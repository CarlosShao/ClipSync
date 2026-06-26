class ClipboardItem {
  final String id;
  final String contentType;
  final String contentPreview;
  final int contentSize;
  final Map<String, dynamic>? metadata;
  final bool isFavorite;
  final DateTime? expiresAt;
  final DateTime createdAt;
  final DeviceInfo? sourceDevice;

  ClipboardItem({
    required this.id,
    required this.contentType,
    required this.contentPreview,
    this.contentSize = 0,
    this.metadata,
    this.isFavorite = false,
    this.expiresAt,
    required this.createdAt,
    this.sourceDevice,
  });

  factory ClipboardItem.fromJson(Map<String, dynamic> json) {
    return ClipboardItem(
      id: json['id'],
      contentType: json['contentType'],
      contentPreview: json['contentPreview'] ?? '',
      contentSize: json['contentSize'] ?? 0,
      metadata: json['metadata'],
      isFavorite: json['isFavorite'] ?? false,
      expiresAt: json['expiresAt'] != null ? DateTime.parse(json['expiresAt']) : null,
      createdAt: DateTime.parse(json['createdAt']),
      sourceDevice: json['sourceDevice'] != null
          ? DeviceInfo.fromJson(json['sourceDevice'])
          : null,
    );
  }

  ClipboardItem copyWith({
    String? contentType,
    String? contentPreview,
    bool? isFavorite,
  }) {
    return ClipboardItem(
      id: id,
      contentType: contentType ?? this.contentType,
      contentPreview: contentPreview ?? this.contentPreview,
      contentSize: contentSize,
      metadata: metadata,
      isFavorite: isFavorite ?? this.isFavorite,
      expiresAt: expiresAt,
      createdAt: createdAt,
      sourceDevice: sourceDevice,
    );
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
      default:
        return 'text';
    }
  }

  String get typeLabel {
    switch (contentType) {
      case 'text':
        return '文本';
      case 'image':
        return '图片';
      case 'link':
        return '链接';
      case 'file':
        return '文件';
      default:
        return contentType;
    }
  }
}

class DeviceInfo {
  final String? name;
  final String? platform;

  DeviceInfo({this.name, this.platform});

  factory DeviceInfo.fromJson(Map<String, dynamic> json) {
    return DeviceInfo(
      name: json['name'],
      platform: json['platform'],
    );
  }
}
