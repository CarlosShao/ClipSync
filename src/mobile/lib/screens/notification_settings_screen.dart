import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../l10n/app_localizations.dart';
import '../providers/settings_provider.dart';
import '../services/app_exception.dart';
import '../services/server_config.dart';
import '../services/token_store.dart';

/// 通知设置页（B3 真实化，替换占位页）
///
/// 结构（Material 3，SwitchListTile 与 settings_screen 同款）：
/// 1. 「推送通知」本地开关：SettingsProvider.notificationsEnabled
///    （SharedPreferences 'notifications_enabled'，与设置页既有开关共用同一
///    字段两处联动；本地通知链路 LocalNotificationService 读同一键）；
/// 2. 「服务端通知偏好」：调后端通知偏好 API 读+写
///    （GET/PUT /api/notifications/preferences，字段对齐桌面端
///    src/desktop/src/api/notifications.ts 契约），失败 SnackBar 提示
///    （friendlyError / AppException 错误码映射，遵循 A3 基建）；
/// 3. 「系统通知设置」入口：经原生桥（clipsync/sync MethodChannel，
///    与 permission_guide_screen 跳电池/自启动设置同款方式）跳转
///    ACTION_APP_NOTIFICATION_SETTINGS。
class NotificationSettingsScreen extends StatefulWidget {
  const NotificationSettingsScreen({Key? key}) : super(key: key);

  @override
  State<NotificationSettingsScreen> createState() =>
      _NotificationSettingsScreenState();
}

class _NotificationSettingsScreenState extends State<NotificationSettingsScreen> {
  /// 服务端通知偏好类型（与桌面端 useNotifications.ts PREF_TYPE_BY_KEY 对齐）
  static const List<String> _serverPrefTypes = <String>[
    'device_online',
    'sync_complete',
    'security_alert',
    'product_update',
  ];

  /// 原生桥（clipsync/sync，由 MainActivity 承载；与 permission_guide_screen
  /// 同一通道契约）
  static const MethodChannel _nativeBridge = MethodChannel('clipsync/sync');

  /// 服务端偏好：type → enabled（缺失类型按默认开启展示）
  final Map<String, bool> _serverPrefs = <String, bool>{};
  bool _prefsLoading = false;

  @override
  void initState() {
    super.initState();
    _loadServerPrefs();
  }

  // ---------------------------------------------------------------------------
  // 服务端通知偏好（GET /api/notifications/preferences）
  // ---------------------------------------------------------------------------

  Future<void> _loadServerPrefs() async {
    setState(() => _prefsLoading = true);
    try {
      final map = await _NotificationPrefsApi.fetchPreferences();
      if (!mounted) return;
      setState(() {
        for (final type in _serverPrefTypes) {
          _serverPrefs[type] = map[type] ?? true;
        }
        _prefsLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _prefsLoading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(friendlyError(e, AppLocalizations.of(context))),
        ),
      );
    }
  }

