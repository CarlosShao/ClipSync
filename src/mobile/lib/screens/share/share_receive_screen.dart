import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:receive_sharing_intent/receive_sharing_intent.dart';

import '../../providers/auth_provider.dart';
import '../../providers/clipboard_provider.dart';
import '../../services/api_service.dart';
import '../../services/token_store.dart';
import '../../theme/app_theme.dart';

/// 分享接收负载（T3.5）：从系统分享面板收到的文本与图片（临时文件路径）。
///
/// receive_sharing_intent 在 Android 侧将文件复制到应用缓存目录，
/// [imagePaths] 为可读的临时文件绝对路径；文本直接在 `SharedMediaFile.path`。
class SharePayload {
  final List<String> texts;
  final List<String> imagePaths;

  const SharePayload({this.texts = const [], this.imagePaths = const []});

  bool get isEmpty => texts.isEmpty && imagePaths.isEmpty;

  factory SharePayload.fromSharedMedia(List<SharedMediaFile> media) {
    final texts = <String>[];
    final imagePaths = <String>[];
    for (final m in media) {
      switch (m.type) {
        case SharedMediaType.text:
        case SharedMediaType.url:
          if (m.path.trim().isNotEmpty) texts.add(m.path.trim());
          break;
        case SharedMediaType.image:
          if (m.path.trim().isNotEmpty) imagePaths.add(m.path.trim());
          break;
        case SharedMediaType.video:
        case SharedMediaType.file:
          // 暂只支持文本与图片（file/video 走桌面端/网页端上传）
          break;
      }
    }
    return SharePayload(texts: texts, imagePaths: imagePaths);
  }
}

/// 分享接收确认页（T3.5）：预览分享进来的文本/图片，
/// 「存入剪贴板」后走既有上传链路入库：
/// - 文本 → POST /api/clipboard（与桌面端 payload 对齐：明文放
///   contentEncrypted 字段，历史命名）；
/// - 图片 → POST /api/media/image（ApiService.uploadImage，multipart）。
///
/// 路由：`/share/receive`，extra 传 [SharePayload]（app_router 注册）。
class ShareReceiveScreen extends StatefulWidget {
  const ShareReceiveScreen({super.key, required this.payload});

  final SharePayload payload;

  @override
  State<ShareReceiveScreen> createState() => _ShareReceiveScreenState();
}

class _ShareReceiveScreenState extends State<ShareReceiveScreen> {
  bool _uploading = false;

  // ---------------------------------------------------------------------------
  // 上传
  // ---------------------------------------------------------------------------

  Future<void> _saveToClipboard() async {
    if (_uploading) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _uploading = true);

    var successCount = 0;
    try {
      final token = await TokenStore.getAccessToken();
      if (token == null || token.isEmpty) {
        throw Exception('未登录：缺少访问令牌');
      }
      final deviceId = await context.read<AuthProvider>().ensureDeviceId();
      if (deviceId == null || deviceId.isEmpty) {
        throw Exception('设备未注册，无法上传（请退出重登后重试）');
      }

      for (final text in widget.payload.texts) {
        final ok = await _uploadText(token, deviceId, text);
        if (ok) successCount++;
      }
      for (final path in widget.payload.imagePaths) {
        final ok = await _uploadImage(token, deviceId, path);
        if (ok) successCount++;
      }
    } catch (e) {
      if (mounted) {
        setState(() => _uploading = false);
        messenger.showSnackBar(
          SnackBar(content: Text('存入失败：$e'), duration: const Duration(seconds: 3)),
        );
      }
      return;
    }

    if (!mounted) return;
    setState(() => _uploading = false);

