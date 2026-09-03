import 'dart:async';

import 'package:flutter/material.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/screens/favorites/collection_dialogs.dart';
import 'package:clipsync_mobile/screens/favorites/collection_items_screen.dart';
import 'package:clipsync_mobile/services/app_exception.dart';
import 'package:clipsync_mobile/services/collections_api_service.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/widgets/common/app_card.dart';
import 'package:clipsync_mobile/widgets/common/empty_state.dart';
import 'package:clipsync_mobile/widgets/common/error_state.dart';
import 'package:clipsync_mobile/widgets/common/skeleton_list.dart';

/// 收藏夹页（T4.1 / C1 管理补齐；树形层级导航根页，Obsidian v2）。
///
/// 遵循 5.5 规格：
/// - 顶层分组卡片列表：卡片采用 AppCard v2 (SurfaceTier.low)；
/// - 左侧专属分组颜色圆标（Paste Pinboard 模式：派生亮暗适配色）；
/// - 展示分组名称 + 「N items · M folders」统计徽章 + 右侧 ⋮ 菜单（重命名/删除）；
/// - 点击分组平滑进入子层。
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

  /// 新建分组：采用 Obsidian v2 28dp 大圆角 BottomSheet。
  Future<void> _showCreateDialog() async {
    final name = await showCreateCollectionSheet(context);
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

  /// 拖拽排序（C1，仅顶层分组）：乐观更新本地顺序 → reorderCollections 持久化，失败回滚。
  Future<void> _onReorder(int oldIndex, int newIndex) async {
    final l10n = AppLocalizations.of(context);
    final previous = List<CollectionGroup>.of(_groups);
    final reordered = List<CollectionGroup>.of(_visibleGroups);
    reordered.insert(newIndex, reordered.removeAt(oldIndex));
    setState(() {
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

  /// 点进分组：根 Navigator 全屏压入组内条目页。
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

  /// 主体：三态分发。
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

  /// 顶层分组列表（C1 拖拽排序）：长按条目即可拖动换位。
  Widget _buildGroupList() {
    final visible = _visibleGroups;
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

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
            elevation: AppElevationV2.floating * animation.value,
            borderRadius: BorderRadius.circular(AppShapesV2.md),
            color: AppColorsV2.surface(context, tier: SurfaceTier.low),
            child: child,
          ),
          child: child,
        );
      },
      itemBuilder: (BuildContext context, int index) => KeyedSubtree(
        key: ValueKey<String>(visible[index].id),
        child: Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.md),
          child: _buildGroupTile(visible[index], isDark),
        ),
      ),
    );
  }

  /// 顶层分组卡片：AppCard v2 (SurfaceTier.low) + 左侧专属分组颜色圆标 +
  /// 名称 + 「N items · M folders」统计徽章 + 右侧 ⋮ 菜单。
  Widget _buildGroupTile(CollectionGroup group, bool isDark) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final l10n = AppLocalizations.of(context);

    final folderCount = childCollectionsOf(_groups, group).length;
    final String itemsBadgeText = l10n.collectionItemCount(group.itemCount);
    final String? folderBadgeText =
        folderCount > 0 ? l10n.collectionFolderCount(folderCount) : null;

    final Color accentColor = collectionAccentColor(group, isDark);

    return AppCard(
      surfaceTier: SurfaceTier.low,
      borderRadius: AppShapesV2.brMd,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.md,
      ),
      onTap: () => _openCollection(group),
      child: Row(
        children: <Widget>[
          collectionLeadingAvatar(
            group,
            scheme,
            size: 42,
            isDark: isDark,
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  group.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: <Widget>[
                    _buildCountBadge(itemsBadgeText, accentColor, isDark),
                    if (folderBadgeText != null) ...<Widget>[
                      const SizedBox(width: AppSpacing.xs),
                      _buildCountBadge(
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

  /// 统计徽章：pill 样式小胶囊。
  Widget _buildCountBadge(
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

  /// 全页可滚动包装：内容不满一屏时也能下拉刷新。
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

