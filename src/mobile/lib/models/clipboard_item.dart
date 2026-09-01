import 'dart:convert';

/// 剪贴板条目全量内容模型（T1.1）
///
/// 字段与后端 `GET /api/clipboard` 响应一一对齐（见 src/server/src/routes/clipboard.js
/// 列表接口的 items 映射），并兼容桌面端解析行为（src/desktop/src/composables/clipboardLoad.ts）：
/// - 列表响应只含 `contentPreview`（服务端截断至 5000 字符），**不含完整内容**；
///   完整内容经 `GET /api/clipboard/:id/content` 的 `contentEncrypted` 字段获取
///   （历史命名，实际为明文文本/图片 data URL），拉取后以 [ClipboardItem.copyWith] 回填 [fullContent]。
/// - `metadata` 后端可能是 jsonb 对象，也可能（历史数据/WS）是 JSON 字符串，fromJson 统一归一为 Map。
class ClipboardItem {
  final String id;

  /// 类型：text / link / image / file / code（后端 isValidContentType 白名单）
  final String contentType;

  /// 完整内容体（nullable）。列表接口不返回该字段，按需经内容接口拉取后回填。
  final String? fullContent;

  /// 截断预览（服务端最长 5000 字符），用于列表展示与搜索
  final String contentPreview;

  /// 图片 OCR 文本（后端 ocr_text，可能为空串）
  final String ocrText;

  /// 完整内容的字节大小（后端 content_size）
  final int contentSize;

  /// 元数据（归一化为 Map，可能含 tags / pinned / originalName / paths 等）
  final Map<String, dynamic> metadata;

  final bool isFavorite;
  final DateTime? favoritedAt;

  /// 是否已归档（后端 archived）
  final bool isArchived;
  final DateTime? expiresAt;
  final DateTime createdAt;
  final DateTime? updatedAt;

  /// 保护级别：none / pin / advanced（后端 protection_level）
  final String protectionLevel;

  /// 来源设备 id（顶层冗余字段，WS payload 或部分接口可能直接给出）
  final String? sourceDeviceId;

  /// 来源设备信息（列表响应由 LEFT JOIN devices 得出，可能为 null）
  final DeviceInfo? sourceDevice;

  ClipboardItem({
    required this.id,
    required this.contentType,
    this.fullContent,
    this.contentPreview = '',
    this.ocrText = '',
    this.contentSize = 0,
    this.metadata = const {},
    this.isFavorite = false,
    this.favoritedAt,
    this.isArchived = false,
    this.expiresAt,
    required this.createdAt,
    this.updatedAt,
    this.protectionLevel = 'none',
    this.sourceDeviceId,
    this.sourceDevice,
  });

