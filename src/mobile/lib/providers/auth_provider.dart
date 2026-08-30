import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';

import '../services/api_service.dart';
import '../services/token_store.dart';

/// login() 的结果：区分「成功」「需要两步验证」「失败」
enum LoginResult { success, twoFactorRequired, failure }

/// 认证状态管理
///
/// - token / refreshToken 读写走 [TokenStore]（secure storage，T1.2/T1.3）
/// - 登录响应含 twoFactorRequired 时进入 2FA 挑战态（T1.4），
///   由 [verifyTwoFactorLogin] 提交动态码完成登录
/// - 登录收尾后注册真实设备并持久化 deviceId（T1.5），WS 与同步链路使用真实设备 id
class AuthProvider extends ChangeNotifier {
  final ApiService _api = ApiService();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();
  static const String _keyDeviceId = 'auth_device_id';

  bool _isLoading = true;
  bool _isAuthenticated = false;
  String? _token;
  String? _refreshToken;
  Map<String, dynamic>? _user;

  /// 2FA 登录挑战令牌（login 响应 twoFactorRequired 时下发，验证成功后清除）
  String? _pendingChallengeToken;

  /// 本机在服务端注册的真实设备 id（secure storage 持久化）
  String? _deviceId;

  /// 进行中的设备注册（单飞，避免登录收尾与 home_screen 并发重复注册）
  Future<String?>? _deviceRegistration;

  bool get isLoading => _isLoading;
  bool get isAuthenticated => _isAuthenticated;
  String? get token => _token;

  /// 供 WS / 后台服务等使用的刷新令牌（可能为 null：旧版本升级未重新登录前没有）
  String? get refreshToken => _refreshToken;
  Map<String, dynamic>? get user => _user;

  /// 本机真实设备 id（未注册成功时为 null）
  String? get deviceId => _deviceId;

  /// login 返回 [LoginResult.twoFactorRequired] 后，UI 可据此判断挑战态是否有效
  bool get hasPendingTwoFactorChallenge =>
      _pendingChallengeToken != null && _pendingChallengeToken!.isNotEmpty;

  AuthProvider() {
    _loadToken();
  }

  Future<void> _loadToken() async {
    _token = await TokenStore.getAccessToken();
    _refreshToken = await TokenStore.getRefreshToken();
    _deviceId = await _readDeviceId();
    _isAuthenticated = _token != null;

    if (_isAuthenticated) {
      // 校验 token 有效性；失败且有 refresh token 时先静默续期一次再重试
      var profile = await _tryGetProfile(_token!);
      if (profile == null && _refreshToken != null) {
        final renewed = await TokenStore.refreshAccessToken();
        if (renewed != null && renewed.isNotEmpty) {
          _token = renewed;
          _refreshToken = await TokenStore.getRefreshToken();
          profile = await _tryGetProfile(_token!);
        }
      }

      if (profile != null) {
        _user = profile;
      } else {
        // 凭证彻底失效：清空（secure storage + 本地设备 id）
        _isAuthenticated = false;
        _token = null;
        _refreshToken = null;
        await TokenStore.clear();
      }
    }

    _isLoading = false;
    notifyListeners();
  }

  Future<Map<String, dynamic>?> _tryGetProfile(String token) async {
    try {
      final profile = await _api.getProfile(token);
      return profile.isEmpty ? null : profile;
    } catch (e) {
      return null;
    }
  }

  Future<void> sendVerificationCode(String phone) async {
    await _api.sendVerificationCode(phone);
  }

  /// 验证码登录。
  /// 返回 [LoginResult.twoFactorRequired] 表示账号开启了两步验证，
  /// 需要继续调用 [verifyTwoFactorLogin] 提交 6 位动态码完成登录。
  Future<LoginResult> login(String phone, String code) async {
    try {
      final result = await _api.login(phone, code);
      if (result['twoFactorRequired'] == true) {
        final challenge = result['challengeToken'];
        _pendingChallengeToken =
            (challenge is String && challenge.isNotEmpty) ? challenge : null;
        if (_pendingChallengeToken == null) {
          return LoginResult.failure;
        }
        return LoginResult.twoFactorRequired;
      }
      await _completeLogin(result);
      return LoginResult.success;
    } catch (e) {
      debugPrint('[AuthProvider] login failed: $e');
      return LoginResult.failure;
    }
  }

