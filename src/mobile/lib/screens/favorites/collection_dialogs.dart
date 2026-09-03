import 'package:flutter/material.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/services/collections_api_service.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';

/// 收藏夹专属调色板定义（Paste Pinboard 模式：品牌紫、6 大类型色及中性强调色）。
class CollectionColorOption {
  const CollectionColorOption({
    required this.name,
    required this.lightColor,
    required this.darkColor,
    this.emoji = '📁',
  });

  final String name;
  final Color lightColor;
  final Color darkColor;
  final String emoji;

  Color resolve(bool isDark) => isDark ? darkColor : lightColor;
}

/// 预设专属色板（包含品牌紫、6 大类型色与中性/珊瑚色）。
const List<CollectionColorOption> kCollectionColorPalette = <CollectionColorOption>[
  CollectionColorOption(
    name: 'purple',
    lightColor: AppColorsV2.brandPrimaryLight,
    darkColor: AppColorsV2.brandPrimaryDark,
    emoji: '📁',
  ),
  CollectionColorOption(
    name: 'blue',
    lightColor: AppColorsV2.typeLinkLight,
    darkColor: AppColorsV2.typeLinkDark,
    emoji: '🌐',
  ),
  CollectionColorOption(
    name: 'amber',
    lightColor: AppColorsV2.typeImageLight,
    darkColor: AppColorsV2.typeImageDark,
    emoji: '⭐',
  ),
  CollectionColorOption(
    name: 'pink',
    lightColor: AppColorsV2.typeFileLight,
    darkColor: AppColorsV2.typeFileDark,
    emoji: '💼',
  ),
  CollectionColorOption(
    name: 'teal',
    lightColor: AppColorsV2.typeColorLight,
    darkColor: AppColorsV2.typeColorDark,
    emoji: '💡',
  ),
  CollectionColorOption(
    name: 'slate',
    lightColor: AppColorsV2.typeCodeLight,
    darkColor: AppColorsV2.typeCodeDark,
    emoji: '🎯',
  ),
  CollectionColorOption(
    name: 'coral',
    lightColor: Color(0xFFEF4444),
    darkColor: Color(0xFFF87171),
    emoji: '🔥',
  ),
];

/// 根据分组名称 hash 或 emoji 派生专属亮暗适配色（Paste Pinboard 模式）。
Color collectionAccentColor(CollectionGroup group, bool isDark) {
  // 若已匹配已知 palette emoji，直接采用对应色
  for (final option in kCollectionColorPalette) {
    if (option.emoji == group.icon) {
      return option.resolve(isDark);
    }
  }

  // 否则根据名称 hash 派生专属色
  final int hash = group.name.codeUnits.fold<int>(0, (prev, elem) => prev + elem);
  final option = kCollectionColorPalette[hash % kCollectionColorPalette.length];
  return option.resolve(isDark);
}

/// 分组图标圆标（Paste Pinboard 模式）：专属亮暗适配色底 + 图标/色标。
Widget collectionLeadingAvatar(
  CollectionGroup group,
  ColorScheme scheme, {
  double size = 40.0,
  bool isDark = false,
}) {
  final Color accentColor = collectionAccentColor(group, isDark);
  final bool isEmoji = group.icon.length <= 2 && group.icon != '📁';

  return Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: accentColor.withValues(alpha: isDark ? 0.20 : 0.12),
      borderRadius: BorderRadius.circular(AppShapesV2.sm),
      border: Border.all(
        color: accentColor.withValues(alpha: isDark ? 0.35 : 0.25),
        width: 1,
      ),
    ),
    alignment: Alignment.center,
    child: isEmoji
        ? Text(group.icon, style: TextStyle(fontSize: size * 0.45))
        : Container(
            width: size * 0.35,
            height: size * 0.35,
            decoration: BoxDecoration(
              color: accentColor,
              shape: BoxShape.circle,
            ),
          ),
  );
}

/// 采用 AppShapesV2.xl (28dp) 大圆角的弹层式新建分组 Sheet。
Future<String?> showCreateCollectionSheet(
  BuildContext context, {
  String? parentName,
}) async {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(AppShapesV2.xl),
      ),
    ),
    builder: (BuildContext sheetContext) => CreateCollectionSheet(
      parentName: parentName,
    ),
  );
}

/// 新建分组 BottomSheet 组件。
class CreateCollectionSheet extends StatefulWidget {
  const CreateCollectionSheet({
    super.key,
    this.parentName,
  });

  final String? parentName;

  @override
  State<CreateCollectionSheet> createState() => _CreateCollectionSheetState();
}

