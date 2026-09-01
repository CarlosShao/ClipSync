class Device {
  final String id;
  final String deviceName;
  final String deviceType;
  final String platform;
  final String? platformVersion;
  final String? appVersion;
  final bool isOnline;
  final DateTime? lastSeenAt;
  final DateTime createdAt;

  Device({
    required this.id,
    required this.deviceName,
    required this.deviceType,
    required this.platform,
    this.platformVersion,
    this.appVersion,
    this.isOnline = false,
    this.lastSeenAt,
    required this.createdAt,
  });

  /// 防御式解析：服务端返回 snake_case（device_name/is_online/last_seen_at），
  /// 历史兼容 camelCase；任何字段缺失/类型不符都不允许崩溃
  /// （此前 camelCase 直取 + DateTime.parse(null) 导致设备页整页加载失败）
  factory Device.fromJson(Map<String, dynamic> json) {
    String readString(List<String> keys, [String fallback = '']) {
      for (final k in keys) {
        final v = json[k];
        if (v is String && v.isNotEmpty) return v;
      }
      return fallback;
    }

    DateTime? readDate(List<String> keys) {
      for (final k in keys) {
        final v = json[k];
        if (v is String && v.isNotEmpty) {
          try {
            return DateTime.parse(v);
          } catch (_) {
            /* ignore malformed date */
          }
        }
      }
      return null;
    }

    bool readBool(List<String> keys) {
      for (final k in keys) {
        final v = json[k];
        if (v is bool) return v;
      }
      return false;
    }

    return Device(
      id: readString(const ['id']),
      // 设备名缺失时返回空串，UI 层用 l10n unknownDevice 兜底（A3 解耦：
      // model 不再内嵌中文默认值）
      deviceName: readString(const ['device_name', 'deviceName']),
      deviceType: readString(const ['device_type', 'deviceType'], 'desktop'),
      platform: readString(const ['platform'], 'unknown'),
      platformVersion: readString(const ['platform_version', 'platformVersion']),
      appVersion: readString(const ['app_version', 'appVersion']),
      isOnline: readBool(const ['is_online', 'isOnline']),
      lastSeenAt: readDate(const ['last_seen_at', 'lastSeenAt']),
      createdAt: readDate(const ['created_at', 'createdAt']) ?? DateTime.now(),
    );
  }

  String get deviceIcon {
    switch (deviceType) {
      case 'desktop':
        return 'computer';
      case 'mobile':
        return 'phone_iphone';
      case 'tablet':
        return 'tablet_mac';
      default:
        return 'devices_other';
    }
  }
}
