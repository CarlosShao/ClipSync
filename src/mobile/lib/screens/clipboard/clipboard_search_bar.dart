import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_localizations.dart';
import '../../providers/clipboard_provider.dart';
import '../../services/search_history_api_service.dart' show SearchHistoryItem;
import '../../theme/app_theme.dart';

/// 剪贴板流顶部搜索栏（T2.3 / C2 搜索历史）。
///
/// 纯 UI 组件：文本变化经 [debounce]（默认 300ms）防抖后回调 [onQueryChanged]，
/// 由宿主页面负责转发给 `ClipboardProvider.setSearchQuery`（重置分页由 provider 处理）。
///
/// 文本控制器由宿主持有并传入，便于宿主在「清除筛选」等场景同步清空输入框
/// （clear 同样会走防抖回调，与手动删除文本行为一致）。
///
/// C2 搜索历史浮层：聚焦且输入框为空时展示最近 10 条历史（数据源
/// `ClipboardProvider.searchHistory`，聚焦时经 [ClipboardProvider.loadSearchHistory]
/// 刷新）；点击条目回填输入框并按既有防抖路径执行搜索；底部「清空」经
/// [ClipboardProvider.clearSearchHistory] 清空并提示 searchHistoryCleared；
/// 失焦 / 点击浮层外部 / 输入非空文本时收起。交互对齐桌面端
/// SearchHistoryDropdown.vue（只读参照）。
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
  final FocusNode _focusNode = FocusNode();
  final LayerLink _layerLink = LayerLink();
  OverlayEntry? _historyOverlay;

  /// 历史浮层条目上的指针已按下（尚未抬起）：失焦延迟收起时跳过，
  /// 保证 tap up 能落在浮层条目上触发回填。
  bool _historyPressing = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_handleControllerChanged);
    _focusNode.addListener(_handleFocusChanged);
  }

  @override
  void dispose() {
    _removeHistoryOverlay();
    _debounceTimer?.cancel();
    _focusNode.removeListener(_handleFocusChanged);
    _focusNode.dispose();
    widget.controller.removeListener(_handleControllerChanged);
    super.dispose();
  }

  /// 控制器文本变化（含外部 clear）：刷新清除按钮可见性 + 重启防抖计时。
  ///
  /// C2：有文本时收起历史浮层；清空回空且仍聚焦时重新展示。
  void _handleControllerChanged() {
    if (mounted) {
      setState(() {});
    }
    _debounceTimer?.cancel();
    _debounceTimer = Timer(widget.debounce, () {
      widget.onQueryChanged(widget.controller.text.trim());
    });
    if (widget.controller.text.isNotEmpty) {
      _removeHistoryOverlay();
    } else if (_focusNode.hasFocus) {
      _showHistoryOverlay();
    }
  }

  /// 点击清除按钮：清空输入框（经监听器走同一条防抖回调路径）。
  void _handleClear() {
    _debounceTimer?.cancel();
    widget.controller.clear();
  }

  // ---------------------------------------------------------------------------
  // C2 搜索历史浮层
  // ---------------------------------------------------------------------------

  void _handleFocusChanged() {
    if (!mounted) {
      return;
    }
    if (_focusNode.hasFocus) {
      if (widget.controller.text.isEmpty) {
        _showHistoryOverlay();
      }
    } else {
      // 失焦延迟收起：点选历史条目时 Flutter 会先（pointer down）触发
      // TextField 的 onTapOutside 失焦，若立即移除浮层，pointer up 落空
      // 导致回填丢失；延迟一拍并按 [_historyPressing] 跳过。
      Future<void>.delayed(const Duration(milliseconds: 200), () {
        if (!mounted || _historyPressing) {
          return;
        }
        _removeHistoryOverlay();
      });
    }
  }

  void _showHistoryOverlay() {
    _removeHistoryOverlay();
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    // 每次展示都刷新（静默失败沿用旧镜像）
    unawaited(provider.loadSearchHistory());

    double barWidth = 320;
    final RenderObject? renderObject = context.findRenderObject();
    if (renderObject is RenderBox && renderObject.hasSize) {
      barWidth = renderObject.size.width;
    }

    _historyOverlay = OverlayEntry(
      builder: (BuildContext overlayContext) {
        return Stack(
          children: <Widget>[
            // 遮罩：点击浮层外部任意区域收起
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: _dismissHistoryOverlay,
              ),
            ),
            CompositedTransformFollower(
              link: _layerLink,
              targetAnchor: Alignment.bottomLeft,
              followerAnchor: Alignment.topLeft,
              offset: const Offset(0, AppSpacing.xs),
              showWhenUnlinked: false,
              child: AnimatedBuilder(
                animation: provider,
                builder: (BuildContext context, Widget? _) =>
                    _buildHistoryPanel(context, provider, barWidth),
              ),
            ),
          ],
        );
      },
    );
    Overlay.of(context, rootOverlay: true).insert(_historyOverlay!);
  }

  void _removeHistoryOverlay() {
    _historyOverlay?.remove();
    _historyOverlay = null;
  }

  /// 点击遮罩 / 清空按钮后的收起（立即移除 + 失焦）。
  void _dismissHistoryOverlay() {
    _removeHistoryOverlay();
    _historyPressing = false;
    _focusNode.unfocus();
  }

  /// 历史浮层面板：标题 + 最近 10 条 + 底部「清空」（样式对齐搜索栏圆角/描边）。
  Widget _buildHistoryPanel(BuildContext context, ClipboardProvider provider, double barWidth) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final TextTheme textTheme = Theme.of(context).textTheme;
    final AppLocalizations l10n = AppLocalizations.of(context);
    final List<SearchHistoryItem> items = provider.searchHistory
        .take(ClipboardProvider.kSearchHistoryLimit)
        .toList();

    return Material(
      color: scheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.md),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          minWidth: barWidth,
          maxWidth: barWidth,
          maxHeight: 320,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, AppSpacing.xs,
              ),
              child: Text(
                l10n.searchHistoryTitle,
                style: textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
            // 空历史只显示标题行（arb 冻结，无「暂无历史」文案 key）
            if (items.isNotEmpty)
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  padding: EdgeInsets.zero,
                  itemCount: items.length,
                  itemBuilder: (BuildContext context, int index) {
                    final keyword = items[index].keyword;
                    return Listener(
                      onPointerDown: (_) => _historyPressing = true,
                      child: ListTile(
                        dense: true,
                        visualDensity: VisualDensity.compact,
                        leading: Icon(Icons.history, size: 18, color: scheme.onSurfaceVariant),
                        title: Text(
                          keyword,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: textTheme.bodyMedium,
                        ),
                        onTap: () => _pickHistoryKeyword(keyword),
                      ),
                    );
                  },
                ),
              ),
            if (items.isNotEmpty)
              Listener(
                onPointerDown: (_) => _historyPressing = true,
                child: InkWell(
                  onTap: () => unawaited(_handleClearHistory(provider)),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.lg, vertical: AppSpacing.sm,
                    ),
                    decoration: BoxDecoration(
                      border: Border(top: BorderSide(color: scheme.outlineVariant)),
                    ),
                    child: Row(
                      children: <Widget>[
                        Icon(Icons.delete_outline, size: 16, color: scheme.error),
                        const SizedBox(width: AppSpacing.sm),
                        Text(
                          l10n.clearSearchHistory,
                          style: textTheme.labelMedium?.copyWith(color: scheme.error),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 点击历史条目：回填输入框（经控制器监听器走既有防抖路径执行搜索）并收起。
  void _pickHistoryKeyword(String keyword) {
    _removeHistoryOverlay();
    _historyPressing = false;
    _debounceTimer?.cancel();
    widget.controller.text = keyword;
    widget.controller.selection = TextSelection.collapsed(offset: keyword.length);
    _focusNode.unfocus();
  }

  /// 清空搜索历史：成功后提示 searchHistoryCleared 并收起浮层；失败静默关闭。
  Future<void> _handleClearHistory(ClipboardProvider provider) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final bool ok = await provider.clearSearchHistory();
    if (!mounted) {
      return;
    }
    _dismissHistoryOverlay();
    if (ok) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.searchHistoryCleared)),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final hasText = widget.controller.text.isNotEmpty;
    final hintText =
        widget.hintText ?? AppLocalizations.of(context).clipboardSearchHint;

    return CompositedTransformTarget(
      link: _layerLink,
      child: TextField(
        controller: widget.controller,
        focusNode: _focusNode,
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
      ),
    );
  }
}
