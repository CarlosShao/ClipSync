package com.clipsync.clipsync_mobile

import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.util.Log
import android.widget.Toast

/**
 * 一键同步剪贴板（2026-09）：透明 Activity，拉起即获得输入焦点 → 读取系统剪贴板 →
 * 有新文本立即原子上传 → 立即 finish，全程 <1 秒，无任何界面。
 *
 * 为什么需要它：Android 10+ 剪贴板读取只豁免「有输入焦点的应用」与默认输入法，
 * 后台/无障碍路径在这台 ROM 上均被拒绝（AppOps 实测：READ 仅发生在 top 状态）。
 * 本 Activity 是不切走当前应用的「借焦点」通道——入口：
 *   1. 前台服务常驻通知的「同步剪贴板」按钮
 *   2. 快捷设置磁贴（QuickSyncTile）
 * 用户在任何界面复制后点一下即可完成手机 → PC 的文本同步。
 */
class QuickSyncActivity : android.app.Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // translucent 主题，无布局

        var synced = false
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val clip = cm?.primaryClip
            if (clip != null && clip.itemCount > 0) {
                val desc = clip.description
                val isText = desc == null ||
                    desc.hasMimeType(android.content.ClipDescription.MIMETYPE_TEXT_PLAIN) ||
                    desc.hasMimeType("text/*")
                if (isText) {
                    val text = try {
                        clip.getItemAt(0).coerceToText(this)?.toString()
                    } catch (e: Exception) {
                        null
                    }
                    if (!text.isNullOrBlank() && text.length <= 100_000 &&
                        !ClipboardAccessibilityService.isEcho(text)
                    ) {
                        // 上传前先登记回声：无障碍轮询（前台时）读到同内容不再重复上传
                        ClipboardAccessibilityService.registerEcho(text)
                        NativeClipboardUploader.uploadAsync(this, text)
                        synced = true
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w("QuickSync", "quick sync failed", t)
        }

        // 顺手补扫截图 + 拉取远程内容（拿到焦点的瞬间能做的事一起做掉）
        SyncForegroundService.triggerScreenshotCheck()

        Toast.makeText(
            this,
            if (synced) "剪贴板已同步" else "剪贴板暂无新内容",
            Toast.LENGTH_SHORT
        ).show()

        finish()
    }
}
