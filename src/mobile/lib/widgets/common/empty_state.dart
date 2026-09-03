import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/app_theme.dart';

/// 空状态插画变体类型。
enum EmptyStateIllustration {
  /// 剪贴板默认
  clipboard,

  /// 设备列表
  devices,

  /// 收藏夹
  favorites,

  /// 搜索无结果
  search,

  /// 通用收件箱
  generic,
}

/// 空状态占位 v2 (Obsidian)。
///
/// 规范要求：
/// - displaySmall 风格大图标 (36-44dp 居于 80dp 容器)；
/// - spring 物理入场动效（轻微 scale + fade）；
/// - 支持 illustration 变体（剪贴板 / 设备 / 收藏夹专属图标与语义色彩）；
/// - 保持现有参数 (title, message, icon, actionLabel, onAction, padding) 兼容。
class EmptyState extends StatefulWidget {
  /// 创建空状态占位。
  const EmptyState({
    required this.title,
    super.key,
    this.message,
    this.icon,
    this.illustration = EmptyStateIllustration.generic,
    this.actionLabel,
    this.onAction,
    this.padding = const EdgeInsets.symmetric(
      vertical: AppSpacing.xxl,
      horizontal: AppSpacing.xl,
    ),
  });

  /// 空状态标题。
  final String title;

  /// 可选描述文案。
  final String? message;

  /// 自定义覆盖图标；若未指定则由 [illustration] 决定。
  final IconData? icon;

  /// 插画语义变体。
  final EmptyStateIllustration illustration;

  /// 操作按钮文案。
  final String? actionLabel;

  /// 操作按钮回调。
  final VoidCallback? onAction;

  /// 整体留白。
  final EdgeInsetsGeometry padding;

  @override
  State<EmptyState> createState() => _EmptyStateState();
}

class _EmptyStateState extends State<EmptyState>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotionV2.slow,
  );

  late final Animation<double> _scaleAnimation = Tween<double>(
    begin: 0.88,
    end: 1.0,
  ).animate(
    CurvedAnimation(
      parent: _controller,
      curve: AppMotionV2.decelerateE,
    ),
  );

  late final Animation<double> _fadeAnimation = Tween<double>(
    begin: 0.0,
    end: 1.0,
  ).animate(
    CurvedAnimation(
      parent: _controller,
      curve: AppMotionV2.decelerateE,
    ),
  );

  @override
  void initState() {
    super.initState();
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final ColorScheme scheme = theme.colorScheme;
    final TextTheme textTheme = theme.textTheme;
    final bool hasAction = widget.actionLabel != null && widget.onAction != null;

    final (IconData effectiveIcon, Color accentColor) = _resolveVisuals(isDark);

    return Padding(
      padding: widget.padding,
      child: Center(
        child: FadeTransition(
          opacity: _fadeAnimation,
          child: ScaleTransition(
            scale: _scaleAnimation,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Container(
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(
                    color: accentColor.withValues(alpha: 0.12),
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: Icon(
                    widget.icon ?? effectiveIcon,
                    size: 38,
                    color: accentColor,
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                Text(
                  widget.title,
                  style: textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if (widget.message != null) ...<Widget>[
                  const SizedBox(height: AppSpacing.xs),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 300),
                    child: Text(
                      widget.message!,
                      style: textTheme.bodyMedium?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ],
                if (hasAction) ...<Widget>[
                  const SizedBox(height: AppSpacing.xl),
                  FilledButton.tonal(
                    onPressed: widget.onAction,
                    child: Text(widget.actionLabel!),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  (IconData, Color) _resolveVisuals(bool isDark) {
    return switch (widget.illustration) {
      EmptyStateIllustration.clipboard => (
          Icons.content_paste_rounded,
          isDark ? AppColorsV2.typeTextDark : AppColorsV2.typeTextLight,
        ),
      EmptyStateIllustration.devices => (
          Icons.devices_rounded,
          isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight,
        ),
      EmptyStateIllustration.favorites => (
          Icons.star_rounded,
          isDark ? AppColorsV2.typeImageDark : AppColorsV2.typeImageLight,
        ),
      EmptyStateIllustration.search => (
          Icons.search_off_rounded,
          isDark ? AppColorsV2.typeCodeDark : AppColorsV2.typeCodeLight,
        ),
      EmptyStateIllustration.generic => (
          Icons.inbox_rounded,
          isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight,
        ),
    };
  }
}
