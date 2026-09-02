import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../services/app_exception.dart';
import '../../services/collections_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';
import 'collection_dialogs.dart';
import 'collection_items_screen.dart';

/// 收藏夹页（T4.1 / C1 管理补齐；树形层级导航根页）。
///
/// 页面结构：**当前层级**的收藏夹分组列表 + 右下角「新建分组」FAB。
/// 根页只显示顶层分组（path 为 ltree 两段 `root.<id>`，按 `.col_` 分段判定，
/// 见 [CollectionsApiService.listCollections]）；子分组在点进分组后的
/// [CollectionItemsScreen] 中逐层下钻（资源管理器式）。
///
/// 数据交互全部走 [CollectionsApiService]（Bearer 由 TokenStore 解析）：
/// - 首次进入 / 下拉刷新：listCollections（拉全量分组，含服务端聚合的
///   item_count 与 path；本地按 path 过滤出顶层展示）；
/// - 分组卡片副标题：条目数 + 直接子分组数（「3 条内容 · 2 个子分组」）；
/// - 新建分组：对话框输入名称 → createCollection（根页 = 顶层，不传
///   parentId）→ 重拉列表（后端新分组 sort_order=0 排最前）；
/// - 删除分组：分组行 trailing 菜单 → 确认对话框（说明子分组级联删除）→
///   deleteCollection → 重拉列表；
/// - 重命名分组（C1）：trailing 菜单 → 改名对话框（可选改图标 emoji）→
///   updateCollection → 重拉列表；
/// - 拖拽排序（C1）：列表长按拖动，乐观更新顶层顺序 → reorderCollections
///   （只提交顶层分组；批量端点被后端路由遮蔽时 API 层自动退化为逐条
///   sortOrder），失败回滚；
/// - 点进分组：整行点击以根 Navigator 压入 [CollectionItemsScreen]
///   （全屏覆盖 shell 的 AppBar 与底栏，返回后回到本页）。
///
/// 三态：SkeletonList（加载中）/ ErrorState（失败可重试）/ EmptyState
/// （无分组时提供「新建分组」快捷入口）。
class FavoritesScreen extends StatefulWidget {
  const FavoritesScreen({super.key});

  @override
  State<FavoritesScreen> createState() => _FavoritesScreenState();
}

class _FavoritesScreenState extends State<FavoritesScreen> {
  final CollectionsApiService _api = CollectionsApiService();

  /// 全量分组（含子分组；展示与排序均从该列表派生）
  List<CollectionGroup> _groups = <CollectionGroup>[];
  bool _isLoading = false;

  /// 创建 / 删除请求进行中（FAB 与空态按钮防重复提交）
  bool _isMutating = false;

  /// 最近一次失败的原始错误对象（UI 层经 friendlyError 映射 l10n 文案）
  Object? _error;

  /// 当前展示的顶层分组（path 分段数 ≤ 2，即 `root.<id>`；
  /// path 异常为空时按顶层兜底展示，避免分组凭空消失）。
  List<CollectionGroup> get _visibleGroups =>
      _groups.where(isTopLevelCollection).toList();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// 拉取分组列表（下拉刷新与增删后重载共用）。
  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final groups = await _api.listCollections();
      if (!mounted) {
        return;
      }
      setState(() {
        _groups = groups;
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
  // 新建 / 删除分组
  // ---------------------------------------------------------------------------

  /// 新建分组：对话框输入名称（必填，≤100 字符与后端截断一致）。
  /// 根页 = 顶层新建，不传 parentId。
  Future<void> _showCreateDialog() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) =>
          CreateCollectionDialog(controller: controller),
    );
    controller.dispose();

