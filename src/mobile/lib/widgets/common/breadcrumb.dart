import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/app_theme.dart';

/// 面包屑导航项数据。
class BreadcrumbItem {
  /// 创建面包屑项。
  const BreadcrumbItem({
    required this.id,
    required this.label,
    this.icon,
    this.color,
  });

  /// 唯一标识。
  final String id;

  /// 显示文案。
  final String label;

  /// 前缀图标。
  final IconData? icon;

  /// 自定义语义色（如分组色）。
  final Color? color;
}

/// 收藏夹 / 文件夹树形路径面包屑导航 (Obsidian v2)。
///
/// 规范要求：
/// - pill 分段 ([AppShapesV2.pill])；
/// - 当前末级高亮（主文字颜色 + w600）；
/// - 支持单项点击切换路径 ([onSelect])；
/// - 横向可滚动以支持长层级。
class Breadcrumb extends StatelessWidget {
  /// 创建面包屑导航。
  const Breadcrumb({
    required this.items,
    super.key,
    this.onSelect,
    this.padding = const EdgeInsets.symmetric(
      horizontal: AppSpacing.lg,
      vertical: AppSpacing.xs,
    ),
  });

  /// 路径节点列表（自顶向下，最后一项为当前末级）。
  final List<BreadcrumbItem> items;

  /// 点击节点回调（通常点击历史祖先节点触发回退）。
  final ValueChanged<BreadcrumbItem>? onSelect;

  /// 外边距。
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return const SizedBox.shrink();
    }

    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: padding,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (int i = 0; i < items.length; i++) ...<Widget>[
            if (i > 0)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Icon(
                  Icons.chevron_right_rounded,
                  size: 16,
                  color: isDark ? Colors.white38 : Colors.black38,
                ),
              ),
            _buildSegment(theme, items[i], isLast: i == items.length - 1),
          ],
        ],
      ),
    );
  }

  Widget _buildSegment(ThemeData theme, BreadcrumbItem item, {required bool isLast}) {
    final bool isDark = theme.brightness == Brightness.dark;
    final Color textColor = isLast
        ? theme.colorScheme.onSurface
        : theme.colorScheme.onSurfaceVariant;

    final Color bgColor = isLast
        ? (isDark
            ? AppColorsV2.surfaceHighDark
            : AppColorsV2.surfaceHighLight)
        : Colors.transparent;

    return Material(
      color: bgColor,
      borderRadius: BorderRadius.circular(AppShapesV2.pill),
      child: InkWell(
        onTap: isLast ? null : () => onSelect?.call(item),
        borderRadius: BorderRadius.circular(AppShapesV2.pill),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (item.icon != null) ...<Widget>[
                Icon(
                  item.icon,
                  size: 14,
                  color: item.color ?? (isLast ? AppColorsV2.brandPrimaryLight : textColor),
                ),
                const SizedBox(width: 4),
              ],
              Text(
                item.label,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: textColor,
                  fontWeight: isLast ? FontWeight.w600 : FontWeight.w400,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
