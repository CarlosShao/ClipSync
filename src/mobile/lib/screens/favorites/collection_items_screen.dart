import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/providers/clipboard_provider.dart';
import 'package:clipsync_mobile/screens/favorites/collection_dialogs.dart';
import 'package:clipsync_mobile/services/api_service.dart';
import 'package:clipsync_mobile/services/app_exception.dart';
import 'package:clipsync_mobile/services/collections_api_service.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/widgets/common/app_card.dart';
import 'package:clipsync_mobile/widgets/common/breadcrumb.dart';
import 'package:clipsync_mobile/widgets/common/device_chip.dart';
import 'package:clipsync_mobile/widgets/common/empty_state.dart';
import 'package:clipsync_mobile/widgets/common/error_state.dart';
import 'package:clipsync_mobile/widgets/common/mono_text.dart';
import 'package:clipsync_mobile/widgets/common/section_divider.dart';
import 'package:clipsync_mobile/widgets/common/skeleton_list.dart';
import 'package:clipsync_mobile/widgets/common/swipe_action_row.dart';
import 'package:clipsync_mobile/widgets/common/type_badge.dart';
import 'package:clipsync_mobile/widgets/favorites/collection_picker.dart';

/// 收藏夹组内条目页（树形层级导航二级页，两段式布局，Obsidian v2）。
///
/// 遵循 5.5 规格：
/// - 顶部引入 Obsidian v2 `Breadcrumb` 组件，展示树形路径并支持快速跳转回退；
/// - 两段式布局：
///   * 上半段：子分组区（卡片流 + 专属色彩圆标）；
///   * 下半段：组内收藏条目（单列高密度流，右滑取消收藏，左滑移出）；
/// - 保留拖拽排序（ReorderableListView）能力与条目多选移动功能。
class CollectionItemsScreen extends StatefulWidget {
  const CollectionItemsScreen({required this.collection, super.key});

  /// 入口收藏夹分组
  final CollectionGroup collection;

  @override
  State<CollectionItemsScreen> createState() => _CollectionItemsScreenState();
}

class _CollectionItemsScreenState extends State<CollectionItemsScreen> {
  final CollectionsApiService _api = CollectionsApiService();
  final ScrollController _scrollController = ScrollController();

  /// 当前所在分组（页内状态导航；初始为入口分组）
  late CollectionGroup _current = widget.collection;

  /// 全量分组（服务端按 sort_order 排序；用于推导子分组与面包屑祖先链）
  List<CollectionGroup> _allGroups = <CollectionGroup>[];

  /// 当前分组的条目列表
  List<FavoriteEntry> _items = <FavoriteEntry>[];
  bool _isLoading = false;

  /// 新建/重命名/删除分组请求进行中（FAB 防重复提交）
  bool _isMutating = false;

  /// 正在复制全文的条目 id（行尾转圈反馈；null = 无复制进行中）
  String? _copyingId;

  /// 最近一次失败的原始错误对象（UI 层经 friendlyError 映射 l10n 文案）
  Object? _error;

  /// 多选模式：AppBar 动作 / 长按菜单进入，批量移动完成后退出
  bool _multiSelect = false;

  /// 多选模式下已勾选的条目 id
  final Set<String> _selectedIds = <String>{};

  /// 批量移动进行中（防重复提交 + 按钮转圈）
  bool _moving = false;

  /// 当前列表条目是否已全部勾选（空列表视为未全选）
  bool get _isAllSelected =>
      _items.isNotEmpty && _selectedIds.length == _items.length;

  /// 是否已从入口分组下钻（决定返回行为：逐级上溯 vs 退出路由）
  bool get _drilledIn => _current.id != widget.collection.id;

  /// 当前分组的直接子分组（path 前缀匹配，见 childCollectionsOf）
  List<CollectionGroup> get _subCollections =>
      childCollectionsOf(_allGroups, _current);

