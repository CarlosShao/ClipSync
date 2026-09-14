// test/e2e_crypto_test.dart
//
// B8: 移动端 E2E 加密单元测试。
//
// 协议 §8 标准测试向量（docs/plans/e2e-vector.json）——与桌面 Rust 实现
// （src/desktop/src-tauri/src/e2e_crypto.rs `#[cfg(test)]`）相同的一组对拍用例：
// 1. 向量解密：fixture 私钥 + 信封 → 必须还原 expectedPlaintext；
// 2. 反向往返：fixture 公钥作为接收方公钥加密 → fixture 私钥解密 → 一致；
// 3. 自往返：随机生成密钥对 → encrypt → decrypt → 一致。
//
// 信封字段值硬编码（与 Rust 用例一致，避免测试运行目录相关的相对路径问题）；
// 向量原始字段名（ciphertextB64 等）映射为协议信封字段名后对拍。

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:clipsync_mobile/services/e2e_crypto.dart';

void main() {
  // docs/plans/e2e-vector.json —— 标准测试向量（硬编码常量）
  const vecDeviceId = '11111111-2222-3333-4444-555555555555';
  const vecRecipientPriv = 'pSdNimTX0ecVtVNpIvtdCHIOCbQFY3XN1PUE+VObiBY=';
  const vecRecipientPub =
      'BHaPJXJxZcrMOvnDkLRqTfjWYDKGDcv+yu65xzRJRqEFK4qtCAHoucSJ+mJ1phqGqo7uD7PU6Qkh495JQSl+rUI=';
  const vecCiphertext =
      'NxZxfY970DsYNuzknxqiHaU5i/cQkqp6fS5OiM+oz6RhAVhDdYaYGncr6NwulCbzrJ4qcXSFy6Q=';
  const vecEpk =
      'BP57SyNEf7gLfCgl/QD3QLfTDaEadnlF2jLuSWu0IrxojjZUYTL6fxiA9NQxeUNvpBmmX+DCweBLSoU2ztHP5/I=';
  const vecIv = '40tdTI2ae5YdP6KI';
  const vecW = 'mvi3AKP+384KS7y19FCdHA0OgVwQ1s+5UaaCQXd42WyqBLa3xQJx2VHEVhZ+fZ28';
  const vecWiv = 'BlBKVeruduizXwe2';
  const vecExpected = 'hello clipsync 端到端加密测试 ✨';

  /// 用向量信封原文构造协议信封（ciphertext 用向量文件的字段名 ciphertextB64，
  /// 同时覆盖 decrypt 的兼容字段解析路径——与 Rust 对拍用例同构）。
  Map<String, dynamic> vectorEnvelope() => {
        'v': 1,
        'alg': 'ECDH-P256+HKDF-SHA256+A256GCM',
        'epk': vecEpk,
        'iv': vecIv,
        'keys': {
          vecDeviceId: {'w': vecW, 'iv': vecWiv},
        },
        'ciphertextB64': vecCiphertext,
      };

  group('B8 E2E 加密 — 协议 §8 标准向量对拍', () {
    test('fixture 私钥解密信封 → expectedPlaintext', () async {
      final kp = e2eKeypairFromSeed(base64Decode(vecRecipientPriv));
      // 健全性：fixture 私钥派生的公钥必须与 fixture 公钥一致
      expect(kp.publicKeyB64, vecRecipientPub);

      final plaintext =
          await e2eDecrypt(vectorEnvelope(), vecDeviceId, kp.privateKey);
      expect(utf8.decode(plaintext), vecExpected,
          reason: '解密结果与 expectedPlaintext 不一致');
    });

    test('兼容字段：密文改用 content_encrypted 字段名同样可解', () async {
      final kp = e2eKeypairFromSeed(base64Decode(vecRecipientPriv));
      final envelope = vectorEnvelope()
        ..remove('ciphertextB64')
        ..['content_encrypted'] = vecCiphertext;
      final plaintext = await e2eDecrypt(envelope, vecDeviceId, kp.privateKey);
      expect(utf8.decode(plaintext), vecExpected);
    });

    test('反向往返：fixture 公钥加密 → fixture 私钥解密 + 信封结构校验', () async {
      final kp = e2eKeypairFromSeed(base64Decode(vecRecipientPriv));
      final envelope = await e2eEncrypt(
        utf8.encode(vecExpected),
        {vecDeviceId: vecRecipientPub},
      );

      // 信封结构（协议 §2 + ciphertext 字段）
      expect(envelope['v'], 1);
      expect(envelope['alg'], 'ECDH-P256+HKDF-SHA256+A256GCM');
      final epk = base64Decode(envelope['epk'] as String);
      expect(epk.length, 65, reason: 'epk 应为 65B 未压缩点');
      expect(epk[0], 0x04);
      final wiv = base64Decode(
          ((envelope['keys'] as Map)[vecDeviceId] as Map)['iv'] as String);
      expect(wiv.length, 12, reason: '包装 IV 应为 12B');
      final w = base64Decode(
          ((envelope['keys'] as Map)[vecDeviceId] as Map)['w'] as String);
      expect(w.length, 48, reason: 'wrappedKey 应为 32B K + 16B tag = 48B');
      expect(envelope.containsKey('ciphertext'), isTrue);
      final iv = base64Decode(envelope['iv'] as String);
      expect(iv.length, 12, reason: '内容 IV 应为 12B');

      final plaintext = await e2eDecrypt(envelope, vecDeviceId, kp.privateKey);
      expect(utf8.decode(plaintext), vecExpected);
    });
  });

  group('B8 E2E 加密 — 自往返与多接收方', () {
    test('随机密钥对自往返（含多字节 UTF-8 / 二进制边界 / 空内容）', () async {
      final kp = e2eGenerateKeypair();
      expect(kp.publicKey.length, 65);
      expect(kp.publicKey[0], 0x04);

      final contents = <Uint8List>[
        Uint8List.fromList(
            [...utf8.encode('clip content 123 🔒 中文'), 0x00, 0xFF, 0xFE]),
        Uint8List(0), // 空内容
        Uint8List.fromList(List<int>.generate(64 * 1024, (i) => i % 256)), // 64KB
      ];
      for (final content in contents) {
        final envelope = await e2eEncrypt(content, {'self-device': kp.publicKeyB64});
        final decrypted = await e2eDecrypt(envelope, 'self-device', kp.privateKey);
        expect(decrypted, content, reason: '自往返内容不一致');
      }
    });

    test('多接收方：每台设备用自己的私钥都能解密', () async {
      final alice = e2eGenerateKeypair();
      final bob = e2eGenerateKeypair();
      final content = utf8.encode('multi-recipient 内容');

      final envelope = await e2eEncrypt(content, {
        'alice-device': alice.publicKeyB64,
        'bob-device': bob.publicKeyB64,
      });

      expect(utf8.decode(await e2eDecrypt(envelope, 'alice-device', alice.privateKey)),
          utf8.decode(content));
      expect(utf8.decode(await e2eDecrypt(envelope, 'bob-device', bob.privateKey)),
          utf8.decode(content));
    });

    test('随机性：同一内容两次加密的信封（epk/iv/w/ciphertext）必须不同', () async {
      final kp = e2eGenerateKeypair();
      final recipients = {'d1': kp.publicKeyB64};
      final env1 = await e2eEncrypt(utf8.encode('same'), recipients);
      final env2 = await e2eEncrypt(utf8.encode('same'), recipients);
      expect(env1['epk'], isNot(env2['epk']));
      expect(env1['iv'], isNot(env2['iv']));
      expect(env1['ciphertext'], isNot(env2['ciphertext']));
      expect(((env1['keys'] as Map)['d1'] as Map)['w'],
          isNot(((env2['keys'] as Map)['d1'] as Map)['w']));
    });
  });

  group('B8 E2E 加密 — 异常路径', () {
    test('本设备不在信封 keys 列表 → 抛 E2eCryptoException', () async {
      final kp = e2eGenerateKeypair();
      final other = e2eGenerateKeypair();
      final envelope = await e2eEncrypt(
        utf8.encode('secret'),
        {'other-device': other.publicKeyB64},
      );
      expect(
        () => e2eDecrypt(envelope, 'not-in-keys', kp.privateKey),
        throwsA(isA<E2eCryptoException>().having(
          (e) => e.message, 'message', contains('不在信封 keys'))),
      );
    });

    test('deviceId 在 keys 中但私钥不匹配 → 解包失败', () async {
      final wrong = e2eGenerateKeypair();
      final other = e2eGenerateKeypair();
      final envelope = await e2eEncrypt(
        utf8.encode('secret'),
        {'other-device': other.publicKeyB64},
      );
      expect(
        () => e2eDecrypt(envelope, 'other-device', wrong.privateKey),
        throwsA(isA<E2eCryptoException>().having(
            (e) => e.message, 'message', contains('AES-GCM 解密失败'))),
      );
    });

    test('密文被篡改（ciphertext/tag 翻转一字节）→ 解密失败', () async {
      final kp = e2eGenerateKeypair();
      final envelope = await e2eEncrypt(utf8.encode('tamper-me'), {
        'self-device': kp.publicKeyB64,
      });
      final ct = base64Decode(envelope['ciphertext'] as String);
      ct[ct.length - 1] ^= 0x01; // 翻转 tag 最后一比特
      final tampered = Map<String, dynamic>.from(envelope)
        ..['ciphertext'] = base64Encode(ct);
      expect(
        () => e2eDecrypt(tampered, 'self-device', kp.privateKey),
        throwsA(isA<E2eCryptoException>()),
      );
    });

    test('信封缺少必填字段（epk/iv/keys）→ 抛 E2eCryptoException', () async {
      final kp = e2eGenerateKeypair();
      for (final field in ['epk', 'iv', 'keys']) {
        final envelope = vectorEnvelope()..remove(field);
        expect(
          () => e2eDecrypt(envelope, vecDeviceId, kp.privateKey),
          throwsA(isA<E2eCryptoException>()),
          reason: '缺少 $field 时应显式报错',
        );
      }
    });

    test('接收方公钥非法（长度错误 / 非 0x04 开头 / 不在曲线上）→ 抛 E2eCryptoException', () async {
      final b64Of = (List<int> bytes) => base64Encode(bytes);
      final invalidKeys = <String, String>{
        '长度 64B': b64Of(List<int>.filled(64, 0x04)),
        '非 0x04 开头': b64Of(List<int>.filled(65, 0x02)),
        '不在曲线上': b64Of([0x04, ...List<int>.filled(64, 0xAA)]),
        '非法 base64': 'not-base64!!',
      };
      for (final entry in invalidKeys.entries) {
        expect(
          () => e2eEncrypt(utf8.encode('x'), {'d1': entry.value}),
          throwsA(isA<E2eCryptoException>()),
          reason: '${entry.key} 的公钥应被拒绝',
        );
      }
    });

    test('空接收方 / 超过 32 个接收方 → 抛 E2eCryptoException', () async {
      expect(
        () => e2eEncrypt(utf8.encode('x'), const {}),
        throwsA(isA<E2eCryptoException>().having(
            (e) => e.message, 'message', contains('recipients 为空'))),
      );

      // 33 个接收方（公钥合法性按 key 校验，可复用同一合法公钥）
      final tooMany = <String, String>{
        for (var i = 0; i < 33; i++) 'device-$i': vecRecipientPub,
      };
      expect(
        () => e2eEncrypt(utf8.encode('x'), tooMany),
        throwsA(isA<E2eCryptoException>().having(
            (e) => e.message, 'message', contains('上限 32'))),
      );
    });

    test('deviceId 为空 / 空白 → 抛 E2eCryptoException', () async {
      final kp = e2eGenerateKeypair();
      expect(
        () => e2eEncrypt(utf8.encode('x'), {'  ': kp.publicKeyB64}),
        throwsA(isA<E2eCryptoException>()),
      );
    });

    test('私钥长度非法（非 32B）→ 抛 E2eCryptoException', () async {
      final kp = e2eGenerateKeypair();
      final envelope = await e2eEncrypt(utf8.encode('x'), {'d': kp.publicKeyB64});
      expect(
        () => e2eDecrypt(envelope, 'd', Uint8List(31)),
        throwsA(isA<E2eCryptoException>().having(
            (e) => e.message, 'message', contains('私钥长度非法'))),
      );
    });
  });
}
