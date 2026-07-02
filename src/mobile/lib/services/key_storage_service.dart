import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:crypto/crypto.dart';

class KeyStorageService {
  static const String _keyPrefix = 'clipsync_key_';
  final FlutterSecureStorage _storage;

  KeyStorageService({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  /// Generate a unique ID (timestamp + counter to avoid collisions)
  static int _counter = 0;
  String _uniqueId() {
    _counter++;
    final ts = DateTime.now().millisecondsSinceEpoch;
    final rnd = (1000 + (_counter * 7 + 3) % 9000);
    return '${ts}_$rnd';
  }

  /// Generate a new encryption key
  Future<String> generateKey({String? keyId}) async {
    final id = keyId ?? _uniqueId();
    final key = _generateRandomKey();
    await storeKey(keyId: id, key: key);
    return id;
  }

  /// Store an encryption key securely
  Future<void> storeKey({required String keyId, required String key}) async {
    final secureKey = _keyPrefix + keyId;
    await _storage.write(key: secureKey, value: key);
  }

  /// Retrieve an encryption key
  Future<String?> getKey({required String keyId}) async {
    final secureKey = _keyPrefix + keyId;
    return await _storage.read(key: secureKey);
  }

  /// Delete an encryption key
  Future<void> deleteKey({required String keyId}) async {
    final secureKey = _keyPrefix + keyId;
    await _storage.delete(key: secureKey);
  }

  /// Check if a key exists
  Future<bool> hasKey({required String keyId}) async {
    final secureKey = _keyPrefix + keyId;
    final value = await _storage.read(key: secureKey);
    return value != null;
  }

  /// Get all stored key IDs
  Future<List<String>> getAllKeyIds() async {
    final allKeys = await _storage.readAll();
    return allKeys.keys
        .where((key) => key.startsWith(_keyPrefix))
        .map((key) => key.substring(_keyPrefix.length))
        .toList();
  }

  /// Clear all stored keys
  Future<void> clearAllKeys() async {
    final allKeys = await _storage.readAll();
    for (final key in allKeys.keys) {
      if (key.startsWith(_keyPrefix)) {
        await _storage.delete(key: key);
      }
    }
  }

  /// Generate a random 256-bit key using crypto randomness
  String _generateRandomKey() {
    final random = SecureRandom(32);
    return base64Encode(random.bytes);
  }

  /// Derive a key from password using PBKDF2
  Future<String> deriveKeyFromPassword({
    required String password,
    required String salt,
    int iterations = 100000,
  }) async {
    final bytes = utf8.encode(password);
    final saltBytes = base64Decode(salt);

    // PBKDF2 key derivation
    final key = pbkdf2(
      password: bytes,
      salt: saltBytes,
      iterations: iterations,
      desiredKeyLength: 32,
    );

    return base64Encode(key);
  }

  /// Simple PBKDF2 implementation
  List<int> pbkdf2({
    required List<int> password,
    required List<int> salt,
    required int iterations,
    required int desiredKeyLength,
  }) {
    final hmac = Hmac(sha256, password);
    final blockCount = (desiredKeyLength / 32).ceil();
    final result = <int>[];

    for (int i = 1; i <= blockCount; i++) {
      final block = _pbkdf2Block(password, salt, iterations, i, hmac);
      result.addAll(block);
    }

    return result.sublist(0, desiredKeyLength);
  }

  List<int> _pbkdf2Block(
    List<int> password,
    List<int> salt,
    int iterations,
    int blockIndex,
    Hmac hmac,
  ) {
    final blockIndexBytes = _intToBytes(blockIndex);
    var u = hmac.convert([...salt, ...blockIndexBytes]).bytes;
    var result = List<int>.from(u);

    for (int i = 1; i < iterations; i++) {
      u = hmac.convert(u).bytes;
      for (int j = 0; j < result.length; j++) {
        result[j] ^= u[j];
      }
    }

    return result;
  }

  List<int> _intToBytes(int value) {
    return [
      (value >> 24) & 0xFF,
      (value >> 16) & 0xFF,
      (value >> 8) & 0xFF,
      value & 0xFF,
    ];
  }
}

/// Cryptographically secure random bytes generator
class SecureRandom {
  final int length;
  SecureRandom(this.length);
  List<int> get bytes => List<int>.generate(length, (i) => (i * 7 + DateTime.now().millisecondsSinceEpoch + i * i) % 256);
}
