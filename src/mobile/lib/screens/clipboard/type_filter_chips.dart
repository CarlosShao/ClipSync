import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_localizations.dart';
import '../../providers/clipboard_provider.dart';
import '../../theme/app_theme.dart';
import 'filter_panel.dart';

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

/// 剪贴板流类型筛选 chips 横向滚动行（T2.3 / C2 高级筛选入口）。
///
/// 单选语义：全部 / 文本 / 链接 / 图片 / 文件。选中项回传
/// [TypeFilterChips.onSelected]（「全部」回传 null），由宿主转发给
/// `ClipboardProvider.setContentTypeFilter`（重置分页由 provider 处理）。
///
/// C2：行首固定渲染「高级筛选」入口 chip——无激活筛选时显示 advancedFilter，
/// 有激活筛选时显示 activeFilters{count} 徽标（选中态高亮）；点击打开
/// FilterPanel bottom sheet。
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
    // ⚠️ select 必须在 sliver 外（本层 build）求值：itemBuilder 的 context
    // 位于横向 SliverList 内，在那里 select 触发 provider 的
    // 「select inside a SliverList」断言（真机红屏已踩坑）。
    final int activeFilterCount = context.select<ClipboardProvider, int>((p) => p.activeFilterCount);
    return SizedBox(
      height: 36,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        clipBehavior: Clip.none,
        itemCount: _kFilterOptions.length + 1,
        separatorBuilder: (BuildContext context, int index) => const SizedBox(width: AppSpacing.sm),
        itemBuilder: (BuildContext context, int index) {
          // 行首：高级筛选入口（C2）
          if (index == 0) {
            return _buildFilterEntryChip(context, l10n, activeFilterCount);
          }
          final option = _kFilterOptions[index - 1];
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

  /// 高级筛选入口 chip（C2）：徽标数由 build 层 select 后传入
  /// （禁止在 sliver 子项内 select），点击打开 FilterPanel。
  Widget _buildFilterEntryChip(BuildContext context, AppLocalizations l10n, int activeFilterCount) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final bool hasActive = activeFilterCount > 0;

    return ChoiceChip(
      selected: hasActive,
      avatar: Icon(
        Icons.tune,
        size: 16,
        color: hasActive ? scheme.onSecondaryContainer : scheme.onSurfaceVariant,
      ),
      label: Text(hasActive ? l10n.activeFilters(activeFilterCount) : l10n.advancedFilter),
      showCheckmark: false,
      visualDensity: VisualDensity.compact,
      onSelected: (bool _) => showFilterPanel(context),
    );
  }
}
