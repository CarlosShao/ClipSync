import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// 统一卡片容器：16 圆角、1px 描边、无阴影、按压态轻微缩放。
///
/// 列表项、信息块、面板一律使用 [AppCard] 而非直接用 Material/Card，
/// 以保证全局卡片观感一致。亮暗底色与描边自动取自当前 [ColorScheme]。
///
/// ```dart
/// AppCard(
///   onTap: () => ...,
///   child: Text("内容"),
/// )
/// ```
class AppCard extends StatefulWidget {
  /// 创建统一卡片。
  ///
  /// [child] 为卡片内容；[onTap] / [onLongPress] 为交互回调，
  /// 两者皆为 null 时无按压态；[padding] 默认 [AppSpacing.lg]；
  /// [margin] 由卡片自身管理，默认无边距；[borderRadius] 默认
  /// [AppRadius.lg]（16）；[color] / [borderColor] 用于临时覆盖主题色。
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

  /// 圆角，默认 [AppRadius.lg]。
  final BorderRadius? borderRadius;

  /// 覆盖卡片底色，默认取主题卡片色。
  final Color? color;

  /// 覆盖描边色，默认取主题 outlineVariant。
  final Color? borderColor;

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
    final theme = Theme.of(context);
    final effectiveRadius = widget.borderRadius ?? BorderRadius.circular(AppRadius.lg);
    final interactive = widget.onTap != null || widget.onLongPress != null;

    return Padding(
      padding: widget.margin ?? EdgeInsets.zero,
      child: Listener(
        onPointerDown: interactive ? (_) => _setPressed(true) : null,
        onPointerUp: (_) => _setPressed(false),
        onPointerCancel: (_) => _setPressed(false),
        child: AnimatedScale(
          scale: _pressed ? 0.98 : 1.0,
          duration: AppDurations.fast,
          curve: Curves.easeOut,
          child: Material(
            color: widget.color ??
                (theme.brightness == Brightness.light
                    ? theme.colorScheme.surfaceContainerLowest
                    : theme.colorScheme.surfaceContainerLow),
            clipBehavior: Clip.antiAlias,
            shape: RoundedRectangleBorder(
              borderRadius: effectiveRadius,
              side: BorderSide(color: widget.borderColor ?? theme.colorScheme.outlineVariant),
            ),
            child: InkWell(
              onTap: widget.onTap,
              onLongPress: widget.onLongPress,
              borderRadius: effectiveRadius,
              child: Padding(
                padding: widget.padding,
                child: widget.child,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
