import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'server_config.dart';

/// 认证凭据统一存取（T1.2 / T1.3 冻结契约）
///
/// - access / refresh token 存 flutter_secure_storage（Android Keystore 加密）
/// - 首次启动把旧版 SharedPreferences 的 `auth_token` 迁移进 secure storage（迁移后删除旧键）
/// - [refreshAccessToken] 单飞：并发调用共享同一次刷新请求；
///   服务端 POST /api/auth/refresh 为 GETDEL 旋转语义（旧 refreshToken 用一次即废），
///   成功返回新 access token 并落库，失败返回 null。
class TokenStore {
  TokenStore._();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  static const String _keyAccessToken = 'auth_access_token';
  static const String _keyRefreshToken = 'auth_refresh_token';

  /// 旧版本存放在 SharedPreferences 的键（迁移源）
  static const String _legacyPrefsKey = 'auth_token';

  /// 进行中的刷新请求（单飞）；null 表示当前没有刷新在跑
  static Future<String?>? _refreshInFlight;

  /// 旧 token 迁移守卫：每次冷启动最多执行一次
  static Future<void>? _migration;

  /// 读取 access token（触发一次性的旧 token 迁移）
  static Future<String?> getAccessToken() async {
    await _ensureMigrated();
    try {
      return await _storage.read(key: _keyAccessToken);
    } catch (e) {
      debugPrint('[TokenStore] read access token failed: $e');
      return null;
    }
  }

  /// 持久化 token 对；refreshToken 为空时保留已有的 refresh token
  static Future<void> save({
    required String accessToken,
    String? refreshToken,
  }) async {
    await _storage.write(key: _keyAccessToken, value: accessToken);
    if (refreshToken != null && refreshToken.isNotEmpty) {
      await _storage.write(key: _keyRefreshToken, value: refreshToken);
    }
  }

  /// 读取 refresh token
  static Future<String?> getRefreshToken() async {
    try {
      return await _storage.read(key: _keyRefreshToken);
    } catch (e) {
      debugPrint('[TokenStore] read refresh token failed: $e');
      return null;
    }
  }

  /// 清空全部凭据（登出 / 刷新失效时调用）
  static Future<void> clear() async {
    try {
      await _storage.delete(key: _keyAccessToken);
      await _storage.delete(key: _keyRefreshToken);
    } catch (e) {
      debugPrint('[TokenStore] clear secure storage failed: $e');
    }
    // 兜底：清理可能残留的旧版键
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_legacyPrefsKey);
    } catch (_) {
      // 忽略：清不清旧键都不影响安全（secure storage 已清）
    }
  }

  /// 单飞刷新 access token：
  /// - 已有刷新在跑 → 直接返回同一个 Future（共享一次请求，避免 GETDEL 旋转令牌被并发消费）
  /// - 无刷新在跑 → 发起 POST /api/auth/refresh，成功落库新 token 并返回新 access token
  /// - 无 refresh token / 请求失败 / 响应不合法 → 返回 null
  static Future<String?> refreshAccessToken() {
    final inFlight = _refreshInFlight;
    if (inFlight != null) {
      return inFlight;
    }
    final future = _doRefresh();
    _refreshInFlight = future;
    future.whenComplete(() {
      _refreshInFlight = null;
    });
    return future;
  }

  static Future<String?> _doRefresh() async {
    final refreshToken = await getRefreshToken();
    if (refreshToken == null || refreshToken.isEmpty) {
      debugPrint('[TokenStore] refresh skipped: no refresh token stored');
      return null;
    }
    try {
      final response = await http
          .post(
            Uri.parse('${ServerConfig.baseUrl}/api/auth/refresh'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({'refreshToken': refreshToken}),
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode != 200) {
        debugPrint('[TokenStore] refresh failed: HTTP ${response.statusCode}');
        return null;
      }

      final data = jsonDecode(response.body);
      if (data is! Map<String, dynamic>) {
        debugPrint('[TokenStore] refresh response is not a JSON object');
        return null;
      }

      final newAccess = data['token'];
      final newRefresh = data['refreshToken'];
      if (newAccess is! String || newAccess.isEmpty) {
        debugPrint('[TokenStore] refresh response missing token');
        return null;
      }

      await save(
        accessToken: newAccess,
        refreshToken: (newRefresh is String && newRefresh.isNotEmpty)
            ? newRefresh
            : null,
      );
      return newAccess;
    } catch (e) {
      debugPrint('[TokenStore] refresh error: $e');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 旧 token 迁移（SharedPreferences → secure storage）
  // ---------------------------------------------------------------------------

  static Future<void> _ensureMigrated() {
    return _migration ??= _migrateLegacyToken();
  }

  static Future<void> _migrateLegacyToken() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final legacy = prefs.getString(_legacyPrefsKey);
      if (legacy == null || legacy.isEmpty) {
        return;
      }
      final existing = await _storage.read(key: _keyAccessToken);
      if (existing == null || existing.isEmpty) {
        // 写入失败会抛出 → 保留旧键，下次启动重试
        await _storage.write(key: _keyAccessToken, value: legacy);
      }
      // 迁移成功后删除旧键，确保只迁移一次
      await prefs.remove(_legacyPrefsKey);
    } catch (e) {
      debugPrint('[TokenStore] legacy token migration failed: $e');
    }
  }
}
