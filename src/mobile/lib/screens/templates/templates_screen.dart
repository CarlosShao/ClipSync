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
import '../../widgets/common/mono_text.dart';
import '../../widgets/common/skeleton_list.dart';
import '../../widgets/common/type_badge.dart';

/// 模板库页（T4.2 / C4 模板增强 / Obsidian v2）。
///
/// 页面结构：单列模板卡片列表（AppCard v2：名称 + 参数占位符预览 MonoText + 分类标签 +
/// 「使用/快速填充」按钮 + 编辑/删除菜单），FAB「新建模板」，顶部 AppBar 标题「模板库」，
/// 支持下拉刷新。
///
/// 新建/编辑/变量填充/结果弹层全面采用 [AppShapesV2.xl] (28dp) 与 tokens_v2 表面分层。
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
    // 渲染成功后记住本次非空输入，下次使用同变量时自动预填
    await _rememberInputs(values);
    await _showResultDialog(rendered);
  }

  /// `{{name}}` / `{{name:default}}` 占位符原始内容 →（变量名, 语法默认值）。
  static (String, String?) _parseVariableToken(String raw) {
    final int idx = raw.indexOf(':');
    if (idx <= 0) {
      return (raw.trim(), null);
    }
    return (raw.substring(0, idx).trim(), raw.substring(idx + 1).trim());
  }

  /// 渲染成功后把本次输入回写全局变量存储（PUT /api/template-variables）。
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

  /// 渲染结果对话框：支持文本选择与一键「复制全文」，圆角 28dp。
  Future<void> _showResultDialog(String rendered) async {
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) {
        final bool isDark = Theme.of(dialogContext).brightness == Brightness.dark;
        return AlertDialog(
          shape: AppShapesV2.shapeXl,
          title: Row(
            children: <Widget>[
              Container(
                padding: const EdgeInsets.all(AppSpacing.xs),
                decoration: BoxDecoration(
                  color: AppColorsV2.brandPrimaryLight.withValues(alpha: 0.12),
                  borderRadius: AppShapesV2.brXs,
                ),
                child: const Icon(
                  Icons.auto_awesome_rounded,
                  size: 20,
                  color: AppColorsV2.brandPrimaryLight,
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(l10n.renderResultTitle)),
            ],
          ),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 360, minWidth: 280),
            child: Container(
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(
                color: AppColorsV2.surfaceFor(tier: SurfaceTier.high, isDark: isDark),
                borderRadius: AppShapesV2.brSm,
                border: Border.all(color: AppColorsV2.borderFor(isDark: isDark)),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  rendered,
                  style: const TextStyle(
                    fontFamily: 'JetBrains Mono',
                    fontFamilyFallback: <String>['monospace'],
                    fontSize: 13,
                    height: 1.5,
                  ),
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
              icon: const Icon(Icons.copy_all_rounded, size: 18),
              label: Text(l10n.copyAll),
            ),
          ],
        );
      },
    );
  }

  // ---------------------------------------------------------------------------
  // 模板 CRUD（C4）
  // ---------------------------------------------------------------------------

  /// 新建 / 编辑模板：弹出 28dp 编辑对话框。
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

  /// 删除模板：确认对话框采用 28dp 圆角。
  Future<void> _deleteTemplate(ClipboardTemplate template) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        final dialogL10n = AppLocalizations.of(dialogContext);
        return AlertDialog(
          shape: AppShapesV2.shapeXl,
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
                  fontWeight: FontWeight.w600,
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
      appBar: AppBar(
        title: Text(l10n.templates),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => unawaited(_showTemplateEditor()),
        icon: const Icon(Icons.add_rounded),
        label: Text(l10n.newTemplate),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildContent(),
      ),
    );
  }

  /// 主体：三态分发。
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
          illustration: EmptyStateIllustration.generic,
          icon: Icons.description_outlined,
          title: l10n.noTemplates,
          message: l10n.noTemplatesDesc,
          actionLabel: l10n.newTemplate,
          onAction: () => unawaited(_showTemplateEditor()),
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
        AppSpacing.xxl * 2,
      ),
      itemCount: _templates.length,
      separatorBuilder: (BuildContext context, int index) =>
          const SizedBox(height: AppSpacing.md),
      itemBuilder: (BuildContext context, int index) =>
          _buildTemplateCard(_templates[index]),
    );
  }

  /// 模板卡片 (Obsidian v2)：
  /// - 单列卡片 AppCard v2 (SurfaceTier.low)；
  /// - 模板名称、参数占位符预览 (MonoText)、分类标签；
  /// - 快速填充与一键复制入口。
  Widget _buildTemplateCard(ClipboardTemplate template) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final l10n = AppLocalizations.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final List<String> variables = template.variableNames;
    final String preview = template.content.trim();

    return AppCard(
      surfaceTier: SurfaceTier.low,
      borderRadius: AppShapesV2.brMd,
      onTap: () => unawaited(_useTemplate(template)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // Header: 图标 + 模板名称 + 分类标签/变量徽标 + 菜单
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColorsV2.surfaceFor(tier: SurfaceTier.high, isDark: isDark),
                  borderRadius: AppShapesV2.brSm,
                ),
                child: Icon(
                  variables.isNotEmpty
                      ? Icons.data_object_rounded
                      : Icons.notes_rounded,
                  size: 20,
                  color: variables.isNotEmpty
                      ? (isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight)
                      : scheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      template.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              // 分类与变量标签
              if (variables.isNotEmpty)
                TypeBadge(
                  contentType: 'code',
                  customLabel: l10n.variableCount(variables.length),
                )
              else
                const TypeBadge(
                  contentType: 'text',
                  customLabel: '快捷文本',
                ),
              const SizedBox(width: AppSpacing.xs),
              PopupMenuButton<String>(
                icon: Icon(
                  Icons.more_vert_rounded,
                  size: 20,
                  color: scheme.onSurfaceVariant,
                ),
                shape: AppShapesV2.shapeMd,
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
                          Icons.delete_outline_rounded,
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

          // 参数占位符预览 (MonoText 徽章行)
          if (variables.isNotEmpty) ...<Widget>[
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: variables.take(4).map((String rawVar) {
                final (String varName, _) = _parseVariableToken(rawVar);
                return Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: AppColorsV2.surfaceFor(tier: SurfaceTier.high, isDark: isDark),
                    borderRadius: AppShapesV2.brXs,
                    border: Border.all(
                      color: AppColorsV2.borderFor(isDark: isDark),
                      width: 0.8,
                    ),
                  ),
                  child: MonoText(
                    '{{$varName}}',
                    style: TextStyle(
                      fontSize: 11,
                      color: isDark ? AppColorsV2.typeCodeDark : AppColorsV2.typeCodeLight,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                );
              }).toList(),
            ),
          ],

          // 内容预览区域：嵌入式代码/模板块
          const SizedBox(height: AppSpacing.sm),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.md,
              vertical: AppSpacing.sm,
            ),
            decoration: BoxDecoration(
              color: AppColorsV2.surfaceFor(tier: SurfaceTier.base, isDark: isDark),
              borderRadius: AppShapesV2.brSm,
              border: Border.all(
                color: AppColorsV2.borderFor(isDark: isDark),
                width: 0.5,
              ),
            ),
            child: MonoText(
              preview.isEmpty ? l10n.emptyTemplateContent : preview,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
                height: 1.45,
              ),
            ),
          ),

          // 底部操作区：一键快速填充 / 使用
          const SizedBox(height: AppSpacing.md),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: <Widget>[
              FilledButton.tonalIcon(
                onPressed: () => unawaited(_useTemplate(template)),
                style: FilledButton.styleFrom(
                  shape: AppShapesV2.shapePill,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                ),
                icon: const Icon(Icons.play_arrow_rounded, size: 18),
                label: Text(l10n.useTemplate),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 全页可滚动包装：支持下拉刷新。
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

/// 变量填写对话框：采用 [AppShapesV2.xl] (28dp)。
class _VariableInputDialog extends StatefulWidget {
  const _VariableInputDialog({
    required this.variableName,
    required this.step,
    required this.total,
    this.initialValue,
  });

  final String variableName;
  final int step;
  final int total;
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
    final bool isLast = widget.step >= widget.total;
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;

    return AlertDialog(
      shape: AppShapesV2.shapeXl,
      title: Row(
        children: <Widget>[
          Container(
            padding: const EdgeInsets.all(AppSpacing.xs),
            decoration: BoxDecoration(
              color: AppColorsV2.brandPrimaryLight.withValues(alpha: 0.12),
              borderRadius: AppShapesV2.brXs,
            ),
            child: const Icon(
              Icons.tune_rounded,
              size: 20,
              color: AppColorsV2.brandPrimaryLight,
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(l10n.fillVariableTitle)),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                l10n.variableProgress(widget.step, widget.total),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColorsV2.surfaceFor(tier: SurfaceTier.high, isDark: isDark),
                  borderRadius: AppShapesV2.brXs,
                ),
                child: MonoText(
                  '{{${widget.variableName}}}',
                  style: TextStyle(
                    fontSize: 11,
                    color: isDark ? AppColorsV2.typeCodeDark : AppColorsV2.typeCodeLight,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _controller,
            autofocus: true,
            decoration: InputDecoration(
              labelText: widget.variableName,
              hintText: l10n.variableInputHint('{{${widget.variableName}}}'),
              helperText: l10n.variableDefaultValue,
              border: OutlineInputBorder(borderRadius: AppShapesV2.brSm),
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

/// 模板编辑对话框：采用 [AppShapesV2.xl] (28dp)。
class _TemplateEditorDialog extends StatefulWidget {
  const _TemplateEditorDialog({this.template});

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
      shape: AppShapesV2.shapeXl,
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
                border: OutlineInputBorder(borderRadius: AppShapesV2.brSm),
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
              style: const TextStyle(
                fontFamily: 'JetBrains Mono',
                fontFamilyFallback: <String>['monospace'],
                fontSize: 13,
              ),
              decoration: InputDecoration(
                labelText: l10n.templateContent,
                alignLabelWithHint: true,
                helperText: l10n.templateVarsHint,
                border: OutlineInputBorder(borderRadius: AppShapesV2.brSm),
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