    // 上传成功后服务端会广播 WS new_clipboard，同时主动刷新一次列表兜底
    if (successCount > 0) {
      unawaited(context.read<ClipboardProvider>().refresh());
      messenger.showSnackBar(
        SnackBar(
          content: Text('已存入 $successCount 条剪贴板内容'),
          duration: const Duration(seconds: 2),
        ),
      );
    } else {
      messenger.showSnackBar(
        const SnackBar(content: Text('存入失败，请稍后重试'), duration: Duration(seconds: 3)),
      );
    }
    Navigator.of(context).pop();
  }

  /// 文本入库：POST /api/clipboard（对齐桌面端 clipboardUpload.ts 的 payload：
  /// contentEncrypted 为明文内容——历史命名；link 类型由 URL 形态判定）。
  Future<bool> _uploadText(String token, String deviceId, String text) async {
    final isLink = RegExp(r'^https?://\S+$', caseSensitive: false).hasMatch(text.trim());
    final response = await http
        .post(
          Uri.parse('${ApiService.baseUrl}/api/clipboard'),
          headers: <String, String>{
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
          body: jsonEncode(<String, dynamic>{
            'content': text,
            'contentEncrypted': text,
            'sourceDeviceId': deviceId,
            'contentType': isLink ? 'link' : 'text',
            'contentPreview': text.length > 5000 ? text.substring(0, 5000) : text,
            'contentSize': utf8.encode(text).length,
          }),
        )
        .timeout(const Duration(seconds: 30));
    return response.statusCode == 201 || response.statusCode == 200;
  }

  /// 图片入库：POST /api/media/image（既有 ApiService.uploadImage multipart 链路）
  Future<bool> _uploadImage(String token, String deviceId, String path) async {
    final file = File(path);
    if (!file.existsSync()) return false;
    final bytes = await file.readAsBytes();
    if (bytes.isEmpty) return false;

    final fileName = path.split(Platform.pathSeparator).last;
    final result = await ApiService().uploadImage(
      token,
      deviceId,
      imageBytes: bytes,
      filename: fileName,
      mimeType: _guessImageMime(fileName),
    );
    return result != null;
  }

  String _guessImageMime(String fileName) {
    final lower = fileName.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('存入剪贴板')),
      body: widget.payload.isEmpty
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.share_outlined, size: 48, color: theme.colorScheme.onSurfaceVariant),
                  const SizedBox(height: AppSpacing.md),
                  const Text('没有可存入的内容'),
                ],
              ),
            )
          : ListView(
              padding: const EdgeInsets.all(AppSpacing.lg),
              children: [
                for (final text in widget.payload.texts) _buildTextCard(theme, text),
                if (widget.payload.imagePaths.isNotEmpty)
                  _buildImageSection(theme, widget.payload.imagePaths),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  '内容将上传到你的 ClipSync 账号，所有已登录设备可见。',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
      bottomNavigationBar: widget.payload.isEmpty
          ? null
          : BottomAppBar(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
              child: Row(
                children: [
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _uploading ? null : _saveToClipboard,
                      icon: _uploading
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.playlist_add_rounded),
                      label: Text(_uploading ? '存入中…' : '存入剪贴板'),
                    ),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _buildTextCard(ThemeData theme, String text) {
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  text.trim().startsWith('http') ? Icons.link_rounded : Icons.notes_rounded,
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.sm),
                Text(
                  text.trim().startsWith('http') ? '链接' : '文本',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              text,
              maxLines: 8,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodyMedium,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildImageSection(ThemeData theme, List<String> paths) {
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.image_rounded, size: 16, color: theme.colorScheme.onSurfaceVariant),
                const SizedBox(width: AppSpacing.sm),
                Text(
                  '图片（${paths.length} 张）',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            SizedBox(
              height: 160,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: paths.length,
                separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.sm),
                itemBuilder: (context, index) => ClipRRect(
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  child: Image.file(
                    File(paths[index]),
                    width: 160,
                    height: 160,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => Container(
                      width: 160,
                      height: 160,
                      color: Theme.of(context).colorScheme.surfaceContainerHigh,
                      child: const Icon(Icons.broken_image_rounded),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
