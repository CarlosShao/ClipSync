package com.clipsync.clipsync_mobile

import android.service.quicksettings.TileService

/**
 * 快捷设置磁贴「同步剪贴板」：任意界面下拉快捷面板点一下 → 拉起透明
 * QuickSyncActivity（借焦点读取剪贴板并同步）→ 自动收回，无需切换应用。
 */
class QuickSyncTile : TileService() {
    override fun onClick() {
        super.onClick()
        try {
            startActivity(
                android.content.Intent(this, QuickSyncActivity::class.java)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (_: Throwable) {
        }
    }
}
