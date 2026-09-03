import 'package:flutter/material.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/theme/tokens_v2.dart';

/// 统一类型徽章 (Obsidian v2)。
///
/// 规范要求：
/// - 统一 6 色系类型徽章 (text, link, image, file, color, code)；
/// - pill 胶囊形状 ([AppShapesV2.pill])；
/// - leading icon + 语义文字；
/// - 语义色低透明度底色 (14%) + 语义色前景色。
class TypeBadge extends StatelessWidget {
  /// 创建类型徽章。
  const TypeBadge({
    required this.contentType,
    super.key,
    this.customLabel,
    this.compact = false,
  });

  /// 内容类型：text / link / image / file / color / code 等。
  final String contentType;

  /// 自定义文本标签（为空时取 l10n 对应类型词）。
  final String? customLabel;

  /// 是否紧凑显示（仅显示图标，不显示文字）。
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final AppLocalizations l10n = AppLocalizations.of(context);

    final Color typeColor = AppColorsV2.getColorForType(contentType, isDark);
    final IconData icon = _typeIcon(contentType);
    final String label = customLabel ?? _typeLabel(contentType, l10n);

    if (compact) {
      return Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: typeColor.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(AppShapesV2.pill),
        ),
        child: Icon(icon, size: 12, color: typeColor),
      );
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: typeColor.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(AppShapesV2.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 12, color: typeColor),
          const SizedBox(width: 4),
          Text(
            label,
            style: TextStyle(
              color: typeColor,
              fontSize: 11,
              fontWeight: FontWeight.w600,
              height: 1.1,
            ),
          ),
        ],
      ),
    );
  }

  static IconData _typeIcon(String type) {
    return switch (type.toLowerCase().trim()) {
      'image' || 'img' => Icons.image_outlined,
      'link' || 'url' => Icons.link_rounded,
      'file' => Icons.insert_drive_file_outlined,
      'color' => Icons.palette_outlined,
      'code' => Icons.code_rounded,
      _ => Icons.subject_rounded,
    };
  }

  static String _typeLabel(String type, AppLocalizations l10n) {
    return switch (type.toLowerCase().trim()) {
      'text' => l10n.typeText,
      'image' || 'img' => l10n.typeImage,
      'link' || 'url' => l10n.typeLink,
      'file' => l10n.typeFile,
      'code' => l10n.typeCode,
      'color' => l10n.typeColor,
      _ => type,
    };
  }
}
