import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 本地通知文案配置（A3 解耦：服务层无 BuildContext，由 main.dart 在
/// MaterialApp builder 首帧后取 AppLocalizations 注入；locale 切换时
/// builder 重建会再次注入，通知文案跟随语言）。
class NotificationTexts {
  const NotificationTexts({
    required this.channelClipboardName,
    required this.channelClipboardDesc,
    required this.channelAlertName,
    required this.channelAlertDesc,
    required this.clipboardUpdatedTitle,
    required this.newClipboardBody,
  });

  /// 剪贴板同步渠道名
  final String channelClipboardName;

  /// 剪贴板同步渠道描述
  final String channelClipboardDesc;

  /// 同步告警渠道名
  final String channelAlertName;

  /// 同步告警渠道描述
  final String channelAlertDesc;

  /// 「剪贴板已更新」通知标题
  final String clipboardUpdatedTitle;

  /// 无预览内容时的通知正文
  final String newClipboardBody;
}

/// 本地通知服务（T3.4 即时通知）
///
/// - flutter_local_notifications 封装：初始化 Android 双渠道
///   `clipsync_sync`（低优先级，剪贴板同步提醒，静默展示）与
///   `clipsync_alert`（默认优先级，供后续同步异常等告警使用）；
///   渠道名/描述等文案经 [applyTexts] 注入（[NotificationTexts]）；
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
  bool _channelsCreated = false;
  NotificationTexts? _texts;

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

  /// 注入本地化文案（main.dart 的 MaterialApp builder 每次构建时调用；
  /// 渠道尚未创建且插件已初始化时补建渠道，幂等）。
  void applyTexts(NotificationTexts texts) {
    _texts = texts;
    if (_initialized && !_channelsCreated) {
      unawaited(_createChannels());
    }
  }

  /// 初始化插件。可安全重复调用（幂等）。
  /// 渠道创建延后到 [applyTexts] 提供文案后进行（首帧前文案未就绪）。
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
      _initialized = true;
    } catch (e) {
      debugPrint('[LocalNotification] initialize failed: $e');
      return;
    }
    // 文案已先行注入（如热重启后二次初始化）时直接补建渠道
    await _createChannels();
  }

  /// 创建/更新 Android 双渠道（幂等；重复创建即更新名称与描述）。
  Future<void> _createChannels() async {
    final texts = _texts;
    if (texts == null || _channelsCreated) return;
    try {
      final android = _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      if (android != null) {
        await android.createNotificationChannel(
          AndroidNotificationChannel(
            syncChannelId,
            texts.channelClipboardName,
            description: texts.channelClipboardDesc,
            importance: Importance.low,
          ),
        );
        await android.createNotificationChannel(
          AndroidNotificationChannel(
            alertChannelId,
            texts.channelAlertName,
            description: texts.channelAlertDesc,
            importance: Importance.defaultImportance,
          ),
        );
        _channelsCreated = true;
      }
    } catch (e) {
      debugPrint('[LocalNotification] create channels failed: $e');
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

  /// 弹「剪贴板已更新」通知（clipsync_sync 低优先级渠道）。
  /// 文案尚未注入（首帧前的极小窗口）时跳过本次弹通知。
  Future<void> showClipboardUpdated(String preview) async {
    if (!_initialized) return;
    final texts = _texts;
    if (texts == null) {
      debugPrint('[LocalNotification] skip show: texts not applied yet');
      return;
    }

    final body = preview.isEmpty ? texts.newClipboardBody : preview;
    try {
      await _plugin.show(
        _clipboardNotificationId,
        texts.clipboardUpdatedTitle,
        body,
        NotificationDetails(
          android: AndroidNotificationDetails(
            syncChannelId,
            texts.channelClipboardName,
            channelDescription: texts.channelClipboardDesc,
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
