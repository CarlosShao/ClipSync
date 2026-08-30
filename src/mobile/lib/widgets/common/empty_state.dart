import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// 空状态占位：图标 + 标题 + 描述 + 可选操作按钮。
///
/// 用于列表为空、无搜索结果等场景，居中展示，亮暗自适配。
///
/// ```dart
/// EmptyState(
///   title: "暂无剪贴板内容",
///   message: "在电脑上复制任意内容，它会同步到这里",
///   actionLabel: "重试",
///   onAction: _refresh,
/// )
/// ```
class EmptyState extends StatelessWidget {
  /// 创建空状态占位。
  ///
  /// [title] 必填；[message] 为可选描述文案；
  /// [icon] 默认收件箱图标；[actionLabel] + [onAction] 成对提供时
  /// 渲染操作按钮；[padding] 控制整体留白。
  const EmptyState({
    required this.title,
    super.key,
    this.message,
    this.icon = Icons.inbox_outlined,
    this.actionLabel,
    this.onAction,
    this.padding = const EdgeInsets.symmetric(vertical: AppSpacing.xxl, horizontal: AppSpacing.xl),
  });

  /// 空状态标题（如「暂无内容」）。
  final String title;

  /// 可选描述文案。
  final String? message;

  /// 图标，默认 [Icons.inbox_outlined]。
  final IconData icon;

  /// 操作按钮文案，与 [onAction] 成对出现才显示按钮。
  final String? actionLabel;

  /// 操作按钮回调。
  final VoidCallback? onAction;

  /// 整体留白。
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final hasAction = actionLabel != null && onAction != null;

    return Padding(
      padding: padding,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(color: scheme.surfaceContainerHigh, shape: BoxShape.circle),
              child: Icon(icon, size: 32, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              title,
              style: textTheme.titleMedium,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (message != null) ...<Widget>[
              const SizedBox(height: AppSpacing.xs),
              Text(
                message!,
                style: textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
            ],
            if (hasAction) ...<Widget>[
              const SizedBox(height: AppSpacing.xl),
              FilledButton.tonal(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}
