import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import '../models/clipboard_item.dart';
import '../models/device.dart';
import '../models/session.dart';
import 'cache_service.dart';
import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

class ApiService {
  static String get baseUrl => ServerConfig.baseUrl;

  /// 解析 Bearer 令牌：显式传入的 token 优先；未传时从 TokenStore（secure storage，
  /// T1.2 冻结契约）读取。都没有则抛出未登录异常。
  Future<String> _resolveToken(String? token) async {
    final resolved = token ?? await TokenStore.getAccessToken();
    if (resolved == null || resolved.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    return resolved;
  }

  Future<Map<String, String>> _headers(String? token) async {
    final resolved = await _resolveToken(token);
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $resolved',
    };
  }

  /// JSON 响应体安全解码为 Map（jsonDecode 返回 dynamic，直接返回会触发
  /// return_of_invalid_type / argument_type_not_assignable）
  static Map<String, dynamic> _decodeMap(String body) {
    final decoded = jsonDecode(body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  // Auth
  Future<void> sendVerificationCode(String phone) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/auth/send-code'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'phone': phone}),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.sendCodeFailed);
    }
  }

  Future<Map<String, dynamic>> login(String phone, String code) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/auth/verify-code'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'phone': phone, 'code': code}),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.loginFailed);
    }

    return _decodeMap(response.body);
  }

  Future<Map<String, dynamic>> getProfile(String? token) async {
    return await CacheDecorator().cachedOperation(
      CacheKeys.userProfile(),
      () async {
        final response = await http.get(
          Uri.parse('$baseUrl/api/auth/me'),
          headers: await _headers(token),
        );

        if (response.statusCode != 200) {
          throw const AppException(AppErrorCodes.fetchProfileFailed);
        }

        return _decodeMap(response.body);
      },
      ttl: const Duration(minutes: 5),
    ) ?? {};
  }

  // Clipboard

  /// 拉取剪贴板列表（T1.1）
  ///
  /// - 返回解析后的 [ClipboardPage]（items + pagination）。
  /// - 保留并暴露全部分页/筛选能力：page/limit、contentType、search、favorites、
  ///   deviceId、dateFrom、dateTo、tag、all、view（对齐后端 GET /api/clipboard 查询参数）。
  /// - 缓存键带上筛选签名：无筛选时沿用既有键（缓存兼容），带筛选时各自独立缓存，
  ///   避免不同筛选结果串缓存。
  Future<ClipboardPage> getClipboardItems(
    String? token, {
    int page = 1,
    int limit = 50,
    String? contentType,
    String? search,
    bool? favorites,
    String? deviceId,
    String? dateFrom,
    String? dateTo,
    String? tag,
    bool all = false,
    String? view,
    bool forceRefresh = false,
  }) async {
    final queryParams = <String, String>{
      'page': page.toString(),
      'limit': limit.toString(),
    };

    if (contentType != null && contentType.isNotEmpty) {
      queryParams['contentType'] = contentType;
    }
    if (search != null && search.trim().isNotEmpty) {
      queryParams['search'] = search.trim();
    }
    if (favorites == true) queryParams['favorites'] = 'true';
    if (all) queryParams['all'] = 'true';
    if (deviceId != null && deviceId.isNotEmpty) {
      queryParams['deviceId'] = deviceId;
    }
    if (dateFrom != null && dateFrom.isNotEmpty) {
      queryParams['dateFrom'] = dateFrom;
    }
    if (dateTo != null && dateTo.isNotEmpty) queryParams['dateTo'] = dateTo;
    if (tag != null && tag.isNotEmpty) queryParams['tag'] = tag;
    if (view != null && view.isNotEmpty) queryParams['view'] = view;

    // 缓存键：无筛选沿用旧键（兼容既有缓存）；有筛选附加签名段
    final filterSignature = <String>[
      if (contentType != null && contentType.isNotEmpty)
        'type=${Uri.encodeComponent(contentType)}',
      if (search != null && search.trim().isNotEmpty)
        'q=${Uri.encodeComponent(search.trim())}',
      if (favorites == true) 'fav=1',
      if (deviceId != null && deviceId.isNotEmpty)
        'dev=${Uri.encodeComponent(deviceId)}',
      if (dateFrom != null && dateFrom.isNotEmpty)
        'from=${Uri.encodeComponent(dateFrom)}',
      if (dateTo != null && dateTo.isNotEmpty)
        'to=${Uri.encodeComponent(dateTo)}',
      if (tag != null && tag.isNotEmpty) 'tag=${Uri.encodeComponent(tag)}',
      if (all) 'all=1',
      if (view != null && view.isNotEmpty) 'view=${Uri.encodeComponent(view)}',
    ].join('&');
    final cacheKey = filterSignature.isEmpty
        ? CacheKeys.clipboardListWithPage(page)
        : '${CacheKeys.clipboardListWithPage(page)}#$filterSignature';

    // 缓存原始 Map（可安全经磁盘 JSON 序列化往返），出缓存后再解析为强类型
    final data = await CacheDecorator().cachedOperation<Map<String, dynamic>>(
      cacheKey,
      () async {
        final uri = Uri.parse('$baseUrl/api/clipboard').replace(
          queryParameters: queryParams,
        );

        final response = await http.get(uri, headers: await _headers(token));

        if (response.statusCode != 200) {
          throw const AppException(AppErrorCodes.fetchClipboardFailed);
        }

        final decoded = jsonDecode(response.body);
        return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
      },
      ttl: const Duration(minutes: 2),
      forceRefresh: forceRefresh,
    );

    return ClipboardPage.fromJson(data ?? const {});
  }

  /// 获取单条完整内容（T1.1 核心）
  ///
  /// 列表响应只含截断预览（服务端截断至 5000 字符），复制长文本前需经
  /// `GET /api/clipboard/:id/content` 拉取完整内容（contentEncrypted 字段，
  /// 历史命名、实际为明文；对齐桌面端 useClipboard.ts 的复制取数路径）。
  Future<String?> getItemContent(String? token, String itemId) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/clipboard/$itemId/content'),
      headers: await _headers(token),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchItemContentFailed);
    }

    final decoded = jsonDecode(response.body);
    if (decoded is Map<String, dynamic>) {
      final content = decoded['contentEncrypted'];
      return content is String ? content : null;
    }
    return null;
  }

  /// 收藏 toggle（PUT /api/clipboard/:id/favorite）。
  /// 返回服务端权威状态 {id, isFavorite, favoritedAt}，请求失败抛异常。
  Future<Map<String, dynamic>?> toggleFavorite(String? token, String itemId) async {
    final response = await http.put(
      Uri.parse('$baseUrl/api/clipboard/$itemId/favorite'),
      headers: await _headers(token),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.toggleFavoriteFailed);
    }

    final decoded = jsonDecode(response.body);
    return decoded is Map<String, dynamic> ? decoded : null;
  }

  Future<void> deleteClipboardItem(String? token, String itemId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/api/clipboard/$itemId'),
      headers: await _headers(token),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.deleteItemFailed);
    }
  }

  // Devices
  Future<List<Device>> getDevices(String? token, {bool forceRefresh = false}) async {
    // 磁盘缓存只存 JSON 序列化的原始列表；Device 对象不可直接 jsonEncode，
    // 之前直接把 List<Device> 交给 cachedOperation 导致 _putToDisk 每次
    // jsonEncode 抛错（"Converting object to an encodable object failed"），
    // 错误报告队列被反复刷满（FAB 恒显 20）。
    final cached = await CacheDecorator().cachedOperation<List<dynamic>>(
      CacheKeys.deviceList(),
      () async {
        final response = await http.get(
          Uri.parse('$baseUrl/api/devices'),
          headers: await _headers(token),
        );

        if (response.statusCode != 200) {
          throw const AppException(AppErrorCodes.fetchDevicesFailed);
        }

        return jsonDecode(response.body) as List<dynamic>;
      },
      ttl: const Duration(minutes: 5),
      forceRefresh: forceRefresh,
    );
    return (cached ?? const <dynamic>[])
        .map((json) => Device.fromJson(json as Map<String, dynamic>))
        .toList();
  }

  Future<Device> registerDevice(
    String? token, {
    required String deviceName,
    required String deviceType,
    required String platform,
    String? platformVersion,
    String? appVersion,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/devices'),
      headers: await _headers(token),
      body: jsonEncode({
        'deviceName': deviceName,
        'deviceType': deviceType,
        'platform': platform,
        'platformVersion': platformVersion,
        'appVersion': appVersion,
      }),
    );

    if (response.statusCode != 201) {
      throw const AppException(AppErrorCodes.registerDeviceFailed);
    }

    return Device.fromJson(_decodeMap(response.body));
  }

  Future<void> removeDevice(String? token, String deviceId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/api/devices/$deviceId'),
      headers: await _headers(token),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.removeDeviceFailed);
    }
  }

  // Sync
  Future<Map<String, dynamic>?> syncPush(
    String? token,
    String deviceId,
    List<Map<String, dynamic>> changes,
  ) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/sync/push'),
      headers: await _headers(token),
      body: jsonEncode({'deviceId': deviceId, 'changes': changes}),
    );

    if (response.statusCode == 200) {
      return _decodeMap(response.body);
    }
    return null;
  }

  Future<Map<String, dynamic>?> syncPull(
    String? token,
    String deviceId, {
    String? since,
    int limit = 100,
  }) async {
    final queryParams = {'limit': limit.toString()};
    if (since != null) queryParams['since'] = since;

    final uri = Uri.parse('$baseUrl/api/sync/pull/$deviceId').replace(
      queryParameters: queryParams,
    );

    final response = await http.get(uri, headers: await _headers(token));

    if (response.statusCode == 200) {
      return _decodeMap(response.body);
    }
    return null;
  }

  Future<Map<String, dynamic>?> getSyncStatus(String? token, String deviceId) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/sync/status/$deviceId'),
      headers: await _headers(token),
    );

    if (response.statusCode == 200) {
      return _decodeMap(response.body);
    }
    return null;
  }

  // Media upload
  Future<Map<String, dynamic>?> uploadImage(
    String? token,
    String deviceId, {
    required List<int> imageBytes,
    required String filename,
    String? mimeType,
  }) async {
    final uri = Uri.parse('$baseUrl/api/media/image');
    final request = http.MultipartRequest('POST', uri);
    request.headers['Authorization'] = 'Bearer ${await _resolveToken(token)}';
    request.fields['sourceDeviceId'] = deviceId;
    request.files.add(http.MultipartFile.fromBytes(
      'image',
      imageBytes,
      filename: filename,
      // 必须带正确的图片 MIME：服务端 multer fileFilter 只放行 image/*，
      // 缺省 application/octet-stream 会被拒收（截图同步曾因此静默失败）。
      contentType: MediaType.parse(_resolveImageMime(mimeType, filename)),
    ));

    final streamedResponse = await request.send();
    final responseBody = await streamedResponse.stream.bytesToString();
    if (streamedResponse.statusCode == 201) {
      return _decodeMap(responseBody);
    }
    // ignore: avoid_print
    print('[ApiService.uploadImage] Failed (${streamedResponse.statusCode}): $responseBody');
    return null;
  }

  /// 解析上传图片 MIME：显式 mimeType 优先，否则按文件扩展名推断。
  static String _resolveImageMime(String? mimeType, String filename) {
    final explicit = mimeType?.trim();
    if (explicit != null && explicit.isNotEmpty) return explicit;
    final lower = filename.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.bmp')) return 'image/bmp';
    if (lower.endsWith('.jpeg') || lower.endsWith('.jpg')) return 'image/jpeg';
    return 'image/jpeg';
  }

  Future<Map<String, dynamic>?> uploadFile(
    String? token,
    String deviceId, {
    required List<int> fileBytes,
    required String filename,
    String? mimeType,
  }) async {
    final uri = Uri.parse('$baseUrl/api/media/file');
    final request = http.MultipartRequest('POST', uri);
    request.headers['Authorization'] = 'Bearer ${await _resolveToken(token)}';
    request.fields['sourceDeviceId'] = deviceId;
    request.files.add(http.MultipartFile.fromBytes(
      'file',
      fileBytes,
      filename: filename,
    ));

    final response = await request.send();
    if (response.statusCode == 201) {
      return _decodeMap(await response.stream.bytesToString());
    }
    return null;
  }

  // Sessions
  Future<List<Session>> getSessions(String? token) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/sessions'),
      headers: await _headers(token),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchSessionsFailed);
    }

    final dataField = _decodeMap(response.body)['data'];
    final sessionsField = dataField is Map<String, dynamic> ? dataField['sessions'] : null;
    final List<dynamic> data =
        sessionsField is List<dynamic> ? sessionsField : const <dynamic>[];
    return data.map((json) => Session.fromJson(json as Map<String, dynamic>)).toList();
  }

  Future<void> revokeSession(String? token, String sessionId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/api/sessions/$sessionId'),
      headers: await _headers(token),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.revokeFailed);
    }
  }

  Future<void> revokeAllSessions(String? token) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/api/sessions'),
      headers: await _headers(token),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.revokeFailed);
    }
  }

  // Templates

  /// 拉取当前用户的模板列表（T4.2）
  ///
  /// 对齐后端 `GET /api/templates`（src/server/src/routes/templates.js）：
  /// 响应体为 `{ data: [{ id, name, content, created_at, updated_at }, ...] }`，
  /// 按创建时间倒序。结果不做本地缓存（模板可能被任意端增改删，实时性优先）。
  Future<List<ClipboardTemplate>> getTemplates(String? token) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/templates'),
      headers: await _headers(token),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchTemplatesFailed);
    }

    final dynamic raw = _decodeMap(response.body)['data'];
    if (raw is List) {
      return raw
          .whereType<Map<String, dynamic>>()
          .map(ClipboardTemplate.fromJson)
          .toList();
    }
    return const <ClipboardTemplate>[];
  }
}