  /// 提交 2FA 动态验证码（POST /api/auth/2fa/verify-login，challengeToken + code），
  /// 成功返回 {token, refreshToken, ...} 后走与普通登录相同的收尾。
  Future<bool> verifyTwoFactorLogin(String code) async {
    final challenge = _pendingChallengeToken;
    if (challenge == null || challenge.isEmpty) {
      return false;
    }
    try {
      final response = await http
          .post(
            Uri.parse('${ApiService.baseUrl}/api/auth/2fa/verify-login'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({'challengeToken': challenge, 'code': code}),
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode != 200) {
        debugPrint(
          '[AuthProvider] 2FA verify-login failed: HTTP ${response.statusCode}',
        );
        return false;
      }

      final data = jsonDecode(response.body);
      if (data is! Map<String, dynamic>) {
        return false;
      }

      _pendingChallengeToken = null;
      await _completeLogin(data);
      return true;
    } catch (e) {
      debugPrint('[AuthProvider] 2FA verify-login error: $e');
      return false;
    }
  }

  /// 放弃 2FA 挑战（用户点「返回」回到普通登录态）
  void cancelTwoFactor() {
    _pendingChallengeToken = null;
    notifyListeners();
  }

  /// 登录收尾：保存双 token、置认证态、触发设备注册
  Future<void> _completeLogin(Map<String, dynamic> result) async {
    final accessToken = result['token'];
    if (accessToken is! String || accessToken.isEmpty) {
      throw Exception('登录响应缺少 token');
    }

    _token = accessToken;
    final rt = result['refreshToken'];
    _refreshToken = (rt is String && rt.isNotEmpty) ? rt : null;
    final u = result['user'];
    _user = (u is Map<String, dynamic>) ? u : null;
    _isAuthenticated = true;

    await TokenStore.save(
      accessToken: _token!,
      refreshToken: _refreshToken,
    );

    notifyListeners();

    // 设备注册不阻塞登录收尾；home_screen 连接 WS 前会 await ensureDeviceId()
    unawaited(_registerDeviceIfNeeded());
  }

  Future<void> logout() async {
    _token = null;
    _refreshToken = null;
    _user = null;
    _deviceId = null;
    _isAuthenticated = false;
    _pendingChallengeToken = null;
    _deviceRegistration = null;

    await TokenStore.clear();
    try {
      await _storage.delete(key: _keyDeviceId);
    } catch (e) {
      debugPrint('[AuthProvider] clear device id failed: $e');
    }

    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // 设备注册（T1.5）
  // ---------------------------------------------------------------------------

  /// 确保本机已在服务端注册，返回真实 deviceId；失败返回 null（调用方回退旧逻辑并告警）。
  Future<String?> ensureDeviceId() async {
    if (_deviceId != null && _deviceId!.isNotEmpty) {
      return _deviceId;
    }
    if (_token == null) {
      return null;
    }
    return _registerDeviceIfNeeded();
  }

  /// 解绑当前设备后清除本地记录，使下次 ensureDeviceId 重新注册
  Future<void> clearDeviceId() async {
    _deviceId = null;
    try {
      await _storage.delete(key: _keyDeviceId);
    } catch (e) {
      debugPrint('[AuthProvider] clear device id failed: $e');
    }
  }

  Future<String?> _registerDeviceIfNeeded() {
    final inFlight = _deviceRegistration;
    if (inFlight != null) {
      return inFlight;
    }
    final future = _doRegisterDevice();
    _deviceRegistration = future;
    future.whenComplete(() {
      _deviceRegistration = null;
    });
    return future;
  }

  Future<String?> _doRegisterDevice() async {
    final token = _token;
    if (token == null) {
      return null;
    }
    try {
      final info = await _collectDeviceInfo();
      final response = await http
          .post(
            Uri.parse('${ApiService.baseUrl}/api/devices'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'deviceName': info.deviceName,
              'deviceType': 'mobile',
              'platform': 'android',
              'platformVersion': info.platformVersion,
              'appVersion': info.appVersion,
            }),
          )
          .timeout(const Duration(seconds: 15));

      String? newDeviceId;
      if (response.statusCode == 201) {
        final data = jsonDecode(response.body);
        if (data is Map<String, dynamic>) {
          final id = data['id'];
          if (id is String && id.isNotEmpty) {
            newDeviceId = id;
          }
        }
      } else if (response.statusCode == 409) {
        // 同名设备已存在（重复登录场景）：直接采用服务端返回的既有 deviceId
        final data = jsonDecode(response.body);
        if (data is Map<String, dynamic>) {
          final id = data['deviceId'];
          if (id is String && id.isNotEmpty) {
            newDeviceId = id;
          }
        }
      }

      if (newDeviceId == null || newDeviceId.isEmpty) {
        debugPrint(
          '[AuthProvider] device register failed: HTTP ${response.statusCode}',
        );
        return null;
      }

      _deviceId = newDeviceId;
      await _storage.write(key: _keyDeviceId, value: newDeviceId);
      debugPrint('[AuthProvider] device registered: $newDeviceId');
      return newDeviceId;
    } catch (e) {
      debugPrint('[AuthProvider] device register error: $e');
      return null;
    }
  }

  Future<_DeviceInfoBrief> _collectDeviceInfo() async {
    var deviceName = 'Android 设备';
    var platformVersion = '';
    var appVersion = '';
    try {
      if (Platform.isAndroid) {
        final android = await DeviceInfoPlugin().androidInfo;
        final manufacturer = android.manufacturer.trim();
        final model = android.model.trim();
        deviceName = manufacturer.isEmpty || manufacturer.toLowerCase() == 'google'
            ? model
            : '$manufacturer $model';
        platformVersion =
            'Android ${android.version.release} (API ${android.version.sdkInt})';
      }
    } catch (e) {
      debugPrint('[AuthProvider] collect device info failed: $e');
    }
    try {
      final pkg = await PackageInfo.fromPlatform();
      appVersion = pkg.version;
    } catch (_) {
      // appVersion 可选，失败不阻塞注册
    }
    return _DeviceInfoBrief(
      deviceName: deviceName,
      platformVersion: platformVersion,
      appVersion: appVersion,
    );
  }

  Future<String?> _readDeviceId() async {
    try {
      return await _storage.read(key: _keyDeviceId);
    } catch (e) {
      debugPrint('[AuthProvider] read device id failed: $e');
      return null;
    }
  }
}

class _DeviceInfoBrief {
  final String deviceName;
  final String platformVersion;
  final String appVersion;

  const _DeviceInfoBrief({
    required this.deviceName,
    required this.platformVersion,
    required this.appVersion,
  });
}
