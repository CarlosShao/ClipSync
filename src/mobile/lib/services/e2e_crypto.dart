// lib/services/e2e_crypto.dart

import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
// hide Mac：pointycastle 与 cryptography 均导出 Mac，此处 Mac 统一指 cryptography 的认证标签
import 'package:pointycastle/export.dart' hide Mac;
// ecc_fp 未被 export.dart 导出（ECCurve.q = 素域模数，on-curve 校验需要）
import 'package:pointycastle/ecc/ecc_fp.dart' as fp;

/// B8: 移动端（Flutter）端到端加密（E2E）密钥库与加解密。
///
/// 协议契约：`docs/plans/e2e-protocol.md`（唯一实现契约，本文件与其冲突时以协议为准）。
/// 测试向量：`docs/plans/e2e-vector.json`（`test/e2e_crypto_test.dart` 对拍，
/// 桌面端 Rust 参考实现见 `src/desktop/src-tauri/src/e2e_crypto.rs`）。
///
/// 算法栈（协议 §1）：
/// - 设备身份密钥：ECDH P-256（secp256r1）；公钥 = 65B 未压缩点（0x04 || X || Y）的 base64
/// - 内容加密：AES-256-GCM；随机 32B 内容密钥 K + 随机 12B IV；
///   密文存储格式 = base64(ciphertext || tag(16B))
/// - 密钥封装：ECDH(发送方临时私钥, 接收方静态公钥) → HKDF-SHA256
///   （salt = "clipsync-e2e-v1" ASCII，info = 接收方 deviceId UTF-8 字节，输出 32B KEK），
///   再用 KEK 以 AES-256-GCM（独立随机 12B 包装 IV）包装 K → 48B wrappedKey（32B K + 16B tag）
/// - 每次加密生成新的临时 P-256 密钥对，epk（65B 未压缩点 base64）随信封下发
///
/// 依赖分工（与工单推荐差异的说明，见 B8 交付报告）：
/// - P-256（密钥生成 / 点编解码 / ECDH）用 pointycastle（纯 Dart）——
///   cryptography 2.9.0 的 ECDH 在 Dart VM / 移动端是 UnimplementedError
///   （`DartEcdh` 全部方法直接抛出，仅浏览器 WebCrypto 有实现）；
/// - AES-256-GCM / HKDF-SHA256 用 cryptography 包（其纯 Dart 实现在 VM 可用）。
///
/// 私钥存储（协议 §4）：flutter_secure_storage，key = `e2e_device_priv_v1`，
/// 值 = 32B 私钥标量的 base64。公钥始终由私钥派生，不单独存储（避免不一致）。
/// - 私钥缺失时仅 [E2eCrypto.ensureKeypair] 会生成并持久化新密钥；
///   [E2eCrypto.decrypt] 私钥缺失时显式抛错，**不静默重新生成**——重新生成会让
///   本设备永久解不开历史 E2E 条目，必须显式暴露失败；
/// - 存储值损坏（非 base64 / 非 32B / 非法标量）时同样显式抛错，不静默重生成。

/// E2E 加解密失败抛出的异常（密钥缺失/损坏、信封非法、认证失败等）。
class E2eCryptoException implements Exception {
  final String message;

  const E2eCryptoException(this.message);

  @override
  String toString() => 'E2eCryptoException: $message';
}

/// E2E 密钥对：32B 私钥标量 + 65B 未压缩点公钥。
class E2eKeyPair {
  final Uint8List privateKey;
  final Uint8List publicKey;

  const E2eKeyPair({required this.privateKey, required this.publicKey});

  /// 公钥 base64（65B 未压缩点，注册与 encrypt 时使用）
  String get publicKeyB64 => base64.encode(publicKey);
}

// ---------------------------------------------------------------------------
// 协议常量
// ---------------------------------------------------------------------------

/// 信封 alg 字段（协议 §2）
const String kE2eEnvelopeAlg = 'ECDH-P256+HKDF-SHA256+A256GCM';

/// HKDF salt（协议 §1，ASCII）
const String kE2eHkdfSalt = 'clipsync-e2e-v1';

