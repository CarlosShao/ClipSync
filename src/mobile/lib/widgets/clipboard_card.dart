import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/models/clipboard_item.dart';
import 'package:clipsync_mobile/providers/clipboard_provider.dart';
import 'package:clipsync_mobile/services/app_exception.dart';
import 'package:clipsync_mobile/services/server_config.dart';
import 'package:clipsync_mobile/services/token_store.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/widgets/common/app_card.dart';
import 'package:clipsync_mobile/widgets/common/device_chip.dart';
import 'package:clipsync_mobile/widgets/common/mono_text.dart';
import 'package:clipsync_mobile/widgets/common/swipe_action_row.dart';
import 'package:clipsync_mobile/widgets/common/type_badge.dart';
import 'package:clipsync_mobile/widgets/favorites/collection_picker.dart';

/// 卡片左侧类型图标块 / 缩略图边长。
const double _kLeadingSize = 44.0;

/// 列表缩略图内存解码宽度。
const int _kThumbMemCacheWidth = 200;

/// 确认对话框内容摘要最大长度（字符）。
const int _kConfirmPreviewMaxChars = 60;

/// 更多菜单动作。
enum _CardAction { toggleFavorite, pin, setExpiry, archive, editTags, addToCollection, delete }

/// 剪贴板条目卡片 v2 (Obsidian)。
///
/// 遵循 Obsidian v2 / 5.2 规范：
/// - leading 44dp：类型专属预览形态
///   - text → 2 行文本预览或类型图标
///   - link → 链接图标或富链接预览
///   - image → 44dp 缩略图（cached_network_image，圆角 sm）
///   - file → 类型图标 + 文件名
///   - code → MonoText 等宽文本预览
/// - title 行：类型徽章 TypeBadge + 来源设备 DeviceChip + 状态点 + 相对时间
/// - subtitle：内容预览 2-3 行省略（代码/密码走 MonoText 语义）
/// - swipe：可选内建 [SwipeActionRow]（右滑收藏/左滑删除）或供外部包装
/// - 复制与长按菜单回调，保持与现有调用方（clipboard_screen）参数无缝兼容。
class ClipboardCard extends StatefulWidget {
  /// 创建剪贴板条目卡片。
  const ClipboardCard({
    required this.item,
    super.key,
    this.onTap,
    this.onCopy,
    this.enableSwipe = true,
  });

  /// 展示的剪贴板条目。
  final ClipboardItem item;

  /// 单击回调（由列表页决定去向）。
  final VoidCallback? onTap;

  /// 快捷复制回调。
  final VoidCallback? onCopy;

  /// 是否启用内建 SwipeActionRow（默认 true）。
  final bool enableSwipe;

  @override
  State<ClipboardCard> createState() => _ClipboardCardState();
}

class _ClipboardCardState extends State<ClipboardCard> {
  final GlobalKey<PopupMenuButtonState<_CardAction>> _menuKey =
      GlobalKey<PopupMenuButtonState<_CardAction>>();

  Map<String, String>? _thumbHeaders;
  bool _thumbHeadersRequested = false;
  bool _thumbFailed = false;

  @override
  void initState() {
    super.initState();
    if (widget.item.isImage) {
      _requestThumbHeaders();
    }
  }

