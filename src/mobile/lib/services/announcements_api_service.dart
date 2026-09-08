import 'dart:convert';

import 'package:http/http.dart' as http;

import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 系统公告（CO-35，admin_announcements 行的客户端快照）。
///
/// 字段与 `GET /api/app/announcements` 响应一一对应（camelCase，
/// 见 src/server/src/routes/app.js 的 announcements 映射：
/// display_mode → displayMode、created_at → sentAt）：
/// - [audience]：all / free / pro_plus（服务端已按当前用户受众过滤，仅展示）；
/// - [displayMode]：once（打开详情即上报已读回执）/ persistent（常驻展示）。
class Announcement {
  final String id;
  final String title;
  final String content;
  final String audience;

  /// once / persistent（服务端未返回或缺损时按 persistent 常驻处理）
  final String displayMode;
  final DateTime? sentAt;

  const Announcement({
    required this.id,
    required this.title,
    required this.content,
    required this.audience,
    required this.displayMode,
    this.sentAt,
  });

  factory Announcement.fromJson(Map<String, dynamic> json) {
    final sentAt = json['sentAt'];
    return Announcement(
      id: json['id']?.toString() ?? '',
      title: json['title'] is String ? json['title'] as String : '',
      content: json['content'] is String ? json['content'] as String : '',
      audience: json['audience'] is String ? json['audience'] as String : 'all',
      displayMode:
          json['displayMode'] is String ? json['displayMode'] as String : 'persistent',
      sentAt:
          sentAt is String && sentAt.isNotEmpty ? DateTime.tryParse(sentAt) : null,
    );
  }

  /// once 公告：打开详情时上报已读回执（persistent 常驻无需回执）
  bool get isOnce => displayMode == 'once';
}

/// 公告（Announcements）API 封装（CO-35）。
///
/// 对齐后端端点（src/server/src/routes/app.js）：
/// - GET  /api/app/announcements           optionalAuth：带 Bearer 按受众过滤，
///   无 token 仅 audience='all'；
/// - POST /api/app/announcements/:id/read  authenticateToken：必须登录，
///   服务端 upsert 已读表（PK 幂等），重复上报不报错不重复计数。
class AnnouncementsApiService {
  static String get _baseUrl => '${ServerConfig.baseUrl}/api/app';

  /// 公告列表（最新在前，服务端 LIMIT 20）。Bearer 可选。
  /// 失败抛 [AppException]（AppErrorCodes.fetchAnnouncementsFailed）。
  Future<List<Announcement>> fetchAnnouncements() async {
    final token = await TokenStore.getAccessToken();
    final response = await http
        .get(
          Uri.parse('$_baseUrl/announcements'),
          headers: (token != null && token.isNotEmpty)
              ? <String, String>{'Authorization': 'Bearer $token'}
              : const <String, String>{},
        )
        .timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchAnnouncementsFailed);
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      throw const AppException(AppErrorCodes.fetchAnnouncementsFailed);
    }
    final Object? list =
        decoded is Map<String, dynamic> ? decoded['announcements'] : null;
    if (list is! List) {
      return const <Announcement>[];
    }
    return list
        .whereType<Map<String, dynamic>>()
        .map(Announcement.fromJson)
        .toList(growable: false);
  }

  /// 已读回执（once 公告打开详情时调用）。必须登录：未登录（游客）无回执
  /// 语义，直接跳过返回 false；网络失败同样返回 false 由调用方提示，
  /// 不抛异常（回执是尽力而为的副产物，不应打断公告阅读）。
  Future<bool> markRead(String id) async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) return false;
    try {
      final response = await http
          .post(
            Uri.parse('$_baseUrl/announcements/$id/read'),
            headers: <String, String>{'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 10));
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