/// 服务端限制：metadata.e2e.keys ≤ 32 项（协议 §5）
const int kE2eMaxRecipients = 32;

/// 信封版本（协议 §2）
const int _envelopeVersion = 1;

/// P-256 未压缩公钥长度（0x04 || X || Y）
const int _p256UncompressedLen = 65;

/// P-256 私钥标量 / 内容密钥 K / KEK 长度（32B）
const int _scalarLen = 32;

/// AES-GCM IV 长度（96-bit）
const int _gcmIvLen = 12;

/// AES-GCM 认证标签长度（16B）
const int _gcmTagLen = 16;

// ---------------------------------------------------------------------------
// 底层原语：base64 / 随机数 / P-256（pointycastle）/ AES-256-GCM+HKDF（cryptography）
// ---------------------------------------------------------------------------

/// P-256 域参数（prime256v1 ≡ secp256r1）
final ECDomainParameters _p256 = ECDomainParameters('prime256v1');

final Random _secureRandom = Random.secure();

/// AES-256-GCM（12B nonce，128-bit tag；Dart VM/移动端走纯 Dart 实现）
final AesGcm _aesGcm = AesGcm.with256bits();

/// HKDF-SHA256（salt 经 deriveKey 的 nonce 参数传入），输出 32B
final Hkdf _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: _scalarLen);

Uint8List _randomBytes(int length) => Uint8List.fromList(
      List<int>.generate(length, (_) => _secureRandom.nextInt(256)),
    );

Uint8List _unb64(String s) {
  try {
    return base64.decode(s.trim());
  } on FormatException catch (e) {
    throw E2eCryptoException('e2e: base64 解码失败: $e');
  }
}

String _b64(List<int> bytes) => base64.encode(bytes);

BigInt _bytesToBigInt(List<int> bytes) {
  var result = BigInt.zero;
  for (final b in bytes) {
    result = (result << 8) | BigInt.from(b);
  }
  return result;
}

/// BigInt → 固定 32B 大端（P-256 标量 / 共享密钥 X 坐标均为 32B，左补零）
Uint8List _bigIntTo32Bytes(BigInt n) {
  final out = Uint8List(_scalarLen);
  var v = n;
  final mask = BigInt.from(0xff);
  for (var i = _scalarLen - 1; i >= 0; i--) {
    out[i] = (v & mask).toInt();
    v = v >> 8;
  }
  if (v.sign != 0) {
    throw const E2eCryptoException('e2e: 数值超出 32 字节（内部错误）');
  }
  return out;
}

/// 校验 32B 私钥标量并转为 BigInt（1 ≤ d < n）。
BigInt _privateScalar(List<int> privateKey) {
  if (privateKey.length != _scalarLen) {
    throw E2eCryptoException(
      'e2e: 私钥长度非法: ${privateKey.length}（应为 $_scalarLen）',
    );
  }
  final d = _bytesToBigInt(privateKey);
  if (d.sign <= 0 || d >= _p256.n) {
    throw const E2eCryptoException('e2e: 私钥标量非法（须为 1 ≤ d < 曲线阶）');
  }
  return d;
}

/// 解析并校验 P-256 公钥：base64 → 必须 65B 且 0x04 开头（未压缩点）、在曲线上。
ECPoint _parsePublicKeyB64(String publicKeyB64) {
  final bytes = _unb64(publicKeyB64);
  if (bytes.length != _p256UncompressedLen) {
    throw E2eCryptoException(
      'e2e: 公钥必须为 $_p256UncompressedLen 字节未压缩点，实际 ${bytes.length} 字节',
    );
  }
  if (bytes[0] != 0x04) {
    throw const E2eCryptoException('e2e: 公钥必须以 0x04 开头（未压缩点格式）');
  }
  final ECPoint? q;
  try {
    q = _p256.curve.decodePoint(bytes);
  } catch (e) {
    throw E2eCryptoException('e2e: 非法 P-256 公钥: $e');
  }
  if (q == null || q.isInfinity) {
    throw const E2eCryptoException('e2e: 非法 P-256 公钥（不在曲线上）');
  }
  if (!_isOnCurve(q)) {
    throw const E2eCryptoException('e2e: 非法 P-256 公钥（不在曲线上）');
  }
  return q;
}

