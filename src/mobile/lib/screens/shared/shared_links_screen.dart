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
import '../../widgets/common/mono_text.dart';
import '../../widgets/common/skeleton_list.dart';
import '../../widgets/common/type_badge.dart';

/// FAB 创建流程的过期时间选项（对齐后端 expiresInHours 语义）。
enum _ExpiryOption { never, oneDay, oneWeek, oneMonth }

/// 共享链接页（C5 / Obsidian v2）。
///
/// 视觉与交互规格：
/// - 共享链接管理列表：展示条目摘要、链接访问次数、过期时间倒计时；
/// - 快速复制共享链接与撤销失效按钮；
/// - 弹层全部采用 28dp (AppShapesV2.xl) 圆角。
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
          shape: AppShapesV2.shapeXl,
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
                style: TextStyle(
                  color: Theme.of(dialogContext).colorScheme.error,
                  fontWeight: FontWeight.w600,
                ),
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
  // FAB 创建流程
  // ---------------------------------------------------------------------------

  Future<void> _showCreateFlow() async {
    final l10n = AppLocalizations.of(context);

    // 1. 拉取剪贴板第一页并弹条目选择对话框
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

    // 2. 选择过期时间
    final _ExpiryOption? option = await _showExpiryPickerDialog();
    if (option == null || !mounted) {
      return;
    }

    // 3. 创建并刷新列表
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
        final bool isDark = Theme.of(dialogContext).brightness == Brightness.dark;

        return AlertDialog(
          shape: AppShapesV2.shapeXl,
          title: Text(l10n.createSharedLink),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 380),
            child: SizedBox(
              width: double.maxFinite,
              child: items.isEmpty
                  ? EmptyState(
                      illustration: EmptyStateIllustration.generic,
                      title: l10n.clipboardEmptyTitle,
                      message: l10n.clipboardEmptyMessage,
                    )
                  : ListView.separated(
                      shrinkWrap: true,
                      itemCount: items.length,
                      separatorBuilder: (BuildContext _, int __) =>
                          const SizedBox(height: 6),
                      itemBuilder: (BuildContext context, int index) {
                        final ClipboardItem item = items[index];
                        final String type = _itemTypeStr(item);
                        return InkWell(
                          onTap: () => Navigator.of(dialogContext).pop(item),
                          borderRadius: AppShapesV2.brSm,
                          child: Container(
                            padding: const EdgeInsets.all(AppSpacing.sm),
                            decoration: BoxDecoration(
                              color: AppColorsV2.surfaceFor(
                                tier: SurfaceTier.high,
                                isDark: isDark,
                              ),
                              borderRadius: AppShapesV2.brSm,
                            ),
                            child: Row(
                              children: <Widget>[
                                TypeBadge(contentType: type, compact: true),
                                const SizedBox(width: AppSpacing.sm),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: <Widget>[
                                      Text(
                                        item.isText || item.isLink || item.isCode
                                            ? item.copyText
                                            : (item.fileName ?? item.contentPreview),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(fontSize: 13),
                                      ),
                                      Text(
                                        _typeLabel(l10n, item),
                                        style: TextStyle(
                                          fontSize: 11,
                                          color: Theme.of(dialogContext)
                                              .colorScheme
                                              .onSurfaceVariant,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
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
        return AlertDialog(
          shape: AppShapesV2.shapeXl,
          title: Text(l10n.expiryDate),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              _buildExpiryTile(dialogContext, _ExpiryOption.never, l10n.expiryNever),
              _buildExpiryTile(dialogContext, _ExpiryOption.oneDay, l10n.expiryOneDay),
              _buildExpiryTile(dialogContext, _ExpiryOption.oneWeek, l10n.expiryOneWeek),
              _buildExpiryTile(dialogContext, _ExpiryOption.oneMonth, l10n.expiryOneMonth),
            ],
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

  Widget _buildExpiryTile(
    BuildContext dialogContext,
    _ExpiryOption option,
    String label,
  ) {
    return ListTile(
      title: Text(label),
      shape: AppShapesV2.shapeSm,
      onTap: () => Navigator.of(dialogContext).pop(option),
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
      appBar: AppBar(
        title: Text(l10n.sharedLinks),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _creating ? null : _showCreateFlow,
        tooltip: l10n.createSharedLink,
        child: _creating
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.add_link_rounded),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    final l10n = AppLocalizations.of(context);

    if (_isLoading && _links.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const <Widget>[
          SizedBox(height: AppSpacing.xl),
          SkeletonList(itemCount: 6),
        ],
      );
    }
    if (_error != null && _links.isEmpty) {
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
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xxl),
          EmptyState(
            illustration: EmptyStateIllustration.generic,
            icon: Icons.link_rounded,
            title: l10n.noSharedLinks,
            message: l10n.noSharedLinksDesc,
            actionLabel: l10n.createSharedLink,
            onAction: _showCreateFlow,
          ),
        ],
      );
    }
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.sm,
        AppSpacing.lg,
        AppSpacing.xxl * 2,
      ),
      itemCount: _links.length,
      separatorBuilder: (BuildContext context, int index) =>
          const SizedBox(height: AppSpacing.md),
      itemBuilder: (BuildContext context, int index) =>
          _buildLinkCard(_links[index]),
    );
  }

  /// 共享链接管理卡片 (Obsidian v2)：
  /// - 展示条目摘要；
  /// - 链接访问次数；
  /// - 过期时间倒计时；
  /// - 快速复制与撤销失效按钮。
  Widget _buildLinkCard(SharedLink link) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final bool expired = link.isExpired;

    final String? preview = _displayPreview(link);
    final (String countdownText, Color countdownColor) =
        _resolveCountdown(l10n, link, isDark);

    return AppCard(
      surfaceTier: SurfaceTier.low,
      borderRadius: AppShapesV2.brMd,
      gradientLine: expired
          ? null
          : LinearGradient(
              colors: <Color>[
                isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight,
                (isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight)
                    .withValues(alpha: 0.1),
              ],
            ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Header: 类型徽标 + 标题 + 操作按钮
          Row(
            children: <Widget>[
              TypeBadge(contentType: link.contentType),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  _displayTitle(link),
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.copy_rounded, size: 18),
                tooltip: l10n.copyLink,
                onPressed: () => unawaited(_copyLink(link)),
              ),
              IconButton(
                icon: Icon(
                  Icons.link_off_rounded,
                  size: 18,
                  color: AppColorsV2.dangerColor(context),
                ),
                tooltip: l10n.revokeLink,
                onPressed: () => unawaited(_revokeLink(link)),
              ),
            ],
          ),

          // 条目摘要预览
          if (preview != null) ...<Widget>[
            const SizedBox(height: AppSpacing.sm),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.md,
                vertical: AppSpacing.sm,
              ),
              decoration: BoxDecoration(
                color: AppColorsV2.surfaceFor(
                  tier: SurfaceTier.base,
                  isDark: isDark,
                ),
                borderRadius: AppShapesV2.brSm,
                border: Border.all(
                  color: AppColorsV2.borderFor(isDark: isDark),
                  width: 0.5,
                ),
              ),
              child: Text(
                preview,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                  height: 1.4,
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],

          // 链接地址 (MonoText)
          const SizedBox(height: AppSpacing.sm),
          MonoText(
            link.url,
            style: TextStyle(
              fontSize: 11,
              color: isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),

          // 底部元数据行：访问次数 + 创建时间 + 过期时间倒计时
          const SizedBox(height: AppSpacing.md),
          Row(
            children: <Widget>[
              // 访问次数徽标
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColorsV2.surfaceFor(
                    tier: SurfaceTier.high,
                    isDark: isDark,
                  ),
                  borderRadius: AppShapesV2.brPill,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(
                      Icons.visibility_outlined,
                      size: 12,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      '${link.views}',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              // 创建时间
              Text(
                _formatCreatedAt(l10n, link),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
              const Spacer(),
              // 过期时间倒计时
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: countdownColor.withValues(alpha: 0.12),
                  borderRadius: AppShapesV2.brPill,
                  border: Border.all(
                    color: countdownColor.withValues(alpha: 0.28),
                    width: 0.8,
                  ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(
                      Icons.schedule_rounded,
                      size: 12,
                      color: countdownColor,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      countdownText,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: countdownColor,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 过期时间倒计时解析
  (String, Color) _resolveCountdown(
    AppLocalizations l10n,
    SharedLink link,
    bool isDark,
  ) {
    if (link.isExpired) {
      return (
        l10n.expiredBadge,
        isDark ? AppColorsV2.dangerDark : AppColorsV2.dangerLight,
      );
    }
    final DateTime? expiresAt = link.expiresAt;
    if (expiresAt == null) {
      return (
        l10n.neverExpires,
        isDark ? AppColorsV2.typeColorDark : AppColorsV2.typeColorLight,
      );
    }

    final Duration remaining = expiresAt.difference(DateTime.now());
    if (remaining.isNegative) {
      return (
        l10n.expiredBadge,
        isDark ? AppColorsV2.dangerDark : AppColorsV2.dangerLight,
      );
    }

    if (remaining.inHours < 1) {
      return (
        '剩余 ${remaining.inMinutes} 分钟',
        isDark ? AppColorsV2.typeImageDark : AppColorsV2.typeImageLight,
      );
    }
    if (remaining.inDays < 1) {
      return (
        '剩余 ${remaining.inHours} 小时',
        isDark ? AppColorsV2.typeImageDark : AppColorsV2.typeImageLight,
      );
    }
    if (remaining.inDays < 30) {
      return (
        '剩余 ${remaining.inDays} 天',
        isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight,
      );
    }
    return (
      l10n.expiresAt(_formatDate(l10n, expiresAt)),
      Theme.of(context).colorScheme.onSurfaceVariant,
    );
  }

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
    if (preview == link.title.trim() || preview == link.fileName) {
      return null;
    }
    return preview;
  }

  String _itemTypeStr(ClipboardItem item) {
    if (item.isFile) return 'file';
    if (item.isImage) return 'image';
    if (item.isCode) return 'code';
    if (item.isLink) return 'link';
    return 'text';
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

  String _formatDate(AppLocalizations l10n, DateTime dateTime) {
    return l10n.relDateYMD(dateTime.year, dateTime.month, dateTime.day);
  }
}
