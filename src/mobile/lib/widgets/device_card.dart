import 'package:flutter/material.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/models/device.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/widgets/common/app_card.dart';

/// 设备展示卡片 (DeviceCard v2 - Obsidian)。
///
/// 规范要求：
/// - 48dp tonal 大图标容器（SurfaceTier.mid / AppShapesV2.sm 圆角）；
/// - 在线状态面积表达（在线=successContainer 浅绿微光，离线=surfaceContainer 中性色），带在线状态点；
/// - 当前设备展示 Badge「本机 / This Device」；
/// - 展示设备名称、平台及版本、最后活跃时间；
/// - 操作：支持点击或长按唤起操作（支持自定义 onTap / onLongPress）。
class DeviceCard extends StatelessWidget {
  /// 创建 DeviceCard v2。
  const DeviceCard({
    required this.device,
    super.key,
    this.isCurrent = false,
    this.onTap,
    this.onLongPress,
  });

  /// 设备信息实体。
  final Device device;

  /// 是否为本机。
  final bool isCurrent;

  /// 点击回调。
  final VoidCallback? onTap;

  /// 长按回调。
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme scheme = theme.colorScheme;
    final TextTheme textTheme = theme.textTheme;
    final AppLocalizations l10n = AppLocalizations.of(context);

    final String deviceName =
        device.deviceName.isEmpty ? l10n.unknownDevice : device.deviceName;

    final String statusText =
        device.isOnline ? l10n.deviceOnline : l10n.deviceOffline;

    final String platformVersionStr =
        device.platformVersion != null && device.platformVersion!.isNotEmpty
            ? " ${device.platformVersion}"
            : "";

    final String platformDisplay = "${device.platform}$platformVersionStr";

    // 在线状态面积色调：在线用绿色 successContainer 微光，离线用中性 surfaceContainer
    final Color cardBgColor = device.isOnline
        ? (theme.brightness == Brightness.dark
            ? const Color(0xFF0F291E)
            : const Color(0xFFF0FDF4))
        : (theme.brightness == Brightness.dark
            ? AppColorsV2.surfaceLowDark
            : AppColorsV2.surfaceLowLight);

    final Color cardBorderColor = device.isOnline
        ? (theme.brightness == Brightness.dark
            ? const Color(0xFF166534).withValues(alpha: 0.6)
            : const Color(0xFF86EFAC).withValues(alpha: 0.8))
        : AppColorsV2.borderFor(isDark: theme.brightness == Brightness.dark);

