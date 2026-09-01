import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../l10n/app_localizations.dart';
import '../../models/clipboard_item.dart';
import '../../services/api_service.dart';
import '../../services/app_exception.dart';
import '../../services/shared_links_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/app_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';

/// FAB 创建流程的过期时间选项（对齐后端 expiresInHours 语义）。
enum _ExpiryOption { never, oneDay, oneWeek, oneMonth }

/// 共享链接页（C5）。
///
/// 展示当前用户全部外部分享链接：内容预览 / 创建时间 / 有效期（永久或
/// 具体日期，已过期红色 + 徽标）/ 浏览次数；操作：复制链接、撤销（确认框）。
///
/// FAB 创建流程（对齐后端 sharedLinks.js 创建逻辑）：
/// 1. 拉取剪贴板第一页（复用 [ApiService.getClipboardItems]，强制刷新），
///    弹条目选择对话框（仅文本 text/link/code 与文件条目可分享）；
/// 2. 选择过期时间（永不过期 / 1 天 / 7 天 / 30 天 → expiresInHours）；
/// 3. 调 [SharedLinksApiService.createLinkFromClipboardItem] 创建；
///    成功后复制链接（文案 sharedLinkCreated「已创建并复制」）+ 刷新列表。
///
/// 三态：SkeletonList（加载中）/ ErrorState（失败可重试）/ EmptyState
/// （无共享链接），支持下拉刷新。
class SharedLinksScreen extends StatefulWidget {
  const SharedLinksScreen({super.key});

  @override
  State<SharedLinksScreen> createState() => _SharedLinksScreenState();
}

class _SharedLinksScreenState extends State<SharedLinksScreen> {
  final SharedLinksApiService _api = SharedLinksApiService();

  List<SharedLink> _links = <SharedLink>[];
  bool _isLoading = false;
  bool _creating = false;

