import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/device.dart';
import '../models/session.dart';
import 'cache_service.dart';

class ApiService {
  // TODO: Update this to your server URL
  static const String baseUrl = 'http://localhost:3000';

  Map<String, String> _headers(String token) {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
    };
  }

  // Auth
  Future<void> sendVerificationCode(String phone) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/auth/send-code'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'phone': phone}),
    );

    if (response.statusCode != 200) {
      throw Exception('Failed to send verification code');
    }
  }

  Future<Map<String, dynamic>> login(String phone, String code) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/auth/verify-code'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'phone': phone, 'code': code}),
    );

    if (response.statusCode != 200) {
      throw Exception('Login failed');
    }

    return jsonDecode(response.body);
  }

  Future<Map<String, dynamic>> getProfile(String token) async {
    return await CacheDecorator().cachedOperation(
      CacheKeys.userProfile(),
      () async {
        final response = await http.get(
          Uri.parse('$baseUrl/api/auth/me'),
          headers: _headers(token),
        );

        if (response.statusCode != 200) {
          throw Exception('Failed to get profile');
        }

        return jsonDecode(response.body);
      },
      ttl: const Duration(minutes: 5),
    ) ?? {};
  }

  // Clipboard
  Future<Map<String, dynamic>> getClipboardItems(
    String token, {
    int page = 1,
    int limit = 50,
    String? contentType,
    String? search,
    bool? favorites,
    bool forceRefresh = false,
  }) async {
    return await CacheDecorator().cachedOperation(
      CacheKeys.clipboardListWithPage(page),
      () async {
        final queryParams = {
          'page': page.toString(),
          'limit': limit.toString(),
        };

        if (contentType != null) queryParams['contentType'] = contentType;
        if (search != null) queryParams['search'] = search;
        if (favorites == true) queryParams['favorites'] = 'true';

        final uri = Uri.parse('$baseUrl/api/clipboard').replace(
          queryParameters: queryParams,
        );

        final response = await http.get(uri, headers: _headers(token));

        if (response.statusCode != 200) {
          throw Exception('Failed to load clipboard items');
        }

        return jsonDecode(response.body);
      },
      ttl: const Duration(minutes: 2),
      forceRefresh: forceRefresh,
    ) ?? {};
  }

  Future<void> toggleFavorite(String token, String itemId) async {
    final response = await http.put(
      Uri.parse('$baseUrl/api/clipboard/$itemId/favorite'),
      headers: _headers(token),
    );

    if (response.statusCode != 200) {
      throw Exception('Failed to toggle favorite');
    }
  }

  Future<void> deleteClipboardItem(String token, String itemId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/api/clipboard/$itemId'),
      headers: _headers(token),
    );

    if (response.statusCode != 200) {
      throw Exception('Failed to delete item');
    }
  }

  // Devices
  Future<List<Device>> getDevices(String token, {bool forceRefresh = false}) async {
    return await CacheDecorator().cachedOperation<List<Device>>(
      CacheKeys.deviceList(),
      () async {
        final response = await http.get(
          Uri.parse('$baseUrl/api/devices'),
          headers: _headers(token),
        );

        if (response.statusCode != 200) {
          throw Exception('Failed to load devices');
        }

        final List<dynamic> data = jsonDecode(response.body);
        return data.map((json) => Device.fromJson(json)).toList();
      },
      ttl: const Duration(minutes: 5),
      forceRefresh: forceRefresh,
    ) ?? [];
  }

  Future<Device> registerDevice(
    String token, {
    required String deviceName,
    required String deviceType,
    required String platform,
    String? platformVersion,
    String? appVersion,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/devices'),
      headers: _headers(token),
      body: jsonEncode({
        'deviceName': deviceName,
        'deviceType': deviceType,
        'platform': platform,
        'platformVersion': platformVersion,
        'appVersion': appVersion,
      }),
    );

    if (response.statusCode != 201) {
      throw Exception('Failed to register device');
    }

    return Device.fromJson(jsonDecode(response.body));
  }

  Future<void> removeDevice(String token, String deviceId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/api/devices/$deviceId'),
      headers: _headers(token),
    );

    if (response.statusCode != 200) {
      throw Exception('Failed to remove device');
    }
  }

  // Sync
  Future<Map<String, dynamic>?> syncPush(
    String token,
    String deviceId,
    List<Map<String, dynamic>> changes,
  ) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/sync/push'),
      headers: _headers(token),
      body: jsonEncode({'deviceId': deviceId, 'changes': changes}),
    );

    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    }
    return null;
  }

  Future<Map<String, dynamic>?> syncPull(
    String token,
    String deviceId, {
    String? since,
    int limit = 100,
  }) async {
    final queryParams = {'limit': limit.toString()};
    if (since != null) queryParams['since'] = since;

    final uri = Uri.parse('$baseUrl/api/sync/pull/$deviceId').replace(
      queryParameters: queryParams,
    );

    final response = await http.get(uri, headers: _headers(token));

    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    }
    return null;
  }

  Future<Map<String, dynamic>?> getSyncStatus(String token, String deviceId) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/sync/status/$deviceId'),
      headers: _headers(token),
    );

    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    }
    return null;
  }

  // Media upload
  Future<Map<String, dynamic>?> uploadImage(
    String token,
    String deviceId, {
    required List<int> imageBytes,
    required String filename,
    String? mimeType,
  }) async {
    final uri = Uri.parse('$baseUrl/api/media/image');
    final request = http.MultipartRequest('POST', uri);
    request.headers['Authorization'] = 'Bearer $token';
    request.fields['sourceDeviceId'] = deviceId;
    request.files.add(http.MultipartFile.fromBytes(
      'image',
      imageBytes,
      filename: filename,
    ));

    final response = await request.send();
    if (response.statusCode == 201) {
      return jsonDecode(await response.stream.bytesToString());
    }
    return null;
  }

  Future<Map<String, dynamic>?> uploadFile(
    String token,
    String deviceId, {
    required List<int> fileBytes,
    required String filename,
    String? mimeType,
  }) async {
    final uri = Uri.parse('$baseUrl/api/media/file');
    final request = http.MultipartRequest('POST', uri);
    request.headers['Authorization'] = 'Bearer $token';
    request.fields['sourceDeviceId'] = deviceId;
    request.files.add(http.MultipartFile.fromBytes(
      'file',
      fileBytes,
      filename: filename,
    ));

    final response = await request.send();
    if (response.statusCode == 201) {
      return jsonDecode(await response.stream.bytesToString());
    }
    return null;
  }

  // Sessions
  Future<List<Session>> getSessions(String token) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/sessions'),
      headers: _headers(token),
    );

    if (response.statusCode != 200) {
      throw Exception('Failed to load sessions');
    }

    final List<dynamic> data = jsonDecode(response.body)['data']['sessions'];
    return data.map((json) => Session.fromJson(json)).toList();
  }

  Future<void> revokeSession(String token, String sessionId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/api/sessions/$sessionId'),
      headers: _headers(token),
    );

    if (response.statusCode != 200) {
      throw Exception('Failed to revoke session');
    }
  }

  Future<void> revokeAllSessions(String token) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/api/sessions'),
      headers: _headers(token),
    );

    if (response.statusCode != 200) {
      throw Exception('Failed to revoke all sessions');
    }
  }
}
