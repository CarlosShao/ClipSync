import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:photo_view/photo_view.dart';

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
  CachedNetworkImageProvider? _imageProvider;

  // 操作栏忙碌状态
  bool _favoriteBusy = false;
  bool _downloadBusy = false;

  bool get _isTextLike => _item.isText || _item.isLink || _item.isCode;

  @override
  void initState() {
    super.initState();
    _item = widget.item;
    if (_item.isImage) {
      _loadImage();
    } else if (_isTextLike) {
      _loadFullText();
    }
    // file 类型无需预备数据：下载时再取 token
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

  /// 准备图片鉴权头并构建 provider（Bearer 来自 TokenStore）。
  Future<void> _loadImage() async {
    final token = await TokenStore.getAccessToken();
    if (!mounted) return;
    if (token == null || token.isEmpty) {
      // 无可用 token：直接进入错误态（重试会重新读 token）
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
    String text;
    if (_isTextLike) {
      text = _textState == _TextLoadState.loaded ? _fullText : _item.copyText;
    } else if (_item.isImage) {
      text = _item.ocrText;
    } else {
      text = _item.fileName ?? '';
    }
    if (text.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(
          content: Text('该条目暂无文本内容'),
          duration: Duration(seconds: 2),
        ),
      );
      return;
    }
    await Clipboard.setData(ClipboardData(text: text));
    messenger.showSnackBar(
      const SnackBar(content: Text('已复制'), duration: Duration(seconds: 2)),
    );
  }

  /// 收藏 toggle：调既有 PUT /api/clipboard/:id/favorite，以服务端返回为准。
  Future<void> _toggleFavorite() async {
    final messenger = ScaffoldMessenger.of(context);
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
        const SnackBar(content: Text('收藏操作失败，请稍后重试')),
      );
    }
  }

  /// 文件下载：GET /api/media/:id/download（Bearer）→ 保存到临时目录 downloads/
  /// 并以SnackBar 告知保存路径。同名校验存在时追加序号避免覆盖。
  Future<void> _downloadFile() async {
    final messenger = ScaffoldMessenger.of(context);
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
        SnackBar(content: Text('已保存到 ${target.path}'), duration: const Duration(seconds: 3)),
      );
    } catch (_) {
      messenger.showSnackBar(
        const SnackBar(content: Text('下载失败，请稍后重试')),
      );
    } finally {
      if (mounted) {
        setState(() => _downloadBusy = false);
      }
    }
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
    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(_item.typeLabel),
            const SizedBox(width: AppSpacing.sm),
            Text(
              _formatRelativeTime(_item.createdAt),
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
      return _buildErrorView(
        theme,
        message: provider == null ? '缺少登录凭据，无法加载图片' : '图片加载失败，请检查网络后重试',
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
                '加载中…',
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
    final fileName = _item.fileName ?? _item.contentPreview;
    final displayName = fileName.isEmpty ? '未知文件' : fileName;
    final mime = _item.metadata['mimeType'];
    final mimeText = mime is String && mime.isNotEmpty ? ' · $mime' : '';

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
              FilledButton.tonalIcon(
                onPressed: _downloadBusy ? null : _downloadFile,
                icon: _downloadBusy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.download_rounded),
                label: Text(_downloadBusy ? '下载中…' : '打开（下载到本机）'),
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                '文件经服务端下载接口获取，保存到应用临时目录',
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
          message: '内容加载失败，请检查网络后重试',
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
              '链接内容 · 点击底部「复制」即可复制完整链接',
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
              label: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }

  // --------------------------- 底部操作栏 ---------------------------

  Widget _buildBottomBar(ThemeData theme) {
    final scheme = theme.colorScheme;
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
              label: const Text('复制'),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          IconButton.filledTonal(
            onPressed: _favoriteBusy ? null : _toggleFavorite,
            tooltip: _item.isFavorite ? '取消收藏' : '收藏',
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
  String _formatRelativeTime(DateTime dateTime) {
    final diff = DateTime.now().difference(dateTime);
    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inHours < 1) return '${diff.inMinutes} 分钟前';
    if (diff.inDays < 1) return '${diff.inHours} 小时前';
    if (diff.inDays < 7) return '${diff.inDays} 天前';
    return '${dateTime.year}/${dateTime.month}/${dateTime.day}';
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
