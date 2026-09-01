import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../l10n/app_localizations.dart';
import '../models/clipboard_item.dart';
import '../providers/clipboard_provider.dart';
import '../services/server_config.dart';
import '../services/token_store.dart';
import '../theme/app_theme.dart';
import 'common/app_card.dart';
import 'favorites/collection_picker.dart';

/// 卡片左侧类型图标块 / 缩略图边长。
const double _kLeadingSize = 44;

/// 列表缩略图内存解码宽度：`GET /api/media/:id/preview` 返回约 200px 的
/// 服务端缩略图，列表场景无需更大分辨率，按此限制解码内存占用。
const int _kThumbMemCacheWidth = 200;

/// 确认对话框内容摘要最大长度（字符）。
const int _kConfirmPreviewMaxChars = 60;

/// 更多菜单动作（右上角按钮与长按共用一套菜单）。
enum _CardAction { toggleFavorite, addToCollection, pin, delete }

/// 剪贴板条目卡片（T2.4）。
///
/// 布局（[AppCard] 容器，底色/描边/圆角全部走主题与设计 token）：
///
/// ```
/// ┌────────────────────────────────────────────┐
/// │ [类型图标块]  文本 ★              [ ⋮ 更多 ] │
/// │  （四色系）   预览内容，最多 3 行省略……        │
/// │               💻 设备名           5 分钟前    │
/// └────────────────────────────────────────────┘
/// ```
///
/// 交互约定（与首页剪贴板流分工）：
/// - 单击 → [onTap] 回调（详情跳转由列表页处理，保持单一导航入口）；
/// - 长按 / 右上角更多按钮 → 同一弹出菜单：
///   收藏 toggle（[ClipboardProvider.toggleFavorite]，以服务端权威状态回写）、
///   置顶（占位「即将上线」，禁用态）、加入分组（C1，经
///   addItemToCollectionFlow 选组后加入）、删除（确认对话框后
///   [ClipboardProvider.deleteItem]，成功移出列表）。
///
/// 图片条目：经媒体端点 `GET /api/media/:id/preview`（Bearer 鉴权）显示
/// 服务端缩略图；无凭据或加载失败时回退类型图标块。
/// `cached_network_image` 为既有依赖（详情页已引入），不新增依赖。
class ClipboardCard extends StatefulWidget {
  /// 创建剪贴板条目卡片。
  ///
  /// [item] 为条目数据；[onTap] 为单击回调（null 时无按压反馈）。
  const ClipboardCard({super.key, required this.item, this.onTap});

  /// 展示的剪贴板条目。
  final ClipboardItem item;

  /// 单击回调（由列表页决定去向，卡片不持有路由依赖）。
  final VoidCallback? onTap;

  @override
  State<ClipboardCard> createState() => _ClipboardCardState();
}

class _ClipboardCardState extends State<ClipboardCard> {
  /// 更多菜单按钮引用：长按复用同一菜单（锚定到右上角按钮弹出）。
  final GlobalKey<PopupMenuButtonState<_CardAction>> _menuKey =
      GlobalKey<PopupMenuButtonState<_CardAction>>();

  /// 缩略图鉴权头（Bearer）；null = 未就绪 / 无凭据，回退图标块。
  Map<String, String>? _thumbHeaders;

  /// 是否已尝试读取凭据（条目换绑时避免重复读 token）。
  bool _thumbHeadersRequested = false;

