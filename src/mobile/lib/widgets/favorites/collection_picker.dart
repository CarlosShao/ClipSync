import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../services/app_exception.dart';
import '../../services/collections_api_service.dart';
import '../../theme/app_theme.dart';

/// 分组选择对话框（C1）：单选一个收藏夹分组，点选即返回该分组；
/// 取消（点外部 / 返回）返回 null。
///
/// [groups] 为可选项（调用方负责排除「当前分组」等场景）。
Future<CollectionGroup?> showCollectionPickerDialog(
  BuildContext context, {
  required List<CollectionGroup> groups,
}) {
  final l10n = AppLocalizations.of(context);
  return showDialog<CollectionGroup>(
    context: context,
    builder: (BuildContext dialogContext) {
      return AlertDialog(
        title: Text(l10n.selectGroup),
        content: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 320),
          child: ListView.builder(
            shrinkWrap: true,
            itemCount: groups.length,
            itemBuilder: (BuildContext context, int index) {
              final group = groups[index];
              return ListTile(
                leading: CircleAvatar(
                  backgroundColor: Theme.of(context).colorScheme.surfaceContainerHigh,
                  child: group.icon.length <= 2
                      ? Text(group.icon, style: const TextStyle(fontSize: 18))
                      : Icon(
                          Icons.folder_outlined,
                          size: 20,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                ),
                title: Text(group.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                onTap: () => Navigator.of(dialogContext).pop(group),
              );
            },
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: Text(l10n.cancel),
          ),
        ],
      );
    },
  );
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
