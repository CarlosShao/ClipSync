import 'package:flutter/material.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/screens/favorites/collection_dialogs.dart';
import 'package:clipsync_mobile/services/app_exception.dart';
import 'package:clipsync_mobile/services/collections_api_service.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';

/// 分组选择弹层（Obsidian v2）：
/// 采用 28dp 大圆角 BottomSheet，以树形层级展示所有可用分组。
Future<CollectionGroup?> showCollectionPickerDialog(
  BuildContext context, {
  required List<CollectionGroup> groups,
}) {
  return showModalBottomSheet<CollectionGroup>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(AppShapesV2.xl),
      ),
    ),
    builder: (BuildContext sheetContext) {
      return CollectionPickerSheet(groups: groups);
    },
  );
}

/// 树形分组选择器 BottomSheet 组件。
class CollectionPickerSheet extends StatefulWidget {
  const CollectionPickerSheet({
    required this.groups,
    super.key,
  });

  final List<CollectionGroup> groups;

  @override
  State<CollectionPickerSheet> createState() => _CollectionPickerSheetState();
}

class _CollectionPickerSheetState extends State<CollectionPickerSheet> {
  String _filter = '';

  int _treeDepth(CollectionGroup group) {
    if (group.path.isEmpty) {
      return 0;
    }
    final segments = group.path.split('.');
    return segments.length > 2 ? segments.length - 2 : 0;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final isDark = theme.brightness == Brightness.dark;

    final filtered = widget.groups.where((g) {
      if (_filter.isEmpty) {
        return true;
      }
      return g.name.toLowerCase().contains(_filter.toLowerCase());
    }).toList();

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.7,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.lg,
            AppSpacing.md,
            AppSpacing.lg,
            AppSpacing.lg,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: AppSpacing.md),
                  decoration: BoxDecoration(
                    color: scheme.outlineVariant,
                    borderRadius: BorderRadius.circular(AppShapesV2.pill),
                  ),
                ),
              ),
              Row(
                children: <Widget>[
                  Text(
                    l10n.selectGroup,
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
              if (widget.groups.length > 6) ...<Widget>[
                const SizedBox(height: AppSpacing.xs),
                TextField(
                  decoration: InputDecoration(
                    hintText: l10n.clipboardSearchHint,
                    prefixIcon: const Icon(Icons.search, size: 20),
                    isDense: true,
                    filled: true,
                    fillColor: AppColorsV2.surface(context, tier: SurfaceTier.high),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(AppShapesV2.sm),
                      borderSide: BorderSide.none,
                    ),
                  ),
                  onChanged: (val) => setState(() => _filter = val.trim()),
                ),
              ],
              const SizedBox(height: AppSpacing.sm),
              Expanded(
                child: filtered.isEmpty
                    ? Center(
                        child: Text(
                          l10n.noAvailableGroups,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                        ),
                      )
                    : ListView.builder(
                        itemCount: filtered.length,
                        itemBuilder: (BuildContext context, int index) {
                          final group = filtered[index];
                          final depth = _treeDepth(group);
                          return Padding(
                            padding: EdgeInsets.only(
                              left: depth * 20.0,
                              bottom: AppSpacing.xs,
                            ),
                            child: ListTile(
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(AppShapesV2.sm),
                              ),
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: AppSpacing.sm,
                                vertical: 2,
                              ),
                              leading: collectionLeadingAvatar(
                                group,
                                scheme,
                                size: 36,
                                isDark: isDark,
                              ),
                              title: Text(
                                group.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                              subtitle: Text(
                                l10n.collectionItemCount(group.itemCount),
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: scheme.onSurfaceVariant,
                                ),
                              ),
                              trailing: const Icon(
                                Icons.chevron_right_rounded,
                                size: 18,
                              ),
                              onTap: () => Navigator.of(context).pop(group),
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 「加入分组」完整流程（C1，剪贴板卡片与组内条目页共用）：
///
/// 1. 拉取当前用户全部分组（失败 → SnackBar 错误文案，返回 null）；
/// 2. 排除 [excludeCollectionId]（组内条目页「加入其他分组」场景），
///    无可选项 → SnackBar 提示 noAvailableGroups，返回 null；
/// 3. 弹 [showCollectionPickerDialog] 选择目标分组（取消 → 返回 null）；
/// 4. 调 `POST /collections/:id/items` 加入（后端唯一归属：自动移出其他
///    分组，即「移动」语义；失败 → SnackBar，返回 null）；
/// 5. 成功 → SnackBar movedToCollection{name}，返回目标分组。
///
/// 返回目标分组供调用方做后续 UI 更新（如从当前组列表移除该条目）。
Future<CollectionGroup?> addItemToCollectionFlow(
  BuildContext context, {
  required String itemId,
  String? excludeCollectionId,
}) async {
  final l10n = AppLocalizations.of(context);
  final messenger = ScaffoldMessenger.of(context);
  final api = CollectionsApiService();

  List<CollectionGroup> groups;
  try {
    groups = await api.listCollections();
  } on Exception catch (e) {
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    return null;
  }

  final options = excludeCollectionId == null
      ? groups
      : groups.where((CollectionGroup g) => g.id != excludeCollectionId).toList();
  if (options.isEmpty) {
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(l10n.noAvailableGroups)));
    return null;
  }

  if (!context.mounted) {
    return null;
  }
  final target = await showCollectionPickerDialog(context, groups: options);
  if (target == null) {
    return null;
  }

  try {
    await api.addItemToCollection(target.id, itemId);
  } on Exception catch (e) {
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    return null;
  }

  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(l10n.movedToCollection(target.name))));
  return target;
}

