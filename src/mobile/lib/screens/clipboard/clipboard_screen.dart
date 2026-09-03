import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_localizations.dart';
import '../../models/clipboard_item.dart';
import '../../providers/clipboard_provider.dart';
import '../../providers/settings_provider.dart';
import '../../providers/ws_provider.dart';
import '../../services/app_exception.dart';
import '../../services/token_store.dart';
import '../../theme/app_theme.dart';
import '../../widgets/clipboard_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/glass_panel.dart';
import '../../widgets/common/quick_paste_dock.dart';
import '../../widgets/common/section_divider.dart';
import '../../widgets/common/skeleton_list.dart';
import '../../widgets/common/sync_pulse_indicator.dart';
import 'clipboard_search_bar.dart';
import 'item_detail_screen.dart';
import 'type_filter_chips.dart';

/// 滚动接近底部多少像素时触发加载更多。
const double _kLoadMoreThreshold = 400;

/// 首页剪贴板流 (Obsidian v2 / Ticket R2.2)。
///
/// 遵循 docs/plans/mobile-ui-redesign.md 中 5.3 规格：
/// - 顶部 SliverAppBar（大标题模式）：
///   * 折叠态：紧凑搜索栏 + 类型筛选 Chips（横滑，含 Filter 弹层入口 Chip）吸顶固定；
///   * 展开态：大标题「Clipboard」(displaySmall) + 最后同步状态/时间点（包裹 SyncPulseIndicator 脉冲圆点）。
/// - 列表流（Raycast/Paste 高密度效率流）：
///   * 置顶区：有置顶项时，顶部展示 SectionDivider(title: 'Pinned' / l10n)，条目置顶展示；
///   * 常规区：单列密集排列，使用已重写的 [ClipboardCard]（44dp 类型专属预览、TypeBadge、DeviceChip、SwipeActionRow 滑动收藏/删除等）；
///   * 点击复制全量文本（加 SnackBar / SyncPulse 反馈，含「打开」详情快捷入口）、长按/菜单操作逻辑。
/// - 底部快速粘贴 Dock：
///   * 集成使用已建好的 [QuickPasteDock]（展示最近 3-5 条最近复制条目，横滑芯片，点击直接复制）。
/// - 新内容浮动提示条：
///   * 收到 WebSocket 新内容且用户不在顶部时，使用 [GlassPanel] 毛玻璃胶囊浮条（「有 N 条新内容」，点击平滑滚回顶部）。
/// - 空状态：使用 [EmptyState] (illustration: EmptyStateIllustration.clipboard，配合桌面端同步引导文案)。
/// - 与现有 [ClipboardProvider]、[SettingsProvider]、[WsProvider] 无缝联动。
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

  /// 最后同步时间戳。
  DateTime? _lastSyncTime;

  /// 同步脉冲指示器触发器（取反触发脉冲动效）。
  bool _syncPulseTrigger = false;

  /// 用户当前是否位于列表顶部（<= 100 像素）。
  bool _isAtTop = true;

  /// 用户在非顶部时积累的未读新内容数。
  int _unreadNewCount = 0;

  /// 最近一次记录的条目数，用于对比新增条目。
  int _lastKnownItemCount = 0;

  @override
  void initState() {
    super.initState();
    _provider = context.read<ClipboardProvider>();
    _provider?.addListener(_onProviderChanged);
    _scrollController.addListener(_onScroll);
    _lastSyncTime = DateTime.now();

    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initialLoad();
    });
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    _searchController.dispose();
    _provider?.removeListener(_onProviderChanged);
    super.dispose();
  }

  void _onProviderChanged() {
    if (!mounted) {
      return;
    }
    final provider = _provider;
    if (provider == null) {
      return;
    }
    final currentCount = provider.items.length;
    if (_lastKnownItemCount > 0 && currentCount > _lastKnownItemCount) {
      final diff = currentCount - _lastKnownItemCount;
      if (!_isAtTop) {
        setState(() {
          _unreadNewCount += diff;
        });
      }
    }
    _lastKnownItemCount = currentCount;
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
    _lastKnownItemCount = provider.items.length;
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
    if (mounted) {
      setState(() {
        _lastSyncTime = DateTime.now();
        _syncPulseTrigger = !_syncPulseTrigger;
        _unreadNewCount = 0;
        _lastKnownItemCount = provider.items.length;
      });
    }
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
    if (mounted) {
      _lastKnownItemCount = provider.items.length;
    }
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

  /// 点击复制条目全量文本（Raycast/Paste 效率流模式）：
  /// 解析全文并写入系统剪贴板，触发轻微震动、SyncPulse 动效与 SnackBar 反馈。
  Future<void> _copyItem(ClipboardItem item) async {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);

    try {
      final token = await TokenStore.getAccessToken();
      final text = await provider.resolveCopyText(token, item.id);
      if (text.isEmpty) {
        messenger
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(l10n.noCopyableContent)));
        return;
      }
      await Clipboard.setData(ClipboardData(text: text));
      await HapticFeedback.lightImpact();
      if (mounted) {
        setState(() {
          _syncPulseTrigger = !_syncPulseTrigger;
          _lastSyncTime = DateTime.now();
        });
      }
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(l10n.copied),
            duration: const Duration(seconds: 3),
            action: SnackBarAction(
              label: l10n.open,
              onPressed: () => _openDetail(item),
            ),
          ),
        );
    } on Exception catch (_) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l10n.copyFailed)));
    }
  }

  /// 点击条目「打开」/ SnackBar 快捷操作 → 详情预览页。
  void _openDetail(ClipboardItem item) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (BuildContext routeContext) => ItemDetailScreen(item: item),
        ),
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
  // 滚动监听：无限分页与顶部状态
  // ---------------------------------------------------------------------------

  void _onScroll() {
    if (!_scrollController.hasClients) {
      return;
    }
    final position = _scrollController.position;
    final atTop = position.pixels <= 100;
    if (atTop != _isAtTop) {
      setState(() {
        _isAtTop = atTop;
        if (atTop) {
          _unreadNewCount = 0;
        }
      });
    }
    if (position.pixels >= position.maxScrollExtent - _kLoadMoreThreshold) {
      unawaited(_loadMore());
    }
  }

  /// 点击浮条：清零 pending 计数 + 按当前筛选重拉第 1 页 + 回到顶部。
  void _revealNewContent() {
    final provider = _provider;
    if (provider == null) {
      return;
    }
    provider.clearPendingNewCount();
    setState(() {
      _unreadNewCount = 0;
      _lastSyncTime = DateTime.now();
      _syncPulseTrigger = !_syncPulseTrigger;
    });
    unawaited(provider.refresh());
    _scrollToTop(animated: true);
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    // 联动 SettingsProvider 与 WsProvider
    context.watch<SettingsProvider>();
    final wsProvider = context.watch<WsProvider>();

    return Consumer<ClipboardProvider>(
      builder: (BuildContext context, ClipboardProvider provider, Widget? child) {
        final int totalNewCount = provider.pendingNewCount + (_isAtTop ? 0 : _unreadNewCount);

        return Stack(
          children: <Widget>[
            RefreshIndicator(
              onRefresh: _onRefresh,
              child: CustomScrollView(
                controller: _scrollController,
                physics: const AlwaysScrollableScrollPhysics(),
                keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                slivers: <Widget>[
                  _buildSliverAppBar(context, provider, wsProvider),
                  ..._buildBodySlivers(context, provider),
                ],
              ),
            ),
            // 毛玻璃新内容浮条（F2 / 5.3）：收到 WS 新内容且不在顶部时显示
            if (totalNewCount > 0)
              Positioned(
                left: 0,
                right: 0,
                bottom: provider.items.isNotEmpty ? 68.0 : AppSpacing.lg,
                child: Center(
                  child: _buildNewContentBar(context, totalNewCount),
                ),
              ),
            // 底部常驻快速粘贴 Dock（5.3 / Gboard 模式）：展示最近 3-5 条剪贴板项
            if (provider.items.isNotEmpty)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: SafeArea(
                  top: false,
                  child: QuickPasteDock(
                    items: provider.items,
                    onPasteItem: (ClipboardItem item) => unawaited(_copyItem(item)),
                    onOpenMore: () => _scrollToTop(animated: true),
                    maxItems: 5,
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  /// 顶部 SliverAppBar（大标题模式）：
  /// - 展开态：大标题「Clipboard」(displaySmall) + 最后同步状态/时间点（含脉冲圆点）；
  /// - 折叠态：紧凑搜索栏 + 类型筛选 Chips（含 Filter 弹层入口）吸顶固定。
  Widget _buildSliverAppBar(
    BuildContext context,
    ClipboardProvider provider,
    WsProvider wsProvider,
  ) {
    final ThemeData theme = Theme.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final Color bgColor = theme.scaffoldBackgroundColor;

    return SliverAppBar(
      pinned: true,
      floating: false,
      expandedHeight: 180.0,
      toolbarHeight: 0.0,
      backgroundColor: bgColor,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      flexibleSpace: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final double topPadding = MediaQuery.of(context).padding.top;
          final double minHeight = topPadding + 96.0;
          final double maxHeight = topPadding + 180.0;
          final double delta = maxHeight - minHeight;
          final double current = constraints.maxHeight - minHeight;
          final double progress = delta > 0 ? (current / delta).clamp(0.0, 1.0) : 0.0;

          return Container(
            color: bgColor,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const SizedBox(height: AppSpacing.sm),
                    if (progress > 0.05)
                      Opacity(
                        opacity: progress,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            Text(
                              l10n.tabClipboard,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.displaySmall?.copyWith(
                                fontWeight: FontWeight.bold,
                                letterSpacing: -0.5,
                              ),
                            ),
                            const SizedBox(height: 2),
                            _buildSyncStatusRow(theme, l10n, wsProvider.isConnected),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
      bottom: PreferredSize(
        preferredSize: const Size.fromHeight(96.0),
        child: Container(
          color: bgColor,
          padding: const EdgeInsets.only(bottom: AppSpacing.sm),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                child: ClipboardSearchBar(
                  controller: _searchController,
                  onQueryChanged: _commitSearchQuery,
                ),
              ),
              const SizedBox(height: AppSpacing.xs),
              TypeFilterChips(
                selected: provider.contentTypeFilter,
                onSelected: _onFilterSelected,
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 展开态副标题：最后同步状态与相对时间点，配合 [SyncPulseIndicator] 脉冲圆点。
  Widget _buildSyncStatusRow(ThemeData theme, AppLocalizations l10n, bool isConnected) {
    final String statusText;
    if (!isConnected) {
      statusText = l10n.deviceOffline;
    } else if (_lastSyncTime != null) {
      statusText = '${l10n.deviceOnline} · ${_formatRelativeTime(l10n, _lastSyncTime!)}';
    } else {
      statusText = l10n.deviceOnline;
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        SyncPulseIndicator(
          trigger: _syncPulseTrigger,
          size: 8.0,
        ),
        const SizedBox(width: AppSpacing.xs),
        Text(
          statusText,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }

  /// 相对时间格式化。
  String _formatRelativeTime(AppLocalizations l10n, DateTime time) {
    final Duration diff = DateTime.now().difference(time);
    if (diff.inMinutes < 1) {
      return l10n.relJustNow;
    }
    if (diff.inMinutes < 60) {
      return l10n.relMinutesAgo(diff.inMinutes);
    }
    if (diff.inHours < 24) {
      return l10n.relHoursAgo(diff.inHours);
    }
    if (diff.inDays < 7) {
      return l10n.relDaysAgo(diff.inDays);
    }
    return l10n.relDateMD(time.month, time.day);
  }

  /// 内容区域 Sliver 列表分发：三态与置顶/常规分组流。
  List<Widget> _buildBodySlivers(BuildContext context, ClipboardProvider provider) {
    final AppLocalizations l10n = AppLocalizations.of(context);

    if (provider.isLoading && provider.items.isEmpty) {
      return const <Widget>[
        SliverFillRemaining(
          hasScrollBody: false,
          child: SkeletonList(itemCount: 8),
        ),
      ];
    }
    if (provider.error != null && provider.items.isEmpty) {
      final message = friendlyError(provider.error, l10n);
      return <Widget>[
        SliverFillRemaining(
          hasScrollBody: false,
          child: ErrorState(message: message, onRetry: () => unawaited(_onRefresh())),
        ),
      ];
    }
    if (provider.items.isEmpty) {
      return <Widget>[
        SliverFillRemaining(
          hasScrollBody: false,
          child: _buildEmptyState(provider),
        ),
      ];
    }

    // 区分置顶条目与常规条目
    final pinnedItems = provider.items.where((ClipboardItem item) => item.isPinned).toList();
    final normalItems = provider.items.where((ClipboardItem item) => !item.isPinned).toList();

    return <Widget>[
      // 置顶分组区（5.3 规范：置顶条目独立分组在顶部）
      if (pinnedItems.isNotEmpty) ...<Widget>[
        SliverToBoxAdapter(
          child: SectionDivider(
            title: l10n.pinnedSection,
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.lg,
              AppSpacing.sm,
              AppSpacing.lg,
              AppSpacing.xs,
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          sliver: SliverList(
            delegate: SliverChildBuilderDelegate(
              (BuildContext context, int index) {
                final item = pinnedItems[index];
                return Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: ClipboardCard(
                    key: ValueKey<String>(item.id),
                    item: item,
                    onTap: () => unawaited(_copyItem(item)),
                    onCopy: () => unawaited(_copyItem(item)),
                  ),
                );
              },
              childCount: pinnedItems.length,
            ),
          ),
        ),
      ],

      // 常规流区（Raycast/Paste 高密度效率流）
      if (normalItems.isNotEmpty) ...<Widget>[
        if (pinnedItems.isNotEmpty)
          SliverToBoxAdapter(
            child: SectionDivider(
              title: l10n.itemsSectionHeader,
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.md,
                AppSpacing.lg,
                AppSpacing.xs,
              ),
            ),
          ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          sliver: SliverList(
            delegate: SliverChildBuilderDelegate(
              (BuildContext context, int index) {
                final item = normalItems[index];
                return Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: ClipboardCard(
                    key: ValueKey<String>(item.id),
                    item: item,
                    onTap: () => unawaited(_copyItem(item)),
                    onCopy: () => unawaited(_copyItem(item)),
                  ),
                );
              },
              childCount: normalItems.length,
            ),
          ),
        ),
      ],

      // 列表尾部（底部留白 80dp 避让 QuickPasteDock）
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.only(bottom: 80.0),
          child: _buildListFooter(provider),
        ),
      ),
    ];
  }

  /// 空态：使用 [EmptyState] 配合 EmptyStateIllustration.clipboard 与桌面端引导文案。
  Widget _buildEmptyState(ClipboardProvider provider) {
    final AppLocalizations l10n = AppLocalizations.of(context);
    final hasFilters = (provider.searchQuery != null && provider.searchQuery!.isNotEmpty) ||
        provider.contentTypeFilter != null ||
        provider.activeFilterCount > 0;

    if (hasFilters) {
      return EmptyState(
        illustration: EmptyStateIllustration.search,
        title: l10n.clipboardNoResultsTitle,
        message: l10n.clipboardNoResultsMessage,
        actionLabel: l10n.clipboardClearFilters,
        onAction: _clearAllFilters,
      );
    }
    return EmptyState(
      illustration: EmptyStateIllustration.clipboard,
      title: l10n.clipboardEmptyTitle,
      message: l10n.clipboardEmptyMessage,
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

  /// 「有 N 条新内容」毛玻璃胶囊浮条（5.3 规范 / GlassPanel）。
  Widget _buildNewContentBar(BuildContext context, int count) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return GlassPanel(
      borderRadius: BorderRadius.circular(AppShapesV2.pill),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppShapesV2.pill),
        onTap: _revealNewContent,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.arrow_upward_rounded, size: 16, color: scheme.primary),
            const SizedBox(width: AppSpacing.xs),
            Text(
              AppLocalizations.of(context).clipboardNewContentBar(count),
              style: textTheme.labelMedium?.copyWith(
                color: scheme.primary,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
