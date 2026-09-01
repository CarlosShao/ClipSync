class Session {
  final String id;
  final String? deviceName;
  final String? platform;
  final String? appVersion;
  final String? ipAddress;
  final String? userAgent;
  final DateTime createdAt;
  final DateTime lastActiveAt;
  final bool isCurrent;

  Session({
    required this.id,
    this.deviceName,
    this.platform,
    this.appVersion,
    this.ipAddress,
    this.userAgent,
    required this.createdAt,
    required this.lastActiveAt,
    this.isCurrent = false,
  });

  factory Session.fromJson(Map<String, dynamic> json) {
    return Session(
      id: json['id'] as String? ?? '',
      deviceName: json['deviceName'] as String?,
      platform: json['platform'] as String?,
      appVersion: json['appVersion'] as String?,
      ipAddress: json['ipAddress'] as String?,
      userAgent: json['userAgent'] as String?,
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      lastActiveAt: DateTime.tryParse(json['lastActiveAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      isCurrent: json['isCurrent'] as bool? ?? false,
    );
  }
}
