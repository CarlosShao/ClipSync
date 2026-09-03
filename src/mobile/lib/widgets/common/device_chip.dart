import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/app_theme.dart';

/// 设备来源芯片 (Obsidian v2)。
///
/// 规范要求：
/// - leading 设备类型 icon + 设备名 + 在线状态点（绿色/灰色）；
/// - 紧凑尺寸，适配列表卡片元数据区（56-64dp 密度）；
/// - 支持点击回调（如查看设备详情）。
class DeviceChip extends StatelessWidget {
  /// 创建设备来源芯片。
  const DeviceChip({
    required this.deviceName,
    super.key,
    this.platform,
    this.isOnline,
    this.isCurrent = false,
    this.onTap,
  });

  /// 设备名称。
  final String deviceName;

  /// 操作系统/平台：windows / macos / linux / ios / android 等。
  final String? platform;

  /// 在线状态：true=在线（绿点），false=离线（灰点），null=不显示状态点。
  final bool? isOnline;

  /// 是否是当前本机。
  final bool isCurrent;

  /// 点击回调。
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final Color textColor = theme.colorScheme.onSurfaceVariant;
    final IconData icon = _platformIcon(platform);

    final Widget content = Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: isDark
            ? AppColorsV2.surfaceHighDark.withValues(alpha: 0.5)
            : AppColorsV2.surfaceHighLight,
        borderRadius: BorderRadius.circular(AppShapesV2.xs),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          Icon(icon, size: 12, color: textColor),
          const SizedBox(width: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 120),
            child: Text(
              deviceName,
              style: theme.textTheme.bodySmall?.copyWith(
                color: textColor,
                fontSize: 11,
                fontWeight: FontWeight.w500,
                height: 1.1,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (isOnline != null) ...<Widget>[
            const SizedBox(width: 4),
            Container(
              width: 5,
              height: 5,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: isOnline!
                    ? (isDark ? AppColors.successDark : AppColors.success)
                    : (isDark ? Colors.white24 : Colors.black26),
              ),
            ),
          ],
        ],
      ),
    );

    if (onTap != null) {
      return InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppShapesV2.xs),
        child: content,
      );
    }
    return content;
  }

  static IconData _platformIcon(String? platform) {
    return switch (platform?.toLowerCase().trim()) {
      'windows' => Icons.laptop_windows_rounded,
      'macos' => Icons.laptop_mac_rounded,
      'linux' => Icons.terminal_rounded,
      'ios' => Icons.phone_iphone_rounded,
      'android' => Icons.phone_android_rounded,
      _ => Icons.devices_other_rounded,
    };
  }
}
