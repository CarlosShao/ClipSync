import 'package:flutter/foundation.dart';

/// 订阅计划模型
class SubscriptionPlan {
  final String id;
  final String name;
  final String? description;
  final double price;
  final String currency;
  final String interval;
  final int maxDevices;
  final int maxClipboardPerDay;
  final int maxStorageMB;
  final bool hasOcr;
  final bool hasPrioritySync;
  final bool hasAICategories;
  final bool hasTeamSharing;
  final bool isActive;
  final String? paywallFeature1;
  final String? paywallFeature2;
  final String? paywallFeature3;
  final DateTime createdAt;
  final DateTime updatedAt;

  SubscriptionPlan({
    required this.id,
    required this.name,
    this.description,
    required this.price,
    required this.currency,
    required this.interval,
    required this.maxDevices,
    required this.maxClipboardPerDay,
    required this.maxStorageMB,
    this.hasOcr = false,
    this.hasPrioritySync = false,
    this.hasAICategories = false,
    this.hasTeamSharing = false,
    this.isActive = true,
    this.paywallFeature1,
    this.paywallFeature2,
    this.paywallFeature3,
    required this.createdAt,
    required this.updatedAt,
  });

  /// 从 JSON 创建订阅计划
  factory SubscriptionPlan.fromJson(Map<String, dynamic> json) {
    return SubscriptionPlan(
      id: json['id'],
      name: json['name'],
      description: json['description'],
      price: (json['price'] as num).toDouble(),
      currency: json['currency'] ?? 'CNY',
      interval: json['interval'] ?? 'month',
      maxDevices: json['max_devices'] ?? 2,
      maxClipboardPerDay: json['max_clipboard_per_day'] ?? 50,
      maxStorageMB: json['max_storage_mb'] ?? 50,
      hasOcr: json['has_ocr'] ?? false,
      hasPrioritySync: json['has_priority_sync'] ?? false,
      hasAICategories: json['has_ai_categories'] ?? false,
      hasTeamSharing: json['has_team_sharing'] ?? false,
      isActive: json['is_active'] ?? true,
      paywallFeature1: json['paywall_feature_1'],
      paywallFeature2: json['paywall_feature_2'],
      paywallFeature3: json['paywall_feature_3'],
      createdAt: DateTime.parse(json['created_at']),
      updatedAt: DateTime.parse(json['updated_at']),
    );
  }

  /// 转换为 JSON
  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'description': description,
      'price': price,
      'currency': currency,
      'interval': interval,
      'max_devices': maxDevices,
      'max_clipboard_per_day': maxClipboardPerDay,
      'max_storage_mb': maxStorageMB,
      'has_ocr': hasOcr,
      'has_priority_sync': hasPrioritySync,
      'has_ai_categories': hasAICategories,
      'has_team_sharing': hasTeamSharing,
      'is_active': isActive,
      'paywall_feature_1': paywallFeature1,
      'paywall_feature_2': paywallFeature2,
      'paywall_feature_3': paywallFeature3,
      'created_at': createdAt.toIso8601String(),
      'updated_at': updatedAt.toIso8601String(),
    };
  }

  /// 获取格式化的价格
  String get formattedPrice {
    if (price == 0) return '免费';
    final currencySymbol = currency == 'CNY' ? '¥' : '\$';
    final intervalText = interval == 'month' ? '/月' : '/年';
    return '$currencySymbol${price.toStringAsFixed(2)}$intervalText';
  }

  /// 获取计划图标
  IconData get icon {
    switch (name.toLowerCase()) {
      case 'free':
        return Icons.card_giftcard;
      case 'pro':
        return Icons.star;
      case 'enterprise':
        return Icons.workspace_premium;
      default:
        return Icons.card_membership;
    }
  }

  /// 获取计划颜色
  Color get color {
    switch (name.toLowerCase()) {
      case 'free':
        return const Color(0xFF6C5CE7); // 紫色
      case 'pro':
        return const Color(0xFF0984E3); // 蓝色
      case 'enterprise':
        return const Color(0xFF00B894); // 绿色
      default:
        return const Color(0xFF6C5CE7);
    }
  }

  /// 获取功能列表
  List<String> get features {
    final features = <String>[];
    features.add('最多 $maxDevices 台设备');
    features.add('每日 $maxClipboardPerDay 条剪贴板');
    features.add('存储空间 ${maxStorageMB}MB');
    if (hasOcr) features.add('✓ OCR 文字识别');
    if (hasPrioritySync) features.add('✓ 优先同步');
    if (hasAICategories) features.add('✓ AI 智能分类');
    if (hasTeamSharing) features.add('✓ 团队共享');
    if (paywallFeature1 != null) features.add('✓ $paywallFeature1');
    if (paywallFeature2 != null) features.add('✓ $paywallFeature2');
    if (paywallFeature3 != null) features.add('✓ $paywallFeature3');
    return features;
  }
}
