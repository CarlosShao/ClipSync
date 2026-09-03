import 'package:flutter/material.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';

/// 错误状态 v2 (Obsidian)。
///
/// 规范要求：
/// - 重试按钮改 [FilledButton.tonal]；
/// - 支持展示错误码 [errorCode]；
/// - 文案全走 l10n，支持错误重试与回退；
/// - 保持原有参数接口向后兼容。
class ErrorState extends StatelessWidget {
  /// 创建错误状态占位。
  const ErrorState({
    required this.message,
    super.key,
    this.title,
    this.errorCode,
    this.icon = Icons.error_outline_rounded,
    this.retryLabel,
    this.onRetry,
    this.padding = const EdgeInsets.symmetric(
      vertical: AppSpacing.xxl,
      horizontal: AppSpacing.xl,
    ),
  });

  /// 错误描述文案。
  final String message;

  /// 错误标题，null 时回退 l10n 的 loadFailedTitle。
  final String? title;

  /// 可选错误码（如 ERR_NETWORK, 404 等）。
  final String? errorCode;

  /// 图标，默认 [Icons.error_outline_rounded]。
  final IconData icon;

  /// 重试按钮文案，null 时回退 l10n 的 retry。
  final String? retryLabel;

  /// 重试回调；为 null 时隐藏按钮。
  final VoidCallback? onRetry;

  /// 整体留白。
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final TextTheme textTheme = theme.textTheme;
    final AppLocalizations l10n = AppLocalizations.of(context);

    final String effectiveTitle = title ?? l10n.loadFailedTitle;
    final String effectiveRetryLabel = retryLabel ?? l10n.retry;
    final Color dangerColor = AppColorsV2.dangerFor(isDark: isDark);

    return Padding(
      padding: padding,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 76,
              height: 76,
              decoration: BoxDecoration(
                color: dangerColor.withValues(alpha: 0.12),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 36, color: dangerColor),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              effectiveTitle,
              style: textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
              textAlign: TextAlign.center,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: AppSpacing.xs),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 300),
              child: Text(
                message,
                style: textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
            ),
            if (errorCode != null && errorCode!.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.xs),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: isDark
                      ? AppColorsV2.surfaceHighDark
                      : AppColorsV2.surfaceHighLight,
                  borderRadius: BorderRadius.circular(AppShapesV2.xs),
                ),
                child: Text(
                  'Code: ',
                  style: textTheme.labelSmall?.copyWith(
                    fontFamily: 'JetBrains Mono',
                    fontFamilyFallback: const <String>['monospace'],
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
            if (onRetry != null) ...<Widget>[
              const SizedBox(height: AppSpacing.xl),
              FilledButton.tonal(
                onPressed: onRetry,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppShapesV2.sm),
                  ),
                ),
                child: Text(effectiveRetryLabel),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
