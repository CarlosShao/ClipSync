import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/tokens_v2.dart';

/// 列表条目滑动手势包装 (Obsidian v2)。
///
/// 规范要求：
/// - 右滑 = 收藏（品牌紫 #5A4BD1），触发 [onSwipeRight]；
/// - 左滑 = 删除（危险红 danger），触发 [onSwipeLeft]；
/// - 内部使用物理感动画交互，滑动跟手，松手平滑回弹；
/// - 不破坏现有列表结构与点击手势。
class SwipeActionRow extends StatefulWidget {
  /// 创建滑动手势行。
  const SwipeActionRow({
    required this.child,
    super.key,
    this.onSwipeRight,
    this.onSwipeLeft,
    this.rightIcon = Icons.star_rounded,
    this.leftIcon = Icons.delete_outline_rounded,
    this.rightColor,
    this.leftColor,
    this.threshold = 72.0,
    this.borderRadius,
  });

  /// 列表卡片子组件。
  final Widget child;

  /// 右滑动作（收藏）。
  final VoidCallback? onSwipeRight;

  /// 左滑动作（删除）。
  final VoidCallback? onSwipeLeft;

  /// 右滑图标。
  final IconData rightIcon;

  /// 左滑图标。
  final IconData leftIcon;

  /// 右滑底色（默认品牌紫）。
  final Color? rightColor;

  /// 左滑底色（默认 danger 红）。
  final Color? leftColor;

  /// 触发动作所需的滑动位移阈值，默认 72dp。
  final double threshold;

  /// 圆角。
  final BorderRadius? borderRadius;

  @override
  State<SwipeActionRow> createState() => _SwipeActionRowState();
}

class _SwipeActionRowState extends State<SwipeActionRow>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotionV2.normal,
  );

  double _dragOffset = 0.0;

  void _onHorizontalDragUpdate(DragUpdateDetails details) {
    // 若对应方向未配置回调，则限制反方向滑动
    final double delta = details.primaryDelta ?? 0.0;
    final double next = _dragOffset + delta;
    if (next > 0 && widget.onSwipeRight == null) {
      return;
    }
    if (next < 0 && widget.onSwipeLeft == null) {
      return;
    }
    setState(() {
      _dragOffset = next.clamp(-140.0, 140.0);
    });
  }

  void _onHorizontalDragEnd(DragEndDetails details) {
    if (_dragOffset > widget.threshold && widget.onSwipeRight != null) {
      widget.onSwipeRight!();
    } else if (_dragOffset < -widget.threshold && widget.onSwipeLeft != null) {
      widget.onSwipeLeft!();
    }
    _resetOffset();
  }

  void _resetOffset() {
    final double current = _dragOffset;
    final Animation<double> anim = Tween<double>(begin: current, end: 0.0).animate(
      CurvedAnimation(parent: _controller, curve: AppMotionV2.decelerateE),
    );
    anim.addListener(() {
      setState(() => _dragOffset = anim.value);
    });
    _controller.forward(from: 0.0);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color rightActionColor = widget.rightColor ??
        (isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight);
    final Color leftActionColor =
        widget.leftColor ?? AppColorsV2.dangerFor(isDark: isDark);
    final BorderRadius radius = widget.borderRadius ?? AppShapesV2.brMd;

    final double progress = (_dragOffset.abs() / widget.threshold).clamp(0.0, 1.0);

    return ClipRRect(
      borderRadius: radius,
      child: Stack(
        children: <Widget>[
          Positioned.fill(
            child: Container(
              color: _dragOffset > 0 ? rightActionColor : leftActionColor,
              alignment: _dragOffset > 0 ? Alignment.centerLeft : Alignment.centerRight,
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Opacity(
                opacity: progress,
                child: Transform.scale(
                  scale: 0.8 + 0.2 * progress,
                  child: Icon(
                    _dragOffset > 0 ? widget.rightIcon : widget.leftIcon,
                    color: Colors.white,
                    size: 24,
                  ),
                ),
              ),
            ),
          ),
          GestureDetector(
            onHorizontalDragUpdate: _onHorizontalDragUpdate,
            onHorizontalDragEnd: _onHorizontalDragEnd,
            child: Transform.translate(
              offset: Offset(_dragOffset, 0),
              child: widget.child,
            ),
          ),
        ],
      ),
    );
  }
}
