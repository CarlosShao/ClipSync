import 'package:flutter/material.dart';

import 'package:clipsync_mobile/models/clipboard_item.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/widgets/common/glass_panel.dart';
import 'package:clipsync_mobile/widgets/common/type_badge.dart';

/// 底部快速粘贴 Dock 容器 (Obsidian v2 / Gboard 模式)。
///
/// 规范要求：
/// - 底部横滑 Chips（3-5 个最近条目）；
/// - 外层包裹 [GlassPanel] 毛玻璃浮层效果；
/// - 点击条目直接调用 [onPasteItem] 触发复制/回写；
/// - 单击右侧操作按钮可触发 [onOpenMore]（如展开更多或打开剪贴板）。
class QuickPasteDock extends StatelessWidget {
  /// 创建快速粘贴 Dock。
  const QuickPasteDock({
    required this.items,
    required this.onPasteItem,
    super.key,
    this.onOpenMore,
    this.maxItems = 5,
    this.margin = const EdgeInsets.fromLTRB(
      AppSpacing.md,
      0,
      AppSpacing.md,
      AppSpacing.md,
    ),
  });

  /// 最近剪贴板条目列表。
  final List<ClipboardItem> items;

  /// 点击复制回调。
  final ValueChanged<ClipboardItem> onPasteItem;

  /// 展开或更多回调。
  final VoidCallback? onOpenMore;

  /// 最多展示条目数，默认 5。
  final int maxItems;

  /// 外边距。
  final EdgeInsetsGeometry margin;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return const SizedBox.shrink();
    }

    final ThemeData theme = Theme.of(context);
    final List<ClipboardItem> displayItems = items.take(maxItems).toList();

    return GlassPanel(
      margin: margin,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: AppSpacing.xs,
      ),
      borderRadius: BorderRadius.circular(AppShapesV2.pill),
      child: Row(
        children: <Widget>[
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: displayItems.map((ClipboardItem item) {
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 3),
                    child: _buildItemChip(theme, item),
                  );
                }).toList(),
              ),
            ),
          ),
          if (onOpenMore != null) ...<Widget>[
            Container(
              width: 1,
              height: 20,
              margin: const EdgeInsets.symmetric(horizontal: 4),
              color: theme.colorScheme.outlineVariant,
            ),
            IconButton(
              icon: const Icon(Icons.keyboard_arrow_up_rounded, size: 20),
              visualDensity: VisualDensity.compact,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
              onPressed: onOpenMore,
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildItemChip(ThemeData theme, ClipboardItem item) {
    final bool isDark = theme.brightness == Brightness.dark;
    final String preview = item.contentPreview.trim().replaceAll(RegExp(r'\s+'), ' ');
    final String label = preview.isEmpty
        ? (item.fileName ?? item.contentType)
        : preview;

    return Material(
      color: isDark
          ? AppColorsV2.surfaceHighDark.withValues(alpha: 0.6)
          : AppColorsV2.surfaceHighLight,
      borderRadius: BorderRadius.circular(AppShapesV2.pill),
      child: InkWell(
        onTap: () => onPasteItem(item),
        borderRadius: BorderRadius.circular(AppShapesV2.pill),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 4, 10, 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              TypeBadge(contentType: item.contentType, compact: true),
              const SizedBox(width: 6),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 140),
                child: Text(
                  label,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