  /// 面包屑链：顶层分组 → … → 当前分组（按 ltree path 前缀逐段匹配祖先）。
  List<CollectionGroup> get _breadcrumb {
    final path = _current.path;
    if (path.isEmpty) {
      return <CollectionGroup>[_current];
    }
    final segments = path.split('.');
    final crumbs = <CollectionGroup>[];
    for (var i = 1; i < segments.length; i++) {
      final prefix = segments.sublist(0, i + 1).join('.');
      for (final CollectionGroup group in _allGroups) {
        if (group.path == prefix) {
          crumbs.add(group);
          break;
        }
      }
    }
    if (crumbs.isEmpty || crumbs.last.id != _current.id) {
      crumbs.add(_current);
    }
    return crumbs;
  }

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  /// 拉取全量分组 + 当前分组条目列表。
  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final results = await Future.wait<dynamic>(<Future<dynamic>>[
        _api.listCollections(),
        _api.listCollectionItems(_current.id),
      ]);
      if (!mounted) {
        return;
      }
      setState(() {
        _allGroups = results[0] as List<CollectionGroup>;
        _items = results[1] as List<FavoriteEntry>;
        _isLoading = false;
      });
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      setState(() {
        _isLoading = false;
        _error = e;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 层级导航
  // ---------------------------------------------------------------------------

  void _navigateTo(CollectionGroup target) {
    if (target.id == _current.id) {
      return;
    }
    setState(() {
      _current = target;
      _multiSelect = false;
      _selectedIds.clear();
      _copyingId = null;
      _items = <FavoriteEntry>[];
      _error = null;
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(0);
      }
    });
    unawaited(_load());
  }

  void _goUp() {
    final crumbs = _breadcrumb;
    if (crumbs.length >= 2) {
      _navigateTo(crumbs[crumbs.length - 2]);
    }
  }

  // ---------------------------------------------------------------------------
  // 分组管理（新建子分组 / 重命名 / 删除）
  // ---------------------------------------------------------------------------

  Future<void> _showCreateDialog() async {
    final l10n = AppLocalizations.of(context);
    final name = await showCreateCollectionSheet(
      context,
      parentName: _current.name,
    );
    final trimmed = name?.trim() ?? '';
    if (trimmed.isEmpty || !mounted) {
      return;
    }
    setState(() => _isMutating = true);
    try {
      final group = await _api.createCollection(trimmed, parentId: _current.id);
      if (!mounted) {
        return;
      }
      unawaited(_load());
      _showSnackBar(l10n.collectionCreated(group.name));
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      _showSnackBar(friendlyError(e, l10n));
    } finally {
      if (mounted) {
        setState(() => _isMutating = false);
      }
    }
  }

  Future<void> _showRenameDialog(CollectionGroup sub) async {
    final (String name, String? icon) =
        await showDialog<(String, String?)>(
          context: context,
          builder: (BuildContext dialogContext) => RenameCollectionDialog(
            initialName: sub.name,
            initialIcon: sub.icon,
          ),
        ) ??
        ('', null);

    if (name.isEmpty || (name == sub.name && icon == null) || !mounted) {
      return;
    }

    final l10n = AppLocalizations.of(context);
    setState(() => _isMutating = true);
    try {
      await _api.updateCollection(sub.id, name: name, icon: icon);
      if (!mounted) {
        return;
      }
      unawaited(_load());
      _showSnackBar(l10n.collectionRenamed);
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      _showSnackBar(friendlyError(e, l10n));
    } finally {
      if (mounted) {
        setState(() => _isMutating = false);
      }
    }
  }

  Future<void> _confirmDelete(CollectionGroup sub) async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await confirmDeleteCollection(context, sub);
    if (!confirmed || !mounted) {
      return;
    }

    setState(() => _isMutating = true);
    try {
      await _api.deleteCollection(sub.id);
      if (!mounted) {
        return;
      }
      unawaited(_load());
      _showSnackBar(l10n.collectionDeleted(sub.name));
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      _showSnackBar(friendlyError(e, l10n));
    } finally {
      if (mounted) {
        setState(() => _isMutating = false);
      }
    }
  }

