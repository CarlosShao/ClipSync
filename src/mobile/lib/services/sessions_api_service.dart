import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 活跃会话（`GET /api/sessions` 响应行，camelCase，见
/// src/server/src/routes/sessions.js 的列表查询）：
/// - `lastActiveAt` 当前与 created_at 同源（服务端 user_sessions 表暂未记录心跳）；
/// - `isCurrent` 由服务端按请求头 `x-session-id` 匹配标记（sessions.js:17）；
///   请求头缺失时服务端不标记，客户端会以本机解码出的会话 id 兜底补标。
class ActiveSession {
  final String id;
  final String deviceName;
  final String platform;
  final String ipAddress;
  final DateTime? createdAt;
  final DateTime? lastActiveAt;
  final bool isCurrent;

  const ActiveSession({
    required this.id,
    this.deviceName = '',
    this.platform = 'unknown',
    this.ipAddress = '',
    this.createdAt,
    this.lastActiveAt,
    this.isCurrent = false,
  });

  factory ActiveSession.fromJson(Map<String, dynamic> json) {
    return ActiveSession(
      id: _asString(json['id']) ?? '',
      deviceName: _asString(json['deviceName']) ?? '',
      platform: _asString(json['platform']) ?? 'unknown',
      ipAddress: _asString(json['ipAddress']) ?? '',
      createdAt: _asDateTime(json['createdAt']),
      lastActiveAt: _asDateTime(json['lastActiveAt']),
      isCurrent: json['isCurrent'] == true,
    );
  }

  static String? _asString(dynamic v) => v is String ? v : null;

  static DateTime? _asDateTime(dynamic v) =>
      v is String && v.isNotEmpty ? DateTime.tryParse(v) : null;
}

/// 会话管理（Sessions）API 封装（T4.3）。
///
/// 对齐后端 `/api/sessions` 路由（src/server/src/routes/sessions.js）：
/// - GET    /api/sessions              → { data: { sessions: [...] } }
///   （请求头 `x-session-id` 用于让服务端标记当前会话 isCurrent）
/// - DELETE /api/sessions/:sessionId   → { message }（吊销单个会话，强制下线；
///   服务端会把该会话 jti 写入 Redis 黑名单，当前会话被吊销后其 access token
///   立即失效，客户端需同步走登出流程）
///
/// Bearer 令牌统一走 [TokenStore.getAccessToken()]（T1.2 冻结契约），
/// 未登录时抛出异常由 UI 层展示错误态。
class SessionsApiService {
  static String get _baseUrl => '${ServerConfig.baseUrl}/api/sessions';

  /// 统一请求头：从 TokenStore 解析 Bearer 令牌，缺失时抛未登录异常；
  /// [sessionId] 非空时附带 `x-session-id`（服务端据此标记当前会话）。
  Future<Map<String, String>> _headers({String? sessionId}) async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    return <String, String>{
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
      if (sessionId != null && sessionId.isNotEmpty) 'x-session-id': sessionId,
    };
  }

  /// JSON 响应体安全解码为 Map（jsonDecode 返回 dynamic，直接断言会触发
  /// strict-casts 报错）。
  static Map<String, dynamic> _decodeMap(String body) {
    final dynamic decoded = jsonDecode(body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  /// 本机当前会话 id：登录签发的 access token（JWT）payload 中
  /// `jti` 与 `sessionId` 同为会话 uuid（src/server/src/routes/auth.js:52），
  /// 客户端自行解码即可获得，无需服务端额外下发；解码失败返回 null
  /// （此时服务端降级为不标记当前会话，吊销流程退化为普通吊销）。
  Future<String?> currentSessionId() async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      return null;
    }
    return _sessionIdFromToken(token);
  }

  /// 解析 JWT payload 中的会话 id（不做签名校验，仅读取自有 token）。
  static String? _sessionIdFromToken(String token) {
    final List<String> parts = token.split('.');
    if (parts.length != 3) {
      return null;
    }
    try {
      final String payload =
          utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
      final dynamic decoded = jsonDecode(payload);
      if (decoded is! Map<String, dynamic>) {
        return null;
      }
      final dynamic jti = decoded['jti'];
      if (jti is String && jti.isNotEmpty) {
        return jti;
      }
      final dynamic sessionId = decoded['sessionId'];
      if (sessionId is String && sessionId.isNotEmpty) {
        return sessionId;
      }
      return null;
    } on FormatException catch (e) {
      debugPrint('[SessionsApiService] decode session id failed: $e');
      return null;
    } catch (e) {
      debugPrint('[SessionsApiService] decode session id failed: $e');
      return null;
    }
  }

  /// 获取当前用户所有活跃会话（服务端按 created_at 倒序）。
  ///
  /// 自动附带 `x-session-id`；若服务端未标记 isCurrent（如 header 未生效），
  /// 以本机解码出的会话 id 兜底补标，保证吊销当前会话的登出链路可用。
  Future<List<ActiveSession>> listSessions() async {
    final String? currentId = await currentSessionId();
    final http.Response response = await http
        .get(Uri.parse(_baseUrl), headers: await _headers(sessionId: currentId))
        .timeout(const Duration(seconds: 15));

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchSessionsFailed);
    }

    final Map<String, dynamic> body = _decodeMap(response.body);
    final dynamic payload = body['data'] is Map<String, dynamic>
        ? (body['data'] as Map<String, dynamic>)['sessions']
        : body['sessions'];
    if (payload is! List) {
      return const <ActiveSession>[];
    }
    final List<ActiveSession> sessions = payload
        .whereType<Map<String, dynamic>>()
        .map(ActiveSession.fromJson)
        .toList();

    if (currentId == null || currentId.isEmpty) {
      return sessions;
    }
    return <ActiveSession>[
      for (final ActiveSession session in sessions)
        session.id == currentId && !session.isCurrent
            ? _markedCurrent(session)
            : session,
    ];
  }

  /// 吊销指定会话（强制下线）。404（会话不存在/不属于当前用户）与其他
  /// 非 200 状态一律抛异常，由 UI 层提示。
  Future<void> revokeSession(String sessionId) async {
    final http.Response response = await http
        .delete(
          Uri.parse('$_baseUrl/$sessionId'),
          headers: await _headers(),
        )
        .timeout(const Duration(seconds: 15));

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.revokeFailed);
    }
  }

  /// 兜底补标 isCurrent（fromJson 之外不可变字段的重建）。
  static ActiveSession _markedCurrent(ActiveSession session) {
    return ActiveSession(
      id: session.id,
      deviceName: session.deviceName,
      platform: session.platform,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      isCurrent: true,
    );
  }
}
