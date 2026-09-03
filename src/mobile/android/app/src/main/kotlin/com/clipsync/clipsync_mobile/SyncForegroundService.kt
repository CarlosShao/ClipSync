package com.clipsync.clipsync_mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipDescription
import android.content.ClipboardManager
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

        /** 保存图片至系统公共相册 Pictures/ClipSync（支持 Android 10+ 分区存储与低版本兼容） */
        fun saveImageToAlbum(context: Context, bytes: ByteArray, name: String?, mime: String?): String? {
            val fileName = if (!name.isNullOrBlank()) name else "ClipSync_${System.currentTimeMillis()}.png"
            val mimeType = if (!mime.isNullOrBlank()) mime else "image/png"
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val resolver = context.contentResolver
                    val contentValues = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/ClipSync")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues)
                        ?: return null
                    resolver.openOutputStream(uri)?.use { os ->
                        os.write(bytes)
                        os.flush()
                    }
                    contentValues.clear()
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    resolver.update(uri, contentValues, null, null)
                    uri.toString()
                } else {
                    val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
                    val clipSyncDir = File(picturesDir, "ClipSync")
                    if (!clipSyncDir.exists()) clipSyncDir.mkdirs()
                    val destFile = File(clipSyncDir, fileName)
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
    private var lastProcessedScreenshotPath: String? = null
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

    private fun registerScreenshotObserver() {
        val handler = Handler(Looper.getMainLooper())
        val observer = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                super.onChange(selfChange, uri)
                checkLatestScreenshot()
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
            val projection = arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DATA,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.MIME_TYPE
            )
            val sortOrder = "${MediaStore.Images.Media.DATE_ADDED} DESC"
            contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                null,
                null,
                sortOrder
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val pathIndex = cursor.getColumnIndex(MediaStore.Images.Media.DATA)
                    val dateAddedIndex = cursor.getColumnIndex(MediaStore.Images.Media.DATE_ADDED)
                    val mimeIndex = cursor.getColumnIndex(MediaStore.Images.Media.MIME_TYPE)

                    val path = if (pathIndex >= 0) cursor.getString(pathIndex) else null
                    val dateAdded = if (dateAddedIndex >= 0) cursor.getLong(dateAddedIndex) else 0L
                    val mime = if (mimeIndex >= 0) cursor.getString(mimeIndex) else "image/png"

                    val nowSec = System.currentTimeMillis() / 1000
                    // 仅检测最近 15 秒内新增的图片，且路径或文件名包含截屏特征
                    if (path != null && (nowSec - dateAdded) in 0..15) {
                        val lower = path.lowercase()
                        val isScreenshot = lower.contains("screenshot") ||
                            lower.contains("截屏") ||
                            lower.contains("screen_shot") ||
                            lower.contains("screencap")
                        if (isScreenshot && path != lastProcessedScreenshotPath && (System.currentTimeMillis() - lastScreenshotTime > 1500)) {
                            lastProcessedScreenshotPath = path
                            lastScreenshotTime = System.currentTimeMillis()
                            Log.i(TAG, "Detected new screenshot: $path")
                            dispatchScreenshotCaptured(path, mime)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "checkLatestScreenshot error", e)
        }
    }

    private fun dispatchScreenshotCaptured(path: String, mime: String) {
        mainHandler.post {
            val channel = dartChannel ?: return@post
            val args = mapOf<String, Any>(
                "path" to path,
                "mimeType" to mime,
                "capturedAt" to System.currentTimeMillis()
            )
            try {
                channel.invokeMethod("onScreenshotCaptured", args)
            } catch (e: Exception) {
                Log.w(TAG, "invoke onScreenshotCaptured failed", e)
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
