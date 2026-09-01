import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/subscription_plan.dart';
import '../models/user_subscription.dart';
import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 当前订阅查询结果（GET /api/subscriptions/current 的响应结构）。
///
/// - [subscription] 为 null 表示当前没有活跃订阅（后端约定：此时返回
///   `subscription: null`，并在 [plan] 中携带 Free 套餐信息）；
/// - [plan] 为当前生效套餐（无活跃订阅时为 Free 套餐，后端缺失时为 null）。
class CurrentSubscriptionData {
  const CurrentSubscriptionData({this.subscription, this.plan});

  /// 当前活跃订阅；null 表示未订阅（Free）。
  final UserSubscription? subscription;

  /// 当前生效套餐（含未订阅时的 Free 套餐）。
  final SubscriptionPlan? plan;
}

/// 订阅 API 服务（T4.4 去 mock 重写）。
///
/// 对齐后端契约（src/server/src/routes/subscriptions.js / invoices.js）：
/// - GET  /api/subscriptions/plans   公开接口，可用套餐列表
/// - GET  /api/subscriptions/current 认证，当前订阅 + 生效套餐
/// - POST /api/subscriptions/cancel  认证，期末取消（到期前订阅仍可用）
/// - POST /api/subscriptions/resume  认证，恢复已标记期末取消的订阅
/// - GET  /api/invoices              认证，账单列表
///
/// 支付不在移动端完成：升级/购买统一引导到桌面端操作，因此本服务
/// 不提供 subscribe 调用（旧 mock 订阅与 /api/payments/history 死调用
/// 一并移除）。所有失败路径均抛出携带后端 error 文案的异常，由调用方
/// 呈现，不再静默降级为模拟数据。
class SubscriptionApiService {
  static String get _baseUrl => '${ServerConfig.baseUrl}/api';

  /// 解析 Bearer 令牌：显式传入优先，否则读 TokenStore（secure storage）；
  /// 两者都缺失时抛出未登录异常。
  static Future<String> _resolveToken(String? token) async {
    final resolved = token ?? await TokenStore.getAccessToken();
    if (resolved == null || resolved.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    return resolved;
  }

  static Future<Map<String, String>> _authHeaders(String? token) async {
    return <String, String>{
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ${await _resolveToken(token)}',
    };
  }

  /// 从错误响应体提取后端 error 文案（`{ error: '...' }`）作为异常 detail，
  /// 非 JSON 响应体或缺失字段时回退到状态码描述（HTTP xxx）。
  static String? _serverDetail(http.Response response) {
    try {
      final Object? decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic> && decoded['error'] is String) {
        return decoded['error'] as String;
      }
    } on FormatException {
      // 非 JSON 响应体：回退到状态码
    }
    return 'HTTP ${response.statusCode}';
  }

  /// 解析套餐对象（/plans 与 /current 共用 camelCase 字段结构）。
  ///
  /// 说明：后端不返回 created_at/updated_at，而 [SubscriptionPlan] 的
  /// 这两个审计字段为必填，此处以当前时间占位（不参与任何展示逻辑）。
  static SubscriptionPlan _parsePlan(Map<String, dynamic> raw) {
    return SubscriptionPlan(
      id: raw['id']?.toString() ?? '',
      name: raw['name']?.toString() ?? '',
      // /plans 响应不含 description，用 displayName 作为卡片副标题
      description: (raw['description'] ?? raw['displayName'])?.toString(),
      price: (raw['price'] as num?)?.toDouble() ?? 0,
      currency: raw['currency']?.toString() ?? 'CNY',
      interval: raw['billingCycle']?.toString() ?? 'month',
      maxDevices: (raw['maxDevices'] as num?)?.toInt() ?? 0,
      maxClipboardPerDay: (raw['maxClipboardItems'] as num?)?.toInt() ?? 0,
      maxStorageMB: (raw['maxStorageMb'] as num?)?.toInt() ?? 0,
      isActive: true,
      createdAt: DateTime.now(),
      updatedAt: DateTime.now(),
    );
  }