  @override
  void didUpdateWidget(ClipboardCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.item.id != oldWidget.item.id) {
      _thumbFailed = false;
      if (widget.item.isImage && !_thumbHeadersRequested) {
        _requestThumbHeaders();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);

    final Widget card = Semantics(
      label: l10n.clipboardCardSemantics(_typeLabel(l10n), _previewText),
      button: true,
      child: AppCard(
        onTap: widget.onTap,
        onLongPress: _showContextMenu,
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.md,
        ),
        surfaceTier: SurfaceTier.low,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _buildLeading(theme),
            const SizedBox(width: AppSpacing.md),
            Expanded(child: _buildContent(theme)),
            const SizedBox(width: AppSpacing.xs),
            _buildMoreButton(theme),
          ],
        ),
      ),
    );

    if (!widget.enableSwipe) {
      return card;
    }

    return SwipeActionRow(
      onSwipeRight: () => unawaited(_toggleFavorite()),
      onSwipeLeft: () => unawaited(_deleteWithConfirm()),
      child: card,
    );
  }

  String _typeLabel(AppLocalizations l10n) {
    switch (widget.item.contentType) {
      case 'text':
        return l10n.typeText;
      case 'image':
        return l10n.typeImage;
      case 'link':
        return l10n.typeLink;
      case 'file':
        return l10n.typeFile;
      case 'code':
        return l10n.typeCode;
      default:
        return widget.item.contentType;
    }
  }

  /// 中间内容列：TypeBadge + DeviceChip + 相对时间 / 预览内容 / 标签
  Widget _buildContent(ThemeData theme) {
    final ColorScheme scheme = theme.colorScheme;
    final TextTheme textTheme = theme.textTheme;
    final AppLocalizations l10n = AppLocalizations.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: AppSpacing.xs,
          runSpacing: 2,
          children: <Widget>[
            TypeBadge(contentType: widget.item.contentType),
            if (widget.item.sourceDevice?.name != null)
              DeviceChip(
                deviceName: widget.item.sourceDevice!.name!,
                platform: widget.item.sourceDevice?.platform,
              ),
            if (widget.item.isFavorite)
              Icon(Icons.star_rounded, size: 14, color: _warningColor(theme)),
            if (widget.item.isPinned)
              Icon(Icons.push_pin_rounded, size: 12, color: _warningColor(theme)),
            if (widget.item.isExpired)
              _buildBadge(l10n.expiredBadge, scheme.error),
            if (widget.item.isArchived)
              _buildBadge(l10n.archivedBadge, scheme.onSurfaceVariant),
            Text(
              _formatRelativeTime(l10n, widget.item.createdAt),
              style: textTheme.labelSmall?.copyWith(
                color: scheme.onSurfaceVariant,
                fontSize: 11,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.xs),
        _buildPreviewWidget(theme),
        if (widget.item.tags.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.sm),
          ClipboardTagChips(tags: widget.item.tags),
        ],
      ],
    );
  }

  Widget _buildPreviewWidget(ThemeData theme) {
    final ColorScheme scheme = theme.colorScheme;
    final TextTheme textTheme = theme.textTheme;

    if (widget.item.isProtected) {
      return MonoText(
        widget.item.contentPreview,
        isMasked: true,
        style: textTheme.bodyMedium?.copyWith(
          color: AppColorsV2.secureAccent,
          letterSpacing: 2.0,
        ),
        maxLines: 2,
      );
    }

    if (widget.item.isCode) {
      return MonoText(
        _previewText,
        style: textTheme.bodyMedium?.copyWith(
          color: scheme.onSurface,
          fontSize: 13,
        ),
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
      );
    }

    return Text(
      _previewText,
      style: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurface,
        height: 1.3,
      ),
      maxLines: 3,
      overflow: TextOverflow.ellipsis,
    );
  }

  /// 左侧 44dp 类型专属预览形态
  Widget _buildLeading(ThemeData theme) {
    if (widget.item.isImage) {
      return _buildThumb(theme);
    }
    return _buildTypeBlock(theme);
  }

  Widget _buildThumb(ThemeData theme) {
    final Map<String, String>? headers = _thumbHeaders;
    if (headers == null || _thumbFailed) {
      return _buildTypeBlock(theme);
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(AppShapesV2.sm),
      child: SizedBox(
        width: _kLeadingSize,
        height: _kLeadingSize,
        child: CachedNetworkImage(
          imageUrl: '${ServerConfig.baseUrl}/api/media/${widget.item.id}/preview',
          httpHeaders: headers,
          fit: BoxFit.cover,
          memCacheWidth: _kThumbMemCacheWidth,
          fadeInDuration: AppMotionV2.fast,
          placeholder: (BuildContext context, String url) {
            return Container(color: theme.colorScheme.surfaceContainerHigh);
          },
          errorWidget: (BuildContext context, String url, Object error) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted && !_thumbFailed) {
                setState(() => _thumbFailed = true);
              }
            });
            return _buildTypeBlock(theme);
          },
        ),
      ),
    );
  }

  Widget _buildTypeBlock(ThemeData theme) {
    final bool isDark = theme.brightness == Brightness.dark;
    final Color color = AppColorsV2.getColorForType(widget.item.contentType, isDark);

    return Container(
      width: _kLeadingSize,
      height: _kLeadingSize,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
      ),
      alignment: Alignment.center,
      child: Icon(_typeIcon(widget.item.contentType), size: 22, color: color),
    );
  }

  Widget _buildMoreButton(ThemeData theme) {
    return PopupMenuButton<_CardAction>(
      key: _menuKey,
      tooltip: AppLocalizations.of(context).moreActions,
      icon: Icon(Icons.more_vert, size: 20, color: theme.colorScheme.onSurfaceVariant),
      constraints: const BoxConstraints(minWidth: 200),
      onSelected: _onMenuSelected,
      itemBuilder: (BuildContext context) => _buildMenuItems(theme),
    );
  }

  List<PopupMenuEntry<_CardAction>> _buildMenuItems(ThemeData theme) {
    final ColorScheme scheme = theme.colorScheme;
    final AppLocalizations l10n = AppLocalizations.of(context);
    final bool favorite = widget.item.isFavorite;
    final bool pinned = widget.item.isPinned;
    final bool archived = widget.item.isArchived;

    return <PopupMenuEntry<_CardAction>>[
      PopupMenuItem<_CardAction>(
        value: _CardAction.toggleFavorite,
        child: Row(
          children: <Widget>[
            Icon(
              favorite ? Icons.star_border : Icons.star,
              size: 18,
              color: favorite ? scheme.onSurfaceVariant : _warningColor(theme),
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(favorite ? l10n.unfavorite : l10n.favorite),
          ],
        ),
      ),
      PopupMenuItem<_CardAction>(
        value: _CardAction.pin,
        child: Row(
          children: <Widget>[
            Icon(
              pinned ? Icons.push_pin : Icons.push_pin_outlined,
              size: 18,
              color: pinned ? _warningColor(theme) : scheme.onSurfaceVariant,
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(l10n.pinToTop),
          ],
        ),
      ),
      PopupMenuItem<_CardAction>(
        value: _CardAction.setExpiry,
        child: Row(
          children: <Widget>[
            Icon(Icons.schedule_outlined, size: 18, color: scheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.sm),
            Text(l10n.setExpiry),
          ],
        ),
      ),
      PopupMenuItem<_CardAction>(
        value: _CardAction.archive,
        child: Row(
          children: <Widget>[
            Icon(
              archived ? Icons.unarchive_outlined : Icons.archive_outlined,
              size: 18,
              color: scheme.onSurfaceVariant,
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(archived ? l10n.unarchive : l10n.archive),
          ],
        ),
      ),
      PopupMenuItem<_CardAction>(
        value: _CardAction.editTags,
        child: Row(
          children: <Widget>[
            Icon(Icons.label_outline, size: 18, color: scheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.sm),
            Text(l10n.editTags),
          ],
        ),
      ),
      PopupMenuItem<_CardAction>(
        value: _CardAction.addToCollection,
        child: Row(
          children: <Widget>[
            Icon(Icons.drive_file_move_outlined, size: 18, color: scheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.sm),
            Text(l10n.addToCollection),
          ],
        ),
      ),
      const PopupMenuDivider(),
      PopupMenuItem<_CardAction>(
        value: _CardAction.delete,
        child: Row(
          children: <Widget>[
            Icon(Icons.delete_outline, size: 18, color: scheme.error),
            const SizedBox(width: AppSpacing.sm),
            Text(l10n.delete, style: TextStyle(color: scheme.error)),
          ],
        ),
      ),
    ];
  }

  void _showContextMenu() {
    _menuKey.currentState?.showButtonMenu();
  }

  void _onMenuSelected(_CardAction action) {
    switch (action) {
      case _CardAction.toggleFavorite:
        unawaited(_toggleFavorite());
      case _CardAction.pin:
        unawaited(_togglePin());
      case _CardAction.setExpiry:
        unawaited(_setExpiryFlow());
      case _CardAction.archive:
        unawaited(_toggleArchive());
      case _CardAction.editTags:
        unawaited(_editTagsFlow());
      case _CardAction.addToCollection:
        unawaited(
          addItemToCollectionFlow(context, itemId: widget.item.id),
        );
      case _CardAction.delete:
        unawaited(_deleteWithConfirm());
    }
  }

  Future<void> _toggleFavorite() async {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final String? token = await TokenStore.getAccessToken();
    await provider.toggleFavorite(token, widget.item.id);
  }

  Future<void> _togglePin() async {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final bool wasPinned = widget.item.isPinned;
    final String? token = await TokenStore.getAccessToken();
    try {
      await provider.setPinned(token, widget.item.id, !wasPinned);
      messenger.showSnackBar(
        SnackBar(
          content: Text(wasPinned ? l10n.unpinSuccess : l10n.pinSuccess),
          duration: const Duration(seconds: 2),
        ),
      );
    } on Exception catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    }
  }

  Future<void> _setExpiryFlow() async {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final ExpiryChoice? choice = await showExpiryPickerDialog(context);
    if (choice == null || !mounted) {
      return;
    }
    final String? token = await TokenStore.getAccessToken();
    try {
      await provider.setExpiry(token, widget.item.id, choice.expiresAt);
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.expirySet),
          duration: const Duration(seconds: 2),
        ),
      );
    } on Exception catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    }
  }

  Future<void> _toggleArchive() async {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final bool willArchive = !widget.item.isArchived;
    final String? token = await TokenStore.getAccessToken();
    try {
      await provider.setArchived(token, widget.item.id, willArchive);
      if (willArchive) {
        messenger.showSnackBar(
          SnackBar(
            content: Text(l10n.archivedBadge),
            duration: const Duration(seconds: 2),
          ),
        );
      }
    } on Exception catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    }
  }

  Future<void> _editTagsFlow() async {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final List<String>? tags =
        await showTagsEditorDialog(context, initialTags: widget.item.tags);
    if (tags == null || !mounted) {
      return;
    }
    final String? token = await TokenStore.getAccessToken();
    try {
      await provider.updateTags(token, widget.item.id, tags);
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.tagsSaved),
          duration: const Duration(seconds: 2),
        ),
      );
    } on Exception catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    }
  }

  Future<void> _deleteWithConfirm() async {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final bool confirmed = await _confirmDelete();
    if (!confirmed || !mounted) {
      return;
    }
    final String? token = await TokenStore.getAccessToken();
    await provider.deleteItem(token, widget.item.id);
    final bool removed = !provider.items.any((ClipboardItem e) => e.id == widget.item.id);
    messenger.showSnackBar(
      SnackBar(
        content: Text(removed ? l10n.deleted : l10n.deleteFailed),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  Future<bool> _confirmDelete() async {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final AppLocalizations l10n = AppLocalizations.of(context);
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(l10n.deleteConfirmTitle),
        content: Text(l10n.deleteConfirmMessage(_confirmPreviewText)),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.cancel),
          ),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: scheme.error),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(l10n.delete),
          ),
        ],
      ),
    );
    return confirmed ?? false;
  }

  Future<void> _requestThumbHeaders() async {
    _thumbHeadersRequested = true;
    final String? token = await TokenStore.getAccessToken();
    if (!mounted) {
      return;
    }
    setState(() {
      _thumbHeaders =
          (token == null || token.isEmpty)
              ? null
              : <String, String>{'Authorization': 'Bearer $token'};
    });
  }

  String get _previewText {
    final ClipboardItem item = widget.item;
    final AppLocalizations l10n = AppLocalizations.of(context);
    if (item.isFile) {
      return item.fileName ?? l10n.placeholderFile;
    }
    final String preview = item.contentPreview.trim();
    if (preview.isEmpty) {
      return item.isImage ? l10n.placeholderImage : l10n.placeholderEmpty;
    }
    return preview;
  }

  String get _confirmPreviewText {
    final String flat = _previewText.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (flat.isEmpty) {
      return _typeLabel(AppLocalizations.of(context));
    }
    if (flat.length <= _kConfirmPreviewMaxChars) {
      return flat;
    }
    return '…';
  }

  IconData _typeIcon(String contentType) {
    return switch (contentType.toLowerCase().trim()) {
      'image' => Icons.image_outlined,
      'link' => Icons.link_rounded,
      'file' => Icons.insert_drive_file_outlined,
      'code' => Icons.code_rounded,
      _ => Icons.subject_rounded,
    };
  }

  Color _warningColor(ThemeData theme) =>
      theme.brightness == Brightness.dark ? AppColors.warningDark : AppColors.warning;

  Widget _buildBadge(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: color,
              fontSize: 10,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }

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
}

