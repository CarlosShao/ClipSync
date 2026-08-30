import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../services/api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/app_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';

/// 模板库页（T4.2）。
///
/// 页面结构：模板卡片列表（名称 + 内容预览 + 变量徽标 + 「使用」按钮），
/// 顶部 AppBar 标题「模板库」，支持下拉刷新。
///
/// 数据交互走 [ApiService.getTemplates]（Bearer 由 TokenStore 解析，
/// 对齐后端 `GET /api/templates`，响应 `{ data: [...] }`）。
///
/// 使用流程（「使用」按钮 / 整卡点击）：
/// - 模板不含 `{{变量}}`：直接渲染，弹出结果对话框；
/// - 模板含变量：按出现顺序逐个弹出填写对话框（取消即中止），
///   同名变量复用已填值，全部填完后渲染并弹出结果对话框；
/// - 结果对话框提供「复制全文」：Clipboard.setData + SnackBar 反馈。
///
/// 三态：SkeletonList（加载中）/ ErrorState（失败可重试）/ EmptyState
/// （无模板，提示到桌面端创建）。
class TemplatesScreen extends StatefulWidget {
  const TemplatesScreen({super.key});

  @override
  State<TemplatesScreen> createState() => _TemplatesScreenState();
}

class _TemplatesScreenState extends State<TemplatesScreen> {
  final ApiService _api = ApiService();

  List<ClipboardTemplate> _templates = <ClipboardTemplate>[];
  bool _isLoading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// 拉取模板列表（首次进入与下拉刷新共用）。
  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final templates = await _api.getTemplates(null);
      if (!mounted) {
        return;
      }
      setState(() {
        _templates = templates;
        _isLoading = false;
      });
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      setState(() {
        _isLoading = false;
        _error = e.toString();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 使用模板
  // ---------------------------------------------------------------------------

  /// 「使用」入口：含变量先逐个填写，无变量直接渲染，最后弹出结果对话框。
  Future<void> _useTemplate(ClipboardTemplate template) async {
    final variables = template.variableNames;
    final values = <String, String>{};

    for (int i = 0; i < variables.length; i++) {
      final value = await _showVariableInputDialog(
        variableName: variables[i],
        step: i + 1,
        total: variables.length,
        initialValue: values[variables[i]],
      );
      // 取消 / 关闭对话框：中止整个使用流程，不渲染
      if (value == null || !mounted) {
        return;
      }
      values[variables[i]] = value;
    }

    final rendered = template.render(values);
    if (!mounted) {
      return;
    }
    await _showResultDialog(rendered);
  }

  /// 单个变量的填写对话框；返回 null 表示用户取消。
  Future<String?> _showVariableInputDialog({
    required String variableName,
    required int step,
    required int total,
    String? initialValue,
  }) {
    return showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => _VariableInputDialog(
        variableName: variableName,
        step: step,
        total: total,
        initialValue: initialValue,
      ),
    );
  }

  /// 渲染结果对话框：可长按选择部分文本，「复制全文」一键复制全部结果。
  Future<void> _showResultDialog(String rendered) async {
    // 在 await 之前捕获 messenger，避免 async 间隔后使用已失效的 context
    final messenger = ScaffoldMessenger.of(context);
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('渲染结果'),
        content: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 320),
          child: SingleChildScrollView(
            child: SelectableText(
              rendered,
              style: Theme.of(dialogContext).textTheme.bodyMedium?.copyWith(
                    height: 1.5,
                  ),
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('关闭'),
          ),
          FilledButton.icon(
            onPressed: () {
              unawaited(Clipboard.setData(ClipboardData(text: rendered)));
              Navigator.of(dialogContext).pop();
              messenger
                ..hideCurrentSnackBar()
                ..showSnackBar(
                  const SnackBar(content: Text('已复制渲染结果到剪贴板')),
                );
            },
            icon: const Icon(Icons.copy_all_outlined),
            label: const Text('复制全文'),
          ),
        ],
      ),
    );
  }

  /// 错误文案友好化：去掉异常前缀（'Exception: xxx' → 'xxx'）。
  String _friendlyError(String raw) =>
      raw.replaceFirst(RegExp(r'^Exception:\s*'), '');

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('模板库')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildContent(),
      ),
    );
  }

  /// 主体：三态分发。骨架/错误/空态也包在可滚动容器里，任何状态可下拉刷新。
  Widget _buildContent() {
    if (_isLoading && _templates.isEmpty) {
      return _scrollableBody(const SkeletonList(itemCount: 6));
    }
    if (_error != null && _templates.isEmpty) {
      return _scrollableBody(
        ErrorState(
          message: _friendlyError(_error!),
          onRetry: () => unawaited(_load()),
        ),
      );
    }
    if (_templates.isEmpty) {
      return _scrollableBody(
        const EmptyState(
          icon: Icons.description_outlined,
          title: '暂无模板',
          message: '在桌面端保存剪贴板内容为模板后，会同步到这里',
        ),
      );
    }
    return _buildTemplateList();
  }

  Widget _buildTemplateList() {
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.md,
        AppSpacing.lg,
        AppSpacing.xxl,
      ),
      itemCount: _templates.length,
      separatorBuilder: (BuildContext context, int index) =>
          const SizedBox(height: AppSpacing.md),
      itemBuilder: (BuildContext context, int index) =>
          _buildTemplateCard(_templates[index]),
    );
  }

  /// 模板卡片：名称 + 变量徽标 + 内容预览（3 行截断）+ 「使用」按钮。
  Widget _buildTemplateCard(ClipboardTemplate template) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final variables = template.variableNames;
    final preview = template.content.trim();

    return AppCard(
      onTap: () => unawaited(_useTemplate(template)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  template.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (variables.isNotEmpty) ...<Widget>[
                const SizedBox(width: AppSpacing.sm),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.sm,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHigh,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    '${variables.length} 个变量',
                    style: textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            preview.isEmpty ? '（模板内容为空）' : preview,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: textTheme.bodyMedium?.copyWith(
              color: scheme.onSurfaceVariant,
              height: 1.4,
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton.tonalIcon(
              onPressed: () => unawaited(_useTemplate(template)),
              icon: const Icon(Icons.play_arrow_outlined),
              label: const Text('使用'),
            ),
          ),
        ],
      ),
    );
  }

  /// 全页可滚动包装：内容不满一屏时也能下拉刷新（AlwaysScrollable），
  /// 状态占位在 minHeight 约束内垂直居中。
  Widget _scrollableBody(Widget child) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        return SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: child,
          ),
        );
      },
    );
  }
}

