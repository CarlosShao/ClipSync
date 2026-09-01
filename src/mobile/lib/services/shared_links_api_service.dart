import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/clipboard_item.dart';
import 'api_service.dart';
import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 共享链接（后端 shared_links 行，C5）。
///
/// 字段与 `GET /api/shared-links` 响应一一对应（见
/// src/server/src/routes/sharedLinks.js 的列表查询）：
/// - [url] 由后端按请求 origin / SHARE_LINK_BASE_URL 生成，前端不自行拼域名；
/// - [title] 后端兜底为 content_preview 或 '(无标题)'；
/// - [expiresAt] 为 null 表示永不过期。
class SharedLink {
  final String id;
  final String title;
  final String url;

  /// 类型：text / link / image / file
  final String contentType;
  final String? fileName;
  final int fileSize;

  /// 内容预览（文件类型为文件名）
  final String? preview;

  /// 公开访问次数（打开公开页时服务端自增）
  final int views;
  final DateTime? createdAt;
  final DateTime? expiresAt;

  const SharedLink({
    required this.id,
    required this.title,
    required this.url,
    this.contentType = 'text',
    this.fileName,
    this.fileSize = 0,
    this.preview,
    this.views = 0,
    this.createdAt,
    this.expiresAt,
  });

  factory SharedLink.fromJson(Map<String, dynamic> json) {
    return SharedLink(
      id: _asId(json['id']),
      title: _asString(json['title']) ?? '',
      url: _asString(json['url']) ?? '',
      contentType: _asString(json['contentType']) ?? 'text',
      fileName: _asString(json['fileName']),
      fileSize: _asInt(json['fileSize']),
      preview: _asString(json['preview']),
      views: _asInt(json['views']),
      createdAt: _asDateTime(json['createdAt']),
      expiresAt: _asDateTime(json['expiresAt']),
    );
  }

  /// 是否已过期（无过期时间视为永不过期）
  bool get isExpired => expiresAt != null && expiresAt!.isBefore(DateTime.now());

  static String? _asString(dynamic v) => v is String ? v : null;

  /// id 兼容：后端可能返回字符串（UUID）或数字（SERIAL）
  static String _asId(dynamic v) =>
      v is String ? v : (v is num ? v.toString() : '');

  static int _asInt(dynamic v) => v is int ? v : (v is num ? v.toInt() : 0);

  static DateTime? _asDateTime(dynamic v) =>
      v is String && v.isNotEmpty ? DateTime.tryParse(v) : null;
}

/// 分享文件预上传结果（`POST /api/shared-links/upload-file` 响应）。
///
/// fileKey 在后续创建链接请求中原样回传，后端据此取回已落盘的文件。
class SharedFileUpload {
  final String fileKey;
  final String fileName;
  final int fileSize;

  const SharedFileUpload({
    required this.fileKey,
    required this.fileName,
    required this.fileSize,
  });

  factory SharedFileUpload.fromJson(Map<String, dynamic> json) {
    return SharedFileUpload(
      fileKey: json['fileKey'] is String ? json['fileKey'] as String : '',
      fileName: json['fileName'] is String ? json['fileName'] as String : '',
      fileSize: json['fileSize'] is int
          ? json['fileSize'] as int
          : (json['fileSize'] is num ? (json['fileSize'] as num).toInt() : 0),
    );
  }
}

/// 共享链接（Shared Links）API 封装（C5）。
///
/// 对齐后端 `/api/shared-links` 路由（src/server/src/routes/sharedLinks.js）：
/// - GET    /api/shared-links            → { links: [...] }
/// - POST   /api/shared-links            → 201 { id, token, url, ... }
/// - DELETE /api/shared-links/:id        → 204
/// - POST   /api/shared-links/upload-file（multipart，文件分享预上传）
///
/// Bearer 令牌统一走 [TokenStore.getAccessToken()]（T1.2 冻结契约），
/// 服务端 csrfProtection 对 Bearer 请求直接放行（见 csrf.js）。
class SharedLinksApiService {
  static String get _baseUrl => '${ServerConfig.baseUrl}/api/shared-links';

  /// 后端创建接口的内容上限（sharedLinks.js MAX_CONTENT）
  static const int maxContentLength = 5000000;

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

