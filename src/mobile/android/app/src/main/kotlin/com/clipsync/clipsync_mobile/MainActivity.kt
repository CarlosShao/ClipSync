package com.clipsync.clipsync_mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * T3.1/T3.2：承载 clipsync/sync MethodChannel（Dart ↔ 原生）。
 *
 * Dart → 原生方法：
 * - startService / stopService        启停前台同步服务（SyncForegroundService）
 * - isServiceRunning                  服务运行状态查询
 * - isBatteryOptimizationIgnored      电池优化豁免查询（T3.4 引导页消费）
 * - requestIgnoreBatteryOptimization  跳转电池优化豁免系统弹窗
 * - requestNotificationPermission     POST_NOTIFICATIONS 运行时权限申请（Android 13+）
 *
 * 原生 → Dart：
 * - onClipboardCaptured               前台服务采集到的系统剪贴板文本（SyncForegroundService 推送）
 */
class MainActivity : FlutterActivity() {

    companion object {
        private const val NOTIFICATION_PERMISSION_REQUEST = 7301
    }

    /** 进行中的通知权限申请结果回调（通道调用发生在主线程） */
    private var pendingNotificationResult: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val channel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            SyncForegroundService.METHOD_CHANNEL_NAME
        )
        // 交由前台服务持有，用于向 Dart 推送采集文本
        SyncForegroundService.dartChannel = channel
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "startService" -> {
                    SyncForegroundService.start(this)
                    result.success(true)
                }
                "stopService" -> {
                    SyncForegroundService.stop(this)
                    result.success(true)
                }
                "isServiceRunning" -> result.success(SyncForegroundService.isRunning)
                "isBatteryOptimizationIgnored" -> result.success(
                    SyncForegroundService.isIgnoringBatteryOptimizations(this)
                )
                "requestIgnoreBatteryOptimization" -> {
                    SyncForegroundService.requestIgnoreBatteryOptimizations(this)
                    result.success(true)
                }
                "requestNotificationPermission" -> requestNotificationPermission(result)
                else -> result.notImplemented()
            }
        }
    }

    override fun onDestroy() {
        // 引擎随 Activity 销毁时摘除通道引用，避免服务向已销毁引擎推送
        SyncForegroundService.dartChannel = null
        super.onDestroy()
    }

    // -------------------------------------------------------------------------
    // POST_NOTIFICATIONS 运行时权限（Android 13+）
    // -------------------------------------------------------------------------

    private fun requestNotificationPermission(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // 13 以下无需运行时申请
            result.success(true)
            return
        }
        val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            result.success(true)
            return
        }
        if (pendingNotificationResult != null) {
            // 已有申请在途，本次直接返回未授权（不重复弹窗）
            result.success(false)
            return
        }
        pendingNotificationResult = result
        requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATION_PERMISSION_REQUEST
        )
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            val result = pendingNotificationResult
            pendingNotificationResult = null
            val granted = grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED
            result?.success(granted)
            return
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }
}
