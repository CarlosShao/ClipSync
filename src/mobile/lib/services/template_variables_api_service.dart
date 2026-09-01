import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_service.dart';
import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 模板及其全局变量 API 封装（C4 模板增强）。
///
/// 对齐后端路由：
/// - GET    /api/template-variables          → `{ data: [{ id, name, value, ... }] }`
///   （src/server/src/routes/templateVariables.js，按用户隔离、按名称排序）
/// - PUT    /api/template-variables          → 200 行，body `{ name, value? }`
///   （按 (user_id, name) upsert；name 须匹配 `^[a-zA-Z_][a-zA-Z0-9_]*$`）
/// - POST   /api/templates                   → 201 行，body `{ name, content? }`
/// - PUT    /api/templates/:id               → 200 行，body `{ name?, content? }`
/// - DELETE /api/templates/:id               → 204
///
/// 全局变量是「按用户隔离的 name → value 存储」，同时充当变量默认值与
/// 上次记住的输入（桌面端 templateVariableStore 回退链的同一存储），
/// 因此不存在 templateId 维度，端点均为全局粒度。
class TemplatesApiService {
  static String get _baseUrl => ServerConfig.baseUrl;

  /// 后端变量名约束（templateVariables.js NAME_RE）：字母或下划线开头，
  /// 可跟字母/数字/下划线；不满足的变量名不应用于 upsert（后端 400）。
  static final RegExp _variableNamePattern = RegExp(r'^[a-zA-Z_][a-zA-Z0-9_]*$');

  /// 变量名是否符合后端存储约束（调用方据此过滤「记住输入」回写）。
  static bool isValidVariableName(String name) =>
      _variableNamePattern.hasMatch(name);

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

  /// JSON 响应体安全解码为 Map（jsonDecode 返回 dynamic，直接断言会触发
  /// strict-casts 报错）。
  static Map<String, dynamic> _decodeMap(String body) {
    final dynamic decoded = jsonDecode(body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  // ---------------------------------------------------------------------------
  // 全局模板变量（默认值 / 上次记住输入）
  // ---------------------------------------------------------------------------

  /// 拉取当前用户全部全局模板变量，返回 `name → value` 映射。
  ///
  /// 对齐桌面端 templateVariableStore.fetchVariables 的数据源；UI 侧以此
  /// 构建回退链（后端存储值 → 模板语法默认值 → 空串）。
  Future<Map<String, String>> fetchDefaults() async {
    final response = await http.get(
      Uri.parse('$_baseUrl/api/template-variables'),
      headers: await _headers(),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchTemplateVarsFailed);
    }

    final dynamic raw = _decodeMap(response.body)['data'];
    final Map<String, String> defaults = <String, String>{};
    if (raw is List) {
      for (final dynamic row in raw) {
        if (row is Map<String, dynamic>) {
          final dynamic name = row['name'];
          if (name is String && name.isNotEmpty) {
            final dynamic value = row['value'];
            defaults[name] = value is String ? value : '';
          }
        }
      }
    }
    return defaults;
  }

  /// upsert 单个变量（PUT /api/template-variables，body `{ name, value }`）。
  Future<void> saveDefault(String name, String value) async {
    final response = await http.put(
      Uri.parse('$_baseUrl/api/template-variables'),
      headers: await _headers(),
      body: jsonEncode(<String, String>{'name': name, 'value': value}),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.saveTemplateVarsFailed);
    }
  }

  /// 批量记住输入：逐个 upsert，任一失败即抛出（调用方决定是否吞掉）。
  Future<void> saveDefaults(Map<String, String> variables) async {
    for (final MapEntry<String, String> entry in variables.entries) {
      await saveDefault(entry.key, entry.value);
    }
  }

  // ---------------------------------------------------------------------------
  // 模板 CRUD
  // ---------------------------------------------------------------------------

  /// 新建模板（POST /api/templates，201 返回新建行）。
  Future<ClipboardTemplate> createTemplate(String name, String content) async {
    final response = await http.post(
      Uri.parse('$_baseUrl/api/templates'),
      headers: await _headers(),
      body: jsonEncode(<String, String>{'name': name, 'content': content}),
    );

    if (response.statusCode != 201) {
      throw const AppException(AppErrorCodes.createTemplateFailed);
    }

    final dynamic raw = _decodeMap(response.body);
    if (raw is Map<String, dynamic> && raw.isNotEmpty) {
      return ClipboardTemplate.fromJson(raw);
    }
    throw const AppException(AppErrorCodes.createTemplateFailed);
  }

  /// 更新模板（PUT /api/templates/:id，name 与 content 全量提交，200 返回更新行）。
  Future<ClipboardTemplate> updateTemplate(
    String id,
    String name,
    String content,
  ) async {
    final response = await http.put(
      Uri.parse('$_baseUrl/api/templates/$id'),
      headers: await _headers(),
      body: jsonEncode(<String, String>{'name': name, 'content': content}),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.updateTemplateFailed);
    }

    final dynamic raw = _decodeMap(response.body);
    if (raw is Map<String, dynamic> && raw.isNotEmpty) {
      return ClipboardTemplate.fromJson(raw);
    }
    throw const AppException(AppErrorCodes.updateTemplateFailed);
  }

  /// 删除模板（DELETE /api/templates/:id，204）。
  Future<void> deleteTemplate(String id) async {
    final response = await http.delete(
      Uri.parse('$_baseUrl/api/templates/$id'),
      headers: await _headers(),
    );

    if (response.statusCode != 204) {
      throw const AppException(AppErrorCodes.deleteTemplateFailed);
    }
  }
}
