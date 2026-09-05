package com.clipsync.clipsync_mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 周期自愈自检（2026-09 vivo/OriginOS 保活）：每 5 分钟被 WAKEUP 闹钟唤醒一次。
 *
 * - serviceWanted=true 且前台服务不在 → 重新拉起（覆盖 LMK 回收、崩溃、部分厂商
 *   「一键清理」等非 force-stop 场景；真正的 force-stop 连闹钟都会被系统撤销，
 *   只能靠用户授予自启动/后台高耗电白名单，无法代码绕过）
 * - 无论是否拉起都续排下一次自检，形成闹钟链；登出（serviceWanted=false）后不再续排
 */
class SyncKeepAliveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SyncForegroundService.ACTION_KEEPALIVE_CHECK) return
        if (!SyncForegroundService.isServiceWanted(context)) return
        if (!SyncForegroundService.isRunning) {
            Log.i("SyncKeepAliveReceiver", "keepalive check: service dead, restarting")
            SyncForegroundService.start(context)
        } else {
            Log.d("SyncKeepAliveReceiver", "keepalive check: service alive")
        }
        SyncForegroundService.scheduleKeepAliveAlarm(context)
    }
}
