import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/router/app_router.dart';
import 'package:clipsync_mobile/services/local_notification_service.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/widgets/common/app_card.dart';

/// 权限与保活引导页 (Obsidian v2)。
///
/// 首次启动（完成 onboarding 且登录后）展示一次，分步卡片引导：
/// 1. 通知权限：POST_NOTIFICATIONS 运行时权限申请按钮（Android 13+）；
/// 2. 电池优化豁免：经原生桥检测并跳转系统设置；原生桥未就绪降级为手动路径提示；
/// 3. 自启动设置：尝试经原生桥跳转厂商自启动管理页，失败展示通用指引。
///
/// 视觉与交互规范 (Obsidian v2)：
/// - displaySmall 页面主标题 + 优雅的引导副标题；
/// - AppCard v2 容器分步展示各项系统权限与状态指示；
/// - 按钮与动效全面对齐 tokens_v2（AppShapesV2、AppMotionV2、SurfaceTier）。
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
    final granted =
        await LocalNotificationService.instance.requestPermission();
    if (!mounted) return;
    setState(() => _notificationEnabled = granted);
    final l10n = AppLocalizations.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          granted ? l10n.notifPermissionGranted : l10n.notifPermissionDenied,
        ),
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
      final l10n = AppLocalizations.of(context);
      _showManualGuide(l10n.batteryTitle, l10n.batteryManualGuide);
      return;
    }
    // 从系统设置返回后重查状态
    final ignored = await _NativeBridge.isBatteryOptimizationIgnored();
    if (mounted) {
      setState(() => _batteryIgnored = ignored);
    }
  }

  Future<void> _openAutoStartSettings() async {
    final ok = await _NativeBridge.openAutoStartSettings();
    if (!mounted) return;
    if (!ok) {
      _showAutoStartGuide();
    }
  }

  void _showManualGuide(String title, String body) {
    final l10n = AppLocalizations.of(context);
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: AppShapesV2.brLg),
        title: Text(title),
        content: Text(
          body,
          style: Theme.of(dialogContext).textTheme.bodyMedium,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: Text(l10n.gotIt),
          ),
        ],
      ),
    );
  }

  /// 国产 ROM 自启动设置通用指引（跳转失败时展示）
  void _showAutoStartGuide() {
    final l10n = AppLocalizations.of(context);
    _showManualGuide(l10n.autoStartTitle, l10n.autoStartGuide);
  }

  // ---------------------------------------------------------------------------
  // 完成 / 跳过：写标记 + 清 pending + 回首页
  // ---------------------------------------------------------------------------

  Future<void> _finish() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool('permission_guide_shown', true);
    } catch (_) {
      // 写标记失败不中断流程
    }
    PermissionGuideGate.pending.value = false;
    if (!mounted) return;
    context.go(AppRoutes.homeClipboard);
  }

  // ---------------------------------------------------------------------------
  // 构建页面
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    final l10n = AppLocalizations.of(context);
    final brandPrimary =
        isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight;

    return Scaffold(
      backgroundColor: AppColorsV2.surface(context, tier: SurfaceTier.base),
      body: Stack(
        children: [
          // 顶部轻量微光环境
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 240,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    brandPrimary.withValues(alpha: 0.06),
                    brandPrimary.withValues(alpha: 0.0),
                  ],
                ),
              ),
            ),
          ),
          SafeArea(
            child: ListView(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.xl,
                vertical: AppSpacing.lg,
              ),
              children: [
                const SizedBox(height: AppSpacing.md),
                // 顶部标题区（displaySmall 规范大标题）
                Text(
                  l10n.permissionGuideTitle,
                  style: theme.textTheme.displaySmall?.copyWith(
                    fontWeight: FontWeight.bold,
                    letterSpacing: -0.5,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  l10n.permissionGuideIntro,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: AppSpacing.xl),

                // 权限卡片 1：通知
                _buildNotificationCard(theme, isDark),
                const SizedBox(height: AppSpacing.md),

                // 权限卡片 2：电池优化
                _buildBatteryCard(theme, isDark),
                const SizedBox(height: AppSpacing.md),

                // 权限卡片 3：自启动与后台保护
                _buildAutoStartCard(theme, isDark),
                const SizedBox(height: AppSpacing.xxl),

                // 底部主按钮与跳过按钮
                SizedBox(
                  width: double.infinity,
                  height: 54,
                  child: FilledButton(
                    onPressed: _finish,
                    style: FilledButton.styleFrom(
                      shape: const RoundedRectangleBorder(
                        borderRadius: AppShapesV2.brSm,
                      ),
                    ),
                    child: Text(
                      l10n.finishAndStart,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                Center(
                  child: TextButton(
                    onPressed: _finish,
                    style: TextButton.styleFrom(
                      foregroundColor: theme.colorScheme.onSurfaceVariant,
                    ),
                    child: Text(l10n.skip),
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildNotificationCard(ThemeData theme, bool isDark) {
    final l10n = AppLocalizations.of(context);
    final accent = isDark ? AppColorsV2.typeImageDark : AppColorsV2.typeImageLight;
    return _GuideCard(
      icon: Icons.notifications_active_rounded,
      accentColor: accent,
      title: l10n.stepNotifTitle,
      description: l10n.stepNotifDesc,
      statusText: _statusLabel(
        _notificationEnabled,
        l10n.statusOn,
        l10n.statusOff,
      ),
      statusColor: _statusColor(_notificationEnabled),
      actionLabel: l10n.requestNotifPermission,
      onAction: _requestNotificationPermission,
    );
  }

  Widget _buildBatteryCard(ThemeData theme, bool isDark) {
    final l10n = AppLocalizations.of(context);
    final accent = isDark ? AppColorsV2.typeColorDark : AppColorsV2.typeColorLight;
    return _GuideCard(
      icon: Icons.battery_saver_rounded,
      accentColor: accent,
      title: l10n.stepBatteryTitle,
      description: l10n.stepBatteryDesc,
      statusText: _batteryIgnored == null
          ? l10n.statusUndetected
          : _statusLabel(
              _batteryIgnored,
              l10n.statusExempted,
              l10n.statusNotExempted,
            ),
      statusColor: _batteryIgnored == null
          ? theme.colorScheme.onSurfaceVariant
          : _statusColor(_batteryIgnored),
      actionLabel: _batteryJumping ? l10n.jumping : l10n.gotoBatterySettings,
      onAction: _batteryJumping ? null : _openBatteryOptimization,
    );
  }

  Widget _buildAutoStartCard(ThemeData theme, bool isDark) {
    final l10n = AppLocalizations.of(context);
    final accent = isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight;
    return _GuideCard(
      icon: Icons.restart_alt_rounded,
      accentColor: accent,
      title: l10n.stepAutoStartTitle,
      description: l10n.stepAutoStartDesc,
      statusText: l10n.autoStartStatusHint,
      statusColor: theme.colorScheme.onSurfaceVariant,
      actionLabel: l10n.gotoAutoStartSettings,
      onAction: _openAutoStartSettings,
    );
  }

  String _statusLabel(bool? value, String yes, String no) {
    if (value == null) {
      return AppLocalizations.of(context).unknown;
    }
    return value ? yes : no;
  }

  Color _statusColor(bool? value) {
    final scheme = Theme.of(context).colorScheme;
    if (value == null) {
      return scheme.onSurfaceVariant;
    }
    return value ? AppColors.success : AppColors.warning;
  }
}

// -----------------------------------------------------------------------------
// 引导卡片（基于 AppCard v2）
// -----------------------------------------------------------------------------

class _GuideCard extends StatelessWidget {
  const _GuideCard({
    required this.icon,
    required this.accentColor,
    required this.title,
    required this.description,
    required this.statusText,
    required this.statusColor,
    required this.actionLabel,
    required this.onAction,
  });

  final IconData icon;
  final Color accentColor;
  final String title;
  final String description;
  final String statusText;
  final Color statusColor;
  final String actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return AppCard(
      surfaceTier: SurfaceTier.low,
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: accentColor.withValues(alpha: 0.12),
                  borderRadius: const BorderRadius.all(AppShapesV2.rSm),
                ),
                child: Icon(icon, size: 24, color: accentColor),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Text(
                  title,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            description,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              height: 1.4,
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: statusColor,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  statusText,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: statusColor,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          SizedBox(
            width: double.infinity,
            height: 46,
            child: FilledButton.tonal(
              onPressed: onAction,
              style: FilledButton.styleFrom(
                shape: const RoundedRectangleBorder(
                  borderRadius: AppShapesV2.brSm,
                ),
              ),
              child: Text(
                actionLabel,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// 原生桥
// -----------------------------------------------------------------------------

class _NativeBridge {
  _NativeBridge._();

  static const MethodChannel _channel = MethodChannel('clipsync/sync');

  static Future<bool?> isBatteryOptimizationIgnored() async {
    if (!Platform.isAndroid) {
      return true;
    }
    try {
      return await _channel.invokeMethod<bool>('isBatteryOptimizationIgnored');
    } catch (_) {
      return null;
    }
  }

  static Future<bool> openBatteryOptimizationSettings() async {
    if (!Platform.isAndroid) {
      return false;
    }
    try {
      await _channel.invokeMethod<void>('requestIgnoreBatteryOptimization');
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> openAutoStartSettings() async {
    if (!Platform.isAndroid) {
      return false;
    }
    try {
      await _channel.invokeMethod<void>('openAutoStartSettings');
      return true;
    } catch (_) {
      return false;
    }
  }
}

