import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:receive_sharing_intent/receive_sharing_intent.dart';

import '../../l10n/app_localizations.dart';
import '../../providers/auth_provider.dart';
import '../../providers/clipboard_provider.dart';
import '../../services/api_service.dart';
import '../../services/app_exception.dart';
import '../../services/token_store.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/app_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/glass_panel.dart';
import '../../widgets/common/mono_text.dart';
import '../../widgets/common/section_divider.dart';
import '../../widgets/common/type_badge.dart';

/// 分享接收负载（T3.5）：从系统分享面板收到的文本与图片（临时文件路径）。
class SharePayload {
  final List<String> texts;
  final List<String> imagePaths;

  const SharePayload({this.texts = const <String>[], this.imagePaths = const <String>[]});

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

/// 分享接收确认页（T3.5 / Obsidian v2）。
///
/// 视觉规格：
/// - 系统分享唤起的接收页：毛玻璃浮层底栏 (GlassPanel) + 底纸质感 (SurfaceTier.low)；
/// - 预览分享的文本、链接或图片缩略图，类型徽标与等宽语义；
/// - 一键「确认入库并同步」高亮动效按钮。
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
    final l10n = AppLocalizations.of(context);
    setState(() => _uploading = true);

    var successCount = 0;
    try {
      final token = await TokenStore.getAccessToken();
      if (token == null || token.isEmpty) {
        throw const AppException(AppErrorCodes.noToken);
      }
      final deviceId = await context.read<AuthProvider>().ensureDeviceId();
      if (deviceId == null || deviceId.isEmpty) {
        throw const AppException(AppErrorCodes.deviceNotRegistered);
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
          SnackBar(
            content: Text(l10n.saveInFailed(friendlyError(e, l10n))),
            duration: const Duration(seconds: 3),
          ),
        );
      }
      return;
    }

    if (!mounted) return;
    setState(() => _uploading = false);

    if (successCount > 0) {
      unawaited(context.read<ClipboardProvider>().refresh());
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.savedInCount(successCount)),
          duration: const Duration(seconds: 2),
        ),
      );
    } else {
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.saveInFailedRetry),
          duration: const Duration(seconds: 3),
        ),
      );
    }
    Navigator.of(context).pop();
  }

  /// 文本入库：POST /api/clipboard
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

  /// 图片入库：POST /api/media/image
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
    final l10n = AppLocalizations.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.saveToClipboard),
      ),
      body: widget.payload.isEmpty
          ? EmptyState(
              illustration: EmptyStateIllustration.generic,
              icon: Icons.share_outlined,
              title: l10n.nothingToSave,
              message: l10n.saveToClipboardDesc,
            )
          : ListView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.sm,
                AppSpacing.lg,
                AppSpacing.xxl * 3,
              ),
              children: <Widget>[
                SectionDivider(
                  title: l10n.saveToClipboard,
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                ),
                for (final text in widget.payload.texts)
                  _buildTextCard(theme, text),
                if (widget.payload.imagePaths.isNotEmpty)
                  _buildImageSection(theme, widget.payload.imagePaths),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  l10n.saveToClipboardDesc,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
      bottomNavigationBar: widget.payload.isEmpty
          ? null
          : _buildBottomBar(context),
    );
  }

  Widget _buildTextCard(ThemeData theme, String text) {
    final bool isDark = theme.brightness == Brightness.dark;
    final bool isLink = RegExp(r'^https?://\S+$', caseSensitive: false).hasMatch(text.trim());

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: AppCard(
        surfaceTier: SurfaceTier.low,
        borderRadius: AppShapesV2.brMd,
        gradientLine: isLink
            ? LinearGradient(
                colors: <Color>[
                  isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight,
                  (isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight).withValues(alpha: 0.1),
                ],
              )
            : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                TypeBadge(contentType: isLink ? 'link' : 'text'),
                const Spacer(),
                Text(
                  '${utf8.encode(text).length} B',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            if (isLink)
              MonoText(
                text,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight,
                  fontSize: 13,
                  height: 1.4,
                ),
              )
            else
              Text(
                text,
                maxLines: 8,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(
                  height: 1.5,
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildImageSection(ThemeData theme, List<String> paths) {
    final l10n = AppLocalizations.of(context);
    final bool isDark = theme.brightness == Brightness.dark;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: AppCard(
        surfaceTier: SurfaceTier.low,
        borderRadius: AppShapesV2.brMd,
        gradientLine: LinearGradient(
          colors: <Color>[
            isDark ? AppColorsV2.typeImageDark : AppColorsV2.typeImageLight,
            (isDark ? AppColorsV2.typeImageDark : AppColorsV2.typeImageLight).withValues(alpha: 0.1),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                TypeBadge(
                  contentType: 'image',
                  customLabel: l10n.imageCount(paths.length),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            SizedBox(
              height: 140,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: paths.length,
                separatorBuilder: (BuildContext _, int __) =>
                    const SizedBox(width: AppSpacing.sm),
                itemBuilder: (BuildContext context, int index) => ClipRRect(
                  borderRadius: AppShapesV2.brSm,
                  child: Image.file(
                    File(paths[index]),
                    width: 140,
                    height: 140,
                    fit: BoxFit.cover,
                    errorBuilder: (BuildContext _, Object __, StackTrace? ___) => Container(
                      width: 140,
                      height: 140,
                      decoration: BoxDecoration(
                        color: AppColorsV2.surfaceFor(
                          tier: SurfaceTier.high,
                          isDark: isDark,
                        ),
                        borderRadius: AppShapesV2.brSm,
                      ),
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

  Widget _buildBottomBar(BuildContext context) {
    final l10n = AppLocalizations.of(context);

    return SafeArea(
      child: GlassPanel(
        margin: const EdgeInsets.all(AppSpacing.md),
        padding: const EdgeInsets.all(AppSpacing.sm),
        borderRadius: AppShapesV2.brLg,
        child: _SyncGlowButton(
          uploading: _uploading,
          onPressed: _uploading ? null : _saveToClipboard,
          label: _uploading ? l10n.saving : l10n.saveToClipboard,
        ),
      ),
    );
  }
}

/// 带品牌紫高光动效的提交按钮。
class _SyncGlowButton extends StatefulWidget {
  const _SyncGlowButton({
    required this.uploading,
    required this.onPressed,
    required this.label,
  });

  final bool uploading;
  final VoidCallback? onPressed;
  final String label;

  @override
  State<_SyncGlowButton> createState() => _SyncGlowButtonState();
}

class _SyncGlowButtonState extends State<_SyncGlowButton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulseController = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  )..repeat(reverse: true);

  late final Animation<double> _glowAnimation = Tween<double>(
    begin: 0.2,
    end: 0.6,
  ).animate(
    CurvedAnimation(
      parent: _pulseController,
      curve: Curves.easeInOut,
    ),
  );

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color brandColor = isDark
        ? AppColorsV2.brandPrimaryDark
        : AppColorsV2.brandPrimaryLight;

    return AnimatedBuilder(
      animation: _glowAnimation,
      builder: (BuildContext context, Widget? child) {
        return Container(
          width: double.infinity,
          height: 48,
          decoration: BoxDecoration(
            borderRadius: AppShapesV2.brMd,
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: brandColor.withValues(alpha: _glowAnimation.value),
                blurRadius: 14,
                spreadRadius: 1,
              ),
            ],
          ),
          child: child,
        );
      },
      child: FilledButton.icon(
        onPressed: widget.onPressed,
        style: FilledButton.styleFrom(
          shape: AppShapesV2.shapeMd,
          backgroundColor: AppColorsV2.brandPrimaryLight,
          foregroundColor: Colors.white,
        ),
        icon: widget.uploading
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                ),
              )
            : const Icon(Icons.cloud_upload_rounded, size: 20),
        label: Text(
          widget.label,
          style: const TextStyle(
            fontWeight: FontWeight.w600,
            fontSize: 15,
          ),
        ),
      ),
    );
  }
}
