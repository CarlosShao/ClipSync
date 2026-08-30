import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// 区块标题：列表/分组内容前的标题行。
///
/// 左侧标题（可选副标题），右侧可放操作入口（如「查看全部」）。
///
/// ```dart
/// SectionHeader(
///   title: "最近设备",
///   trailing: TextButton(onPressed: ..., child: Text("全部")),
/// )
/// ```
class SectionHeader extends StatelessWidget {
  /// 创建区块标题。
  ///
  /// [title] 为必填主标题；[subtitle] 为可选副标题；
  /// [trailing] 为可选右侧操作控件；[padding] 默认上 24 下 12，
  /// 与页面 16 水平边距组合后形成标准区块节奏。
  const SectionHeader({
    required this.title,
    super.key,
    this.subtitle,
    this.trailing,
    this.padding = const EdgeInsets.fromLTRB(0, AppSpacing.xl, 0, AppSpacing.md),
  });

  /// 主标题。
  final String title;

  /// 可选副标题。
  final String? subtitle;

  /// 可选右侧操作控件（按钮、图标等）。
  final Widget? trailing;

  /// 外边距。
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: padding,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(title, style: textTheme.titleMedium, maxLines: 1, overflow: TextOverflow.ellipsis),
                if (subtitle != null) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    subtitle!,
                    style: textTheme.bodySmall,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
          if (trailing != null) ...<Widget>[const SizedBox(width: AppSpacing.sm), trailing!],
        ],
      ),
    );
  }
}
