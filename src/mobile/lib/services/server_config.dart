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
  ///
  /// release 固定指向生产 `https://api.clipchain.top`（与 src/shared/domains.js 一致）；
  /// debug 保留平台本地地址，便于真机/模拟器联调（2026-10-04 审计 E2：此前 release 也用
  /// 模拟器回环地址 10.0.2.2/localhost，装完即连不上）。
  static String get defaultBaseUrl {
    if (kReleaseMode) {
      return 'https://api.clipchain.top';
    }
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
    // release：后端地址固定为内置默认值，不接受持久化值的改动
    // （防被指向伪造/明文服务器；与桌面端同口径）。debug 照旧读设置，便于联调。
    if (kReleaseMode) {
      _baseUrl = '';
      return;
    }
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
    if (kReleaseMode) return; // release 不可运行时修改（同上）
    _baseUrl = url;
  }
}
