import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// 动画工具类
/// 提供通用的页面切换、列表项、按钮交互等动画效果
class AppAnimations {
  /// 页面切换动画 - 从右向左滑入
  static Route<T> slideInRoute<T>(Widget page) {
    return PageRouteBuilder<T>(
      pageBuilder: (context, animation, secondaryAnimation) => page,
      transitionsBuilder: (context, animation, secondaryAnimation, child) {
        const begin = Offset(1.0, 0.0);
        const end = Offset.zero;
        const curve = Curves.easeInOutCubic;

        var tween = Tween(begin: begin, end: end).chain(
          CurveTween(curve: curve),
        );

        return SlideTransition(
          position: animation.drive(tween),
          child: child,
        );
      },
      transitionDuration: const Duration(milliseconds: 350),
    );
  }

  /// 页面切换动画 - 从底部滑入
  static Route<T> slideUpRoute<T>(Widget page) {
    return PageRouteBuilder<T>(
      pageBuilder: (context, animation, secondaryAnimation) => page,
      transitionsBuilder: (context, animation, secondaryAnimation, child) {
        const begin = Offset(0.0, 1.0);
        const end = Offset.zero;
        const curve = Curves.easeOutCubic;

        var tween = Tween(begin: begin, end: end).chain(
          CurveTween(curve: curve),
        );

        return SlideTransition(
          position: animation.drive(tween),
          child: child,
        );
      },
      transitionDuration: const Duration(milliseconds: 300),
    );
  }

  /// 页面切换动画 - 淡入 + 缩放
  static Route<T> fadeScaleRoute<T>(Widget page) {
    return PageRouteBuilder<T>(
      pageBuilder: (context, animation, secondaryAnimation) => page,
      transitionsBuilder: (context, animation, secondaryAnimation, child) {
        const curve = Curves.easeOutCubic;

        var scaleTween = Tween(begin: 0.9, end: 1.0).chain(
          CurveTween(curve: curve),
        );

        var fadeTween = Tween(begin: 0.0, end: 1.0).chain(
          CurveTween(curve: curve),
        );

        return ScaleTransition(
          scale: animation.drive(scaleTween),
          child: FadeTransition(
            opacity: animation.drive(fadeTween),
            child: child,
          ),
        );
      },
      transitionDuration: const Duration(milliseconds: 300),
    );
  }

  /// 通用的淡入动画
  static Widget fadeIn({
    required AnimationController controller,
    required Widget child,
    Duration delay = Duration.zero,
    double beginOpacity = 0.0,
    double endOpacity = 1.0,
  }) {
    final fadeTween = Tween(begin: beginOpacity, end: endOpacity);
    final fadeAnimation = fadeTween.animate(
      CurvedAnimation(
        parent: controller,
        curve: Interval(
          delay.inMilliseconds / controller.duration!.inMilliseconds,
          1.0,
          curve: Curves.easeOut,
        ),
      ),
    );

    return FadeTransition(
      opacity: fadeAnimation,
      child: child,
    );
  }

  /// 通用的滑入动画
  static Widget slideIn({
    required AnimationController controller,
    required Widget child,
    Duration delay = Duration.zero,
    Offset beginOffset = const Offset(0.0, 0.3),
    Offset endOffset = Offset.zero,
  }) {
    final slideTween = Tween(begin: beginOffset, end: endOffset);
    final slideAnimation = slideTween.animate(
      CurvedAnimation(
        parent: controller,
        curve: Interval(
          delay.inMilliseconds / controller.duration!.inMilliseconds,
          1.0,
          curve: Curves.easeOutCubic,
        ),
      ),
    );

    final fadeTween = Tween(begin: 0.0, end: 1.0);
    final fadeAnimation = fadeTween.animate(
      CurvedAnimation(
        parent: controller,
        curve: Interval(
          delay.inMilliseconds / controller.duration!.inMilliseconds,
          1.0,
          curve: Curves.easeOut,
        ),
      ),
    );

    return SlideTransition(
      position: slideAnimation,
      child: FadeTransition(
        opacity: fadeAnimation,
        child: child,
      ),
    );
  }

  /// 列表项入场动画包装器
  static Widget animatedListItem({
    required AnimationController controller,
    required Widget child,
    required int index,
    int totalItems = 10,
  }) {
    // 计算延迟，让列表项依次入场
    final delay = Duration(milliseconds: 50 * index);
    final maxDelay = Duration(milliseconds: 300);

    return slideIn(
      controller: controller,
      child: child,
      delay: delay > maxDelay ? maxDelay : delay,
    );
  }

  /// 按钮点击涟漪效果
  static Widget rippleButton({
    required VoidCallback onTap,
    required Widget child,
    BorderRadius borderRadius = const BorderRadius.all(Radius.circular(12)),
    Color? splashColor,
    Color? highlightColor,
  }) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: borderRadius,
        splashColor: splashColor ?? AppTheme.primaryColor.withOpacity(0.2),
        highlightColor: highlightColor ?? AppTheme.primaryColor.withOpacity(0.1),
        child: child,
      ),
    );
  }

  /// 带弹性的按钮点击效果
  static Widget bounceButton({
    Key? key,
    required VoidCallback onTap,
    required Widget child,
    double scaleDown = 0.95,
  }) {
    return _BounceWidget(
      key: key,
      onTap: onTap,
      scaleDown: scaleDown,
      child: child,
    );
  }

  /// 页面切换淡入淡出包装器
  static Widget animatedSwitcher({
    required int index,
    required List<Widget> children,
    Duration duration = const Duration(milliseconds: 300),
  }) {
    return AnimatedSwitcher(
      duration: duration,
      transitionBuilder: (child, animation) {
        return FadeTransition(
          opacity: animation,
          child: SlideTransition(
            position: Tween<Offset>(
              begin: const Offset(0.1, 0.0),
              end: Offset.zero,
            ).animate(CurvedAnimation(
              parent: animation,
              curve: Curves.easeOutCubic,
            )),
            child: child,
          ),
        );
      },
      child: children[index],
    );
  }
}

/// 弹性点击效果Widget
class _BounceWidget extends StatefulWidget {
  final VoidCallback onTap;
  final double scaleDown;
  final Widget child;

  const _BounceWidget({
    Key? key,
    required this.onTap,
    required this.child,
    this.scaleDown = 0.95,
  }) : super(key: key);

  @override
  State<_BounceWidget> createState() => _BounceWidgetState();
}

class _BounceWidgetState extends State<_BounceWidget>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 150),
      vsync: this,
    );
    _scaleAnimation = Tween<double>(
      begin: 1.0,
      end: widget.scaleDown,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeInOut,
    ));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTapDown: (_) => _controller.forward(),
      onTapUp: (_) {
        _controller.reverse();
        widget.onTap();
      },
      onTapCancel: () => _controller.reverse(),
      child: AnimatedBuilder(
        animation: _scaleAnimation,
        builder: (context, child) {
          return Transform.scale(
            scale: _scaleAnimation.value,
            child: child,
          );
        },
        child: widget.child,
      ),
    );
  }
}


