package com.clipsync.clipsync_mobile

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.media.MediaScannerConnection
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.os.FileObserver
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.Timer
import java.util.TimeZone
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

        /** SyncKeepAliveReceiver 周期自检 action */
        const val ACTION_KEEPALIVE_CHECK = "com.clipsync.clipsync_mobile.action.KEEPALIVE_CHECK"

        private const val NOTIFICATION_CHANNEL_ID = "clipsync_sync"
        private const val NOTIFICATION_ID = 1001

        /** 采集轮询间隔（毫秒） */
        private const val POLL_INTERVAL_MS = 1500L

        /** 自愈自检间隔（毫秒）：进程被厂商 ROM 杀死（非 force-stop 场景）后由此拉起。
         *  2 分钟：亮屏/解锁瞬间的 SCREEN_ON/USER_PRESENT 补扫覆盖了主要场景，
         *  这里只兜「进程死了但没被 force-stop」的窗口期，越短复活越快 */
        private const val KEEPALIVE_INTERVAL_MS = 2 * 60 * 1000L

        /** PC 图片拉取间隔：亮屏 4 秒（「相册第一时间看到」），灭屏 30 秒（省电） */
        private const val REMOTE_PULL_INTERVAL_SCREEN_ON_MS = 4000L
        private const val REMOTE_PULL_INTERVAL_SCREEN_OFF_MS = 30000L

        /** PC 图片落盘大小上限（30MB） */
        private const val REMOTE_PULL_MAX_BYTES = 30 * 1024 * 1024

        private const val REQUEST_CODE_RESTART = 1001
        private const val REQUEST_CODE_KEEPALIVE = 1002

        /** 截图处理游标持久化键（服务重启后恢复，避免死亡期间的截图被静默跳过） */
        private const val PREF_KEY_LAST_SCREENSHOT_ID = "lastProcessedScreenshotId"

        /** 开机自启门控键：用户启动过服务=true（stop 时清除） */
        private const val PREF_KEY_SERVICE_WANTED = "serviceWanted"

        /** PC 图片拉取游标（epoch ms）：只存比它更新的远程图片 */
        private const val PREF_KEY_LAST_REMOTE_PULL_AT = "lastRemoteImageAtMs"

        /** 用户是否仍希望服务运行（BootCompletedReceiver / SyncKeepAliveReceiver 消费） */
        fun isServiceWanted(context: Context): Boolean {
            return try {
                context.getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
                    .getBoolean(PREF_KEY_SERVICE_WANTED, false)
            } catch (_: Throwable) {
                false
            }
        }

        /**
         * 排下一个自愈自检闹钟（5 分钟后）。由服务 onCreate 与 SyncKeepAliveReceiver 续排，
         * 形成 WAKEUP 闹钟链：进程被 ROM 杀掉（LMK/厂商清理等非 force-stop 场景）后由
         * 下一次自检拉起；用户登出（serviceWanted=false）后 Receiver 不再续排，链条终止。
         */
        fun scheduleKeepAliveAlarm(context: Context) {
            try {
                val intent = Intent(context, SyncKeepAliveReceiver::class.java).apply {
                    action = ACTION_KEEPALIVE_CHECK
                    setPackage(context.packageName)
                }
                val pi = PendingIntent.getBroadcast(
                    context,
                    REQUEST_CODE_KEEPALIVE,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
                am?.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + KEEPALIVE_INTERVAL_MS,
                    pi
                )
            } catch (t: Throwable) {
                Log.w(TAG, "scheduleKeepAliveAlarm failed", t)
            }
        }

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

        /** 保存同步凭据（服务端地址、JWT token、设备 ID、开关组），供服务脱离 Flutter 后台独立工作 */
        fun saveSyncConfig(
            context: Context,
            baseUrl: String?,
            token: String?,
            deviceId: String?,
            autoSyncScreenshots: Boolean,
            autoSaveImagesToAlbum: Boolean = true
        ) {
            val sp = context.getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
            sp.edit()
                .putString("baseUrl", baseUrl)
                .putString("token", token)
                .putString("deviceId", deviceId)
                .putBoolean("autoSyncScreenshots", autoSyncScreenshots)
                .putBoolean("autoSaveImagesToAlbum", autoSaveImagesToAlbum)
                .apply()
            Log.i(TAG, "Sync config saved: baseUrl=$baseUrl, deviceId=$deviceId, autoSync=$autoSyncScreenshots, autoSaveAlbum=$autoSaveImagesToAlbum")
        }

        /** 启动前台服务（由 Dart 经 MainActivity 通道调用；应用前台场景无 FGS 启动限制） */
        fun start(context: Context) {
            if (isRunning) return
            // 记录"用户想要服务运行"：BootCompletedReceiver 据此决定开机是否自启（登出后不再拉起）
            try {
                context.getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
                    .edit().putBoolean(PREF_KEY_SERVICE_WANTED, true).apply()
            } catch (_: Throwable) {}
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
            // 清除开机自启意图：用户主动停止（含登出）后，下次开机不再自动拉起
            try {
                context.getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
                    .edit().putBoolean(PREF_KEY_SERVICE_WANTED, false).apply()
            } catch (_: Throwable) {}
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
                    // 幂等落盘：同名文件已存在于 Pictures/Screenshots 时直接复用。
                    // Dart 推送路径与原生轮询路径可能先后处理同一条目，确定性文件名
                    // （Sync_PC_<itemId前8位>）+ 此检查保证相册不出现重复图片。
                    // 注意 RELATIVE_PATH 存储值带尾部斜杠（"Pictures/Screenshots/"），
                    // 比较值必须一致，否则存在性检查永远落空、MediaStore 会生成 "(1)" 副本。
                    resolver.query(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        arrayOf(MediaStore.Images.Media._ID),
                        "${MediaStore.Images.Media.DISPLAY_NAME}=? AND ${MediaStore.Images.Media.RELATIVE_PATH}=?",
                        arrayOf(fileName, Environment.DIRECTORY_PICTURES + "/Screenshots/"),
                        null
                    )?.use { c ->
                        if (c.moveToFirst()) {
                            val idx = c.getColumnIndex(MediaStore.Images.Media._ID)
                            if (idx >= 0) {
                                return ContentUris.withAppendedId(
                                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                                    c.getLong(idx)
                                ).toString()
                            }
                        }
                    }
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
                            try {
                                context.getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
                                    .edit()
                                    .putLong(PREF_KEY_LAST_SCREENSHOT_ID, service.lastProcessedScreenshotId)
                                    .apply()
                            } catch (_: Exception) {}
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
    private var wifiLock: WifiManager.WifiLock? = null

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

            if (wifiLock == null) {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                @Suppress("DEPRECATION")
                val wifiMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }
                wifiLock = wm?.createWifiLock(wifiMode, "clipsync:screenshot_wifi_lock")?.apply {
                    setReferenceCounted(false)
                }
            }
            if (wifiLock?.isHeld != true) {
                wifiLock?.acquire()
                Log.d(TAG, "WifiLock acquired")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "acquireWakeLock/wifiLock failed", t)
        }
    }

    fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
                Log.d(TAG, "WakeLock released")
            }
            if (wifiLock?.isHeld == true) {
                wifiLock?.release()
                Log.d(TAG, "WifiLock released")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "releaseWakeLock/wifiLock failed", t)
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
                    acquireWakeLock(20000L)
                    val file = File(dir, fileName)
                    if (file.exists()) {
                        // 1. 立即触发系统扫描，解决锁屏/后台休眠下 MediaStore 延迟索引问题
                        MediaScannerConnection.scanFile(
                            applicationContext,
                            arrayOf(file.absolutePath),
                            arrayOf("image/*")
                        ) { path, uri ->
                            Log.i(TAG, "MediaScanner scanned: $path -> $uri")
                            acquireWakeLock(15000L)
                            screenshotHandler?.post(checkScreenshotRunnable)
                        }
                        // 2. 避免等 MediaStore 延迟，文件已完成写入时延时 200ms 直接直读文件处理
                        if (!fileName.startsWith(".") && file.length() > 1024) {
                            screenshotHandler?.postDelayed({
                                handleFileScreenshotDirectly(file)
                            }, 200L)
                        }
                    }
                    val h = screenshotHandler ?: mainHandler
                    h.removeCallbacks(checkScreenshotRunnable)
                    h.postDelayed(checkScreenshotRunnable, 300L)
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
        registerScreenStateReceiver()
        startPolling()
        scheduleKeepAliveAlarm(applicationContext)
        screenshotHandler?.post(screenshotRunnable)
        screenshotHandler?.post(remotePullRunnable)
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

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        Log.i(TAG, "onTaskRemoved called - keeping foreground sync service alive")
        try {
            val restartIntent = Intent(applicationContext, SyncForegroundService::class.java).also {
                it.setPackage(packageName)
            }
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
            } else {
                PendingIntent.FLAG_ONE_SHOT
            }
            val pendingIntent = PendingIntent.getService(applicationContext, 1001, restartIntent, flags)
            val alarmManager = getSystemService(Context.ALARM_SERVICE) as? AlarmManager
            // WAKEUP + AllowWhileIdle：厂商杀进程/Doze 下也能准时唤醒重建（原 set 不唤醒 CPU，
            // 灭屏划卡片后要等下次亮屏才重启，期间同步完全中断）
            alarmManager?.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + 1000L,
                pendingIntent
            )
        } catch (e: Exception) {
            Log.w(TAG, "onTaskRemoved restart alarm failed", e)
        }
    }

    override fun onDestroy() {
        stopFileObservers()
        releaseWakeLock()
        wakeLock = null
        wifiLock = null

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

        val ssReceiver = screenStateReceiver
        if (ssReceiver != null) {
            try {
                unregisterReceiver(ssReceiver)
            } catch (e: Exception) {
                Log.w(TAG, "unregister screen state receiver failed", e)
            }
            screenStateReceiver = null
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34+：specialUse 类型没有 dataSync 的「6 小时/24 小时」运行上限，
            // 且允许从 BOOT_COMPLETED 启动（dataSync 在 Android 15 起被禁止）——
            // 这两点是剪贴板同步服务「永久常驻」的前提。子类型用途在 Manifest 声明。
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // API 29-33：要求显式传与 Manifest 声明一致的 foregroundServiceType
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
        // 一键同步：通知按钮 → 透明 Activity 借焦点读取并同步剪贴板（不切换应用）
        val quickSyncIntent = PendingIntent.getActivity(
            this,
            1002,
            Intent(this, QuickSyncActivity::class.java),
            pendingFlags
        )

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
            .addAction(
                Notification.Action.Builder(
                    null as android.graphics.drawable.Icon?,
                    "同步剪贴板",
                    quickSyncIntent
                ).build()
            )
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

    private var screenStateReceiver: BroadcastReceiver? = null

    /** 当前屏幕状态（SCREEN_ON/OFF 维护；决定 PC 图片拉取频率） */
    @Volatile
    private var screenOn: Boolean = true

    /**
     * 亮屏/解锁广播：用户按下电源键或解锁的瞬间立即补扫截图并唤醒同步，
     * 不要求打开 App。Doze 深度休眠期间 ContentObserver/1.5s 轮询可能整体停摆
     * （Handler 需要 CPU 唤醒才能 tick），SCREEN_ON 是系统必然唤醒进程的时刻，
     * 也是「锁屏期间漏掉的截图」最可靠的补传触发点。
     */
    private fun registerScreenStateReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> {
                        Log.i(TAG, "Screen on / user present — immediate screenshot catch-up")
                        screenOn = true
                        acquireWakeLock(20000L)
                        val h = screenshotHandler ?: return
                        h.removeCallbacks(checkScreenshotRunnable)
                        h.post(checkScreenshotRunnable)
                        // MediaStore 索引可能滞后于解锁瞬间，追加两次复查
                        h.postDelayed(checkScreenshotRunnable, 2500L)
                        h.postDelayed(checkScreenshotRunnable, 6000L)
                        // 亮屏/解锁同时立即拉一次 PC 端新图片（相册第一时间可见）
                        h.removeCallbacks(remotePullRunnable)
                        h.post(remotePullRunnable)
                    }
                    Intent.ACTION_SCREEN_OFF -> {
                        screenOn = false
                    }
                }
            }
        }
        screenStateReceiver = receiver
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(receiver, filter)
            }
            Log.i(TAG, "Screen state receiver registered (SCREEN_ON / SCREEN_OFF / USER_PRESENT)")
        } catch (e: Exception) {
            Log.w(TAG, "register screen state receiver failed", e)
        }
    }

    // -------------------------------------------------------------------------
    // PC 截图/图片 → 手机相册（原生轮询，2026-09：不再依赖 Flutter 引擎存活。
    // 后台/冻结时 Dart 层收不到 WS 推送，只有原生轮询能保证「相册第一时间可见」。
    // 与 Dart 推送路径通过确定性文件名（Sync_PC_<itemId前8位>）+ MediaStore 存在性
    // 检查去重，两边谁先到都不会重复落盘。）
    // -------------------------------------------------------------------------

    private val remotePullRunnable = object : Runnable {
        override fun run() {
            try {
                pullRemoteImages()
            } catch (t: Throwable) {
                Log.w(TAG, "pullRemoteImages error", t)
            } finally {
                val interval = if (screenOn) REMOTE_PULL_INTERVAL_SCREEN_ON_MS else REMOTE_PULL_INTERVAL_SCREEN_OFF_MS
                screenshotHandler?.postDelayed(this, interval)
            }
        }
    }

    private val remotePullInFlight = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun pullRemoteImages() {
        if (!remotePullInFlight.compareAndSet(false, true)) return
        try {
            val sp = getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
            if (!sp.getBoolean("autoSaveImagesToAlbum", true)) return
            val baseUrl = sp.getString("baseUrl", null)?.trimEnd('/') ?: return
            val token = sp.getString("token", null) ?: return
            val myDeviceId = sp.getString("deviceId", null) ?: return

            // 首次运行游标初始化为当前时间：绝不把历史图片倒进相册
            if (!sp.contains(PREF_KEY_LAST_REMOTE_PULL_AT)) {
                sp.edit().putLong(PREF_KEY_LAST_REMOTE_PULL_AT, System.currentTimeMillis()).apply()
                return
            }
            val cursorMs = sp.getLong(PREF_KEY_LAST_REMOTE_PULL_AT, 0L)

            acquireWakeLock(15000L)
            val listUrl = "$baseUrl/api/clipboard?page=1&limit=10"
            val body = httpGetString(listUrl, token) ?: return
            val root = org.json.JSONObject(body)
            val items = root.optJSONArray("items") ?: return

            var newestMs = cursorMs
            var savedAny = false
            for (i in 0 until items.length()) {
                val item = items.optJSONObject(i) ?: continue
                val createdAtMs = parseIsoToEpochMs(item.optString("createdAt")) ?: continue
                if (createdAtMs > newestMs) newestMs = createdAtMs
                if (createdAtMs <= cursorMs) continue
                val sourceId = item.optJSONObject("sourceDevice")?.optString("id") ?: ""
                if (sourceId.isEmpty() || sourceId == myDeviceId) continue
                val itemId = item.optString("id")
                if (itemId.isEmpty()) continue

                when (item.optString("contentType")) {
                    "image" -> {
                        val media = httpGetBytes("$baseUrl/api/media/$itemId/download", token) ?: continue
                        if (media.first.isEmpty()) continue
                        val ext = when {
                            media.second.contains("jpeg") || media.second.contains("jpg") -> "jpg"
                            media.second.contains("webp") -> "webp"
                            media.second.contains("gif") -> "gif"
                            else -> "png"
                        }
                        val fileName = "Sync_PC_${itemId.take(8)}.$ext"
                        val saved = saveImageToAlbum(applicationContext, media.first, fileName, media.second)
                        if (saved != null) {
                            savedAny = true
                            Log.i(TAG, "[RemotePull] saved PC image to album: $fileName (${media.first.size} bytes)")
                        }
                    }
                    "text", "link" -> {
                        // PC 文本/链接 → 手机剪贴板（后台回写；FGS 状态下系统允许写剪贴板，
                        // AppOps 实测 [fgsvc-s] 写入成功）。列表里是截断的 preview，
                        // 长文本需拉全量 content。回写前登记回声，抑制无障碍采集回环。
                        val content = fetchRemoteItemContent(baseUrl, token, itemId) ?: continue
                        if (content.isNotEmpty() && content.length <= 100_000 &&
                            !ClipboardAccessibilityService.isEcho(content)
                        ) {
                            ClipboardAccessibilityService.registerEcho(content)
                            try {
                                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                                cm?.setPrimaryClip(android.content.ClipData.newPlainText("clipsync", content))
                                savedAny = true
                                Log.i(TAG, "[RemotePull] wrote PC text to clipboard (${content.length} chars)")
                            } catch (t: Throwable) {
                                Log.w(TAG, "[RemotePull] clipboard write denied: ${t.message}")
                            }
                        }
                    }
                }
            }
            if (newestMs > cursorMs) {
                sp.edit().putLong(PREF_KEY_LAST_REMOTE_PULL_AT, newestMs).apply()
            }
            if (savedAny) {
                // 相册变更后触发一次截图检测：saveImageToAlbum 已登记 recentlySavedImageIds，
                // 这里只是让状态机立即消化掉本次 MediaStore 变更，避免多余的 fast-retry
                screenshotHandler?.post(checkScreenshotRunnable)
            }
        } finally {
            remotePullInFlight.set(false)
        }
    }

    /** 拉取远程条目全量内容（GET /api/clipboard/:id/content → contentEncrypted） */
    private fun fetchRemoteItemContent(baseUrl: String, token: String, itemId: String): String? {
        val body = httpGetString("$baseUrl/api/clipboard/$itemId/content", token) ?: return null
        return try {
            val obj = org.json.JSONObject(body)
            val content = obj.optString("contentEncrypted")
            if (content.isEmpty() || content == "null") null else content
        } catch (_: Throwable) {
            null
        }
    }

    private fun httpGetString(url: String, token: String): String? {
        var conn: java.net.HttpURLConnection? = null
        return try {
            conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 8000
                setRequestProperty("Authorization", "Bearer $token")
            }
            if (conn.responseCode != 200) {
                Log.w(TAG, "[RemotePull] GET $url -> ${conn.responseCode}")
                null
            } else {
                conn.inputStream.bufferedReader().use { it.readText() }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "[RemotePull] GET failed: ${t.message}")
            null
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    private fun httpGetBytes(url: String, token: String): Pair<ByteArray, String>? {
        var conn: java.net.HttpURLConnection? = null
        return try {
            conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 15000
                setRequestProperty("Authorization", "Bearer $token")
            }
            if (conn.responseCode != 200) return null
            val mime = conn.getHeaderField("Content-Type") ?: "image/png"
            val bytes = conn.inputStream.use { input ->
                val buf = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(64 * 1024)
                var n: Int
                var total = 0
                while (input.read(chunk).also { n = it } > 0) {
                    total += n
                    if (total > REMOTE_PULL_MAX_BYTES) return null
                    buf.write(chunk, 0, n)
                }
                buf.toByteArray()
            }
            Pair(bytes, mime)
        } catch (t: Throwable) {
            Log.w(TAG, "[RemotePull] download failed: ${t.message}")
            null
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    /** 解析服务端 ISO8601 时间（2026-09-05T14:28:13.806873+08:00 / ...Z）为 epoch 毫秒 */
    private fun parseIsoToEpochMs(iso: String): Long? {
        return try {
            val m = Regex("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})?$").find(iso.trim())
                ?: return null
            val secPart = m.groupValues[1]
            var offPart = m.groupValues[2]
            if (offPart.isEmpty()) offPart = "Z"
            if (offPart == "Z") offPart = "+00:00"
            val normalized = if (offPart.length == 5) offPart.substring(0, 3) + offPart.substring(3) else offPart
            val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US)
            sdf.timeZone = TimeZone.getTimeZone("GMT${normalized}")
            sdf.parse("${secPart}${normalized}")?.time
        } catch (_: Throwable) {
            null
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
        // 无障碍采集服务已接管（系统信任豁免，后台可读）：
        // 经典路径受 Android 10+ 焦点限制只能在 App 前台工作，交给无障碍路径统一采集
        if (ClipboardAccessibilityService.isConnected) return
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

    private fun persistLastScreenshotId() {
        try {
            getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
                .edit()
                .putLong(PREF_KEY_LAST_SCREENSHOT_ID, lastProcessedScreenshotId)
                .apply()
        } catch (e: Exception) {
            Log.w(TAG, "persistLastScreenshotId failed", e)
        }
    }

    private fun initLastScreenshotId() {
        // 优先恢复持久化游标，而不是"重置为当前最新 id"：服务死亡/被杀期间的截图
        // id 必然大于上次持久化的游标，服务重启后轮询与解锁补扫会自动补传它们；
        // 旧逻辑直接推到最新，等于把断档期的截图静默永久丢弃。
        val sp = getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
        val persisted = try {
            sp.getLong(PREF_KEY_LAST_SCREENSHOT_ID, -1L)
        } catch (_: Throwable) { -1L }
        if (persisted > 0) {
            lastProcessedScreenshotId = persisted
            Log.i(TAG, "Restored lastProcessedScreenshotId=$persisted from prefs")
            return
        }
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
                        persistLastScreenshotId()
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
                        persistLastScreenshotId()
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
                processedFileNames.add(fileName)
                // 原生直传为主路径（2026-09 锁屏修复）：灭屏后 Flutter 引擎可能被进程冻结，
                // invokeMethod 只是 post 到主线程队列、不会抛异常，Dart 上传会静默卡死到用户
                // 打开 App 才补传。凭据已下沉 SharedPreferences，原生上传完全不依赖引擎存活；
                // 上传成功后再尽力通知 Dart（仅元数据、不带图片字节）刷新列表 UI。
                Log.i(TAG, "Uploading screenshot natively: $fileName (${bytes.size} bytes)")
                uploadScreenshotNatively(bytes, fileName, mime)
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

    private val processedFileNames = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    private fun handleFileScreenshotDirectly(file: File) {
        try {
            if (!file.exists() || !file.canRead() || file.length() < 1024) return
            val name = file.name
            if (name.startsWith(".") || processedFileNames.contains(name)) return

            val lastModSec = file.lastModified() / 1000
            val nowSec = System.currentTimeMillis() / 1000
            if (lastModSec > 0 && Math.abs(nowSec - lastModSec) > 3600) return

            acquireWakeLock(20000L)
            val bytes = file.readBytes()
            if (bytes.isEmpty()) return
            processedFileNames.add(name)

            val lower = name.lowercase()
            val mime = when {
                lower.endsWith(".png") -> "image/png"
                lower.endsWith(".webp") -> "image/webp"
                lower.endsWith(".gif") -> "image/gif"
                else -> "image/jpeg"
            }

            // 与 dispatchScreenshotCaptured 同口径（2026-09 锁屏修复）：
            // 原生直传为主路径，Dart 引擎冻结时上传不再被卡死；Dart 只做 UI 刷新
            Log.i(TAG, "Uploading direct file screenshot natively: $name (${bytes.size} bytes)")
            uploadScreenshotNatively(bytes, name, mime)
        } catch (t: Throwable) {
            Log.w(TAG, "handleFileScreenshotDirectly failed for ${file.absolutePath}", t)
        }
    }

    private fun uploadScreenshotNatively(bytes: ByteArray, fileName: String, mimeType: String) {
        val sp = getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
        val autoSync = sp.getBoolean("autoSyncScreenshots", true)
        if (!autoSync) {
            Log.d(TAG, "uploadScreenshotNatively skipped: autoSync is false")
            releaseWakeLock()
            return
        }
        val baseUrl = sp.getString("baseUrl", null)?.trimEnd('/')
        val token = sp.getString("token", null)
        val deviceId = sp.getString("deviceId", null)
        if (baseUrl.isNullOrEmpty() || token.isNullOrEmpty() || deviceId.isNullOrEmpty()) {
            Log.w(TAG, "uploadScreenshotNatively skipped: missing config (baseUrl=$baseUrl, tokenPresent=${!token.isNullOrEmpty()}, deviceId=$deviceId)")
            releaseWakeLock()
            return
        }

        screenshotHandler?.post {
            acquireWakeLock(30000L)
            var success = false
            for (attempt in 1..3) {
                var conn: java.net.HttpURLConnection? = null
                try {
                    // boundary 不能用 "=" 开头/结尾（旧实现 "====ts====" 会被 multer/busboy
                    // 的参数解析吞掉第一个 "=" 导致永远找不到 file part，真机实测 400）
                    val boundary = "----clipsync" + System.currentTimeMillis()
                    val url = java.net.URL("$baseUrl/api/media/image")
                    conn = url.openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.connectTimeout = 12000
                    conn.readTimeout = 15000
                    conn.doOutput = true
                    conn.doInput = true
                    conn.useCaches = false
                    conn.setRequestProperty("Authorization", "Bearer $token")
                    conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")

                    val os = conn.outputStream
                    val writer = java.io.PrintWriter(java.io.OutputStreamWriter(os, "UTF-8"), true)

                    // 1. sourceDeviceId field
                    writer.append("--$boundary\r\n")
                    writer.append("Content-Disposition: form-data; name=\"sourceDeviceId\"\r\n\r\n")
                    writer.append("$deviceId\r\n")
                    writer.flush()

                    // 2. image file field
                    val mime = if (mimeType.isNotBlank()) mimeType else "image/png"
                    val safeName = if (fileName.isNotBlank()) fileName else "Screenshot_${System.currentTimeMillis()}.png"
                    writer.append("--$boundary\r\n")
                    writer.append("Content-Disposition: form-data; name=\"image\"; filename=\"$safeName\"\r\n")
                    writer.append("Content-Type: $mime\r\n\r\n")
                    writer.flush()

                    os.write(bytes)
                    os.flush()

                    writer.append("\r\n--$boundary--\r\n")
                    writer.flush()
                    writer.close()

                    val code = conn.responseCode
                    if (code == 201) {
                        Log.i(TAG, "uploadScreenshotNatively SUCCESS: $safeName (${bytes.size} bytes)")
                        success = true
                        notifyScreenshotUploadedToDart(safeName, mime, bytes.size)
                        break
                    } else {
                        val errBody = try {
                            conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                        } catch (_: Throwable) { "" }
                        Log.w(TAG, "uploadScreenshotNatively attempt $attempt failed with code $code: $errBody")
                        if (code in 400..499) break
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "uploadScreenshotNatively attempt $attempt error: ${t.message}")
                    if (attempt < 3) {
                        try { Thread.sleep(600L * attempt) } catch (_: Throwable) {}
                    }
                } finally {
                    try { conn?.disconnect() } catch (_: Throwable) {}
                }
            }
            releaseWakeLock()
        }
    }

    /** 原生直传成功后尽力通知 Dart 刷新列表（仅元数据、不携带图片字节；引擎冻结时静默失败） */
    private fun notifyScreenshotUploadedToDart(fileName: String, mimeType: String, size: Int) {
        val channel = dartChannel ?: return
        mainHandler.post {
            try {
                channel.invokeMethod(
                    "onScreenshotCaptured",
                    mapOf<String, Any>(
                        "fileName" to fileName,
                        "mimeType" to mimeType,
                        "capturedAt" to System.currentTimeMillis(),
                        "size" to size,
                        "uploaded" to true
                    )
                )
            } catch (e: Exception) {
                Log.w(TAG, "notify onScreenshotCaptured(uploaded) failed", e)
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
