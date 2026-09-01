import 'dart:convert';

import 'package:http/http.dart' as http;

import 'app_exception.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 收藏夹分组（后端 favorite_collections 行 + item_count 聚合列）。
///
/// 字段与 `GET /api/favorites/collections` 响应一一对应（snake_case，
/// 见 src/server/src/routes/favorites.js 的列表查询）：
/// - `item_count` 为组内仍然存在且 is_favorite=TRUE 的条目数；
/// - `path` 为 ltree 层级路径（'root.xxx' 或 'root.parent.child'）。
class CollectionGroup {
  final String id;
  final String name;

  /// 图标 emoji（后端创建时默认 '📁'）
  final String icon;

  /// ltree 层级路径，用于区分根分组与子分组
  final String path;
  final int sortOrder;

  /// 组内条目数（服务端聚合列 item_count）
  final int itemCount;
  final DateTime? createdAt;

  const CollectionGroup({
    required this.id,
    required this.name,
    this.icon = '📁',
    this.path = '',
    this.sortOrder = 0,
    this.itemCount = 0,
    this.createdAt,
  });

  factory CollectionGroup.fromJson(Map<String, dynamic> json) {
    return CollectionGroup(
      id: _asString(json['id']) ?? '',
      name: _asString(json['name']) ?? '',
      icon: _asString(json['icon']) ?? '📁',
      path: _asString(json['path']) ?? '',
      sortOrder: _asInt(json['sort_order']),
      itemCount: _asInt(json['item_count']),
      createdAt: _asDateTime(json['created_at']),
    );
  }

  static String? _asString(dynamic v) => v is String ? v : null;

  static int _asInt(dynamic v) => v is int ? v : (v is num ? v.toInt() : 0);

  static DateTime? _asDateTime(dynamic v) =>
      v is String && v.isNotEmpty ? DateTime.tryParse(v) : null;
}

/// 收藏夹组内条目（`GET /api/favorites/collections/:id/items` 行）。
///
/// 注意：该接口只返回 content_preview（与剪贴板列表一致，服务端截断至
/// 5000 字符），**不含完整内容**；复制全文需另走
/// `GET /api/clipboard/:id/content`（即 ApiService.getItemContent 的既有路径）。
class FavoriteEntry {
  final String id;

  /// 类型：text / link / image / file / code
  final String contentType;

  /// 截断预览（服务端最长 5000 字符）
  final String contentPreview;

  /// 完整内容的字节大小（用于判断预览是否被截断）
  final int contentSize;

  /// 来源设备名（LEFT JOIN devices，可能为 null）
  final String? deviceName;

  /// 来源设备平台（windows / macos / android …）
  final String? platform;
  final bool isFavorite;
  final DateTime? favoritedAt;
  final DateTime? createdAt;

  const FavoriteEntry({
    required this.id,
    this.contentType = 'text',
    this.contentPreview = '',
    this.contentSize = 0,
    this.deviceName,
    this.platform,
    this.isFavorite = false,
    this.favoritedAt,
    this.createdAt,
  });

  factory FavoriteEntry.fromJson(Map<String, dynamic> json) {
    return FavoriteEntry(
      id: _asString(json['id']) ?? '',
      contentType: _asString(json['content_type']) ?? 'text',
      contentPreview: _asString(json['content_preview']) ?? '',
      contentSize: _asInt(json['content_size']),
      deviceName: _asString(json['device_name']),
      platform: _asString(json['platform']),
      isFavorite: json['is_favorite'] == true,
      favoritedAt: _asDateTime(json['favorited_at']),
      createdAt: _asDateTime(json['created_at']),
    );
  }

  /// 是否文本类条目（可复制全文的类型，对齐 ClipboardProvider.resolveCopyText）
  bool get isTextLike => const <String>{'text', 'link', 'code'}.contains(contentType);

  /// 预览疑似被截断（对齐 ClipboardItem.mayBeTruncated 的判定）
  bool get mayBeTruncated => contentSize <= 0 || contentPreview.length < contentSize;

  static String? _asString(dynamic v) => v is String ? v : null;

  static int _asInt(dynamic v) => v is int ? v : (v is num ? v.toInt() : 0);

  static DateTime? _asDateTime(dynamic v) =>
      v is String && v.isNotEmpty ? DateTime.tryParse(v) : null;
}

/// 收藏夹（Collections）API 封装（T4.1）。
///
/// 对齐后端 `/api/favorites` 路由（src/server/src/routes/favorites.js）：
/// - GET    /api/favorites/collections                 → { collections: [...] }
/// - POST   /api/favorites/collections {name}         → 201 { collection: {...} }
/// - DELETE /api/favorites/collections/:id             → { message }（级联删除子分组）
/// - GET    /api/favorites/collections/:id/items       → { items: [...] }
///
/// Bearer 令牌统一走 [TokenStore.getAccessToken()]（T1.2 冻结契约），
/// 未登录时抛出异常由 UI 层展示错误态。
class CollectionsApiService {
  static String get _baseUrl => '${ServerConfig.baseUrl}/api/favorites';

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

  /// 获取当前用户所有收藏夹分组（含 item_count 聚合），按 sort_order 排序。
  Future<List<CollectionGroup>> listCollections() async {
    final response = await http.get(
      Uri.parse('$_baseUrl/collections'),
      headers: await _headers(),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchCollectionsFailed);
    }

    final dynamic raw = _decodeMap(response.body)['collections'];
    if (raw is List) {
      return raw
          .whereType<Map<String, dynamic>>()
          .map(CollectionGroup.fromJson)
          .toList();
    }
    return const <CollectionGroup>[];
  }

  /// 创建收藏夹分组（根级；后端新分组 sort_order=0 排最前）。
  ///
  /// 名称超 100 字符由后端截断；成功返回新建分组（201）。
  Future<CollectionGroup> createCollection(String name) async {
    final response = await http.post(
      Uri.parse('$_baseUrl/collections'),
      headers: await _headers(),
      body: jsonEncode(<String, String>{'name': name}),
    );

    if (response.statusCode != 201) {
      throw const AppException(AppErrorCodes.createCollectionFailed);
    }

    final dynamic raw = _decodeMap(response.body)['collection'];
    if (raw is Map<String, dynamic>) {
      return CollectionGroup.fromJson(raw);
    }
    throw const AppException(AppErrorCodes.createCollectionFailed);
  }

  /// 删除收藏夹分组（后端级联删除其所有子分组；组内剪贴板条目不受影响）。
  Future<void> deleteCollection(String id) async {
    final response = await http.delete(
      Uri.parse('$_baseUrl/collections/$id'),
      headers: await _headers(),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.deleteCollectionFailed);
    }
  }

  /// 获取收藏夹组内条目列表（按组内 sort_order 排序）。
  Future<List<FavoriteEntry>> listCollectionItems(String collectionId) async {
    final response = await http.get(
      Uri.parse('$_baseUrl/collections/$collectionId/items'),
      headers: await _headers(),
    );

    if (response.statusCode != 200) {
      throw const AppException(AppErrorCodes.fetchCollectionItemsFailed);
    }

    final dynamic raw = _decodeMap(response.body)['items'];
    if (raw is List) {
      return raw
          .whereType<Map<String, dynamic>>()
          .map(FavoriteEntry.fromJson)
          .toList();
    }
    return const <FavoriteEntry>[];
  }
}
