import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../router/app_router.dart';
import '../../services/local_notification_service.dart';
import '../../theme/app_theme.dart';

/// 权限与保活引导页（T3.4）
///
/// 首次启动（完成 onboarding 且登录后）展示一次，分步卡片引导：
/// 1. 通知权限：POST_NOTIFICATIONS 运行时权限申请按钮（Android 13+）；
/// 2. 电池优化豁免：经原生桥 `clipsync/native_bridge` 检测并跳转系统设置；
///    原生桥未就绪（并行工单 T3.1 的 MethodChannel 尚未落地）或调用失败时
///    降级为手动路径提示文案；
/// 3. 自启动设置：尝试经原生桥跳转厂商自启动管理页，失败展示
///    常见国产 ROM 的通用指引文案。
///
/// 「完成 / 跳过」写入 SharedPreferences `permission_guide_shown` 并清空
/// 路由侧 pending 标记（app_router.dart 的 [PermissionGuideGate]），回首页。
class PermissionGuideScreen extends StatefulWidget {
  const PermissionGuideScreen({super.key});

  @override
  State<PermissionGuideScreen> createState() => _PermissionGuideScreenState();
}

class _PermissionGuideScreenState extends State<PermissionGuideScreen> {
  // 步骤状态：null = 未知 / 检测失败（原生能力缺失）
  bool? _notificationEnabled;
  bool? _batteryIgnored; // 是否已加入电池优化豁免白名单
  bool _batteryJumping = false;

  @override
  void initState() {
    super.initState();
    _refreshStatuses();
  }

  Future<void> _refreshStatuses() async {
    final notifEnabled =
        await LocalNotificationService.instance.areNotificationsEnabled();
    final batteryIgnored = await _NativeBridge.isBatteryOptimizationIgnored();
    if (!mounted) return;
    setState(() {
      _notificationEnabled = notifEnabled;
      _batteryIgnored = batteryIgnored;
    });
  }

  // ---------------------------------------------------------------------------
  // 步骤动作
  // ---------------------------------------------------------------------------

  Future<void> _requestNotificationPermission() async {
    final granted = await LocalNotificationService.instance
        .requestPermission();
    if (!mounted) return;
    setState(() => _notificationEnabled = granted);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(granted ? '通知权限已开启' : '通知权限未授予，可在系统设置中手动开启'),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  Future<void> _openBatteryOptimization() async {
    setState(() => _batteryJumping = true);
    final ok = await _NativeBridge.openBatteryOptimizationSettings();
    if (!mounted) return;
    setState(() => _batteryJumping = false);
    if (!ok) {
      _showManualGuide(
        '电池优化豁免',
        '未能自动跳转，请手动设置：\n\n'
            '系统设置 → 应用管理 → ClipSync → 电池\n'
            '→ 选择「不受限制 / 允许后台活动」\n\n'
            '部分机型路径为：设置 → 电池 → 更多电池设置 → 应用休眠。',
      );
      return;
    }
    // 从系统设置返回后重查状态
    final ignored = await _NativeBridge.isBatteryOptimizationIgnored();
    if (mounted) setState(() => _batteryIgnored = ignored);
  }

  Future<void> _openAutoStartSettings() async {
    final ok = await _NativeBridge.openAutoStartSettings();
    if (!mounted) return;
    if (!ok) {
      _showAutoStartGuide();
    }
  }

  void _showManualGuide(String title, String body) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(body, style: Theme.of(dialogContext).textTheme.bodyMedium),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('知道了'),
          ),
        ],
      ),
    );
  }

  /// 国产 ROM 自启动设置通用指引（跳转失败时展示）
  void _showAutoStartGuide() {
    _showManualGuide(
      '自启动设置',
      '不同厂商路径示例：\n\n'
          '· 小米 MIUI：安全中心 → 应用管理 → 权限 → 自启动管理 → 允许 ClipSync\n'
          '· 华为 EMUI/HarmonyOS：设置 → 应用 → 应用启动管理 → ClipSync → 手动管理（允许自启动/关联启动/后台活动）\n'
          '· OPPO ColorOS：手机管家 → 权限隐私 → 自启动管理 → 允许 ClipSync\n'
          '· vivo OriginOS：i管家 → 应用管理 → 权限管理 → 自启动 → 允许 ClipSync',
    );
  }

  // ---------------------------------------------------------------------------
  // 完成 / 跳过：写标记 + 清 pending + 回首页（app_router 守卫放行）
  // ---------------------------------------------------------------------------

  Future<void> _finish() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool('permission_guide_shown', true);
    } catch (_) {
      // 写标记失败：下次启动可能再次展示，可接受
    }
    PermissionGuideGate.pending.value = false;
    // 引导页挂在根级（非 shell 分支），完成后回主页默认分支
    if (!mounted) return;
    context.go(AppRoutes.homeClipboard);
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('权限与保活引导'),
        automaticallyImplyLeading: false,
      ),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          Text(
            '为了让「电脑复制 → 手机秒到」持续生效，建议完成以下 3 步设置：',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          _buildNotificationCard(theme),
          const SizedBox(height: AppSpacing.md),
          _buildBatteryCard(theme),
          const SizedBox(height: AppSpacing.md),
          _buildAutoStartCard(theme),
          const SizedBox(height: AppSpacing.xl),
          FilledButton(
            onPressed: _finish,
            child: const Text('完成，开始使用'),
          ),
          const SizedBox(height: AppSpacing.sm),
          TextButton(
            onPressed: _finish,
            child: const Text('跳过'),
          ),
          const SizedBox(height: AppSpacing.lg),
        ],
      ),
    );
  }

  Widget _buildNotificationCard(ThemeData theme) {
    return _GuideCard(
      icon: Icons.notifications_active_rounded,
      title: '1. 通知权限',
      description: '接收「剪贴板已更新」即时通知（Android 13+ 需授权）。',
      statusText: _statusLabel(_notificationEnabled, '已开启', '未开启'),
      statusColor: _statusColor(_notificationEnabled),
      actionLabel: '申请通知权限',
      onAction: _requestNotificationPermission,
    );
  }

  Widget _buildBatteryCard(ThemeData theme) {
    return _GuideCard(
      icon: Icons.battery_saver_rounded,
      title: '2. 电池优化豁免',
      description: '加入电池优化白名单，避免息屏后同步断连、通知延迟。',
      statusText: _batteryIgnored == null
          ? '暂无法自动检测（需应用原生支持）'
          : _statusLabel(_batteryIgnored, '已豁免', '未豁免'),
      statusColor: _batteryIgnored == null
          ? theme.colorScheme.onSurfaceVariant
          : _statusColor(_batteryIgnored),
      actionLabel: _batteryJumping ? '跳转中…' : '前往电池优化设置',
      onAction: _batteryJumping ? null : _openBatteryOptimization,
    );
  }

  Widget _buildAutoStartCard(ThemeData theme) {
    return _GuideCard(
      icon: Icons.restart_alt_rounded,
      title: '3. 自启动设置',
      description: '允许 ClipSync 自启动与后台运行，开机后自动恢复同步。',
      statusText: '按厂商规则各异，建议手动确认',
      statusColor: theme.colorScheme.onSurfaceVariant,
      actionLabel: '前往自启动设置',
      onAction: _openAutoStartSettings,
    );
  }

  String _statusLabel(bool? value, String yes, String no) {
    if (value == null) return '未知';
    return value ? yes : no;
  }

  Color _statusColor(bool? value) {
    final scheme = Theme.of(context).colorScheme;
    if (value == null) return scheme.onSurfaceVariant;
    return value ? AppColors.success : AppColors.warning;
  }
}