/// 校验点满足曲线方程 y² = x³ + ax + b (mod p)。
/// pointycastle 的 decodePoint 不做 on-curve 校验（Rust p256 crate 会拒绝非法点），
/// 行为对齐必须显式校验。P-256 cofactor = 1，在曲线上即在素数阶子群内。
bool _isOnCurve(ECPoint q) {
  final x = q.x?.toBigInteger();
  final y = q.y?.toBigInteger();
  if (x == null || y == null) {
    return false;
  }
  final p = (_p256.curve as fp.ECCurve).q!;
  final a = _p256.curve.a!.toBigInteger()!;
  final b = _p256.curve.b!.toBigInteger()!;
  final lhs = (y * y) % p;
  final rhs = (x * x % p * x + a * x + b) % p;
  return lhs == rhs;
}

/// 由 32B 私钥标量构造密钥对（公钥 = 标量 × 生成元，65B 未压缩点）。
E2eKeyPair _keyPairFromScalar(List<int> scalar) {
  final d = _privateScalar(scalar);
  final q = _p256.G * d;
  if (q == null || q.isInfinity) {
    throw const E2eCryptoException('e2e: 公钥派生得到无穷远点（内部错误）');
  }
  return E2eKeyPair(
    privateKey: Uint8List.fromList(scalar),
    publicKey: q.getEncoded(false),
  );
}

/// 生成新的 P-256 密钥对（拒绝采样：1 ≤ d < n）。
E2eKeyPair e2eGenerateKeypair() {
  BigInt d;
  do {
    d = _bytesToBigInt(_randomBytes(_scalarLen));
  } while (d.sign == 0 || d >= _p256.n);
  return _keyPairFromScalar(_bigIntTo32Bytes(d));
}

/// 由 32B 私钥标量（seed）构造密钥对。测试向量对拍与存储恢复用。
E2eKeyPair e2eKeypairFromSeed(List<int> seed) => _keyPairFromScalar(seed);

/// ECDH(ephPriv, peerPub) → HKDF-SHA256(salt="clipsync-e2e-v1", info=deviceId)
/// → 32B KEK。共享密钥取共享点 X 坐标的 32B 大端（与 Rust p256 diffie_hellman
/// 的 raw_secret_bytes 一致）。
Future<Uint8List> _deriveKek({
  required BigInt ephPriv,
  required ECPoint peerPub,
  required String deviceId,
}) async {
  final shared = peerPub * ephPriv;
  if (shared == null || shared.isInfinity || shared.x == null) {
    throw const E2eCryptoException('e2e: ECDH 共享点非法（对端公钥不合法）');
  }
  final sharedX = shared.x!.toBigInteger();
  if (sharedX == null) {
    throw const E2eCryptoException('e2e: ECDH 共享点坐标非法（内部错误）');
  }
  final kek = await _hkdf.deriveKey(
    secretKey: SecretKey(_bigIntTo32Bytes(sharedX)),
    nonce: utf8.encode(kE2eHkdfSalt),
    info: utf8.encode(deviceId),
  );
  return Uint8List.fromList(await kek.extractBytes());
}

/// AES-256-GCM 加密，输出 ciphertext || tag(16B)。
Future<Uint8List> _aesGcmSeal(List<int> key, List<int> iv, List<int> plaintext) async {
  final box = await _aesGcm.encrypt(
    plaintext,
    secretKey: SecretKey(key),
    nonce: iv,
  );
  return Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
}

/// AES-256-GCM 解密（输入 = ciphertext || tag(16B)，tag 校验失败即整体失败）。
Future<Uint8List> _aesGcmOpen(List<int> key, List<int> iv, List<int> sealed) async {
  if (sealed.length < _gcmTagLen) {
    throw const E2eCryptoException('e2e: AES-GCM 密文长度非法（不足 16B tag）');
  }
  final split = sealed.length - _gcmTagLen;
  try {
    final plain = await _aesGcm.decrypt(
      SecretBox(
        sealed.sublist(0, split),
        nonce: iv,
        mac: Mac(sealed.sublist(split)),
      ),
      secretKey: SecretKey(key),
    );
    return Uint8List.fromList(plain);
  } on SecretBoxAuthenticationError {
    throw const E2eCryptoException('e2e: AES-GCM 解密失败（密文被篡改或密钥不匹配）');
  }
}

