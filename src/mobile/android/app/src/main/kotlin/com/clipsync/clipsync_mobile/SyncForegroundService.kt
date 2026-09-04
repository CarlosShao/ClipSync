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
import android.os.Handler
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
        private const val POLL_INTERVAL_MS = 2000L

        /** Dart 引擎侧通道（MainActivity.configureFlutterEngine 注入；服务经它向 Dart 推送采集文本） */
        @Volatile
        var dartChannel: MethodChannel? = null

        @Volatile
        var isRunning = false
            private set

        /** 运行中实例（优雅停止用） */
        private var instance: SyncForegroundService? = null

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

    private var screenshotObserver: ContentObserver? = null
    private var lastProcessedScreenshotId: Long = -1L
    private var lastScreenshotTime: Long = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        isRunning = true
        createNotificationChannel()
        startForegroundCompat()
        registerClipListener()
        registerScreenshotObserver()
        startPolling()
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
        pollTimer?.cancel()
        pollTimer = null
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
        // 轮询兜底：监听器在某些 ROM / Android 10+ 焦点受限场景不触发
        pollTimer = Timer("clipsync-clipboard-poll", true)
        pollTimer?.scheduleAtFixedRate(object : TimerTask() {
            override fun run() {
                readClipboard("poll")
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
    // 移动端系统截图感知监听（MediaStore.Images.Media ContentObserver）
    // -------------------------------------------------------------------------

    private val checkScreenshotRunnable = Runnable {
        checkLatestScreenshot()
    }

    private fun registerScreenshotObserver() {
        val handler = Handler(Looper.getMainLooper())
        val observer = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                super.onChange(selfChange, uri)
                // 系统截图生成时可能触发多次（插入记录、写入数据、缩略图等）
                // 防抖 500ms 等待系统完成磁盘写入与 MediaStore 元数据落库，避免读到 0 字节
                mainHandler.removeCallbacks(checkScreenshotRunnable)
                mainHandler.postDelayed(checkScreenshotRunnable, 500)
            }
        }
        screenshotObserver = observer
        try {
            contentResolver.registerContentObserver(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                true,
                observer
            )
            Log.i(TAG, "ScreenshotObserver registered")
        } catch (e: Exception) {
            Log.w(TAG, "register ScreenshotObserver failed", e)
        }
    }

    private fun checkLatestScreenshot() {
        try {
            val projection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                arrayOf(
                    MediaStore.Images.Media._ID,
                    MediaStore.Images.Media.DISPLAY_NAME,
                    MediaStore.Images.Media.DATA,
                    MediaStore.Images.Media.RELATIVE_PATH,
                    MediaStore.Images.Media.DATE_ADDED,
                    MediaStore.Images.Media.MIME_TYPE
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
            val sortOrder = "${MediaStore.Images.Media.DATE_ADDED} DESC"
            contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                null,
                null,
                sortOrder
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val idIndex = cursor.getColumnIndex(MediaStore.Images.Media._ID)
                    val nameIndex = cursor.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME)
                    val dataIndex = cursor.getColumnIndex(MediaStore.Images.Media.DATA)
                    val relativeIndex = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        cursor.getColumnIndex(MediaStore.Images.Media.RELATIVE_PATH)
                    } else -1
                    val dateAddedIndex = cursor.getColumnIndex(MediaStore.Images.Media.DATE_ADDED)
                    val mimeIndex = cursor.getColumnIndex(MediaStore.Images.Media.MIME_TYPE)

                    val id = if (idIndex >= 0) cursor.getLong(idIndex) else -1L
                    val name = if (nameIndex >= 0) cursor.getString(nameIndex) ?: "" else ""
                    val data = if (dataIndex >= 0) cursor.getString(dataIndex) ?: "" else ""
                    val relative = if (relativeIndex >= 0) cursor.getString(relativeIndex) ?: "" else ""
                    val dateAdded = if (dateAddedIndex >= 0) cursor.getLong(dateAddedIndex) else 0L
                    val mime = if (mimeIndex >= 0) cursor.getString(mimeIndex) ?: "image/png" else "image/png"

                    val nowSec = System.currentTimeMillis() / 1000
                    // 时间窗口判定：30秒以内新增（容忍±5秒时钟偏差）
                    if (id >= 0 && Math.abs(nowSec - dateAdded) <= 30) {
                        // 过滤由 ClipSync 本地刚刚保存的图片，防止回环
                        if (recentlySavedImageIds.contains(id)) {
                            return
                        }

                        val lowerName = name.lowercase()
                        val lowerData = data.lowercase()
                        val lowerRelative = relative.lowercase()

                        val isScreenshot = lowerName.contains("screenshot") ||
                            lowerName.contains("截屏") ||
                            lowerName.contains("screen_shot") ||
                            lowerName.contains("screencap") ||
                            lowerData.contains("screenshot") ||
                            lowerData.contains("截屏") ||
                            lowerData.contains("screen_shot") ||
                            lowerRelative.contains("screenshot") ||
                            lowerRelative.contains("截屏")

                        if (isScreenshot && id != lastProcessedScreenshotId &&
                            (System.currentTimeMillis() - lastScreenshotTime > 1500)
                        ) {
                            lastProcessedScreenshotId = id
                            lastScreenshotTime = System.currentTimeMillis()
                            Log.i(TAG, "Detected new screenshot: $name (id=$id)")
                            dispatchScreenshotCaptured(id, name, mime, 0)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "checkLatestScreenshot error", e)
        }
    }

    private fun dispatchScreenshotCaptured(id: Long, fileName: String, mime: String, retryCount: Int) {
        // 用 content:// URI 读取字节：Android 10+ 分区存储下 _data 路径
        // 可能不可用/不可 File 直读，统一走 ContentResolver 最稳。
        try {
            val uri = ContentUris.withAppendedId(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                id
            )
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
            if (bytes == null || bytes.isEmpty()) {
                if (retryCount < 3) {
                    mainHandler.postDelayed({
                        dispatchScreenshotCaptured(id, fileName, mime, retryCount + 1)
                    }, 300)
                }
                return
            }
            mainHandler.post {
                val channel = dartChannel ?: return@post
                val args = mapOf<String, Any>(
                    "bytes" to bytes,
                    "fileName" to fileName,
                    "mimeType" to mime,
                    "capturedAt" to System.currentTimeMillis()
                )
                try {
                    channel.invokeMethod("onScreenshotCaptured", args)
                } catch (e: Exception) {
                    Log.w(TAG, "invoke onScreenshotCaptured failed", e)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "read screenshot bytes failed", e)
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
