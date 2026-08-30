import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../theme/app_theme.dart';

/// 筛选选项定义（value 为 provider 的 contentTypeFilter 值，null = 全部）。
class _FilterOption {
  const _FilterOption({required this.icon, this.value});

  /// 服务端 contentType 白名单值；null 表示「全部」。
  final String? value;

  /// 前置图标。
  final IconData icon;
}

// 文案（全部/文本/链接/图片/文件）在构建时经 AppLocalizations 解析（F5），
// value→key 的映射见 [_optionLabel]。
const List<_FilterOption> _kFilterOptions = <_FilterOption>[
  _FilterOption(icon: Icons.filter_list),
  _FilterOption(value: 'text', icon: Icons.subject),
  _FilterOption(value: 'link', icon: Icons.link),
  _FilterOption(value: 'image', icon: Icons.image_outlined),
  _FilterOption(value: 'file', icon: Icons.insert_drive_file_outlined),
];

/// 按 contentType 取本地化标签（null / 未知值 = 「全部」）。
String _optionLabel(AppLocalizations l10n, String? value) {
  switch (value) {
    case 'text':
      return l10n.typeText;
    case 'link':
      return l10n.typeLink;
    case 'image':
      return l10n.typeImage;
    case 'file':
      return l10n.typeFile;
    default:
      return l10n.typeAll;
  }
}

/// 剪贴板流类型筛选 chips 横向滚动行（T2.3）。
///
/// 单选语义：全部 / 文本 / 链接 / 图片 / 文件。选中项回传
/// [TypeFilterChips.onSelected]（「全部」回传 null），由宿主转发给
/// `ClipboardProvider.setContentTypeFilter`（重置分页由 provider 处理）。
///
/// 纯展示组件：选中态由 [TypeFilterChips.selected] 驱动，自身不持有状态。
class TypeFilterChips extends StatelessWidget {
  /// 创建类型筛选行。
  ///
  /// [selected] 为当前选中的 contentType（null = 全部）；
  /// [onSelected] 在用户点击某个 chip 时回调对应 value（「全部」为 null）。
  const TypeFilterChips({required this.selected, required this.onSelected, super.key});

  /// 当前选中的 contentType；null 表示「全部」。
  final String? selected;

  /// 选择回调（单选，「全部」回传 null）。
  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context);
    return SizedBox(
      height: 36,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        clipBehavior: Clip.none,
        itemCount: _kFilterOptions.length,
        separatorBuilder: (BuildContext context, int index) => const SizedBox(width: AppSpacing.sm),
        itemBuilder: (BuildContext context, int index) {
          final option = _kFilterOptions[index];
          final isSelected = option.value == selected;

          return ChoiceChip(
            selected: isSelected,
            avatar: Icon(
              option.icon,
              size: 16,
              color: isSelected
                  ? Theme.of(context).colorScheme.onSecondaryContainer
                  : Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            label: Text(_optionLabel(l10n, option.value)),
            showCheckmark: false,
            visualDensity: VisualDensity.compact,
            onSelected: (bool _) => onSelected(option.value),
          );
        },
      ),
    );
  }
}