// -----------------------------------------------------------------------------
// 引导卡片
// -----------------------------------------------------------------------------

class _GuideCard extends StatelessWidget {
  const _GuideCard({
    required this.icon,
    required this.title,
    required this.description,
    required this.statusText,
    required this.statusColor,
    required this.actionLabel,
    required this.onAction,
  });

  final IconData icon;
  final String title;
  final String description;
  final String statusText;
  final Color statusColor;
  final String actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: scheme.primaryContainer,
                    borderRadius: BorderRadius.circular(AppRadius.md),
                  ),
                  child: Icon(icon, size: 22, color: scheme.onPrimaryContainer),
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Text(title, style: theme.textTheme.titleMedium),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              description,
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            Row(
              children: [
                Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: statusColor,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    statusText,
                    style: theme.textTheme.labelMedium
                        ?.copyWith(color: statusColor),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            SizedBox(
              width: double.infinity,
              child: FilledButton.tonal(onPressed: onAction, child: Text(actionLabel)),
            ),
          ],
        ),
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// 原生桥（依赖并行工单 T3.1/W3-A 在 android/ 侧注册同名 MethodChannel）
// -----------------------------------------------------------------------------

/// 原生能力桥：电池优化豁免检测 / 系统设置跳转 / 自启动页跳转。
///
/// 通道契约（供 W3-A 实现，见交付报告 Manifest 清单）：
/// - MethodChannel 名称：`clipsync/native_bridge`
/// - `isBatteryOptimizationIgnored` → bool
/// - `openBatteryOptimizationSettings` → void（ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 或设置页）
/// - `openAutoStartSettings` → void（尝试常见厂商自启动页，全部失败抛 PlatformException）
///
/// 原生侧未注册时 MissingPluginException → 本类全部降级返回 null/false，
/// UI 层显示手动指引文案，不崩溃。
class _NativeBridge {
  _NativeBridge._();

  /// 统一走 W3-A 前台服务的既有通道（clipsync/sync，MainActivity 承载），
  /// 电池检测/跳转由 SyncForegroundService 侧实现
  static const MethodChannel _channel = MethodChannel('clipsync/sync');

  /// 是否已豁免电池优化。null = 检测失败（非致命，页面降级展示）。
  static Future<bool?> isBatteryOptimizationIgnored() async {
    if (!Platform.isAndroid) return true; // 非 Android 平台无此概念
    try {
      return await _channel.invokeMethod<bool>('isBatteryOptimizationIgnored');
    } catch (_) {
      return null;
    }
  }

  /// 跳转电池优化授权弹窗。返回 false = 跳转失败（需手动指引）。
  static Future<bool> openBatteryOptimizationSettings() async {
    if (!Platform.isAndroid) return false;
    try {
      await _channel.invokeMethod<void>('requestIgnoreBatteryOptimization');
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 跳转自启动设置（原生侧尝试常见厂商包名/组件）。
  /// 返回 false = 原生侧未实现 / 跳转失败（需通用指引文案）。
  static Future<bool> openAutoStartSettings() async {
    if (!Platform.isAndroid) return false;
    try {
      await _channel.invokeMethod<void>('openAutoStartSettings');
      return true;
    } catch (_) {
      return false;
    }
  }
}
