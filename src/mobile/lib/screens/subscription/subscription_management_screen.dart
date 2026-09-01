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
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';
import '../../widgets/common/section_header.dart';

/// 订阅管理页（T4.4 去 mock 重写，替代已删除的
/// lib/screens/subscription_management_screen.dart）。
///
/// 数据全部来自真实后端（[SubscriptionApiService]，契约见
/// src/server/src/routes/subscriptions.js / invoices.js）：
/// - GET /api/subscriptions/current：当前订阅 + 生效套餐；
/// - GET /api/subscriptions/plans：可用套餐列表（公开接口）；
/// - POST /api/subscriptions/cancel | resume：期末取消 / 恢复续订；
/// - GET /api/invoices：账单记录（替代旧页失效的 /api/payments/history）。
///
/// 页面结构：当前订阅卡片（套餐名/状态/到期时间，无则显示「—」，
/// 末尾按状态给出取消/恢复入口）→ 桌面端支付提示 → 套餐列表
/// （当前套餐高亮，购买按钮替换为「请在桌面端完成支付」提示，
/// 移动端不做真实支付）→ 账单记录。
///
/// 三态：SkeletonList（加载中）/ ErrorState（失败可重试）/
/// RefreshIndicator + 列表（数据），支持下拉刷新与 AppBar 刷新。
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

  /// 首次进入与下拉刷新共用：加载当前订阅 + 套餐列表，账单异步跟加载。
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
      // 账单为辅助信息：失败静默隐藏，不影响订阅主流程展示
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

  /// 账单列表：仅刷新 [CurrentSubscriptionData] 不涉及的部分，
  /// 失败时保持空列表（区块显示「暂无账单记录」）。
  Future<void> _loadInvoices(String? token) async {
    try {
      final invoices = await SubscriptionApiService.getInvoices(token);
      if (!mounted) {
        return;
      }
      setState(() {
        _invoices = invoices;
      });
    } on Exception catch (_) {
      // 账单加载失败不阻塞订阅管理主流程，区块回落为空态
    }
  }

  /// 取消/恢复成功后仅刷新当前订阅（套餐列表与高亮不受影响）。
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

  /// 取消订阅：确认对话框 → POST /api/subscriptions/cancel → 刷新当前订阅。
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

  /// 恢复订阅：确认对话框 → POST /api/subscriptions/resume → 刷新当前订阅。
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

  /// 取消/恢复共用的确认对话框；返回 null 表示用户关闭对话框。
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

  /// 订阅状态文案（仅在有活跃订阅时调用）。
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

  /// 日期格式化为 yyyy-MM-dd，空值显示「—」。
  String _formatDate(DateTime? date) {
    if (date == null) {
      return '—';
    }
    final month = date.month.toString().padLeft(2, '0');
    final day = date.day.toString().padLeft(2, '0');
    return '${date.year}-$month-$day';
  }

  /// 账单时间：后端返回 ISO 字符串，截取日期部分展示。
  String _formatInvoiceDate(Map<String, dynamic> invoice) {
    final raw = invoice['createdAt']?.toString() ?? '';
    return raw.length >= 10 ? raw.substring(0, 10) : (raw.isEmpty ? '—' : raw);
  }

  /// 账单金额文案。
  String _formatInvoiceAmount(Map<String, dynamic> invoice) {
    final amount = invoice['amount'] as num?;
    return amount == null ? '—' : '¥${amount.toStringAsFixed(2)}';
  }

  /// 套餐价格文案（A3 解耦：model 只提供结构化数据，货币符号/周期后缀
  /// 由 UI 经 l10n 组装）。
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

  /// 套餐特性文案列表：数量类经 l10n 占位符插值，能力类按布尔字段显隐，
  /// 末尾追加服务端下发的 paywallFeatureN（原样展示）。
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
  // 页面骨架
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
            icon: const Icon(Icons.refresh),
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
                      AppSpacing.xxl,
                    ),
                    children: <Widget>[
                      _buildCurrentSubscriptionCard(scheme),
                      const SizedBox(height: AppSpacing.lg),
                      _buildDesktopPaymentHint(scheme),
                      SectionHeader(title: l10n.availablePlans),
                      ..._plans.map(_buildPlanCard),
                      SectionHeader(title: l10n.billingRecords),
                      ..._buildInvoiceCards(scheme),
                    ],
                  ),
                ),
    );
  }

  // ---------------------------------------------------------------------------
  // 当前订阅卡片
  // ---------------------------------------------------------------------------

  Widget _buildCurrentSubscriptionCard(ColorScheme scheme) {
    final l10n = AppLocalizations.of(context);
    final plan = _current?.plan;
    final subscription = _current?.subscription;

    final statusChip = subscription == null
        ? null
        : _buildStatusChip(scheme, subscription);

    return AppCard(
      borderColor: scheme.outlineVariant,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(plan?.icon ?? Icons.card_membership, color: scheme.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      plan?.name ?? '—',
                      style: Theme.of(context).textTheme.titleLarge,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (plan?.description case final String description)
                      Text(
                        description,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: scheme.onSurfaceVariant,
                            ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
              if (statusChip != null) statusChip,
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          _buildDetailRow(
            l10n.subscriptionStatusLabel,
            subscription == null ? '—' : _statusLabelOf(subscription, l10n),
          ),
          _buildDetailRow(
            l10n.expiryDate,
            _formatDate(subscription?.currentPeriodEnd),
          ),
          if (subscription?.status == 'trial' &&
              subscription?.trialEnd != null)
            _buildDetailRow(
              l10n.trialEndDate,
              _formatDate(subscription?.trialEnd),
            ),
          if (subscription?.cancelAtPeriodEnd ?? false)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                l10n.subscriptionEndsOn(
                  _formatDate(subscription?.currentPeriodEnd),
                ),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
              ),
            ),
          // 取消 / 恢复入口（与后端能力对齐：cancel/resume 仅作用于
          // status=active 的订阅，试用期与无订阅时不展示）
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
                          child: Text(l10n.resumeSubscription),
                        )
                      : OutlinedButton(
                          onPressed: _cancelSubscription,
                          style: OutlinedButton.styleFrom(
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
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Text(
        _statusLabelOf(subscription, AppLocalizations.of(context)),
        style: Theme.of(context)
            .textTheme
            .labelSmall
            ?.copyWith(color: foreground),
      ),
    );
  }

  /// 键值详情行：[value] 为空时显示「—」。
  Widget _buildDetailRow(String label, String? value) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.xs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 72,
            child: Text(
              label,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
            ),
          ),
          Expanded(
            child: Text(
              value ?? '—',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 桌面端支付提示 + 套餐列表
  // ---------------------------------------------------------------------------

  /// 桌面端支付提示：移动端不承载支付（购买按钮已全部替换为本提示）。
  Widget _buildDesktopPaymentHint(ColorScheme scheme) {
    return AppCard(
      borderColor: scheme.primaryContainer,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(Icons.desktop_windows_outlined, color: scheme.primary, size: 20),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              AppLocalizations.of(context).desktopPaymentHint,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }

  /// 套餐卡片：真实 plans 渲染，当前套餐描边高亮 + 「当前套餐」徽标；
  /// 非当前付费套餐的购买按钮替换为「请在桌面端完成支付」提示。
  Widget _buildPlanCard(SubscriptionPlan plan) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final l10n = AppLocalizations.of(context);
    final bool isCurrent = plan.id == _currentPlanId;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: AppCard(
        borderColor: isCurrent ? scheme.primary : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Icon(plan.icon, color: plan.color),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(plan.name, style: textTheme.titleMedium),
                      if (plan.description case final String description)
                        Text(
                          description,
                          style: textTheme.bodySmall
                              ?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: <Widget>[
                    Text(_planPriceText(plan, l10n), style: textTheme.titleMedium),
                    if (isCurrent)
                      Padding(
                        padding: const EdgeInsets.only(top: AppSpacing.xs),
                        child: Text(
                          l10n.currentPlanBadge,
                          style: textTheme.labelSmall
                              ?.copyWith(color: scheme.primary),
                        ),
                      ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            ..._planFeatureLines(plan, l10n).map(
              (String feature) => Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(Icons.check, size: 16, color: scheme.primary),
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
            // 购买按钮替换为桌面端支付提示（T4.4：移动端不做真实支付）
            if (!isCurrent && plan.price > 0) ...<Widget>[
              const SizedBox(height: AppSpacing.md),
              Row(
                children: <Widget>[
                  Icon(
                    Icons.desktop_windows_outlined,
                    size: 16,
                    color: scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Text(
                    l10n.payOnDesktop,
                    style: textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ],
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
        Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
          child: Center(
            child: Text(
              AppLocalizations.of(context).noInvoices,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
            ),
          ),
        ),
      ];
    }
    return _invoices.map((Map<String, dynamic> invoice) {
      final bool paid = invoice['status']?.toString() == 'paid';
      final String invoiceNo = invoice['invoiceNo']?.toString() ?? '—';
      final String planName = invoice['planName']?.toString() ?? '';
      return Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.md),
        child: AppCard(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            children: <Widget>[
              Icon(
                paid ? Icons.check_circle : Icons.receipt_long,
                size: 20,
                color: paid ? scheme.primary : scheme.onSurfaceVariant,
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      planName.isEmpty ? invoiceNo : '$invoiceNo · $planName',
                      style: Theme.of(context).textTheme.bodyMedium,
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
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ],
          ),
        ),
      );
    }).toList(growable: false);
  }
}
