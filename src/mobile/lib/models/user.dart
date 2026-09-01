// lib/models/user.dart

/// 用户模型
class User {
  final String id;
  final String? phone;
  final String? email;
  final String? displayName;
  final String? avatarUrl;
  final String subscriptionStatus;
  final DateTime createdAt;
  final DateTime? lastLoginAt;

  User({
    required this.id,
    this.phone,
    this.email,
    this.displayName,
    this.avatarUrl,
    required this.subscriptionStatus,
    required this.createdAt,
    this.lastLoginAt,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'] as String? ?? '',
      phone: json['phone'] as String?,
      email: json['email'] as String?,
      displayName: json['display_name'] as String?,
      avatarUrl: json['avatar_url'] as String?,
      subscriptionStatus: json['subscription_status'] as String? ?? 'free',
      createdAt: DateTime.tryParse(json['created_at'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      lastLoginAt: json['last_login_at'] is String
          ? DateTime.tryParse(json['last_login_at'] as String)
          : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'phone': phone,
      'email': email,
      'display_name': displayName,
      'avatar_url': avatarUrl,
      'subscription_status': subscriptionStatus,
      'created_at': createdAt.toIso8601String(),
      'last_login_at': lastLoginAt?.toIso8601String(),
    };
  }
}