  /// 获取套餐列表（公开接口，无需登录）。
  ///
  /// 后端：GET /api/subscriptions/plans → `{ plans: [...] }`。
  static Future<List<SubscriptionPlan>> getPlans() async {
    final response = await http.get(
      Uri.parse('$_baseUrl/subscriptions/plans'),
      headers: const <String, String>{'Content-Type': 'application/json'},
    );
    if (response.statusCode != 200) {
      throw AppException(AppErrorCodes.fetchPlansFailed, _serverDetail(response));
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      throw const AppException(AppErrorCodes.fetchPlansFailed);
    }
    final Object? plansJson =
        decoded is Map<String, dynamic> ? decoded['plans'] : null;
    if (plansJson is! List) {
      return const <SubscriptionPlan>[];
    }
    return plansJson.whereType<Map<String, dynamic>>().map(_parsePlan).toList(
          growable: false,
        );
  }

  /// 查询当前用户订阅状态。
  ///
  /// 后端：GET /api/subscriptions/current →
  /// `{ subscription: {...} | null, plan: {...} }`（无活跃订阅时
  /// subscription 为 null，plan 为 Free 套餐）。
  static Future<CurrentSubscriptionData> getCurrentSubscription(
    String? token,
  ) async {
    final response = await http.get(
      Uri.parse('$_baseUrl/subscriptions/current'),
      headers: await _authHeaders(token),
    );
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.fetchCurrentSubFailed,
        _serverDetail(response),
      );
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      throw const AppException(AppErrorCodes.fetchCurrentSubFailed);
    }
    if (decoded is! Map<String, dynamic>) {
      throw const AppException(AppErrorCodes.fetchCurrentSubFailed);
    }
    final Object? sub = decoded['subscription'];
    final Object? plan = decoded['plan'];
    return CurrentSubscriptionData(
      subscription:
          sub is Map<String, dynamic> ? UserSubscription.fromJson(sub) : null,
      plan: plan is Map<String, dynamic> ? _parsePlan(plan) : null,
    );
  }

  /// 取消订阅（期末生效：到期前订阅仍可用，到期后自动降级）。
  ///
  /// 后端：POST /api/subscriptions/cancel，无活跃订阅时返回 400。
  static Future<void> cancelSubscription(String? token) async {
    final response = await http.post(
      Uri.parse('$_baseUrl/subscriptions/cancel'),
      headers: await _authHeaders(token),
    );
    if (response.statusCode != 200) {
      throw AppException(AppErrorCodes.cancelSubFailed, _serverDetail(response));
    }
  }

  /// 恢复已标记「期末取消」的订阅（继续自动续订）。
  ///
  /// 后端：POST /api/subscriptions/resume，无可恢复订阅时返回 400。
  static Future<void> resumeSubscription(String? token) async {
    final response = await http.post(
      Uri.parse('$_baseUrl/subscriptions/resume'),
      headers: await _authHeaders(token),
    );
    if (response.statusCode != 200) {
      throw AppException(AppErrorCodes.resumeSubFailed, _serverDetail(response));
    }
  }

  /// 获取账单列表（最多 [limit] 条，按时间倒序）。
  ///
  /// 后端：GET /api/invoices → `{ invoices: [...], pagination: {...} }`。
  /// 已替换旧的 /api/payments/history 死调用。
  static Future<List<Map<String, dynamic>>> getInvoices(
    String? token, {
    int limit = 20,
  }) async {
    final response = await http.get(
      Uri.parse('$_baseUrl/invoices?limit=$limit'),
      headers: await _authHeaders(token),
    );
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.fetchInvoicesFailed,
        _serverDetail(response),
      );
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      throw const AppException(AppErrorCodes.fetchInvoicesFailed);
    }
    final Object? invoicesJson =
        decoded is Map<String, dynamic> ? decoded['invoices'] : null;
    if (invoicesJson is! List) {
      return const <Map<String, dynamic>>[];
    }
    return invoicesJson
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }
}
