package com.clipsync.clipsync_mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 开机自启：系统启动完成后恢复剪贴板同步前台服务。
 *
 * - 仅当服务此前被用户启动过（serviceWanted=true，由 SyncForegroundService.start 写入、
 *   stop 清除）才自启；登出/主动停止后开机不会拉起
 * - Android 15 起 dataSync 类型不允许从 BOOT_COMPLETED 启动且有 6 小时运行上限，
 *   服务已在 API 34+ 切换为 specialUse 类型（无上限、允许开机启动）
 * - 各厂商「自启动」白名单仍需用户在系统设置中授予（MIUI 等无法代码绕过）
 */
class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != "android.intent.action.QUICKBOOT_POWERON") return
        val wanted = try {
            context.getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
                .getBoolean("serviceWanted", false)
        } catch (_: Throwable) {
            false
        }
        if (!wanted) {
            Log.i("BootCompletedReceiver", "service was not running before shutdown, skip autostart")
            return
        }
        Log.i("BootCompletedReceiver", "boot completed — restarting sync foreground service")
        SyncForegroundService.start(context)
    }
}