    return Semantics(
      label: l10n.deviceSemantics(deviceName, statusText),
      button: true,
      child: AppCard(
        color: cardBgColor,
        borderColor: cardBorderColor,
        onTap: onTap,
        onLongPress: onLongPress,
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: <Widget>[
            // 48dp tonal 容器大图标
            _buildDeviceIcon(context, theme),
            const SizedBox(width: AppSpacing.lg),

            // 设备信息
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  // 设备名 + 本机 Badge
                  Row(
                    children: <Widget>[
                      Flexible(
                        child: Text(
                          deviceName,
                          style: textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (isCurrent) ...<Widget>[
                        const SizedBox(width: AppSpacing.sm),
                        _buildCurrentBadge(context),
                      ],
                    ],
                  ),
                  const SizedBox(height: AppSpacing.xs),

                  // 平台与版本 · 在线/最后活跃
                  Row(
                    children: <Widget>[
                      // 在线状态点
                      _buildStatusDot(theme),
                      const SizedBox(width: 6),
                      Text(
                        statusText,
                        style: textTheme.bodySmall?.copyWith(
                          color: device.isOnline
                              ? (theme.brightness == Brightness.dark
                                  ? AppColors.successDark
                                  : AppColors.success)
                              : scheme.onSurfaceVariant,
                          fontWeight: device.isOnline
                              ? FontWeight.w500
                              : FontWeight.normal,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        "·",
                        style: TextStyle(color: scheme.onSurfaceVariant),
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          platformDisplay,
                          style: textTheme.bodySmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  if (device.lastSeenAt != null) ...<Widget>[
                    const SizedBox(height: 2),
                    Text(
                      "${l10n.lastActivePrefix}${_relativeTime(device.lastSeenAt, l10n)}",
                      style: textTheme.labelSmall?.copyWith(
                        color: scheme.onSurfaceVariant.withValues(alpha: 0.8),
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(width: AppSpacing.sm),
            // 设备类型徽章
            _buildDeviceTypeBadge(context),
          ],
        ),
      ),
    );
  }

  Widget _buildDeviceIcon(BuildContext context, ThemeData theme) {
    final bool isDark = theme.brightness == Brightness.dark;
    final Color iconBg = AppColorsV2.surfaceFor(
      tier: SurfaceTier.mid,
      isDark: isDark,
    );

    final Color iconColor = device.isOnline
        ? (isDark ? AppColors.successDark : AppColors.success)
        : theme.colorScheme.onSurfaceVariant;

    return Container(
      width: 48,
      height: 48,
      decoration: BoxDecoration(
        color: iconBg,
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
        border: Border.all(
          color: device.isOnline
              ? (isDark
                  ? const Color(0xFF166534).withValues(alpha: 0.5)
                  : const Color(0xFFBBF7D0))
              : AppColorsV2.borderFor(isDark: isDark),
        ),
      ),
      child: Icon(
        _getDeviceIcon(),
        color: iconColor,
        size: 24,
      ),
    );
  }

  Widget _buildStatusDot(ThemeData theme) {
    final bool isDark = theme.brightness == Brightness.dark;
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: device.isOnline
            ? (isDark ? AppColors.successDark : AppColors.success)
            : (isDark ? Colors.white24 : Colors.black26),
        shape: BoxShape.circle,
        boxShadow: device.isOnline
            ? <BoxShadow>[
                BoxShadow(
                  color: (isDark ? AppColors.successDark : AppColors.success)
                      .withValues(alpha: 0.4),
                  blurRadius: 4,
                  spreadRadius: 1,
                ),
              ]
            : null,
      ),
    );
  }

  Widget _buildCurrentBadge(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(AppShapesV2.xs),
      ),
      child: Text(
        AppLocalizations.of(context).currentBadge,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: scheme.onPrimaryContainer,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }

  Widget _buildDeviceTypeBadge(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: AppSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppShapesV2.xs),
      ),
      child: Text(
        _getDeviceTypeLabel(context),
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }

  IconData _getDeviceIcon() {
    switch (device.deviceType.toLowerCase().trim()) {
      case "desktop":
        return Icons.computer_rounded;
      case "mobile":
        return Icons.smartphone_rounded;
      case "tablet":
        return Icons.tablet_mac_rounded;
      default:
        return Icons.devices_other_rounded;
    }
  }

  String _getDeviceTypeLabel(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context);
    switch (device.deviceType.toLowerCase().trim()) {
      case "desktop":
        return l10n.platformDesktop;
      case "mobile":
        return l10n.platformMobile;
      case "tablet":
        return l10n.platformTablet;
      default:
        return device.deviceType;
    }
  }

  static String _relativeTime(DateTime? time, AppLocalizations l10n) {
    if (time == null) {
      return l10n.unknown;
    }
    final Duration elapsed = DateTime.now().difference(time);
    if (elapsed < const Duration(minutes: 1)) {
      return l10n.relJustNow;
    }
    if (elapsed < const Duration(hours: 1)) {
      return l10n.relMinutesAgo(elapsed.inMinutes);
    }
    if (elapsed < const Duration(hours: 24)) {
      return l10n.relHoursAgo(elapsed.inHours);
    }
    if (elapsed < const Duration(days: 30)) {
      return l10n.relDaysAgo(elapsed.inDays);
    }
    final DateTime local = time.toLocal();
    return l10n.relDateYMD(local.year, local.month, local.day);
  }
}