class _CreateCollectionSheetState extends State<CreateCollectionSheet> {
  late final TextEditingController _controller;
  String? _errorText;
  int _selectedColorIndex = 0;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty) {
      setState(() => _errorText = AppLocalizations.of(context).collectionNameRequired);
      return;
    }
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final isDark = theme.brightness == Brightness.dark;
    final hasParent = widget.parentName != null && widget.parentName!.isNotEmpty;

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.xl,
            AppSpacing.md,
            AppSpacing.xl,
            AppSpacing.xl,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: AppSpacing.lg),
                  decoration: BoxDecoration(
                    color: scheme.outlineVariant,
                    borderRadius: BorderRadius.circular(AppShapesV2.pill),
                  ),
                ),
              ),
              Row(
                children: <Widget>[
                  Text(
                    l10n.createCollection,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),
              TextField(
                controller: _controller,
                autofocus: true,
                maxLength: 100,
                decoration: InputDecoration(
                  labelText: l10n.collectionNameLabel,
                  errorText: _errorText,
                  filled: true,
                  fillColor: AppColorsV2.surface(context, tier: SurfaceTier.high),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AppShapesV2.sm),
                    borderSide: BorderSide.none,
                  ),
                ),
                onSubmitted: (String value) => _submit(),
              ),
              if (hasParent) ...<Widget>[
                const SizedBox(height: AppSpacing.xs),
                Row(
                  children: <Widget>[
                    Icon(
                      Icons.subdirectory_arrow_right_rounded,
                      size: 16,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Text(
                        l10n.createUnderParentHint(widget.parentName!),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: AppSpacing.md),
              Text(
                '专属颜色色板',
                style: theme.textTheme.labelMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              SizedBox(
                height: 42,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: kCollectionColorPalette.length,
                  separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.md),
                  itemBuilder: (context, index) {
                    final option = kCollectionColorPalette[index];
                    final color = option.resolve(isDark);
                    final isSelected = index == _selectedColorIndex;
                    return GestureDetector(
                      onTap: () => setState(() => _selectedColorIndex = index),
                      child: Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                          color: color,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: isSelected
                                ? (isDark ? Colors.white : scheme.primary)
                                : Colors.transparent,
                            width: 2.5,
                          ),
                          boxShadow: isSelected
                              ? <BoxShadow>[
                                  BoxShadow(
                                    color: color.withValues(alpha: 0.4),
                                    blurRadius: 8,
                                    spreadRadius: 1,
                                  ),
                                ]
                              : null,
                        ),
                        child: isSelected
                            ? const Icon(Icons.check, size: 18, color: Colors.white)
                            : null,
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: AppSpacing.xl),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(AppShapesV2.sm),
                    ),
                  ),
                  onPressed: _submit,
                  child: Text(l10n.create),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 兼容旧版调用签名的 CreateCollectionDialog（内部使用 M3E 28dp 大圆角卡片样式）。
class CreateCollectionDialog extends StatelessWidget {
  const CreateCollectionDialog({
    required this.controller,
    this.parentName,
    super.key,
  });

  final TextEditingController controller;
  final String? parentName;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final hasParent = parentName != null && parentName!.isNotEmpty;

    return AlertDialog(
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(AppShapesV2.xl)),
      ),
      title: Text(l10n.createCollection),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          TextField(
            controller: controller,
            autofocus: true,
            maxLength: 100,
            decoration: InputDecoration(
              labelText: l10n.collectionNameLabel,
            ),
            onSubmitted: (String value) => Navigator.of(context).pop(value.trim()),
          ),
          if (hasParent)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Row(
                children: <Widget>[
                  Icon(
                    Icons.subdirectory_arrow_right_rounded,
                    size: 16,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      l10n.createUnderParentHint(parentName!),
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: Theme.of(context).colorScheme.onSurfaceVariant,
                          ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(controller.text.trim()),
          child: Text(l10n.create),
        ),
      ],
    );
  }
}

/// 重命名/改色分组对话框（Obsidian v2 28dp 大圆角）。
class RenameCollectionDialog extends StatefulWidget {
  const RenameCollectionDialog({
    required this.initialName,
    required this.initialIcon,
    super.key,
  });

  final String initialName;
  final String initialIcon;

  @override
  State<RenameCollectionDialog> createState() => _RenameCollectionDialogState();
}

class _RenameCollectionDialogState extends State<RenameCollectionDialog> {
  static const List<String> _presetIcons = <String>[
    '📁', '⭐', '🔥', '💡', '🎯', '📌', '🚀', '🎵', '📷', '🏠', '✅', '💼',
  ];

  late final TextEditingController _controller;
  late String _selectedIcon;
  bool _iconChanged = false;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialName);
    _selectedIcon = widget.initialIcon;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty) {
      setState(() => _errorText = AppLocalizations.of(context).collectionNameRequired);
      return;
    }
    Navigator.of(context).pop((name, _iconChanged ? _selectedIcon : null));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;

    return AlertDialog(
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(AppShapesV2.xl)),
      ),
      title: Text(l10n.renameCollection),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          TextField(
            controller: _controller,
            autofocus: true,
            maxLength: 100,
            decoration: InputDecoration(
              labelText: l10n.collectionNameLabel,
              errorText: _errorText,
            ),
            onSubmitted: (String value) => _submit(),
          ),
          const SizedBox(height: AppSpacing.sm),
          SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: <Widget>[
                for (final String emoji in _presetIcons)
                  Padding(
                    padding: const EdgeInsets.only(right: AppSpacing.sm),
                    child: _buildIconOption(emoji, scheme),
                  ),
              ],
            ),
          ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(l10n.save),
        ),
      ],
    );
  }

  Widget _buildIconOption(String emoji, ColorScheme scheme) {
    final selected = emoji == _selectedIcon;
    return GestureDetector(
      onTap: () => setState(() {
        _selectedIcon = emoji;
        _iconChanged = true;
      }),
      child: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppShapesV2.sm),
          border: Border.all(
            color: selected ? scheme.primary : scheme.outlineVariant,
            width: selected ? 2 : 1,
          ),
        ),
        alignment: Alignment.center,
        child: Text(emoji, style: const TextStyle(fontSize: 20)),
      ),
    );
  }
}

/// 删除分组确认对话框（Obsidian v2 28dp 大圆角）。
Future<bool> confirmDeleteCollection(
  BuildContext context,
  CollectionGroup group,
) async {
  final l10n = AppLocalizations.of(context);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (BuildContext dialogContext) => AlertDialog(
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(AppShapesV2.xl)),
      ),
      title: Text(l10n.deleteCollection),
      content: Text(l10n.deleteCollectionConfirm(group.name)),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: Text(l10n.cancel),
        ),
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(true),
          style: TextButton.styleFrom(
            foregroundColor: Theme.of(dialogContext).colorScheme.error,
          ),
          child: Text(l10n.delete),
        ),
      ],
    ),
  );
  return confirmed == true;
}