/// 剪贴板模板（后端 clipboard_templates 行，T4.2）。
///
/// 字段与 `GET /api/templates` 响应一一对应（snake_case）。
/// [content] 支持 `{{变量}}` 占位符：[variableNames] 按出现顺序提取变量名
/// （去重、去除两侧空白），[render] 用给定值替换全部占位符后返回渲染文本。
class ClipboardTemplate {
  final String id;
  final String name;

  /// 模板正文，可含 `{{变量}}` 占位符
  final String content;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const ClipboardTemplate({
    required this.id,
    required this.name,
    this.content = '',
    this.createdAt,
    this.updatedAt,
  });

  factory ClipboardTemplate.fromJson(Map<String, dynamic> json) {
    return ClipboardTemplate(
      id: _asString(json['id']) ?? '',
      name: _asString(json['name']) ?? '',
      content: _asString(json['content']) ?? '',
      createdAt: _asDateTime(json['created_at']),
      updatedAt: _asDateTime(json['updated_at']),
    );
  }

  /// `{{变量}}` 占位符模式：允许占位符两侧任意空白，变量名不含花括号
  static final RegExp _variablePattern = RegExp(r'\{\{\s*([^{}]+?)\s*\}\}');

  /// 模板中出现的变量名（按首次出现顺序去重）
  List<String> get variableNames {
    final List<String> names = <String>[];
    for (final Match match in _variablePattern.allMatches(content)) {
      final String? name = match[1];
      if (name != null && name.isNotEmpty && !names.contains(name)) {
        names.add(name);
      }
    }
    return names;
  }

  /// 是否含变量占位符（决定「使用」时是否进入逐个填写流程）
  bool get hasVariables => variableNames.isNotEmpty;

  /// 渲染模板：所有 `{{变量}}` 替换为 [values] 中对应值，缺失的变量渲染为空串
  String render(Map<String, String> values) {
    return content.replaceAllMapped(_variablePattern, (Match match) {
      final String? name = match[1];
      if (name == null) {
        return match.group(0) ?? '';
      }
      return values[name] ?? '';
    });
  }

  static String? _asString(dynamic v) => v is String ? v : null;

  static DateTime? _asDateTime(dynamic v) =>
      v is String && v.isNotEmpty ? DateTime.tryParse(v) : null;
}