String _requireString(Map<dynamic, dynamic> map, String field) {
  final v = map[field];
  if (v is String && v.isNotEmpty) return v;
  throw E2eCryptoException('e2e: 信封缺少 $field');
}

// ---------------------------------------------------------------------------
// 纯加密核心（无 I/O，供服务层与单元测试复用）
// ---------------------------------------------------------------------------

/// 加密（协议 §3 发送流程）：
/// 1. 随机 32B 内容密钥 K + 12B 内容 IV，ciphertext = AES-256-GCM(K, iv, plaintext)；
/// 2. 生成一次性临时 P-256 密钥对（epk 随信封走）；
/// 3. 对每个接收设备 d：KEK = HKDF(ECDH(ephPriv, pub_d), salt, info=d)，
///    keys[d] = { w: AES-GCM(KEK, wiv, K)（48B）, iv: wiv }。
///
/// 返回完整信封 + `ciphertext` 字段（字段名与 Rust e2e_encrypt_core 对齐）：
/// `{v, alg, epk, iv, keys: {deviceId: {w, iv}}, ciphertext}`。
/// 上传时 `ciphertext` 进 content_encrypted 列，metadata.e2e 只保留
/// v/alg/epk/iv/keys（协议 §2）；keys 是否包含发送设备自己由调用方决定（协议要求包含）。
Future<Map<String, dynamic>> e2eEncrypt(
  List<int> contentBytes,
  Map<String, String> recipientPubKeyByDeviceId,
) async {
  // 归一化接收方：trim deviceId、拒绝空值与去重后的冲突
  final recipients = <String, String>{};
  for (final entry in recipientPubKeyByDeviceId.entries) {
    final id = entry.key.trim();
    if (id.isEmpty) {
      throw const E2eCryptoException('e2e: recipient deviceId 不能为空');
    }
    if (recipients.containsKey(id)) {
      throw E2eCryptoException('e2e: recipient deviceId 重复: $id');
    }
    recipients[id] = entry.value;
  }
  if (recipients.isEmpty) {
    throw const E2eCryptoException(
      'e2e: recipients 为空（至少需要 1 个接收设备；按协议发送方也应把自己加入 keys）',
    );
  }
  if (recipients.length > kE2eMaxRecipients) {
    throw E2eCryptoException('e2e: recipients 数量超过服务端上限 $kE2eMaxRecipients');
  }

  final contentKey = _randomBytes(_scalarLen);
  final contentIv = _randomBytes(_gcmIvLen);
  final ciphertext = await _aesGcmSeal(contentKey, contentIv, contentBytes);

  // 每次加密生成新的临时 P-256 密钥对（epk 随信封走）
  final eph = e2eGenerateKeypair();
  final ephPriv = _bytesToBigInt(eph.privateKey);

  final keys = <String, Map<String, String>>{};
  for (final entry in recipients.entries) {
    final peerPub = _parsePublicKeyB64(entry.value);
    final kek = await _deriveKek(ephPriv: ephPriv, peerPub: peerPub, deviceId: entry.key);
    final wiv = _randomBytes(_gcmIvLen);
    final wrapped = await _aesGcmSeal(kek, wiv, contentKey); // 32B K + 16B tag = 48B
    keys[entry.key] = {'w': _b64(wrapped), 'iv': _b64(wiv)};
  }

  return {
    'v': _envelopeVersion,
    'alg': kE2eEnvelopeAlg,
    'epk': eph.publicKeyB64,
    'iv': _b64(contentIv),
    'keys': keys,
    'ciphertext': _b64(ciphertext),
  };
}

