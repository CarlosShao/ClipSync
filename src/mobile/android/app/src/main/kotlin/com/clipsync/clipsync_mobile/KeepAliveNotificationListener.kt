package com.clipsync.clipsync_mobile

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * 保活锚点 + 验证码自动同步（2026-09）。
 *
 * 1) 保活：系统托管绑定，进程被杀自动重绑（与输入法同类机制）。
 *
 * 2) 验证码自动接力（杀手场景）：手机收到含验证码的短信/通知时，无需用户复制，
 *    直接把验证码推送到服务端 → PC 剪贴板立即变为该验证码 → 用户在电脑上直接
 *    Ctrl+V。比「复制 → 同步」快一步，完美覆盖「手机收验证码 → 电脑粘贴」场景。
 *    只上传提取出的验证码数字本身，不上传短信全文（隐私）。
 *
 * 提取规则：通知文本含验证码关键词（验证码/校验码/动态码/OTP/code 等）时，
 * 取关键词后最近的 4-8 位纯数字。
 */
class KeepAliveNotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "KeepAliveNLS"

        /** 同一条通知去重窗口（毫秒） */
        private const val DEDUP_TTL_MS = 120_000L

        /** 已推送的通知指纹（pkg|code -> 时间戳） */
        private val recentPushes = ConcurrentHashMap<String, Long>()

        private val CODE_KEYWORDS = listOf(
            "验证码", "校验码", "动态码", "动态密码", "确认码",
            "verification code", "verify code", "security code", "otp", "one-time code", "passcode"
        )
        private val CODE_PATTERN = Regex("\\d{4,8}")

        /** 最近一次验证码提取结果（QuickSync/调试可读） */
        @Volatile
        var lastExtractedCode: String? = null
            private set
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "listener connected — process anchored by system binding")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        try {
            if (sbn == null || sbn.isOngoing) return
            val pkg = sbn.packageName ?: return
            // 自家通知与系统持久通知（充电中/VPN 图标等）跳过
            if (pkg == packageName) return

            val text = extractNotificationText(sbn.notification) ?: return
            if (text.length > 600) return
            val lower = text.lowercase()
            if (CODE_KEYWORDS.none { lower.contains(it) }) return

            val code = extractCode(text) ?: return
            val fingerprint = "$pkg|$code"
            val now = System.currentTimeMillis()
            val last = recentPushes[fingerprint]
            if (last != null && now - last < DEDUP_TTL_MS) return
            recentPushes[fingerprint] = now
            prune(now)

            lastExtractedCode = code
            Log.i(TAG, "OTP captured from $pkg: $code — pushing to PC")

            // 验证码以文本条目推送到服务端 → 广播 → PC 剪贴板自动写入
            NativeClipboardUploader.uploadAsync(applicationContext, code)
        } catch (t: Throwable) {
            Log.w(TAG, "onNotificationPosted error", t)
        }
    }

    private fun extractNotificationText(n: Notification): String? {
        val sb = StringBuilder()
        try {
            n.extras?.getCharSequence(Notification.EXTRA_TEXT)?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            n.extras?.getCharSequence(Notification.EXTRA_BIG_TEXT)?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            n.extras?.getCharSequence(Notification.EXTRA_TITLE)?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            val messages = n.extras?.getParcelableArray(Notification.EXTRA_MESSAGES)
            messages?.forEach { item ->
                (item as? Notification.MessagingStyle.Message)?.text?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            }
        } catch (_: Throwable) {
        }
        val result = sb.toString().trim()
        return result.ifEmpty { null }
    }

    /** 取验证码关键词后最近的 4-8 位数字；无关键词上下文时退化为文本中第一个 4-8 位数字 */
    private fun extractCode(text: String): String? {
        val lower = text.lowercase()
        var best: String? = null
        for (kw in CODE_KEYWORDS) {
            var idx = lower.indexOf(kw)
            while (idx >= 0) {
                val window = text.substring(idx, (idx + kw.length + 40).coerceAtMost(text.length))
                CODE_PATTERN.find(window)?.let { m ->
                    if (best == null || m.value.length > best!!.length) best = m.value
                }
                idx = lower.indexOf(kw, idx + kw.length)
            }
        }
        if (best != null) return best
        return CODE_PATTERN.find(text)?.value
    }

    private fun prune(now: Long) {
        recentPushes.entries.removeIf { now - it.value > DEDUP_TTL_MS }
    }
}
