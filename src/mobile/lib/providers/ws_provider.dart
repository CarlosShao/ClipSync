import 'dart:async';

import 'package:flutter/material.dart';
import '../services/ws_service.dart';
import 'clipboard_provider.dart';

class WsProvider extends ChangeNotifier {
  final WsService _service = WsService();
  bool _isConnected = false;

  /// B1 重连补拉：是否已完成过首次成功注册。
  ///
  /// 首次 registered（启动连接）不补拉——home_screen 进入时已 loadItems 全量拉取；
  /// 之后再收到 registered 必然经历过断线（网络切换 / pong 看门狗强制重连），
  /// 补拉一次收回断线期间其他设备的新增/删除/收藏变更。
  bool _connectedOnce = false;

  bool get isConnected => _isConnected;

  void connect({
    required String token,
    required String deviceId,
    required ClipboardProvider clipboardProvider,
  }) {
    _service.onConnected = () {
      final isFirstConnect = !_connectedOnce;
      _connectedOnce = true;
      _isConnected = true;
      notifyListeners();
      if (!isFirstConnect) {
        // 重连补拉：与下拉刷新同路径（refresh 按当前搜索/筛选重拉第 1 页、
        // 替换列表并重置分页）；refresh 内部自行 notifyListeners，此处不再重复通知
        unawaited(clipboardProvider.refresh());
      }
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
    // 显式断开（解绑本机 / 会话退出）后重连视为首次连接：
    // 重登后 home_screen 会重新 loadItems，避免双重拉取
    _connectedOnce = false;
    _isConnected = false;
    notifyListeners();
  }

  /// B3 网络恢复自动重连入口：未连接时按 home_screen 同款参数发起连接。
  ///
  /// 防重入：已连接短路；并发调用由 WsService 的 _connectEpoch 兜底 ——
  /// 新 connect 使 csrf 在途的旧连接流程作废，最终只会开出一条通道。
  /// 不改变 WsService 的指数退避重连策略本身。
  void ensureConnected({
    required String token,
    required String deviceId,
    required ClipboardProvider clipboardProvider,
  }) {
    if (_isConnected) return;
    connect(token: token, deviceId: deviceId, clipboardProvider: clipboardProvider);
  }

  @override
  void dispose() {
    _service.dispose();
    super.dispose();
  }
}