  factory ClipboardItem.fromJson(Map<String, dynamic> json) {
    final deviceJson = json['sourceDevice'];
    final topDeviceId = _asString(json['sourceDeviceId']);
    return ClipboardItem(
      id: _asString(json['id']) ?? '',
      contentType: _asString(json['contentType']) ??
          _asString(json['type']) ??
          'text',
      fullContent: _asString(json['content']),
      contentPreview: _asString(json['contentPreview']) ?? '',
      ocrText: _asString(json['ocrText']) ?? '',
      contentSize: _asInt(json['contentSize']),
      metadata: _normalizeMetadata(json['metadata']),
      isFavorite: _asBool(json['isFavorite']),
      favoritedAt: _asDateTime(json['favoritedAt']),
      isArchived: _asBool(json['archived']),
      expiresAt: _asDateTime(json['expiresAt'] ?? json['expires_at']),
      createdAt:
          _asDateTime(json['createdAt']) ?? DateTime.fromMillisecondsSinceEpoch(0),
      updatedAt: _asDateTime(json['updatedAt']),
      protectionLevel: _asString(json['protectionLevel']) ?? 'none',
      sourceDeviceId:
          (topDeviceId != null && topDeviceId.isNotEmpty) ? topDeviceId : null,
      sourceDevice: deviceJson is Map<String, dynamic>
          ? DeviceInfo.fromJson(deviceJson)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'contentType': contentType,
        if (fullContent != null) 'content': fullContent,
        'contentPreview': contentPreview,
        'ocrText': ocrText,
        'contentSize': contentSize,
        'metadata': metadata,
        'isFavorite': isFavorite,
        if (favoritedAt != null) 'favoritedAt': favoritedAt!.toIso8601String(),
        'archived': isArchived,
        if (expiresAt != null) 'expiresAt': expiresAt!.toIso8601String(),
        'createdAt': createdAt.toIso8601String(),
        if (updatedAt != null) 'updatedAt': updatedAt!.toIso8601String(),
        'protectionLevel': protectionLevel,
        if (sourceDeviceId != null) 'sourceDeviceId': sourceDeviceId,
        if (sourceDevice != null) 'sourceDevice': sourceDevice!.toJson(),
      };

  ClipboardItem copyWith({
    String? contentType,
    String? fullContent,
    String? contentPreview,
    String? ocrText,
    int? contentSize,
    Map<String, dynamic>? metadata,
    bool? isFavorite,
    DateTime? favoritedAt,
    bool? isArchived,
    DateTime? expiresAt,
    DateTime? createdAt,
    DateTime? updatedAt,
    String? protectionLevel,
    String? sourceDeviceId,
    DeviceInfo? sourceDevice,
  }) {
    return ClipboardItem(
      id: id,
      contentType: contentType ?? this.contentType,
      fullContent: fullContent ?? this.fullContent,
      contentPreview: contentPreview ?? this.contentPreview,
      ocrText: ocrText ?? this.ocrText,
      contentSize: contentSize ?? this.contentSize,
      metadata: metadata ?? this.metadata,
      isFavorite: isFavorite ?? this.isFavorite,
      favoritedAt: favoritedAt ?? this.favoritedAt,
      isArchived: isArchived ?? this.isArchived,
      expiresAt: expiresAt ?? this.expiresAt,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      protectionLevel: protectionLevel ?? this.protectionLevel,
      sourceDeviceId: sourceDeviceId ?? this.sourceDeviceId,
      sourceDevice: sourceDevice ?? this.sourceDevice,
    );
  }

  /// 是否已持有完整内容
  bool get hasFullContent => fullContent != null && fullContent!.isNotEmpty;

  /// 完整文本（无完整内容时退化为预览）
  String get copyText => hasFullContent ? fullContent! : contentPreview;

  /// 预览疑似被截断（对齐桌面端 useClipboard.ts 的判定：
  /// contentSize 未知，或当前文本长度 < 服务端字节大小 → 需要拉取完整内容）
  bool get mayBeTruncated =>
      !hasFullContent && (contentSize <= 0 || contentPreview.length < contentSize);

  /// 是否置顶（桌面端约定：metadata.pinned === true）
  bool get isPinned => metadata['pinned'] == true;

  /// 是否已过期（C3：expiresAt 非空且早于当前时刻）
  bool get isExpired {
    final DateTime? expires = expiresAt;
    return expires != null && expires.isBefore(DateTime.now());
  }

  /// 是否受密码保护（C3：protection_level 非 none，解锁走 POST /api/protection/unlock）
  bool get isProtected => protectionLevel != 'none' && protectionLevel.isNotEmpty;

  /// 返回清除过期时间的副本（C3）。
  ///
  /// [copyWith] 对可空字段的语义是「传 null = 保留原值」，无法显式置空，
  /// 清除过期时间（expiryNever）时使用本方法。
  ClipboardItem withoutExpiry() {
    return ClipboardItem(
      id: id,
      contentType: contentType,
      fullContent: fullContent,
      contentPreview: contentPreview,
      ocrText: ocrText,
      contentSize: contentSize,
      metadata: metadata,
      isFavorite: isFavorite,
      favoritedAt: favoritedAt,
      isArchived: isArchived,
      expiresAt: null,
      createdAt: createdAt,
      updatedAt: updatedAt,
      protectionLevel: protectionLevel,
      sourceDeviceId: sourceDeviceId,
      sourceDevice: sourceDevice,
    );
  }

  /// 标签列表（桌面端约定：metadata.tags 数组）
  List<String> get tags {
    final raw = metadata['tags'];
    if (raw is List) {
      return raw.whereType<String>().toList();
    }
    return const [];
  }

  String get typeIcon {
    switch (contentType) {
      case 'text':
        return 'text';
      case 'image':
        return 'image';
      case 'link':
        return 'link';
      case 'file':
        return 'file';
      case 'code':
        return 'code';
      default:
        return 'text';
    }
  }

  // ---------- 类型判定 / 文件名辅助（T2.5 详情预览页，纯追加只读 getter） ----------

  /// 是否图片条目
  bool get isImage => contentType == 'image';

  /// 是否文件条目
  bool get isFile => contentType == 'file';

  /// 是否链接条目
  bool get isLink => contentType == 'link';

  /// 是否代码条目
  bool get isCode => contentType == 'code';

  /// 是否纯文本条目
  bool get isText => contentType == 'text';

  /// 文件显示名（元数据 fileName 优先，回退 originalName；均缺省返回 null）
  String? get fileName {
    final dynamic name = metadata['fileName'] ?? metadata['originalName'];
    if (name is String && name.isNotEmpty) return name;
    return null;
  }

  // ---------- 防御性解析工具（后端/WS 字段可能缺省或类型漂移） ----------

  static String? _asString(dynamic v) => v is String ? v : null;

  static int _asInt(dynamic v) => v is int ? v : (v is num ? v.toInt() : 0);

  static bool _asBool(dynamic v) => v == true || v == 'true';

  static DateTime? _asDateTime(dynamic v) {
    if (v is String && v.isNotEmpty) {
      return DateTime.tryParse(v);
    }
    if (v is num) {
      return DateTime.fromMillisecondsSinceEpoch(v.toInt());
    }
    return null;
  }

  /// metadata 可能是 JSON 字符串（兼容）或已解析对象，统一归一为 Map
  static Map<String, dynamic> _normalizeMetadata(dynamic v) {
    if (v is Map<String, dynamic>) return v;
    if (v is String && v.isNotEmpty) {
      try {
        final parsed = jsonDecode(v);
        if (parsed is Map<String, dynamic>) return parsed;
      } catch (_) {
        // 非 JSON 字符串，按空 metadata 处理
      }
    }
    return const {};
  }
}

/// 来源设备信息（列表响应：LEFT JOIN devices 的 device_name / platform）
class DeviceInfo {
  final String? id;
  final String? name;
  final String? platform;

