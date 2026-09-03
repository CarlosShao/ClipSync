import 'package:flutter/material.dart';

import 'package:clipsync_mobile/theme/tokens_v2.dart';

/// 等宽文本组件 (Obsidian v2)。
///
/// 规范要求：
/// - 密码 / 代码 / 颜色值 / 路径专用（1Password Knox 模式）；
/// - 优先使用 'JetBrains Mono' 字体，回退到 'monospace'；
/// - 支持受保护状态的遮罩（如 ••••••••）与揭示切换。
class MonoText extends StatefulWidget {
  /// 创建等宽文本。
  const MonoText(
    this.text, {
    super.key,
    this.style,
    this.isMasked = false,
    this.maskChar = '•',
    this.maskLength,
    this.allowToggleMask = false,
    this.maxLines,
    this.overflow,
    this.textAlign,
  });

  /// 原始文本。
  final String text;

  /// 自定义文本样式。
  final TextStyle? style;

  /// 是否默认遮罩。
  final bool isMasked;

  /// 遮罩字符，默认 '•'。
  final String maskChar;

  /// 遮罩显示长度（若为 null，则与原文等长，最大 16 位）。
  final int? maskLength;

  /// 是否允许点击眼睛图标切换遮罩状态。
  final bool allowToggleMask;

  /// 最大行数。
  final int? maxLines;

  /// 溢出处理。
  final TextOverflow? overflow;

  /// 对齐方式。
  final TextAlign? textAlign;

  @override
  State<MonoText> createState() => _MonoTextState();
}

class _MonoTextState extends State<MonoText> {
  late bool _masked = widget.isMasked;

  @override
  void didUpdateWidget(MonoText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isMasked != widget.isMasked) {
      _masked = widget.isMasked;
    }
  }

  void _toggle() {
    setState(() => _masked = !_masked);
  }

  @override
  Widget build(BuildContext context) {
    final TextStyle effectiveStyle = (widget.style ?? const TextStyle()).copyWith(
      fontFamily: 'JetBrains Mono',
      fontFamilyFallback: const <String>['monospace'],
    );

    final String displayText;
    if (_masked) {
      final int len = widget.maskLength ?? widget.text.length.clamp(6, 16);
      displayText = widget.maskChar * len;
    } else {
      displayText = widget.text;
    }

    final Widget textWidget = Text(
      displayText,
      style: effectiveStyle,
      maxLines: widget.maxLines,
      overflow: widget.overflow,
      textAlign: widget.textAlign,
    );

    if (!widget.allowToggleMask) {
      return textWidget;
    }

    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color iconColor =
        isDark ? AppColorsV2.secureAccent : themeIconColor(context);

    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        Flexible(child: textWidget),
        const SizedBox(width: 4),
        GestureDetector(
          onTap: _toggle,
          behavior: HitTestBehavior.opaque,
          child: Padding(
            padding: const EdgeInsets.all(2),
            child: Icon(
              _masked ? Icons.visibility_off_outlined : Icons.visibility_outlined,
              size: 16,
              color: iconColor,
            ),
          ),
        ),
      ],
    );
  }

  Color themeIconColor(BuildContext context) {
    return Theme.of(context).colorScheme.onSurfaceVariant;
  }
}
