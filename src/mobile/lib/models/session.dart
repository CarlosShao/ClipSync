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
      id: json['id'],
      deviceName: json['deviceName'],
      platform: json['platform'],
      appVersion: json['appVersion'],
      ipAddress: json['ipAddress'],
      userAgent: json['userAgent'],
      createdAt: DateTime.parse(json['createdAt']),
      lastActiveAt: DateTime.parse(json['lastActiveAt']),
      isCurrent: json['isCurrent'] ?? false,
    );
  }
}
