import 'package:flutter/material.dart';
import '../services/ws_service.dart';
import 'clipboard_provider.dart';

class WsProvider extends ChangeNotifier {
  final WsService _service = WsService();
  bool _isConnected = false;

  bool get isConnected => _isConnected;

  void connect({
    required String token,
    required String deviceId,
    required ClipboardProvider clipboardProvider,
  }) {
    _service.onConnected = () {
      _isConnected = true;
      notifyListeners();
    };

    _service.onDisconnected = () {
      _isConnected = false;
      notifyListeners();
    };

    _service.onNewClipboard = (data) {
      clipboardProvider.handleNewItem(data);
    };

    _service.onClipboardDeleted = (itemId) {
      clipboardProvider.handleDeletedItem(itemId);
    };

    _service.onClipboardBatchDeleted = (ids) {
      clipboardProvider.handleBatchDeleted(ids);
    };

    _service.onClipboardFavorite = (itemId, isFavorite) {
      clipboardProvider.handleFavoriteChanged(itemId, isFavorite);
    };

    _service.connect(token: token, deviceId: deviceId);
  }

  void disconnect() {
    _service.disconnect();
    _isConnected = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _service.dispose();
    super.dispose();
  }
}