  const DeviceInfo({this.id, this.name, this.platform});

  factory DeviceInfo.fromJson(Map<String, dynamic> json) {
    return DeviceInfo(
      id: json['id'] is String ? json['id'] as String : null,
      name: json['name'] is String ? json['name'] as String : null,
      platform: json['platform'] is String ? json['platform'] as String : null,
    );
  }

  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        if (name != null) 'name': name,
        if (platform != null) 'platform': platform,
      };
}

/// `GET /api/clipboard` 分页响应（items + pagination）
class ClipboardPage {
  final List<ClipboardItem> items;
  final int page;
  final int limit;
  final int total;
  final int totalPages;

  const ClipboardPage({
    required this.items,
    this.page = 1,
    this.limit = 50,
    this.total = 0,
    this.totalPages = 0,
  });

  /// 是否还有下一页（pagination 缺失时退化为"本页拿满即可能有更多"的旧启发式）
  bool get hasMore {
    if (totalPages > 0) return page < totalPages;
    return items.length >= limit && limit > 0;
  }

  factory ClipboardPage.fromJson(Map<String, dynamic> json) {
    final rawItems = json['items'];
    final items = rawItems is List
        ? rawItems
            .whereType<Map<String, dynamic>>()
            .map(ClipboardItem.fromJson)
            .toList()
        : <ClipboardItem>[];

    final pagination = json['pagination'];
    int page = 1;
    int limit = 50;
    int total = items.length;
    int totalPages = 0;
    if (pagination is Map<String, dynamic>) {
      page = _asInt(pagination['page'], 1);
      limit = _asInt(pagination['limit'], 50);
      total = _asInt(pagination['total'], items.length);
      totalPages = _asInt(pagination['totalPages'], 0);
    }
    if (totalPages <= 0 && limit > 0) {
      totalPages = (total / limit).ceil();
    }
    return ClipboardPage(
      items: items,
      page: page,
      limit: limit,
      total: total,
      totalPages: totalPages,
    );
  }

  static int _asInt(dynamic v, int fallback) =>
      v is int ? v : (v is num ? v.toInt() : fallback);
}