  /// 最近一次加载失败的原始错误对象（UI 层经 friendlyError 映射 l10n 文案）
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final links = await _api.listLinks();
      if (!mounted) {
        return;
      }
      setState(() {
        _links = links;
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
  // 复制 / 撤销
  // ---------------------------------------------------------------------------

  Future<void> _copyLink(SharedLink link) async {
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    await Clipboard.setData(ClipboardData(text: link.url));
    messenger.showSnackBar(
      SnackBar(content: Text(l10n.linkCopied), duration: const Duration(seconds: 2)),
    );
  }

  Future<void> _revokeLink(SharedLink link) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        final l10n = AppLocalizations.of(dialogContext);
        return AlertDialog(
          title: Text(l10n.revokeLink),
          content: Text(l10n.revokeLinkConfirm),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(l10n.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(
                l10n.confirm,
                style: TextStyle(color: Theme.of(dialogContext).colorScheme.error),
              ),
            ),
          ],
        );
      },
    );

    if (confirmed != true || !mounted) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    try {
      await _api.revokeLink(link.id);
      if (!mounted) {
        return;
      }
      setState(() {
        _links = _links.where((SharedLink l) => l.id != link.id).toList();
      });
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.sharedLinkRevoked),
          duration: const Duration(seconds: 2),
        ),
      );
    } on Exception catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(friendlyError(e, l10n))),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // FAB 创建流程：选条目 → 选过期时间 → 创建
  // ---------------------------------------------------------------------------

  Future<void> _showCreateFlow() async {
    final l10n = AppLocalizations.of(context);

    // 1. 拉取剪贴板第一页并弹条目选择对话框（文本 / 文件条目可分享）
    setState(() => _creating = true);
    ClipboardItem? selected;
    Object? pickError;
    try {
      final page = await ApiService().getClipboardItems(
        null,
        page: 1,
        limit: 20,
        forceRefresh: true,
      );
      final List<ClipboardItem> eligible = page.items
          .where(
            (ClipboardItem it) =>
                it.isText || it.isLink || it.isCode || it.isFile,
          )
          .toList();
      if (mounted) {
        setState(() => _creating = false);
        selected = await _showItemPickerDialog(eligible);
      }
    } on Exception catch (e) {
      pickError = e;
    }
    if (!mounted) {
      return;
    }
    if (pickError != null) {
      setState(() => _creating = false);
      _showSnack(friendlyError(pickError, l10n));
      return;
    }
    if (selected == null) {
      return;
    }

    // 2. 选择过期时间（取消即中止）
    final _ExpiryOption? option = await _showExpiryPickerDialog();
    if (option == null || !mounted) {
      return;
    }

    // 3. 创建（成功后复制链接，与 sharedLinkCreated 文案一致）并刷新列表
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _creating = true);
    try {
      final SharedLink created = await _api.createLinkFromClipboardItem(
        selected,
        expiresInHours: _expiryHours(option),
      );
      await Clipboard.setData(ClipboardData(text: created.url));
      await _load();
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.sharedLinkCreated)),
      );
    } on Exception catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(friendlyError(e, l10n))),
      );
    } finally {
      if (mounted) {
        setState(() => _creating = false);
      }
    }
  }

  /// 过期选项 → 后端 expiresInHours（never 为 null 表示永不过期）
  int? _expiryHours(_ExpiryOption option) {
    switch (option) {
      case _ExpiryOption.oneDay:
        return 24;
      case _ExpiryOption.oneWeek:
        return 168;
      case _ExpiryOption.oneMonth:
        return 720;
      case _ExpiryOption.never:
        return null;
    }
  }

  Future<ClipboardItem?> _showItemPickerDialog(List<ClipboardItem> items) {
    return showDialog<ClipboardItem>(
      context: context,
      builder: (BuildContext dialogContext) {
        final l10n = AppLocalizations.of(dialogContext);
        return AlertDialog(
          title: Text(l10n.createSharedLink),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 360),
            child: SizedBox(
              width: double.maxFinite,
              child: items.isEmpty
                  ? EmptyState(
                      title: l10n.clipboardEmptyTitle,
                      message: l10n.clipboardEmptyMessage,
                    )
                  : ListView.builder(
                      shrinkWrap: true,
                      itemCount: items.length,
                      itemBuilder: (BuildContext context, int index) {
                        final ClipboardItem item = items[index];
                        return ListTile(
                          leading: Icon(_itemIcon(item)),
                          title: Text(
                            item.isText || item.isLink || item.isCode
                                ? item.copyText
                                : (item.fileName ?? item.contentPreview),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(
                            _typeLabel(l10n, item),
                            style: Theme.of(dialogContext)
                                .textTheme
                                .labelSmall
                                ?.copyWith(
                                  color: Theme.of(dialogContext)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                          ),
                          onTap: () => Navigator.of(dialogContext).pop(item),
                        );
                      },
                    ),
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: Text(l10n.cancel),
            ),
          ],
        );
      },
    );
  }

  Future<_ExpiryOption?> _showExpiryPickerDialog() {
    return showDialog<_ExpiryOption>(
      context: context,
      builder: (BuildContext dialogContext) {
        final l10n = AppLocalizations.of(dialogContext);
        return SimpleDialog(
          title: Text(l10n.expiryDate),
          children: <Widget>[
            SimpleDialogOption(
              onPressed: () =>
                  Navigator.of(dialogContext).pop(_ExpiryOption.never),
              child: Text(l10n.expiryNever),
            ),
            SimpleDialogOption(
              onPressed: () =>
                  Navigator.of(dialogContext).pop(_ExpiryOption.oneDay),
              child: Text(l10n.expiryOneDay),
            ),
            SimpleDialogOption(
              onPressed: () =>
                  Navigator.of(dialogContext).pop(_ExpiryOption.oneWeek),
              child: Text(l10n.expiryOneWeek),
            ),
            SimpleDialogOption(
              onPressed: () =>
                  Navigator.of(dialogContext).pop(_ExpiryOption.oneMonth),
              child: Text(l10n.expiryOneMonth),
            ),
          ],
        );
      },
    );
  }

  void _showSnack(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.sharedLinks)),
      floatingActionButton: FloatingActionButton(
        onPressed: _creating ? null : _showCreateFlow,
        tooltip: l10n.createSharedLink,
        child: _creating
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.add_link),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading && _links.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xl),
          SkeletonList(itemCount: 6),
        ],
      );
    }
    if (_error != null && _links.isEmpty) {
      final l10n = AppLocalizations.of(context);
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xxl),
          ErrorState(
            message: friendlyError(_error!, l10n),
            onRetry: _load,
          ),
        ],
      );
    }
    if (_links.isEmpty) {
      final l10n = AppLocalizations.of(context);
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xxl),
          EmptyState(
            icon: Icons.link,
            title: l10n.noSharedLinks,
            message: l10n.noSharedLinksDesc,
          ),
        ],
      );
    }
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.lg),
      itemCount: _links.length,
      separatorBuilder: (BuildContext context, int index) =>
          const SizedBox(height: AppSpacing.md),
      itemBuilder: (BuildContext context, int index) =>
          _buildLinkCard(_links[index]),
    );
  }

  Widget _buildLinkCard(SharedLink link) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final bool expired = link.isExpired;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: scheme.secondaryContainer,
                  borderRadius: BorderRadius.circular(AppRadius.sm),
                ),
                child: Icon(
                  _linkIcon(link),
                  size: 20,
                  color: scheme.onSecondaryContainer,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Text(
                  _displayTitle(link),
                  style: theme.textTheme.titleSmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.copy_rounded, size: 20),
                tooltip: l10n.copyLink,
                onPressed: () => unawaited(_copyLink(link)),
              ),
              IconButton(
                icon: Icon(
                  Icons.link_off_rounded,
                  size: 20,
                  color: scheme.error,
                ),
                tooltip: l10n.revokeLink,
                onPressed: () => unawaited(_revokeLink(link)),
              ),
            ],
          ),
          if (_displayPreview(link) != null) ...<Widget>[
            const SizedBox(height: AppSpacing.sm),
            Text(
              _displayPreview(link)!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
          const SizedBox(height: AppSpacing.sm),
          Text(
            link.url,
            style: theme.textTheme.labelSmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: <Widget>[
              Icon(Icons.visibility_outlined,
                  size: 14, color: scheme.onSurfaceVariant),
              const SizedBox(width: AppSpacing.xs),
              Text(
                '${link.views}',
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Text(
                  _formatCreatedAt(l10n, link),
                  style: theme.textTheme.labelSmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (expired) ...<Widget>[
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.sm,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: scheme.errorContainer,
                    borderRadius: BorderRadius.circular(AppRadius.sm),
                  ),
                  child: Text(
                    l10n.expiredBadge,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.onErrorContainer,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
              ],
              Flexible(
                child: Text(
                  _expiryLabel(l10n, link),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: expired ? scheme.error : scheme.onSurfaceVariant,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 标题：后端兜底值为 '(无标题)' 时回退预览 / 链接
  String _displayTitle(SharedLink link) {
    final String title = link.title.trim();
    if (title.isNotEmpty && title != '(无标题)') {
      return title;
    }
    return _displayPreview(link) ?? (link.url.isEmpty ? title : link.url);
  }

  String? _displayPreview(SharedLink link) {
    final String? preview = link.preview?.trim();
    if (preview == null || preview.isEmpty) {
      return null;
    }
    // 文件条目预览即文件名，与标题重复时不重复展示
    if (preview == link.title.trim() || preview == link.fileName) {
      return null;
    }
    return preview;
  }

  IconData _linkIcon(SharedLink link) {
    switch (link.contentType) {
      case 'file':
        return Icons.insert_drive_file_rounded;
      case 'image':
        return Icons.image_outlined;
      case 'code':
        return Icons.code_rounded;
      default:
        return Icons.link_rounded;
    }
  }

  IconData _itemIcon(ClipboardItem item) {
    if (item.isImage) {
      return Icons.image_outlined;
    }
    if (item.isFile) {
      return Icons.insert_drive_file_rounded;
    }
    if (item.isCode) {
      return Icons.code_rounded;
    }
    if (item.isLink) {
      return Icons.link_rounded;
    }
    return Icons.notes_rounded;
  }

  String _typeLabel(AppLocalizations l10n, ClipboardItem item) {
    if (item.isFile) {
      return l10n.typeFile;
    }
    if (item.isImage) {
      return l10n.typeImage;
    }
    if (item.isCode) {
      return l10n.typeCode;
    }
    if (item.isLink) {
      return l10n.typeLink;
    }
    return l10n.typeText;
  }

  String _expiryLabel(AppLocalizations l10n, SharedLink link) {
    final DateTime? expiresAt = link.expiresAt;
    if (expiresAt == null) {
      return l10n.neverExpires;
    }
    return l10n.expiresAt(_formatDate(l10n, expiresAt));
  }

  String _formatCreatedAt(AppLocalizations l10n, SharedLink link) {
    final DateTime? createdAt = link.createdAt;
    if (createdAt == null) {
      return '';
    }
    final diff = DateTime.now().difference(createdAt);
    if (diff.inMinutes < 1) {
      return l10n.relJustNow;
    }
    if (diff.inHours < 1) {
      return l10n.relMinutesAgo(diff.inMinutes);
    }
    if (diff.inDays < 1) {
      return l10n.relHoursAgo(diff.inHours);
    }
    if (diff.inDays < 7) {
      return l10n.relDaysAgo(diff.inDays);
    }
    return _formatDate(l10n, createdAt);
  }

  /// 日期格式（对齐 relDateYMD：{year}/{month}/{day}）
  String _formatDate(AppLocalizations l10n, DateTime dateTime) {
    return l10n.relDateYMD(dateTime.year, dateTime.month, dateTime.day);
  }
}