/// 标签直显上限：超出部分折叠为「+N」。
const int _kMaxVisibleTags = 3;

/// 单个标签 chip 的最大宽度。
const double _kTagChipMaxWidth = 140.0;

/// 条目标签 chips。
class ClipboardTagChips extends StatelessWidget {
  const ClipboardTagChips({super.key, required this.tags});

  final List<String> tags;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme scheme = theme.colorScheme;
    final TextStyle style = theme.textTheme.labelSmall?.copyWith(
          color: scheme.onSecondaryContainer,
          fontSize: 11,
          fontWeight: FontWeight.w500,
        ) ??
        TextStyle(color: scheme.onSecondaryContainer, fontSize: 11);
    final int hiddenCount = tags.length - _kMaxVisibleTags;

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final String tag in tags.take(_kMaxVisibleTags))
            Padding(
              padding: const EdgeInsets.only(right: AppSpacing.xs),
              child: _buildChip(theme, tag, style),
            ),
          if (hiddenCount > 0)
            Padding(
              padding: const EdgeInsets.only(right: AppSpacing.xs),
              child: _buildChip(theme, '+', style),
            ),
        ],
      ),
    );
  }

  Widget _buildChip(ThemeData theme, String label, TextStyle style) {
    final ColorScheme scheme = theme.colorScheme;
    return Container(
      alignment: Alignment.center,
      constraints: const BoxConstraints(maxWidth: _kTagChipMaxWidth),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
      ),
      child: Text(
        label,
        style: style,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

/// 过期时间选择结果。
class ExpiryChoice {
  const ExpiryChoice(this.expiresAt);
  final DateTime? expiresAt;
}

/// 过期时间预设选择对话框。
Future<ExpiryChoice?> showExpiryPickerDialog(BuildContext context) {
  final AppLocalizations l10n = AppLocalizations.of(context);
  final DateTime now = DateTime.now();
  return showDialog<ExpiryChoice>(
    context: context,
    builder: (BuildContext dialogContext) => SimpleDialog(
      title: Text(l10n.setExpiry),
      children: <Widget>[
        SimpleDialogOption(
          onPressed: () =>
              Navigator.of(dialogContext).pop(const ExpiryChoice(null)),
          child: Text(l10n.expiryNever),
        ),
        SimpleDialogOption(
          onPressed: () => Navigator.of(dialogContext).pop(
            ExpiryChoice(now.add(const Duration(hours: 1))),
          ),
          child: Text(l10n.expiryOneHour),
        ),
        SimpleDialogOption(
          onPressed: () => Navigator.of(dialogContext).pop(
            ExpiryChoice(now.add(const Duration(hours: 24))),
          ),
          child: Text(l10n.expiryOneDay),
        ),
        SimpleDialogOption(
          onPressed: () => Navigator.of(dialogContext).pop(
            ExpiryChoice(now.add(const Duration(hours: 168))),
          ),
          child: Text(l10n.expiryOneWeek),
        ),
        SimpleDialogOption(
          onPressed: () => Navigator.of(dialogContext).pop(
            ExpiryChoice(now.add(const Duration(hours: 720))),
          ),
          child: Text(l10n.expiryOneMonth),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                child: Text(l10n.cancel),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

/// 标签编辑对话框。
Future<List<String>?> showTagsEditorDialog(
  BuildContext context, {
  required List<String> initialTags,
}) {
  final AppLocalizations l10n = AppLocalizations.of(context);
  final TextEditingController controller =
      TextEditingController(text: initialTags.join(', '));
  return showDialog<List<String>>(
    context: context,
    builder: (BuildContext dialogContext) => AlertDialog(
      title: Text(l10n.editTags),
      content: TextField(
        controller: controller,
        autofocus: true,
        maxLines: 3,
        minLines: 1,
        decoration: InputDecoration(hintText: l10n.tagsHint),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: Text(l10n.cancel),
        ),
        TextButton(
          onPressed: () =>
              Navigator.of(dialogContext).pop(parseTagInput(controller.text)),
          child: Text(l10n.save),
        ),
      ],
    ),
  );
}

/// 解析标签输入。
List<String> parseTagInput(String raw) {
  final List<String> tags = <String>[];
  for (final String part in raw.split(RegExp(r'[,，\n]'))) {
    final String tag = part.trim();
    if (tag.isEmpty || tags.contains(tag)) {
      continue;
    }
    tags.add(tag);
  }
  return tags;
}
