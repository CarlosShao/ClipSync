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

/// 高级筛选面板：时间范围（单选，预设档 + G5 自定义起止日期）+ 来源设备
/// （单选，复用 DeviceProvider 既有设备数据源，不发新请求）+ 仅收藏开关。
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
  bool _archiveView = false;

  // G5 自定义时间范围（仅 _dateRange == kDateRangeCustom 时应用）
  DateTime? _customFrom;
  DateTime? _customTo;

  @override
  void initState() {
    super.initState();
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    _dateRange = provider.filterDateRange;
    if (_dateRange == ClipboardProvider.kDateRangeCustom) {
      _customFrom = provider.filterCustomFrom;
      _customTo = provider.filterCustomTo;
    }
    _deviceId = provider.filterDeviceId;
    _favoritesOnly = provider.favoritesOnly;
    _archiveView = provider.archiveView;
  }

  void _apply() {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    Navigator.of(context).pop();
    unawaited(
      provider.applyFilters(
        dateRange: _dateRange,
        customFrom: _customFrom,
        customTo: _customTo,
        deviceId: _deviceId,
        favoritesOnly: _favoritesOnly,
        archiveView: _archiveView,
      ),
    );
  }

  /// 重置：清空暂存并立即提交（乐观更新，列表在面板背后重拉）。
  void _reset() {
    final ClipboardProvider provider = context.read<ClipboardProvider>();
    setState(() {
      _dateRange = null;
      _customFrom = null;
      _customTo = null;
      _deviceId = null;
      _favoritesOnly = false;
      _archiveView = false;
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
        // G5：自定义档会增加一行起止日期按钮，小屏上整列可能超出弹层高度，
        // 包一层滚动视图防 RenderFlex overflow
        child: SingleChildScrollView(
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
              // C3：已归档开关 —— 后端 GET /api/clipboard 仅支持 view=archive
              // （只看归档）与缺省（排除归档）两种视图，无混合展示参数，
              // 故开关语义为「切换到归档视图」而非「在列表中包含已归档」。
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: Text(l10n.filterArchived, style: textTheme.bodyMedium),
                value: _archiveView,
                onChanged: (bool value) => setState(() => _archiveView = value),
              ),
              const SizedBox(height: AppSpacing.lg),
              _buildActions(l10n),
            ],
          ),
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

  /// 时间范围单选：全部时间（null）/ 今天 / 最近 7 天 / 最近 30 天 /
  /// 自定义（G5：showDatePicker 起止两次选择，选中后展示起止按钮可重选）。
  /// 预设档与自定义档互斥（ChoiceChip 单选语义）。
  Widget _buildDateRangeChips(AppLocalizations l10n) {
    final bool customSelected =
        _dateRange == ClipboardProvider.kDateRangeCustom;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Wrap(
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
            _choiceChip(
              label: l10n.filterCustom,
              selected: customSelected,
              onSelected: () => unawaited(_selectCustomRange()),
            ),
          ],
        ),
        // 自定义档：起止日期按钮（点击重选对应一端；未选齐时提示先选起止）
        if (customSelected)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.sm),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: _customDateButton(
                    label: _customFrom != null
                        ? _formatDate(_customFrom!)
                        : l10n.filterDateFrom,
                    icon: Icons.calendar_today_outlined,
                    onPressed: _pickCustomFrom,
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: _customDateButton(
                    label: _customTo != null
                        ? _formatDate(_customTo!)
                        : l10n.filterDateTo,
                    icon: Icons.event_outlined,
                    onPressed: _pickCustomTo,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  /// 「自定义」档首次选择：依次弹出起始、结束日期选择器（G5）；任一步取消
  /// 则整档回退为之前的选择（不残留半选态）。
  Future<void> _selectCustomRange() async {
    final String? previousRange = _dateRange;
    setState(() => _dateRange = ClipboardProvider.kDateRangeCustom);

    final DateTime now = DateTime.now();
    final DateTime fallbackFrom = _customFrom ?? DateTime(now.year, now.month, now.day);
    final DateTime? from = await showDatePicker(
      context: context,
      initialDate: fallbackFrom,
      firstDate: DateTime(now.year - 5),
      lastDate: now,
    );
    if (!mounted) {
      return;
    }
    if (from == null) {
      setState(() => _dateRange = previousRange);
      return;
    }
    final DateTime? to = await showDatePicker(
      context: context,
      initialDate: _customTo != null && !_customTo!.isBefore(from)
          ? _customTo!
          : from,
      firstDate: from,
      lastDate: now,
    );
    if (!mounted) {
      return;
    }
    if (to == null) {
      setState(() => _dateRange = previousRange);
      return;
    }
    // 起止倒置时对调，保证 from <= to（provider 侧同样兜底）
    final bool ordered = !from.isAfter(to);
    setState(() {
      _customFrom = ordered ? from : to;
      _customTo = ordered ? to : from;
      _dateRange = ClipboardProvider.kDateRangeCustom;
    });
  }

  /// 重选自定义起始日期（结束日期保持，必要时前移结束=起始防倒置）。
  Future<void> _pickCustomFrom() async {
    final DateTime now = DateTime.now();
    final DateTime currentTo = _customTo ?? DateTime(now.year, now.month, now.day);
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: _customFrom != null && !_customFrom!.isAfter(currentTo)
          ? _customFrom!
          : currentTo,
      firstDate: DateTime(now.year - 5),
      lastDate: currentTo,
    );
    if (!mounted || picked == null) {
      return;
    }
    setState(() {
      _customFrom = picked;
      if (_customTo != null && _customTo!.isBefore(picked)) {
        _customTo = picked;
      }
    });
  }

  /// 重选自定义结束日期（起始日期保持；firstDate 约束 end >= start）。
  Future<void> _pickCustomTo() async {
    final DateTime now = DateTime.now();
    final DateTime currentFrom =
        _customFrom ?? DateTime(now.year, now.month, now.day);
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: _customTo != null && !_customTo!.isBefore(currentFrom)
          ? _customTo!
          : currentFrom,
      firstDate: currentFrom,
      lastDate: now,
    );
    if (!mounted || picked == null) {
      return;
    }
    setState(() => _customTo = picked);
  }

  /// 自定义起止日期按钮（OutlinedButton，选中日期回显）。
  Widget _customDateButton({
    required String label,
    required IconData icon,
    required VoidCallback onPressed,
  }) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return OutlinedButton.icon(
      onPressed: onPressed,
      icon: Icon(icon, size: 16),
      label: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      style: OutlinedButton.styleFrom(
        visualDensity: VisualDensity.compact,
        foregroundColor: scheme.onSurface,
        side: BorderSide(color: scheme.outlineVariant),
      ),
    );
  }

  /// 日期回显格式 yyyy-MM-dd（pubspec 无 intl，手动补零）。
  String _formatDate(DateTime date) {
    final String mm = date.month.toString().padLeft(2, '0');
    final String dd = date.day.toString().padLeft(2, '0');
    return '${date.year}-$mm-$dd';
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
