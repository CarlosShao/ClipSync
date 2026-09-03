import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_localizations.dart';
import '../../models/subscription_plan.dart';
import '../../models/user_subscription.dart';
import '../../providers/auth_provider.dart';
import '../../services/app_exception.dart';
import '../../services/subscription_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/app_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/section_divider.dart';
import '../../widgets/common/skeleton_list.dart';

/// 订阅管理页（T4.4 / Obsidian v2）。
///
/// 视觉与交互规格：
/// - 当前套餐卡片：尊享渐变顶边 (gradientLine)、徽标、权益清单；
/// - 升级方案对比卡片：对比定价、权益列表、FilledButton.tonal / FilledButton 按钮；
/// - 历史账单明细列表：状态图标、时间、金额；
/// - 全面采用 Obsidian v2 Token 与 28dp (AppShapesV2.xl) 对话框。
class SubscriptionManagementScreen extends StatefulWidget {
  const SubscriptionManagementScreen({super.key});

  @override
  State<SubscriptionManagementScreen> createState() =>
      _SubscriptionManagementScreenState();
}

class _SubscriptionManagementScreenState
    extends State<SubscriptionManagementScreen> {
  CurrentSubscriptionData? _current;
  List<SubscriptionPlan> _plans = const <SubscriptionPlan>[];
  List<Map<String, dynamic>> _invoices = const <Map<String, dynamic>>[];
  bool _isLoading = false;
  bool _isMutating = false;

  /// 最近一次失败的原始错误对象（UI 层经 friendlyError 映射 l10n 文案）
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// 当前生效套餐 id（用于套餐列表高亮匹配）。
  String? get _currentPlanId => _current?.plan?.id;

  // ---------------------------------------------------------------------------
  // 数据加载
  // ---------------------------------------------------------------------------

  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final token = context.read<AuthProvider>().token;
      final current = await SubscriptionApiService.getCurrentSubscription(
        token,
      );
      final plans = await SubscriptionApiService.getPlans();
      if (!mounted) {
        return;
      }
      setState(() {
        _current = current;
        _plans = plans;
        _isLoading = false;
      });
      unawaited(_loadInvoices(token));
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

  Future<void> _loadInvoices(String? token) async {
    try {
      final invoices = await SubscriptionApiService.getInvoices(token);
      if (!mounted) {
        return;
      }
      setState(() {
        _invoices = invoices;
      });
    } on Exception {
      // 账单加载失败不阻塞订阅管理主流程
    }
  }

  Future<void> _refreshCurrent() async {
    final token = context.read<AuthProvider>().token;
    final current = await SubscriptionApiService.getCurrentSubscription(token);
    if (!mounted) {
      return;
    }
    setState(() {
      _current = current;
    });
  }

  // ---------------------------------------------------------------------------
  // 取消 / 恢复订阅
  // ---------------------------------------------------------------------------

  Future<void> _cancelSubscription() async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await _confirmAction(
      title: l10n.cancelSubscription,
      message: l10n.cancelSubscriptionConfirm,
      confirmLabel: l10n.cancelSubscription,
    );
    if (confirmed != true || !mounted) {
      return;
    }

    setState(() {
      _isMutating = true;
    });
    try {
      final token = context.read<AuthProvider>().token;
      await SubscriptionApiService.cancelSubscription(token);
      await _refreshCurrent();
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.subscriptionCancelled)),
      );
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(friendlyError(e, l10n))),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isMutating = false;
        });
      }
    }
  }

  Future<void> _resumeSubscription() async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await _confirmAction(
      title: l10n.resumeSubscription,
      message: l10n.resumeSubscriptionConfirm,
      confirmLabel: l10n.resumeSubscription,
    );
    if (confirmed != true || !mounted) {
      return;
    }

    setState(() {
      _isMutating = true;
    });
    try {
      final token = context.read<AuthProvider>().token;
      await SubscriptionApiService.resumeSubscription(token);
      await _refreshCurrent();
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.subscriptionResumed)),
      );
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(friendlyError(e, l10n))),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isMutating = false;
        });
      }
    }
  }

  Future<bool?> _confirmAction({
    required String title,
    required String message,
    required String confirmLabel,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final l10n = AppLocalizations.of(context);
    return showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        shape: AppShapesV2.shapeXl,
        title: Text(title),
        content: Text(message),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(l10n.thinkAgain),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            style: FilledButton.styleFrom(
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
            ),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 展示辅助
  // ---------------------------------------------------------------------------

  String _statusLabelOf(UserSubscription subscription, AppLocalizations l10n) {
    if (subscription.cancelAtPeriodEnd) {
      return l10n.statusCancelScheduled;
    }
    switch (subscription.status) {
      case 'active':
        return l10n.statusActive;
      case 'trial':
        return l10n.statusTrial;
      default:
        return subscription.status;
    }
  }

  String _formatDate(DateTime? date) {
    if (date == null) {
      return '—';
    }
    final month = date.month.toString().padLeft(2, '0');
    final day = date.day.toString().padLeft(2, '0');
    return '${date.year}-$month-$day';
  }

  String _formatInvoiceDate(Map<String, dynamic> invoice) {
    final raw = invoice['createdAt']?.toString() ?? '';
    return raw.length >= 10 ? raw.substring(0, 10) : (raw.isEmpty ? '—' : raw);
  }

  String _formatInvoiceAmount(Map<String, dynamic> invoice) {
    final amount = invoice['amount'] as num?;
    return amount == null ? '—' : '¥${amount.toStringAsFixed(2)}';
  }

  String _planPriceText(SubscriptionPlan plan, AppLocalizations l10n) {
    if (plan.isFree) {
      return l10n.planFree;
    }
    final String symbol = plan.currency == 'CNY' ? '¥' : r'$';
    final String period = plan.billingPeriod == BillingPeriod.yearly
        ? l10n.perYear
        : l10n.perMonth;
    return '$symbol${plan.price.toStringAsFixed(2)}$period';
  }

  List<String> _planFeatureLines(SubscriptionPlan plan, AppLocalizations l10n) {
    return <String>[
      l10n.planMaxDevices(plan.maxDevices),
      l10n.planDailyClips(plan.maxClipboardPerDay),
      l10n.planStorage(plan.maxStorageMB),
      if (plan.hasOcr) l10n.featureOcr,
      if (plan.hasPrioritySync) l10n.featurePrioritySync,
      if (plan.hasAICategories) l10n.featureAiClassify,
      if (plan.hasTeamSharing) l10n.featureTeamShare,
      for (final String? feature in <String?>[
        plan.paywallFeature1,
        plan.paywallFeature2,
        plan.paywallFeature3,
      ])
        if (feature != null && feature.isNotEmpty) feature,
    ];
  }

  // ---------------------------------------------------------------------------
  // 页面构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final l10n = AppLocalizations.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.subscriptionManagement),
        centerTitle: true,
        actions: <Widget>[
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: l10n.refresh,
            onPressed: _isLoading ? null : _load,
          ),
        ],
      ),
      body: _isLoading
          ? const SkeletonList(itemCount: 6)
          : _error != null
              ? ErrorState(
                  message: friendlyError(_error, l10n),
                  onRetry: _load,
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.lg,
                      AppSpacing.sm,
                      AppSpacing.lg,
                      AppSpacing.xxl * 2,
                    ),
                    children: <Widget>[
                      _buildCurrentSubscriptionCard(scheme),
                      const SizedBox(height: AppSpacing.lg),
                      _buildDesktopPaymentHint(),
                      const SizedBox(height: AppSpacing.md),
                      SectionDivider(title: l10n.availablePlans),
                      const SizedBox(height: AppSpacing.xs),
                      ..._plans.map(_buildPlanCard),
                      const SizedBox(height: AppSpacing.md),
                      SectionDivider(title: l10n.billingRecords),
                      const SizedBox(height: AppSpacing.xs),
                      ..._buildInvoiceCards(scheme),
                    ],
                  ),
                ),
    );
  }

  // ---------------------------------------------------------------------------
  // 当前套餐卡片（尊享渐变顶边 + 徽标 + 权益清单）
  // ---------------------------------------------------------------------------

  Widget _buildCurrentSubscriptionCard(ColorScheme scheme) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final plan = _current?.plan;
    final subscription = _current?.subscription;

    final Color brandPurple = isDark
        ? AppColorsV2.brandPrimaryDark
        : AppColorsV2.brandPrimaryLight;

    return AppCard(
      surfaceTier: SurfaceTier.low,
      borderRadius: AppShapesV2.brLg,
      gradientLine: const LinearGradient(
        colors: <Color>[
          Color(0xFF5A4BD1),
          Color(0xFFA855F7),
          Color(0xFF38BDF8),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Header: 图标 + 套餐名 + 尊享徽标
          Row(
            children: <Widget>[
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: <Color>[Color(0xFF5A4BD1), Color(0xFFA855F7)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: AppShapesV2.brSm,
                ),
                child: Icon(
                  plan?.icon ?? Icons.workspace_premium_rounded,
                  color: Colors.white,
                  size: 24,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Flexible(
                          child: Text(
                            plan?.name ?? '—',
                            style: theme.textTheme.titleLarge?.copyWith(
                              fontWeight: FontWeight.bold,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: AppSpacing.xs),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: brandPurple.withValues(alpha: 0.14),
                            borderRadius: AppShapesV2.brPill,
                          ),
                          child: Text(
                            l10n.currentPlanBadge,
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                              color: brandPurple,
                            ),
                          ),
                        ),
                      ],
                    ),
                    if (plan?.description case final String description)
                      Text(
                        description,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
              if (subscription != null) _buildStatusChip(scheme, subscription),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),

          // 关键日期详情行
          Container(
            padding: const EdgeInsets.all(AppSpacing.md),
            decoration: BoxDecoration(
              color: AppColorsV2.surfaceFor(
                tier: SurfaceTier.base,
                isDark: isDark,
              ),
              borderRadius: AppShapesV2.brSm,
              border: Border.all(
                color: AppColorsV2.borderFor(isDark: isDark),
                width: 0.5,
              ),
            ),
            child: Column(
              children: <Widget>[
                _buildDetailRow(
                  l10n.subscriptionStatusLabel,
                  subscription == null ? '—' : _statusLabelOf(subscription, l10n),
                ),
                const SizedBox(height: AppSpacing.xs),
                _buildDetailRow(
                  l10n.expiryDate,
                  _formatDate(subscription?.currentPeriodEnd),
                ),
                if (subscription?.status == 'trial' &&
                    subscription?.trialEnd != null) ...<Widget>[
                  const SizedBox(height: AppSpacing.xs),
                  _buildDetailRow(
                    l10n.trialEndDate,
                    _formatDate(subscription?.trialEnd),
                  ),
                ],
              ],
            ),
          ),

          // 权益清单
          if (plan != null) ...<Widget>[
            const SizedBox(height: AppSpacing.md),
            Text(
              '套餐包含权益',
              style: theme.textTheme.labelMedium?.copyWith(
                fontWeight: FontWeight.w600,
                color: scheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            ..._planFeatureLines(plan, l10n).map(
              (String feature) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(
                      Icons.check_circle_rounded,
                      size: 16,
                      color: brandPurple,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Text(
                        feature,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurface,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],

          if (subscription?.cancelAtPeriodEnd ?? false)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Text(
                l10n.subscriptionEndsOn(
                  _formatDate(subscription?.currentPeriodEnd),
                ),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: AppColorsV2.dangerColor(context),
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),

          // 取消 / 恢复操作按钮
          if (subscription != null && subscription.status == 'active') ...<Widget>[
            const SizedBox(height: AppSpacing.lg),
            SizedBox(
              width: double.infinity,
              child: _isMutating
                  ? const Center(
                      child: SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(),
                      ),
                    )
                  : subscription.cancelAtPeriodEnd
                      ? FilledButton.tonal(
                          onPressed: _resumeSubscription,
                          style: FilledButton.styleFrom(
                            shape: AppShapesV2.shapeMd,
                          ),
                          child: Text(l10n.resumeSubscription),
                        )
                      : OutlinedButton(
                          onPressed: _cancelSubscription,
                          style: OutlinedButton.styleFrom(
                            shape: AppShapesV2.shapeMd,
                            foregroundColor: scheme.error,
                            side: BorderSide(color: scheme.error),
                          ),
                          child: Text(l10n.cancelSubscription),
                        ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildStatusChip(ColorScheme scheme, UserSubscription subscription) {
    final bool cancelled = subscription.cancelAtPeriodEnd;
    final (Color background, Color foreground) = cancelled
        ? (scheme.errorContainer, scheme.onErrorContainer)
        : subscription.status == 'trial'
            ? (scheme.tertiaryContainer, scheme.onTertiaryContainer)
            : (scheme.primaryContainer, scheme.onPrimaryContainer);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 3),
      decoration: BoxDecoration(
        color: background,
        borderRadius: AppShapesV2.brPill,
      ),
      child: Text(
        _statusLabelOf(subscription, AppLocalizations.of(context)),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: foreground,
        ),
      ),
    );
  }

  Widget _buildDetailRow(String label, String? value) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: <Widget>[
        Text(
          label,
          style: TextStyle(
            fontSize: 13,
            color: scheme.onSurfaceVariant,
          ),
        ),
        const Spacer(),
        Text(
          value ?? '—',
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
          ),
        ),
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // 桌面端支付提示
  // ---------------------------------------------------------------------------

  Widget _buildDesktopPaymentHint() {
    final theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;

    return AppCard(
      surfaceTier: SurfaceTier.low,
      borderRadius: AppShapesV2.brMd,
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AppColorsV2.surfaceFor(tier: SurfaceTier.high, isDark: isDark),
              borderRadius: AppShapesV2.brSm,
            ),
            child: Icon(
              Icons.desktop_windows_rounded,
              color: isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight,
              size: 20,
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Text(
              AppLocalizations.of(context).desktopPaymentHint,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 升级方案对比卡片
  // ---------------------------------------------------------------------------

  Widget _buildPlanCard(SubscriptionPlan plan) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final l10n = AppLocalizations.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final bool isCurrent = plan.id == _currentPlanId;
    final Color brandPurple = isDark
        ? AppColorsV2.brandPrimaryDark
        : AppColorsV2.brandPrimaryLight;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: AppCard(
        surfaceTier: SurfaceTier.low,
        borderRadius: AppShapesV2.brMd,
        borderColor: isCurrent ? brandPurple : null,
        gradientLine: isCurrent
            ? LinearGradient(
                colors: <Color>[
                  brandPurple,
                  brandPurple.withValues(alpha: 0.1),
                ],
              )
            : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: plan.color.withValues(alpha: 0.14),
                    borderRadius: AppShapesV2.brSm,
                  ),
                  child: Icon(plan.icon, color: plan.color, size: 20),
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        plan.name,
                        style: textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (plan.description case final String description)
                        Text(
                          description,
                          style: textTheme.bodySmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: <Widget>[
                    Text(
                      _planPriceText(plan, l10n),
                      style: textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: isCurrent ? brandPurple : scheme.onSurface,
                      ),
                    ),
                    if (isCurrent)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          l10n.currentPlanBadge,
                          style: textTheme.labelSmall?.copyWith(
                            color: brandPurple,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            ..._planFeatureLines(plan, l10n).map(
              (String feature) => Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(
                      Icons.check_rounded,
                      size: 16,
                      color: isCurrent ? brandPurple : scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Text(
                        feature,
                        style: textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            SizedBox(
              width: double.infinity,
              child: isCurrent
                  ? FilledButton.tonal(
                      onPressed: null,
                      style: FilledButton.styleFrom(
                        shape: AppShapesV2.shapeMd,
                      ),
                      child: Text(l10n.currentPlanBadge),
                    )
                  : FilledButton(
                      onPressed: null,
                      style: FilledButton.styleFrom(
                        shape: AppShapesV2.shapeMd,
                        backgroundColor: AppColorsV2.brandPrimaryLight,
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: <Widget>[
                          const Icon(Icons.desktop_windows_outlined, size: 16),
                          const SizedBox(width: AppSpacing.xs),
                          Text(l10n.payOnDesktop),
                        ],
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 账单记录
  // ---------------------------------------------------------------------------

  List<Widget> _buildInvoiceCards(ColorScheme scheme) {
    if (_invoices.isEmpty) {
      return <Widget>[
        EmptyState(
          illustration: EmptyStateIllustration.generic,
          icon: Icons.receipt_long_rounded,
          title: AppLocalizations.of(context).noInvoices,
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.xl),
        ),
      ];
    }
    return _invoices.map((Map<String, dynamic> invoice) {
      final bool paid = invoice['status']?.toString() == 'paid';
      final String invoiceNo = invoice['invoiceNo']?.toString() ?? '—';
      final String planName = invoice['planName']?.toString() ?? '';

      return Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.sm),
        child: AppCard(
          surfaceTier: SurfaceTier.low,
          borderRadius: AppShapesV2.brSm,
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.lg,
            vertical: AppSpacing.md,
          ),
          child: Row(
            children: <Widget>[
              Icon(
                paid ? Icons.check_circle_rounded : Icons.receipt_long_rounded,
                size: 20,
                color: paid ? AppColorsV2.typeColorLight : scheme.onSurfaceVariant,
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      planName.isEmpty ? invoiceNo : '$invoiceNo · $planName',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            fontWeight: FontWeight.w500,
                          ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      _formatInvoiceDate(invoice),
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Text(
                _formatInvoiceAmount(invoice),
                style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
              ),
            ],
          ),
        ),
      );
    }).toList(growable: false);
  }
}
