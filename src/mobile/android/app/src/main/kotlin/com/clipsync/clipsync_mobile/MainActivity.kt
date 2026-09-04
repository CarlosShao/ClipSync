package com.clipsync.clipsync_mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * T3.1/T3.2：承载 clipsync/sync MethodChannel（Dart ↔ 原生）。
 * T4.6：改继承 FlutterFragmentActivity（local_auth 生物识别的硬性要求）。
 *
 * Dart → 原生方法：
 * - startService / stopService        启停前台同步服务（SyncForegroundService）
 * - isServiceRunning                  服务运行状态查询
 * - isBatteryOptimizationIgnored      电池优化豁免查询（T3.4 引导页消费）
 * - requestIgnoreBatteryOptimization  跳转电池优化豁免系统弹窗
 * - openAutoStartSettings             尽力跳转厂商自启动设置页（全失败返回 false，Dart 降级指引）
 * - openAppNotificationSettings       跳转本应用系统通知设置页（B3 通知设置页消费）
 * - requestNotificationPermission     POST_NOTIFICATIONS 运行时权限申请（Android 13+）
 *
 * 原生 → Dart：
 * - onClipboardCaptured               前台服务采集到的系统剪贴板文本（SyncForegroundService 推送）
 */
class MainActivity : FlutterFragmentActivity() {

    companion object {
        private const val NOTIFICATION_PERMISSION_REQUEST = 7301
        private const val MEDIA_READ_PERMISSION_REQUEST = 7302
    }

    /** 进行中的通知权限申请结果回调（通道调用发生在主线程） */
    private var pendingNotificationResult: MethodChannel.Result? = null

    /** 进行中的媒体读取权限申请结果回调（截图同步用） */
    private var pendingMediaReadResult: MethodChannel.Result? = null

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
                "hasMediaReadPermission" -> result.success(hasMediaReadPermission())
                "requestMediaReadPermission" -> requestMediaReadPermission(result)
                "openAutoStartSettings" -> result.success(openAutoStartSettings())
                "openAppNotificationSettings" -> result.success(openAppNotificationSettings())
                "saveImageToAlbum" -> {
                    val bytes = call.argument<ByteArray>("bytes")
                    val fileName = call.argument<String>("fileName")
                    val mimeType = call.argument<String>("mimeType")
                    if (bytes != null) {
                        val savedPath = SyncForegroundService.saveImageToAlbum(this, bytes, fileName, mimeType)
                        result.success(savedPath)
                    } else {
                        result.error("INVALID_ARGS", "bytes cannot be null", null)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    // -------------------------------------------------------------------------
    // 厂商自启动设置页（尽力跳转：MIUI/EMUI/ColorOS/OriginOS/iQOO/一加，全失败返回 false 由 Dart 降级指引）
    // -------------------------------------------------------------------------

    private fun openAutoStartSettings(): Boolean {
        val components = listOf(
            "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.huawei.systemmanager/com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.coloros.safecenter/com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.oppo.safe/com.oppo.safe.permission.startup.StartupAppListActivity",
            "com.iqoo.secure/com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
            "com.oneplus.security/com.oneplus.security.chainlaunch.ChainLaunchAppListActivity"
        )
        for (component in components) {
            try {
                val parts = component.split("/")
                val intent = Intent()
                intent.setClassName(parts[0], parts[1])
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                return true
            } catch (e: Exception) {
                // 该厂商组件不存在，尝试下一个
            }
        }
        return false
    }

    // -------------------------------------------------------------------------
    // 应用通知设置页（B3：ACTION_APP_NOTIFICATION_SETTINGS；
    // 低版本系统无此入口时回退应用详情页，仍失败返回 false 由 Dart 降级提示）
    // -------------------------------------------------------------------------

    private fun openAppNotificationSettings(): Boolean {
        try {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            return true
        } catch (e: Exception) {
            try {
                val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(fallback)
                return true
            } catch (e: Exception) {
                return false
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
        if (requestCode == MEDIA_READ_PERMISSION_REQUEST) {
            val result = pendingMediaReadResult
            pendingMediaReadResult = null
            val granted = grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED
            result?.success(granted)
            return
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    // -------------------------------------------------------------------------
    // 媒体读取运行时权限（截图同步：Android 13+ READ_MEDIA_IMAGES，
    // ≤12 用 READ_EXTERNAL_STORAGE）。拒绝不阻塞主流程，仅截图同步不可用。
    // -------------------------------------------------------------------------

    private fun hasMediaReadPermission(): Boolean {
        val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestMediaReadPermission(result: MethodChannel.Result) {
        if (hasMediaReadPermission()) {
            result.success(true)
            return
        }
        if (pendingMediaReadResult != null) {
            pendingMediaReadResult?.success(false)
        }
        pendingMediaReadResult = result
        val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        requestPermissions(arrayOf(permission), MEDIA_READ_PERMISSION_REQUEST)
    }
}
