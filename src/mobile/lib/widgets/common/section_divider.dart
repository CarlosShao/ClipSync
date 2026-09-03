import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/app_theme.dart';

/// 区块分隔组件 (Obsidian v2)。
///
/// 规范要求：
/// - 左侧标签文字 + 右侧渐隐渐变横线（Notion / Linear 模式）；
/// - 支持可选右侧操作控件（如「查看全部」或图标按钮）；
/// - 优雅划分置顶区、时间区间、设置分组等。
class SectionDivider extends StatelessWidget {
  /// 创建区块分隔组件。
  const SectionDivider({
    required this.title,
    super.key,
    this.trailing,
    this.padding = const EdgeInsets.symmetric(
      horizontal: AppSpacing.lg,
      vertical: AppSpacing.sm,
    ),
  });

  /// 分组标题文字。
  final String title;

  /// 右侧附加控件。
  final Widget? trailing;

  /// 外边距，默认水平 16，垂直 8。
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final Color textColor = theme.colorScheme.onSurfaceVariant;
    final Color lineColor = AppColorsV2.borderFor(isDark: isDark);

    return Padding(
      padding: padding,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          Text(
            title,
            style: theme.textTheme.labelSmall?.copyWith(
              color: textColor,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.5,
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Container(
              height: 1.0,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: <Color>[
                    lineColor,
                    lineColor.withValues(alpha: 0.0),
                  ],
                ),
              ),
            ),
          ),
          if (trailing != null) ...<Widget>[
            const SizedBox(width: AppSpacing.sm),
            trailing!,
          ],
        ],
      ),
    );
  }
}
