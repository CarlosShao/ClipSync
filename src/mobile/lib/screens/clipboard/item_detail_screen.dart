import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:photo_view/photo_view.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../l10n/app_localizations.dart';
import '../../models/clipboard_item.dart';
import '../../providers/clipboard_provider.dart';
import '../../services/api_service.dart';
import '../../services/app_exception.dart';
import '../../services/item_actions_api_service.dart';
import '../../services/server_config.dart';
import '../../services/shared_links_api_service.dart';
import '../../services/token_store.dart';
import '../../theme/app_theme.dart';
import '../../widgets/clipboard_card.dart'
    show ClipboardTagChips, ExpiryChoice, showExpiryPickerDialog, showTagsEditorDialog;

/// 文本类（text/link/code）全量内容加载状态
enum _TextLoadState { loading, loaded, error }

/// 剪贴板条目详情预览页（T2.5）。
///
/// 页面输入为 [ClipboardItem]（构造传入），按类型分发内容区：
/// - image：PhotoView 双指缩放查看（GET /api/media/:id/preview，Bearer 鉴权）；
/// - file：文件卡片（文件名取 metadata、大小格式化）+ 打开按钮
///   （调 GET /api/media/:id/download 下载到本机临时目录）；
/// - text/link/code：全文展示（code 等宽字体），SelectionArea 支持选择复制。
///
/// 受保护条目（C3，protectionLevel 非 none）：进入即锁定，不渲染任何内容，
/// 弹密码对话框经 POST /api/protection/unlock（protection.js 协议，401 =
/// 密码错误）验证；成功以返回内容填充条目并解除锁定，失败 wrongPassword
/// 提示可重试；取消后保留锁定占位与解锁入口。
///
/// 底部操作栏：复制全量（Clipboard.setData +「已复制」提示）、收藏 toggle、
/// 共享链接，以及 C3 条目动作溢出菜单（置顶 / 归档 / 编辑标签 / 过期时间，
/// 与卡片长按菜单同一动作集，走同一 [ClipboardProvider] 方法）。
/// 状态徽章（C3）：已过期 / 已归档展示在 AppBar 标题行。
///
/// 全量内容拉取：text/link/code 经 [ApiService.getItemContent]
/// （GET /api/clipboard/:id/content，token 由 TokenStore 静态解析）；
/// 加载中显示骨架，失败显示错误态 + 重试。
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

  // 图片状态：鉴权头就绪后构建 provider；errorListener 捕获加载失败
  bool _headersReady = false;
  bool _imageFailed = false;
  int _imageEpoch = 0; // 重试代数：重建 provider 强制重新拉取
  Map<String, String> _mediaHeaders = const <String, String>{};
  // 双通道：旧桌面版本把图片存成 dataURL（无 media 记录）→ MemoryImage；
  // 新版本走 media 端点 → CachedNetworkImageProvider（带鉴权头）
  ImageProvider<Object>? _imageProvider;
  bool _isInlineDataImage = false;

  // 操作栏忙碌状态
  bool _favoriteBusy = false;
  bool _downloadBusy = false;
  bool _shareLinkBusy = false;

  // 文件条目降级（F4）：content 为来源设备本机路径 / 下载失败时置位，
  // 文件卡片切换为「复制文件名」+ 降级提示，不再提供跨设备下载入口。
  bool _fileDegraded = false;

  // C3：受保护条目锁定态（解锁前不渲染内容区）
  bool _locked = false;

  bool get _isTextLike => _item.isText || _item.isLink || _item.isCode;

  @override
  void initState() {
    super.initState();
    _item = widget.item;
    if (_item.isProtected) {
      // C3：受保护条目先锁定，首帧后弹密码对话框（不预取内容，
      // 内容统一经 POST /api/protection/unlock 验证后获取）
      _locked = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          unawaited(_showUnlockDialog());
        }
      });
    } else if (_item.isImage) {
      _loadImage();
    } else if (_isTextLike) {
      _loadFullText();
    } else if (_item.isFile) {
      // F4：预取 content 探测是否为来源设备本机路径 → 直接降级，不进加载失败态
      unawaited(_probeFileContent());
    }
  }

  // ---------------------------------------------------------------------------
  // 数据加载
  // ---------------------------------------------------------------------------

  /// 拉取文本类全量内容（GET /api/clipboard/:id/content）。
  /// token 传 null，由 ApiService 内部经 TokenStore 静态解析。
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

  /// F4：预取文件条目 content 并探测是否为来源设备本机路径。
  ///
  /// 剪贴板捕获的文件条目 content 存的是来源设备本机路径（手机无该文件、
  /// 无对应 media 记录，下载端点必然失败），探测命中即直接进入降级态：
  /// 展示文件名 + 降级提示，不提供下载入口、不进加载失败态。
  /// 探测失败不致命：保留下载入口，由用户点击后按下载失败路径降级。
  Future<void> _probeFileContent() async {
    if (_fileDegraded) {
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
        // 拉取失败：保留下载入口，失败再降级
        return;
      }
    }
    if (_looksLikeLocalPath(content)) {
      if (!mounted) return;
      setState(() => _fileDegraded = true);
    }
  }

  /// 路径启发式（F4）：含 \ 或 / 且非 URL、非 data: 的文本内容视为本机路径。
  bool _looksLikeLocalPath(String? content) {
    if (content == null) {
      return false;
    }
    final trimmed = content.trim();
    if (trimmed.isEmpty) {
      return false;
    }
    final lower = trimmed.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:')) {
      return false;
    }
    return trimmed.contains('\\') || trimmed.contains('/');
  }

  /// 准备图片数据。双通道策略（对齐桌面端渲染）：
  /// ① 先取条目完整内容——`data:image` 开头 = 旧版内联 dataURL，解码为
  ///    MemoryImage（这类图片没有 media 记录，media 端点必然 404）；
  /// ② 否则走 GET /api/media/:id/preview（Bearer 鉴权网络图）。
  Future<void> _loadImage() async {
    // ① 内联 dataURL 通道
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
        // 取内容失败不致命：继续尝试 media 通道
      }
    }
    if (content != null && content.startsWith('data:image')) {
      final comma = content.indexOf(',');
      final bytes = base64Decode(content.substring(comma + 1));
      if (!mounted) return;
      setState(() {
        _headersReady = true;
        _imageFailed = false;
        _isInlineDataImage = true;
        _imageProvider = MemoryImage(bytes);
      });
      return;
    }
    // ② media 端点通道
    final token = await TokenStore.getAccessToken();
    if (!mounted) return;
    if (token == null || token.isEmpty) {
      setState(() {
        _headersReady = true;
        _imageFailed = true;
        _isInlineDataImage = false;
        _imageProvider = null;
      });
      return;
    }
    setState(() {
      _mediaHeaders = <String, String>{'Authorization': 'Bearer $token'};
      _headersReady = true;
      _imageFailed = false;
      _isInlineDataImage = false;
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

  /// 图片重试：旧 provider 清出内存缓存，换代重建触发重新拉取
  /// （磁盘缓存不缓存失败结果，新 key 必然重新请求）。
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
  // 受保护条目解锁（C3）
  // ---------------------------------------------------------------------------

  /// 密码解锁对话框：POST /api/protection/unlock（protection.js 协议），
  /// 401 = 密码错误（wrongPassword），其余失败 unlockFailed，均在对话框内
  /// 提示可重试；成功 pop(true) 并以返回内容分发加载。取消 pop(false)。
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
          builder:
              (BuildContext innerContext, void Function(VoidCallback) setDialogState) {
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
              title: Text(l10n.itemLocked),
              content: TextField(
                controller: controller,
                obscureText: true,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: l10n.passwordLabel,
                  errorText: errorText,
                ),
                onSubmitted: (_) => unawaited(submit()),
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(false),
                  child: Text(l10n.cancel),
                ),
                FilledButton(
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
      // 用户取消：保持锁定占位，可从占位按钮重新发起解锁
      setState(() {});
    }
  }

  /// 解锁成功：以返回内容回填条目并解除锁定，按类型分发加载
  /// （image 走既有双通道；text/link/code 直接展示；file 走路径探测降级）。
  Future<void> _onUnlocked(String content) async {
    if (!mounted) {
      return;
    }
    setState(() {
      _locked = false;
      _item = _item.copyWith(fullContent: content);
    });
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

  /// 受保护条目锁定占位（C3）：解锁前不渲染任何内容，仅提供解锁入口。
  Widget _buildLockedView(ThemeData theme) {
    final ColorScheme scheme = theme.colorScheme;
    final AppLocalizations l10n = AppLocalizations.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.lock_outline, size: 48, color: scheme.onSurfaceVariant),
          const SizedBox(height: AppSpacing.md),
          Text(
            l10n.itemLocked,
            style: theme.textTheme.bodyMedium
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.lg),
          FilledButton.icon(
            onPressed: () => unawaited(_showUnlockDialog()),
            icon: const Icon(Icons.lock_open),
            label: Text(l10n.unlock),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 底部操作栏动作
  // ---------------------------------------------------------------------------

  /// 复制全量：文本类复制已加载全文；图片复制 OCR 文本；文件复制文件名。
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
    await Clipboard.setData(ClipboardData(text: text));
    messenger.showSnackBar(
      SnackBar(content: Text(l10n.copied), duration: const Duration(seconds: 2)),
    );
  }

  /// 分享条目文本（T3.5）：调系统分享面板（share_plus），文本取 copyText
  /// （详情页已加载全文时优先用全文）。
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

  /// 收藏 toggle：调既有 PUT /api/clipboard/:id/favorite，以服务端返回为准。
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

  /// C3：创建共享链接——对当前条目直接调创建 API，成功后自动复制链接
  /// （文案 sharedLinkCreated「已创建并复制」），失败经 SnackBar 提示。
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

  // ---------------------------------------------------------------------------
  // 条目动作（C3：置顶 / 归档 / 过期 / 标签；与卡片长按菜单同一动作集，
  // 走同一 [ClipboardProvider] 方法，列表随 Provider 通知同步，详情自身
  // 以 _item 回写 + SnackBar 反馈）
  // ---------------------------------------------------------------------------

  /// C3 动作菜单分发。
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
    }
  }

  /// 置顶 toggle：Provider 乐观更新/重拉/回滚，详情 _item 同步回写。
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

  /// 归档/取消归档：成功后条目已离开当前视图列表，提示并返回列表页
  /// （归档提示 archivedBadge；取消归档以 unarchive 文案 + 返回作为反馈）。
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

  /// 设置过期时间：预设选择对话框 → Provider.setExpiry → 详情 _item 回写
  /// （清除过期走 withoutExpiry）→ expirySet 提示。
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

  /// 编辑标签：标签编辑对话框 → Provider.updateTags → 详情 _item 回写 →
  /// tagsSaved 提示。
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

  /// 文件下载：GET /api/media/:id/download（Bearer）→ 保存到临时目录 downloads/
  /// 并以SnackBar 告知保存路径。同名校验存在时追加序号避免覆盖。
  ///
  /// F4：任何下载失败（404 / 网络异常等）都按「文件在来源设备本机」降级——
  /// SnackBar 提示跨设备暂不可取，文件卡片切换为「复制文件名」。
  Future<void> _downloadFile() async {
    final messenger = ScaffoldMessenger.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    setState(() => _downloadBusy = true);
    try {
      final token = await TokenStore.getAccessToken();
      if (token == null || token.isEmpty) {
        throw const AppException(AppErrorCodes.noToken);
      }
      final response = await http
          .get(
            Uri.parse('${ServerConfig.baseUrl}/api/media/${_item.id}/download'),
            headers: <String, String>{'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 120));
      if (response.statusCode != 200) {
        throw AppException(AppErrorCodes.downloadFailed, 'HTTP ${response.statusCode}');
      }
      final dir = await getTemporaryDirectory();
      final saveDir = Directory('${dir.path}${Platform.pathSeparator}downloads');
      await saveDir.create(recursive: true);

      final baseName = _safeFileName();
      var target = File('${saveDir.path}${Platform.pathSeparator}$baseName');
      var seq = 1;
      while (target.existsSync()) {
        final dot = baseName.lastIndexOf('.');
        final stem = dot > 0 ? baseName.substring(0, dot) : baseName;
        final ext = dot > 0 ? baseName.substring(dot) : '';
        target = File('${saveDir.path}${Platform.pathSeparator}$stem(${seq++})$ext');
      }
      await target.writeAsBytes(response.bodyBytes);
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.fileSavedTo(target.path)),
          duration: const Duration(seconds: 3),
        ),
      );
    } catch (_) {
      if (mounted) {
        setState(() => _fileDegraded = true);
      }
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.fileLocalOnlyHint), duration: const Duration(seconds: 3)),
      );
    } finally {
      if (mounted) {
        setState(() => _downloadBusy = false);
      }
    }
  }

  /// F4：复制文件名（降级态下替代下载入口的动作）。
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

  /// 文件展示名（F4）：metadata 文件名优先；缺失时从路径型 content/预览
  /// 推导基名（含 \ 或 / 时取末段），避免把整条来源路径当文件名展示。
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

  /// 文件名净化：去掉路径分隔符与非法字符，避免写入时路径穿越。
  String _safeFileName() {
    final raw = _item.fileName ?? _item.contentPreview;
    final name = raw.isEmpty ? 'clip-file-${_item.id}' : raw;
    return name.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppLocalizations l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(_localizedTypeLabel(l10n)),
            const SizedBox(width: AppSpacing.sm),
            Text(
              _formatRelativeTime(l10n, _item.createdAt),
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            // C3 状态徽章：已过期 / 已归档
            if (_item.isExpired) ...<Widget>[
              const SizedBox(width: AppSpacing.sm),
              _buildStatusBadge(theme, l10n.expiredBadge, theme.colorScheme.error),
            ],
            if (_item.isArchived) ...<Widget>[
              const SizedBox(width: AppSpacing.sm),
              _buildStatusBadge(
                theme,
                l10n.archivedBadge,
                theme.colorScheme.onSurfaceVariant,
              ),
            ],
          ],
        ),
      ),
      body: Column(
        children: <Widget>[
          // G2 标签展示：有标签时在内容区顶部渲染 chips（横排可滚动，
          // 最多 3 个 + "+N"）；受保护条目解锁前不渲染任何内容，含标签
          if (!_locked && _item.tags.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.md,
                AppSpacing.lg,
                0,
              ),
              child: Align(
                alignment: Alignment.centerLeft,
                child: ClipboardTagChips(tags: _item.tags),
              ),
            ),
          Expanded(child: _buildBody(theme)),
        ],
      ),
      bottomNavigationBar: _buildBottomBar(theme),
    );
  }

  /// C3：状态徽章（已过期 / 已归档）：低透明底色 + 彩色小字胶囊。
  Widget _buildStatusBadge(ThemeData theme, String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.sm),
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

  /// 本地化类型标签（A3：模型不再提供中文 typeLabel，UI 层按 contentType 映射 l10n）
  String _localizedTypeLabel(AppLocalizations l10n) {
    switch (_item.contentType) {
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
        return _item.contentType;
    }
  }

  /// 内容区按类型分发；受保护条目解锁前只渲染锁定占位（C3）
  Widget _buildBody(ThemeData theme) {
    if (_locked) {
      return _buildLockedView(theme);
    }
    if (_item.isImage) {
      return _buildImageView(theme);
    }
    if (_item.isFile) {
      return _buildFileView(theme);
    }
    return _buildTextView(theme);
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
    return PhotoView(
      key: ValueKey<int>(_imageEpoch),
      imageProvider: provider,
      backgroundDecoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLowest,
      ),
      minScale: PhotoViewComputedScale.contained,
      maxScale: PhotoViewComputedScale.covered * 4,
      loadingBuilder: (BuildContext context, ImageChunkEvent? event) {
        return _buildImageSkeleton(theme);
      },
      errorBuilder: (BuildContext context, Object error, StackTrace? stackTrace) {
        // 兜底：任何未走 errorListener 的失败也切换到整页错误态（可点重试）
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && !_imageFailed) {
            setState(() => _imageFailed = true);
          }
        });
        return _buildImageSkeleton(theme);
      },
    );
  }

  Widget _buildImageSkeleton(ThemeData theme) {
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Container(
        decoration: BoxDecoration(
          color: scheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(AppRadius.lg),
        ),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: AppSpacing.md),
              Text(
                AppLocalizations.of(context).loading,
                style: theme.textTheme.labelMedium
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // --------------------------- file ---------------------------

  Widget _buildFileView(ThemeData theme) {
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final displayName = _fileDisplayName;
    final mime = _item.metadata['mimeType'];
    final mimeText = mime is String && mime.isNotEmpty ? ' · $mime' : '';

    // F4 降级态：不提供下载入口，改为「复制文件名」+ 来源设备本机提示
    final Widget actionButton = _fileDegraded
        ? FilledButton.tonalIcon(
            onPressed: _copyFileName,
            icon: const Icon(Icons.copy_rounded),
            label: Text(l10n.copyFileName),
          )
        : FilledButton.tonalIcon(
            onPressed: _downloadBusy ? null : _downloadFile,
            icon: _downloadBusy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.download_rounded),
            label: Text(_downloadBusy ? l10n.downloading : l10n.openDownload),
          );
    final String actionHint = _fileDegraded
        ? l10n.fileLocalOnlyHint
        : l10n.fileDownloadHint;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
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
                      borderRadius: BorderRadius.circular(AppRadius.md),
                    ),
                    child: Icon(
                      Icons.insert_drive_file_rounded,
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
                          style: theme.textTheme.titleMedium,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: AppSpacing.xs),
                        Text(
                          '${_formatBytes(_item.contentSize)}$mimeText',
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
              actionButton,
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
        ),
      ),
    );
  }

  // --------------------------- text / link / code ---------------------------

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
    final scheme = theme.colorScheme;
    final isCode = _item.isCode;
    final contentStyle = isCode
        ? theme.textTheme.bodyMedium?.copyWith(
            fontFamily: 'monospace',
            fontSize: 13,
            height: 1.6,
          )
        : theme.textTheme.bodyLarge;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: SelectionArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_item.isLink) ...[
              _buildLinkHint(theme),
              const SizedBox(height: AppSpacing.md),
            ],
            if (isCode)
              Card(
                color: scheme.surfaceContainerLow,
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.md),
                  child: Text(_fullText, style: contentStyle),
                ),
              )
            else
              Text(_fullText, style: contentStyle),
          ],
        ),
      ),
    );
  }

  /// 链接提示条：告知用户可经底部「复制」复制完整链接
  Widget _buildLinkHint(ThemeData theme) {
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(AppRadius.md),
      ),
      child: Row(
        children: [
          Icon(Icons.link, size: 16, color: scheme.onSecondaryContainer),
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

  /// 文本类加载骨架：若干行占位块（宽度渐变模拟正文节奏）
  Widget _buildTextSkeleton(ThemeData theme) {
    final scheme = theme.colorScheme;
    const widthFactors = <double>[0.92, 1.0, 0.78, 1.0, 0.86, 0.62];
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
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
                    borderRadius: BorderRadius.circular(AppRadius.sm),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  // --------------------------- 通用错误态 ---------------------------

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
            Icon(Icons.error_outline, size: 48, color: scheme.error),
            const SizedBox(height: AppSpacing.md),
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.lg),
            FilledButton.tonalIcon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: Text(AppLocalizations.of(context).retry),
            ),
          ],
        ),
      ),
    );
  }

  // --------------------------- 底部操作栏 ---------------------------

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
            child: FilledButton.icon(
              // C3：锁定期间不暴露内容复制
              onPressed: _locked ? null : _copyFull,
              icon: const Icon(Icons.copy_rounded),
              label: Text(l10n.copy),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          IconButton.filledTonal(
            onPressed: _locked ? null : _shareItem,
            tooltip: l10n.share,
            icon: const Icon(Icons.share_rounded),
          ),
          const SizedBox(width: AppSpacing.sm),
          // C5：创建共享链接入口（仅操作区追加，其余区域不动；锁定期间禁用）
          IconButton.filledTonal(
            onPressed: (_shareLinkBusy || _locked) ? null : _createSharedLink,
            tooltip: l10n.createSharedLink,
            icon: _shareLinkBusy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.add_link),
          ),
          const SizedBox(width: AppSpacing.sm),
          // C3：条目动作溢出菜单（置顶/归档/编辑标签/过期；底栏空间有限）
          PopupMenuButton<String>(
            tooltip: l10n.moreActions,
            icon: const Icon(Icons.more_vert),
            onSelected: _onDetailMenuSelected,
            itemBuilder: (BuildContext menuContext) => <PopupMenuEntry<String>>[
              PopupMenuItem<String>(
                value: 'pin',
                child: Row(
                  children: <Widget>[
                    Icon(
                      _item.isPinned ? Icons.push_pin : Icons.push_pin_outlined,
                      size: 18,
                      color: _item.isPinned
                          ? AppColors.warning
                          : scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.pinToTop),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'archive',
                child: Row(
                  children: <Widget>[
                    Icon(
                      _item.isArchived
                          ? Icons.unarchive_outlined
                          : Icons.archive_outlined,
                      size: 18,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(_item.isArchived ? l10n.unarchive : l10n.archive),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'expiry',
                child: Row(
                  children: <Widget>[
                    Icon(Icons.schedule_outlined,
                        size: 18, color: scheme.onSurfaceVariant),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.setExpiry),
                  ],
                ),
              ),
              PopupMenuItem<String>(
                value: 'tags',
                child: Row(
                  children: <Widget>[
                    Icon(Icons.label_outline,
                        size: 18, color: scheme.onSurfaceVariant),
                    const SizedBox(width: AppSpacing.sm),
                    Text(l10n.editTags),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(width: AppSpacing.sm),
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
                  ),
          ),
        ],
      ),
    );
  }

  // --------------------------- 格式化工具 ---------------------------

  /// 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 年月日
  String _formatRelativeTime(AppLocalizations l10n, DateTime dateTime) {
    final diff = DateTime.now().difference(dateTime);
    if (diff.inMinutes < 1) return l10n.relJustNow;
    if (diff.inHours < 1) return l10n.relMinutesAgo(diff.inMinutes);
    if (diff.inDays < 1) return l10n.relHoursAgo(diff.inHours);
    if (diff.inDays < 7) return l10n.relDaysAgo(diff.inDays);
    return l10n.relDateYMD(dateTime.year, dateTime.month, dateTime.day);
  }

  /// 字节大小格式化：B / KB / MB / GB（10 以上取整，10 以下保留一位小数）
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
