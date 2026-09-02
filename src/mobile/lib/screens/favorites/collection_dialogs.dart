import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../services/collections_api_service.dart';
import '../../theme/app_theme.dart';

/// 收藏夹分组管理共享对话框（FavoritesScreen 与 CollectionItemsScreen 复用）：
/// - [CreateCollectionDialog]：新建分组（可选父分组位置提示，树形层级导航）；
/// - [RenameCollectionDialog]：重命名分组（可选改图标 emoji）；
/// - [confirmDeleteCollection]：删除分组确认（说明子分组会被级联删除）。

/// 新建分组对话框：输入名称，空名称给出错误提示，回车或「创建」提交。
///
/// [parentName] 非空时在输入框下方显示创建位置提示（「将创建到 XX 下」），
/// 用于子分组页（树形层级导航）明确新建分组的挂载父级；null = 顶层新建。
class CreateCollectionDialog extends StatefulWidget {
  const CreateCollectionDialog({
    required this.controller,
    this.parentName,
    super.key,
  });

  final TextEditingController controller;

  /// 父分组名称（仅用于位置提示文案；实际 parentId 由调用方在提交时携带）
  final String? parentName;

  @override
  State<CreateCollectionDialog> createState() => _CreateCollectionDialogState();
}

class _CreateCollectionDialogState extends State<CreateCollectionDialog> {
  String? _errorText;

  void _submit() {
    final name = widget.controller.text.trim();
    if (name.isEmpty) {
      setState(() => _errorText = AppLocalizations.of(context).collectionNameRequired);
      return;
    }
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final hasParent = widget.parentName != null && widget.parentName!.isNotEmpty;
    return AlertDialog(
      title: Text(l10n.createCollection),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          TextField(
            controller: widget.controller,
            autofocus: true,
            maxLength: 100,
            decoration: InputDecoration(
              labelText: l10n.collectionNameLabel,
              errorText: _errorText,
            ),
            onSubmitted: (String value) => _submit(),
          ),
          if (hasParent)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Row(
                children: <Widget>[
                  Icon(
                    Icons.subdirectory_arrow_right,
                    size: 16,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      l10n.createUnderParentHint(widget.parentName!),
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
          onPressed: _submit,
          child: Text(l10n.create),
        ),
      ],
    );
  }
}

/// 重命名分组对话框：输入名称（必填）+ 可选改图标 emoji。
///
/// 返回位置记录 `(name, icon)`：icon 为 null 表示未改图标（不随请求发送）；
/// 取消返回 null。预设图标全部为 ≤2 UTF-16 code unit 的 emoji，
/// 与分组卡片的 icon 渲染分支（length<=2 显示 emoji 文本）保持一致。
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
  /// 预设图标（覆盖常用语义：默认文件夹/星标/紧急/想法/目标/置顶/上线/媒体等）
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

  /// 图标选项：选中态用 primary 描边加粗；当前 icon 不在预设里时无选中项。
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
          borderRadius: BorderRadius.circular(AppRadius.sm),
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

/// 删除分组确认对话框：确认返回 true，取消（点外部 / 返回 / 取消按钮）返回 false。
///
/// 文案说明组内条目不受影响、子分组会被级联删除（与后端 DELETE 行为一致）。
Future<bool> confirmDeleteCollection(
  BuildContext context,
  CollectionGroup group,
) async {
  final l10n = AppLocalizations.of(context);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (BuildContext dialogContext) => AlertDialog(
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

/// 分组图标圆标：emoji（≤2 code unit）按文字渲染，长图标名按文件夹图标渲染。
/// FavoritesScreen / CollectionItemsScreen 的分组卡片共用，避免图标名折行。
Widget collectionLeadingAvatar(CollectionGroup group, ColorScheme scheme) {
  return CircleAvatar(
    backgroundColor: scheme.surfaceContainerHigh,
    child: group.icon.length <= 2
        ? Text(group.icon, style: const TextStyle(fontSize: 18))
        : Icon(Icons.folder_outlined, size: 20, color: scheme.primary),
  );
}
