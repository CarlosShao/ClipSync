import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_localizations.dart';
import '../../providers/clipboard_provider.dart';
import '../../services/api_service.dart';
import '../../services/app_exception.dart';
import '../../services/collections_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';
import '../../widgets/favorites/collection_picker.dart';

/// 收藏夹组内条目页（T4.1 / C1 管理补齐）。
///
/// 由 FavoritesScreen 以根 Navigator 全屏压入（自带 Scaffold + AppBar，
/// 盖过主页 shell 的标题栏与底栏）。
///
/// 数据交互：条目列表走 CollectionsApiService.listCollectionItems
/// （`GET /api/favorites/collections/:id/items`，只含 content_preview）。
///
/// 点击条目 = 复制全文（对齐 ClipboardProvider.resolveCopyText 的取数路径）：
/// - 条目仍在剪贴板 provider 缓存中 → 复用既有 resolveCopyText
///   （预览截断时经内容接口拉全文并回填缓存）；
/// - 否则文本类条目（text/link/code）直接走 `GET /api/clipboard/:id/content`
///   拉全文，失败退化为预览；其余类型直接复制预览文本；
/// - 最终 Clipboard.setData + SnackBar 反馈。
///
/// 长按条目（C1）→ 底部动作菜单：
/// - 「加入其他分组」：分组选择对话框 → addItemToCollection（后端唯一归属
///   自动移出其他分组 = 移动语义）→ 本组列表即时移除该条目；
/// - 「移出分组」：removeItemFromCollection，乐观移除 + 失败回滚
///   （条目仅解除分组关联，不从剪贴板删除）；
/// - 「多选」（C1 收尾）：进入多选模式（AppBar 动作图标同入口）。
///
/// 多选模式（C1 收尾：条目多选移动）：
/// - AppBar 切换为多选态：关闭按钮 + 「已选 N 项」标题 + 全选/取消全选；
/// - 条目前出现勾选框，点击条目切换勾选（复制/长按菜单暂停）；
/// - 底部操作栏「移动到…」→ collection_picker 选目标分组 → 批量
///   addItemToCollection（后端唯一归属 = 移动语义，加入即自动移出本组）；
///   完成后退出多选态并刷新。
class CollectionItemsScreen extends StatefulWidget {
  const CollectionItemsScreen({required this.collection, super.key});

  /// 所属收藏夹分组（名称用于 AppBar 标题）
  final CollectionGroup collection;

  @override
  State<CollectionItemsScreen> createState() => _CollectionItemsScreenState();
}

class _CollectionItemsScreenState extends State<CollectionItemsScreen> {
  final CollectionsApiService _api = CollectionsApiService();

  List<FavoriteEntry> _items = <FavoriteEntry>[];
  bool _isLoading = false;

  /// 正在复制全文的条目 id（行尾转圈反馈；null = 无复制进行中）
  String? _copyingId;

  /// 最近一次失败的原始错误对象（UI 层经 friendlyError 映射 l10n 文案）
  Object? _error;

  /// 多选模式（C1 收尾）：AppBar 动作 / 长按菜单进入，批量移动完成后退出
  bool _multiSelect = false;

  /// 多选模式下已勾选的条目 id
  final Set<String> _selectedIds = <String>{};

  /// 批量移动进行中（防重复提交 + 按钮转圈）
  bool _moving = false;