/// 变量填写对话框：模板使用流程中的一环，逐个收集 `{{变量}}` 的值。
///
/// 顶部提示进度（第 x / N 个）与变量名；同声明的 [initialValue] 复用
/// 已填过的值；「取消」返回 null（调用方中止整个流程），
/// 提交返回输入值（允许为空串，渲染为空占位）。
class _VariableInputDialog extends StatefulWidget {
  const _VariableInputDialog({
    required this.variableName,
    required this.step,
    required this.total,
    this.initialValue,
  });

  /// 变量名（占位符内去掉两侧空白后的内容）
  final String variableName;

  /// 当前是第几个变量（1 起）
  final int step;

  /// 变量总数
  final int total;

  /// 同名变量此前已填过的值（预填）
  final String? initialValue;

  @override
  State<_VariableInputDialog> createState() => _VariableInputDialogState();
}

class _VariableInputDialogState extends State<_VariableInputDialog> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialValue ?? '');

  void _submit() {
    Navigator.of(context).pop(_controller.text);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isLast = widget.step >= widget.total;

    return AlertDialog(
      title: const Text('填写变量'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            '第 ${widget.step} / ${widget.total} 个变量',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _controller,
            autofocus: true,
            decoration: InputDecoration(
              labelText: widget.variableName,
              hintText: '请输入 {{${widget.variableName}}} 的值',
            ),
            onSubmitted: (String value) => _submit(),
          ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(isLast ? '完成' : '下一项'),
        ),
      ],
    );
  }
}
