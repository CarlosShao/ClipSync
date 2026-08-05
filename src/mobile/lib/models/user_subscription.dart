/// 用户订阅模型
///
/// 对应后端 GET /api/subscriptions/current 返回的 `subscription` 字段结构：
///   { id, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, trialEnd }
/// planName 由同一响应里的 `plan.name` 携带，前端在使用时从该结构读取。
class UserSubscription {
  final String? id;
  final String? planName;
  final String status;
  final DateTime? currentPeriodStart;
  final DateTime? currentPeriodEnd;
  final bool autoRenew;
  final bool cancelAtPeriodEnd;
  final DateTime? trialEnd;

  UserSubscription({
    this.id,
    this.planName,
    this.status = 'active',
    this.currentPeriodStart,
    this.currentPeriodEnd,
    this.autoRenew = true,
    this.cancelAtPeriodEnd = false,
    this.trialEnd,
  });

  factory UserSubscription.fromJson(Map<String, dynamic> json) {
    return UserSubscription(
      id: json['id']?.toString(),
      planName: json['planName'] ?? json['plan_name']?.toString(),
      status: json['status']?.toString() ?? 'active',
      currentPeriodStart: _parseDate(json['currentPeriodStart'] ?? json['current_period_start']),
      currentPeriodEnd: _parseDate(json['currentPeriodEnd'] ?? json['current_period_end']),
      autoRenew: json['autoRenew'] ?? json['auto_renew'] ?? true,
      cancelAtPeriodEnd: json['cancelAtPeriodEnd'] ?? json['cancel_at_period_end'] ?? false,
      trialEnd: _parseDate(json['trialEnd'] ?? json['trial_end']),
    );
  }

  static DateTime? _parseDate(dynamic value) {
    if (value == null) return null;
    if (value is DateTime) return value;
    return DateTime.tryParse(value.toString());
  }
}
