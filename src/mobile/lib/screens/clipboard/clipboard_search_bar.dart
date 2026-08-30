import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';

/// 剪贴板流顶部搜索栏（T2.3）。
///
/// 纯 UI 组件：文本变化经 [debounce]（默认 300ms）防抖后回调 [onQueryChanged]，
/// 由宿主页面负责转发给 `ClipboardProvider.setSearchQuery`（重置分页由 provider 处理）。
///
/// 文本控制器由宿主持有并传入，便于宿主在「清除筛选」等场景同步清空输入框
/// （clear 同样会走防抖回调，与手动删除文本行为一致）。
class ClipboardSearchBar extends StatefulWidget {
  /// 创建搜索栏。
  ///
  /// [controller] 为宿主持有的文本控制器；[onQueryChanged] 在防抖结束后
  /// 收到去首尾空格的关键字（空串表示无搜索）；[debounce] 默认 300ms；
  /// [hintText] 缺省时取本地化占位文案（F5）。
  const ClipboardSearchBar({
    required this.controller,
    required this.onQueryChanged,
    super.key,
    this.debounce = const Duration(milliseconds: 300),
    this.hintText,
  });

  /// 宿主持有的文本控制器（外部 clear 也会触发防抖回调）。
  final TextEditingController controller;

  /// 防抖结束后的搜索关键字回调（trim 后，空串 = 清除搜索）。
  final ValueChanged<String> onQueryChanged;

  /// 防抖时长，默认 300ms。
  final Duration debounce;

  /// 占位提示文案；null = 使用本地化默认文案。
  final String? hintText;

  @override
  State<ClipboardSearchBar> createState() => _ClipboardSearchBarState();
}

class _ClipboardSearchBarState extends State<ClipboardSearchBar> {
  Timer? _debounceTimer;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_handleControllerChanged);
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    widget.controller.removeListener(_handleControllerChanged);
    super.dispose();
  }

  /// 控制器文本变化（含外部 clear）：刷新清除按钮可见性 + 重启防抖计时。
  void _handleControllerChanged() {
    if (mounted) {
      setState(() {});
    }
    _debounceTimer?.cancel();
    _debounceTimer = Timer(widget.debounce, () {
      widget.onQueryChanged(widget.controller.text.trim());
    });
  }

  /// 点击清除按钮：清空输入框（经监听器走同一条防抖回调路径）。
  void _handleClear() {
    _debounceTimer?.cancel();
    widget.controller.clear();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final hasText = widget.controller.text.isNotEmpty;
    final hintText =
        widget.hintText ?? AppLocalizations.of(context).clipboardSearchHint;

    return TextField(
      controller: widget.controller,
      textInputAction: TextInputAction.search,
      // 提交时不等待防抖：立即上报当前关键字（内容相同则 provider 内部幂等）
      onSubmitted: (String value) {
        _debounceTimer?.cancel();
        widget.onQueryChanged(value.trim());
      },
      decoration: InputDecoration(
        hintText: hintText,
        prefixIcon: Icon(Icons.search, color: scheme.onSurfaceVariant),
        suffixIcon: hasText
            ? IconButton(
                icon: Icon(Icons.close, size: 20, color: scheme.onSurfaceVariant),
                onPressed: _handleClear,
                tooltip: AppLocalizations.of(context).clearSearch,
              )
            : null,
      ),
    );
  }
}
