import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/models/clipboard_item.dart';
import 'package:clipsync_mobile/providers/clipboard_provider.dart';
import 'package:clipsync_mobile/router/app_router.dart';
import 'package:clipsync_mobile/services/api_service.dart';
import 'package:clipsync_mobile/services/app_exception.dart';
import 'package:clipsync_mobile/services/biometric_service.dart';
import 'package:clipsync_mobile/services/item_actions_api_service.dart';
import 'package:clipsync_mobile/services/server_config.dart';
import 'package:clipsync_mobile/services/shared_links_api_service.dart';
import 'package:clipsync_mobile/services/token_store.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/utils/file_opener.dart';
import 'package:clipsync_mobile/widgets/clipboard_card.dart'
    show ExpiryChoice, showExpiryPickerDialog, showTagsEditorDialog;
import 'package:clipsync_mobile/widgets/common/app_card.dart';
import 'package:clipsync_mobile/widgets/common/device_chip.dart';
import 'package:clipsync_mobile/widgets/common/mono_text.dart';
import 'package:clipsync_mobile/widgets/common/section_divider.dart';
import 'package:clipsync_mobile/widgets/common/sync_pulse_indicator.dart';
import 'package:clipsync_mobile/widgets/common/type_badge.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:photo_view/photo_view.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

/// 文本类（text/link/code）全量内容加载状态
enum _TextLoadState { loading, loaded, error }

/// 剪贴板条目详情与安全揭示页 (Obsidian v2 - Ticket R2.3 / 5.4)。
///
/// 核心规格与特性：
/// 1. AppBar：
///    - 返回键 + 类型专属徽章 [TypeBadge] + 来源设备 [DeviceChip] + 相对时间 + ⋮ 溢出菜单；
///    - 状态徽章：已过期 / 已归档以胶囊徽章呈现。
/// 2. 内容展示区分发（按 content_type）：
///    - image：深暗沉浸底色 PhotoView 双指/双击缩放查看，支持双通道加载与 OCR 文本预览；
///    - file：专属文件卡片 [AppCard]（大图标 + 文件名 + 体积 + 格式 + 下载/打开/分享按钮，带进度）；
///      多文件条目支持单文件操作行 + 顶部全部打包下载 (zip)；
///    - text / link：SelectionArea 包裹支持任意区域复制，附带字符/词数/行数统计；
///    - code：[MonoText] 等宽呈现，带 [SurfaceTier.high] 代码块底色容器与统计信息。
/// 3. 受保护条目安全语义（1Password Knox 模式）：
///    - 密码/安全条目默认处于遮罩态（[MonoText] 遮罩，如 ••••••••），展示锁定图标与安全语义 Accent；
///    - 点击「解锁/查看」唤起生物识别验证或密码对话框，校验成功后触发平滑揭示动画展示原文内容；
///    - 支持一键脱敏复制与 60s 倒计时自动重新加锁。
/// 4. 元数据区：
///    - 来源设备 [DeviceChip]、创建时间、修改时间、条目体积、安全级别；
///    - 标签 Chips 区域，支持快速添加与单个移除标签。
/// 5. 底部固定操作栏：
///    - 主操作：全宽「复制全文」[FilledButton]，带振动反馈与 [SyncPulseIndicator] 光晕；
///    - 辅助操作：图标行（分享、收藏切换、删除确认、共享链接）。
class ItemDetailScreen extends StatefulWidget {
  const ItemDetailScreen({super.key, required this.item});

  final ClipboardItem item;

  @override
  State<ItemDetailScreen> createState() => _ItemDetailScreenState();
}

class _ItemDetailScreenState extends State<ItemDetailScreen> {
  late ClipboardItem _item;

  // 文本类全量内容状态
  _TextLoadState _textState = _TextLoadState.loading;
  String _fullText = '';

  // 图片状态
  bool _headersReady = false;
  bool _imageFailed = false;
  int _imageEpoch = 0;
  Map<String, String> _mediaHeaders = const <String, String>{};
  ImageProvider<Object>? _imageProvider;

  // 操作栏忙碌状态
  bool _favoriteBusy = false;
  bool _shareLinkBusy = false;
  bool _pulseTrigger = false;

  // 下载忙碌与进度
  static const String _zipKey = 'zip';
  final Set<String> _downloadBusy = <String>{};
  final Map<String, double> _downloadProgress = <String, double>{};
  final Map<String, String> _downloadedPaths = <String, String>{};
  final Set<String> _degradedFileKeys = <String>{};
  bool _fileDegraded = false;

  // Knox 模式与受保护状态
  bool _locked = false;
  String? _unlockedContent;
  Timer? _autoLockTimer;
  int _autoLockSeconds = 60;

  bool get _isTextLike => _item.isText || _item.isLink || _item.isCode;