  /// 当前条目缩略图是否加载失败（失败回退图标块并停止重试；条目变更时复位）。
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
    // 列表按索引复用 State（WS 头插 / 分页追加都会换绑条目）：
    // 条目变了必须复位缩略图失败态，否则新条目被旧失败态压成图标块。
    if (widget.item.id != oldWidget.item.id) {
      _thumbFailed = false;
      if (widget.item.isImage && !_thumbHeadersRequested) {
        _requestThumbHeaders();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);

    return Semantics(
      label: l10n.clipboardCardSemantics(_typeLabel(l10n), _previewText),
      button: true,
      child: AppCard(
        onTap: widget.onTap,
        onLongPress: _showContextMenu,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
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
  }

  /// 本地化类型标签（A3：模型不再提供中文 typeLabel，UI 层按 contentType 映射 l10n）。
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

  /// 中间内容列：类型标签 + 收藏星标 / 预览（≤3 行省略）/ 来源设备 + 相对时间。
  Widget _buildContent(ThemeData theme) {
    final ColorScheme scheme = theme.colorScheme;
    final TextTheme textTheme = theme.textTheme;
    final Color typeColor = _typeColor(theme);
    final AppLocalizations l10n = AppLocalizations.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          children: <Widget>[
            Text(
              _typeLabel(l10n),
              style: textTheme.labelSmall?.copyWith(color: typeColor, fontWeight: FontWeight.w600),
            ),
            if (widget.item.isFavorite) ...<Widget>[
              const SizedBox(width: AppSpacing.xs),
              Icon(Icons.star, size: 14, color: _warningColor(theme)),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          _previewText,
          style: textTheme.bodyMedium?.copyWith(color: scheme.onSurface),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: AppSpacing.sm),
        Row(
          children: <Widget>[
            Icon(
              _deviceIcon(widget.item.sourceDevice?.platform),
              size: 12,
              color: scheme.onSurfaceVariant,
            ),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: Text(
                widget.item.sourceDevice?.name ?? l10n.unknownDevice,
                style: textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(
              _formatRelativeTime(l10n, widget.item.createdAt),
              style: textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      ],
    );
  }

  /// 左侧块：图片条目显示服务端缩略图（无凭据 / 加载失败回退类型图标块）。
  Widget _buildLeading(ThemeData theme) {
    if (widget.item.isImage) {
      return _buildThumb(theme);
    }
    return _buildTypeBlock(theme);
  }

  /// 服务端缩略图（GET /api/media/:id/preview，Bearer 头）。
  Widget _buildThumb(ThemeData theme) {
    final Map<String, String>? headers = _thumbHeaders;
    if (headers == null || _thumbFailed) {
      return _buildTypeBlock(theme);
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(AppRadius.sm),
      child: SizedBox(
        width: _kLeadingSize,
        height: _kLeadingSize,
        child: CachedNetworkImage(
          imageUrl: '${ServerConfig.baseUrl}/api/media/${widget.item.id}/preview',
          httpHeaders: headers,
          fit: BoxFit.cover,
          memCacheWidth: _kThumbMemCacheWidth,
          fadeInDuration: AppDurations.fast,
          placeholder: (BuildContext context, String url) {
            return Container(color: theme.colorScheme.surfaceContainerHigh);
          },
          errorWidget: (BuildContext context, String url, Object error) {
            // 失败后固化回退态，避免后续重建反复重打媒体端点
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

  /// 类型图标块：四色系色码（文本=品牌紫 / 链接=成功绿 / 图片=琥珀 /
  /// 文件=tertiary / 代码=secondary），同色低透明底 + 彩色图标。
  Widget _buildTypeBlock(ThemeData theme) {
    final Color color = _typeColor(theme);
    return Container(
      width: _kLeadingSize,
      height: _kLeadingSize,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      alignment: Alignment.center,
      child: Icon(_typeIcon(widget.item.contentType), size: 22, color: color),
    );
  }

  /// 右上角更多按钮；菜单同时供长按手势复用。
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

  /// 更多菜单项：收藏 toggle / 置顶（占位禁用）/ 删除（红色危险项）。
  List<PopupMenuEntry<_CardAction>> _buildMenuItems(ThemeData theme) {
    final ColorScheme scheme = theme.colorScheme;
    final AppLocalizations l10n = AppLocalizations.of(context);
    final bool favorite = widget.item.isFavorite;

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
        enabled: false,
        child: Row(
          children: <Widget>[
            Icon(Icons.push_pin_outlined, size: 18, color: scheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.sm),
            Text(l10n.pinToTop),
            const Spacer(),
            Text(
              l10n.comingSoon,
              style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
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

  // ---------------------------------------------------------------------------
  // 交互
  // ---------------------------------------------------------------------------

  /// 长按上下文菜单：复用右上角按钮的弹出逻辑。
  void _showContextMenu() {
    _menuKey.currentState?.showButtonMenu();
  }

  /// 菜单动作分发。置顶为占位项（禁用态），正常不会回调。
  void _onMenuSelected(_CardAction action) {
    switch (action) {
      case _CardAction.toggleFavorite:
        unawaited(_toggleFavorite());
      case _CardAction.addToCollection:
        // C1：加入分组流程（拉分组 → 选择对话框 → addItem → 成功提示），
        // 实现收敛在 collection_picker.dart，本文件只做入口。
        unawaited(
          addItemToCollectionFlow(context, itemId: widget.item.id),
        );
      case _CardAction.delete:
        unawaited(_deleteWithConfirm());
      case _CardAction.pin:
        break;
    }
  }

  /// 收藏 toggle：走 Provider（以服务端返回的权威状态回写列表）。
  Future<void> _toggleFavorite() async {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final String? token = await TokenStore.getAccessToken();
    await provider.toggleFavorite(token, widget.item.id);
  }

  /// 删除（带确认对话框）：确认后走 [ClipboardProvider.deleteItem]。
  ///
  /// 以「条目是否已从列表移除」判定成败：成功提示「已删除」；
  /// 请求失败时条目仍在列表中（Provider 只在成功后移除），提示重试。
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

  /// 删除确认对话框；返回用户是否确认。
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

  // ---------------------------------------------------------------------------
  // 读取凭据（缩略图）
  // ---------------------------------------------------------------------------

  /// 读取 Bearer 凭据供缩略图请求使用（媒体端点不走 ApiService，需自带鉴权头）。
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

  // ---------------------------------------------------------------------------
  // 展示辅助
  // ---------------------------------------------------------------------------

  /// 列表预览文本：文件优先显示文件名；图片无预览/OCR 时显示占位文案。
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

  /// 确认对话框内容摘要（压平空白、限长）。
  String get _confirmPreviewText {
    final String flat = _previewText.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (flat.isEmpty) {
      return _typeLabel(AppLocalizations.of(context));
    }
    if (flat.length <= _kConfirmPreviewMaxChars) {
      return flat;
    }
    return '${flat.substring(0, _kConfirmPreviewMaxChars)}…';
  }

  /// 类型主色：语义色走 [AppColors]（亮暗分档），文件/代码走 ColorScheme 派生色。
  Color _typeColor(ThemeData theme) {
    final bool isDark = theme.brightness == Brightness.dark;
    switch (widget.item.contentType) {
      case 'link':
        return isDark ? AppColors.successDark : AppColors.success;
      case 'image':
        return isDark ? AppColors.warningDark : AppColors.warning;
      case 'file':
        return theme.colorScheme.tertiary;
      case 'code':
        return theme.colorScheme.secondary;
      default:
        return theme.colorScheme.primary;
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

  /// 来源设备平台图标。
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

  /// 警示色（收藏星标）：亮暗分档。
  Color _warningColor(ThemeData theme) =>
      theme.brightness == Brightness.dark ? AppColors.warningDark : AppColors.warning;

  /// 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / M 月 D 日。
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
