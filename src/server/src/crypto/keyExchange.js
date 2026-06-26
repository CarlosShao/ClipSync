import crypto from 'crypto';
import { promisify } from 'util';

const generateKeyPairAsync = promisify(crypto.generateKeyPair);

/**
 * ECDH Key Exchange for ClipSync
 * 
 * 流程：
 * 1. 客户端生成 ECDH 密钥对
 * 2. 客户端发送公钥到服务器
 * 3. 服务器存储公钥
 * 4. 两个客户端通过对方公钥计算共享密钥
 * 5. 从共享密钥派生加密密钥
 */

const CURVE = 'prime256v1'; // NIST P-256
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128 bits for AES-GCM
const SALT_LENGTH = 16; // 128 bits for PBKDF2
const PBKDF2_ITERATIONS = 100000;

/**
 * 生成 ECDH 密钥对
 * @returns {Promise<{publicKey: string, privateKey: string}>}
 */
export async function generateKeyPair() {
  const { publicKey, privateKey } = await generateKeyPairAsync('ec', {
    namedCurve: CURVE,
  });

  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/**
 * 从两个公钥计算共享密钥
 * @param {string} privateKey - 本方私钥 (PEM)
 * @param {string} otherPublicKey - 对方公钥 (PEM)
 * @returns {Buffer} 共享密钥
 */
export function computeSharedSecret(privateKey, otherPublicKey) {
  // Use crypto.diffieHellman which correctly handles ECDH key exchange
  return crypto.diffieHellman({
    privateKey: crypto.createPrivateKey(privateKey),
    publicKey: crypto.createPublicKey(otherPublicKey),
  });
}

/**
 * 从共享密钥派生加密密钥 (PBKDF2)
 * @param {Buffer} sharedSecret - 共享密钥
 * @param {Buffer} salt - 盐值
 * @returns {Promise<Buffer>} 派生密钥
 */
export async function deriveKey(sharedSecret, salt) {
  const deriveKeyAsync = promisify(crypto.pbkdf2);
  return deriveKeyAsync(sharedSecret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * 生成随机盐值
 * @returns {Buffer}
 */
export function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH);
}

/**
 * 生成随机 IV
 * @returns {Buffer}
 */
export function generateIV() {
  return crypto.randomBytes(IV_LENGTH);
}

/**
 * AES-256-GCM 加密
 * @param {Buffer|string} plaintext - 明文
 * @param {Buffer} key - 256位密钥
 * @param {Buffer} iv - 初始化向量
 * @returns {{ciphertext: Buffer, authTag: Buffer}}
 */
export function encrypt(plaintext, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const plaintextBuffer = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { ciphertext, authTag };
}

/**
 * AES-256-GCM 解密
 * @param {Buffer} ciphertext - 密文
 * @param {Buffer} key - 256位密钥
 * @param {Buffer} iv - 初始化向量
 * @param {Buffer} authTag - 认证标签
 * @returns {Buffer} 明文
 */
export function decrypt(ciphertext, key, iv, authTag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext;
}

/**
 * 完整的加密流程：生成密钥 -> 加密数据
 * @param {string} plaintext - 明文
 * @param {Buffer} key - 加密密钥
 * @returns {{encrypted: string, iv: string, authTag: string, salt: string}}
 */
export function encryptData(plaintext, key) {
  const iv = generateIV();
  const { ciphertext, authTag } = encrypt(plaintext, key, iv);

  return {
    encrypted: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * 完整的解密流程：解密数据
 * @param {string} encrypted - 密文 (base64)
 * @param {Buffer} key - 加密密钥
 * @param {string} iv - 初始化向量 (base64)
 * @param {string} authTag - 认证标签 (base64)
 * @returns {string} 明文
 */
export function decryptData(encrypted, key, iv, authTag) {
  const ciphertext = Buffer.from(encrypted, 'base64');
  const ivBuffer = Buffer.from(iv, 'base64');
  const authTagBuffer = Buffer.from(authTag, 'base64');

  const plaintext = decrypt(ciphertext, key, ivBuffer, authTagBuffer);
  return plaintext.toString('utf8');
}

/**
 * 生成设备密钥对并存储
 * 用于设备间的端到端加密
 */
export class DeviceKeyManager {
  constructor() {
    // 内存存储（生产环境应使用安全存储）
    this.deviceKeys = new Map(); // deviceId -> { publicKey, privateKey }
  }

  /**
   * 为设备生成密钥对
   */
  async generateDeviceKeys(deviceId) {
    const keyPair = await generateKeyPair();
    this.deviceKeys.set(deviceId, keyPair);
    return keyPair;
  }

  /**
   * 获取设备公钥
   */
  getPublicKey(deviceId) {
    const keys = this.deviceKeys.get(deviceId);
    return keys ? keys.publicKey : null;
  }

  /**
   * 获取设备私钥
   */
  getPrivateKey(deviceId) {
    const keys = this.deviceKeys.get(deviceId);
    return keys ? keys.privateKey : null;
  }

  /**
   * 计算两个设备间的共享密钥
   */
  computeSharedKey(deviceId1, deviceId2) {
    const keys1 = this.deviceKeys.get(deviceId1);
    const keys2 = this.deviceKeys.get(deviceId2);

    if (!keys1 || !keys2) {
      return null;
    }

    return computeSharedSecret(keys1.privateKey, keys2.publicKey);
  }

  /**
   * 加密数据（从设备1到设备2）
   */
  encryptForDevice(plaintext, deviceId1, deviceId2) {
    const sharedKey = this.computeSharedKey(deviceId1, deviceId2);
    if (!sharedKey) {
      return null;
    }

    const salt = generateSalt();
    const iv = generateIV();
    const { ciphertext, authTag } = encrypt(plaintext, sharedKey, iv);

    return {
      encrypted: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      salt: salt.toString('base64'),
      senderDeviceId: deviceId1,
    };
  }

  /**
   * 解密数据（从设备2接收）
   */
  decryptFromDevice(encryptedData, deviceId1, deviceId2) {
    const sharedKey = this.computeSharedKey(deviceId1, deviceId2);
    if (!sharedKey) {
      return null;
    }

    const ciphertext = Buffer.from(encryptedData.encrypted, 'base64');
    const iv = Buffer.from(encryptedData.iv, 'base64');
    const authTag = Buffer.from(encryptedData.authTag, 'base64');

    return decrypt(ciphertext, sharedKey, iv, authTag).toString('utf8');
  }
}

// 导出单例
export const keyManager = new DeviceKeyManager();

export default {
  generateKeyPair,
  computeSharedSecret,
  deriveKey,
  generateSalt,
  generateIV,
  encrypt,
  decrypt,
  encryptData,
  decryptData,
  keyManager,
};
