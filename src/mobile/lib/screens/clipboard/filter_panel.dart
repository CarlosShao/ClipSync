import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_localizations.dart';
import '../../models/device.dart';
import '../../providers/clipboard_provider.dart';
import '../../providers/device_provider.dart';
import '../../theme/app_theme.dart';

/// 打开高级筛选 bottom sheet（C2）。
///
/// 面板内选择即时乐观更新（局部 state），「应用」提交到
/// [ClipboardProvider.applyFilters] 后关闭；「重置」立即提交
/// [ClipboardProvider.resetAdvancedFilters]（面板保持打开，列表在背后刷新）；
/// 「取消」/点外部/下拉关闭均不改动暂存的选择。
Future<void> showFilterPanel(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    builder: (BuildContext sheetContext) => const FilterPanel(),
  );
}

/// 高级筛选面板：时间范围（单选）+ 来源设备（单选，复用 DeviceProvider
/// 既有设备数据源，不发新请求）+ 仅收藏开关。
class FilterPanel extends StatefulWidget {
  const FilterPanel({super.key});

  @override
  State<FilterPanel> createState() => _FilterPanelState();
}

class _FilterPanelState extends State<FilterPanel> {
  // 暂存选择（打开面板时从 provider 快照，应用/重置时才写回）
  String? _dateRange;
  String? _deviceId;
  bool _favoritesOnly = false;

  @override
  void initState() {
    super.initState();
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    _dateRange = provider.filterDateRange;
    _deviceId = provider.filterDeviceId;
    _favoritesOnly = provider.favoritesOnly;
  }

  void _apply() {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    Navigator.of(context).pop();
    unawaited(
      provider.applyFilters(
        dateRange: _dateRange,
        deviceId: _deviceId,
        favoritesOnly: _favoritesOnly,
      ),
    );
  }

  /// 重置：清空暂存并立即提交（乐观更新，列表在面板背后重拉）。
  void _reset() {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    setState(() {
      _dateRange = null;
      _deviceId = null;
      _favoritesOnly = false;
    });
    unawaited(provider.resetAdvancedFilters());
  }

  @override
  Widget build(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context);
    final TextTheme textTheme = Theme.of(context).textTheme;
    // 复用现有设备数据源（home_screen 启动时已加载），不发起新请求
    final List<Device> devices = context.watch<DeviceProvider>().devices;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              l10n.advancedFilter,
              style: textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.lg),
            _buildSectionLabel(l10n.filterDateRange),
            _buildDateRangeChips(l10n),
            const SizedBox(height: AppSpacing.lg),
            _buildSectionLabel(l10n.filterDevice),
            _buildDeviceChips(l10n, devices),
            const SizedBox(height: AppSpacing.sm),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: Text(l10n.filterFavoritesOnly, style: textTheme.bodyMedium),
              value: _favoritesOnly,
              onChanged: (bool value) => setState(() => _favoritesOnly = value),
            ),
            const SizedBox(height: AppSpacing.lg),
            _buildActions(l10n),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionLabel(String label) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Text(
        label,
        style: Theme.of(context)
            .textTheme
            .labelSmall
            ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
      ),
    );
  }

  /// 时间范围单选：全部时间（null）/ 今天 / 最近 7 天 / 最近 30 天。
  Widget _buildDateRangeChips(AppLocalizations l10n) {
    return Wrap(
      spacing: AppSpacing.sm,
      runSpacing: AppSpacing.sm,
      children: <Widget>[
        _choiceChip(
          label: l10n.filterAllTime,
          selected: _dateRange == null,
          onSelected: () => setState(() => _dateRange = null),
        ),
        _choiceChip(
          label: l10n.filterToday,
          selected: _dateRange == ClipboardProvider.kDateRangeToday,
          onSelected: () =>
              setState(() => _dateRange = ClipboardProvider.kDateRangeToday),
        ),
        _choiceChip(
          label: l10n.filterWeek,
          selected: _dateRange == ClipboardProvider.kDateRangeWeek,
          onSelected: () =>
              setState(() => _dateRange = ClipboardProvider.kDateRangeWeek),
        ),
        _choiceChip(
          label: l10n.filterMonth,
          selected: _dateRange == ClipboardProvider.kDateRangeMonth,
          onSelected: () =>
              setState(() => _dateRange = ClipboardProvider.kDateRangeMonth),
        ),
      ],
    );
  }

  /// 来源设备单选：全部设备（null）+ 设备列表（名称缺失用 unknownDevice 兜底）。
  Widget _buildDeviceChips(AppLocalizations l10n, List<Device> devices) {
    return Wrap(
      spacing: AppSpacing.sm,
      runSpacing: AppSpacing.sm,
      children: <Widget>[
        _choiceChip(
          label: l10n.filterAllDevices,
          selected: _deviceId == null,
          onSelected: () => setState(() => _deviceId = null),
        ),
        for (final Device device in devices)
          _choiceChip(
            label: device.deviceName.isEmpty ? l10n.unknownDevice : device.deviceName,
            selected: _deviceId == device.id,
            onSelected: () => setState(() => _deviceId = device.id),
          ),
      ],
    );
  }

  Widget _choiceChip({
    required String label,
    required bool selected,
    required VoidCallback onSelected,
  }) {
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      showCheckmark: false,
      visualDensity: VisualDensity.compact,
      onSelected: (bool _) => onSelected(),
    );
  }

  /// 按钮行：重置（左）+ 取消 / 应用（右）。
  Widget _buildActions(AppLocalizations l10n) {
    return Row(
      children: <Widget>[
        TextButton(
          onPressed: _reset,
          child: Text(l10n.resetFilter),
        ),
        const Spacer(),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
        const SizedBox(width: AppSpacing.sm),
        FilledButton(
          onPressed: _apply,
          child: Text(l10n.applyFilter),
        ),
      ],
    );
  }
}
