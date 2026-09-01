import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../l10n/app_localizations.dart';
import '../../services/api_service.dart';
import '../../services/app_exception.dart';
import '../../services/template_variables_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/app_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';

/// 模板库页（T4.2 / C4 模板增强）。
///
/// 页面结构：模板卡片列表（名称 + 内容预览 + 变量徽标 + 「使用」按钮 +
/// 编辑/删除菜单），FAB「新建模板」，顶部 AppBar 标题「模板库」，
/// 支持下拉刷新。
///
/// 数据交互走 [ApiService.getTemplates] 与 [TemplatesApiService]
/// （模板 CRUD + 全局模板变量；Bearer 由 TokenStore 解析）。
///
/// 使用流程（「使用」按钮 / 整卡点击）：
/// - 模板不含 `{{变量}}`：直接渲染，弹出结果对话框；
/// - 模板含变量：按出现顺序逐个弹出填写对话框（取消即中止），
///   预填回退链对齐桌面端（templateVariableStore / VariableFillDialog）：
///   后端全局存储值（默认值/上次记住输入）→ 模板语法默认值
///   （`{{name:default}}`）→ 空串；渲染成功后把本次非空输入回写后端，
///   下次使用自动预填；
/// - 结果对话框提供「复制全文」：Clipboard.setData + SnackBar 反馈。
///
/// 模板管理（C4）：FAB 新建、卡片菜单编辑 / 删除（删除需确认），
/// 成功后刷新列表。
///
/// 三态：SkeletonList（加载中）/ ErrorState（失败可重试）/ EmptyState
/// （无模板，noTemplatesDesc 既有文案保留，由 FAB「新建模板」引导本机创建）。
class TemplatesScreen extends StatefulWidget {
  const TemplatesScreen({super.key});

  @override
  State<TemplatesScreen> createState() => _TemplatesScreenState();
}

class _TemplatesScreenState extends State<TemplatesScreen> {
  final ApiService _api = ApiService();
  final TemplatesApiService _templatesApi = TemplatesApiService();

  List<ClipboardTemplate> _templates = <ClipboardTemplate>[];
  bool _isLoading = false;

  /// 全局模板变量（name → value，默认值/上次记住输入），用于填写预填回退链
  Map<String, String> _variableDefaults = <String, String>{};

