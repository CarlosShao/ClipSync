import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 本地通知服务（T3.4 即时通知）
///
/// - flutter_local_notifications 封装：初始化 Android 双渠道
///   `clipsync_sync`（低优先级，剪贴板同步提醒，静默展示）与
///   `clipsync_alert`（默认优先级，供后续同步异常等告警使用）；
/// - WS 收到 new_clipboard → 弹「剪贴板已更新」本地通知（正文=内容预览），
///   点击导航回首页（冷启动时落在默认路由 `/`，经路由守卫同样回首页）；
/// - Android 13+ POST_NOTIFICATIONS 运行时权限申请（[requestPermission]，
///   由权限引导页 / 调用方触发，不在初始化时强弹）；
/// - 设置页既有「推送通知」开关（SharedPreferences `notifications_enabled`，
///   写入方 settings_screen / SettingsProvider）为关时不弹。
class LocalNotificationService {
  LocalNotificationService._();

  static final LocalNotificationService instance = LocalNotificationService._();

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  bool _initialized = false;

  /// 是否已完成初始化
  bool get isInitialized => _initialized;

  /// 通知点击回调（main.dart 挂载：跳转首页剪贴板 tab）
  void Function()? onNotificationTap;

  // Android 渠道定义（工单 T3.4 / T3.1 与 Manifest 侧约定）
  static const String syncChannelId = 'clipsync_sync';
  static const String alertChannelId = 'clipsync_alert';

  /// 剪贴板更新通知的固定 id（同一 id 重复弹出时更新而非堆积）
  static const int _clipboardNotificationId = 2001;

  /// 设置页「推送通知」偏好的 SharedPreferences 键（既有约定，勿改）
  static const String _prefKeyNotificationsEnabled = 'notifications_enabled';

  /// 初始化插件并创建双渠道。可安全重复调用（幂等）。
  Future<void> initialize() async {
    if (_initialized) return;

    const settings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    );

    try {
      await _plugin.initialize(
        settings,
        onDidReceiveNotificationResponse: _handleNotificationResponse,
      );

      final android = _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      if (android != null) {
        await android.createNotificationChannel(
          const AndroidNotificationChannel(
            syncChannelId,
            '剪贴板同步',
            description: '设备间剪贴板内容同步提醒（静默，不发出声音）',
            importance: Importance.low,
          ),
        );
        await android.createNotificationChannel(
          const AndroidNotificationChannel(
            alertChannelId,
            '同步告警',
            description: '同步异常、设备告警等重要提醒',
            importance: Importance.defaultImportance,
          ),
        );
      }
      _initialized = true;
    } catch (e) {
      debugPrint('[LocalNotification] initialize failed: $e');
    }
  }

  /// 申请 Android 13+ POST_NOTIFICATIONS 运行时权限。
  /// 返回是否被授予；低版本系统（无需运行时权限）返回 true。
  Future<bool> requestPermission() async {
    try {
      final android = _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      if (android == null) {
        // 非 Android 平台：无运行时权限概念
        return true;
      }
      final granted = await android.requestNotificationsPermission();
      return granted ?? false;
    } catch (e) {
      debugPrint('[LocalNotification] requestPermission failed: $e');
      return false;
    }
  }

  /// 系统通知是否已启用（Android 13+ 为运行时权限状态）
  Future<bool> areNotificationsEnabled() async {
    try {
      final android = _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      if (android == null) return true;
      return await android.areNotificationsEnabled() ?? false;
    } catch (_) {
      return false;
    }
  }

  /// WS new_clipboard 消息入口：检查设置开关 → 提取预览 → 弹通知。
  /// 任何失败都静默吞掉（通知失败不影响同步主链路）。
  Future<void> handleWsNewClipboard(Map<String, dynamic> msg) async {
    if (!_initialized) return;

    // 设置页「推送通知」开关为关时不弹（读写同一 SharedPreferences 键）
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!(prefs.getBool(_prefKeyNotificationsEnabled) ?? true)) return;
    } catch (_) {
      // 读偏好失败：按默认开启处理
    }

    final preview = _extractPreview(msg);
    await showClipboardUpdated(preview);
  }

  /// 弹「剪贴板已更新」通知（clipsync_sync 低优先级渠道）
  Future<void> showClipboardUpdated(String preview) async {
    if (!_initialized) return;

    final body = preview.isEmpty ? '收到新的剪贴板内容' : preview;
    try {
      await _plugin.show(
        _clipboardNotificationId,
        '剪贴板已更新',
        body,
        const NotificationDetails(
          android: AndroidNotificationDetails(
            syncChannelId,
            '剪贴板同步',
            channelDescription: '设备间剪贴板内容同步提醒（静默，不发出声音）',
            importance: Importance.low,
            priority: Priority.low,
            onlyAlertOnce: true,
            autoCancel: true,
          ),
        ),
        payload: 'new_clipboard',
      );
    } catch (e) {
      debugPrint('[LocalNotification] show failed: $e');
    }
  }

  // ---------------------------------------------------------------------------

  void _handleNotificationResponse(NotificationResponse response) {
    onNotificationTap?.call();
  }

  /// 从 WS 消息提取预览文本：兼容 `msg.item.contentPreview` 与顶层字段两种负载
  static String _extractPreview(Map<String, dynamic> msg) {
    final dynamic raw = msg['item'];
    final item = raw is Map<String, dynamic> ? raw : msg;
    final dynamic preview = item['contentPreview'] ?? item['preview'];
    if (preview is! String || preview.trim().isEmpty) return '';
    final trimmed = preview.trim().replaceAll('\n', ' ');
    return trimmed.length > 80 ? '${trimmed.substring(0, 80)}…' : trimmed;
  }
}
