package com.clipsync.clipsync_mobile

import android.service.notification.NotificationListenerService
import android.util.Log

/**
 * 保活锚点（2026-09，用户要求的灰色技巧兜底）。
 *
 * 原理与输入法相同：NotificationListenerService 是系统托管的服务——用户在
 * 「设置 → 通知使用权」授权后，系统会持续绑定本服务；进程被杀时
 * NotificationManagerService 会自动重新 bind（通常秒级），等效于把进程拉活。
 * 这是对抗厂商 ROM force-stop 级清理的最后手段：START_STICKY/自愈闹钟在
 * force-stop 下全部失效，唯独系统托管绑定会在用户未手动撤销授权时恢复。
 *
 * 本服务本身不做任何通知处理（onNotificationPosted 不覆写），纯粹作为
 * 进程存活锚点。用户可在系统设置中随时撤销授权，撤销后自然回退到
 * 自愈闹钟链 + START_STICKY + 开机自启的组合。
 */
class KeepAliveNotificationListener : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i("KeepAliveNLS", "listener connected — process anchored by system binding")
    }
}
