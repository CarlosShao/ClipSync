import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/tokens_v2.dart';

/// 同步完成指示器：克制的品牌紫脉冲光晕动效。
///
/// 规范要求：
/// - 同步完成时品牌紫 12% 脉冲一次（[AppColorsV2.syncGlow]，300ms，一次性，克制）；
/// - 配合物理感微缩放（0.95 -> 1.05 -> 1.0）；
/// - 支持包裹任意 [child]，或独立渲染为脉冲状态圆点。
class SyncPulseIndicator extends StatefulWidget {
  /// 创建同步脉冲指示器。
  ///
  /// [trigger] 变化（变为 true 或数值递增）时触发一次脉冲动画；
  /// [child] 可选，包裹的目标子组件；若为 null 则渲染独立指示圆点；
  /// [size] 独立圆点尺寸，默认 10dp。
  const SyncPulseIndicator({
    super.key,
    this.trigger = false,
    this.child,
    this.size = 10.0,
  });

  /// 触发状态；由 false 变 true 时执行单次脉冲。
  final bool trigger;

  /// 包裹子组件；null 时显示小圆点。
  final Widget? child;

  /// 独立圆点尺寸。
  final double size;

  @override
  State<SyncPulseIndicator> createState() => _SyncPulseIndicatorState();
}

class _SyncPulseIndicatorState extends State<SyncPulseIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 300),
  );

  late final Animation<double> _scaleAnimation = TweenSequence<double>(<TweenSequenceItem<double>>[
    TweenSequenceItem<double>(
      tween: Tween<double>(begin: 1.0, end: 1.06).chain(
        CurveTween(curve: AppMotionV2.decelerateE),
      ),
      weight: 50,
    ),
    TweenSequenceItem<double>(
      tween: Tween<double>(begin: 1.06, end: 1.0).chain(
        CurveTween(curve: AppMotionV2.accelerateE),
      ),
      weight: 50,
    ),
  ]).animate(_controller);

  late final Animation<double> _glowOpacity = TweenSequence<double>(<TweenSequenceItem<double>>[
    TweenSequenceItem<double>(
      tween: Tween<double>(begin: 0.0, end: 1.0),
      weight: 40,
    ),
    TweenSequenceItem<double>(
      tween: Tween<double>(begin: 1.0, end: 0.0),
      weight: 60,
    ),
  ]).animate(_controller);

  @override
  void initState() {
    super.initState();
    if (widget.trigger) {
      _controller.forward(from: 0.0);
    }
  }

  @override
  void didUpdateWidget(SyncPulseIndicator oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!oldWidget.trigger && widget.trigger) {
      _controller.forward(from: 0.0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.child != null) {
      return AnimatedBuilder(
        animation: _controller,
        builder: (BuildContext context, Widget? child) {
          return CustomPaint(
            foregroundPainter: _GlowPainter(
              opacity: _glowOpacity.value,
            ),
            child: Transform.scale(
              scale: _scaleAnimation.value,
              child: child,
            ),
          );
        },
        child: widget.child,
      );
    }

    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color dotColor =
        isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight;

    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? _) {
        return SizedBox(
          width: widget.size * 2,
          height: widget.size * 2,
          child: Stack(
            alignment: Alignment.center,
            children: <Widget>[
              if (_glowOpacity.value > 0)
                Container(
                  width: widget.size * 2 * _scaleAnimation.value,
                  height: widget.size * 2 * _scaleAnimation.value,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AppColorsV2.syncGlow.withValues(alpha: 0.12 * _glowOpacity.value),
                  ),
                ),
              Container(
                width: widget.size,
                height: widget.size,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: dotColor,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _GlowPainter extends CustomPainter {
  const _GlowPainter({required this.opacity});

  final double opacity;

  @override
  void paint(Canvas canvas, Size size) {
    if (opacity <= 0) {
      return;
    }
    final Paint paint = Paint()
      ..color = AppColorsV2.syncGlow.withValues(alpha: 0.12 * opacity)
      ..maskFilter = const MaskFilter.blur(BlurStyle.outer, 8);

    final RRect rrect = RRect.fromRectAndRadius(
      Offset.zero & size,
      AppShapesV2.rMd,
    );
    canvas.drawRRect(rrect, paint);
  }

  @override
  bool shouldRepaint(_GlowPainter oldDelegate) => oldDelegate.opacity != opacity;
}
