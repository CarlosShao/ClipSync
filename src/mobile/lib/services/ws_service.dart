import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';

class WsService {
  WebSocketChannel? _channel;
  String? _token;
  String? _deviceId;
  bool _isConnected = false;
  Timer? _heartbeatTimer;
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;
  static const int _maxReconnectAttempts = 10;

  // Callbacks
  Function(Map<String, dynamic>)? onNewClipboard;
  Function(String)? onClipboardDeleted;
  Function(List<String>)? onClipboardBatchDeleted;
  Function(String, bool)? onClipboardFavorite;
  Function()? onConnected;
  Function()? onDisconnected;

  bool get isConnected => _isConnected;

  void connect({required String token, required String deviceId}) {
    _token = token;
    _deviceId = deviceId;
    _connect();
  }

  void _connect() {
    if (_token == null) return;

    final uri = Uri.parse('ws://localhost:3000/ws?token=$_token');
    _channel = WebSocketChannel.connect(uri);

    _channel!.stream.listen(
      (data) {
        final msg = jsonDecode(data as String);
        _handleMessage(msg);
      },
      onDone: () {
        _isConnected = false;
        _heartbeatTimer?.cancel();
        onDisconnected?.call();
        _scheduleReconnect();
      },
      onError: (error) {
        _isConnected = false;
        _heartbeatTimer?.cancel();
        onDisconnected?.call();
        _scheduleReconnect();
      },
    );

    // Send register after a short delay
    Future.delayed(const Duration(milliseconds: 500), () {
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
        break;
      case 'clipboard_deleted':
        if (msg['itemId'] != null) {
          onClipboardDeleted?.call(msg['itemId']);
        } else if (msg['itemIds'] != null) {
          final ids = (msg['itemIds'] as List).cast<String>();
          onClipboardBatchDeleted?.call(ids);
        }
        break;
      case 'clipboard_favorite':
        onClipboardFavorite?.call(msg['itemId'], msg['isFavorite']);
        break;
      case 'error':
        break;
    }
  }

  void send(Map<String, dynamic> message) {
    _channel?.sink.add(jsonEncode(message));
  }

  void _scheduleReconnect() {
    if (_reconnectAttempts >= _maxReconnectAttempts) return;
    _reconnectAttempts++;
    
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
    final delaySeconds = (1 << (_reconnectAttempts - 1).clamp(0, 5)).clamp(1, 30);
    
    // Add jitter (±20%) to prevent thundering herd
    final jitterRange = (delaySeconds * 0.2).round();
    final jitter = (DateTime.now().millisecondsSinceEpoch % (jitterRange * 2)) - jitterRange;
    final finalDelaySeconds = (delaySeconds + jitter).clamp(1, 30);
    
    final delay = Duration(seconds: finalDelaySeconds);
    
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, _connect);
  }

  void disconnect() {
    _heartbeatTimer?.cancel();
    _reconnectTimer?.cancel();
    _channel?.sink.close();
    _isConnected = false;
  }

  void dispose() {
    disconnect();
  }
}
