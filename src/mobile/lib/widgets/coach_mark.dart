import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 气泡提示控制器，管理提示序列
class CoachMarkController {
  final List<CoachMark> _marks = [];
  int _currentIndex = 0;
  OverlayEntry? _overlayEntry;
  final BuildContext context;
  final VoidCallback? onComplete;

  CoachMarkController({
    required this.context,
    this.onComplete,
  });

  /// 添加一个气泡提示
  void addMark(CoachMark mark) {
    _marks.add(mark);
  }

  /// 显示下一个提示
  void showNext() {
    if (_currentIndex < _marks.length) {
      _showMark(_marks[_currentIndex]);
      _currentIndex++;
    } else {
      hide();
      onComplete?.call();
    }
  }

  /// 显示第一个提示
  void start() {
    _currentIndex = 0;
    showNext();
  }

  /// 隐藏当前提示
  void hide() {
    _overlayEntry?.remove();
    _overlayEntry = null;
  }

  /// 释放资源
  void dispose() {
    hide();
    _marks.clear();
  }

  /// 显示指定的气泡提示
  void _showMark(CoachMark mark) {
    hide(); // 先隐藏之前的提示

    final RenderBox renderBox = mark.targetKey.currentContext?.findRenderObject() as RenderBox;
    final size = renderBox.size;
    final position = renderBox.localToGlobal(Offset.zero);

    _overlayEntry = OverlayEntry(
      builder: (context) => _CoachMarkWidget(
        mark: mark,
        targetPosition: position,
        targetSize: size,
        onNext: showNext,
        onSkip: hide,
        isLast: _currentIndex == _marks.length - 1,
      ),
    );

    Overlay.of(context).insert(_overlayEntry!);
  }

  /// 检查是否应该显示提示
  static Future<bool> shouldShowMark(String markId) async {
    final prefs = await SharedPreferences.getInstance();
    return !(prefs.getBool('coach_mark_$markId') ?? false);
  }

  /// 标记提示已显示
  static Future<void> markAsShown(String markId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('coach_mark_$markId', true);
  }
}

/// 气泡提示数据
class CoachMark {
  final String id;
  final GlobalKey targetKey;
  final String title;
  final String description;
  final Widget? child;
  final Alignment preferredAnchor;
  final Alignment preferredTargetAnchor;

  CoachMark({
    required this.id,
    required this.targetKey,
    required this.title,
    required this.description,
    this.child,
    this.preferredAnchor = Alignment.bottomCenter,
    this.preferredTargetAnchor = Alignment.topCenter,
  });
}

/// 气泡提示Widget
class _CoachMarkWidget extends StatelessWidget {
  final CoachMark mark;
  final Offset targetPosition;
  final Size targetSize;
  final VoidCallback onNext;
  final VoidCallback onSkip;
  final bool isLast;

  const _CoachMarkWidget({
    required this.mark,
    required this.targetPosition,
    required this.targetSize,
    required this.onNext,
    required this.onSkip,
    required this.isLast,
  });

  @override
  Widget build(BuildContext context) {
    // 计算提示框位置
    final overlaySize = MediaQuery.of(context).size;
    final top = targetPosition.dy + targetSize.height + 8;
    final left = targetPosition.dx;

    // 确保提示框不超出屏幕
    final maxWidth = overlaySize.width - 32;
    final adjustedLeft = left.clamp(16.0, overlaySize.width - maxWidth - 16);

    return Stack(
      children: [
        // 半透明背景遮罩
        Positioned.fill(
          child: GestureDetector(
            onTap: onSkip,
            child: Container(
              color: Colors.black.withOpacity(0.5),
            ),
          ),
        ),
        // 高亮目标区域
        Positioned(
          top: targetPosition.dy - 4,
          left: targetPosition.dx - 4,
          width: targetSize.width + 8,
          height: targetSize.height + 8,
          child: Container(
            decoration: BoxDecoration(
              border: Border.all(color: Colors.white, width: 2),
              borderRadius: BorderRadius.circular(8),
            ),
          ),
        ),
        // 提示框
        Positioned(
          top: top,
          left: adjustedLeft,
          width: maxWidth,
          child: Material(
            color: Colors.transparent,
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.2),
                    blurRadius: 10,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    mark.title,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF2D3436),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    mark.description,
                    style: const TextStyle(
                      fontSize: 14,
                      color: Color(0xFF636E72),
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      TextButton(
                        onPressed: onSkip,
                        child: const Text(
                          '跳过',
                          style: TextStyle(color: Colors.grey),
                        ),
                      ),
                      ElevatedButton(
                        onPressed: () {
                          CoachMarkController.markAsShown(mark.id);
                          onNext();
                        },
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF6C5CE7),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        child: Text(isLast ? '完成' : '下一步'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// 气泡提示包装器Widget
class CoachMarkTarget extends StatefulWidget {
  final GlobalKey key;
  final Widget child;
  final CoachMark? mark;
  final CoachMarkController? controller;

  const CoachMarkTarget({
    required this.key,
    required this.child,
    this.mark,
    this.controller,
  }) : super(key: key);

  @override
  State<CoachMarkTarget> createState() => _CoachMarkTargetState();
}

class _CoachMarkTargetState extends State<CoachMarkTarget> {
  @override
  void initState() {
    super.initState();
    if (widget.mark != null && widget.controller != null) {
      widget.controller!.addMark(widget.mark!);
    }
  }

  @override
  Widget build(BuildContext context) {
    return widget.child;
  }
}