import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../providers/clipboard_provider.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 前台服务剪贴板采集管线（T3.2）
///
/// 职责：接收 Kotlin 前台服务经 MethodChannel（clipsync/sync，onClipboardCaptured）
/// 回传的系统剪贴板文本 → 多层去重与回环抑制 → 走既有上传契约入库
/// （POST /api/clipboard：sourceDeviceId + contentEncrypted 必填、Idempotency-Key 幂等键）。
///
/// 去重/回环抑制分层：
/// 1. Kotlin 侧：与上次回传文本相同则不推送（减少通道流量）
/// 2. Dart 层1：与上一条采集内容 sha256 去重（监听器 + 2s 轮询会读到同一内容）
/// 3. Dart 层2：已知服务端内容抑制——
///    a) 本机上传成功的内容（2 小时哈希环）
///    b) WS new_clipboard 推回的内容（含本机上传的回声，经 [EchoAwareClipboardProvider] 登记）
///    c) 已加载列表中已有的条目（应用内复制场景：内容本就来自服务端）
/// 4. 服务端兜底：5 分钟内容哈希去重 + Idempotency-Key 幂等
class ClipboardCaptureService {
  ClipboardCaptureService._();

  static final ClipboardCaptureService instance = ClipboardCaptureService._();

  /// 与服务端内容上限对齐（10MB，见 server clipboard.js）
  static const int _maxContentLength = 10 * 1024 * 1024;

  /// 已知服务端内容的抑制窗口（覆盖「复制→上传→WS 推回→用户再复制」链路）
  static const Duration _knownHashTtl = Duration(hours: 2);
  static const int _maxKnownHashes = 128;

  /// 上传失败后的重试参数：最多 3 次（间隔 3s/6s），仍失败则进入 5 分钟冷却
  static const int _maxUploadAttempts = 3;
  static const Duration _failedCooldown = Duration(minutes: 5);

  String? _lastCapturedHash;

  /// 已知服务端内容哈希环：hash -> 登记时间
  final Map<String, DateTime> _knownServerHashes = <String, DateTime>{};

  /// 上传失败冷却：hash -> 冷却截止时间（避免失败后每 2s 轮询反复打服务器）
  final Map<String, DateTime> _failedHashCooldown = <String, DateTime>{};

  /// 采集处理串行化（上一条未处理完时排队，避免并发上传乱序）
  Future<void> _pipeline = Future<void>.value();

  /// 由 main.dart 绑定：
  /// - provider：已加载列表（应用内复制的内容与列表条目比对，抑制重复入库）
  /// - deviceIdProvider：本机在服务端注册的真实设备 id（T1.5；未注册时不采集）
  ClipboardProvider? _provider;
  String? Function()? _deviceIdProvider;

  void bind({
    ClipboardProvider? provider,
    String? Function()? deviceIdProvider,
  }) {
    if (provider != null) _provider = provider;
    if (deviceIdProvider != null) _deviceIdProvider = deviceIdProvider;
  }

