import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:provider/provider.dart';
import '../providers/auth_provider.dart';

/// 通知 API 服务
class NotificationApiService {
  final String baseUrl;

  NotificationApiService({this.baseUrl = 'http://localhost:3000'});

  /// 获取通知偏好
  Future<Map<String, dynamic>> getNotificationPreferences(String token) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/notifications/preferences'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
    );

    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    } else {
      throw Exception('获取通知偏好失败: ${response.body}');
    }
  }

  /// 更新通知偏好
  Future<Map<String, dynamic>> updateNotificationPreferences(
    String token,
    Map<String, bool> preferences,
  ) async {
    final response = await http.put(
      Uri.parse('$baseUrl/api/notifications/preferences'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'preferences': preferences}),
    );

    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    } else {
      throw Exception('更新通知偏好失败: ${response.body}');
    }
  }

  /// 获取通知历史
  Future<Map<String, dynamic>> getNotificationHistory(
    String token, {
    int limit = 20,
  }) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/notifications/history?limit=$limit'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
    );

    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    } else {
      throw Exception('获取通知历史失败: ${response.body}');
    }
  }
}
