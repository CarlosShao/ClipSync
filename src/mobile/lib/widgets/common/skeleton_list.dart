import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// 单个骨架占位块：圆角矩形或圆形，底色取主题容器色。
///
/// 通常不单独使用，交给 [SkeletonList] 统一驱动脉冲动效；
/// 自定义复杂骨架布局时也可直接组合 [SkeletonBox]。
class SkeletonBox extends StatelessWidget {
  /// 创建骨架占位块。
  ///
  /// [width] / [height] 控制尺寸（[height] 默认 12，近似一行文字）；
  /// [radius] 默认 [AppRadius.sm]；[circle] 为 true 时忽略 [radius]
  /// 渲染为圆形（用于头像占位）。
  const SkeletonBox({
    super.key,
    this.width,
    this.height = 12,
    this.radius = AppRadius.sm,
    this.circle = false,
  });

  /// 占位块宽度；null 时横向撑满父容器。
  final double? width;

  /// 占位块高度，默认 12。
  final double height;

  /// 圆角，默认 [AppRadius.sm]。
  final double radius;

  /// 是否渲染为圆形。
  final bool circle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh,
        shape: circle ? BoxShape.circle : BoxShape.rectangle,
        borderRadius: circle ? null : BorderRadius.circular(radius),
      ),
    );
  }
}

/// 列表加载骨架：头像 + 两行文本的占位行，整组同步呼吸脉冲。
///
/// 用于列表页加载中的占位，动效为克制的透明度呼吸（无第三方依赖）。
///
/// ```dart
/// isLoading
///     ? const SkeletonList(itemCount: 6)
///     : ListView(children: items)
/// ```
class SkeletonList extends StatefulWidget {
  /// 创建列表加载骨架。
  ///
  /// [itemCount] 为占位行数，默认 5；[padding] 为整体内边距，
  /// 默认 16（与页面边距一致）。
  const SkeletonList({super.key, this.itemCount = 5, this.padding = const EdgeInsets.all(AppSpacing.lg)});

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
    duration: const Duration(milliseconds: 1200),
  )..repeat(reverse: true);

  late final Animation<double> _opacity = Tween<double>(begin: 0.45, end: 0.9).animate(
    CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: widget.padding ?? EdgeInsets.zero,
      child: FadeTransition(
        opacity: _opacity,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: List<Widget>.generate(widget.itemCount, (int index) => _buildRow()),
        ),
      ),
    );
  }

  /// 构建单行占位：圆形头像 + 标题行 + 副文本行。
  Widget _buildRow() {
    return const Padding(
      padding: EdgeInsets.only(bottom: AppSpacing.lg),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SkeletonBox(width: 40, height: 40, circle: true),
          SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                FractionallySizedBox(
                  widthFactor: 0.7,
                  alignment: Alignment.centerLeft,
                  child: SkeletonBox(height: 14),
                ),
                SizedBox(height: AppSpacing.sm),
                FractionallySizedBox(
                  widthFactor: 0.45,
                  alignment: Alignment.centerLeft,
                  child: SkeletonBox(),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
