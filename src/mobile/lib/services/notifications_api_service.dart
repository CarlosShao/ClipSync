import 'dart:convert';

import 'package:http/http.dart' as http;

import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 站内通知（后端 notification_history 行，C5）。
///
/// 字段与 `GET /api/notifications/history` 响应一一对应（snake_case，
/// 见 src/server/src/routes/notifications.js + notificationService.js 的
/// `SELECT * FROM notification_history`）：
/// - [status]：sent / failed / pending（发送状态，与已读状态独立）；
/// - [readAt]：非 null 即已读；未读 = [isRead] 为 false。
class NotificationItem {
  final String id;
  final String notificationType;
  final String title;
  final String? content;

  /// 发送状态：sent / failed / pending
  final String status;
  final DateTime? sentAt;
  final DateTime? readAt;
  final DateTime? createdAt;

  const NotificationItem({
    required this.id,
    required this.notificationType,
    required this.title,
    this.content,
    this.status = 'sent',
    this.sentAt,
    this.readAt,
    this.createdAt,
  });

  factory NotificationItem.fromJson(Map<String, dynamic> json) {
    return NotificationItem(
      id: _asId(json['id']),
      notificationType: _asString(json['notification_type']) ?? '',
      title: _asString(json['title']) ?? '',
      content: _asString(json['content']),
      status: _asString(json['status']) ?? 'sent',
      sentAt: _asDateTime(json['sent_at']),
      readAt: _asDateTime(json['read_at']),
      createdAt: _asDateTime(json['created_at']),
    );
  }

  /// 是否已读（read_at 非空）
  bool get isRead => readAt != null;

  /// 标为已读后的本地副本（read_at 置为当前时间）
  NotificationItem markedRead() {
    return NotificationItem(
      id: id,
      notificationType: notificationType,
      title: title,
      content: content,
      status: status,
      sentAt: sentAt,
      readAt: readAt ?? DateTime.now(),
      createdAt: createdAt,
    );
  }

  static String? _asString(dynamic v) => v is String ? v : null;

  /// id 兼容：SERIAL 主键经 pg 返回数字，历史/代理形态可能为字符串
  static String _asId(dynamic v) =>
      v is String ? v : (v is num ? v.toString() : '');

  static DateTime? _asDateTime(dynamic v) =>
      v is String && v.isNotEmpty ? DateTime.tryParse(v) : null;
}

/// 站内通知（Notifications）API 封装（C5）。
///
/// 对齐后端 `/api/notifications` 路由（src/server/src/routes/notifications.js）：
/// - GET /api/notifications/history?limit=&offset=  → 通知行数组（直接返回
///   `result.rows`，非 `{data: [...]}` 包装；解析时对包装形态做兼容）；
/// - PUT /api/notifications/history/:id/read        → 200 更新后的行。
///
/// 后端无「全部已读」批量端点，批量已读由 UI 层逐条调用 [markRead]。
/// Bearer 令牌统一走 [TokenStore.getAccessToken()]（T1.2 冻结契约）。
class NotificationsApiService {
  static String get _baseUrl => '${ServerConfig.baseUrl}/api/notifications';

  /// 统一请求头：从 TokenStore 解析 Bearer 令牌，缺失时抛未登录异常。
  Future<Map<String, String>> _headers() async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    return <String, String>{
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
    };
  }

  /// 获取通知历史（按创建时间倒序，默认最近 50 条）。
  Future<List<NotificationItem>> fetchHistory({
    int limit = 50,
    int offset = 0,
  }) async {
    final uri = Uri.parse('$_baseUrl/history').replace(
      queryParameters: <String, String>{
        'limit': limit.toString(),
        'offset': offset.toString(),
      },
    );

    final response = await http.get(uri, headers: await _headers());

    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.fetchNotificationsFailed,
        'HTTP ${response.statusCode}',
      );
    }

    final dynamic decoded = jsonDecode(response.body);
    List<dynamic>? raw;
    if (decoded is List) {
      raw = decoded;
    } else if (decoded is Map<String, dynamic>) {
      // 兼容潜在的数据包装形态
      final dynamic data = decoded['data'] ?? decoded['history'];
      if (data is List) raw = data;
    }
    if (raw == null) {
      return const <NotificationItem>[];
    }
    return raw
        .whereType<Map<String, dynamic>>()
        .map(NotificationItem.fromJson)
        .toList();
  }

  /// 标记单条通知为已读（后端 read_at 为空时置为当前时间）。
  Future<void> markRead(String id) async {
    final response = await http.put(
      Uri.parse('$_baseUrl/history/$id/read'),
      headers: await _headers(),
    );

    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.markNotificationReadFailed,
        'HTTP ${response.statusCode}',
      );
    }
  }
}
