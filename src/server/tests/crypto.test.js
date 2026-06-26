import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  computeSharedSecret,
  deriveKey,
  generateSalt,
  generateIV,
  encrypt,
  decrypt,
  encryptData,
  decryptData,
  DeviceKeyManager,
} from '../src/crypto/keyExchange.js';

describe('Crypto / Key Exchange', () => {
  describe('generateKeyPair', () => {
    it('should generate a valid ECDH key pair', async () => {
      const keyPair = await generateKeyPair();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(typeof keyPair.publicKey).toBe('string');
      expect(typeof keyPair.privateKey).toBe('string');
      expect(keyPair.publicKey).toContain('BEGIN PUBLIC KEY');
      expect(keyPair.privateKey).toContain('BEGIN PRIVATE KEY');
    });

    it('should generate unique key pairs', async () => {
      const kp1 = await generateKeyPair();
      const kp2 = await generateKeyPair();
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
    });
  });

  describe('computeSharedSecret', () => {
    it('should compute same shared secret from both sides', async () => {
      const alice = await generateKeyPair();
      const bob = await generateKeyPair();

      const sharedAlice = computeSharedSecret(alice.privateKey, bob.publicKey);
      const sharedBob = computeSharedSecret(bob.privateKey, alice.publicKey);

      expect(sharedAlice.equals(sharedBob)).toBe(true);
      expect(sharedAlice.length).toBeGreaterThan(0);
    });

    it('should produce different secrets for different pairs', async () => {
      const alice = await generateKeyPair();
      const bob = await generateKeyPair();
      const carol = await generateKeyPair();

      const secretAB = computeSharedSecret(alice.privateKey, bob.publicKey);
      const secretAC = computeSharedSecret(alice.privateKey, carol.publicKey);

      expect(secretAB.equals(secretAC)).toBe(false);
    });
  });

  describe('deriveKey', () => {
    it('should derive a 32-byte key from shared secret', async () => {
      const alice = await generateKeyPair();
      const bob = await generateKeyPair();
      const sharedSecret = computeSharedSecret(alice.privateKey, bob.publicKey);
      const salt = generateSalt();

      const key = await deriveKey(sharedSecret, salt);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should derive different keys with different salts', async () => {
      const alice = await generateKeyPair();
      const bob = await generateKeyPair();
      const sharedSecret = computeSharedSecret(alice.privateKey, bob.publicKey);

      const salt1 = generateSalt();
      const salt2 = generateSalt();

      const key1 = await deriveKey(sharedSecret, salt1);
      const key2 = await deriveKey(sharedSecret, salt2);

      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('encryptData / decryptData', () => {
    it('should encrypt and decrypt text correctly', () => {
      const key = Buffer.alloc(32, 1);
      const plaintext = 'Hello ClipSync! 这是测试文本';

      const encrypted = encryptData(plaintext, key);
      expect(encrypted.encrypted).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.authTag).toBeDefined();

      const decrypted = decryptData(encrypted.encrypted, key, encrypted.iv, encrypted.authTag);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for same plaintext', () => {
      const key = Buffer.alloc(32, 1);
      const plaintext = 'Same text';

      const enc1 = encryptData(plaintext, key);
      const enc2 = encryptData(plaintext, key);

      expect(enc1.encrypted).not.toBe(enc2.encrypted);
      expect(enc1.iv).not.toBe(enc2.iv);
    });

    it('should fail to decrypt with wrong key', () => {
      const key1 = Buffer.alloc(32, 1);
      const key2 = Buffer.alloc(32, 2);
      const plaintext = 'Secret data';

      const encrypted = encryptData(plaintext, key1);

      expect(() => {
        decryptData(encrypted.encrypted, key2, encrypted.iv, encrypted.authTag);
      }).toThrow();
    });

    it('should handle empty string', () => {
      const key = Buffer.alloc(32, 1);
      const plaintext = '';

      const encrypted = encryptData(plaintext, key);
      const decrypted = decryptData(encrypted.encrypted, key, encrypted.iv, encrypted.authTag);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle long text', () => {
      const key = Buffer.alloc(32, 1);
      const plaintext = 'A'.repeat(100000);

      const encrypted = encryptData(plaintext, key);
      const decrypted = decryptData(encrypted.encrypted, key, encrypted.iv, encrypted.authTag);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('Low-level encrypt/decrypt', () => {
    it('should encrypt and decrypt buffer data', () => {
      const key = Buffer.alloc(32, 42);
      const iv = generateIV();
      const plaintext = Buffer.from('Binary data');

      const { ciphertext, authTag } = encrypt(plaintext, key, iv);
      const decrypted = decrypt(ciphertext, key, iv, authTag);

      expect(decrypted.equals(plaintext)).toBe(true);
    });
  });

  describe('generateIV', () => {
    it('should generate a 12-byte IV (AES-GCM)', () => {
      const iv = generateIV();
      expect(iv).toBeInstanceOf(Buffer);
      expect(iv.length).toBe(12);
    });

    it('should generate unique IVs', () => {
      const iv1 = generateIV();
      const iv2 = generateIV();
      expect(iv1.equals(iv2)).toBe(false);
    });
  });

  describe('generateSalt', () => {
    it('should generate a 16-byte salt', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(16);
    });

    it('should generate unique salts', () => {
      const s1 = generateSalt();
      const s2 = generateSalt();
      expect(s1.equals(s2)).toBe(false);
    });
  });

  describe('DeviceKeyManager', () => {
    it('should generate and manage device keys', async () => {
      const manager = new DeviceKeyManager();

      const keys1 = await manager.generateDeviceKeys('device-1');
      const keys2 = await manager.generateDeviceKeys('device-2');

      expect(keys1.publicKey).toBeDefined();
      expect(keys2.publicKey).toBeDefined();

      expect(manager.getPublicKey('device-1')).toBe(keys1.publicKey);
      expect(manager.getPublicKey('device-2')).toBe(keys2.publicKey);
      expect(manager.getPublicKey('device-3')).toBeNull();
    });

    it('should compute shared key between devices', async () => {
      const manager = new DeviceKeyManager();
      await manager.generateDeviceKeys('device-1');
      await manager.generateDeviceKeys('device-2');

      const sharedKey = manager.computeSharedKey('device-1', 'device-2');
      expect(sharedKey).toBeInstanceOf(Buffer);
      expect(sharedKey.length).toBeGreaterThan(0);

      // Reverse direction should produce same key
      const sharedKeyReverse = manager.computeSharedKey('device-2', 'device-1');
      expect(sharedKey.equals(sharedKeyReverse)).toBe(true);
    });

    it('should encrypt and decrypt between devices', async () => {
      const manager = new DeviceKeyManager();
      await manager.generateDeviceKeys('device-1');
      await manager.generateDeviceKeys('device-2');

      const plaintext = 'Encrypted message between devices';
      const encrypted = manager.encryptForDevice(plaintext, 'device-1', 'device-2');

      expect(encrypted).not.toBeNull();
      expect(encrypted.encrypted).toBeDefined();

      const decrypted = manager.decryptFromDevice(encrypted, 'device-2', 'device-1');
      expect(decrypted).toBe(plaintext);
    });

    it('should return null for unknown devices', async () => {
      const manager = new DeviceKeyManager();
      expect(manager.computeSharedKey('unknown-1', 'unknown-2')).toBeNull();
      expect(manager.encryptForDevice('test', 'unknown-1', 'unknown-2')).toBeNull();
    });
  });
});