  void _showSnackBar(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  // ---------------------------------------------------------------------------
  // 复制全文
  // ---------------------------------------------------------------------------

  Future<void> _copyEntry(FavoriteEntry entry) async {
    if (_copyingId != null) {
      return;
    }
    final provider = context.read<ClipboardProvider>();
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    final inProviderCache = provider.items.any((item) => item.id == entry.id);

    setState(() => _copyingId = entry.id);
    try {
      final text = await _resolveCopyText(entry, provider, inProviderCache);
      if (text.isEmpty) {
        messenger
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(l10n.noCopyableContent)));
        return;
      }
      await Clipboard.setData(ClipboardData(text: text));
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l10n.copied)));
    } on Exception catch (_) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l10n.copyFailed)));
    } finally {
      if (mounted) {
        setState(() => _copyingId = null);
      }
    }
  }

  Future<String> _resolveCopyText(
    FavoriteEntry entry,
    ClipboardProvider provider,
    bool inProviderCache,
  ) async {
    if (inProviderCache) {
      return provider.resolveCopyText(null, entry.id);
    }
    if (entry.isTextLike && entry.mayBeTruncated) {
      try {
        final full = await ApiService().getItemContent(null, entry.id);
        if (full != null && full.isNotEmpty) {
          return full;
        }
      } on Exception catch (_) {
        // 退化为预览文本
      }
    }
    return entry.contentPreview;
  }

  // ---------------------------------------------------------------------------
  // 分组条目管理（移出/取消收藏/加入其他分组）
  // ---------------------------------------------------------------------------

  Future<void> _showEntryActions(FavoriteEntry entry) async {
    final l10n = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;
    final action = await showModalBottomSheet<String>(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppShapesV2.xl),
        ),
      ),
      builder: (BuildContext sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              ListTile(
                leading: const Icon(Icons.drive_file_move_outlined),
                title: Text(l10n.addToCollection),
                onTap: () => Navigator.of(sheetContext).pop('add'),
              ),
              ListTile(
                leading: Icon(Icons.playlist_remove, color: scheme.error),
                title: Text(
                  l10n.removeFromCollection,
                  style: TextStyle(color: scheme.error),
                ),
                onTap: () => Navigator.of(sheetContext).pop('remove'),
              ),
              ListTile(
                leading: const Icon(Icons.star_outline_rounded),
                title: Text(l10n.unfavorite),
                onTap: () => Navigator.of(sheetContext).pop('unfavorite'),
              ),
              ListTile(
                leading: const Icon(Icons.checklist),
                title: Text(l10n.multiSelect),
                onTap: () => Navigator.of(sheetContext).pop('multi'),
              ),
            ],
          ),
        ),
      ),
    );
    if (action == null || !mounted) {
      return;
    }
    if (action == 'add') {
      await _moveEntryToOtherCollection(entry);
    } else if (action == 'remove') {
      await _removeEntryFromCollection(entry);
    } else if (action == 'unfavorite') {
      await _unfavoriteEntry(entry);
    } else if (action == 'multi') {
      _enterMultiSelect(entry.id);
    }
  }

  Future<void> _moveEntryToOtherCollection(FavoriteEntry entry) async {
    final target = await addItemToCollectionFlow(
      context,
      itemId: entry.id,
      excludeCollectionId: _current.id,
    );
    if (target == null || !mounted) {
      return;
    }
    setState(() => _items.removeWhere((FavoriteEntry e) => e.id == entry.id));
  }

  Future<void> _removeEntryFromCollection(FavoriteEntry entry) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final snapshot = List<FavoriteEntry>.of(_items);
    setState(() => _items.removeWhere((FavoriteEntry e) => e.id == entry.id));
    try {
      await _api.removeItemFromCollection(_current.id, entry.id);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l10n.removedFromCollection)));
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      setState(() => _items = snapshot);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    }
  }

  Future<void> _unfavoriteEntry(FavoriteEntry entry) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final provider = context.read<ClipboardProvider>();
    final snapshot = List<FavoriteEntry>.of(_items);

    setState(() => _items.removeWhere((FavoriteEntry e) => e.id == entry.id));
    try {
      await provider.toggleFavorite(null, entry.id);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l10n.unfavorite)));
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      setState(() => _items = snapshot);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    }
  }

  // ---------------------------------------------------------------------------
  // 多选移动
  // ---------------------------------------------------------------------------

  void _enterMultiSelect([String? initialId]) {
    setState(() {
      _multiSelect = true;
      _selectedIds.clear();
      if (initialId != null) {
        _selectedIds.add(initialId);
      }
    });
  }

  void _exitMultiSelect() {
    setState(() {
      _multiSelect = false;
      _selectedIds.clear();
    });
  }

  void _toggleSelected(String entryId) {
    setState(() {
      if (_selectedIds.contains(entryId)) {
        _selectedIds.remove(entryId);
      } else {
        _selectedIds.add(entryId);
      }
    });
  }

  void _toggleSelectAll() {
    setState(() {
      if (_isAllSelected) {
        _selectedIds.clear();
      } else {
        _selectedIds.addAll(_items.map((FavoriteEntry e) => e.id));
      }
    });
  }

  Future<void> _moveSelectedToCollection() async {
    if (_selectedIds.isEmpty || _moving) {
      return;
    }
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _moving = true);
    try {
      final groups = await _api.listCollections();
      if (!mounted) {
        return;
      }
      final options = groups
          .where((CollectionGroup g) => g.id != _current.id)
          .toList();
      if (options.isEmpty) {
        messenger
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(l10n.noAvailableGroups)));
        return;
      }

      final target = await showCollectionPickerDialog(context, groups: options);
      if (target == null || !mounted) {
        return;
      }

      final pendingIds = List<String>.of(_selectedIds);
      final movedIds = <String>[];
      Object? firstError;
      for (final String id in pendingIds) {
        try {
          await _api.addItemToCollection(target.id, id);
          movedIds.add(id);
        } on Exception catch (e) {
          firstError ??= e;
        }
      }
      if (!mounted) {
        return;
      }

      final Widget feedback = firstError == null
          ? Text(l10n.moveSuccess(movedIds.length))
          : (movedIds.isEmpty
              ? Text(friendlyError(firstError, l10n))
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(l10n.moveSuccess(movedIds.length)),
                    Text(friendlyError(firstError, l10n)),
                  ],
                ));
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: feedback));

      if (movedIds.isEmpty) {
        return;
      }
      setState(() {
        _items.removeWhere((FavoriteEntry e) => movedIds.contains(e.id));
        _multiSelect = false;
        _selectedIds.clear();
        _moving = false;
      });
      await _load();
    } finally {
      if (mounted && _moving) {
        setState(() => _moving = false);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return PopScope<Object?>(
      canPop: !_drilledIn || _breadcrumb.length < 2,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (didPop) {
          return;
        }
        _goUp();
      },
      child: Scaffold(
        appBar: AppBar(
          leading: _multiSelect
              ? IconButton(
                  icon: const Icon(Icons.close),
                  tooltip: l10n.cancel,
                  onPressed: _exitMultiSelect,
                )
              : null,
          title: Text(
            _multiSelect
                ? l10n.selectedCount(_selectedIds.length)
                : _current.name,
          ),
          actions: <Widget>[
            if (_multiSelect)
              IconButton(
                icon: Icon(_isAllSelected ? Icons.deselect : Icons.select_all),
                tooltip: _isAllSelected ? l10n.deselectAll : l10n.selectAll,
                onPressed: _toggleSelectAll,
              )
            else
              IconButton(
                icon: const Icon(Icons.checklist),
                tooltip: l10n.multiSelect,
                onPressed: () => _enterMultiSelect(),
              ),
          ],
        ),
        floatingActionButton: _multiSelect
            ? null
            : FloatingActionButton.extended(
                onPressed: _isMutating ? null : _showCreateDialog,
                icon: const Icon(Icons.create_new_folder_outlined),
                label: Text(l10n.createCollection),
              ),
        body: Column(
          children: <Widget>[
            if (!_multiSelect) _buildBreadcrumbSection(l10n),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: _buildContent(),
              ),
            ),
          ],
        ),
        bottomNavigationBar: _multiSelect ? _buildSelectionBar(l10n) : null,
      ),
    );
  }

  /// 面包屑（采用 Obsidian v2 Breadcrumb 组件）：清晰展示树形路径并支持点击跳转。
  Widget _buildBreadcrumbSection(AppLocalizations l10n) {
    final crumbs = _breadcrumb;
    final items = <BreadcrumbItem>[
      BreadcrumbItem(
        id: '__all__',
        label: l10n.breadcrumbAll,
        icon: Icons.star_rounded,
      ),
      for (final group in crumbs)
        BreadcrumbItem(
          id: group.id,
          label: group.name,
          icon: group.icon.length <= 2 ? null : Icons.folder_outlined,
        ),
    ];

    return Breadcrumb(
      items: items,
      onSelect: (item) {
        if (item.id == '__all__') {
          Navigator.of(context).pop();
          return;
        }
        for (final group in crumbs) {
          if (group.id == item.id) {
            _navigateTo(group);
            break;
          }
        }
      },
    );
  }

  /// 多选底部操作栏。
  Widget _buildSelectionBar(AppLocalizations l10n) {
    return BottomAppBar(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.sm,
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: FilledButton.icon(
              onPressed:
                  (_selectedIds.isEmpty || _moving) ? null : _moveSelectedToCollection,
              icon: _moving
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.drive_file_move_outlined),
              label: Text(l10n.moveToCollection),
            ),
          ),
        ],
      ),
    );
  }

  /// 主体：三态分发。
  Widget _buildContent() {
    final l10n = AppLocalizations.of(context);
    if (_isLoading && _items.isEmpty && _subCollections.isEmpty) {
      return _scrollableBody(const SkeletonList(itemCount: 6));
    }
    if (_error != null && _items.isEmpty && _subCollections.isEmpty) {
      return _scrollableBody(
        ErrorState(
          message: friendlyError(_error, l10n),
          onRetry: () => unawaited(_load()),
        ),
      );
    }
    if (!_isLoading && _items.isEmpty && _subCollections.isEmpty) {
      return _scrollableBody(
        EmptyState(
          icon: Icons.folder_open,
          title: l10n.collectionItemsEmptyTitle,
          message: l10n.collectionItemsEmptyMessage,
        ),
      );
    }
    return _buildSections();
  }

  /// 两段式主体：
  /// - 上半段：子分组卡片区（点进下钻）；
  /// - 下半段：组内收藏条目高密度流（带右滑取消收藏、左滑移出手势）。
  Widget _buildSections() {
    final l10n = AppLocalizations.of(context);
    final subs = _subCollections;
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return CustomScrollView(
      controller: _scrollController,
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: <Widget>[
        if (subs.isNotEmpty) ...<Widget>[
          SliverToBoxAdapter(
            child: SectionDivider(title: l10n.subCollectionsHeader),
          ),
          SliverPadding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.lg,
              vertical: AppSpacing.xs,
            ),
            sliver: SliverList(
              delegate: SliverChildBuilderDelegate(
                (context, index) {
                  return Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                    child: _buildSubCollectionTile(subs[index], isDark),
                  );
                },
                childCount: subs.length,
              ),
            ),
          ),
        ],
        if (_items.isNotEmpty) ...<Widget>[
          if (subs.isNotEmpty)
            SliverToBoxAdapter(
              child: SectionDivider(title: l10n.itemsSectionHeader),
            ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.lg,
              AppSpacing.xs,
              AppSpacing.lg,
              AppSpacing.xxl,
            ),
            sliver: SliverReorderableList(
              itemCount: _items.length,
              onReorderItem: (oldIndex, newIndex) {
                setState(() {
                  final item = _items.removeAt(oldIndex);
                  _items.insert(newIndex, item);
                });
              },
              itemBuilder: (context, index) {
                final entry = _items[index];
                return ReorderableDelayedDragStartListener(
                  key: ValueKey<String>(entry.id),
                  index: index,
                  enabled: !_multiSelect,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                    child: _buildEntryTile(entry),
                  ),
                );
              },
            ),
          ),
        ],
      ],
    );
  }

  /// 子收藏夹卡片：AppCard v2 (SurfaceTier.low) + 专属色圆标 + 统计徽章 + 菜单。
  Widget _buildSubCollectionTile(CollectionGroup sub, bool isDark) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final l10n = AppLocalizations.of(context);

    final folderCount = childCollectionsOf(_allGroups, sub).length;
    final String itemsBadgeText = l10n.collectionItemCount(sub.itemCount);
    final String? folderBadgeText =
        folderCount > 0 ? l10n.collectionFolderCount(folderCount) : null;
    final Color accentColor = collectionAccentColor(sub, isDark);

    return AppCard(
      surfaceTier: SurfaceTier.low,
      borderRadius: AppShapesV2.brMd,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.md,
      ),
      onTap: () => _navigateTo(sub),
      child: Row(
        children: <Widget>[
          collectionLeadingAvatar(
            sub,
            scheme,
            size: 40,
            isDark: isDark,
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  sub.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: <Widget>[
                    _buildSubBadge(itemsBadgeText, accentColor, isDark),
                    if (folderBadgeText != null) ...<Widget>[
                      const SizedBox(width: AppSpacing.xs),
                      _buildSubBadge(
                        folderBadgeText,
                        scheme.onSurfaceVariant,
                        isDark,
                        isNeutral: true,
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          PopupMenuButton<String>(
            tooltip: l10n.moreActions,
            icon: Icon(
              Icons.more_vert_rounded,
              color: scheme.onSurfaceVariant,
              size: 20,
            ),
            shape: const RoundedRectangleBorder(
              borderRadius: BorderRadius.all(Radius.circular(AppShapesV2.md)),
            ),
            onSelected: (String value) {
              if (value == 'rename') {
                unawaited(_showRenameDialog(sub));
              } else if (value == 'delete') {
                unawaited(_confirmDelete(sub));
              }
            },
            itemBuilder: (BuildContext menuContext) => <PopupMenuItem<String>>[
              PopupMenuItem<String>(
                value: 'rename',
                child: Row(
                  children: <Widget>[
                    Icon(
                      Icons.edit_outlined,
                      size: 20,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.renameCollection),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'delete',
                child: Row(
                  children: <Widget>[
                    Icon(
                      Icons.delete_outline_rounded,
                      size: 20,
                      color: scheme.error,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.deleteCollection, style: TextStyle(color: scheme.error)),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSubBadge(
    String label,
    Color color,
    bool isDark, {
    bool isNeutral = false,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: isNeutral
            ? (isDark
                ? AppColorsV2.surfaceHighDark
                : AppColorsV2.surfaceHighLight)
            : color.withValues(alpha: isDark ? 0.18 : 0.10),
        borderRadius: BorderRadius.circular(AppShapesV2.pill),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w500,
          color: isNeutral
              ? (isDark ? Colors.white70 : Colors.black54)
              : color,
        ),
      ),
    );
  }

  /// 组内收藏条目卡片：
  /// - AppCard v2 (SurfaceTier.low)；
  /// - 右滑取消收藏（品牌紫/星标）、左滑移出分组（danger 红）；
  /// - TypeBadge + DeviceChip + 相对时间，高密度流呈现。
  Widget _buildEntryTile(FavoriteEntry entry) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final l10n = AppLocalizations.of(context);
    final isCopying = _copyingId == entry.id;
    final isSelected = _selectedIds.contains(entry.id);

    final card = AppCard(
      surfaceTier: SurfaceTier.low,
      borderRadius: AppShapesV2.brMd,
      color: _multiSelect && isSelected
          ? scheme.primary.withValues(alpha: 0.12)
          : null,
      padding: const EdgeInsets.all(AppSpacing.md),
      onTap: _multiSelect
          ? () => _toggleSelected(entry.id)
          : (isCopying ? null : () => unawaited(_copyEntry(entry))),
      onLongPress:
          _multiSelect ? null : () => unawaited(_showEntryActions(entry)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (_multiSelect) ...<Widget>[
            Checkbox(
              value: isSelected,
              onChanged: (_) => _toggleSelected(entry.id),
            ),
            const SizedBox(width: AppSpacing.xs),
          ],
          _buildLeadingBlock(entry),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: AppSpacing.xs,
                  runSpacing: 2,
                  children: <Widget>[
                    TypeBadge(contentType: entry.contentType),
                    if (entry.deviceName != null && entry.deviceName!.isNotEmpty)
                      DeviceChip(
                        deviceName: entry.deviceName!,
                        platform: entry.platform,
                      ),
                    if (entry.createdAt != null)
                      Text(
                        _formatRelativeTime(entry.createdAt!, l10n),
                        style: textTheme.labelSmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                          fontSize: 11,
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: AppSpacing.xs),
                _buildEntryPreview(entry, textTheme, scheme, l10n),
              ],
            ),
          ),
          if (!_multiSelect) ...<Widget>[
            const SizedBox(width: AppSpacing.xs),
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: isCopying
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : IconButton(
                      icon: Icon(
                        Icons.more_vert_rounded,
                        size: 18,
                        color: scheme.onSurfaceVariant,
                      ),
                      onPressed: () => unawaited(_showEntryActions(entry)),
                    ),
            ),
          ],
        ],
      ),
    );

    if (_multiSelect) {
      return card;
    }

    // 单列高密度流：右滑取消收藏，左滑移出当前分组
    return SwipeActionRow(
      rightIcon: Icons.star_border_rounded,
      rightColor: AppColorsV2.brandPrimaryLight,
      leftIcon: Icons.playlist_remove_rounded,
      leftColor: AppColorsV2.dangerLight,
      borderRadius: AppShapesV2.brMd,
      onSwipeRight: () => unawaited(_unfavoriteEntry(entry)),
      onSwipeLeft: () => unawaited(_removeEntryFromCollection(entry)),
      child: card,
    );
  }

  Widget _buildLeadingBlock(FavoriteEntry entry) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final color = AppColorsV2.getColorForType(entry.contentType, isDark);

    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: color.withValues(alpha: isDark ? 0.20 : 0.12),
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
      ),
      child: Icon(
        _typeIcon(entry.contentType),
        size: 20,
        color: color,
      ),
    );
  }

  Widget _buildEntryPreview(
    FavoriteEntry entry,
    TextTheme textTheme,
    ColorScheme scheme,
    AppLocalizations l10n,
  ) {
    final String text = entry.contentPreview.trim().isEmpty
        ? l10n.placeholderEmpty
        : entry.contentPreview;

    if (entry.contentType == 'code') {
      return MonoText(
        text,
        style: textTheme.bodyMedium?.copyWith(
          color: scheme.onSurface,
          fontSize: 13,
        ),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      );
    }

    return Text(
      text,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurface,
        height: 1.3,
      ),
    );
  }

  IconData _typeIcon(String contentType) {
    switch (contentType.toLowerCase().trim()) {
      case 'image':
        return Icons.image_outlined;
      case 'link':
        return Icons.link_rounded;
      case 'file':
        return Icons.insert_drive_file_outlined;
      case 'code':
        return Icons.code_rounded;
      case 'color':
        return Icons.palette_outlined;
      default:
        return Icons.subject_rounded;
    }
  }

  String _formatRelativeTime(DateTime time, AppLocalizations l10n) {
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
}

