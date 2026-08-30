import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// 错误状态：错误图标 + 标题 + 描述 + 重试按钮。
///
/// 用于请求失败、网络异常等场景；[onRetry] 为 null 时隐藏重试按钮
/// （仅展示错误信息的只读场景）。
///
/// ```dart
/// ErrorState(
///   message: "网络连接失败，请检查网络后重试",
///   onRetry: () => provider.refresh(),
/// )
/// ```
class ErrorState extends StatelessWidget {
  /// 创建错误状态占位。
  ///
  /// [message] 为必填错误描述；[title] 默认「加载失败」；
  /// [icon] 默认错误轮廓图标；[retryLabel] 默认「重试」；
  /// [onRetry] 为重试回调，为 null 时不渲染按钮。
  const ErrorState({
    required this.message,
    super.key,
    this.title = '加载失败',
    this.icon = Icons.error_outline,
    this.retryLabel = '重试',
    this.onRetry,
    this.padding = const EdgeInsets.symmetric(vertical: AppSpacing.xxl, horizontal: AppSpacing.xl),
  });

  /// 错误描述文案。
  final String message;

  /// 错误标题，默认「加载失败」。
  final String title;

  /// 图标，默认 [Icons.error_outline]。
  final IconData icon;

  /// 重试按钮文案，默认「重试」。
  final String retryLabel;

  /// 重试回调；为 null 时隐藏按钮。
  final VoidCallback? onRetry;

  /// 整体留白。
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

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
              child: Icon(icon, size: 32, color: scheme.error),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              title,
              style: textTheme.titleMedium,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              message,
              style: textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
            if (onRetry != null) ...<Widget>[
              const SizedBox(height: AppSpacing.xl),
              FilledButton(onPressed: onRetry, child: Text(retryLabel)),
            ],
          ],
        ),
      ),
    );
  }
}
