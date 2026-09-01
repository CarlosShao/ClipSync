import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../services/app_exception.dart';
import '../../services/collections_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';
import 'collection_items_screen.dart';

/// 收藏夹页（T4.1 / C1 管理补齐）。
///
/// 页面结构：收藏夹分组列表（名称 + 条目数）+ 右下角「新建分组」FAB。
///
/// 数据交互全部走 [CollectionsApiService]（Bearer 由 TokenStore 解析）：
/// - 首次进入 / 下拉刷新：listCollections（分组含服务端聚合的 item_count）；
/// - 新建分组：对话框输入名称 → createCollection → 重拉列表（后端新分组
///   sort_order=0 排最前）；
/// - 删除分组：分组行 trailing 菜单 → 确认对话框（说明组内条目不受影响）→
///   deleteCollection（后端级联删除子分组）→ 重拉列表；
/// - 重命名分组（C1）：trailing 菜单 → 改名对话框（可选改图标 emoji）→
///   updateCollection → 重拉列表；
/// - 拖拽排序（C1）：列表长按拖动，乐观更新本地顺序 → reorderCollections
///   （批量端点被后端路由遮蔽时 API 层自动退化为逐条 sortOrder），失败回滚；
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

  List<CollectionGroup> _groups = <CollectionGroup>[];
  bool _isLoading = false;

  /// 创建 / 删除请求进行中（FAB 与空态按钮防重复提交）
  bool _isMutating = false;

  /// 最近一次失败的原始错误对象（UI 层经 friendlyError 映射 l10n 文案）
  Object? _error;

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
  Future<void> _showCreateDialog() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) =>
          _CreateCollectionDialog(controller: controller),
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
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(l10n.deleteCollection),
        content: Text(l10n.deleteCollectionConfirm(group.name)),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.cancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            child: Text(l10n.delete),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) {
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
          builder: (BuildContext dialogContext) => _RenameCollectionDialog(
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

  /// 拖拽排序：乐观更新本地顺序 → reorderCollections 持久化，失败回滚。
  ///（onReorderItem 的 newIndex 已代扣被移除项的位移，无需再 -1）
  Future<void> _onReorder(int oldIndex, int newIndex) async {
    final l10n = AppLocalizations.of(context);
    final previous = List<CollectionGroup>.of(_groups);
    setState(() {
      final moved = _groups.removeAt(oldIndex);
      _groups.insert(newIndex, moved);
    });
    try {
      await _api.reorderCollections(_groups);
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
    if (_groups.isEmpty) {
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

  /// 分组列表（C1 拖拽排序）：长按条目即可拖动换位，onReorder 乐观更新 +
  /// 失败回滚；拖拽中的条目以带阴影的 Material 提升（对齐 cardTheme 圆角）。
  Widget _buildGroupList() {
    return ReorderableListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.md,
        AppSpacing.lg,
        96,
      ),
      itemCount: _groups.length,
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
        key: ValueKey<String>(_groups[index].id),
        child: _buildGroupTile(_groups[index]),
      ),
    );
  }

  /// 分组卡片：图标 + 名称 + 条目数；整行点击进组内条目页，长按拖动排序，
  /// trailing 菜单提供「重命名分组」「删除分组」入口。
  Widget _buildGroupTile(CollectionGroup group) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final l10n = AppLocalizations.of(context);

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: scheme.surfaceContainerHigh,
          // 服务端 icon 字段存的是图标名（如 "folder"）而非 emoji：
          // ASCII 长串按文件夹图标渲染，emoji（短字符）才按文字渲染，
          // 避免图标名在圆标内折行成 "fold er"
          child: group.icon.length <= 2
              ? Text(group.icon, style: const TextStyle(fontSize: 18))
              : Icon(Icons.folder_outlined,
                  size: 20, color: scheme.primary),
        ),
        title: Text(
          group.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          l10n.collectionItemCount(group.itemCount),
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

/// 新建分组对话框：输入名称，空名称给出错误提示，回车或「创建」提交。
class _CreateCollectionDialog extends StatefulWidget {
  const _CreateCollectionDialog({required this.controller});

  final TextEditingController controller;

  @override
  State<_CreateCollectionDialog> createState() =>
      _CreateCollectionDialogState();
}

class _CreateCollectionDialogState extends State<_CreateCollectionDialog> {
  String? _errorText;

  void _submit() {
    final name = widget.controller.text.trim();
    if (name.isEmpty) {
      setState(() => _errorText = AppLocalizations.of(context).collectionNameRequired);
      return;
    }
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return AlertDialog(
      title: Text(l10n.createCollection),
      content: TextField(
        controller: widget.controller,
        autofocus: true,
        maxLength: 100,
        decoration: InputDecoration(
          labelText: l10n.collectionNameLabel,
          errorText: _errorText,
        ),
        onSubmitted: (String value) => _submit(),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(l10n.create),
        ),
      ],
    );
  }
}

/// 重命名分组对话框（C1）：输入名称（必填）+ 可选改图标 emoji。
///
/// 返回位置记录 `(name, icon)`：icon 为 null 表示未改图标（不随请求发送）；
/// 取消返回 null。预设图标全部为 ≤2 UTF-16 code unit 的 emoji，
/// 与分组卡片的 icon 渲染分支（length<=2 显示 emoji 文本）保持一致。
class _RenameCollectionDialog extends StatefulWidget {
  const _RenameCollectionDialog({
    required this.initialName,
    required this.initialIcon,
  });

  final String initialName;
  final String initialIcon;

  @override
  State<_RenameCollectionDialog> createState() =>
      _RenameCollectionDialogState();
}

class _RenameCollectionDialogState extends State<_RenameCollectionDialog> {
  /// 预设图标（覆盖常用语义：默认文件夹/星标/紧急/想法/目标/置顶/上线/媒体等）
  static const List<String> _presetIcons = <String>[
    '📁', '⭐', '🔥', '💡', '🎯', '📌', '🚀', '🎵', '📷', '🏠', '✅', '💼',
  ];

  late final TextEditingController _controller;
  late String _selectedIcon;
  bool _iconChanged = false;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialName);
    _selectedIcon = widget.initialIcon;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty) {
      setState(() => _errorText = AppLocalizations.of(context).collectionNameRequired);
      return;
    }
    Navigator.of(context).pop((name, _iconChanged ? _selectedIcon : null));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text(l10n.renameCollection),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          TextField(
            controller: _controller,
            autofocus: true,
            maxLength: 100,
            decoration: InputDecoration(
              labelText: l10n.collectionNameLabel,
              errorText: _errorText,
            ),
            onSubmitted: (String value) => _submit(),
          ),
          SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: <Widget>[
                for (final String emoji in _presetIcons)
                  Padding(
                    padding: const EdgeInsets.only(right: AppSpacing.sm),
                    child: _buildIconOption(emoji, scheme),
                  ),
              ],
            ),
          ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(l10n.save),
        ),
      ],
    );
  }

  /// 图标选项：选中态用 primary 描边加粗；当前 icon 不在预设里时无选中项。
  Widget _buildIconOption(String emoji, ColorScheme scheme) {
    final selected = emoji == _selectedIcon;
    return GestureDetector(
      onTap: () => setState(() {
        _selectedIcon = emoji;
        _iconChanged = true;
      }),
      child: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppRadius.sm),
          border: Border.all(
            color: selected ? scheme.primary : scheme.outlineVariant,
            width: selected ? 2 : 1,
          ),
        ),
        alignment: Alignment.center,
        child: Text(emoji, style: const TextStyle(fontSize: 20)),
      ),
    );
  }
}