  /// 最近一次失败的原始错误对象（UI 层经 friendlyError 映射 l10n 文案）
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(_loadVariableDefaults());
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
        _error = e;
      });
    }
  }

  /// 拉取全局模板变量（默认值/上次记住输入）。
  ///
  /// 失败不阻塞页面：回退链退化为「无预填」，与桌面端
  /// templateVariableStore.fetchVariables 失败仅告警的行为一致。
  Future<void> _loadVariableDefaults() async {
    try {
      final Map<String, String> defaults = await _templatesApi.fetchDefaults();
      if (!mounted) {
        return;
      }
      setState(() {
        _variableDefaults = defaults;
      });
    } on Exception {
      // 静默降级：默认值仅用于预填，加载失败不影响列表与使用流程
    }
  }

  // ---------------------------------------------------------------------------
  // 使用模板
  // ---------------------------------------------------------------------------

  /// 「使用」入口：含变量先逐个填写，无变量直接渲染，最后弹出结果对话框。
  ///
  /// 每个变量的预填回退链对齐桌面端 VariableFillDialog：
  /// 后端全局存储值（默认值/上次记住输入）→ 模板语法默认值
  /// （`{{name:default}}`）→ 空串。
  Future<void> _useTemplate(ClipboardTemplate template) async {
    final variables = template.variableNames;
    final values = <String, String>{};

    for (int i = 0; i < variables.length; i++) {
      final (String name, String? syntaxDefault) =
          _parseVariableToken(variables[i]);
      final String stored = _variableDefaults[name] ?? '';
      final String prefill =
          stored.isNotEmpty ? stored : (syntaxDefault ?? '');

      final value = await _showVariableInputDialog(
        variableName: name,
        step: i + 1,
        total: variables.length,
        initialValue: prefill,
      );
      // 取消 / 关闭对话框：中止整个使用流程，不渲染
      if (value == null || !mounted) {
        return;
      }
      // 以占位符原始内容为键（如 name:default），保证 render 替换一致
      values[variables[i]] = value;
    }

    final rendered = template.render(values);
    if (!mounted) {
      return;
    }
    // 渲染成功后记住本次非空输入（对齐桌面端「记住」默认勾选语义），
    // 下次使用同变量时自动预填
    await _rememberInputs(values);
    await _showResultDialog(rendered);
  }

  /// `{{name}}` / `{{name:default}}` 占位符原始内容 →（变量名, 语法默认值）。
  ///
  /// 对齐桌面端 VAR_PATTERN 语法（templateStore.ts：`{{ name:default }}`，
  /// 冒号后为默认值）；移动端 [ClipboardTemplate.variableNames] 提取的是
  /// 花括号内原始文本，展示与回写前需在此拆分。
  static (String, String?) _parseVariableToken(String raw) {
    final int idx = raw.indexOf(':');
    if (idx <= 0) {
      return (raw.trim(), null);
    }
    return (raw.substring(0, idx).trim(), raw.substring(idx + 1).trim());
  }

  /// 渲染成功后把本次输入回写全局变量存储（PUT /api/template-variables）。
  ///
  /// 仅回写非空输入、且变量名满足后端 NAME_RE 约束的变量（对齐桌面端
  /// TemplatesView.onFillConfirm 的非空回写语义）。失败静默：记忆属
  /// 增强能力，不影响本次渲染结果展示。
  Future<void> _rememberInputs(Map<String, String> values) async {
    final Map<String, String> pending = <String, String>{};
    values.forEach((String raw, String value) {
      final (String name, _) = _parseVariableToken(raw);
      if (value.isNotEmpty && TemplatesApiService.isValidVariableName(name)) {
        pending[name] = value;
      }
    });
    if (pending.isEmpty) {
      return;
    }
    try {
      await _templatesApi.saveDefaults(pending);
      if (!mounted) {
        return;
      }
      setState(() {
        _variableDefaults = <String, String>{..._variableDefaults, ...pending};
      });
    } on Exception {
      // 静默失败：下次使用时无预填，属可接受降级
    }
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
    final l10n = AppLocalizations.of(context);
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(l10n.renderResultTitle),
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
            child: Text(l10n.close),
          ),
          FilledButton.icon(
            onPressed: () {
              unawaited(Clipboard.setData(ClipboardData(text: rendered)));
              Navigator.of(dialogContext).pop();
              messenger
                ..hideCurrentSnackBar()
                ..showSnackBar(
                  SnackBar(content: Text(l10n.renderResultCopied)),
                );
            },
            icon: const Icon(Icons.copy_all_outlined),
            label: Text(l10n.copyAll),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 模板 CRUD（C4）
  // ---------------------------------------------------------------------------

  /// 新建 / 编辑模板：弹出编辑对话框，确认后 POST / PUT 并刷新列表。
  ///
  /// [template] 为 null 表示新建；成功反馈 [AppLocalizations.templateSaved]，
  /// 失败经 friendlyError 兜底展示（无专属 arb key，走 detail/errorUnknown）。
  Future<void> _showTemplateEditor([ClipboardTemplate? template]) async {
    final (String, String)? result = await showDialog<(String, String)>(
      context: context,
      builder: (BuildContext dialogContext) =>
          _TemplateEditorDialog(template: template),
    );
    if (result == null || !mounted) {
      return;
    }
    final (String name, String content) = result;
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    try {
      if (template == null) {
        await _templatesApi.createTemplate(name, content);
      } else {
        await _templatesApi.updateTemplate(template.id, name, content);
      }
      if (!mounted) {
        return;
      }
      messenger.showSnackBar(SnackBar(content: Text(l10n.templateSaved)));
      await _load();
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e, l10n))));
    }
  }

  /// 删除模板：确认对话框 → DELETE → templateDeleted 反馈并刷新列表。
  Future<void> _deleteTemplate(ClipboardTemplate template) async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        final dialogL10n = AppLocalizations.of(dialogContext);
        return AlertDialog(
          title: Text(dialogL10n.delete),
          content: Text(dialogL10n.deleteTemplateConfirm(template.name)),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(dialogL10n.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(
                dialogL10n.delete,
                style: TextStyle(
                  color: Theme.of(dialogContext).colorScheme.error,
                ),
              ),
            ),
          ],
        );
      },
    );

    if (confirmed != true || !mounted) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    try {
      await _templatesApi.deleteTemplate(template.id);
      if (!mounted) {
        return;
      }
      messenger.showSnackBar(
        SnackBar(
          content: Text(AppLocalizations.of(context).templateDeleted),
          duration: const Duration(seconds: 2),
        ),
      );
      await _load();
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      messenger.showSnackBar(
        SnackBar(
          content: Text(friendlyError(e, AppLocalizations.of(context))),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.templates)),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => unawaited(_showTemplateEditor()),
        icon: const Icon(Icons.add),
        label: Text(l10n.newTemplate),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildContent(),
      ),
    );
  }

  /// 主体：三态分发。骨架/错误/空态也包在可滚动容器里，任何状态可下拉刷新。
  Widget _buildContent() {
    final l10n = AppLocalizations.of(context);
    if (_isLoading && _templates.isEmpty) {
      return _scrollableBody(const SkeletonList(itemCount: 6));
    }
    if (_error != null && _templates.isEmpty) {
      return _scrollableBody(
        ErrorState(
          message: friendlyError(_error, l10n),
          onRetry: () => unawaited(_load()),
        ),
      );
    }
    if (_templates.isEmpty) {
      return _scrollableBody(
        EmptyState(
          icon: Icons.description_outlined,
          title: l10n.noTemplates,
          message: l10n.noTemplatesDesc,
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
    final l10n = AppLocalizations.of(context);
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
                    l10n.variableCount(variables.length),
                    style: textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
              const SizedBox(width: AppSpacing.sm),
              PopupMenuButton<String>(
                itemBuilder: (BuildContext menuContext) =>
                    <PopupMenuEntry<String>>[
                  PopupMenuItem<String>(
                    value: 'edit',
                    child: Row(
                      children: <Widget>[
                        const Icon(Icons.edit_outlined, size: 20),
                        const SizedBox(width: AppSpacing.sm),
                        Text(l10n.editTemplate),
                      ],
                    ),
                  ),
                  PopupMenuItem<String>(
                    value: 'delete',
                    child: Row(
                      children: <Widget>[
                        Icon(
                          Icons.delete_outline,
                          size: 20,
                          color: scheme.error,
                        ),
                        const SizedBox(width: AppSpacing.sm),
                        Text(
                          l10n.delete,
                          style: TextStyle(color: scheme.error),
                        ),
                      ],
                    ),
                  ),
                ],
                onSelected: (String action) {
                  if (action == 'edit') {
                    unawaited(_showTemplateEditor(template));
                  } else if (action == 'delete') {
                    unawaited(_deleteTemplate(template));
                  }
                },
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            preview.isEmpty ? l10n.emptyTemplateContent : preview,
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
              label: Text(l10n.useTemplate),
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
/// 顶部提示进度（第 x / N 个）与变量名；输入框经 [initialValue] 预填
/// 回退链结果（全局存储值 → 语法默认值，见 [TemplatesScreen] 使用流程），
/// helperText 提示「默认值（可选）」；取消返回 null（调用方中止整个流程），
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
    final l10n = AppLocalizations.of(context);

    return AlertDialog(
      title: Text(l10n.fillVariableTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            l10n.variableProgress(widget.step, widget.total),
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
              // 模板占位符提示渲染为 {{变量名}}（双花括号语义由 Dart 侧拼接，
              // arb 模板为严格 ICU 语法，不能放字面量花括号）
              hintText: l10n.variableInputHint('{{${widget.variableName}}}'),
              helperText: l10n.variableDefaultValue,
            ),
            onSubmitted: (String value) => _submit(),
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
          child: Text(isLast ? l10n.done : l10n.nextItem),
        ),
      ],
    );
  }
}

/// 模板编辑对话框（C4）：新建 / 编辑共用，[template] 为 null 表示新建。
///
/// 字段：名称（必填，为空时 errorText 提示 templateNameRequired）+
/// 内容（多行，helperText 提示 `{{变量}}` 语法，即 templateVarsHint）。
/// 确认返回 `(name, content)` 记录（名称已 trim），取消 / 关闭返回 null。
class _TemplateEditorDialog extends StatefulWidget {
  const _TemplateEditorDialog({this.template});

  /// 编辑目标；null 表示新建
  final ClipboardTemplate? template;

  @override
  State<_TemplateEditorDialog> createState() => _TemplateEditorDialogState();
}

class _TemplateEditorDialogState extends State<_TemplateEditorDialog> {
  late final TextEditingController _nameController =
      TextEditingController(text: widget.template?.name ?? '');
  late final TextEditingController _contentController =
      TextEditingController(text: widget.template?.content ?? '');

  bool _nameError = false;

  void _submit() {
    final String name = _nameController.text.trim();
    if (name.isEmpty) {
      setState(() => _nameError = true);
      return;
    }
    Navigator.of(context).pop((name, _contentController.text));
  }

  @override
  void dispose() {
    _nameController.dispose();
    _contentController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final bool isEditing = widget.template != null;

    return AlertDialog(
      title: Text(isEditing ? l10n.editTemplate : l10n.newTemplate),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            TextField(
              controller: _nameController,
              autofocus: !isEditing,
              decoration: InputDecoration(
                labelText: l10n.templateName,
                errorText: _nameError ? l10n.templateNameRequired : null,
              ),
              onChanged: (String value) {
                if (_nameError && value.trim().isNotEmpty) {
                  setState(() => _nameError = false);
                }
              },
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _contentController,
              maxLines: 6,
              minLines: 4,
              decoration: InputDecoration(
                labelText: l10n.templateContent,
                alignLabelWithHint: true,
                helperText: l10n.templateVarsHint,
              ),
            ),
          ],
        ),
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
}
