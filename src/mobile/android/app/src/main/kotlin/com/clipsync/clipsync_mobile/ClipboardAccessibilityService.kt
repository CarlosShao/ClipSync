package com.clipsync.clipsync_mobile

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 无障碍剪贴板采集（2026-09：移动端文本后台同步的根本解法）。
 *
 * 背景：Android 10 起，无输入焦点的应用读取剪贴板一律返回 null（系统限制，
 * 仅前台焦点应用与默认输入法豁免）——前台服务本身永远没有焦点，所以
 * SyncForegroundService 的经典采集链路在后台/锁屏下拿到的是空内容，
 * 「手机复制文本 → PC」只在 App 前台时生效。
 *
 * 解法与输入法同源：无障碍服务属于系统信任组件，**豁免剪贴板焦点限制**，
 * 后台/锁屏都能读取。本服务不做任何屏幕内容分析（canRetrieveWindowContent=false），
 * 只做两件事：
 *   1. 屏幕亮起时每 2 秒轮询一次系统剪贴板（SCREEN_ON 立即补一次）
 *   2. 发现新文本（非回声）→ 原生直传 POST /api/clipboard（契约与 Dart 采集一致，
 *      服务端按 content_hash 去重，双路径并发不会产生重复条目）
 *
 * 回环抑制：手机剪贴板还可能被「Dart 收到 PC 文本后的回写」改写——那条文本
 * 不能再上传回服务端。Dart 侧在回写/采集上传时经 MethodChannel 调
 * [registerEcho] 登记 60 秒抑制窗口；Dart 冻结时不会发生回写，
 * 此时的剪贴板变更必为用户主动复制。
 *
 * 附带收益：无障碍绑定同样是系统托管绑定（进程死亡自动重绑），
 * 与 KeepAliveNotificationListener 一起构成保活锚点。
 */
class ClipboardAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "ClipboardA11y"

        /** 采集轮询间隔（毫秒） */
        private const val POLL_INTERVAL_MS = 2000L

        /** 回声抑制窗口（毫秒）：覆盖「Dart 上传/回写 → 本服务轮询读到」的时序差 */
        private const val ECHO_TTL_MS = 60_000L

        /** 文本长度上限（与 Dart ClipboardCapture._maxContentLength 对齐） */
        private const val MAX_CONTENT_LENGTH = 100_000

        @Volatile
        var isConnected: Boolean = false
            private set

        /** 回声抑制环：sha256(text) -> 登记时间戳 */
        private val echoHashes = ConcurrentHashMap<String, Long>()

        fun registerEcho(text: String) {
            if (text.isEmpty()) return
            echoHashes[sha256(text)] = System.currentTimeMillis()
            pruneEcho()
        }

        fun isEcho(text: String): Boolean {
            val seenAt = echoHashes[sha256(text)] ?: return false
            if (System.currentTimeMillis() - seenAt > ECHO_TTL_MS) {
                echoHashes.remove(sha256(text))
                return false
            }
            return true
        }

        private fun pruneEcho() {
            val now = System.currentTimeMillis()
            echoHashes.entries.removeIf { now - it.value > ECHO_TTL_MS }
        }

        private fun sha256(text: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val uploadInFlight = AtomicBoolean(false)

    @Volatile
    private var screenOn: Boolean = true

    private var lastUploadedHash: String? = null

    private var screenStateReceiver: BroadcastReceiver? = null

    private val pollRunnable = object : Runnable {
        override fun run() {
            try {
                if (screenOn) {
                    captureClipboard()
                }
            } catch (t: Throwable) {
                Log.w(TAG, "capture error", t)
            } finally {
                mainHandler.postDelayed(this, POLL_INTERVAL_MS)
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        isConnected = true
        screenOn = try {
            (getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager)?.isInteractive ?: true
        } catch (_: Throwable) { true }

        screenStateReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> {
                        screenOn = true
                        mainHandler.removeCallbacks(pollRunnable)
                        mainHandler.post(pollRunnable)
                    }
                    Intent.ACTION_SCREEN_OFF -> screenOn = false
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(screenStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(screenStateReceiver, filter)
            }
        } catch (e: Exception) {
            Log.w(TAG, "register screen receiver failed", e)
        }

        mainHandler.post(pollRunnable)
        Log.i(TAG, "accessibility clipboard capture connected (poll ${POLL_INTERVAL_MS}ms, screenOn=$screenOn)")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        isConnected = false
        mainHandler.removeCallbacks(pollRunnable)
        screenStateReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Throwable) {}
        }
        screenStateReceiver = null
        Log.i(TAG, "accessibility service unbound — capture falls back to foreground-only path")
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) {
        // 不消费无障碍事件：采集靠轮询，服务本身只为获取系统信任豁免
    }

    override fun onInterrupt() {}

    // -------------------------------------------------------------------------
    // 采集 + 原生直传
    // -------------------------------------------------------------------------

    private fun captureClipboard() {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        val clip = try {
            cm.primaryClip
        } catch (e: Exception) {
            null
        } ?: return
        if (clip.itemCount <= 0) return
        // 文本类型才采集（图片走截图检测管线；文件无剪贴板内容）
        val desc = clip.description
        if (desc != null && !desc.hasMimeType("text/*") &&
            !desc.hasMimeType(android.content.ClipDescription.MIMETYPE_TEXT_PLAIN)
        ) return
        val text = try {
            clip.getItemAt(0).coerceToText(this)?.toString()
        } catch (e: Exception) {
            null
        } ?: return
        if (text.isBlank() || text.length > MAX_CONTENT_LENGTH) return
        if (isEcho(text)) return
        val hash = sha256(text)
        if (hash == lastUploadedHash) return

        // 剪贴板采集总开关（B3）：Flutter SharedPreferences，键带 flutter. 前缀
        val captureEnabled = try {
            getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
                .getBoolean("flutter.clipboard_capture_enabled", true)
        } catch (_: Throwable) {
            true
        }
        if (!captureEnabled) return

        lastUploadedHash = hash
        uploadTextNatively(text)
    }

    private fun uploadTextNatively(text: String) {
        // 上传契约收敛到 NativeClipboardUploader（QuickSyncActivity 共用）
        NativeClipboardUploader.uploadAsync(applicationContext, text)
    }
}
