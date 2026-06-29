import 'package:http/htter.dart' as http;
import 'dart:convert';
import '../models/subscription_plan.dart';

/// 订阅 API 服务
class SubscriptionApiService {
  static const String _baseUrl = 'http://localhost:3001/api';
  
  /// 获取套餐列表
  static Future<List<SubscriptionPlan>> getPlans() async {
    try {
      final response = await http.get(
        Uri.parse('$_baseUrl/subscriptions/plans'),
        headers: {
          'Content-Type': 'application/json',
        },
      );
      
      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        final plansJson = data['plans'] as List<dynamic>;
        return plansJson.map((json) => SubscriptionPlan.fromJson(json)).toList();
      } else {
        throw Exception('获取套餐列表失败: ${response.statusCode}');
      }
    } catch (e) {
      // 如果后端不可用，返回模拟数据
      print('⚠️ 后端不可用，使用模拟数据: $e');
      return _getMockPlans();
    }
  }
  
  /// 获取当前订阅
  static Future<Map<String, dynamic>? getCurrentSubscription(String token) async {
    try {
      final response = await http.get(
        Uri.parse('$_baseUrl/subscriptions/current'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );
      
      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        return data;
      } else {
        throw Exception('获取当前订阅失败: ${response.statusCode}');
      }
    } catch (e) {
      print('⚠️ 获取当前订阅失败: $e');
      return null;
    }
  }
  
  /// 创建/升级订阅
  static Future<Map<String, dynamic>> subscribe({
    required String token,
    required String planId,
    required String paymentMethod,
  }) async {
    try {
      final response = await http.post(
        Uri.parse('$_baseUrl/subscriptions/subscribe'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'planId': planId,
          'paymentMethod': paymentMethod,
        }),
      );
      
      if (response.statusCode == 200 || response.statusCode == 201) {
        final data = json.decode(response.body);
        return data;
      } else {
        throw Exception('创建订阅失败: ${response.statusCode}');
      }
    } catch (e) {
      // 如果后端不可用，返回模拟数据
      print('⚠️ 后端不可用，模拟订阅成功: $e');
      return {
        'success': true,
        'message': '订阅成功（模拟）',
        'subscription': {
          'id': 'mock-sub-001',
          'planId': planId,
          'status': 'active',
        },
      };
    }
  }
  
  /// 取消订阅
  static Future<bool> cancelSubscription(String token) async {
    try {
      final response = await http.post(
        Uri.parse('$_baseUrl/subscriptions/cancel'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );
      
      if (response.statusCode == 200) {
        return true;
      } else {
        throw Exception('取消订阅失败: ${response.statusCode}');
      }
    } catch (e) {
      print('⚠️ 取消订阅失败: $e');
      return false;
    }
  }
  
  /// 恢复订阅
  static Future<bool> resumeSubscription(String token) async {
    try {
      final response = await http.post(
        Uri.parse('$_baseUrl/subscriptions/resume'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );
      
      if (response.statusCode == 200) {
        return true;
      } else {
        throw Exception('恢复订阅失败: ${response.statusCode}');
      }
    } catch (e) {
      print('⚠️ 恢复订阅失败: $e');
      return false;
    }
  }

  /// 获取支付历史
  static Future<List<dynamic>> getPaymentHistory(String token) async {
    try {
      final response = await http.get(
        Uri.parse('$_baseUrl/payments/history'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );

      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        return data['payments'] as List<dynamic>;
      } else {
        throw Exception('获取支付历史失败: ${response.statusCode}');
      }
    } catch (e) {
      print('⚠️ 获取支付历史失败: $e');
      return [];
    }
  }

  /// 获取发票列表
  static Future<List<dynamic>> getInvoices(String token) async {
    try {
      final response = await http.get(
        Uri.parse('$_baseUrl/invoices'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );

      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        return data['invoices'] as List<dynamic>;
      } else {
        throw Exception('获取发票列表失败: ${response.statusCode}');
      }
    } catch (e) {
      print('⚠️ 获取发票列表失败: $e');
      return [];
    }
  }
  
  /// 模拟数据（后端不可用时的降级方案）
  static List<SubscriptionPlan> _getMockPlans() {
    return [
      SubscriptionPlan(
        id: 'free',
        name: 'Free',
        description: '适合个人用户的基础功能',
        price: 0,
        currency: 'CNY',
        interval: 'month',
        maxDevices: 2,
        maxClipboardPerDay: 50,
        maxStorageMB: 50,
        isActive: true,
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      ),
      SubscriptionPlan(
        id: 'pro',
        name: 'Pro',
        description: '适合重度用户的专业功能',
        price: 9.9,
        currency: 'CNY',
        interval: 'month',
        maxDevices: 5,
        maxClipboardPerDay: 500,
        maxStorageMB: 500,
        hasOcr: true,
        hasPrioritySync: true,
        hasAiCategories: true,
        isActive: true,
        paywallFeature1: '优先客服支持',
        paywallFeature2: '高级 Markdown 预览',
        paywallFeature3: '无广告体验',
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      ),
      SubscriptionPlan(
        id: 'enterprise',
        name: 'Enterprise',
        description: '适合团队的企业级功能',
        price: 29.9,
        currency: 'CNY',
        interval: 'month',
        maxDevices: 999,
        maxClipboardPerDay: 9999,
        maxStorageMB: 9999,
        hasOcr: true,
        hasPrioritySync: true,
        hasAiCategories: true,
        hasTeamSharing: true,
        isActive: true,
        paywallFeature1: '团队共享剪贴板',
        paywallFeature2: '团队管理中心',
        paywallFeature3: '优先功能访问',
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      ),
    ];
  }
}
