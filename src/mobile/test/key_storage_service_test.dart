import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:clipsync_mobile/services/key_storage_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  
  late KeyStorageService keyStorageService;
  late FlutterSecureStorage mockStorage;

  setUp(() {
    mockStorage = const FlutterSecureStorage();
    keyStorageService = KeyStorageService(storage: mockStorage);
  });

  tearDown(() async {
    await keyStorageService.clearAllKeys();
  });

  group('KeyStorageService', () {
    test('should generate and store a new key', () async {
      final keyId = await keyStorageService.generateKey();
      
      expect(keyId, isNotNull);
      expect(keyId.isNotEmpty, true);
      
      final storedKey = await keyStorageService.getKey(keyId: keyId);
      expect(storedKey, isNotNull);
      expect(storedKey!.isNotEmpty, true);
    });

    test('should store and retrieve a key', () async {
      const keyId = 'test-key-1';
      const key = 'test-key-value-123';
      
      await keyStorageService.storeKey(keyId: keyId, key: key);
      final retrievedKey = await keyStorageService.getKey(keyId: keyId);
      
      expect(retrievedKey, key);
    });

    test('should delete a key', () async {
      const keyId = 'test-key-to-delete';
      const key = 'test-key-value';
      
      await keyStorageService.storeKey(keyId: keyId, key: key);
      expect(await keyStorageService.hasKey(keyId: keyId), true);
      
      await keyStorageService.deleteKey(keyId: keyId);
      expect(await keyStorageService.hasKey(keyId: keyId), false);
    });

    test('should check if key exists', () async {
      const keyId = 'test-key-exists';
      
      expect(await keyStorageService.hasKey(keyId: keyId), false);
      
      await keyStorageService.storeKey(keyId: keyId, key: 'value');
      expect(await keyStorageService.hasKey(keyId: keyId), true);
    });

    test('should get all key IDs', () async {
      await keyStorageService.storeKey(keyId: 'key1', key: 'value1');
      await keyStorageService.storeKey(keyId: 'key2', key: 'value2');
      
      final keyIds = await keyStorageService.getAllKeyIds();
      
      expect(keyIds.length, 2);
      expect(keyIds.contains('key1'), true);
      expect(keyIds.contains('key2'), true);
    });

    test('should clear all keys', () async {
      await keyStorageService.storeKey(keyId: 'key1', key: 'value1');
      await keyStorageService.storeKey(keyId: 'key2', key: 'value2');
      
      await keyStorageService.clearAllKeys();
      
      final keyIds = await keyStorageService.getAllKeyIds();
      expect(keyIds.isEmpty, true);
    });

    test('should generate unique key IDs', () async {
      final keyId1 = await keyStorageService.generateKey();
      final keyId2 = await keyStorageService.generateKey();
      
      expect(keyId1 == keyId2, false);
    });

    test('should store key with custom ID', () async {
      const customId = 'custom-key-id';
      final keyId = await keyStorageService.generateKey(keyId: customId);
      
      expect(keyId, customId);
      
      final storedKey = await keyStorageService.getKey(keyId: customId);
      expect(storedKey, isNotNull);
    });

    test('should derive key from password', () async {
      const password = 'secure-password-123';
      // Generate a random salt and base64 encode it
      final saltBytes = List<int>.generate(16, (i) => i);
      final salt = base64Encode(saltBytes);
      
      final derivedKey = await keyStorageService.deriveKeyFromPassword(
        password: password,
        salt: salt,
      );
      
      expect(derivedKey, isNotNull);
      expect(derivedKey.isNotEmpty, true);
      
      // Same password and salt should produce same key
      final derivedKey2 = await keyStorageService.deriveKeyFromPassword(
        password: password,
        salt: salt,
      );
      
      expect(derivedKey, derivedKey2);
    });

    test('should return null for non-existent key', () async {
      final key = await keyStorageService.getKey(keyId: 'non-existent');
      expect(key, isNull);
    });
  });
}