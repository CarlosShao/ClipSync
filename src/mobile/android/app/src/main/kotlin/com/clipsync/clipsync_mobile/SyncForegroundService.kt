package com.clipsync.clipsync_mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.FileObserver
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream
import java.util.Timer
import java.util.TimerTask

/**
 * T3.1/T3.2 前台服务：进程保活 + 系统剪贴板采集。
 *
 * - 前台服务类型 dataSync（Manifest foregroundServiceType 声明，见 AndroidManifest.xml）
 * - 常驻低优先级通知「ClipSync 同步运行中」，点击打开主界面
 * - 剪贴板采集双通道：OnPrimaryClipChangedListener 事件监听 + java.util.Timer 每 2 秒轮询兜底
 *   （Android 10+ 无焦点应用读剪贴板受限，返回 null；有焦点场景事件/轮询可正常读到，
 *   详见交付文档的平台限制说明）
 * - 采集文本经 MethodChannel（clipsync/sync，方法 onClipboardCaptured）回传 Dart，
 *   去重/上传/回环抑制逻辑在 Dart 侧 ClipboardCaptureService
 * - 电池优化豁免查询与跳转（T3.4 引导页消费）
 */
class SyncForegroundService : Service() {

    companion object {
        private const val TAG = "SyncForegroundService"

        /** Dart ↔ 原生 MethodChannel 通道名（与 Dart 侧 SyncService/ClipboardCaptureService 对齐） */
        const val METHOD_CHANNEL_NAME = "clipsync/sync"

        /** Dart 侧主动停止服务时经 startService 下发的 action */
        const val ACTION_STOP = "com.clipsync.clipsync_mobile.action.STOP_SYNC"

        private const val NOTIFICATION_CHANNEL_ID = "clipsync_sync"
        private const val NOTIFICATION_ID = 1001

        /** 采集轮询间隔（毫秒） */
        private const val POLL_INTERVAL_MS = 1500L

        /** Dart 引擎侧通道（MainActivity.configureFlutterEngine 注入；服务经它向 Dart 推送采集文本） */
        @Volatile
        var dartChannel: MethodChannel? = null

        @Volatile
        var isRunning = false
            private set

        /** 运行中实例（优雅停止用） */
        private var instance: SyncForegroundService? = null

        /** 外部（如 Activity 回到前台或生命周期变化）请求主动检测截屏 */
        fun triggerScreenshotCheck() {
            instance?.let { service ->
                val h = service.screenshotHandler ?: service.mainHandler
                h.post {
                    try {
                        service.checkLatestScreenshot()
                    } catch (t: Throwable) {
                        Log.w(TAG, "triggerScreenshotCheck error", t)
                    }
                }
            }
        }

        /** 外部（如 Dart 侧完成图片上传）通知释放唤醒锁 */
        fun releaseWakeLock() {
            instance?.releaseWakeLock()
        }

        /** 启动前台服务（由 Dart 经 MainActivity 通道调用；应用前台场景无 FGS 启动限制） */
        fun start(context: Context) {
            if (isRunning) return
            val intent = Intent(context, SyncForegroundService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                Log.w(TAG, "start foreground service failed", e)
            }
        }

        /** 停止前台服务并移除常驻通知 */
        fun stop(context: Context) {
            val running = instance
            if (running != null) {
                running.stopGracefully()
            } else {
                context.stopService(Intent(context, SyncForegroundService::class.java))
            }
        }

        /** 电池优化是否已被豁免（未豁免时 Doze 会限制同步，引导页据此提示加白名单） */
        fun isIgnoringBatteryOptimizations(context: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
            val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
                ?: return false
            return pm.isIgnoringBatteryOptimizations(context.packageName)
        }

        /** 跳转「忽略电池优化」系统授权弹窗（REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 权限已在 Manifest 声明） */
        fun requestIgnoreBatteryOptimizations(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
            try {
                val intent = Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${context.packageName}")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            } catch (e: Exception) {
                Log.w(TAG, "open battery optimization request failed", e)
            }
        }

        /** 本地保存过的图片 ID 集合，防止触发本地截图检测形成回环 */
        val recentlySavedImageIds = java.util.Collections.synchronizedSet(mutableSetOf<Long>())

        /** 保存图片至系统相册（存入 Pictures/Screenshots 确保出现在手机截屏专有相册与首位） */
        fun saveImageToAlbum(context: Context, bytes: ByteArray, name: String?, mime: String?): String? {
            val fileName = if (!name.isNullOrBlank()) name else "Screenshot_${System.currentTimeMillis()}.png"
            val mimeType = if (!mime.isNullOrBlank()) mime else "image/png"
            val nowMs = System.currentTimeMillis()
            val nowSec = nowMs / 1000
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val resolver = context.contentResolver
                    val contentValues = ContentValues().apply {
                        put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                        put(MediaStore.Images.Media.MIME_TYPE, mimeType)
                        // 写入 Pictures/Screenshots，各大安卓厂商（OPPO、小米、vivo、华为）均归类为系统截屏相册
                        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Screenshots")
                        put(MediaStore.Images.Media.DATE_ADDED, nowSec)
                        put(MediaStore.Images.Media.DATE_MODIFIED, nowSec)
                        put(MediaStore.Images.Media.DATE_TAKEN, nowMs)
                        put(MediaStore.Images.Media.IS_PENDING, 1)
                    }
                    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues)
                        ?: return null
                    resolver.openOutputStream(uri, "w")?.use { os ->
                        os.write(bytes)
                        os.flush()
                    }
                    contentValues.clear()
                    contentValues.put(MediaStore.Images.Media.IS_PENDING, 0)
                    resolver.update(uri, contentValues, null, null)

                    try {
                        val id = ContentUris.parseId(uri)
                        recentlySavedImageIds.add(id)
                        instance?.let { service ->
                            service.lastProcessedScreenshotId = Math.max(service.lastProcessedScreenshotId, id)
                        }
                    } catch (_: Exception) {}

                    // 触发媒体扫描，让第三方应用（如微信）相册选择器立即刷新呈现
                    try {
                        MediaScannerConnection.scanFile(context, arrayOf(uri.toString()), arrayOf(mimeType), null)
                    } catch (_: Exception) {}

                    uri.toString()
                } else {
                    val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
                    val screenshotsDir = File(picturesDir, "Screenshots")
                    if (!screenshotsDir.exists()) screenshotsDir.mkdirs()
                    val destFile = File(screenshotsDir, fileName)
                    FileOutputStream(destFile).use { fos ->
                        fos.write(bytes)
                        fos.flush()
                    }
                    MediaScannerConnection.scanFile(context, arrayOf(destFile.absolutePath), arrayOf(mimeType), null)
                    destFile.absolutePath
                }
            } catch (e: Exception) {
                Log.e(TAG, "saveImageToAlbum failed", e)
                null
            }
        }
    }

    private val clipboardManager: ClipboardManager? by lazy {
        getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val sendLock = Any()
    private var lastSentText: String? = null
    private var clipListener: ClipboardManager.OnPrimaryClipChangedListener? = null
    private var pollTimer: Timer? = null

    private var wakeLock: PowerManager.WakeLock? = null

    private fun acquireWakeLock(durationMs: Long = 15000L) {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clipsync:screenshot_sync_lock")?.apply {
                    setReferenceCounted(false)
                }
            }
            wakeLock?.acquire(durationMs)
            Log.d(TAG, "WakeLock acquired for ${durationMs}ms")
        } catch (t: Throwable) {
            Log.w(TAG, "acquireWakeLock failed", t)
        }
    }

    fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
                Log.d(TAG, "WakeLock released")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "releaseWakeLock failed", t)
        }
    }

    private class DirectoryFileObserver(
        private val dir: File,
        private val onFileEvent: (String) -> Unit
    ) {
        private var observer: FileObserver? = null

        fun start() {
            if (!dir.exists()) {
                try {
                    dir.mkdirs()
                } catch (_: Throwable) {}
            }
            try {
                val mask = FileObserver.CLOSE_WRITE or FileObserver.MOVED_TO
                val obs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    object : FileObserver(dir, mask) {
                        override fun onEvent(event: Int, path: String?) {
                            if (path != null) onFileEvent(path)
                        }
                    }
                } else {
                    @Suppress("DEPRECATION")
                    object : FileObserver(dir.absolutePath, mask) {
                        override fun onEvent(event: Int, path: String?) {
                            if (path != null) onFileEvent(path)
                        }
                    }
                }
                obs.startWatching()
                observer = obs
                Log.i(TAG, "DirectoryFileObserver watching: ${dir.absolutePath}")
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to start DirectoryFileObserver for ${dir.absolutePath}", t)
            }
        }

        fun stop() {
            try {
                observer?.stopWatching()
            } catch (_: Throwable) {}
            observer = null
        }
    }

    private val fileObservers = mutableListOf<DirectoryFileObserver>()

    private fun startFileObservers() {
        // 覆盖主流安卓品牌截屏存储目录：
        // 1. Pictures/Screenshots：AOSP、MIUI/HyperOS、ColorOS、OriginOS、HarmonyOS、Pixel
        // 2. DCIM/Screenshots：三星 OneUI、部分机型相册默认
        // 3. Pictures/ScreenCapture：部分华为/荣耀机型
        val dirs = listOf(
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Screenshots"),
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM), "Screenshots"),
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "ScreenCapture")
        )
        for (dir in dirs) {
            val obs = DirectoryFileObserver(dir) { fileName ->
                val lower = fileName.lowercase()
                if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) {
                    Log.i(TAG, "[FileObserver] Screenshot file written: $fileName in ${dir.name}")
                    acquireWakeLock(15000L)
                    val h = screenshotHandler ?: mainHandler
                    h.removeCallbacks(checkScreenshotRunnable)
                    h.postDelayed(checkScreenshotRunnable, 40L)
                }
            }
            obs.start()
            fileObservers.add(obs)
        }
    }

    private fun stopFileObservers() {
        for (obs in fileObservers) {
            obs.stop()
        }
        fileObservers.clear()
    }

    private var screenshotObserver: ContentObserver? = null
    private var lastProcessedScreenshotId: Long = -1L
    private var lastScreenshotTime: Long = 0
    private val pendingScreenshotIds = java.util.Collections.synchronizedSet(mutableSetOf<Long>())

    private var screenshotThread: HandlerThread? = null
    private var screenshotHandler: Handler? = null

    private val screenshotRunnable = object : Runnable {
        override fun run() {
            try {
                checkLatestScreenshot()
            } catch (t: Throwable) {
                Log.w(TAG, "checkLatestScreenshot error", t)
            } finally {
                screenshotHandler?.postDelayed(this, 1500L)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        isRunning = true
        createNotificationChannel()
        startForegroundCompat()

        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clipsync:screenshot_sync_lock")?.apply {
            setReferenceCounted(false)
        }

        val sThread = HandlerThread("clipsync-screenshot-worker").apply { start() }
        screenshotThread = sThread
        screenshotHandler = Handler(sThread.looper)

        initLastScreenshotId()
        registerClipListener()
        registerScreenshotObserver()
        startFileObservers()
        startPolling()
        screenshotHandler?.post(screenshotRunnable)
        Log.i(TAG, "foreground service started")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopGracefully()
            return START_NOT_STICKY
        }
        // START_STICKY：进程被系统回收后尝试重启服务（重启后 onCreate 重新挂监听/轮询）
        return START_STICKY
    }

    override fun onDestroy() {
        stopFileObservers()
        releaseWakeLock()
        wakeLock = null

        pollTimer?.cancel()
        pollTimer = null

        screenshotHandler?.removeCallbacksAndMessages(null)
        screenshotThread?.quitSafely()
        screenshotThread = null
        screenshotHandler = null

        val listener = clipListener
        if (listener != null) {
            try {
                clipboardManager?.removePrimaryClipChangedListener(listener)
            } catch (e: Exception) {
                Log.w(TAG, "remove clipboard listener failed", e)
            }
        }
        clipListener = null

        val obs = screenshotObserver
        if (obs != null) {
            try {
                contentResolver.unregisterContentObserver(obs)
            } catch (e: Exception) {
                Log.w(TAG, "unregister screenshot observer failed", e)
            }
            screenshotObserver = null
        }

        instance = null
        isRunning = false
        Log.i(TAG, "foreground service destroyed")
        super.onDestroy()
    }

    // -------------------------------------------------------------------------
    // 前台通知（常驻、低优先级、点击打开主界面）
    // -------------------------------------------------------------------------

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "ClipSync 同步",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "剪贴板同步常驻服务"
            setShowBadge(false)
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        manager?.createNotificationChannel(channel)
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // API 34+ 要求显式传与 Manifest 声明一致的 foregroundServiceType
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val tapIntent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val contentIntent = PendingIntent.getActivity(this, 0, tapIntent, pendingFlags)

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        return builder
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("ClipSync 同步运行中")
            .setContentText("正在保持剪贴板同步，点击打开")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent)
            .build()
    }

    // -------------------------------------------------------------------------
    // 系统剪贴板采集：事件监听 + 轮询兜底
    // -------------------------------------------------------------------------

    private fun registerClipListener() {
        val cm = clipboardManager ?: return
        val listener = ClipboardManager.OnPrimaryClipChangedListener {
            readClipboard("listener")
        }
        clipListener = listener
        try {
            cm.addPrimaryClipChangedListener(listener)
        } catch (e: Exception) {
            Log.w(TAG, "register clipboard listener failed", e)
        }
    }

    private fun startPolling() {
        // 轮询兜底：仅用于系统剪贴板（通过 mainHandler 调度，防止在非 Looper 线程抛错或被系统隐私拦截阻断）
        pollTimer = Timer("clipsync-clipboard-poll", true)
        pollTimer?.scheduleAtFixedRate(object : TimerTask() {
            override fun run() {
                mainHandler.post {
                    try {
                        readClipboard("poll")
                    } catch (_: Throwable) {}
                }
            }
        }, POLL_INTERVAL_MS, POLL_INTERVAL_MS)
    }

    private fun readClipboard(source: String) {
        val cm = clipboardManager ?: return
        // Android 10+ 无焦点时 primaryClip 返回 null / 个别 ROM 抛异常，一律静默降级
        val clip = try {
            cm.primaryClip
        } catch (e: Exception) {
            null
        } ?: return
        if (clip.itemCount <= 0) return

        // v1 仅采集文本（图片/文件走分享入口 T3.5）；description 缺失时交给 coerceToText 兜底
        val description = clip.description
        val isText = description == null ||
            description.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) ||
            description.hasMimeType("text/*")
        if (!isText) return

        val text = try {
            clip.getItemAt(0).coerceToText(this)?.toString()
        } catch (e: Exception) {
            null
        }
        if (text.isNullOrEmpty() || text.isBlank()) return

        // Kotlin 侧轻去重：与上次回传相同的内容不再打扰 Dart
        val changed = synchronized(sendLock) {
            if (text == lastSentText) {
                false
            } else {
                lastSentText = text
                true
            }
        }
        if (!changed) return

        mainHandler.post {
            val channel = dartChannel ?: return@post
            val args = mapOf<String, Any>(
                "text" to text,
                "capturedAt" to System.currentTimeMillis(),
                "source" to source,
            )
            try {
                channel.invokeMethod("onClipboardCaptured", args)
            } catch (e: Exception) {
                Log.w(TAG, "invoke onClipboardCaptured failed", e)
            }
        }
    }

    // -------------------------------------------------------------------------
    // 移动端系统截图感知监听（MediaStore.Images.Media ContentObserver + FileObserver + 异步 HandlerThread 轮询）
    // -------------------------------------------------------------------------

    private data class ScreenshotCandidate(
        val id: Long,
        val name: String,
        val mime: String,
        val dateAdded: Long
    )

    private val checkScreenshotRunnable = Runnable {
        try {
            checkLatestScreenshot()
        } catch (t: Throwable) {
            Log.w(TAG, "checkLatestScreenshot error", t)
        }
    }

    private val fastRetryRunnable = Runnable {
        try {
            checkLatestScreenshot()
        } catch (t: Throwable) {
            Log.w(TAG, "fastRetry checkLatestScreenshot error", t)
        }
    }

    private fun scheduleFastRetry() {
        val h = screenshotHandler ?: return
        h.removeCallbacks(fastRetryRunnable)
        h.postDelayed(fastRetryRunnable, 80L)
    }

    private fun initLastScreenshotId() {
        try {
            val projection = arrayOf(MediaStore.Images.Media._ID)
            val sortOrder = "${MediaStore.Images.Media._ID} DESC"
            contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                null,
                null,
                sortOrder
            )?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(MediaStore.Images.Media._ID)
                    if (idx >= 0) {
                        lastProcessedScreenshotId = c.getLong(idx)
                        Log.i(TAG, "Initialized lastProcessedScreenshotId to $lastProcessedScreenshotId")
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "initLastScreenshotId failed", e)
        }
    }

    private fun registerScreenshotObserver() {
        // 使用专用的 HandlerThread Looper，即使应用切到后台主线程被系统休眠，工作线程仍能立即响应 ContentObserver 事件
        val h = screenshotHandler ?: Handler(Looper.getMainLooper())
        val observer = object : ContentObserver(h) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                super.onChange(selfChange, uri)
                acquireWakeLock(15000L)
                h.removeCallbacks(checkScreenshotRunnable)
                h.postDelayed(checkScreenshotRunnable, 50L)
            }
        }
        screenshotObserver = observer
        try {
            contentResolver.registerContentObserver(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                true,
                observer
            )
            Log.i(TAG, "ScreenshotObserver registered on worker looper")
        } catch (e: Exception) {
            Log.w(TAG, "register ScreenshotObserver failed", e)
        }
    }

    fun checkLatestScreenshot() {
        try {
            val projection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                arrayOf(
                    MediaStore.Images.Media._ID,
                    MediaStore.Images.Media.DISPLAY_NAME,
                    MediaStore.Images.Media.DATA,
                    MediaStore.Images.Media.RELATIVE_PATH,
                    MediaStore.Images.Media.DATE_ADDED,
                    MediaStore.Images.Media.MIME_TYPE,
                    MediaStore.Images.Media.IS_PENDING
                )
            } else {
                arrayOf(
                    MediaStore.Images.Media._ID,
                    MediaStore.Images.Media.DISPLAY_NAME,
                    MediaStore.Images.Media.DATA,
                    MediaStore.Images.Media.DATE_ADDED,
                    MediaStore.Images.Media.MIME_TYPE
                )
            }
            val sortOrder = "${MediaStore.Images.Media.DATE_ADDED} DESC, ${MediaStore.Images.Media._ID} DESC"
            contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                null,
                null,
                sortOrder
            )?.use { cursor ->
                var rowsChecked = 0
                var hasPending = false
                val candidates = mutableListOf<ScreenshotCandidate>()

                while (cursor.moveToNext() && rowsChecked < 15) {
                    rowsChecked++
                    val idIndex = cursor.getColumnIndex(MediaStore.Images.Media._ID)
                    val nameIndex = cursor.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME)
                    val dataIndex = cursor.getColumnIndex(MediaStore.Images.Media.DATA)
                    val relativeIndex = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        cursor.getColumnIndex(MediaStore.Images.Media.RELATIVE_PATH)
                    } else -1
                    val dateAddedIndex = cursor.getColumnIndex(MediaStore.Images.Media.DATE_ADDED)
                    val mimeIndex = cursor.getColumnIndex(MediaStore.Images.Media.MIME_TYPE)
                    val pendingIndex = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        cursor.getColumnIndex(MediaStore.Images.Media.IS_PENDING)
                    } else -1

                    val id = if (idIndex >= 0) cursor.getLong(idIndex) else -1L
                    if (id <= 0) continue

                    // 1. 过滤已处理项、在途项与由 ClipSync 本地刚刚保存的图片，防止回环
                    if (id <= lastProcessedScreenshotId || pendingScreenshotIds.contains(id) || recentlySavedImageIds.contains(id)) {
                        continue
                    }

                    // 2. 如果系统还在异步落盘写入（is_pending == 1），标记需要快速重试，切勿跳过并永久丢弃
                    if (pendingIndex >= 0 && cursor.getInt(pendingIndex) == 1) {
                        Log.d(TAG, "Screenshot id=$id is still pending, scheduling fast retry")
                        hasPending = true
                        continue
                    }

                    val name = if (nameIndex >= 0) cursor.getString(nameIndex) ?: "" else ""
                    val data = if (dataIndex >= 0) cursor.getString(dataIndex) ?: "" else ""
                    val relative = if (relativeIndex >= 0) cursor.getString(relativeIndex) ?: "" else ""
                    val dateAdded = if (dateAddedIndex >= 0) cursor.getLong(dateAddedIndex) else 0L
                    val mime = if (mimeIndex >= 0) cursor.getString(mimeIndex) ?: "image/png" else "image/png"

                    val nowSec = System.currentTimeMillis() / 1000
                    // 时间窗口：放宽到 2 小时（7200秒），防止手机后台休眠/灭屏后超过 60 秒被误丢弃！
                    if (dateAdded > 0 && Math.abs(nowSec - dateAdded) > 7200) {
                        continue
                    }

                    val lowerName = name.lowercase()
                    val lowerData = data.lowercase()
                    val lowerRelative = relative.lowercase()

                    // 全品牌厂商截屏命名与路径规则覆盖：
                    // 小米/MIUI/HyperOS: Screenshot_2026-09-04-17-12-13.png / Pictures/Screenshots
                    // 华为/荣耀/HarmonyOS: Screenshot_... 或 截屏_...
                    // OPPO/一加/ColorOS: Screenshot_...
                    // vivo/iQOO/OriginOS: Screenshot_...
                    // 三星/OneUI: DCIM/Screenshots/Screenshot_...
                    // Pixel/AOSP: Pictures/Screenshots/Screenshot_...
                    val isScreenshot = lowerName.contains("screenshot") ||
                        lowerName.contains("截屏") ||
                        lowerName.contains("screen_shot") ||
                        lowerName.contains("screencap") ||
                        lowerName.contains("screen-shot") ||
                        lowerData.contains("screenshot") ||
                        lowerData.contains("截屏") ||
                        lowerData.contains("screen_shot") ||
                        lowerData.contains("screencap") ||
                        lowerRelative.contains("screenshot") ||
                        lowerRelative.contains("截屏")

                    if (isScreenshot) {
                        candidates.add(ScreenshotCandidate(id, name, mime, dateAdded))
                    }
                }

                if (hasPending) {
                    scheduleFastRetry()
                }

                if (candidates.isNotEmpty()) {
                    acquireWakeLock(15000L)
                    // 按 ID 升序依次分发，保证连续多张截图按拍摄时间顺序上传，且不会丢弃中间的截图
                    candidates.sortBy { it.id }
                    for (candidate in candidates) {
                        pendingScreenshotIds.add(candidate.id)
                        lastProcessedScreenshotId = Math.max(lastProcessedScreenshotId, candidate.id)
                        lastScreenshotTime = System.currentTimeMillis()
                        Log.i(TAG, "[ScreenshotObserver] Detected new screenshot: ${candidate.name} (id=${candidate.id}, mime=${candidate.mime})")
                        dispatchScreenshotCaptured(candidate.id, candidate.name, candidate.mime, 0)
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "checkLatestScreenshot error", e)
        }
    }

    private fun dispatchScreenshotCaptured(id: Long, fileName: String, mime: String, retryCount: Int) {
        val sHandler = screenshotHandler
        if (sHandler == null) {
            pendingScreenshotIds.remove(id)
            return
        }
        sHandler.post {
            try {
                acquireWakeLock(15000L)
                val uri = ContentUris.withAppendedId(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    id
                )
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                if (bytes == null || bytes.isEmpty()) {
                    if (retryCount < 10) {
                        sHandler.postDelayed({
                            dispatchScreenshotCaptured(id, fileName, mime, retryCount + 1)
                        }, 100L)
                    } else {
                        Log.w(TAG, "read screenshot bytes empty after 10 retries: $fileName (id=$id)")
                        pendingScreenshotIds.remove(id)
                        if (lastProcessedScreenshotId == id) {
                            lastProcessedScreenshotId = id - 1
                        }
                    }
                    return@post
                }
                pendingScreenshotIds.remove(id)
                mainHandler.post {
                    val channel = dartChannel
                    if (channel == null) {
                        Log.w(TAG, "dartChannel is null, dropping onScreenshotCaptured: $fileName")
                        return@post
                    }
                    val args = mapOf<String, Any>(
                        "bytes" to bytes,
                        "fileName" to fileName,
                        "mimeType" to mime,
                        "capturedAt" to System.currentTimeMillis()
                    )
                    Log.i(TAG, "Dispatching onScreenshotCaptured to Dart: $fileName (${bytes.size} bytes)")
                    try {
                        channel.invokeMethod("onScreenshotCaptured", args)
                    } catch (e: Exception) {
                        Log.w(TAG, "invoke onScreenshotCaptured failed", e)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "read screenshot bytes failed", e)
                if (retryCount < 10) {
                    sHandler.postDelayed({
                        dispatchScreenshotCaptured(id, fileName, mime, retryCount + 1)
                    }, 100L)
                } else {
                    pendingScreenshotIds.remove(id)
                    if (lastProcessedScreenshotId == id) {
                        lastProcessedScreenshotId = id - 1
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // 优雅停止
    // -------------------------------------------------------------------------

    private fun stopGracefully() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (e: Exception) {
            Log.w(TAG, "stopForeground failed", e)
        }
        stopSelf()
    }
}