  /// 当前列表条目是否已全部勾选（空列表视为未全选）
  bool get _isAllSelected =>
      _items.isNotEmpty && _selectedIds.length == _items.length;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// 拉取组内条目列表。
  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final items = await _api.listCollectionItems(widget.collection.id);
      if (!mounted) {
        return;
      }
      setState(() {
        _items = items;
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
  // 复制全文
  // ---------------------------------------------------------------------------

  /// 点击条目 → 复制全文（含加载反馈与失败提示）。
  Future<void> _copyEntry(FavoriteEntry entry) async {
    if (_copyingId != null) {
      return;
    }
    // initState 阶段捕获的引用与同步快照，避免跨 async gap 使用 context
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

  /// 解析复制文本（取数路径对齐 ClipboardProvider.resolveCopyText）：
  /// 已有全文直接用；预览疑似截断的文本类条目拉全文；失败退化为预览。
  Future<String> _resolveCopyText(
    FavoriteEntry entry,
    ClipboardProvider provider,
    bool inProviderCache,
  ) async {
    if (inProviderCache) {
      // 复用既有 provider 路径（预览截断时经内容接口拉全文并回填缓存）
      return provider.resolveCopyText(null, entry.id);
    }
    if (entry.isTextLike && entry.mayBeTruncated) {
      try {
        // GET /api/clipboard/:id/content（token 由 TokenStore 解析）
        final full = await ApiService().getItemContent(null, entry.id);
        if (full != null && full.isNotEmpty) {
          return full;
        }
      } on Exception catch (_) {
        // 拉取失败：退化为预览文本（仅 >5000 字符时才会失真，属可接受降级）
      }
    }
    return entry.contentPreview;
  }

  // ---------------------------------------------------------------------------
  // 分组条目管理（C1）
  // ---------------------------------------------------------------------------

  /// 长按条目 → 底部动作菜单（加入其他分组 / 移出分组）。
  Future<void> _showEntryActions(FavoriteEntry entry) async {
    final l10n = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (BuildContext sheetContext) => SafeArea(
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
              leading: const Icon(Icons.checklist),
              title: Text(l10n.multiSelect),
              onTap: () => Navigator.of(sheetContext).pop('multi'),
            ),
          ],
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
    } else if (action == 'multi') {
      // 长按入口进入多选态，并预勾选该条目
      _enterMultiSelect(entry.id);
    }
  }

  /// 加入其他分组：分组选择 → addItem（后端唯一归属自动移出本组 = 移动），
  /// 成功后把条目从本组列表即时移除。
  Future<void> _moveEntryToOtherCollection(FavoriteEntry entry) async {
    final target = await addItemToCollectionFlow(
      context,
      itemId: entry.id,
      excludeCollectionId: widget.collection.id,
    );
    if (target == null || !mounted) {
      return;
    }
    setState(() => _items.removeWhere((FavoriteEntry e) => e.id == entry.id));
  }

  /// 移出分组：乐观移除 + 失败回滚（条目仅解除关联，不从剪贴板删除）。
  Future<void> _removeEntryFromCollection(FavoriteEntry entry) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final snapshot = List<FavoriteEntry>.of(_items);
    setState(() => _items.removeWhere((FavoriteEntry e) => e.id == entry.id));
    try {
      await _api.removeItemFromCollection(widget.collection.id, entry.id);
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

  // ---------------------------------------------------------------------------
  // 多选移动（C1 收尾）
  // ---------------------------------------------------------------------------

  /// 进入多选模式；[initialId] 非空时预勾选该条目（长按菜单入口）。
  void _enterMultiSelect([String? initialId]) {
    setState(() {
      _multiSelect = true;
      _selectedIds.clear();
      if (initialId != null) {
        _selectedIds.add(initialId);
      }
    });
  }

  /// 退出多选模式并清空勾选。
  void _exitMultiSelect() {
    setState(() {
      _multiSelect = false;
      _selectedIds.clear();
    });
  }

  /// 勾选/取消勾选单个条目。
  void _toggleSelected(String entryId) {
    setState(() {
      if (_selectedIds.contains(entryId)) {
        _selectedIds.remove(entryId);
      } else {
        _selectedIds.add(entryId);
      }
    });
  }

  /// 全选/取消全选（AppBar 动作：已全选 → 取消全选，否则全选）。
  void _toggleSelectAll() {
    setState(() {
      if (_isAllSelected) {
        _selectedIds.clear();
      } else {
        _selectedIds.addAll(_items.map((FavoriteEntry e) => e.id));
      }
    });
  }

  /// 批量移动勾选条目到其他分组：
  ///
  /// 1. 拉取全部分组并排除当前组（无可选分组 → noAvailableGroups 提示）；
  /// 2. [showCollectionPickerDialog] 选择目标分组（取消 = 放弃本次移动）；
  /// 3. 逐条调既有 addItemToCollection —— 后端唯一归属：加入目标分组时自动
  ///    移出其他分组（含本组），即「移动」语义，无需先 removeItemFromCollection
  ///    （先删后加在加失败时会把条目留在无分组状态，add-first 更稳）；
  /// 4. 全部失败 → 保留多选态与勾选便于重试；有成功项 → 移出本地列表、
  ///    退出多选态并刷新（部分失败时对失败部分追加 friendlyError 提示）。
  Future<void> _moveSelectedToCollection() async {
    if (_selectedIds.isEmpty || _moving) {
      return;
    }
    // initState 阶段捕获引用，避免跨 async gap 使用 context
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _moving = true);
    try {
      final groups = await _api.listCollections();
      if (!mounted) {
        return;
      }
      final options = groups
          .where((CollectionGroup g) => g.id != widget.collection.id)
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
      // 结果提示（单条 SnackBar）：全部成功 → moveSuccess；
      // 部分/全部失败 → moveSuccess（有成功项时）+ friendlyError 并列展示，
      // 避免后一条把前一条顶掉。
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
        // 全部失败：保留多选态与勾选，提示错误后可重试
        return;
      }
      // 完成后退出多选态并刷新：先本地移出已移动项（避免闪烁），再拉服务端权威状态
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
    return Scaffold(
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
              : widget.collection.name,
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
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildContent(),
      ),
      bottomNavigationBar: _multiSelect ? _buildSelectionBar(l10n) : null,
    );
  }

  /// 多选底部操作栏：「移动到…」批量移动到其他分组（无勾选 / 移动中禁用）。
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