  /// 切换服务端偏好：乐观更新 → PUT；失败回滚并 SnackBar 提示
  Future<void> _toggleServerPref(String type, bool enabled) async {
    setState(() => _serverPrefs[type] = enabled);
    try {
      await _NotificationPrefsApi.updatePreference(
        notificationType: type,
        enabled: enabled,
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _serverPrefs[type] = !enabled);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(friendlyError(e, AppLocalizations.of(context))),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 系统通知设置入口
  // ---------------------------------------------------------------------------

  /// 跳转 Android 应用通知设置（ACTION_APP_NOTIFICATION_SETTINGS，由原生桥
  /// 承载）；非 Android 平台或跳转失败时 SnackBar 降级提示。
  Future<void> _openSystemNotificationSettings() async {
    final l10n = AppLocalizations.of(context);
    if (!Platform.isAndroid) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.systemNotifSettingsFailed)),
      );
      return;
    }
    try {
      final ok =
          await _nativeBridge.invokeMethod<bool>('openAppNotificationSettings') ??
              false;
      if (!ok) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(l10n.systemNotifSettingsFailed)),
        );
      }
    } on PlatformException catch (e) {
      debugPrint('[NotificationSettings] open settings failed: ${e.message}');
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.systemNotifSettingsFailed)),
      );
    } on MissingPluginException {
      // 原生桥未注册：降级提示
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.systemNotifSettingsFailed)),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.notificationSettings),
      ),
      body: ListView(
        children: [
          // 1. 本地开关：新剪贴板通知（现有 pushNotifications 字段的正式 UI）
          SwitchListTile(
            secondary: const Icon(Icons.notifications_active_outlined),
            title: Text(l10n.pushNotifications),
            subtitle: Text(l10n.pushNotificationsDesc),
            value: context.watch<SettingsProvider>().notificationsEnabled,
            onChanged: (value) {
              context.read<SettingsProvider>().setNotificationsEnabled(value);
            },
          ),
          const Divider(),

          // 2. 服务端通知偏好（与账号同步，跨设备生效）
          _buildSectionHeader(l10n.serverNotifPrefs),
          if (_prefsLoading)
            const ListTile(
              leading: SizedBox(
                width: 24,
                height: 24,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else
            for (final type in _serverPrefTypes)
              SwitchListTile(
                title: Text(_serverPrefLabel(type, l10n)),
                value: _serverPrefs[type] ?? true,
                onChanged: (value) => _toggleServerPref(type, value),
              ),
          const Divider(),

          // 3. 系统通知设置入口
          ListTile(
            leading: const Icon(Icons.tune),
            title: Text(l10n.systemNotifSettings),
            subtitle: Text(l10n.systemNotifSettingsDesc),
            trailing: const Icon(Icons.chevron_right),
            onTap: _openSystemNotificationSettings,
          ),
          const SizedBox(height: 16),
        ],
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.bold,
          color: Theme.of(context).primaryColor,
        ),
      ),
    );
  }

  String _serverPrefLabel(String type, AppLocalizations l10n) {
    switch (type) {
      case 'device_online':
        return l10n.notifTypeDeviceOnline;
      case 'sync_complete':
        return l10n.notifTypeSyncComplete;
      case 'security_alert':
        return l10n.notifTypeSecurityAlert;
      case 'product_update':
        return l10n.notifTypeProductUpdate;
      default:
        return type;
    }
  }
}

/// 服务端通知偏好 API（本页私有客户端，对齐桌面端
/// src/desktop/src/api/notifications.ts 的既有契约，不改后端）：
///
/// - GET /api/notifications/preferences → [{ user_id, notification_type, enabled }]
/// - PUT /api/notifications/preferences  body: { notificationType, enabled }
///
/// 令牌解析沿用 TokenStore（secure storage，T1.2 冻结契约）；401 时静默
/// 续期一次后重试（与 clipboard_capture 既有链路一致）。
class _NotificationPrefsApi {
  _NotificationPrefsApi._();

  /// 类型 → enabled 映射；未出现在响应中的类型不在返回 Map 内（调用方兜底）
  static Future<Map<String, bool>> fetchPreferences() async {
    var token = await _requireToken();
    var response = await http.get(
      Uri.parse('${ServerConfig.baseUrl}/api/notifications/preferences'),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (response.statusCode == 401) {
      token = await _refreshOrThrow();
      response = await http.get(
        Uri.parse('${ServerConfig.baseUrl}/api/notifications/preferences'),
        headers: {'Authorization': 'Bearer $token'},
      );
    }
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.fetchNotificationPrefsFailed,
        'HTTP ${response.statusCode}',
      );
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! List) return <String, bool>{};
    final result = <String, bool>{};
    for (final row in decoded) {
      if (row is Map<String, dynamic> &&
          row['notification_type'] is String &&
          row['enabled'] is bool) {
        result[row['notification_type'] as String] = row['enabled'] as bool;
      }
    }
    return result;
  }

  static Future<void> updatePreference({
    required String notificationType,
    required bool enabled,
  }) async {
    var token = await _requireToken();
    var response = await http.put(
      Uri.parse('${ServerConfig.baseUrl}/api/notifications/preferences'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
      body: jsonEncode(<String, dynamic>{
        'notificationType': notificationType,
        'enabled': enabled,
      }),
    );
    if (response.statusCode == 401) {
      token = await _refreshOrThrow();
      response = await http.put(
        Uri.parse('${ServerConfig.baseUrl}/api/notifications/preferences'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: jsonEncode(<String, dynamic>{
          'notificationType': notificationType,
          'enabled': enabled,
        }),
      );
    }
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.updateNotificationPrefsFailed,
        'HTTP ${response.statusCode}',
      );
    }
  }

  static Future<String> _requireToken() async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    return token;
  }

  static Future<String> _refreshOrThrow() async {
    final renewed = await TokenStore.refreshAccessToken();
    if (renewed == null || renewed.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    return renewed;
  }
}
