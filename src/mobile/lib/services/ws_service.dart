import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'server_config.dart';
import 'token_store.dart';

class WsService {
  WebSocketChannel? _channel;
  String? _token;
  String? _deviceId;
  bool _isConnected = false;
  Timer? _heartbeatTimer;
  Timer? _reconnectTimer;
  Timer? _registerTimer;
  int _reconnectAttempts = 0;
  static const int _maxReconnectAttempts = 10;

  /// 连接代数：防止上一次连接流程（异步获取 csrf 途中）与新一轮连接重叠
  /// 造成重复开通道；新 connect 会使旧的 in-flight 流程作废。
  int _connectEpoch = 0;

  // Callbacks
  void Function(Map<String, dynamic>)? onNewClipboard;
  void Function(String)? onClipboardDeleted;
  void Function(List<String>)? onClipboardBatchDeleted;
  void Function(String, bool)? onClipboardFavorite;
  void Function()? onConnected;
  void Function()? onDisconnected;

  /// 全局 new_clipboard 钩子（T3.4 即时通知）。
  ///
  /// 与 [onNewClipboard] 并行触发：WsProvider 已占用 onNewClipboard 走列表更新，
  /// 本地通知由 main.dart 静态挂载本钩子，避免 WsProvider 介入。
  static void Function(Map<String, dynamic> msg)? globalNewClipboardHook;

  bool get isConnected => _isConnected;

  void connect({required String token, required String deviceId}) {
    _token = token;
    _deviceId = deviceId;
    _connect();
  }

  /// T3.3 生产握手：GET /api/ws/csrf-token（Bearer 鉴权）获取一次性 csrf_token
  /// （60s TTL、单次使用），拼进握手 URL `?csrf_token=...`。
  ///
  /// - 失败重取一次；两次都失败时降级为不带 csrf 直连（开发环境后端不校验；
  ///   生产环境后端会拒绝本次连接，走既有断线退避重连再取）。
  /// - 对齐桌面端 src/desktop/src/composables/useWebSocket.ts 的 fetchWsCsrf 流程。
  Future<String> _fetchWsCsrf() async {
    if (_token == null || _token!.isEmpty) return '';

    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        // 每次尝试都重新解析 token：401 触发静默续期后重试可用新令牌
        final bearer = await TokenStore.getAccessToken() ?? _token;
        if (bearer == null || bearer.isEmpty) return '';
        final response = await http
            .get(
              Uri.parse('${ServerConfig.baseUrl}/api/ws/csrf-token'),
              headers: <String, String>{'Authorization': 'Bearer $bearer'},
            )
            .timeout(const Duration(seconds: 10));
        if (response.statusCode == 200) {
          final decoded = jsonDecode(response.body);
          if (decoded is Map<String, dynamic>) {
            final csrf = decoded['csrfToken'];
            if (csrf is String && csrf.isNotEmpty) return csrf;
          }
        } else {
          // 401 等：token 可能已过期，先尝试静默续期再重取
          await TokenStore.refreshAccessToken();
        }
      } catch (_) {
        // 网络异常：进入下一次重试
      }
    }
    return '';
  }

  Future<void> _connect() async {
    final token = _token;
    if (token == null) return;

    // 使旧的 in-flight 连接流程作废
    final epoch = ++_connectEpoch;

    final csrf = await _fetchWsCsrf();
    if (epoch != _connectEpoch) return; // 已被新一轮 connect/disconnect 取代

    final query = <String, String>{'token': token};
    if (csrf.isNotEmpty) query['csrf_token'] = csrf;

    final uri = Uri.parse('${ServerConfig.wsUrl}/ws').replace(
      queryParameters: query,
    );

    final channel = WebSocketChannel.connect(uri);
    _channel = channel;

    // 连接成功（首帧消息到达）后重置重连计数，让后续断线拥有完整的
    // 指数退避序列；否则失败 10 次后将永久放弃重连
    channel.stream.listen(
      (data) {
        if (_reconnectAttempts != 0) _reconnectAttempts = 0;
        if (data is! String) return;
        final dynamic decoded = jsonDecode(data);
        if (decoded is Map<String, dynamic>) {
          _handleMessage(decoded);
        }
      },
      onDone: () {
        if (epoch != _connectEpoch) return;
        _isConnected = false;
        _heartbeatTimer?.cancel();
        onDisconnected?.call();
        _scheduleReconnect();
      },
      onError: (error) {
        if (epoch != _connectEpoch) return;
        _isConnected = false;
        _heartbeatTimer?.cancel();
        onDisconnected?.call();
        _scheduleReconnect();
      },
    );

    // Send register after a short delay（后端 10s 未注册即踢线 4005）
    _registerTimer?.cancel();
    _registerTimer = Timer(const Duration(milliseconds: 500), () {
      if (_deviceId != null) {
        send({'type': 'register', 'deviceId': _deviceId});
      }
    });

    // Start heartbeat
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      send({'type': 'ping'});
    });
  }

  void _handleMessage(Map<String, dynamic> msg) {
    switch (msg['type']) {
      case 'registered':
        _isConnected = true;
        _reconnectAttempts = 0;
        onConnected?.call();
        break;
      case 'new_clipboard':
        onNewClipboard?.call(msg);
        // T3.4：即时本地通知（钩子由 main.dart 挂载，未挂载时为空操作）
        globalNewClipboardHook?.call(msg);
        break;
      case 'clipboard_deleted':
        if (msg['itemId'] != null) {
          onClipboardDeleted?.call(msg['itemId'] as String);
        } else if (msg['itemIds'] != null) {
          final ids = (msg['itemIds'] as List).cast<String>();
          onClipboardBatchDeleted?.call(ids);
        }
        break;
      case 'clipboard_favorite':
        onClipboardFavorite?.call(
          msg['itemId'] as String,
          msg['isFavorite'] as bool,
        );
        break;
      case 'error':
        break;
    }
  }

  void send(Map<String, dynamic> message) {
    try {
      _channel?.sink.add(jsonEncode(message));
    } catch (_) {
      // sink 已关闭：等待 onDone 触发重连
    }
  }

  void _scheduleReconnect() {
    if (_reconnectAttempts >= _maxReconnectAttempts) return;
    _reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
    final delaySeconds = (1 << (_reconnectAttempts - 1).clamp(0, 5)).clamp(1, 30);

    // Add jitter (±20%) to prevent thundering herd.
    // ⚠️ 首次重连 delaySeconds=1 → jitterRange=0 → `x % 0` 抛
    // IntegerDivisionByZeroException，且异常发生在断线回调内，
    // 会直接杀死重连调度（WS 一断即永久死亡）——必须零值保护
    final jitterRange = delaySeconds <= 1 ? 0 : (delaySeconds * 0.2).round();
    final jitter = jitterRange <= 0
        ? 0
        : (DateTime.now().millisecondsSinceEpoch % (jitterRange * 2)) - jitterRange;
    final finalDelaySeconds = (delaySeconds + jitter).clamp(1, 30);

    final delay = Duration(seconds: finalDelaySeconds);

    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, _connect);
  }

  void disconnect() {
    // 使 in-flight 的连接流程作废（否则断开后异步 csrf 返回还会重开通道）
    _connectEpoch++;
    _heartbeatTimer?.cancel();
    _reconnectTimer?.cancel();
    _registerTimer?.cancel();
    _channel?.sink.close();
    _isConnected = false;
  }

  void dispose() {
    disconnect();
  }
}
