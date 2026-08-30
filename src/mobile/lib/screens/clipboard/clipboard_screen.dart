import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/clipboard_item.dart';
import '../../providers/clipboard_provider.dart';
import '../../services/token_store.dart';
import '../../theme/app_theme.dart';
import '../../widgets/clipboard_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';
import 'clipboard_search_bar.dart';
import 'item_detail_screen.dart';
import 'type_filter_chips.dart';

/// 滚动接近底部多少像素时触发加载更多。
const double _kLoadMoreThreshold = 400;

/// 滚动超过多少像素后视为「已离开列表顶部」，新内容到达时改弹浮条提示。
const double _kNewContentScrollThreshold = 600;

/// 首页剪贴板流（T2.3）。
///
/// 页面结构：顶部搜索栏（300ms 防抖）+ 类型筛选 chips（单选）+ 列表主体。
///
/// 数据交互全部走 [ClipboardProvider]（T1.1）：
/// - 首次进入 / 下拉刷新：[ClipboardProvider.refresh]（token 由 provider 内部解析）；
/// - 搜索：防抖后 [ClipboardProvider.setSearchQuery]；
/// - 类型筛选：[ClipboardProvider.setContentTypeFilter]；
/// - 无限分页：滚动近底部时 [ClipboardProvider.loadItems]（hasMore/isLoading 由 provider 守护）；
/// - 三态：SkeletonList（加载中）/ ErrorState（失败可重试）/ EmptyState（区分
///   「无内容」与「筛选无结果」）。
///
/// 实时性：WS 新增/删除/收藏经 WsProvider → provider 的 handle* 方法更新列表，
/// 本页仅消费 Consumer 重建，不重复接线；离开列表顶部时收到新内容会显示
/// 「有 N 条新内容」轻量浮条，点击回到顶部。
///
/// 卡片渲染（T2.4）：条目统一由 [ClipboardCard] 渲染——四色类型块/缩略图、
/// 3 行预览省略、来源设备与相对时间；单击回调进详情页，长按/右上角更多
/// 菜单提供收藏 toggle、置顶（占位）与删除（带确认），数据操作走 Provider。
class ClipboardScreen extends StatefulWidget {
  const ClipboardScreen({super.key});

  @override
  State<ClipboardScreen> createState() => _ClipboardScreenState();
}

class _ClipboardScreenState extends State<ClipboardScreen> {
  final TextEditingController _searchController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  /// initState 阶段捕获的 provider 引用，dispose 时用于移除监听。
  ClipboardProvider? _provider;

  /// 「已读锚点」：最后被用户看到过的列表顶部条目 id。
  String? _anchorItemId;

  /// 锚点之上未被看到的新条目数（>0 时显示浮条）。
  int _hiddenNewCount = 0;