  /// MethodChannel 入口：Kotlin 前台服务回传的系统剪贴板文本
  void handleCapturedText(String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty || trimmed.length > _maxContentLength) return;
    _pipeline = _pipeline.then((_) => _process(trimmed));
  }

  Future<void> _process(String text) async {
    try {
      final hash = _hashOf(text);

      // 层1：与上一条采集去重
      if (hash == _lastCapturedHash) return;
      _lastCapturedHash = hash;

      // 失败冷却中：本次采集跳过（等用户再次主动复制时再试）
      final failedUntil = _failedHashCooldown[hash];
      if (failedUntil != null) {
        if (DateTime.now().isBefore(failedUntil)) return;
        _failedHashCooldown.remove(hash);
      }

      // 层2：回环抑制（本机刚上传的 / WS 推回的 / 列表已有的）
      if (isKnownServerContent(text)) {
        debugPrint('[ClipboardCapture] suppressed: content already on server');
        return;
      }

      await _uploadWithRetry(text, hash);
    } catch (e) {
      debugPrint('[ClipboardCapture] process failed: $e');
    }
  }

  /// 是否为已知服务端内容（回环抑制判定）
  bool isKnownServerContent(String text) {
    final hash = _hashOf(text);
    final seenAt = _knownServerHashes[hash];
    if (seenAt != null && DateTime.now().difference(seenAt) < _knownHashTtl) {
      return true;
    }
    // 应用内复制：内容与已加载列表条目一致，说明来自服务端，不再入库
    final provider = _provider;
    if (provider != null) {
      for (final item in provider.items) {
        if (item.copyText == text) return true;
      }
    }
    return false;
  }

  /// WS 推送登记（[EchoAwareClipboardProvider.handleNewItem] 前调用）：
  /// 服务端推来的内容进入本地列表时登记哈希，防止之后被采集管线重复上传。
  void registerServerContent(String? content) {
    if (content == null || content.isEmpty) return;
    _remember(_hashOf(content));
  }

  String _hashOf(String text) => sha256.convert(utf8.encode(text)).toString();

  void _remember(String hash) {
    _knownServerHashes[hash] = DateTime.now();
    // 裁剪：超量时丢弃最旧的登记
    if (_knownServerHashes.length > _maxKnownHashes) {
      final oldestFirst = _knownServerHashes.keys.toList()
        ..sort((a, b) => _knownServerHashes[a]!.compareTo(_knownServerHashes[b]!));
      for (final key
          in oldestFirst.take(_knownServerHashes.length - _maxKnownHashes)) {
        _knownServerHashes.remove(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 上传（POST /api/clipboard）
  // ---------------------------------------------------------------------------

  Future<void> _uploadWithRetry(String text, String hash) async {
    for (var attempt = 1; attempt <= _maxUploadAttempts; attempt++) {
      try {
        final duplicated = await _upload(text);
        if (duplicated) {
          // 服务端 5 分钟内容哈希去重命中：内容已在服务端，登记后不再上传
          debugPrint('[ClipboardCapture] server dedup hit (duplicate)');
        }
        _remember(hash);
        return;
      } catch (e) {
        debugPrint('[ClipboardCapture] upload attempt $attempt failed: $e');
        if (attempt < _maxUploadAttempts) {
          await Future<void>.delayed(Duration(seconds: 3 * attempt));
        }
      }
    }
    // 重试耗尽：进入冷却，期间同内容采集跳过，不无限打服务器
    _failedHashCooldown[hash] = DateTime.now().add(_failedCooldown);
  }

  /// POST /api/clipboard（对齐服务端契约）。
  /// 返回 true 表示服务端内容去重命中（HTTP 200 + duplicate）。
  Future<bool> _upload(String text) async {
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) {
      debugPrint('[ClipboardCapture] skip upload: not logged in');
      return false;
    }
    final deviceId = _deviceIdProvider?.call();
    if (deviceId == null || deviceId.isEmpty) {
      debugPrint('[ClipboardCapture] skip upload: device not registered yet');
      return false;
    }

    var statusCode = await _postClipboard(text, token, deviceId);
    if (statusCode == 401) {
      // 访问令牌过期：静默续期一次后重放（T1.3 TokenStore 单飞契约）
      final renewed = await TokenStore.refreshAccessToken();
      if (renewed == null || renewed.isEmpty) {
        throw Exception('上传失败：HTTP 401 且刷新令牌不可用');
      }
      statusCode = await _postClipboard(text, renewed, deviceId);
    }
    return _interpret(statusCode);
  }

  Future<int> _postClipboard(String text, String token, String deviceId) async {
    final response = await http
        .post(
          Uri.parse('${ServerConfig.baseUrl}/api/clipboard'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
            'Idempotency-Key': _generateIdempotencyKey(),
          },
          body: jsonEncode(<String, dynamic>{
            'sourceDeviceId': deviceId,
            'contentType': 'text',
            'contentEncrypted': text,
            'contentPreview': text, // 服务端自行截断至 5000 字符
            'contentSize': text.length,
            'metadata': <String, dynamic>{},
          }),
        )
        .timeout(const Duration(seconds: 15));
    return response.statusCode;
  }

  bool _interpret(int statusCode) {
    if (statusCode == 201) return false; // 新建成功
    if (statusCode == 200) return true; // 服务端去重命中（duplicate: true）
    throw Exception('上传失败：HTTP $statusCode');
  }

  /// 幂等键：uuid 未依赖（T0.2 移除），用时间戳 + dart:math 随机数生成
  String _generateIdempotencyKey() {
    final rand = Random();
    return 'mobile-${DateTime.now().microsecondsSinceEpoch}-'
        '${rand.nextInt(1 << 30)}-${rand.nextInt(1 << 30)}';
  }
}

/// 带 WS 回环登记的剪贴板 Provider（T3.2 回环抑制）。
///
/// WS new_clipboard 进入 handleNewItem 前，先把内容登记进采集管线的
/// 「已知服务端内容」哈希环，杜绝「收到新内容 → 用户复制 → 采集管线重复上传」回环。
/// main.dart 以此替换 ClipboardProvider 注入；对 WsProvider 的回调接线与 UI 完全透明
/// （handleNewItem 仍照常插入列表，本类只做登记副作用）。
class EchoAwareClipboardProvider extends ClipboardProvider {
  @override
  void handleNewItem(Map<String, dynamic> data) {
    final raw = data['item'];
    final itemJson = raw is Map<String, dynamic> ? raw : data;
    final preview = itemJson['contentPreview'];
    ClipboardCaptureService.instance
        .registerServerContent(preview is String ? preview : null);
    super.handleNewItem(data);
  }
}