/// 解密（协议 §3 接收流程）：ECDH(myPriv, epk) → HKDF(info=本机 deviceId) →
/// 解包 K → AES-GCM 解密 ciphertext。返回明文字节。
///
/// 信封字段要求：epk / iv / keys（{ deviceId: { w, iv } }）必填；密文从
/// `ciphertext`、`ciphertextB64`（e2e-vector.json 的写法）或 `content_encrypted`
/// （协议列名）三者之一读取——与 Rust e2e_decrypt_core 的兼容字段解析一致。
/// 本设备不在 keys → [E2eCryptoException]（占位语义由 UI 层实现）。
Future<Uint8List> e2eDecrypt(
  Map<dynamic, dynamic> envelope,
  String myDeviceId,
  List<int> privateKey,
) async {
  final deviceId = myDeviceId.trim();
  if (deviceId.isEmpty) {
    throw const E2eCryptoException('e2e: myDeviceId 不能为空');
  }
  final priv = _privateScalar(privateKey);

  final epk = _parsePublicKeyB64(_requireString(envelope, 'epk'));
  final iv = _unb64(_requireString(envelope, 'iv'));
  if (iv.length != _gcmIvLen) {
    throw E2eCryptoException('e2e: 内容 IV 长度非法: ${iv.length}（应为 $_gcmIvLen）');
  }
  final keysObj = envelope['keys'];
  if (keysObj is! Map) {
    throw const E2eCryptoException('e2e: 信封缺少 keys');
  }
  final entry = keysObj[deviceId];
  if (entry == null) {
    throw E2eCryptoException('e2e: 本设备 ($deviceId) 不在信封 keys 列表中');
  }
  if (entry is! Map) {
    throw const E2eCryptoException('e2e: keys 条目非法');
  }
  final wrapped = _unb64(_requireString(entry, 'w'));
  final wiv = _unb64(_requireString(entry, 'iv'));
  if (wiv.length != _gcmIvLen) {
    throw E2eCryptoException('e2e: 包装 IV 长度非法: ${wiv.length}（应为 $_gcmIvLen）');
  }
  String? ctB64;
  for (final field in const ['ciphertext', 'ciphertextB64', 'content_encrypted']) {
    final v = envelope[field];
    if (v is String && v.isNotEmpty) {
      ctB64 = v;
      break;
    }
  }
  if (ctB64 == null) {
    throw const E2eCryptoException(
      'e2e: 信封缺少密文字段（ciphertext / ciphertextB64 / content_encrypted 三者之一）',
    );
  }

  // ECDH(myPriv, epk) → HKDF(salt, info=本机 deviceId) → KEK → 解包 K
  final kek = await _deriveKek(ephPriv: priv, peerPub: epk, deviceId: deviceId);
  final contentKey = await _aesGcmOpen(kek, wiv, wrapped);
  if (contentKey.length != _scalarLen) {
    throw E2eCryptoException(
      'e2e: 解包出的内容密钥长度非法: ${contentKey.length}（应为 $_scalarLen）',
    );
  }
  return _aesGcmOpen(contentKey, iv, _unb64(ctB64));
}

// ---------------------------------------------------------------------------
// 服务层：私钥持久化（flutter_secure_storage）+ 便捷入口
// ---------------------------------------------------------------------------

/// E2E 密钥库服务（单例 [E2eCrypto.instance]）。
///
/// - 私钥经 flutter_secure_storage 持久化（Android Keystore 加密），
///   key 名按协议 §4 固定为 `e2e_device_priv_v1`；
/// - 内存缓存避免反复读安全存储；[ensureKeypair] 单飞避免并发生成两把私钥；
/// - 生成 / 读取失败一律显式抛 [E2eCryptoException]，不静默重生成。
class E2eCrypto {
  E2eCrypto._();

  static final E2eCrypto instance = E2eCrypto._();

  /// secure storage 键名（协议 §4）
  static const String _storageKey = 'e2e_device_priv_v1';

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  /// 进程内缓存（含派生公钥）
  E2eKeyPair? _cachedKeypair;

  /// 进行中的 ensureKeypair（单飞）
  Future<String>? _ensureInFlight;

