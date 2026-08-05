import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 统一后端地址配置
///
/// - 所有 HTTP/WS 服务统一从这里取后端地址，避免各处硬编码 localhost:3000/3001 不一致
/// - 设置页保存的 `server_url` 会被读取；未保存时按平台给默认值：
///   - Android（模拟器）：`http://10.0.2.2:3001`（10.0.2.2 是模拟器访问宿主机的别名）
///   - 其余平台：`http://localhost:3001`
class ServerConfig {
  ServerConfig._();

  static String _baseUrl = '';

  /// 当前生效的后端 HTTP 地址（含端口，不含 /api 前缀）
  static String get baseUrl => _baseUrl.isEmpty ? defaultBaseUrl : _baseUrl;

  /// 平台默认地址
  static String get defaultBaseUrl {
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:3001';
    }
    return 'http://localhost:3001';
  }

  /// 对应的 WebSocket 地址（http→ws，https→wss）
  static String get wsUrl {
    final b = baseUrl;
    if (b.startsWith('https://')) {
      return b.replaceFirst('https://', 'wss://');
    }
    return b.replaceFirst('http://', 'ws://');
  }

  /// 应用启动时调用，把 SharedPreferences 里的 server_url 加载进内存
  static Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString('server_url');
      if (saved != null && saved.isNotEmpty) {
        _baseUrl = saved;
      }
    } catch (_) {
      _baseUrl = defaultBaseUrl;
    }
  }

  /// 设置页保存后同步更新内存值（无需重启即可对后续请求生效）
  static void setBaseUrl(String url) {
    _baseUrl = url;
  }
}
