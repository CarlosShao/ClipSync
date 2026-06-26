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

  factory Device.fromJson(Map<String, dynamic> json) {
    return Device(
      id: json['id'],
      deviceName: json['deviceName'],
      deviceType: json['deviceType'],
      platform: json['platform'],
      platformVersion: json['platformVersion'],
      appVersion: json['appVersion'],
      isOnline: json['isOnline'] ?? false,
      lastSeenAt: json['lastSeenAt'] != null ? DateTime.parse(json['lastSeenAt']) : null,
      createdAt: DateTime.parse(json['createdAt']),
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
