import 'dart:ui';
import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/tokens_v2.dart';

/// 毛玻璃浮层容器 (Obsidian v2)。
///
/// 规范要求：
/// - BackdropFilter(filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24))；
/// - 边框带白/暗微光描边；
/// - 仅用于浮层、快捷面板（如 QuickPasteDock / 新内容浮条）。
class GlassPanel extends StatelessWidget {
  /// 创建毛玻璃容器。
  const GlassPanel({
    required this.child,
    super.key,
    this.borderRadius,
    this.padding,
    this.margin,
    this.blurSigma = 24.0,
    this.backgroundColor,
    this.borderColor,
    this.elevation = AppElevationV2.floating,
  });

  /// 面板子内容。
  final Widget child;

  /// 圆角，默认 [AppShapesV2.brLg] (20)。
  final BorderRadius? borderRadius;

  /// 内边距。
  final EdgeInsetsGeometry? padding;

  /// 外边距。
  final EdgeInsetsGeometry? margin;

  /// 模糊度，默认 24。
  final double blurSigma;

  /// 自定义覆盖底色。
  final Color? backgroundColor;

  /// 自定义覆盖描边色。
  final Color? borderColor;

  /// 投影高度，默认 [AppElevationV2.floating] (3)。
  final double elevation;

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final BorderRadius radius = borderRadius ?? AppShapesV2.brLg;

    final Color effectiveBg = backgroundColor ??
        (isDark
            ? const Color(0xE6232328) // 90% surfaceMidDark
            : const Color(0xEBFFFFFF)); // 92% white

    final Color effectiveBorder = borderColor ??
        (isDark
            ? Colors.white.withValues(alpha: 0.10)
            : Colors.black.withValues(alpha: 0.08));

    return Padding(
      padding: margin ?? EdgeInsets.zero,
      child: Material(
        color: Colors.transparent,
        elevation: elevation,
        shadowColor: isDark
            ? Colors.black.withValues(alpha: 0.5)
            : Colors.black.withValues(alpha: 0.15),
        borderRadius: radius,
        child: ClipRRect(
          borderRadius: radius,
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: blurSigma, sigmaY: blurSigma),
            child: Container(
              padding: padding,
              decoration: BoxDecoration(
                color: effectiveBg,
                borderRadius: radius,
                border: Border.all(color: effectiveBorder, width: 1.0),
              ),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}