    final trimmed = name?.trim() ?? '';
    if (trimmed.isEmpty || !mounted) {
      return;
    }
    await _createGroup(trimmed);
  }

  /// 调用创建接口，成功后重拉列表并提示。
  Future<void> _createGroup(String name) async {
    final l10n = AppLocalizations.of(context);
    setState(() => _isMutating = true);
    try {
      final group = await _api.createCollection(name);
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

  /// 删除分组：确认对话框（带说明）→ 删除 → 重拉列表。
  Future<void> _confirmDelete(CollectionGroup group) async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await confirmDeleteCollection(context, group);
    if (!confirmed || !mounted) {
      return;
    }

    setState(() => _isMutating = true);
    try {
      await _api.deleteCollection(group.id);
      if (!mounted) {
        return;
      }
      unawaited(_load());
      _showSnackBar(l10n.collectionDeleted(group.name));
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

  /// 重命名分组：改名对话框（预填当前名称，可选改图标 emoji）→ 更新 → 重拉列表。
  Future<void> _showRenameDialog(CollectionGroup group) async {
    final (String name, String? icon) =
        await showDialog<(String, String?)>(
          context: context,
          builder: (BuildContext dialogContext) => RenameCollectionDialog(
            initialName: group.name,
            initialIcon: group.icon,
          ),
        ) ??
        ('', null);

    // 名称未改且未改图标：无需请求
    if (name.isEmpty || (name == group.name && icon == null) || !mounted) {
      return;
    }

    final l10n = AppLocalizations.of(context);
    setState(() => _isMutating = true);
    try {
      await _api.updateCollection(group.id, name: name, icon: icon);
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

  /// 拖拽排序（C1，仅顶层分组）：乐观更新本地顺序 → reorderCollections 持久
  /// 化，失败回滚。（onReorderItem 的 newIndex 已代扣被移除项的位移）
  ///
  /// 只提交顶层分组的顺序：子分组显示在二级页，其 sort_order 不随根页拖动
  /// 变化（树形层级下扁平全量重排会把子分组顺序打乱）。
  Future<void> _onReorder(int oldIndex, int newIndex) async {
    final l10n = AppLocalizations.of(context);
    final previous = List<CollectionGroup>.of(_groups);
    final reordered = List<CollectionGroup>.of(_visibleGroups);
    // onReorderItem 的 newIndex 已代扣被移除项的位移，直接先移后插
    reordered.insert(newIndex, reordered.removeAt(oldIndex));
    setState(() {
      // 顶层按新顺序置前；子分组保持原相对顺序（不参与本次提交）
      _groups = <CollectionGroup>[
        ...reordered,
        ..._groups.where((CollectionGroup g) => !isTopLevelCollection(g)),
      ];
    });
    try {
      await _api.reorderCollections(reordered);
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      setState(() => _groups = previous);
      _showSnackBar(friendlyError(e, l10n));
    }
  }

  /// 点进分组：根 Navigator 全屏压入组内条目页（盖过 shell AppBar 与底栏）。
  void _openCollection(CollectionGroup group) {
    unawaited(
      Navigator.of(context, rootNavigator: true).push(
        MaterialPageRoute<void>(
          builder: (BuildContext routeContext) =>
              CollectionItemsScreen(collection: group),
        ),
      ),
    );
  }

  void _showSnackBar(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _isMutating ? null : _showCreateDialog,
        icon: const Icon(Icons.create_new_folder_outlined),
        label: Text(l10n.createCollection),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildContent(),
      ),
    );
  }

  /// 主体：三态分发。骨架/错误/空态也包在 RefreshIndicator 的可滚动容器里，
  /// 保证任何状态下都能下拉刷新。
  Widget _buildContent() {
    final l10n = AppLocalizations.of(context);
    if (_isLoading && _groups.isEmpty) {
      return _scrollableBody(const SkeletonList(itemCount: 6));
    }
    if (_error != null && _groups.isEmpty) {
      return _scrollableBody(
        ErrorState(
          message: friendlyError(_error, l10n),
          onRetry: () => unawaited(_load()),
        ),
      );
    }
    if (_visibleGroups.isEmpty) {
      return _scrollableBody(
        EmptyState(
          icon: Icons.star_outline,
          title: l10n.collectionsEmptyTitle,
          message: l10n.collectionsEmptyMessage,
          actionLabel: l10n.createCollection,
          onAction: _isMutating ? null : _showCreateDialog,
        ),
      );
    }
    return _buildGroupList();
  }

  /// 顶层分组列表（C1 拖拽排序）：长按条目即可拖动换位，onReorder 乐观更新 +
  /// 失败回滚；拖拽中的条目以带阴影的 Material 提升（对齐 cardTheme 圆角）。
  Widget _buildGroupList() {
    final visible = _visibleGroups;
    return ReorderableListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.md,
        AppSpacing.lg,
        96,
      ),
      itemCount: visible.length,
      onReorderItem: _onReorder,
      proxyDecorator: (Widget child, int index, Animation<double> animation) {
        return AnimatedBuilder(
          animation: animation,
          builder: (BuildContext context, Widget? child) => Material(
            elevation: 2 * animation.value,
            borderRadius: BorderRadius.circular(AppRadius.lg),
            color: Theme.of(context).cardTheme.color ??
                Theme.of(context).colorScheme.surfaceContainerLow,
            child: child,
          ),
          child: child,
        );
      },
      itemBuilder: (BuildContext context, int index) => KeyedSubtree(
        key: ValueKey<String>(visible[index].id),
        child: _buildGroupTile(visible[index]),
      ),
    );
  }

  /// 顶层分组卡片：图标 + 名称 + 条目数/子分组数；整行点击进组内条目页，
  /// 长按拖动排序，trailing 菜单提供「重命名分组」「删除分组」入口。
  Widget _buildGroupTile(CollectionGroup group) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final l10n = AppLocalizations.of(context);

    final subtitleParts = <String>[
      l10n.collectionItemCount(group.itemCount),
    ];
    final folderCount = childCollectionsOf(_groups, group).length;
    if (folderCount > 0) {
      subtitleParts.add(l10n.collectionFolderCount(folderCount));
    }

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: ListTile(
        leading: collectionLeadingAvatar(group, scheme),
        title: Text(
          group.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          subtitleParts.join(' · '),
          style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
        ),
        trailing: PopupMenuButton<String>(
          tooltip: l10n.moreActions,
          onSelected: (String value) {
            if (value == 'rename') {
              unawaited(_showRenameDialog(group));
            } else if (value == 'delete') {
              unawaited(_confirmDelete(group));
            }
          },
          itemBuilder: (BuildContext menuContext) => <PopupMenuItem<String>>[
            PopupMenuItem<String>(
              value: 'rename',
              child: Row(
                children: <Widget>[
                  Icon(Icons.edit_outlined, size: 20, color: scheme.onSurfaceVariant),
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
                    Icons.delete_outline,
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
        onTap: () => _openCollection(group),
      ),
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
}
