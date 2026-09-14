import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../providers/clipboard_provider.dart';
import '../providers/feature_flags_provider.dart';
import '../providers/settings_provider.dart';
import 'app_exception.dart';
import 'e2e_crypto.dart';
import 'pending_upload_queue.dart';
import 'server_config.dart';
import 'token_store.dart';

/// 前台服务剪贴板采集管线（T3.2）
///
/// 职责：接收 Kotlin 前台服务经 MethodChannel（clipsync/sync，onClipboardCaptured）
/// 回传的系统剪贴板文本 → 多层去重与回环抑制 → 走既有上传契约入库
/// （POST /api/clipboard：sourceDeviceId + contentEncrypted 必填、Idempotency-Key 幂等键）。
///
/// B9 E2E 端到端加密（协议契约 docs/plans/e2e-protocol.md）：
/// - 双闸门（协议 §5）＝ 用户级本地开关（SharedPreferences 'e2e_enabled'，
///   执行侧实时读，与 SettingsProvider 同键）∧ 套餐特性位 e2e_encryption
///   （FeatureFlagsProvider 快照，不可达时 fail-open）；任一不满足走旧明文路径；
/// - 开关开启：拉账号设备公钥表（GET /api/devices，含本机）→ encrypt →
///   密文进 content/contentEncrypted、不含 ciphertext 的信封进 metadata.e2e、
///   contentPreview 置 '[E2E]'（与桌面 B6 字段语义对齐）；
/// - 加密原语失败（E2eCryptoException）fail-closed：中止发送，绝不回退明文；
///   无任何收件人公钥 → 回退明文（协议 §5 可用性降级）；
/// - 离线队列：加密发生在入队前（密封包装经 entry.text 通道随队列入库，
///   重放时原样上传，不重加密、不落明文）。
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
        // 冷却结束：若离线队列有积压 → 顺带触发一次重放尝试
        // （不内嵌 timer；由采集/网络恢复事件驱动，队列内部有重入保护）
        unawaited(_replayQueueIfPending());
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
  // B9 E2E 端到端加密（协议 §3 发送流程 / §5 双闸门与降级）
  // ---------------------------------------------------------------------------

  /// 收件人公钥缓存 TTL（对齐桌面端 B6：批量重试/连发时避免每条都打 /api/devices）
  static const Duration _recipientsTtl = Duration(seconds: 15);

  Map<String, String>? _recipientsCache;
  DateTime? _recipientsCachedAt;

  /// E2E 双闸门（协议 §5）：用户级本地开关（SharedPreferences，执行侧每次
  /// 实时读，与 SettingsProvider.e2eEnabledPrefKey 同键）∧ 套餐特性位
  /// e2e_encryption（FeatureFlagsProvider 套餐快照；快照不可达时 fail-open，
  /// 服务端权威兜底）。任一不满足 → 走旧明文路径。
  Future<bool> _isE2eEnabled() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!(prefs.getBool(SettingsProvider.e2eEnabledPrefKey) ?? false)) {
        return false;
      }
    } catch (e) {
      debugPrint('[ClipboardCapture] e2e switch read failed (treated off): $e');
      return false;
    }
    return FeatureFlagsProvider.maybeActive?.e2eEncryptionAllowed ?? true;
  }

  /// 拉取账号设备公钥表（GET /api/devices；响应为数组或 {devices:[...]}，
  /// 每项 public_key 为 65B 未压缩点 base64）并收集带公钥的设备。
  /// 含本机：服务端返回账号全部设备，协议 §3 要求 keys 包含发送方自己。
  /// 拉取失败 / 无带公钥设备 → 空映射（调用方按协议 §5 回退明文）。
  Future<Map<String, String>> _collectRecipientKeys() async {
    final cached = _recipientsCache;
    final cachedAt = _recipientsCachedAt;
    if (cached != null &&
        cachedAt != null &&
        DateTime.now().difference(cachedAt) < _recipientsTtl) {
      return cached;
    }
    try {
      final token = await TokenStore.getAccessToken();
      if (token == null || token.isEmpty) return const <String, String>{};
      final response = await http
          .get(
            Uri.parse('${ServerConfig.baseUrl}/api/devices'),
            headers: <String, String>{'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) {
        debugPrint('[ClipboardCapture] e2e devices fetch HTTP '
            '${response.statusCode} (plaintext fallback)');
        return const <String, String>{};
      }
      final decoded = jsonDecode(response.body);
      final List<dynamic> list = decoded is List
          ? decoded
          : decoded is Map<String, dynamic> && decoded['devices'] is List
              ? decoded['devices'] as List<dynamic>
              : const <dynamic>[];
      final keys = <String, String>{};
      for (final d in list) {
        if (d is! Map) continue;
        final id = d['id'];
        final publicKey = d['public_key'];
        if (id is String && id.isNotEmpty && publicKey is String && publicKey.isNotEmpty) {
          keys[id] = publicKey;
        }
      }
      _recipientsCache = keys;
      _recipientsCachedAt = DateTime.now();
      return keys;
    } catch (e) {
      debugPrint('[ClipboardCapture] e2e collect recipients failed '
          '(plaintext fallback): $e');
      return const <String, String>{};
    }
  }

  /// 加密一段文本（协议 §3）。返回 null = 回退明文（无任何收件人公钥）；
  /// 抛 [E2eCryptoException] = 加密原语失败（调用方 fail-closed 中止发送，
  /// 绝不回退明文）。
  Future<_E2eSealed?> _encryptText(String text) async {
    final recipients = await _collectRecipientKeys();
    if (recipients.isEmpty) return null;
    // 服务端 metadata.e2e.keys 上限 32 项（协议 §5），超限截断（对齐桌面端 B6）
    var entries = recipients.entries.toList(growable: false);
    if (entries.length > kE2eMaxRecipients) {
      entries = entries.sublist(0, kE2eMaxRecipients);
    }
    final envelope = await E2eCrypto.instance.encrypt(
      utf8.encode(text),
      Map<String, String>.fromEntries(entries),
    );
    final ciphertext = envelope.remove('ciphertext');
    if (ciphertext is! String || ciphertext.isEmpty) {
      throw const E2eCryptoException('e2e: 信封缺少 ciphertext（内部错误）');
    }
    return _E2eSealed(ciphertext, envelope);
  }

  // --- 离线队列密封通道（B9 第 2 项：加密发生在入队前） ---

  /// 队列条目 schema 只有一个 text 通道（重放链路 SyncService → reuploadText
  /// 仅透传 text + 幂等键，队列机制本身不改动），密文与信封以带魔数前缀的
  /// JSON 打包进 text。魔数前缀 + 结构化双重校验：解码失败一律按普通文本
  /// 走明文链路，不会破坏存量明文积压条目。
  static const String _e2eQueueTag = 'clipsyncE2e';
  static const String _e2eQueuePrefix = '{"$_e2eQueueTag":';

  /// 密封载荷 → 队列 text 字段（带魔数前缀的 JSON）
  String _encodeE2eForQueue(_E2eSealed sealed) => jsonEncode(<String, dynamic>{
        _e2eQueueTag: 1,
        'ciphertext': sealed.ciphertextB64,
        'envelope': sealed.envelope,
      });

  /// 队列 text 字段 → 密封载荷；非密封包装 / 结构非法返回 null（按明文处理）
  _E2eSealed? _decodeE2eFromQueue(String text) {
    if (!text.startsWith(_e2eQueuePrefix)) return null;
    try {
      final decoded = jsonDecode(text);
      if (decoded is! Map<String, dynamic>) return null;
      if (decoded[_e2eQueueTag] != 1) return null;
      final ciphertext = decoded['ciphertext'];
      final envelope = decoded['envelope'];
      if (ciphertext is! String ||
          ciphertext.isEmpty ||
          envelope is! Map<String, dynamic>) {
        return null;
      }
      return _E2eSealed(ciphertext, envelope);
    } catch (e) {
      debugPrint('[ClipboardCapture] e2e queue payload decode failed '
          '(treated as plain text): $e');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 上传（POST /api/clipboard）
  // ---------------------------------------------------------------------------

  Future<void> _uploadWithRetry(String text, String hash) async {
    // 幂等键一次性生成并贯穿所有重试与离线入队：服务端按 Idempotency-Key 幂等，
    // 超时重试/离线重放复用同键，避免「请求已达服务端但响应丢失」类场景重复入库
    final idempotencyKey = _generateIdempotencyKey();
    // B9：双闸门开启时加密一次性完成并贯穿重试与离线入队（加密发生在入队前，
    // 同一密文/信封随幂等键复用，避免每次重试重加密出不同密文）。
    _E2eSealed? e2e;
    if (await _isE2eEnabled()) {
      try {
        e2e = await _encryptText(text);
      } on E2eCryptoException catch (err) {
        // fail-closed（协议 §3/§5）：加密失败绝不回退明文——中止发送且不入队明文
        debugPrint('[ClipboardCapture] e2e encrypt failed, abort upload '
            '(fail-closed, no plaintext fallback): $err');
        return;
      }
      if (e2e == null) {
        // 无任何收件人公钥：按协议 §5 回退明文（约定的可用性降级）
        debugPrint('[ClipboardCapture] e2e enabled but no recipient public keys, '
            'falling back to plaintext');
      }
    }
    for (var attempt = 1; attempt <= _maxUploadAttempts; attempt++) {
      try {
        final duplicated =
            await _upload(text, idempotencyKey: idempotencyKey, e2e: e2e);
        if (duplicated) {
          // 服务端 5 分钟内容哈希去重命中：内容已在服务端，登记后不再上传
          debugPrint('[ClipboardCapture] server dedup hit (duplicate)');
        }
        _remember(hash);
        // 上传成功：清除离线队列中同文本积压（避免后续重放重复入库）
        await PendingUploadQueue.instance.removeMatchingText(text);
        return;
      } catch (e) {
        debugPrint('[ClipboardCapture] upload attempt $attempt failed: $e');
        if (attempt < _maxUploadAttempts) {
          await Future<void>.delayed(Duration(seconds: 3 * attempt));
        }
      }
    }
    // 重试耗尽：进入冷却（防抖动，期间同内容采集跳过），
    // 同时入离线持久化队列——网络恢复/冷却结束/重启后由重放链路补传，不再静默丢失。
    // B9：加密条目在入队前已完成加密，队列存密封包装（重放时原样上传，
    // 不重加密、不落明文；见 _encodeE2eForQueue）。
    _failedHashCooldown[hash] = DateTime.now().add(_failedCooldown);
    await PendingUploadQueue.instance.enqueue(
      idempotencyKey: idempotencyKey,
      contentType: 'text',
      text: e2e != null ? _encodeE2eForQueue(e2e) : text,
      initialAttempts: _maxUploadAttempts,
    );
    debugPrint('[ClipboardCapture] upload failed $_maxUploadAttempts times: '
        'content queued for offline replay (${e2e != null ? 'e2e' : 'plaintext'})');
  }

  /// 离线队列有积压时触发一次重放尝试（重入保护与空队列判断在队列内部）
  Future<void> _replayQueueIfPending() async {
    if (await PendingUploadQueue.instance.hasPending()) {
      await PendingUploadQueue.instance.replayPending();
    }
  }

  /// POST /api/clipboard（对齐服务端契约）。
  /// 返回 true 表示服务端内容去重命中（HTTP 200 + duplicate）。
  /// [e2e] 非空时按 B9 E2E 契约构造密文请求体（见 [_postClipboard]）。
  Future<bool> _upload(String text, {required String idempotencyKey, _E2eSealed? e2e}) async {
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

    var statusCode =
        await _postClipboard(text, token, deviceId, idempotencyKey, e2e: e2e);
    if (statusCode == 401) {
      // 访问令牌过期：静默续期一次后重放（T1.3 TokenStore 单飞契约）
      final renewed = await TokenStore.refreshAccessToken();
      if (renewed == null || renewed.isEmpty) {
        throw const AppException(
          AppErrorCodes.uploadFailed,
          'HTTP 401 and refresh token unavailable',
        );
      }
      statusCode = await _postClipboard(text, renewed, deviceId,
          idempotencyKey, e2e: e2e);
    }
    return _interpret(statusCode);
  }

  /// 离线队列重放：按既有上传链路重传文本（复用入队时的幂等键）。
  /// 返回 true=成功（含服务端幂等/去重命中），false=仍失败（队列保留该条）。
  /// 成功后登记哈希（回环抑制层 2a），WS 推回的回声不会引发再次上传。
  ///
  /// B9 重放三态：
  /// a) 密封包装条目（入队前已加密）：原样上传信封+密文，不重加密、不受当前
  ///    开关影响——开关关闭不能把已加密内容改发明文，也不该重加密密文；
  /// b) 明文条目 + 当前双闸门开启（入队早于开开关的积压）：重放时补加密；
  ///    补加密失败 fail-closed：返回 false 保留队列，绝不回退明文发送；
  /// c) 明文条目 + 开关关闭：沿用旧明文链路。
  Future<bool> reuploadText(String text, String idempotencyKey) async {
    try {
      final token = await TokenStore.getAccessToken();
      if (token == null || token.isEmpty) {
        debugPrint('[ClipboardCapture] replay skip: not logged in');
        return false;
      }
      final deviceId = _deviceIdProvider?.call();
      if (deviceId == null || deviceId.isEmpty) {
        debugPrint('[ClipboardCapture] replay skip: device not registered yet');
        return false;
      }
      _E2eSealed? e2e = _decodeE2eFromQueue(text);
      var payloadText = text;
      if (e2e != null) {
        payloadText = e2e.ciphertextB64; // 仅用于哈希登记，请求体走 e2e 分支
      } else if (await _isE2eEnabled()) {
        try {
          e2e = await _encryptText(text);
        } on E2eCryptoException catch (err) {
          debugPrint('[ClipboardCapture] replay e2e encrypt failed, keep queued '
              '(fail-closed, no plaintext fallback): $err');
          return false;
        }
      }
      await _upload(payloadText, idempotencyKey: idempotencyKey, e2e: e2e);
      _remember(_hashOf(payloadText));
      return true;
    } catch (e) {
      debugPrint('[ClipboardCapture] replay upload failed: $e');
      return false;
    }
  }

  /// POST /api/clipboard（对齐服务端契约）。
  ///
  /// B9：[e2e] 非空时按协议 §2 拆列构造密文请求体（与桌面 B6 字段语义对齐）——
  /// `content`/`contentEncrypted` 均为信封 ciphertext（content_encrypted 列）、
  /// `metadata.e2e` 为不含 ciphertext 的信封、`contentPreview` 置 '[E2E]'
  /// （服务端 tsvector 全文搜索自然降级）；null 时沿用旧明文请求体。
  Future<int> _postClipboard(
      String text, String token, String deviceId, String idempotencyKey,
      {_E2eSealed? e2e}) async {
    final Map<String, dynamic> body;
    if (e2e != null) {
      body = <String, dynamic>{
        'sourceDeviceId': deviceId,
        'contentType': 'text',
        'content': e2e.ciphertextB64,
        'contentEncrypted': e2e.ciphertextB64,
        'contentPreview': '[E2E]',
        'contentSize': e2e.ciphertextB64.length,
        'metadata': <String, dynamic>{'e2e': e2e.envelope},
      };
    } else {
      body = <String, dynamic>{
        'sourceDeviceId': deviceId,
        'contentType': 'text',
        'contentEncrypted': text,
        'contentPreview': text, // 服务端自行截断至 5000 字符
        'contentSize': text.length,
        'metadata': <String, dynamic>{},
      };
    }
    final response = await http
        .post(
          Uri.parse('${ServerConfig.baseUrl}/api/clipboard'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
            'Idempotency-Key': idempotencyKey,
          },
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 15));
    return response.statusCode;
  }

  bool _interpret(int statusCode) {
    if (statusCode == 201) return false; // 新建成功
    if (statusCode == 200) return true; // 服务端去重命中（duplicate: true）
    throw AppException(AppErrorCodes.uploadFailed, 'HTTP $statusCode');
  }

  /// 幂等键：uuid 未依赖（T0.2 移除），用时间戳 + dart:math 随机数生成
  String _generateIdempotencyKey() {
    final rand = Random();
    return 'mobile-${DateTime.now().microsecondsSinceEpoch}-'
        '${rand.nextInt(1 << 30)}-${rand.nextInt(1 << 30)}';
  }

  // === B9 补线：图片条目 E2E（调用方：main.dart 截屏 / share_receive_screen / sync_service 重放） ===
  // 图片密文不能走 /api/media/image（服务端用 sharp 解析明文字节，密文会 500），
  // 必须改走 /api/clipboard JSON 端点（与桌面 B6 图片路径同构：密文进 content_encrypted 列，
  // 信封进 metadata.e2e，接收端从条目详情解密渲染）。

  /// 图片条目 E2E 上传（三态）：
  /// - 开关关 / 无收件人公钥 / 无 token → handled:false（调用方回退旧明文 multipart 链路）
  /// - 加密原语失败 / 密文上传失败 → handled:true + aborted:true（fail-closed，绝不回退明文）
  /// - 成功 → handled:true + response（含服务端条目 id）
  Future<E2eImageOutcome> uploadImageMaybeE2e({
    required String deviceId,
    required List<int> imageBytes,
    required String filename,
    String? mimeType,
  }) async {
    if (!await _isE2eEnabled()) return const E2eImageOutcome(handled: false);
    final recipients = await _collectRecipientKeys();
    if (recipients.isEmpty) return const E2eImageOutcome(handled: false);
    final token = await TokenStore.getAccessToken();
    if (token == null || token.isEmpty) return const E2eImageOutcome(handled: false);

    final _E2eSealed sealed;
    try {
      var entries = recipients.entries.toList(growable: false);
      if (entries.length > kE2eMaxRecipients) {
        entries = entries.sublist(0, kE2eMaxRecipients);
      }
      final envelope = await E2eCrypto.instance.encrypt(
        imageBytes,
        Map<String, String>.fromEntries(entries),
      );
      final ciphertext = envelope.remove('ciphertext');
      if (ciphertext is! String || ciphertext.isEmpty) {
        throw const E2eCryptoException('e2e: 信封缺少 ciphertext（内部错误）');
      }
      sealed = _E2eSealed(ciphertext, envelope);
    } on E2eCryptoException catch (err) {
      debugPrint('[ClipboardCapture] e2e image encrypt failed, abort upload '
          '(fail-closed, no plaintext fallback): $err');
      return const E2eImageOutcome(handled: true, aborted: true);
    }

    final body = <String, dynamic>{
      'sourceDeviceId': deviceId,
      'contentType': 'image',
      'content': sealed.ciphertextB64,
      'contentEncrypted': sealed.ciphertextB64,
      'contentPreview': '[E2E]',
      'contentSize': sealed.ciphertextB64.length,
      'mimeType': (mimeType == null || mimeType.isEmpty) ? 'image/png' : mimeType,
      'metadata': <String, dynamic>{'e2e': sealed.envelope},
    };
    try {
      final response = await http
          .post(
            Uri.parse('${ServerConfig.baseUrl}/api/clipboard'),
            headers: <String, String>{
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
              'Idempotency-Key': _generateIdempotencyKey(),
            },
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 20));
      if (response.statusCode == 201 || response.statusCode == 200) {
        Map<String, dynamic>? decoded;
        try {
          final raw = jsonDecode(response.body);
          if (raw is Map<String, dynamic>) decoded = raw;
        } catch (_) {}
        return E2eImageOutcome(handled: true, response: decoded);
      }
      debugPrint('[ClipboardCapture] e2e image upload HTTP '
          '${response.statusCode} (fail-closed, no plaintext fallback)');
      return const E2eImageOutcome(handled: true, aborted: true);
    } catch (e) {
      debugPrint('[ClipboardCapture] e2e image upload failed: $e '
          '(fail-closed, no plaintext fallback)');
      return const E2eImageOutcome(handled: true, aborted: true);
    }
  }
}

/// B9 补线：图片 E2E 三态结果（见 [ClipboardCaptureService.uploadImageMaybeE2e]）
class E2eImageOutcome {
  const E2eImageOutcome({required this.handled, this.response, this.aborted = false});

  /// true = E2E 通道已终结（成功或 fail-closed），调用方不得再走明文链路
  final bool handled;

  /// 成功时的服务端响应（含 id）
  final Map<String, dynamic>? response;

  /// true = 加密/上传失败被 fail-closed 终止（内容未发出，也绝不明文重发）
  final bool aborted;
}

/// B9：E2E 密封载荷——信封拆列前的中间形态（协议 §2）：
/// ciphertext 进请求体 content/contentEncrypted（content_encrypted 列），
/// 其余信封字段（v/alg/epk/iv/keys）进 metadata.e2e。
class _E2eSealed {
  const _E2eSealed(this.ciphertextB64, this.envelope);

  /// base64(ciphertext || tag(16B))
  final String ciphertextB64;

  /// 不含 ciphertext 的信封
  final Map<String, dynamic> envelope;
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
