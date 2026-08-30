import 'dart:async';

import 'package:flutter/material.dart';

import '../../services/collections_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';
import 'collection_items_screen.dart';

/// 收藏夹页（T4.1）。
///
/// 页面结构：收藏夹分组列表（名称 + 条目数）+ 右下角「新建分组」FAB。
///
/// 数据交互全部走 [CollectionsApiService]（Bearer 由 TokenStore 解析）：
/// - 首次进入 / 下拉刷新：listCollections（分组含服务端聚合的 item_count）；
/// - 新建分组：对话框输入名称 → createCollection → 重拉列表（后端新分组
///   sort_order=0 排最前）；
/// - 删除分组：分组行 trailing 菜单 → 确认对话框（说明组内条目不受影响）→
///   deleteCollection（后端级联删除子分组）→ 重拉列表；
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
  String? _error;

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
        _error = e.toString();
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
    setState(() => _isMutating = true);
    try {
      final group = await _api.createCollection(name);
      if (!mounted) {
        return;
      }
      unawaited(_load());
      _showSnackBar('已创建「${group.name}」');
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      _showSnackBar('创建失败：${_friendlyError(e.toString())}');
    } finally {
      if (mounted) {
        setState(() => _isMutating = false);
      }
    }
  }

  /// 删除分组：确认对话框（带说明）→ 删除 → 重拉列表。
  Future<void> _confirmDelete(CollectionGroup group) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('删除分组'),
        content: Text(
          '确定删除「${group.name}」吗？\n\n'
          '组内的剪贴板条目不会被删除，仍保留在剪贴板收藏中；'
          '该分组下的子分组会被一并删除。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            child: const Text('删除'),
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
      _showSnackBar('已删除「${group.name}」');
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      _showSnackBar('删除失败：${_friendlyError(e.toString())}');
    } finally {
      if (mounted) {
        setState(() => _isMutating = false);
      }
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

  /// 错误文案友好化：去掉异常前缀（'Exception: xxx' → 'xxx'）。
  String _friendlyError(String raw) => raw.replaceFirst(RegExp(r'^Exception:\s*'), '');

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _isMutating ? null : _showCreateDialog,
        icon: const Icon(Icons.create_new_folder_outlined),
        label: const Text('新建分组'),
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
    if (_isLoading && _groups.isEmpty) {
      return _scrollableBody(const SkeletonList(itemCount: 6));
    }
    if (_error != null && _groups.isEmpty) {
      return _scrollableBody(
        ErrorState(
          message: _friendlyError(_error!),
          onRetry: () => unawaited(_load()),
        ),
      );
    }
    if (_groups.isEmpty) {
      return _scrollableBody(
        EmptyState(
          icon: Icons.star_outline,
          title: '暂无收藏夹分组',
          message: '新建一个分组，把常用的剪贴板内容整理在一起',
          actionLabel: '新建分组',
          onAction: _isMutating ? null : _showCreateDialog,
        ),
      );
    }
    return _buildGroupList();
  }

  Widget _buildGroupList() {
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.md,
        AppSpacing.lg,
        96,
      ),
      itemCount: _groups.length,
      separatorBuilder: (BuildContext context, int index) =>
          const SizedBox(height: AppSpacing.md),
      itemBuilder: (BuildContext context, int index) =>
          _buildGroupTile(_groups[index]),
    );
  }

  /// 分组卡片：图标 + 名称 + 条目数；整行点击进组内条目页，
  /// trailing 菜单提供「删除分组」入口。
  Widget _buildGroupTile(CollectionGroup group) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: scheme.surfaceContainerHigh,
          child: Text(group.icon, style: const TextStyle(fontSize: 18)),
        ),
        title: Text(
          group.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          '${group.itemCount} 条内容',
          style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
        ),
        trailing: PopupMenuButton<String>(
          tooltip: '更多操作',
          onSelected: (String value) {
            if (value == 'delete') {
              unawaited(_confirmDelete(group));
            }
          },
          itemBuilder: (BuildContext menuContext) => <PopupMenuItem<String>>[
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
                  Text('删除分组', style: TextStyle(color: scheme.error)),
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
      setState(() => _errorText = '请输入分组名称');
      return;
    }
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新建分组'),
      content: TextField(
        controller: widget.controller,
        autofocus: true,
        maxLength: 100,
        decoration: InputDecoration(
          labelText: '分组名称',
          errorText: _errorText,
        ),
        onSubmitted: (String value) => _submit(),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _submit,
          child: const Text('创建'),
        ),
      ],
    );
  }
}
