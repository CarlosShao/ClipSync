import 'dart:convert';

import 'package:http/http.dart' as http;

import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 搜索历史条目（`GET /api/search-history` 行，snake_case 列名）。
///
/// 字段对齐后端 src/server/src/routes/searchHistory.js 的 SELECT：
/// id / keyword / created_at / updated_at。
class SearchHistoryItem {
  final String id;

  /// 搜索关键词（服务端 ON CONFLICT (user_id, keyword) 去重，最近搜索排最前）。
  final String keyword;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const SearchHistoryItem({
    required this.id,
    required this.keyword,
    this.createdAt,
    this.updatedAt,
  });

  /// 本地镜像构造（POST 记录成功后乐观插入列表顶部用，无服务端 id/时间）。
  const SearchHistoryItem.local(this.keyword)
      : id = '',
        createdAt = null,
        updatedAt = null;

  factory SearchHistoryItem.fromJson(Map<String, dynamic> json) {
    return SearchHistoryItem(
      id: json['id'] is String ? json['id'] as String : '',
      keyword: json['keyword'] is String ? json['keyword'] as String : '',
      createdAt: _asDateTime(json['created_at']),
      updatedAt: _asDateTime(json['updated_at']),
    );
  }

  static DateTime? _asDateTime(dynamic v) =>
      v is String && v.isNotEmpty ? DateTime.tryParse(v) : null;
}

/// 搜索历史 API 封装（C2 移动端）。
///
/// 对齐后端 `/api/search-history` 路由（src/server/src/routes/searchHistory.js，
/// 挂载于 src/server/src/index.js:433）：
/// - GET    /api/search-history?limit=N → { items: [...], count: n }
/// - POST   /api/search-history {keyword} → 201 { id, keyword, ... }
/// - DELETE /api/search-history → { ok: true }（清空全部）
/// - DELETE /api/search-history?keyword=K → { ok: true }（G4 单条删除·按关键词）
/// - DELETE /api/search-history/:id → { ok: true }（G4 单条删除·按行 id，404=不存在）
///
/// Bearer 令牌统一走 [TokenStore.getAccessToken()]（T1.2 冻结契约）；Bearer
/// 认证请求在服务端跳过 CSRF 校验（csrf.js:157），POST/DELETE 可直连。
class SearchHistoryApiService {
  static String get _baseUrl => '${ServerConfig.baseUrl}/api/search-history';

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

  /// 获取当前用户搜索历史（按最近搜索时间倒序，limit 服务端上限 50）。
  Future<List<SearchHistoryItem>> fetchHistory({int limit = 10}) async {
    final response = await http.get(
      Uri.parse('$_baseUrl?limit=$limit'),
      headers: await _headers(),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchSearchHistoryFailed);
    }

    final dynamic decoded = jsonDecode(response.body);
    if (decoded is! Map<String, dynamic>) {
      return const <SearchHistoryItem>[];
    }
    final dynamic raw = decoded['items'];
    if (raw is List) {
      return raw
          .whereType<Map<String, dynamic>>()
          .map(SearchHistoryItem.fromJson)
          .toList();
    }
    return const <SearchHistoryItem>[];
  }

  /// 记录一次搜索；重复关键词由服务端顶到列表最前（upsert，201 返回该行）。
  Future<void> recordQuery(String term) async {
    final response = await http.post(
      Uri.parse(_baseUrl),
      headers: await _headers(),
      body: jsonEncode(<String, String>{'keyword': term}),
    );

    if (response.statusCode != 201) {
      throw const AppException(AppErrorCodes.fetchSearchHistoryFailed);
    }
  }

  /// 清空当前用户全部搜索历史。
  Future<void> clearHistory() async {
    final response = await http.delete(
      Uri.parse(_baseUrl),
      headers: await _headers(),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchSearchHistoryFailed);
    }
  }

  /// 删除单条历史（G4）：优先按服务端行 id（DELETE /:id，404 视为已不存在，
  /// 与删除语义一致故不视为失败）；本地乐观镜像无 id 时按关键词兜底
  /// （DELETE /?keyword=）。
  Future<void> deleteHistory({String? id, String? keyword}) async {
    if (id != null && id.isNotEmpty) {
      final response = await http.delete(
        Uri.parse('$_baseUrl/$id'),
        headers: await _headers(),
      );
      if (response.statusCode != 200 && response.statusCode != 404) {
        throw const AppException(AppErrorCodes.fetchSearchHistoryFailed);
      }
      return;
    }
    if (keyword == null || keyword.isEmpty) {
      return;
    }
    final response = await http.delete(
      Uri.parse('$_baseUrl?keyword=${Uri.encodeQueryComponent(keyword)}'),
      headers: await _headers(),
    );
    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchSearchHistoryFailed);
    }
  }
}
