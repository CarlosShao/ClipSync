import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_service.dart';
import 'app_exception.dart';
import 'cache_service.dart';
import 'token_store.dart';

/// 账号资料 API（C6 账号区块）。
///
/// - GET 资料：`GET /api/auth/me` 已由 [ApiService.getProfile] 提供
///   （登录/冷启动时 AuthProvider 拉取并缓存，响应含 nickname/phone/
///   email/avatarUrl 字段，足够账号区块展示），此处不再重复实现 GET；
/// - PUT 更新：`PUT /api/auth/profile`，请求体 `{nickname?, avatarUrl?}`
///   （字段名对齐 src/server/src/routes/auth-profile.js），Bearer 认证。
class ProfileApiService {
  /// 更新昵称；成功后清除用户资料缓存，避免重启后 getProfile 读到旧昵称。
  Future<void> updateNickname(String? token, String nickname) {
    return updateProfile(token, {'nickname': nickname});
  }

  /// 更新头像（base64 dataURL）；成功后清除用户资料缓存。
  Future<void> updateAvatar(String? token, String avatarUrl) {
    return updateProfile(token, {'avatarUrl': avatarUrl});
  }

  /// 通用资料更新：仅发送非空字段，其余由服务端忽略。
  Future<void> updateProfile(String? token, Map<String, dynamic> fields) async {
    final resolved = token ?? await TokenStore.getAccessToken();
    if (resolved == null || resolved.isEmpty) {
      throw const AppException(AppErrorCodes.noToken);
    }

    final response = await http.put(
      Uri.parse('${ApiService.baseUrl}/api/auth/profile'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $resolved',
      },
      body: jsonEncode(fields),
    );

    if (response.statusCode != 200) {
      var detail = 'HTTP ${response.statusCode}';
      try {
        final decoded = jsonDecode(response.body);
        if (decoded is Map<String, dynamic> && decoded['error'] is String) {
          final error = decoded['error'] as String;
          detail = '$error（HTTP ${response.statusCode}）';
        }
      } catch (_) {
        // 响应体非 JSON 时保留 HTTP 状态码作为 detail
      }
      throw AppException(AppErrorCodes.updateProfileFailed, detail);
    }

    await CacheService.instance.remove(CacheKeys.userProfile());
  }
}
