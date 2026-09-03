import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/app_theme.dart';

/// 单个骨架占位块 v2 (Obsidian)。
///
/// 圆角矩形或圆形，底色取主题容器色。
class SkeletonBox extends StatelessWidget {
  /// 创建骨架占位块。
  const SkeletonBox({
    super.key,
    this.width,
    this.height = 12.0,
    this.radius = AppShapesV2.xs,
    this.circle = false,
  });

  /// 占位块宽度；null 时横向撑满父容器。
  final double? width;

  /// 占位块高度，默认 12。
  final double height;

  /// 圆角，默认 [AppShapesV2.xs] (8)。
  final double radius;

  /// 是否渲染为圆形。
  final bool circle;

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color baseColor = isDark
        ? AppColorsV2.surfaceHighDark
        : AppColorsV2.surfaceHighLight;

    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: baseColor,
        shape: circle ? BoxShape.circle : BoxShape.rectangle,
        borderRadius: circle ? null : BorderRadius.circular(radius),
      ),
    );
  }
}

/// 列表加载骨架 v2 (Obsidian)。
///
/// 规范要求：
/// - 增加轻量 shimmer 微光渐变动效（无需第三方包，使用 LinearGradient 变换与 AnimatedBuilder 实现）；
/// - 头像/图标块 (44dp，对齐 leading 44dp) + 双行文本；
/// - 兼容原有接口 (itemCount, padding)。
class SkeletonList extends StatefulWidget {
  /// 创建列表加载骨架。
  const SkeletonList({
    super.key,
    this.itemCount = 5,
    this.padding = const EdgeInsets.all(AppSpacing.lg),
  });

  /// 占位行数。
  final int itemCount;

  /// 整体内边距。
  final EdgeInsetsGeometry? padding;

  @override
  State<SkeletonList> createState() => _SkeletonListState();
}

class _SkeletonListState extends State<SkeletonList>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1500),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color shimmerBase = isDark
        ? AppColorsV2.surfaceLowDark
        : AppColorsV2.surfaceHighLight;
    final Color shimmerHighlight = isDark
        ? AppColorsV2.surfaceHighDark
        : Colors.white.withValues(alpha: 0.85);

    return Padding(
      padding: widget.padding ?? EdgeInsets.zero,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (BuildContext context, Widget? _) {
          final double progress = _controller.value;
          final ShaderCallback shaderCallback = (Rect bounds) {
            return LinearGradient(
              begin: const Alignment(-1.0, -0.3),
              end: const Alignment(1.0, 0.3),
              stops: <double>[
                (progress - 0.3).clamp(0.0, 1.0),
                progress.clamp(0.0, 1.0),
                (progress + 0.3).clamp(0.0, 1.0),
              ],
              colors: <Color>[
                shimmerBase,
                shimmerHighlight,
                shimmerBase,
              ],
            ).createShader(bounds);
          };

          return ShaderMask(
            blendMode: BlendMode.srcATop,
            shaderCallback: shaderCallback,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: List<Widget>.generate(
                widget.itemCount,
                (int index) => _buildRow(),
              ),
            ),
          );
        },
      ),
    );
  }

  /// 构建单行占位：44dp 圆角图标 + 标题行 + 副文本行。
  Widget _buildRow() {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.lg),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const SkeletonBox(width: 44, height: 44, radius: AppShapesV2.sm),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: const <Widget>[
                FractionallySizedBox(
                  widthFactor: 0.65,
                  alignment: Alignment.centerLeft,
                  child: SkeletonBox(height: 14, radius: AppShapesV2.xs),
                ),
                SizedBox(height: AppSpacing.sm),
                FractionallySizedBox(
                  widthFactor: 0.88,
                  alignment: Alignment.centerLeft,
                  child: SkeletonBox(height: 12, radius: AppShapesV2.xs),
                ),
                SizedBox(height: AppSpacing.sm),
                FractionallySizedBox(
                  widthFactor: 0.4,
                  alignment: Alignment.centerLeft,
                  child: SkeletonBox(height: 10, radius: AppShapesV2.xs),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
