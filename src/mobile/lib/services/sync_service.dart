import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../providers/auth_provider.dart';
import 'api_service.dart';
import 'clipboard_capture.dart';
import 'pending_upload_queue.dart';
import 'token_store.dart';

/// 前台同步服务桥（T3.1）
///
/// - 登录态挂钩：[attach] 监听 AuthProvider，已登录 → 启动前台服务，登出 → 停止
/// - MethodChannel（clipsync/sync）Dart → 原生：startService/stopService/
///   requestNotificationPermission/isBatteryOptimizationIgnored/requestIgnoreBatteryOptimization
/// - MethodChannel 原生 → Dart：onClipboardCaptured → 转交 [ClipboardCaptureService]
/// - 离线重放（B2）：绑定队列上传器 + 监听网络恢复/启动在线 → 触发
///   [PendingUploadQueue.replayPending]（重入保护与空队列判断在队列内部）
/// - 同步总开关：内存态（硬编码默认开），Wave 3 后续工单接设置页持久化
class SyncService {
  SyncService._();

  static final SyncService instance = SyncService._();

  static const MethodChannel _channel = MethodChannel('clipsync/sync');

  /// 同步总开关（内存态，默认开启；关闭即停服并停止采集）
  bool _syncEnabled = true;
  bool get syncEnabled => _syncEnabled;
  set syncEnabled(bool value) {
    if (_syncEnabled == value) return;
    _syncEnabled = value;
    if (value) {
      _start();
    } else {
      _stop();
    }
  }

  AuthProvider? _auth;
  bool _attached = false;
  bool _handlerRegistered = false;

  /// 登录态挂钩：main() 创建 AuthProvider 后调用一次。
  /// - 监听认证态变化：已登录（含冷启动恢复登录）→ 启动；登出 → 停止
  /// - 同时注册原生 → Dart 的采集回传处理器
  void attach(AuthProvider auth) {
    if (_attached) return;
    _attached = true;
    _auth = auth;
    _registerHandler();
    _registerOfflineReplay();
    auth.addListener(_onAuthChanged);
    // 冷启动已登录场景：等原生通道 handler 注册完成后小幅延迟再首次判断
    Future<void>.delayed(const Duration(milliseconds: 800), _onAuthChanged);
  }

  void _onAuthChanged() {
    final auth = _auth;
    if (auth == null) return;
    if (auth.isAuthenticated && _syncEnabled) {
      _start();
    } else {
      _stop();
    }
  }

  // ---------------------------------------------------------------------------
  // 原生 → Dart：前台服务采集回传
  // ---------------------------------------------------------------------------