  @override
  void initState() {
    super.initState();
    final provider = context.read<ClipboardProvider>();
    _provider = provider;
    provider.addListener(_onProviderChanged);
    _scrollController.addListener(_onScroll);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initialLoad();
    });
  }

  @override
  void dispose() {
    _provider?.removeListener(_onProviderChanged);
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // 数据动作（全部转发 provider，token 由 provider/TokenStore 解析）
  // ---------------------------------------------------------------------------

  /// 首次进入拉取第 1 页；tab 状态保持下 initState 仅执行一次，不重复刷。
  void _initialLoad() {
    if (!mounted) {
      return;
    }
    final provider = _provider;
    if (provider == null) {
      return;
    }
    if (provider.items.isEmpty && provider.error == null && !provider.isLoading) {
      unawaited(provider.refresh());
    }
  }

  /// 下拉刷新（RefreshIndicator.onRefresh）。
  Future<void> _onRefresh() async {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    await provider.refresh();
  }

  /// 加载更多：滚动近底部触发；hasMore/isLoading 由 provider 守护；
  /// 失败后锁死，只能通过底部「重试」按钮显式重试（[isRetry] = true），
  /// 避免滚动事件在网络异常时反复打请求。
  Future<void> _loadMore({bool isRetry = false}) async {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    if (!provider.hasMore || provider.isLoading) {
      return;
    }
    if (!isRetry && provider.error != null) {
      return;
    }
    final token = await TokenStore.getAccessToken();
    if (token == null) {
      return;
    }
    await provider.loadItems(token);
  }

  /// 提交搜索关键字（搜索栏 300ms 防抖后回调；空串 = 清除搜索）。
  void _commitSearchQuery(String query) {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    _scrollToTop(animated: false);
    unawaited(provider.setSearchQuery(query.isEmpty ? null : query));
  }

  /// 类型筛选单选回调（「全部」= null）。
  void _onFilterSelected(String? contentType) {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    if (provider.contentTypeFilter == contentType) {
      return;
    }
    _scrollToTop(animated: false);
    unawaited(provider.setContentTypeFilter(contentType));
  }

  /// 清除全部搜索与筛选（空态「清除筛选」入口）。
  ///
  /// 搜索框 clear 经防抖回调 setSearchQuery(null)，与 clearFilters 幂等，
  /// 不会产生第二次重复请求。
  void _clearAllFilters() {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    _searchController.clear();
    unawaited(provider.clearFilters());
  }

  /// 点击条目 → 详情预览页（T2.5）。
  void _openDetail(ClipboardItem item) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (BuildContext routeContext) => ItemDetailScreen(item: item)),
      ),
    );
  }

  void _scrollToTop({required bool animated}) {
    if (!_scrollController.hasClients) {
      return;
    }
    if (animated) {
      unawaited(
        _scrollController.animateTo(0, duration: AppDurations.slow, curve: Curves.easeOutCubic),
      );
    } else {
      _scrollController.jumpTo(0);
    }
  }

  // ---------------------------------------------------------------------------
  // 滚动监听：无限分页 + 顶部「已读」锚点维护
  // ---------------------------------------------------------------------------

  void _onScroll() {
    if (!_scrollController.hasClients) {
      return;
    }
    final position = _scrollController.position;
    if (position.pixels >= position.maxScrollExtent - _kLoadMoreThreshold) {
      unawaited(_loadMore());
    }
    if (position.pixels <= 100) {
      _markTopVisible();
    }
  }

  /// 用户在列表顶部（未滚动走）：实时新条目直接可见，视为已读并重置浮条。
  void _markTopVisible() {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    final items = provider.items;
    if (items.isEmpty) {
      return;
    }
    _anchorItemId = items.first.id;
    if (_hiddenNewCount != 0) {
      setState(() => _hiddenNewCount = 0);
    }
  }

  /// provider 通知：维护「新内容」浮条计数。
  ///
  /// 可见性判定基于滚动位置（provider.handleNewItem 会把新条目无条件插入
  /// 列表头部，因此列表内不存在「被筛选挡住」的条目；离开顶部才算不可见）。
  void _onProviderChanged() {
    if (!mounted) {
      return;
    }
    final provider = _provider;
    if (provider == null) {
      return;
    }
    final items = provider.items;

    if (items.isEmpty) {
      _anchorItemId = null;
      if (_hiddenNewCount != 0) {
        setState(() => _hiddenNewCount = 0);
      }
      return;
    }

    final topId = items.first.id;
    final scrolledAway =
        _scrollController.hasClients &&
        _scrollController.position.pixels > _kNewContentScrollThreshold;

    if (!scrolledAway) {
      _anchorItemId = topId;
      if (_hiddenNewCount != 0) {
        setState(() => _hiddenNewCount = 0);
      }
      return;
    }

    if (_anchorItemId == null || topId == _anchorItemId) {
      _anchorItemId ??= topId;
      return;
    }

    // 锚点之前有多少条新条目 = 精确的「N 条新内容」
    final anchorId = _anchorItemId!;
    final anchorIndex = items.indexWhere((ClipboardItem item) => item.id == anchorId);
    if (anchorIndex <= 0) {
      // 锚点被刷新/清理丢失：重新锚定，不弹条
      _anchorItemId = topId;
      if (_hiddenNewCount != 0) {
        setState(() => _hiddenNewCount = 0);
      }
      return;
    }
    if (anchorIndex != _hiddenNewCount) {
      setState(() => _hiddenNewCount = anchorIndex);
    }
  }

  /// 点击浮条：回顶部并清零计数。
  void _revealNewContent() {
    _scrollToTop(animated: true);
    if (_hiddenNewCount != 0) {
      setState(() => _hiddenNewCount = 0);
    }
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Consumer<ClipboardProvider>(
      builder: (BuildContext context, ClipboardProvider provider, Widget? child) {
        return Column(
          children: <Widget>[
            _buildHeader(provider),
            Expanded(
              child: Stack(
                children: <Widget>[
                  RefreshIndicator(onRefresh: _onRefresh, child: _buildContent(provider)),
                  if (_hiddenNewCount > 0) _buildNewContentBar(context),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  /// 顶部：搜索栏 + 类型筛选 chips。
  Widget _buildHeader(ClipboardProvider provider) {
    return SafeArea(
      bottom: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.sm,
          AppSpacing.lg,
          AppSpacing.sm,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            ClipboardSearchBar(controller: _searchController, onQueryChanged: _commitSearchQuery),
            const SizedBox(height: AppSpacing.sm),
            TypeFilterChips(selected: provider.contentTypeFilter, onSelected: _onFilterSelected),
          ],
        ),
      ),
    );
  }

  /// 列表主体：三态分发。骨架/错误/空态也包在 RefreshIndicator 的可滚动
  /// 容器里，保证任何状态下都能下拉刷新。
  Widget _buildContent(ClipboardProvider provider) {
    if (provider.isLoading && provider.items.isEmpty) {
      return _scrollableBody(const SkeletonList(itemCount: 8));
    }
    if (provider.error != null && provider.items.isEmpty) {
      final message = _friendlyError(provider.error!);
      return _scrollableBody(ErrorState(message: message, onRetry: () => unawaited(_onRefresh())));
    }
    if (provider.items.isEmpty) {
      return _scrollableBody(_buildEmptyState(provider));
    }
    return _buildList(provider);
  }

  /// 空态：区分「无内容」与「筛选/搜索无结果」两种文案。
  Widget _buildEmptyState(ClipboardProvider provider) {
    final hasFilters =
        (provider.searchQuery != null && provider.searchQuery!.isNotEmpty) ||
        provider.contentTypeFilter != null;
    if (hasFilters) {
      return EmptyState(
        icon: Icons.search_off,
        title: '没有找到匹配的内容',
        message: '试试更换关键词，或清除搜索与筛选条件',
        actionLabel: '清除筛选',
        onAction: _clearAllFilters,
      );
    }
    return const EmptyState(
      icon: Icons.content_paste_off,
      title: '暂无剪贴板内容',
      message: '在电脑上复制任意内容，它会自动同步到这里',
    );
  }

  /// 全页可滚动包装：内容不满一屏时也能下拉刷新（AlwaysScrollable），
  /// 状态占位在 minHeight 约束内垂直居中。
  Widget _scrollableBody(Widget child) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        return SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: child,
          ),
        );
      },
    );
  }

  Widget _buildList(ClipboardProvider provider) {
    return ListView.builder(
      controller: _scrollController,
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.xs, AppSpacing.lg, AppSpacing.xl),
      itemCount: provider.items.length + 1,
      itemBuilder: (BuildContext context, int index) {
        if (index == provider.items.length) {
          return _buildListFooter(provider);
        }
        final item = provider.items[index];
        return Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.md),
          child: ClipboardCard(key: ValueKey<String>(item.id), item: item, onTap: () => _openDetail(item)),
        );
      },
    );
  }

  /// 列表尾部：加载圈 / 加载更多失败重试 / 「没有更多」。
  Widget _buildListFooter(ClipboardProvider provider) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    if (provider.isLoading) {
      return const Padding(
        padding: EdgeInsets.all(AppSpacing.lg),
        child: Center(
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    if (provider.error != null) {
      return Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Center(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.cloud_off, size: 16, color: scheme.error),
              const SizedBox(width: AppSpacing.xs),
              Text('加载更多失败', style: textTheme.bodySmall?.copyWith(color: scheme.error)),
              TextButton(onPressed: () => unawaited(_loadMore(isRetry: true)), child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    if (!provider.hasMore) {
      return Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Center(
          child: Text(
            '没有更多了',
            style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ),
      );
    }
    return const SizedBox.shrink();
  }

  /// 「有 N 条新内容」轻量浮条：吸底居中的深色胶囊，点击回顶部。
  Widget _buildNewContentBar(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final pillRadius = BorderRadius.circular(999);

    return Positioned(
      left: 0,
      right: 0,
      bottom: AppSpacing.lg,
      child: Center(
        child: Material(
          color: scheme.inverseSurface,
          borderRadius: pillRadius,
          child: InkWell(
            borderRadius: pillRadius,
            onTap: _revealNewContent,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(Icons.arrow_upward, size: 16, color: scheme.onInverseSurface),
                  const SizedBox(width: AppSpacing.xs),
                  Text(
                    '有 $_hiddenNewCount 条新内容，点击查看',
                    style: textTheme.labelMedium?.copyWith(color: scheme.onInverseSurface),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 错误文案友好化：去掉异常前缀（'Exception: xxx' → 'xxx'）。
  String _friendlyError(String raw) => raw.replaceFirst(RegExp(r'^Exception:\s*'), '');
}
