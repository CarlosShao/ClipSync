import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/app_theme.dart';

/// 统一卡片容器 v2 (Obsidian)。
///
/// 遵循 M3E / Obsidian 规范：
/// - 基于 [SurfaceTier]（low / mid / high）的 tonal 背景分层（替代传统阴影）；
/// - 支持 M3E 圆角体系（默认 [AppShapesV2.md] = 16dp）；
/// - 支持可选类型色渐变顶边 [gradientLine]（1px 高亮线，Paste 模式）；
/// - 支持 [elevation] 阴影与微按压反馈（按压缩放 0.98）；
/// - 兼容存量参数（child, onTap, onLongPress, padding, margin, borderRadius, color, borderColor）。
class AppCard extends StatefulWidget {
  /// 创建统一卡片。
  const AppCard({
    required this.child,
    super.key,
    this.onTap,
    this.onLongPress,
    this.padding = const EdgeInsets.all(AppSpacing.lg),
    this.margin,
    this.borderRadius,
    this.color,
    this.borderColor,
    this.surfaceTier = SurfaceTier.low,
    this.elevation = AppElevationV2.flat,
    this.gradientLine,
  });

  /// 卡片内容。
  final Widget child;

  /// 点击回调；为 null 时无点击反馈。
  final VoidCallback? onTap;

  /// 长按回调。
  final VoidCallback? onLongPress;

  /// 内容内边距，默认 16。
  final EdgeInsetsGeometry padding;

  /// 卡片外边距，默认无边距（由父级列表控制）。
  final EdgeInsetsGeometry? margin;

  /// 圆角，默认 [AppShapesV2.brMd]（16）。
  final BorderRadius? borderRadius;

  /// 覆盖卡片底色；若为 null 则按 [surfaceTier] 取色。
  final Color? color;

  /// 覆盖描边色，默认取主题描边 [AppColorsV2.borderFor]。
  final Color? borderColor;

  /// 表面层级（默认 [SurfaceTier.low]）。
  final SurfaceTier surfaceTier;

  /// 投影高度，默认 [AppElevationV2.flat] (0)。
  final double elevation;

  /// 可选类型色渐变顶边（1px 高亮线，Paste 模式）。
  final LinearGradient? gradientLine;

  @override
  State<AppCard> createState() => _AppCardState();
}

class _AppCardState extends State<AppCard> {
  bool _pressed = false;

  void _setPressed(bool value) {
    if (_pressed != value) {
      setState(() => _pressed = value);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final BorderRadius effectiveRadius = widget.borderRadius ?? AppShapesV2.brMd;
    final bool interactive = widget.onTap != null || widget.onLongPress != null;

    final Color effectiveColor = widget.color ??
        AppColorsV2.surfaceFor(tier: widget.surfaceTier, isDark: isDark);
    final Color effectiveBorder =
        widget.borderColor ?? AppColorsV2.borderFor(isDark: isDark);

    Widget cardContent = Padding(
      padding: widget.padding,
      child: widget.child,
    );

    if (widget.gradientLine != null) {
      cardContent = Stack(
        children: <Widget>[
          cardContent,
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 1.5,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: widget.gradientLine,
              ),
            ),
          ),
        ],
      );
    }

    return Padding(
      padding: widget.margin ?? EdgeInsets.zero,
      child: Listener(
        onPointerDown: interactive ? (_) => _setPressed(true) : null,
        onPointerUp: (_) => _setPressed(false),
        onPointerCancel: (_) => _setPressed(false),
        child: AnimatedScale(
          scale: _pressed ? 0.98 : 1.0,
          duration: AppMotionV2.fast,
          curve: Curves.easeOut,
          child: Material(
            color: effectiveColor,
            elevation: widget.elevation,
            shadowColor: isDark
                ? Colors.black.withValues(alpha: 0.5)
                : Colors.black.withValues(alpha: 0.15),
            clipBehavior: Clip.antiAlias,
            shape: RoundedRectangleBorder(
              borderRadius: effectiveRadius,
              side: BorderSide(color: effectiveBorder),
            ),
            child: InkWell(
              onTap: widget.onTap,
              onLongPress: widget.onLongPress,
              borderRadius: effectiveRadius,
              child: cardContent,
            ),
          ),
        ),
      ),
    );
  }
}