  /// 主体：三态分发。骨架/错误/空态也包在 RefreshIndicator 的可滚动容器里，
  /// 保证任何状态下都能下拉刷新。
  Widget _buildContent() {
    final l10n = AppLocalizations.of(context);
    if (_isLoading && _items.isEmpty) {
      return _scrollableBody(const SkeletonList(itemCount: 6));
    }
    if (_error != null && _items.isEmpty) {
      return _scrollableBody(
        ErrorState(
          message: friendlyError(_error, l10n),
          onRetry: () => unawaited(_load()),
        ),
      );
    }
    if (_items.isEmpty) {
      return _scrollableBody(
        EmptyState(
          icon: Icons.folder_open,
          title: l10n.collectionItemsEmptyTitle,
          message: l10n.collectionItemsEmptyMessage,
        ),
      );
    }
    return _buildItemList();
  }

  Widget _buildItemList() {
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.md,
        AppSpacing.lg,
        AppSpacing.xxl,
      ),
      itemCount: _items.length,
      separatorBuilder: (BuildContext context, int index) =>
          const SizedBox(height: AppSpacing.md),
      itemBuilder: (BuildContext context, int index) =>
          _buildEntryTile(_items[index]),
    );
  }

  /// 条目卡片：类型色块 + 3 行预览 + 来源设备与相对时间；
  /// 整行点击复制全文（复制中行尾转圈），长按弹分组管理菜单。
  /// 多选模式下：条目前出现勾选框，点击切换勾选，复制/长按菜单暂停。
  Widget _buildEntryTile(FavoriteEntry entry) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final l10n = AppLocalizations.of(context);
    final isCopying = _copyingId == entry.id;
    final isSelected = _selectedIds.contains(entry.id);

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      // 多选态勾选高亮：轻微品牌色底（未勾选保持卡片默认底色）
      color: _multiSelect && isSelected
          ? scheme.primary.withValues(alpha: 0.08)
          : null,
      child: InkWell(
        onTap: _multiSelect
            ? () => _toggleSelected(entry.id)
            : (isCopying ? null : () => unawaited(_copyEntry(entry))),
        onLongPress:
            _multiSelect ? null : () => unawaited(_showEntryActions(entry)),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (_multiSelect) ...<Widget>[
                Checkbox(
                  value: isSelected,
                  onChanged: (_) => _toggleSelected(entry.id),
                ),
                const SizedBox(width: AppSpacing.sm),
              ],
              _buildTypeBadge(entry, scheme),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      entry.contentPreview.isEmpty ? l10n.placeholderEmpty : entry.contentPreview,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.bodyMedium,
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    Row(
                      children: <Widget>[
                        Icon(
                          _deviceIcon(entry.platform),
                          size: 13,
                          color: scheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: AppSpacing.xs),
                        Expanded(
                          child: Text(
                            _buildMetaText(entry),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: textTheme.labelSmall?.copyWith(
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              // 多选态隐藏复制入口（点击语义切换为勾选），避免误导
              if (!_multiSelect) ...<Widget>[
                const SizedBox(width: AppSpacing.sm),
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.xs),
                  child: isCopying
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Icon(
                          Icons.content_copy_outlined,
                          size: 18,
                          color: scheme.onSurfaceVariant,
                        ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// 类型色块（颜色与图标对齐 ClipboardCard 的语义分档）。
  Widget _buildTypeBadge(FavoriteEntry entry, ColorScheme scheme) {
    final color = _typeColor(entry.contentType, scheme);
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(AppRadius.md),
      ),
      child: Icon(_typeIcon(entry.contentType), size: 22, color: color),
    );
  }

  /// 副文本：来源设备名 + 相对时间。
  String _buildMetaText(FavoriteEntry entry) {
    final l10n = AppLocalizations.of(context);
    final device = entry.deviceName;
    final time = entry.createdAt != null ? _formatRelativeTime(entry.createdAt!, l10n) : '';
    if (device == null || device.isEmpty) {
      return time.isEmpty ? l10n.unknownSource : time;
    }
    if (time.isEmpty) {
      return device;
    }
    return '$device · $time';
  }

  /// 类型主色：语义色走 AppColors（亮暗分档），文件/代码走 ColorScheme 派生色。
  Color _typeColor(String contentType, ColorScheme scheme) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    switch (contentType) {
      case 'link':
        return isDark ? AppColors.successDark : AppColors.success;
      case 'image':
        return isDark ? AppColors.warningDark : AppColors.warning;
      case 'file':
        return scheme.tertiary;
      case 'code':
        return scheme.secondary;
      default:
        return scheme.primary;
    }
  }

  /// 类型图标（未识别类型回退文本图标）。
  IconData _typeIcon(String contentType) {
    switch (contentType) {
      case 'image':
        return Icons.image_outlined;
      case 'link':
        return Icons.link;
      case 'file':
        return Icons.insert_drive_file_outlined;
      case 'code':
        return Icons.code;
      default:
        return Icons.subject;
    }
  }

  /// 来源设备平台图标（对齐 ClipboardCard）。
  IconData _deviceIcon(String? platform) {
    switch (platform?.toLowerCase()) {
      case 'windows':
        return Icons.computer;
      case 'macos':
        return Icons.laptop_mac;
      case 'linux':
        return Icons.computer;
      case 'ios':
        return Icons.phone_iphone;
      case 'android':
        return Icons.phone_android;
      default:
        return Icons.devices_other;
    }
  }

  /// 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / M 月 D 日（对齐 ClipboardCard）。
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
