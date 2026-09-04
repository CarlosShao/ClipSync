import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

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
/// - MethodChannel 原生 → Dart：onClipboardCaptured → 采集开关判断（B3）→
///   转交 [ClipboardCaptureService]
/// - 剪贴板采集总开关（B3）：SharedPreferences `clipboard_capture_enabled`
///   （默认开），采集入口每次实时读取，不缓存 stale 值；关闭只停采集，
///   前台服务保持运行（WS 推送接收不受影响）
/// - 离线重放（B2）：绑定队列上传器 + 监听网络恢复/启动在线 → 触发
///   [PendingUploadQueue.replayPending]（重入保护与空队列判断在队列内部）
/// - 网络恢复钩子（B3）：[onNetworkRestored] 由 main.dart 接线 WsProvider，
///   弥补 WS 重连连续失败被放弃后无法自愈的缺口
class SyncService {
  SyncService._();

  static final SyncService instance = SyncService._();

  static const MethodChannel _channel = MethodChannel('clipsync/sync');

  /// 剪贴板采集总开关的 SharedPreferences 键（B3；写入方 settings_provider，
  /// 默认 true。与设置页/SettingsProvider 保持同一字面量，勿改）
  static const String _prefKeyCaptureEnabled = 'clipboard_capture_enabled';

  /// 网络恢复钩子（B3）：connectivity_plus 恢复在线时触发；
  /// main.dart 接线 WsProvider.ensureConnected —— WS 重连被既有策略放弃后
  /// 由网络恢复事件重新发起连接。未接线时为空操作。
  /// （实例成员：SyncService 为全局单例，main.dart 经 instance 挂钩）
  void Function()? onNetworkRestored;

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
    // 采集开关关闭也不停服务：前台服务保持运行（WS 推送链路不受影响），
    // 采集由 MethodChannel 入口按开关实时拦截
    if (auth.isAuthenticated) {
      _start();
    } else {
      _stop();
    }
  }

  /// 剪贴板采集开关实时读取（B3）：每次采集/重放前查 SharedPreferences，
  /// 不缓存 stale 值；读取失败按默认开启处理（与 SettingsProvider 默认一致）
  Future<bool> _isCaptureEnabled() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(_prefKeyCaptureEnabled) ?? true;
    } catch (_) {
      return true;
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
            // 采集总开关（B3）：关闭时丢弃回传文本（前台服务仍运行，
            // 只是不再采集上传系统剪贴板）
            if (text is String && await _isCaptureEnabled()) {
              ClipboardCaptureService.instance.handleCapturedText(text);
            }
          }
          return null;
        case 'onScreenshotCaptured':
          final args = call.arguments;
          if (args is Map) {
            final bytes = args['bytes'];
            final fileName = args['fileName'];
            final mimeType = args['mimeType'];
            if (bytes is Uint8List && bytes.isNotEmpty && await _isCaptureEnabled()) {
              onScreenshotCaptured?.call(bytes, fileName as String?, mimeType as String?);
            }
          }
          return null;
        default:
          throw MissingPluginException('clipsync/sync unknown method: ${call.method}');
      }
    });
  }

  /// 手机截屏侦听回调（原生已读取图片字节；由 main.dart 挂接上传管线）
  void Function(Uint8List bytes, String? fileName, String? mimeType)? onScreenshotCaptured;

  /// 调用原生 MediaStore 接口将图片保存至公共相册 Pictures/ClipSync
  Future<String?> saveImageToAlbum(
    Uint8List bytes, {
    String? fileName,
    String? mimeType,
  }) async {
    try {
      final result = await _channel.invokeMethod<String>('saveImageToAlbum', {
        'bytes': bytes,
        'fileName': fileName,
        'mimeType': mimeType,
      });
      return result;
    } catch (e) {
      debugPrint('[SyncService] saveImageToAlbum failed: $e');
      return null;
    }
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
      if (online) {
        // B3：网络恢复钩子（main.dart 接线 WS 自动重连，弥补重连放弃缺口）
        onNetworkRestored?.call();
        unawaited(_triggerReplay('network restored'));
      }
    });
    Future<void>.delayed(const Duration(milliseconds: 800), () async {
      try {
        final results = await Connectivity().checkConnectivity();
        if (results.any((c) => c != ConnectivityResult.none)) {
          unawaited(_triggerReplay('startup online'));
        }
      } catch (e) {
        debugPrint('[SyncService] startup connectivity check failed: $e');
      }
    });
  }

  /// 重放触发门控：未登录/采集开关关闭时不烧重试次数（队列原样保留；
  /// 隐私语义：关闭采集后不再把本机内容传出去，含离线积压重放）
  Future<void> _triggerReplay(String reason) async {
    final auth = _auth;
    if (auth == null || !auth.isAuthenticated || !await _isCaptureEnabled()) {
      debugPrint(
          '[SyncService] replay skipped ($reason): not authenticated or capture disabled');
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
    // 截图同步媒体读取权限（Android 13+ READ_MEDIA_IMAGES / ≤12 READ_EXTERNAL_STORAGE）：
    // 无权限时 MediaStore 查询不到系统截图，截屏同步失效；拒绝不阻塞服务启动。
    await requestMediaReadPermission();
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

  /// 查询是否已拥有媒体读取权限（截图同步用）。非 Android 平台恒 true。
  Future<bool> hasMediaReadPermission() async {
    try {
      return await _channel.invokeMethod<bool>('hasMediaReadPermission') ?? false;
    } on PlatformException catch (e) {
      debugPrint('[SyncService] hasMediaReadPermission failed: ${e.message}');
    } on MissingPluginException {
      // 非 Android 平台
    }
    return true;
  }

  /// 申请媒体读取权限（截图同步用）。返回是否授予；非 Android 平台恒 true。
  Future<bool> requestMediaReadPermission() async {
    try {
      return await _channel
              .invokeMethod<bool>('requestMediaReadPermission') ??
          false;
    } on PlatformException catch (e) {
      debugPrint('[SyncService] media read permission failed: ${e.message}');
    } on MissingPluginException {
      // 非 Android 平台
    }
    return false;
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

  /// 跳转系统应用设置页（用于引导手动开启相册读取或通知权限）
  Future<bool> openAppNotificationSettings() async {
    try {
      return await _channel.invokeMethod<bool>('openAppNotificationSettings') ?? false;
    } on PlatformException catch (e) {
      debugPrint('[SyncService] openAppNotificationSettings failed: ${e.message}');
    } on MissingPluginException {
      // 非 Android 平台
    }
    return false;
  }
}