  void _registerHandler() {
    if (_handlerRegistered) return;
    _handlerRegistered = true;
    _channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'onClipboardCaptured':
          final args = call.arguments;
          if (args is Map) {
            final text = args['text'];
            if (text is String) {
              ClipboardCaptureService.instance.handleCapturedText(text);
            }
          }
          return null;
        default:
          throw MissingPluginException('clipsync/sync unknown method: ${call.method}');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 离线重放（B2：剪贴板采集离线持久化队列）
  // ---------------------------------------------------------------------------

  /// 绑定队列上传器 + 挂接网络恢复重放触发。
  /// 触发点：
  /// 1. connectivity_plus 事件（任一网络接口上线 → 视为恢复）
  /// 2. App 启动时初始在线探测（覆盖「离线复制 → 杀 App → 联网启动」）
  /// 重放本身的重入保护、空队列短路、跳过阈值都在 [PendingUploadQueue] 内部。
  void _registerOfflineReplay() {
    PendingUploadQueue.instance.bindUploader(_replayUploadEntry);

    Connectivity().onConnectivityChanged.listen((results) {
      final online = results.any((c) => c != ConnectivityResult.none);
      if (online) _triggerReplay('network restored');
    });
    Future<void>.delayed(const Duration(milliseconds: 800), () async {
      try {
        final results = await Connectivity().checkConnectivity();
        if (results.any((c) => c != ConnectivityResult.none)) {
          _triggerReplay('startup online');
        }
      } catch (e) {
        debugPrint('[SyncService] startup connectivity check failed: $e');
      }
    });
  }

  /// 重放触发门控：未登录/同步关闭时不烧重试次数（队列原样保留）
  void _triggerReplay(String reason) {
    final auth = _auth;
    if (auth == null || !auth.isAuthenticated || !_syncEnabled) {
      debugPrint(
          '[SyncService] replay skipped ($reason): not authenticated or sync disabled');
      return;
    }
    unawaited(PendingUploadQueue.instance.replayPending());
  }

  /// 队列上传器：逐条按原上传链路重传（文本复用采集管线与幂等键，
  /// 图片/文件复用 ApiService 既有 multipart 链路）。
  Future<bool> _replayUploadEntry(PendingUploadEntry entry) async {
    if (entry.contentType == 'text') {
      return ClipboardCaptureService.instance
          .reuploadText(entry.text ?? '', entry.idempotencyKey);
    }
    return _replayMediaUpload(entry);
  }

  /// 图片/文件重放：POST /api/media/image|file（ApiService 既有契约，不改动）。
  /// 文件存在性已由队列在调用前校验；此处仅兜底 I/O 异常视为失败。
  Future<bool> _replayMediaUpload(PendingUploadEntry entry) async {
    try {
      final path = entry.filePath;
      if (path == null || path.isEmpty) return false;
      final token = await TokenStore.getAccessToken();
      if (token == null || token.isEmpty) return false;
      final deviceId = _auth?.deviceId;
      if (deviceId == null || deviceId.isEmpty) return false;

      final bytes = await File(path).readAsBytes();
      if (bytes.isEmpty) return false;
      final filename = path.split(Platform.pathSeparator).last;
      final result = entry.contentType == 'image'
          ? await ApiService().uploadImage(
              token,
              deviceId,
              imageBytes: bytes,
              filename: filename,
              mimeType: _guessImageMime(filename),
            )
          : await ApiService().uploadFile(
              token,
              deviceId,
              fileBytes: bytes,
              filename: filename,
            );
      return result != null;
    } catch (e) {
      debugPrint('[SyncService] media replay upload failed: $e');
      return false;
    }
  }

  String _guessImageMime(String filename) {
    final lower = filename.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }

  // ---------------------------------------------------------------------------
  // 服务启停 + 权限
  // ---------------------------------------------------------------------------

  Future<void> _start() async {
    // Android 13+ 通知运行时权限（T3.1）：拒绝也不阻塞前台服务启动
    await _requestNotificationPermission();
    try {
      await _channel.invokeMethod<bool>('startService');
    } on PlatformException catch (e) {
      debugPrint('[SyncService] startService failed: ${e.message}');
    } on MissingPluginException {
      debugPrint('[SyncService] startService: 通道未注册（非 Android 平台），忽略');
    }
  }

  Future<void> _stop() async {
    try {
      await _channel.invokeMethod<bool>('stopService');
    } on PlatformException catch (e) {
      debugPrint('[SyncService] stopService failed: ${e.message}');
    } on MissingPluginException {
      // 非 Android 平台
    }
  }

  Future<void> _requestNotificationPermission() async {
    try {
      await _channel.invokeMethod<bool>('requestNotificationPermission');
    } on PlatformException catch (e) {
      debugPrint('[SyncService] notification permission failed: ${e.message}');
    } on MissingPluginException {
      // 非 Android 平台
    }
  }

  // ---------------------------------------------------------------------------
  // 电池优化查询/引导（T3.4 引导页消费）
  // ---------------------------------------------------------------------------

  /// 电池优化是否已被豁免（Doze 下同步会退化，未豁免时引导用户加白名单）
  Future<bool> isBatteryOptimizationIgnored() async {
    try {
      return await _channel
              .invokeMethod<bool>('isBatteryOptimizationIgnored') ??
          false;
    } on PlatformException catch (e) {
      debugPrint('[SyncService] battery optimization query failed: ${e.message}');
    } on MissingPluginException {
      // 非 Android 平台
    }
    return false;
  }

  /// 跳转「忽略电池优化」系统授权弹窗
  Future<void> openBatteryOptimizationRequest() async {
    try {
      await _channel.invokeMethod<void>('requestIgnoreBatteryOptimization');
    } on PlatformException catch (e) {
      debugPrint('[SyncService] battery optimization request failed: ${e.message}');
    } on MissingPluginException {
      // 非 Android 平台
    }
  }
}
