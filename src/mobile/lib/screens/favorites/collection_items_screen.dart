import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../providers/clipboard_provider.dart';
import '../../services/api_service.dart';
import '../../services/collections_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';

/// 收藏夹组内条目页（T4.1）。
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
  String? _error;

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
        _error = e.toString();
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
    final inProviderCache = provider.items.any((item) => item.id == entry.id);

    setState(() => _copyingId = entry.id);
    try {
      final text = await _resolveCopyText(entry, provider, inProviderCache);
      if (text.isEmpty) {
        messenger
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(content: Text('该条目暂无可复制的内容')));
        return;
      }
      await Clipboard.setData(ClipboardData(text: text));
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('已复制到剪贴板')));
    } on Exception catch (_) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('复制失败，请重试')));
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
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.collection.name),
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
    if (_isLoading && _items.isEmpty) {
      return _scrollableBody(const SkeletonList(itemCount: 6));
    }
    if (_error != null && _items.isEmpty) {
      return _scrollableBody(
        ErrorState(
          message: _friendlyError(_error!),
          onRetry: () => unawaited(_load()),
        ),
      );
    }
    if (_items.isEmpty) {
      return _scrollableBody(
        const EmptyState(
          icon: Icons.folder_open,
          title: '该分组暂无内容',
          message: '在剪贴板列表中将内容加入收藏后，会出现在这里',
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
  /// 整行点击复制全文，复制中行尾转圈。
  Widget _buildEntryTile(FavoriteEntry entry) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final isCopying = _copyingId == entry.id;

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: isCopying ? null : () => unawaited(_copyEntry(entry)),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _buildTypeBadge(entry, scheme),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      entry.contentPreview.isEmpty ? '（空内容）' : entry.contentPreview,
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
    final device = entry.deviceName;
    final time = entry.createdAt != null ? _formatRelativeTime(entry.createdAt!) : '';
    if (device == null || device.isEmpty) {
      return time.isEmpty ? '未知来源' : time;
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
  String _formatRelativeTime(DateTime time) {
    final Duration diff = DateTime.now().difference(time);
    if (diff.inMinutes < 1) {
      return '刚刚';
    }
    if (diff.inMinutes < 60) {
      return '${diff.inMinutes} 分钟前';
    }
    if (diff.inHours < 24) {
      return '${diff.inHours} 小时前';
    }
    if (diff.inDays < 7) {
      return '${diff.inDays} 天前';
    }
    return '${time.month} 月 ${time.day} 日';
  }

  /// 错误文案友好化：去掉异常前缀（'Exception: xxx' → 'xxx'）。
  String _friendlyError(String raw) => raw.replaceFirst(RegExp(r'^Exception:\s*'), '');

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
