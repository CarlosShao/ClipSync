import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:photo_view/photo_view.dart';
import 'package:share_plus/share_plus.dart';

import '../../l10n/app_localizations.dart';
import '../../models/clipboard_item.dart';
import '../../services/api_service.dart';
import '../../services/server_config.dart';
import '../../services/token_store.dart';
import '../../theme/app_theme.dart';

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
/// 底部操作栏：复制全量（Clipboard.setData +「已复制」提示）与收藏 toggle
/// （消费既有 ApiService.toggleFavorite）。
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

  // 文件条目降级（F4）：content 为来源设备本机路径 / 下载失败时置位，
  // 文件卡片切换为「复制文件名」+ 降级提示，不再提供跨设备下载入口。
  bool _fileDegraded = false;

  bool get _isTextLike => _item.isText || _item.isLink || _item.isCode;

  @override
  void initState() {
    super.initState();
    _item = widget.item;
    if (_item.isImage) {
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
        throw Exception('未登录：缺少访问令牌');
      }
      final response = await http
          .get(
            Uri.parse('${ServerConfig.baseUrl}/api/media/${_item.id}/download'),
            headers: <String, String>{'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 120));
      if (response.statusCode != 200) {
        throw Exception('下载失败（HTTP ${response.statusCode}）');
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
          ],
        ),
      ),
      body: _buildBody(theme),
      bottomNavigationBar: _buildBottomBar(theme),
    );
  }

  /// 本地化类型标签（模型 typeLabel 为硬编码中文，UI 层按 contentType 重映射）
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

  /// 内容区按类型分发
  Widget _buildBody(ThemeData theme) {
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
              onPressed: _copyFull,
              icon: const Icon(Icons.copy_rounded),
              label: Text(l10n.copy),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          IconButton.filledTonal(
            onPressed: _shareItem,
            tooltip: l10n.share,
            icon: const Icon(Icons.share_rounded),
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