  /// 从错误响应体提取可读 detail（后端 error 文案优先，回退 HTTP 状态码）。
  static String _errorDetail(http.Response response) {
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) {
        final dynamic err = decoded['error'] ?? decoded['message'];
        if (err is String && err.isNotEmpty) return err;
      }
    } catch (_) {
      // 响应体非 JSON，回退状态码
    }
    return 'HTTP ${response.statusCode}';
  }

  /// 获取当前用户全部共享链接（按创建时间倒序）。
  Future<List<SharedLink>> listLinks() async {
    final response = await http.get(
      Uri.parse(_baseUrl),
      headers: await _headers(),
    );

    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.fetchSharedLinksFailed,
        _errorDetail(response),
      );
    }

    final dynamic raw = _decodeMap(response.body)['links'];
    if (raw is List) {
      return raw
          .whereType<Map<String, dynamic>>()
          .map(SharedLink.fromJson)
          .toList();
    }
    return const <SharedLink>[];
  }

  /// 创建共享链接（内容由服务端 at-rest 加密存储）。
  ///
  /// - 文本类：[content] 必填（≤5MB），[contentType] 取 text/link/code/image；
  /// - 文件类：[contentType] 传 'file'，[fileKey] 为 uploadSharedFile 返回值；
  /// - [expiresInHours] 为 null 或 ≤0 表示永不过期。
  ///
  /// 成功返回 201 创建结果（含 [SharedLink.url]）。
  Future<SharedLink> createLink({
    String? content,
    String? title,
    String? contentType,
    int? expiresInHours,
    String? fileKey,
    String? fileName,
    int? fileSize,
  }) async {
    final body = <String, dynamic>{
      if (content != null) 'content': content,
      if (title != null && title.isNotEmpty) 'title': title,
      if (contentType != null) 'contentType': contentType,
      if (expiresInHours != null && expiresInHours > 0)
        'expiresInHours': expiresInHours,
      if (fileKey != null) 'fileKey': fileKey,
      if (fileName != null) 'fileName': fileName,
      if (fileSize != null) 'fileSize': fileSize,
    };

    final response = await http.post(
      Uri.parse(_baseUrl),
      headers: await _headers(),
      body: jsonEncode(body),
    );

    if (response.statusCode != 201) {
      throw AppException(
        AppErrorCodes.createSharedLinkFailed,
        _errorDetail(response),
      );
    }

    return SharedLink.fromJson(_decodeMap(response.body));
  }

  /// 撤销（删除）共享链接，链接立即失效（后端同时清理已分享的文件）。
  Future<void> revokeLink(String id) async {
    final response = await http.delete(
      Uri.parse('$_baseUrl/$id'),
      headers: await _headers(),
    );

    if (response.statusCode != 204) {
      throw AppException(
        AppErrorCodes.revokeSharedLinkFailed,
        _errorDetail(response),
      );
    }
  }

  /// 预上传要分享的文件（不创建链接，只落盘），返回 fileKey 供 [createLink] 使用。
  Future<SharedFileUpload> uploadSharedFile({
    required List<int> bytes,
    required String filename,
  }) async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }

    final request = http.MultipartRequest(
      'POST',
      Uri.parse('$_baseUrl/upload-file'),
    );
    request.headers['Authorization'] = 'Bearer $token';
    request.files.add(
      http.MultipartFile.fromBytes('file', bytes, filename: filename),
    );

    final response = await request.send();
    final body = await response.stream.bytesToString();
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.createSharedLinkFailed,
        'HTTP ${response.statusCode}',
      );
    }
    return SharedFileUpload.fromJson(_decodeMap(body));
  }

  /// 由剪贴板条目创建共享链接（组合封装：条目内容解析 → createLink）。
  ///
  /// - text/link/code：优先取完整内容（GET /api/clipboard/:id/content，
  ///   列表预览截断至 5000 字符），失败回退预览；
  /// - image：优先取 data URL 内容（旧版数据），新版 media 记录经
  ///   GET /api/media/:id/preview 下载后转 data URL（>3.5MB 拒绝，
  ///   防止 base64 膨胀超服务端 5MB 上限）；
  /// - file：经 GET /api/media/:id/download 下载 → upload-file 预上传 →
  ///   以 fileKey 创建（文件不在来源设备本机时下载必然失败，由调用方
  ///   经错误文案兜底）。
  Future<SharedLink> createLinkFromClipboardItem(
    ClipboardItem item, {
    int? expiresInHours,
  }) async {
    switch (item.contentType) {
      case 'file':
        return _createFromFileItem(item, expiresInHours);
      case 'image':
        return _createFromImageItem(item, expiresInHours);
      default:
        return _createFromTextItem(item, expiresInHours);
    }
  }

  Future<SharedLink> _createFromTextItem(
    ClipboardItem item,
    int? expiresInHours,
  ) async {
    var content = item.copyText;
    try {
      final full = await ApiService().getItemContent(null, item.id);
      if (full != null && full.isNotEmpty) content = full;
    } on Exception catch (_) {
      // 完整内容获取失败：回退列表预览（≤5000 字符）
    }
    if (content.trim().isEmpty) {
      throw const AppException(
        AppErrorCodes.createSharedLinkFailed,
        'empty content',
      );
    }
    if (content.length > maxContentLength) {
      throw const AppException(
        AppErrorCodes.createSharedLinkFailed,
        'content too large',
      );
    }
    return createLink(
      content: content,
      contentType: item.contentType,
      expiresInHours: expiresInHours,
    );
  }

  Future<SharedLink> _createFromImageItem(
    ClipboardItem item,
    int? expiresInHours,
  ) async {
    String? content = item.fullContent;
    if (content == null || !content.startsWith('data:image')) {
      try {
        final fetched = await ApiService().getItemContent(null, item.id);
        if (fetched != null && fetched.isNotEmpty) content = fetched;
      } on Exception catch (_) {
        // 内容接口失败：继续走 media 预览通道
      }
    }
    if (content == null || !content.startsWith('data:image')) {
      content = await _downloadImageAsDataUrl(item.id);
    }
    return createLink(
      content: content,
      contentType: 'image',
      expiresInHours: expiresInHours,
    );
  }

  /// 新版图片为 media 记录（无 data URL）：下载预览转 base64 data URL。
  Future<String> _downloadImageAsDataUrl(String itemId) async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    final response = await http
        .get(
          Uri.parse('${ServerConfig.baseUrl}/api/media/$itemId/preview'),
          headers: <String, String>{'Authorization': 'Bearer $token'},
        )
        .timeout(const Duration(seconds: 60));
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.createSharedLinkFailed,
        'HTTP ${response.statusCode}',
      );
    }
    // base64 膨胀约 4/3，>3.5MB 的原图转码后必超服务端 5MB 内容上限
    if (response.bodyBytes.length > 3500000) {
      throw const AppException(
        AppErrorCodes.createSharedLinkFailed,
        'content too large',
      );
    }
    final dynamic mime = response.headers['content-type']?.split(';').first.trim();
    final safeMime =
        mime is String && mime.startsWith('image/') ? mime : 'image/png';
    return 'data:$safeMime;base64,${base64Encode(response.bodyBytes)}';
  }

  Future<SharedLink> _createFromFileItem(
    ClipboardItem item,
    int? expiresInHours,
  ) async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }
    // 文件条目 content 为来源设备本机路径，实际文件经 media 下载端点获取
    final response = await http
        .get(
          Uri.parse('${ServerConfig.baseUrl}/api/media/${item.id}/download'),
          headers: <String, String>{'Authorization': 'Bearer $token'},
        )
        .timeout(const Duration(seconds: 120));
    if (response.statusCode != 200) {
      throw AppException(
        AppErrorCodes.createSharedLinkFailed,
        'HTTP ${response.statusCode}',
      );
    }
    final filename = (item.fileName != null && item.fileName!.isNotEmpty)
        ? item.fileName!
        : 'clip-file-${item.id}';
    final upload = await uploadSharedFile(
      bytes: response.bodyBytes,
      filename: filename,
    );
    return createLink(
      contentType: 'file',
      expiresInHours: expiresInHours,
      fileKey: upload.fileKey,
      fileName: upload.fileName,
      fileSize: upload.fileSize,
      title: upload.fileName,
    );
  }
}
