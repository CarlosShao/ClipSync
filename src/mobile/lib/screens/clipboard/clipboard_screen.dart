import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_localizations.dart';
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
/// 本页仅消费 Consumer 重建，不重复接线。
///
/// 新内容浮条（F2）：与当前类型筛选不匹配的 WS 新条目不会插入列表，而是累计在
/// [ClipboardProvider.pendingNewCount]；浮条直接读该计数（>0 显示），点击后
/// [ClipboardProvider.clearPendingNewCount] + [ClipboardProvider.refresh] + 回到顶部，
/// 由服务端按当前筛选重新同步。
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

  /// initState 阶段捕获的 provider 引用，供数据动作转发使用。
  ClipboardProvider? _provider;

  @override
  void initState() {
    super.initState();
    _provider = context.read<ClipboardProvider>();
    _scrollController.addListener(_onScroll);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initialLoad();
    });
  }

  @override
  void dispose() {
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
  // 滚动监听：无限分页
  // ---------------------------------------------------------------------------

  void _onScroll() {
    if (!_scrollController.hasClients) {
      return;
    }
    final position = _scrollController.position;
    if (position.pixels >= position.maxScrollExtent - _kLoadMoreThreshold) {
      unawaited(_loadMore());
    }
  }

  /// 点击浮条（F2）：清零 pending 计数 + 按当前筛选重拉第 1 页 + 回到顶部。
  ///
  /// refresh 成功后服务端数据与当前筛选重新对齐（此前被筛选挡住的新条目
  /// 若匹配筛选会随本页返回，不匹配则随计数清零被用户主动放弃）。
  void _revealNewContent() {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    provider.clearPendingNewCount();
    unawaited(provider.refresh());
    _scrollToTop(animated: true);
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
                  // F2：浮条数据源 = 被当前筛选挡住的 WS 新条目数
                  if (provider.pendingNewCount > 0)
                    _buildNewContentBar(context, provider.pendingNewCount),
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
    final AppLocalizations l10n = AppLocalizations.of(context);
    final hasFilters =
        (provider.searchQuery != null && provider.searchQuery!.isNotEmpty) ||
        provider.contentTypeFilter != null;
    if (hasFilters) {
      return EmptyState(
        icon: Icons.search_off,
        title: l10n.clipboardNoResultsTitle,
        message: l10n.clipboardNoResultsMessage,
        actionLabel: l10n.clipboardClearFilters,
        onAction: _clearAllFilters,
      );
    }
    return EmptyState(
      icon: Icons.content_paste_off,
      title: l10n.clipboardEmptyTitle,
      message: l10n.clipboardEmptyMessage,
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
    final AppLocalizations l10n = AppLocalizations.of(context);

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
              Text(
                l10n.clipboardLoadMoreFailed,
                style: textTheme.bodySmall?.copyWith(color: scheme.error),
              ),
              TextButton(
                onPressed: () => unawaited(_loadMore(isRetry: true)),
                child: Text(l10n.retry),
              ),
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
            l10n.clipboardNoMore,
            style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ),
      );
    }
    return const SizedBox.shrink();
  }

  /// 「有 N 条新内容」轻量浮条（F2）：吸底居中的深色胶囊，点击重拉并回顶。
  Widget _buildNewContentBar(BuildContext context, int count) {
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
                    AppLocalizations.of(context).clipboardNewContentBar(count),
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