  @override
  void initState() {
    super.initState();
    _item = widget.item;
    if (_item.isProtected) {
      _locked = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          unawaited(_unlockWithBiometricsOrDialog());
        }
      });
    } else if (_item.isImage) {
      _loadImage();
    } else if (_isTextLike) {
      _loadFullText();
    } else if (_item.isFile) {
      unawaited(_probeFileContent());
    }
  }

  @override
  void dispose() {
    _autoLockTimer?.cancel();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // 数据加载
  // ---------------------------------------------------------------------------

  Future<void> _loadFullText() async {
    if (_item.hasFullContent) {
      setState(() {
        _fullText = _item.fullContent!;
        _textState = _TextLoadState.loaded;
      });
      return;
    }
    setState(() => _textState = _TextLoadState.loading);
    try {
      final String? content = await ApiService().getItemContent(null, _item.id);
      if (!mounted) return;
      setState(() {
        final resolved = (content == null || content.isEmpty)
            ? _item.contentPreview
            : content;
        _fullText = resolved;
        if (content != null && content.isNotEmpty) {
          _item = _item.copyWith(fullContent: content);
        }
        _textState = _TextLoadState.loaded;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _textState = _TextLoadState.error);
    }
  }

  Future<void> _probeFileContent() async {
    if (_fileDegraded || _item.files != null) {
      return;
    }
    String? content = _item.fullContent;
    if (content == null || content.isEmpty) {
      try {
        content = await ApiService().getItemContent(null, _item.id);
        if (!mounted) return;
        if (content != null && content.isNotEmpty) {
          _item = _item.copyWith(fullContent: content);
        }
      } catch (_) {
        return;
      }
    }
    if (_looksLikeLocalPath(content)) {
      if (!mounted) return;
      setState(() => _fileDegraded = true);
    }
  }

  bool _looksLikeLocalPath(String? content) {
    if (content == null) return false;
    final trimmed = content.trim();
    if (trimmed.isEmpty) return false;
    final lower = trimmed.toLowerCase();
    if (lower.startsWith('http://') ||
        lower.startsWith('https://') ||
        lower.startsWith('data:')) {
      return false;
    }
    return trimmed.contains('\\') || trimmed.contains('/');
  }

  Future<void> _loadImage() async {
    String? content = _item.fullContent;
    if (content == null || !content.startsWith('data:image')) {
      try {
        final fetched = await ApiService().getItemContent(null, _item.id);
        if (fetched != null && fetched.isNotEmpty) {
          content = fetched;
          if (mounted) {
            _item = _item.copyWith(fullContent: fetched);
          }
        }
      } catch (_) {
        // Fall back to media endpoint
      }
    }
    if (content != null && content.startsWith('data:image')) {
      final comma = content.indexOf(',');
      final bytes = base64Decode(content.substring(comma + 1));
      if (!mounted) return;
      setState(() {
        _headersReady = true;
        _imageFailed = false;
        _imageProvider = MemoryImage(bytes);
      });
      return;
    }

    final token = await TokenStore.getAccessToken();
    if (!mounted) return;
    if (token == null || token.isEmpty) {
      setState(() {
        _headersReady = true;
        _imageFailed = true;
        _imageProvider = null;
      });
      return;
    }
    setState(() {
      _mediaHeaders = <String, String>{'Authorization': 'Bearer $token'};
      _headersReady = true;
      _imageFailed = false;
      _imageProvider = _buildImageProvider();
    });
  }

  CachedNetworkImageProvider _buildImageProvider() {
    return CachedNetworkImageProvider(
      '${ServerConfig.baseUrl}/api/media/${_item.id}/preview',
      headers: _mediaHeaders,
      errorListener: (Object error) {
        if (mounted && !_imageFailed) {
          setState(() => _imageFailed = true);
        }
      },
    );
  }

  Future<void> _retryImage() async {
    final old = _imageProvider;
    setState(() {
      _imageEpoch++;
      _imageFailed = false;
      _imageProvider = _buildImageProvider();
    });
    if (old != null) {
      await old.evict();
    }
  }

  // ---------------------------------------------------------------------------
  // Knox 安全模式（受保护条目解锁与计时加锁）
  // ---------------------------------------------------------------------------

  void _startAutoLockTimer() {
    _autoLockTimer?.cancel();
    _autoLockSeconds = 60;
    _autoLockTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (_autoLockSeconds <= 1) {
        timer.cancel();
        _lockNow();
      } else {
        setState(() => _autoLockSeconds--);
      }
    });
  }

  void _lockNow() {
    _autoLockTimer?.cancel();
    unawaited(HapticFeedback.lightImpact());
    if (mounted) {
      setState(() {
        _locked = true;
      });
    }
  }

  Future<void> _unlockWithBiometricsOrDialog() async {
    if (_unlockedContent != null) {
      final bool canBio = await BiometricService.canAuthenticate();
      if (canBio && mounted) {
        final l10n = AppLocalizations.of(context);
        final bool authed = await BiometricService.authenticate(
          reason: l10n.biometricUnlockReason,
        );
        if (authed && mounted) {
          await _onUnlocked(_unlockedContent!);
          return;
        }
      }
    }
    if (mounted) {
      await _showUnlockDialog();
    }
  }

  Future<void> _showUnlockDialog() async {
    final AppLocalizations l10n = AppLocalizations.of(context);
    final TextEditingController controller = TextEditingController();
    final bool? unlocked = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (BuildContext dialogContext) {
        String? errorText;
        bool submitting = false;
        return StatefulBuilder(
          builder: (BuildContext innerContext, void Function(VoidCallback) setDialogState) {
            Future<void> submit() async {
              final String password = controller.text;
              if (password.isEmpty || submitting) {
                return;
              }
              setDialogState(() {
                submitting = true;
                errorText = null;
              });
              try {
                final String content = await ItemActionsApiService()
                    .unlock(null, _item.id, password);
                if (dialogContext.mounted) {
                  Navigator.of(dialogContext).pop(true);
                }
                await _onUnlocked(content);
              } on Exception catch (e) {
                setDialogState(() {
                  submitting = false;
                  errorText = friendlyError(e, l10n);
                });
              }
            }

            return AlertDialog(
              icon: const Icon(Icons.lock_rounded, color: AppColorsV2.secureAccent),
              title: Text(l10n.itemLocked),
              content: TextField(
                controller: controller,
                obscureText: true,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: l10n.passwordLabel,
                  errorText: errorText,
                  prefixIcon: const Icon(Icons.password_rounded),
                ),
                onSubmitted: (_) => unawaited(submit()),
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(false),
                  child: Text(l10n.cancel),
                ),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColorsV2.secureAccent,
                    foregroundColor: Colors.white,
                  ),
                  onPressed: submitting ? null : () => unawaited(submit()),
                  child: Text(l10n.unlock),
                ),
              ],
            );
          },
        );
      },
    );
    if (unlocked != true && mounted) {
      setState(() {});
    }
  }

  Future<void> _onUnlocked(String content) async {
    if (!mounted) return;
    await HapticFeedback.mediumImpact();
    setState(() {
      _locked = false;
      _unlockedContent = content;
      _item = _item.copyWith(fullContent: content);
    });
    _startAutoLockTimer();

    if (_item.isImage) {
      await _loadImage();
    } else if (_isTextLike) {
      setState(() {
        _fullText = content;
        _textState = _TextLoadState.loaded;
      });
    } else if (_item.isFile) {
      await _probeFileContent();
    }
  }

  Future<void> _copyMasked() async {
    final messenger = ScaffoldMessenger.of(context);
    final bool isZh = Localizations.localeOf(context).languageCode == 'zh';
    final raw = _isTextLike
        ? (_textState == _TextLoadState.loaded ? _fullText : _item.copyText)
        : _item.copyText;
    if (raw.isEmpty) {
      return;
    }
    String masked;
    if (raw.length <= 4) {
      masked = '••••';
    } else if (raw.length <= 8) {
      masked = '${raw.substring(0, 1)}••••${raw.substring(raw.length - 1)}';
    } else {
      final head = raw.substring(0, 2);
      final tail = raw.substring(raw.length - 2);
      masked = '$head••••••••$tail';
    }
    await HapticFeedback.lightImpact();
    await Clipboard.setData(ClipboardData(text: masked));
    messenger.showSnackBar(
      SnackBar(
        content: Text(isZh ? '已复制脱敏文本 ($masked)' : 'Masked text copied ($masked)'),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 底部操作栏动作
  // ---------------------------------------------------------------------------

  Future<void> _copyFull() async {
    final messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    String text;
    if (_isTextLike) {
      text = _textState == _TextLoadState.loaded ? _fullText : _item.copyText;
    } else if (_item.isImage) {
      text = _item.ocrText;
    } else {
      text = _fileDisplayName;
    }
    if (text.isEmpty) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.noTextContent),
          duration: const Duration(seconds: 2),
        ),
      );
      return;
    }
    await HapticFeedback.mediumImpact();
    setState(() => _pulseTrigger = true);
    Future.delayed(const Duration(milliseconds: 320), () {
      if (mounted) {
        setState(() => _pulseTrigger = false);
      }
    });
    await Clipboard.setData(ClipboardData(text: text));
    messenger.showSnackBar(
      SnackBar(content: Text(l10n.copied), duration: const Duration(seconds: 2)),
    );
  }

  Future<void> _shareItem() async {
    final messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final text = _isTextLike
        ? (_textState == _TextLoadState.loaded ? _fullText : _item.copyText)
        : _item.copyText;
    if (text.trim().isEmpty) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.noTextContent),
          duration: const Duration(seconds: 2),
        ),
      );
      return;
    }
    try {
      await Share.share(text.trim());
    } catch (_) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.shareFailed), duration: const Duration(seconds: 2)),
      );
    }
  }

  Future<void> _toggleFavorite() async {
    final messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    setState(() => _favoriteBusy = true);
    try {
      final result = await ApiService().toggleFavorite(null, _item.id);
      if (!mounted) return;
      final serverFavorite = result?['isFavorite'];
      setState(() {
        _item = _item.copyWith(
          isFavorite: serverFavorite is bool ? serverFavorite : !_item.isFavorite,
        );
        _favoriteBusy = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _favoriteBusy = false);
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.favoriteFailed)),
      );
    }
  }

  Future<void> _createSharedLink() async {
    final messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    setState(() => _shareLinkBusy = true);
    try {
      final link = await SharedLinksApiService()
          .createLinkFromClipboardItem(_item);
      await Clipboard.setData(ClipboardData(text: link.url));
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.sharedLinkCreated),
          duration: const Duration(seconds: 2),
        ),
      );
    } on Exception catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(friendlyError(e, l10n))),
      );
    } finally {
      if (mounted) {
        setState(() => _shareLinkBusy = false);
      }
    }
  }

  Future<bool> _confirmDelete() async {
    final l10n = AppLocalizations.of(context);
    final preview = _item.contentPreview.isNotEmpty
        ? _item.contentPreview
        : (_item.fileName ?? l10n.placeholderFile);
    final displayPreview =
        preview.length > 50 ? '${preview.substring(0, 50)}...' : preview;

    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(l10n.deleteConfirmTitle),
        content: Text(l10n.deleteConfirmMessage(displayPreview)),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.cancel),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: AppColorsV2.dangerColor(context),
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(l10n.delete),
          ),
        ],
      ),
    );
    return confirmed ?? false;
  }

  Future<void> _handleDelete() async {
    final bool confirmed = await _confirmDelete();
    if (!confirmed || !mounted) return;

    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final provider = context.read<ClipboardProvider>();

    try {
      await provider.deleteItem(null, _item.id);
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.deleted), duration: const Duration(seconds: 2)),
      );
      if (mounted) {
        Navigator.of(context).pop();
      }
    } catch (_) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.deleteFailed), duration: const Duration(seconds: 2)),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 条目动作菜单与元数据操作
  // ---------------------------------------------------------------------------

  void _onDetailMenuSelected(String action) {
    switch (action) {
      case 'pin':
        unawaited(_togglePin());
      case 'archive':
        unawaited(_toggleArchive());
      case 'expiry':
        unawaited(_setExpiryFlow());
      case 'tags':
        unawaited(_editTagsFlow());
      case 'share':
        unawaited(_shareItem());
      case 'favorite':
        unawaited(_toggleFavorite());
      case 'shared_link':
        unawaited(_createSharedLink());
      case 'delete':
        unawaited(_handleDelete());
    }
  }

  Future<void> _togglePin() async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final bool wasPinned = _item.isPinned;
    try {
      await provider.setPinned(null, _item.id, !wasPinned);
      if (!mounted) return;
      setState(() {
        _item = _item.copyWith(
          metadata: <String, dynamic>{..._item.metadata, 'pinned': !wasPinned},
        );
      });
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

  Future<void> _toggleArchive() async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final bool willArchive = !_item.isArchived;
    try {
      await provider.setArchived(null, _item.id, willArchive);
      messenger.showSnackBar(
        SnackBar(
          content: Text(willArchive ? l10n.archivedBadge : l10n.unarchive),
          duration: const Duration(seconds: 2),
        ),
      );
      if (mounted) {
        Navigator.of(context).pop();
      }
    } on Exception catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    }
  }

  Future<void> _setExpiryFlow() async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final ExpiryChoice? choice = await showExpiryPickerDialog(context);
    if (choice == null || !mounted) {
      return;
    }
    try {
      await provider.setExpiry(null, _item.id, choice.expiresAt);
      if (!mounted) return;
      setState(() {
        _item = (choice.expiresAt == null)
            ? _item.withoutExpiry()
            : _item.copyWith(expiresAt: choice.expiresAt);
      });
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

  Future<void> _editTagsFlow() async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final List<String>? tags =
        await showTagsEditorDialog(context, initialTags: _item.tags);
    if (tags == null || !mounted) {
      return;
    }
    try {
      await provider.updateTags(null, _item.id, tags);
      if (!mounted) return;
      setState(() {
        _item = _item.copyWith(
          metadata: <String, dynamic>{..._item.metadata, 'tags': tags},
        );
      });
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

  Future<void> _removeTag(String tag) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    final List<String> newTags = List<String>.from(_item.tags)..remove(tag);
    try {
      await provider.updateTags(null, _item.id, newTags);
      if (!mounted) return;
      setState(() {
        _item = _item.copyWith(
          metadata: <String, dynamic>{..._item.metadata, 'tags': newTags},
        );
      });
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

  // ---------------------------------------------------------------------------
  // 文件下载 / 打开 / 分享
  // ---------------------------------------------------------------------------

  Future<String?> _downloadByKey(
    String key, {
    required int fileIndex,
    String? zipName,
  }) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    if (_downloadBusy.contains(key)) {
      return null;
    }
    setState(() {
      _downloadBusy.add(key);
      _downloadProgress.remove(key);
    });
    try {
      final path = await _streamDownload(
        busyKey: key,
        fileIndex: fileIndex,
        fileName: fileIndex < 0 ? zipName : null,
      );
      if (mounted) {
        setState(() {
          _downloadedPaths[key] = path;
          _downloadProgress.remove(key);
        });
      }
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.fileSavedTo(path)),
          duration: const Duration(seconds: 3),
        ),
      );
      return path;
    } on Exception {
      final bool hasFiles = _item.files != null;
      if (mounted) {
        setState(() {
          _downloadProgress.remove(key);
          if (!hasFiles) {
            _fileDegraded = true;
          } else if (fileIndex >= 0) {
            _degradedFileKeys.add(key);
          }
        });
      }
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.fileLocalOnlyHint),
          duration: const Duration(seconds: 3),
        ),
      );
      return null;
    } finally {
      if (mounted) {
        setState(() => _downloadBusy.remove(key));
      }
    }
  }

  Future<String> _streamDownload({
    required String busyKey,
    required int fileIndex,
    String? fileName,
  }) async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    var url = '${ServerConfig.baseUrl}/api/media/${_item.id}/download';
    if (fileIndex >= 0) {
      url = '$url?fileIndex=$fileIndex';
    }
    final request = http.Request('GET', Uri.parse(url))
      ..headers['Authorization'] = 'Bearer $token';
    final client = http.Client();
    File? target;
    try {
      final streamed =
          await client.send(request).timeout(const Duration(seconds: 120));
      if (streamed.statusCode != 200) {
        throw AppException(
          AppErrorCodes.downloadFailed,
          'HTTP ${streamed.statusCode}',
        );
      }
      final dir = await getTemporaryDirectory();
      final saveDir =
          Directory('${dir.path}${Platform.pathSeparator}downloads');
      await saveDir.create(recursive: true);
      target = File(
        '${saveDir.path}${Platform.pathSeparator}'
        '${_uniqueSaveName(fileName ?? _fallbackDownloadName(fileIndex), saveDir)}',
      );
      final total = streamed.contentLength ?? 0;
      final sink = target.openWrite();
      var received = 0;
      try {
        await for (final chunk in streamed.stream.timeout(
          const Duration(seconds: 30),
          onTimeout: (EventSink<List<int>> stallSink) {
            stallSink.addError(TimeoutException('download body stalled'));
          },
        )) {
          received += chunk.length;
          sink.add(chunk);
          if (total > 0) {
            final next = (received / total).clamp(0.0, 1.0);
            final last = _downloadProgress[busyKey];
            if (last == null || (next - last) >= 0.01 || next >= 1.0) {
              if (mounted) {
                setState(() => _downloadProgress[busyKey] = next);
              }
            }
          }
        }
        await sink.flush();
      } finally {
        await sink.close();
      }
      return target.path;
    } catch (_) {
      try {
        if (target != null && target.existsSync()) {
          await target.delete();
        }
      } catch (_) {
        // Silently catch cleanup errors
      }
      rethrow;
    } finally {
      client.close();
    }
  }

  String _fallbackDownloadName(int fileIndex) {
    final files = _item.files;
    if (fileIndex >= 0 && files != null && fileIndex < files.length) {
      return files[fileIndex].name;
    }
    final raw = (_item.fileName ?? _item.contentPreview).trim();
    final firstLine = raw.split('\n').first.trim();
    if (firstLine.isNotEmpty) {
      return firstLine.length > 80 ? firstLine.substring(0, 80) : firstLine;
    }
    return 'clip-file-${_item.id}';
  }

  String _uniqueSaveName(String rawName, Directory saveDir) {
    var baseName = rawName.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_').trim();
    if (baseName.isEmpty) {
      baseName = 'clip-file-${_item.id}';
    }
    final dot = baseName.lastIndexOf('.');
    final stem = dot > 0 ? baseName.substring(0, dot) : baseName;
    final ext = dot > 0 ? baseName.substring(dot) : '';
    var candidate = File('${saveDir.path}${Platform.pathSeparator}$baseName');
    var seq = 1;
    while (candidate.existsSync()) {
      candidate =
          File('${saveDir.path}${Platform.pathSeparator}$stem(${seq++})$ext');
    }
    return candidate.uri.pathSegments.last;
  }

  Future<void> _downloadZip() async {
    await _downloadByKey(_zipKey, fileIndex: -1, zipName: _zipFallbackName());
  }

  String _zipFallbackName() {
    final raw = (_item.fileName ?? _item.contentPreview).trim();
    final firstLine = raw.split('\n').first.trim();
    final base = firstLine.isEmpty ? 'clip-files-${_item.id}' : firstLine;
    final dot = base.lastIndexOf('.');
    final stem = dot > 0 ? base.substring(0, dot) : base;
    return '$stem.zip';
  }

  Future<void> _openFile(
    String key, {
    required int fileIndex,
    String? zipName,
  }) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    if (_downloadBusy.contains(key)) {
      return;
    }
    var path = _downloadedPaths[key];
    if (path == null || !File(path).existsSync()) {
      path = await _downloadByKey(key, fileIndex: fileIndex, zipName: zipName);
      if (path == null) {
        return;
      }
    }
    final bool opened = await FileOpener.open(path);
    if (!mounted || opened) {
      return;
    }
    messenger.showSnackBar(
      SnackBar(
        content: Text(l10n.openFileFailed),
        duration: const Duration(seconds: 3),
      ),
    );
  }

  Future<void> _shareFile(
    String key, {
    required int fileIndex,
    String? zipName,
    String? mimeType,
  }) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    if (_downloadBusy.contains(key)) {
      return;
    }
    var path = _downloadedPaths[key];
    if (path == null || !File(path).existsSync()) {
      path = await _downloadByKey(key, fileIndex: fileIndex, zipName: zipName);
      if (path == null) {
        return;
      }
    }
    try {
      await FileOpener.share(path, mimeType: mimeType);
    } catch (_) {
      if (mounted) {
        messenger.showSnackBar(
          SnackBar(
            content: Text(l10n.shareFailed),
            duration: const Duration(seconds: 2),
          ),
        );
      }
    }
  }

  Future<void> _copyClipFileName(ClipFileInfo info) async {
    final messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    if (info.name.isEmpty) {
      return;
    }
    await Clipboard.setData(ClipboardData(text: info.name));
    messenger.showSnackBar(
      SnackBar(
        content: Text(l10n.copied),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  Future<void> _copyFileName() async {
    final messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    final name = _fileDisplayName;
    if (name.isEmpty) {
      return;
    }
    await Clipboard.setData(ClipboardData(text: name));
    messenger.showSnackBar(
      SnackBar(content: Text(l10n.copied), duration: const Duration(seconds: 2)),
    );
  }

  String get _fileDisplayName {
    final name = _item.fileName;
    if (name != null && name.isNotEmpty) {
      return name;
    }
    final raw = (_item.fullContent ?? _item.contentPreview).trim();
    if (raw.isNotEmpty) {
      final base = raw.split(RegExp(r'[\\/]')).last.trim();
      if (base.isNotEmpty) {
        return base;
      }
    }
    return AppLocalizations.of(context).unknownFile;
  }

  // ---------------------------------------------------------------------------
  // 构建主界面
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () => Navigator.of(context).pop(),
        ),
        titleSpacing: 0,
        title: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              TypeBadge(contentType: _item.contentType),
              const SizedBox(width: AppSpacing.sm),
              if (_item.sourceDevice != null || _item.sourceDeviceId != null) ...[
                DeviceChip(
                  deviceName: _item.sourceDevice?.name ??
                      _item.sourceDeviceId ??
                      l10n.unknownDevice,
                  platform: _item.sourceDevice?.platform,
                ),
                const SizedBox(width: AppSpacing.xs),
              ],
              Text(
                _formatRelativeTime(l10n, _item.createdAt),
                style: theme.textTheme.labelMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              if (_item.isExpired) ...[
                const SizedBox(width: AppSpacing.xs),
                _buildStatusBadge(theme, l10n.expiredBadge, theme.colorScheme.error),
              ],
              if (_item.isArchived) ...[
                const SizedBox(width: AppSpacing.xs),
                _buildStatusBadge(
                  theme,
                  l10n.archivedBadge,
                  theme.colorScheme.onSurfaceVariant,
                ),
              ],
            ],
          ),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.info_outline_rounded),
            tooltip: l10n.moreActions,
            onPressed: () => _showMetadataSheet(theme),
          ),
          PopupMenuButton<String>(
            tooltip: l10n.moreActions,
            icon: const Icon(Icons.more_vert_rounded),
            onSelected: _onDetailMenuSelected,
            itemBuilder: (BuildContext menuContext) => <PopupMenuEntry<String>>[
              PopupMenuItem<String>(
                value: 'share',
                child: Row(
                  children: [
                    Icon(Icons.share_rounded, size: 18, color: theme.colorScheme.onSurfaceVariant),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.share),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'favorite',
                child: Row(
                  children: [
                    Icon(
                      _item.isFavorite ? Icons.star_rounded : Icons.star_border_rounded,
                      size: 18,
                      color: _item.isFavorite ? AppColors.warning : theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(_item.isFavorite ? l10n.unfavorite : l10n.favorite),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'pin',
                child: Row(
                  children: [
                    Icon(
                      _item.isPinned ? Icons.push_pin : Icons.push_pin_outlined,
                      size: 18,
                      color: _item.isPinned ? AppColors.warning : theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.pinToTop),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'tags',
                child: Row(
                  children: [
                    Icon(Icons.label_outline, size: 18, color: theme.colorScheme.onSurfaceVariant),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.editTags),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'expiry',
                child: Row(
                  children: [
                    Icon(Icons.schedule_outlined, size: 18, color: theme.colorScheme.onSurfaceVariant),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.setExpiry),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'archive',
                child: Row(
                  children: [
                    Icon(
                      _item.isArchived ? Icons.unarchive_outlined : Icons.archive_outlined,
                      size: 18,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(_item.isArchived ? l10n.unarchive : l10n.archive),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'shared_link',
                child: Row(
                  children: [
                    Icon(Icons.add_link_rounded, size: 18, color: theme.colorScheme.onSurfaceVariant),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.createSharedLink),
                  ],
                ),
              ),
              const PopupMenuDivider(),
              PopupMenuItem<String>(
                value: 'delete',
                child: Row(
                  children: [
                    Icon(Icons.delete_outline_rounded, size: 18, color: AppColorsV2.dangerColor(context)),
                    const SizedBox(width: AppSpacing.sm),
                    Text(
                      l10n.delete,
                      style: TextStyle(color: AppColorsV2.dangerColor(context)),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          if (!_locked && _item.limitReason != null) _buildLimitBanner(theme),
          Expanded(
            child: AnimatedSwitcher(
              duration: AppMotionV2.slow,
              switchInCurve: AppMotionV2.decelerateE,
              switchOutCurve: AppMotionV2.accelerateE,
              child: _locked
                  ? _buildKnoxLockedView(theme)
                  : _buildUnlockedView(theme),
            ),
          ),
        ],
      ),
      bottomNavigationBar: _buildBottomBar(theme),
    );
  }

  Widget _buildStatusBadge(ThemeData theme, String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppShapesV2.xs),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(
          color: color,
          fontSize: 10,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Knox 安全锁定态
  // ---------------------------------------------------------------------------

  Widget _buildKnoxLockedView(ThemeData theme) {
    final l10n = AppLocalizations.of(context);
    final bool isZh = Localizations.localeOf(context).languageCode == 'zh';
    return Center(
      key: const ValueKey<String>('locked-view'),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 76,
              height: 76,
              decoration: BoxDecoration(
                color: AppColorsV2.secureAccent.withValues(alpha: 0.12),
                shape: BoxShape.circle,
                border: Border.all(
                  color: AppColorsV2.secureAccent.withValues(alpha: 0.25),
                  width: 2,
                ),
              ),
              child: const Icon(
                Icons.lock_rounded,
                size: 38,
                color: AppColorsV2.secureAccent,
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              l10n.itemLocked,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              isZh
                  ? '此条目已启用 1Password Knox 级加密保护'
                  : 'Protected by 1Password Knox security',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.xl),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.lg,
                vertical: AppSpacing.md,
              ),
              decoration: BoxDecoration(
                color: AppColorsV2.surface(context, tier: SurfaceTier.high),
                borderRadius: BorderRadius.circular(AppShapesV2.sm),
                border: Border.all(
                  color: AppColorsV2.secureAccent.withValues(alpha: 0.3),
                ),
              ),
              child: const MonoText(
                '••••••••••••••••',
                isMasked: true,
                style: TextStyle(
                  fontSize: 18,
                  letterSpacing: 4,
                  color: AppColorsV2.secureAccent,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.xl),
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: AppColorsV2.secureAccent,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.xl,
                  vertical: AppSpacing.md,
                ),
              ),
              onPressed: _unlockWithBiometricsOrDialog,
              icon: const Icon(Icons.lock_open_rounded, size: 20),
              label: Text(l10n.unlock),
            ),
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 解锁后内容视图分发
  // ---------------------------------------------------------------------------

  Widget _buildUnlockedView(ThemeData theme) {
    if (_item.isImage) {
      return Column(
        key: const ValueKey<String>('image-view'),
        children: [
          if (_item.isProtected) _buildKnoxUnlockedBanner(theme),
          Expanded(child: _buildImageView(theme)),
        ],
      );
    }

    return SingleChildScrollView(
      key: const ValueKey<String>('unlocked-scroll-view'),
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_item.isProtected) ...[
            _buildKnoxUnlockedBanner(theme),
            const SizedBox(height: AppSpacing.md),
          ],
          if (_item.isFile)
            _buildFileView(theme)
          else if (_item.isCode)
            _buildCodeView(theme)
          else
            _buildTextView(theme),
          const SizedBox(height: AppSpacing.xl),
          _buildMetadataSection(theme),
        ],
      ),
    );
  }

  Widget _buildKnoxUnlockedBanner(ThemeData theme) {
    final bool isZh = Localizations.localeOf(context).languageCode == 'zh';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
      decoration: BoxDecoration(
        color: AppColorsV2.secureAccent.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
        border: Border.all(
          color: AppColorsV2.secureAccent.withValues(alpha: 0.3),
        ),
      ),
      child: Row(
        children: [
          const Icon(Icons.shield_rounded, size: 20, color: AppColorsV2.secureAccent),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isZh ? 'Knox 安全揭示模式' : 'Knox Safe Reveal Mode',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: AppColorsV2.secureAccent,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  isZh
                      ? '已解锁 · ${_autoLockSeconds}s 后自动重锁'
                      : 'Unlocked · auto-locks in ${_autoLockSeconds}s',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          TextButton.icon(
            style: TextButton.styleFrom(
              foregroundColor: AppColorsV2.secureAccent,
              visualDensity: VisualDensity.compact,
            ),
            onPressed: _copyMasked,
            icon: const Icon(Icons.visibility_off_outlined, size: 16),
            label: Text(isZh ? '脱敏复制' : 'Masked Copy'),
          ),
          const SizedBox(width: 4),
          FilledButton.tonalIcon(
            style: FilledButton.styleFrom(
              visualDensity: VisualDensity.compact,
              backgroundColor: AppColorsV2.secureAccent.withValues(alpha: 0.2),
              foregroundColor: AppColorsV2.secureAccent,
            ),
            onPressed: _lockNow,
            icon: const Icon(Icons.lock_rounded, size: 14),
            label: Text(isZh ? '重新加锁' : 'Lock Now'),
          ),
        ],
      ),
    );
  }

  // --------------------------- image ---------------------------

  Widget _buildImageView(ThemeData theme) {
    if (!_headersReady) {
      return _buildImageSkeleton(theme);
    }
    final provider = _imageProvider;
    if (_imageFailed || provider == null) {
      final l10n = AppLocalizations.of(context);
      return _buildErrorView(
        theme,
        message: provider == null ? l10n.imageNoCredentials : l10n.imageLoadFailed,
        onRetry: provider == null ? _loadImage : _retryImage,
      );
    }
    return Container(
      color: const Color(0xFF0D0D11),
      child: PhotoView(
        key: ValueKey<int>(_imageEpoch),
        imageProvider: provider,
        backgroundDecoration: const BoxDecoration(
          color: Color(0xFF0D0D11),
        ),
        minScale: PhotoViewComputedScale.contained,
        maxScale: PhotoViewComputedScale.covered * 4,
        loadingBuilder: (BuildContext context, ImageChunkEvent? event) {
          return _buildImageSkeleton(theme);
        },
        errorBuilder: (BuildContext context, Object error, StackTrace? stackTrace) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted && !_imageFailed) {
              setState(() => _imageFailed = true);
            }
          });
          return _buildImageSkeleton(theme);
        },
      ),
    );
  }

  Widget _buildImageSkeleton(ThemeData theme) {
    final scheme = theme.colorScheme;
    return Container(
      color: const Color(0xFF0D0D11),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: AppSpacing.md),
            Text(
              AppLocalizations.of(context).loading,
              style: theme.textTheme.labelMedium?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // --------------------------- file ---------------------------

  Widget _buildFileView(ThemeData theme) {
    final files = _item.files;
    if (files != null && _item.totalCount > 1) {
      return _buildFileListView(theme, files);
    }
    return _buildSingleFileCard(theme, files);
  }

  Widget _buildFileListView(ThemeData theme, List<ClipFileInfo> files) {
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final totalBytes =
        _item.totalSize > 0 ? _item.totalSize : _sumFileSizes(files);
    return AppCard(
      surfaceTier: SurfaceTier.low,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${l10n.filesCount(files.length)} · ${_formatBytes(totalBytes)}',
                  style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              _buildZipDownloadControl(theme),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          const Divider(),
          for (var i = 0; i < files.length; i++)
            _buildFileRow(theme, files[i], i),
          const SizedBox(height: AppSpacing.xs),
          Text(
            l10n.fileDownloadHint,
            textAlign: TextAlign.center,
            style: theme.textTheme.labelSmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildZipDownloadControl(ThemeData theme) {
    final l10n = AppLocalizations.of(context);
    final scheme = theme.colorScheme;
    if (_downloadBusy.contains(_zipKey)) {
      final progress = _downloadProgress[_zipKey];
      final percent = progress == null ? null : (progress * 100).round();
      return SizedBox(
        width: 128,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            LinearProgressIndicator(value: progress),
            const SizedBox(height: 4),
            Text(
              percent != null
                  ? l10n.downloadingPercent(percent)
                  : l10n.downloading,
              textAlign: TextAlign.center,
              style: theme.textTheme.labelSmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }
    return FilledButton.tonalIcon(
      onPressed: () => unawaited(_downloadZip()),
      icon: const Icon(Icons.folder_zip_outlined, size: 18),
      label: Text(l10n.downloadAllZip),
    );
  }

  Widget _buildFileRow(ThemeData theme, ClipFileInfo info, int index) {
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final key = 'file:$index';
    final busy = _downloadBusy.contains(key);
    final progress = _downloadProgress[key];
    final degraded = _degradedFileKeys.contains(key);
    final displayName = info.name.isNotEmpty ? info.name : l10n.unknownFile;
    final mimeText = (info.mimeType != null && info.mimeType!.isNotEmpty)
        ? ' · ${info.mimeType}'
        : '';

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: scheme.primaryContainer,
                  borderRadius: BorderRadius.circular(AppShapesV2.sm),
                ),
                child: Icon(
                  _iconForFile(info),
                  size: 22,
                  color: scheme.onPrimaryContainer,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      displayName,
                      style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w500),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      '${_formatBytes(info.size)}$mimeText',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          if (busy)
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                LinearProgressIndicator(value: progress),
                const SizedBox(height: 4),
                Text(
                  progress == null
                      ? l10n.downloading
                      : l10n.downloadingPercent((progress * 100).round()),
                  textAlign: TextAlign.end,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            )
          else if (degraded)
            Row(
              children: [
                Icon(Icons.error_outline, size: 16, color: scheme.error),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    l10n.fileLocalOnlyHint,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
                TextButton.icon(
                  onPressed: () => unawaited(_copyClipFileName(info)),
                  icon: const Icon(Icons.copy_rounded, size: 16),
                  label: Text(l10n.copyFileName),
                ),
              ],
            )
          else
            Row(
              children: [
                FilledButton.tonalIcon(
                  onPressed: () => unawaited(_downloadByKey(key, fileIndex: index)),
                  icon: const Icon(Icons.download_rounded, size: 18),
                  label: Text(l10n.download),
                ),
                const SizedBox(width: AppSpacing.sm),
                OutlinedButton.icon(
                  onPressed: () => unawaited(_openFile(key, fileIndex: index)),
                  icon: const Icon(Icons.open_in_new_rounded, size: 18),
                  label: Text(l10n.open),
                ),
                const SizedBox(width: AppSpacing.sm),
                IconButton.outlined(
                  tooltip: l10n.share,
                  onPressed: () => unawaited(
                    _shareFile(key, fileIndex: index, mimeType: info.mimeType),
                  ),
                  icon: const Icon(Icons.share_rounded, size: 18),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _buildSingleFileCard(ThemeData theme, List<ClipFileInfo>? files) {
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final ClipFileInfo? first =
        (files != null && files.isNotEmpty) ? files.first : null;
    final displayName = (first != null && first.name.isNotEmpty)
        ? first.name
        : _fileDisplayName;
    final String? mime;
    if (first != null) {
      mime = first.mimeType;
    } else {
      final dynamic legacyMime = _item.metadata['mimeType'];
      mime = legacyMime is String && legacyMime.isNotEmpty ? legacyMime : null;
    }
    final mimeText = (mime != null && mime.isNotEmpty) ? ' · $mime' : '';
    final sizeBytes =
        (first != null && first.size > 0) ? first.size : _item.contentSize;

    final fileIndex = files != null ? 0 : -1;
    final fileKey = 'file:$fileIndex';
    final busy = _downloadBusy.contains(fileKey);
    final progress = _downloadProgress[fileKey];

    final Widget actionArea;
    if (_fileDegraded) {
      actionArea = FilledButton.tonalIcon(
        onPressed: _copyFileName,
        icon: const Icon(Icons.copy_rounded),
        label: Text(l10n.copyFileName),
      );
    } else if (busy) {
      final percent = progress == null ? null : (progress * 100).round();
      actionArea = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          LinearProgressIndicator(value: progress),
          const SizedBox(height: 6),
          Text(
            percent != null
                ? l10n.downloadingPercent(percent)
                : l10n.downloading,
            textAlign: TextAlign.center,
            style: theme.textTheme.labelSmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
        ],
      );
    } else {
      actionArea = Row(
        children: [
          Expanded(
            child: FilledButton.tonalIcon(
              onPressed: () =>
                  unawaited(_downloadByKey(fileKey, fileIndex: fileIndex)),
              icon: const Icon(Icons.download_rounded, size: 18),
              label: Text(l10n.download),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: FilledButton.icon(
              onPressed: () =>
                  unawaited(_openFile(fileKey, fileIndex: fileIndex)),
              icon: const Icon(Icons.open_in_new_rounded, size: 18),
              label: Text(l10n.open),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          IconButton.filledTonal(
            tooltip: l10n.share,
            onPressed: () => unawaited(
              _shareFile(fileKey, fileIndex: fileIndex, mimeType: first?.mimeType),
            ),
            icon: const Icon(Icons.share_rounded),
          ),
        ],
      );
    }
    final String actionHint =
        _fileDegraded ? l10n.fileLocalOnlyHint : l10n.fileDownloadHint;

    return AppCard(
      surfaceTier: SurfaceTier.low,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: scheme.primaryContainer,
                  borderRadius: BorderRadius.circular(AppShapesV2.md),
                ),
                child: Icon(
                  first != null
                      ? _iconForFile(first)
                      : Icons.insert_drive_file_rounded,
                  size: 28,
                  color: scheme.onPrimaryContainer,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      displayName,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      '${_formatBytes(sizeBytes)}$mimeText',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          actionArea,
          const SizedBox(height: AppSpacing.sm),
          Text(
            actionHint,
            textAlign: TextAlign.center,
            style: theme.textTheme.labelSmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }

  IconData _iconForFile(ClipFileInfo info) {
    final mime = (info.mimeType ?? '').toLowerCase();
    final name = info.name.toLowerCase();
    if (mime.startsWith('image/') ||
        RegExp(r'\.(png|jpe?g|gif|webp|bmp)$').hasMatch(name)) {
      return Icons.image_outlined;
    }
    if (mime.startsWith('video/') ||
        RegExp(r'\.(mp4|mov|avi|mkv|webm)$').hasMatch(name)) {
      return Icons.movie_outlined;
    }
    if (mime.startsWith('audio/') ||
        RegExp(r'\.(mp3|wav|flac|aac|ogg|m4a)$').hasMatch(name)) {
      return Icons.music_note_outlined;
    }
    if (mime == 'application/pdf' || name.endsWith('.pdf')) {
      return Icons.picture_as_pdf_outlined;
    }
    if (mime.contains('zip') ||
        RegExp(r'\.(zip|rar|7z|tar|gz)$').hasMatch(name)) {
      return Icons.folder_zip_outlined;
    }
    return Icons.insert_drive_file_rounded;
  }

  int _sumFileSizes(List<ClipFileInfo> files) {
    var sum = 0;
    for (final f in files) {
      sum += f.size;
    }
    return sum;
  }

  // --------------------------- text / link ---------------------------

  Widget _buildTextView(ThemeData theme) {
    switch (_textState) {
      case _TextLoadState.loading:
        return _buildTextSkeleton(theme);
      case _TextLoadState.error:
        return _buildErrorView(
          theme,
          message: AppLocalizations.of(context).contentLoadFailed,
          onRetry: _loadFullText,
        );
      case _TextLoadState.loaded:
        return _buildLoadedTextView(theme);
    }
  }

  Widget _buildLoadedTextView(ThemeData theme) {
    final bool isZh = Localizations.localeOf(context).languageCode == 'zh';
    return SelectionArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_item.isLink) ...[
            _buildLinkHint(theme),
            const SizedBox(height: AppSpacing.md),
          ],
          _buildTextStatistics(_fullText, theme, isZh),
          const SizedBox(height: AppSpacing.md),
          AppCard(
            surfaceTier: SurfaceTier.low,
            child: Text(
              _fullText,
              style: theme.textTheme.bodyLarge?.copyWith(height: 1.6),
            ),
          ),
        ],
      ),
    );
  }

  // --------------------------- code ---------------------------

  Widget _buildCodeView(ThemeData theme) {
    final bool isDark = theme.brightness == Brightness.dark;
    final bool isZh = Localizations.localeOf(context).languageCode == 'zh';

    switch (_textState) {
      case _TextLoadState.loading:
        return _buildTextSkeleton(theme);
      case _TextLoadState.error:
        return _buildErrorView(
          theme,
          message: AppLocalizations.of(context).contentLoadFailed,
          onRetry: _loadFullText,
        );
      case _TextLoadState.loaded:
        return SelectionArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _buildTextStatistics(_fullText, theme, isZh),
              const SizedBox(height: AppSpacing.sm),
              AppCard(
                surfaceTier: SurfaceTier.high,
                padding: const EdgeInsets.all(AppSpacing.md),
                child: MonoText(
                  _fullText,
                  style: TextStyle(
                    fontSize: 13,
                    height: 1.6,
                    color: isDark ? Colors.white.withValues(alpha: 0.9) : Colors.black87,
                  ),
                ),
              ),
            ],
          ),
        );
    }
  }

  Widget _buildTextStatistics(String text, ThemeData theme, bool isZh) {
    final charCount = text.length;
    final wordCount = text.trim().isEmpty
        ? 0
        : text.trim().split(RegExp(r'\s+')).length;
    final lineCount = text.isEmpty ? 0 : text.split('\n').length;

    final String charLabel = isZh ? '$charCount 字符' : '$charCount chars';
    final String wordLabel = isZh ? '$wordCount 词' : '$wordCount words';
    final String lineLabel = isZh ? '$lineCount 行' : '$lineCount lines';

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: AppColorsV2.surface(context, tier: SurfaceTier.high),
        borderRadius: BorderRadius.circular(AppShapesV2.xs),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.analytics_outlined,
            size: 14,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: 6),
          Text(
            '$charLabel · $wordLabel · $lineLabel',
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildLinkHint(ThemeData theme) {
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
      ),
      child: Row(
        children: [
          Icon(Icons.link_rounded, size: 18, color: scheme.onSecondaryContainer),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              AppLocalizations.of(context).linkHint,
              style: theme.textTheme.labelMedium?.copyWith(
                color: scheme.onSecondaryContainer,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTextSkeleton(ThemeData theme) {
    final scheme = theme.colorScheme;
    const widthFactors = <double>[0.92, 1.0, 0.78, 1.0, 0.86, 0.62];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final factor in widthFactors)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            child: FractionallySizedBox(
              alignment: Alignment.centerLeft,
              widthFactor: factor,
              child: Container(
                height: 14,
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(AppShapesV2.xs),
                ),
              ),
            ),
          ),
      ],
    );
  }

  // --------------------------- 元数据展示区 ---------------------------

  Widget _buildMetadataSection(ThemeData theme) {
    final l10n = AppLocalizations.of(context);
    final bool isZh = Localizations.localeOf(context).languageCode == 'zh';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionDivider(title: isZh ? '条目元数据' : 'Metadata'),
        const SizedBox(height: AppSpacing.xs),
        AppCard(
          surfaceTier: SurfaceTier.low,
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            children: [
              if (_item.sourceDevice != null || _item.sourceDeviceId != null) ...[
                _buildMetadataRow(
                  theme,
                  icon: Icons.devices_rounded,
                  label: isZh ? '来源设备' : 'Source Device',
                  trailing: DeviceChip(
                    deviceName: _item.sourceDevice?.name ??
                        _item.sourceDeviceId ??
                        l10n.unknownDevice,
                    platform: _item.sourceDevice?.platform,
                  ),
                ),
                const Divider(height: AppSpacing.md),
              ],
              _buildMetadataRow(
                theme,
                icon: Icons.calendar_today_outlined,
                label: isZh ? '创建时间' : 'Created At',
                trailingText: _formatDateTime(_item.createdAt),
              ),
              if (_item.updatedAt != null) ...[
                const Divider(height: AppSpacing.md),
                _buildMetadataRow(
                  theme,
                  icon: Icons.update_outlined,
                  label: isZh ? '更新时间' : 'Updated At',
                  trailingText: _formatDateTime(_item.updatedAt!),
                ),
              ],
              const Divider(height: AppSpacing.md),
              _buildMetadataRow(
                theme,
                icon: Icons.data_usage_rounded,
                label: isZh ? '条目体积' : 'Content Size',
                trailingText: _formatBytes(_item.contentSize),
              ),
              if (_item.isProtected) ...[
                const Divider(height: AppSpacing.md),
                _buildMetadataRow(
                  theme,
                  icon: Icons.security_rounded,
                  label: isZh ? '安全保护' : 'Protection',
                  trailingText: _item.protectionLevel,
                ),
              ],
              const Divider(height: AppSpacing.md),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.label_outline_rounded,
                    size: 16,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Text(
                    isZh ? '标签' : 'Tags',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      alignment: WrapAlignment.end,
                      children: [
                        for (final tag in _item.tags)
                          InputChip(
                            label: Text(tag),
                            labelStyle: theme.textTheme.labelSmall,
                            visualDensity: VisualDensity.compact,
                            padding: EdgeInsets.zero,
                            onDeleted: () => _removeTag(tag),
                          ),
                        ActionChip(
                          avatar: const Icon(Icons.add_rounded, size: 14),
                          label: Text(isZh ? '添加' : 'Add'),
                          labelStyle: theme.textTheme.labelSmall,
                          visualDensity: VisualDensity.compact,
                          padding: EdgeInsets.zero,
                          onPressed: _editTagsFlow,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildMetadataRow(
    ThemeData theme, {
    required IconData icon,
    required String label,
    String? trailingText,
    Widget? trailing,
  }) {
    return Row(
      children: [
        Icon(icon, size: 16, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(width: AppSpacing.sm),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const Spacer(),
        if (trailing != null)
          trailing
        else if (trailingText != null)
          Text(
            trailingText,
            style: theme.textTheme.bodySmall?.copyWith(
              fontWeight: FontWeight.w500,
            ),
          ),
      ],
    );
  }

  void _showMetadataSheet(ThemeData theme) {
    final bool isZh = Localizations.localeOf(context).languageCode == 'zh';
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (BuildContext sheetContext) {
        return DraggableScrollableSheet(
          initialChildSize: 0.6,
          minChildSize: 0.35,
          maxChildSize: 0.9,
          expand: false,
          builder: (BuildContext _, ScrollController scrollController) {
            return SingleChildScrollView(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.xl),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_item.ocrText.isNotEmpty) ...[
                    SectionDivider(title: isZh ? 'OCR 识别文本' : 'OCR Text'),
                    const SizedBox(height: AppSpacing.xs),
                    AppCard(
                      surfaceTier: SurfaceTier.high,
                      padding: const EdgeInsets.all(AppSpacing.md),
                      child: SelectionArea(
                        child: Text(
                          _item.ocrText,
                          style: theme.textTheme.bodyMedium,
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.md),
                  ],
                  _buildMetadataSection(theme),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildLimitBanner(ThemeData theme) {
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.md,
        AppSpacing.lg,
        0,
      ),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: scheme.errorContainer.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
      ),
      child: Row(
        children: [
          Icon(Icons.cloud_off_rounded, size: 18, color: scheme.error),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              l10n.limitSyncNotice,
              style: theme.textTheme.labelMedium?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          TextButton(
            onPressed: () =>
                unawaited(context.push(AppRoutes.subscriptionManagement)),
            child: Text(l10n.viewPlans),
          ),
        ],
      ),
    );
  }

  Widget _buildErrorView(
    ThemeData theme, {
    required String message,
    required VoidCallback onRetry,
  }) {
    final scheme = theme.colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline_rounded, size: 48, color: scheme.error),
            const SizedBox(height: AppSpacing.md),
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            FilledButton.tonalIcon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh_rounded),
              label: Text(AppLocalizations.of(context).retry),
            ),
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 底部操作栏
  // ---------------------------------------------------------------------------

  Widget _buildBottomBar(ThemeData theme) {
    final scheme = theme.colorScheme;
    final AppLocalizations l10n = AppLocalizations.of(context);
    return BottomAppBar(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.sm,
      ),
      child: Row(
        children: [
          Expanded(
            child: SyncPulseIndicator(
              trigger: _pulseTrigger,
              child: FilledButton.icon(
                onPressed: _locked ? null : _copyFull,
                icon: const Icon(Icons.copy_rounded, size: 18),
                label: Text(l10n.copy),
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          IconButton.filledTonal(
            onPressed: _locked ? null : _shareItem,
            tooltip: l10n.share,
            icon: const Icon(Icons.share_rounded, size: 18),
          ),
          const SizedBox(width: AppSpacing.xs),
          IconButton.filledTonal(
            onPressed: _favoriteBusy ? null : _toggleFavorite,
            tooltip: _item.isFavorite ? l10n.unfavorite : l10n.favorite,
            color: _item.isFavorite ? AppColors.warning : scheme.onSurfaceVariant,
            icon: _favoriteBusy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Icon(
                    _item.isFavorite
                        ? Icons.star_rounded
                        : Icons.star_border_rounded,
                    size: 18,
                  ),
          ),
          const SizedBox(width: AppSpacing.xs),
          IconButton.filledTonal(
            onPressed: (_shareLinkBusy || _locked) ? null : _createSharedLink,
            tooltip: l10n.createSharedLink,
            icon: _shareLinkBusy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.add_link_rounded, size: 18),
          ),
          const SizedBox(width: AppSpacing.xs),
          IconButton.filledTonal(
            onPressed: _handleDelete,
            tooltip: l10n.delete,
            style: IconButton.styleFrom(
              foregroundColor: AppColorsV2.dangerColor(context),
            ),
            icon: const Icon(Icons.delete_outline_rounded, size: 18),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 格式化辅助
  // ---------------------------------------------------------------------------

  String _formatRelativeTime(AppLocalizations l10n, DateTime dateTime) {
    final diff = DateTime.now().difference(dateTime);
    if (diff.inMinutes < 1) return l10n.relJustNow;
    if (diff.inHours < 1) return l10n.relMinutesAgo(diff.inMinutes);
    if (diff.inDays < 1) return l10n.relHoursAgo(diff.inHours);
    if (diff.inDays < 7) return l10n.relDaysAgo(diff.inDays);
    return l10n.relDateYMD(dateTime.year, dateTime.month, dateTime.day);
  }

  String _formatDateTime(DateTime dt) {
    final local = dt.toLocal();
    final y = local.year.toString().padLeft(4, '0');
    final m = local.month.toString().padLeft(2, '0');
    final d = local.day.toString().padLeft(2, '0');
    final h = local.hour.toString().padLeft(2, '0');
    final min = local.minute.toString().padLeft(2, '0');
    final s = local.second.toString().padLeft(2, '0');
    return '$y-$m-$d $h:$min:$s';
  }

  String _formatBytes(int bytes) {
    if (bytes <= 0) return '0 B';
    if (bytes < 1024) return '$bytes B';
    final kb = bytes / 1024;
    if (kb < 1024) {
      return '${kb.toStringAsFixed(kb < 10 ? 1 : 0)} KB';
    }
    final mb = kb / 1024;
    if (mb < 1024) {
      return '${mb.toStringAsFixed(mb < 10 ? 1 : 0)} MB';
    }
    final gb = mb / 1024;
    return '${gb.toStringAsFixed(2)} GB';
  }
}
