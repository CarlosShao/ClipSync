import 'dart:convert';

import 'package:http/http.dart' as http;

import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 条目动作 API 服务（C3 条目管理能力，独占封装；不重复 [ApiService] 既有方法）。
///
/// 与后端协议对齐（src/server/src/routes/clipboard.js / protection.js）：
/// - 置顶 toggle：`PUT /api/clipboard/:id/pinned`，body `{pinned: bool}`，
///   写入 `metadata.pinned`，响应 `{id, pinned, metadata}`；
/// - 过期时间：`PUT /api/clipboard/:id`，body `{expiresAt: ISO 日期串 | null}`
///   （null = 清除），响应含权威 `expiresAt`；
/// - 归档 toggle：`PUT /api/clipboard/:id`，body `{archived: bool}`，
///   响应含权威 `archived`；
/// - 标签更新：`PUT /api/clipboard/:id`，body `{metadata: {tags: string[]}}`
///   （服务端 metadata 浅合并，仅放行 protected/protectedAt/tags 三个 key）；
/// - 密码解锁：`POST /api/protection/unlock`，body `{itemId, password}`，
///   响应 `{success, level, content}`；401 = 密码错误。
///   注意：桌面端「条目密码」是纯前端加密（PBKDF2 + AES-GCM，密码不上传），
///   移动端 `crypto` 包无 AES-GCM 能力且不加新依赖，故走服务端解锁协议，
///   由后端解密后返回内容。
///
/// 失败统一抛 [AppException]（code 见 [AppErrorCodes] C3 段），UI 层经
/// friendlyError 映射文案；密码错误抛 [AppErrorCodes.wrongPassword]（有预置 key）。
class ItemActionsApiService {
  static String get baseUrl => ServerConfig.baseUrl;

  /// 解析 Bearer 令牌：显式传入优先，未传时从 TokenStore 读取（同 ApiService 契约）。
  Future<String> _resolveToken(String? token) async {
    final String? resolved = token ?? await TokenStore.getAccessToken();
    if (resolved == null || resolved.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    return resolved;
  }

  Future<Map<String, String>> _headers(String? token) async {
    final String resolved = await _resolveToken(token);
    return <String, String>{
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $resolved',
    };
  }

  /// JSON 响应体安全解码为 Map（对齐 ApiService._decodeMap）。
  static Map<String, dynamic> _decodeMap(String body) {
    final dynamic decoded = jsonDecode(body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  /// 置顶/取消置顶（PUT /api/clipboard/:id/pinned）。
  /// 返回服务端权威状态 `{id, pinned, metadata}`，失败抛 [AppErrorCodes.pinFailed]。
  Future<Map<String, dynamic>?> setPinned(
    String? token,
    String itemId,
    bool pinned,
  ) async {
    final http.Response response = await http.put(
      Uri.parse('$baseUrl/api/clipboard/$itemId/pinned'),
      headers: await _headers(token),
      body: jsonEncode(<String, dynamic>{'pinned': pinned}),
    );
    if (response.statusCode != 200) {
      throw AppException(AppErrorCodes.pinFailed, 'HTTP ${response.statusCode}');
    }
    return _decodeMap(response.body);
  }

  /// 设置/清除过期时间（PUT /api/clipboard/:id 的 expiresAt 字段）。
  ///
  /// [expiresAt] 传 null = 清除过期（expiryNever）；传时刻则序列化为 UTC ISO 串
  /// （后端 `new Date()` 解析后落库 expires_at）。
  /// 返回条目权威 payload，失败抛 [AppErrorCodes.setExpiryFailed]。
  Future<Map<String, dynamic>?> setExpiry(
    String? token,
    String itemId,
    DateTime? expiresAt,
  ) async {
    final http.Response response = await http.put(
      Uri.parse('$baseUrl/api/clipboard/$itemId'),
      headers: await _headers(token),
      body: jsonEncode(<String, dynamic>{
        'expiresAt': expiresAt?.toUtc().toIso8601String(),
      }),
    );
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.setExpiryFailed,
        'HTTP ${response.statusCode}',
      );
    }
    return _decodeMap(response.body);
  }

  /// 归档/取消归档（PUT /api/clipboard/:id 的 archived 字段）。
  /// 返回条目权威 payload，失败抛 [AppErrorCodes.archiveFailed]。
  Future<Map<String, dynamic>?> setArchived(
    String? token,
    String itemId,
    bool archived,
  ) async {
    final http.Response response = await http.put(
      Uri.parse('$baseUrl/api/clipboard/$itemId'),
      headers: await _headers(token),
      body: jsonEncode(<String, dynamic>{'archived': archived}),
    );
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.archiveFailed,
        'HTTP ${response.statusCode}',
      );
    }
    return _decodeMap(response.body);
  }

  /// 更新条目标签（PUT /api/clipboard/:id 的 metadata.tags，服务端浅合并）。
  /// 返回条目权威 payload（含合并后的 metadata），失败抛
  /// [AppErrorCodes.updateTagsFailed]。
  Future<Map<String, dynamic>?> updateTags(
    String? token,
    String itemId,
    List<String> tags,
  ) async {
    final http.Response response = await http.put(
      Uri.parse('$baseUrl/api/clipboard/$itemId'),
      headers: await _headers(token),
      body: jsonEncode(<String, dynamic>{
        'metadata': <String, dynamic>{'tags': tags},
      }),
    );
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.updateTagsFailed,
        'HTTP ${response.statusCode}',
      );
    }
    return _decodeMap(response.body);
  }

  /// 受保护条目密码解锁（POST /api/protection/unlock）。
  ///
  /// 返回解密后的条目内容（protection.js 协议的 `content` 字段；pin 级别
  /// 服务端直接返回存量内容，advanced 级别用密码解 DEK 后返回）。
  /// 401（Invalid password）抛 [AppErrorCodes.wrongPassword]；
  /// 其他失败抛 [AppErrorCodes.unlockFailed]。
  Future<String> unlock(String? token, String itemId, String password) async {
    final http.Response response = await http.post(
      Uri.parse('$baseUrl/api/protection/unlock'),
      headers: await _headers(token),
      body: jsonEncode(<String, dynamic>{'itemId': itemId, 'password': password}),
    );
    if (response.statusCode == 401) {
      // 密码错误：不带 detail，wrongPassword 文案不附加技术噪音
      throw const AppException(AppErrorCodes.wrongPassword);
    }
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.unlockFailed,
        'HTTP ${response.statusCode}',
      );
    }
    final Map<String, dynamic> data = _decodeMap(response.body);
    final dynamic content = data['content'];
    if (content is String && content.isNotEmpty) {
      return content;
    }
    throw const AppException(AppErrorCodes.unlockFailed, 'empty content');
  }

  /// 查询条目保护状态（GET /api/protection/status/:itemId）。
  /// 返回 `{level, hasRecoveryKey}`，失败抛 [AppErrorCodes.unlockFailed]。
  Future<Map<String, dynamic>?> protectionStatus(
    String? token,
    String itemId,
  ) async {
    final http.Response response = await http.get(
      Uri.parse('$baseUrl/api/protection/status/$itemId'),
      headers: await _headers(token),
    );
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.unlockFailed,
        'HTTP ${response.statusCode}',
      );
    }
    return _decodeMap(response.body);
  }
}