  /// 确保本机存在 E2E 静态密钥对：内存 → secure storage → 生成并持久化。
  /// 返回公钥 base64（65B 未压缩点）。设备注册前调用并把返回值作为
  /// `publicKey` 上送（协议 §4）。
  Future<String> ensureKeypair() {
    final inFlight = _ensureInFlight;
    if (inFlight != null) {
      return inFlight;
    }
    final future = _doEnsureKeypair();
    _ensureInFlight = future;
    future.whenComplete(() {
      _ensureInFlight = null;
    });
    return future;
  }

  Future<String> _doEnsureKeypair() async {
    final cached = _cachedKeypair;
    if (cached != null) {
      return cached.publicKeyB64;
    }
    final stored = await _readStoredPrivateKey();
    if (stored != null) {
      final kp = _keyPairFromScalar(stored);
      _cachedKeypair = kp;
      return kp.publicKeyB64;
    }
    final kp = e2eGenerateKeypair();
    try {
      await _storage.write(key: _storageKey, value: _b64(kp.privateKey));
    } catch (e) {
      // 写入失败不缓存：未持久化的密钥下次启动会变（设备身份不稳定），
      // 必须让调用方（设备注册）显式失败重试。
      throw E2eCryptoException('e2e: E2E 私钥写入安全存储失败: $e');
    }
    _cachedKeypair = kp;
    debugPrint('[E2eCrypto] E2E keypair generated and persisted');
    return kp.publicKeyB64;
  }

  /// 只读返回本机公钥 base64；未生成过密钥对时返回 null（不触发生成）。
  Future<String?> publicKey() async {
    final cached = _cachedKeypair;
    if (cached != null) {
      return cached.publicKeyB64;
    }
    final stored = await _readStoredPrivateKey();
    if (stored == null) {
      return null;
    }
    final kp = _keyPairFromScalar(stored);
    _cachedKeypair = kp;
    return kp.publicKeyB64;
  }

  /// 加密内容字节（协议 §3 发送流程）。加密只用一次性临时密钥对 + 接收方公钥，
  /// 不依赖本机静态私钥。按协议，调用方应把本设备也放进
  /// [recipientPubKeyByDeviceId]（keys 须包含发送方自己）。
  Future<Map<String, dynamic>> encrypt(
    List<int> contentBytes,
    Map<String, String> recipientPubKeyByDeviceId,
  ) {
    return e2eEncrypt(contentBytes, recipientPubKeyByDeviceId);
  }

  /// 解密信封（协议 §3 接收流程）→ 明文字节。
  /// - 本设备不在信封 keys 列表 → [E2eCryptoException]（UI 显示占位）；
  /// - 本机私钥缺失 → [E2eCryptoException]，**不静默重新生成**。
  Future<Uint8List> decrypt(Map<dynamic, dynamic> envelope, String myDeviceId) async {
    final cached = _cachedKeypair;
    if (cached != null) {
      return e2eDecrypt(envelope, myDeviceId, cached.privateKey);
    }
    final stored = await _readStoredPrivateKey();
    if (stored == null) {
      throw const E2eCryptoException(
        'e2e: E2E 私钥缺失（本设备尚未生成密钥对；应先经设备注册触发 ensureKeypair）',
      );
    }
    return e2eDecrypt(envelope, myDeviceId, stored);
  }

  /// 读取并校验 secure storage 中的私钥；未存储返回 null。
  /// 存储损坏或平台通道异常 → 显式抛 [E2eCryptoException]（不静默重生成：
  /// 读取失败时无法判断密钥是否存在，此时贸然生成会造成第二个设备身份）。
  Future<Uint8List?> _readStoredPrivateKey() async {
    String? stored;
    try {
      stored = await _storage.read(key: _storageKey);
    } catch (e) {
      throw E2eCryptoException('e2e: E2E 私钥读取安全存储失败: $e');
    }
    if (stored == null || stored.isEmpty) {
      return null;
    }
    final bytes = _unb64(stored);
    _privateScalar(bytes); // 长度与标量范围校验，非法即抛
    return bytes;
  }
}
