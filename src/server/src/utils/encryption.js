import crypto from 'crypto';
import { logger } from './logger.js';

/**
 * 加密工具类
 *
 * 支持多种加密算法：
 * 1. AES-256-GCM（对称加密）- 用于加密敏感字段
 * 2. RSA-OAEP（非对称加密）- 用于加密 AES 密钥（密钥轮换）
 *
 * 需要配置环境变量：
 * - ENCRYPTION_MASTER_KEY: 主密钥（AES-256 需要 32 字节）
 * - ENCRYPTION_IV: 初始化向量（AES-GCM 需要 12 字节）
 * - RSA_PRIVATE_KEY: RSA 私钥（PEM 格式）
 * - RSA_PUBLIC_KEY: RSA 公钥（PEM 格式）
 */

// Production security check: reject default keys
const DEFAULT_KEYS = ['default_master_key_32b', 'default_iv_12b', 'dev_encryption_key_32chars_min!!'];

function validateEncryptionConfig() {
  const masterKey = process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_MASTER_KEY;
  const iv = process.env.ENCRYPTION_IV;

  if (process.env.NODE_ENV === 'production') {
    if (!masterKey) {
      logger.error('FATAL: ENCRYPTION_KEY environment variable is required in production');
      process.exit(1);
    }

    if (DEFAULT_KEYS.includes(masterKey)) {
      logger.error('FATAL: ENCRYPTION_KEY must not use default value in production');
      process.exit(1);
    }

    if (masterKey.length < 32) {
      logger.error('FATAL: ENCRYPTION_KEY must be at least 32 characters in production');
      process.exit(1);
    }

    if (!iv) {
      logger.warn('ENCRYPTION_IV not set, using derived IV from master key');
    }
  } else {
    if (!masterKey || DEFAULT_KEYS.includes(masterKey)) {
      logger.warn('WARNING: Using default encryption key. Set ENCRYPTION_KEY for production.');
    }
  }
}

// Validate on module load
validateEncryptionConfig();

// 从环境变量获取加密配置（支持 ENCRYPTION_KEY 和 ENCRYPTION_MASTER_KEY）
const MASTER_KEY_RAW = process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_MASTER_KEY || 'default_master_key_32b';
const IV_RAW = process.env.ENCRYPTION_IV || 'default_iv_12b';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256 需要 32 字节
const IV_LENGTH = 12; // AES-GCM 推荐 12 字节
const AUTH_TAG_LENGTH = 16; // AES-GCM 认证标签 16 字节

// 确保密钥长度恰好为 32 字节
function padOrTruncateKey(key, length) {
  const buf = Buffer.alloc(length);
  const keyBuf = Buffer.from(key);
  keyBuf.copy(buf, 0, 0, Math.min(keyBuf.length, length));
  return buf;
}

const MASTER_KEY = padOrTruncateKey(MASTER_KEY_RAW, KEY_LENGTH);
const IV = Buffer.from(IV_RAW).length === IV_LENGTH ? Buffer.from(IV_RAW) : padOrTruncateKey(IV_RAW, IV_LENGTH);

if (Buffer.from(MASTER_KEY_RAW).length !== KEY_LENGTH) {
  logger.warn(`ENCRYPTION_KEY length is not 32 bytes, padding or truncating. Original length: ${Buffer.from(MASTER_KEY_RAW).length}`);
}

if (Buffer.from(IV).length !== IV_LENGTH) {
  logger.warn('ENCRYPTION_IV length is not 12 bytes, padding or truncating');
}

/**
 * 加密数据（AES-256-GCM）
 * @param {string} plaintext - 明文
 * @returns {string} 密文（格式：iv:authTag:ciphertext）
 */
export function encrypt(plaintext) {
  try {
    if (!plaintext) return null;
    
    // 生成随机 IV（每次加密都使用不同的 IV）
    const iv = crypto.randomBytes(IV_LENGTH);
    
    // 创建加密器（MASTER_KEY 已经是 Buffer）
    const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
    
    // 加密
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // 获取认证标签（用于验证密文完整性）
    const authTag = cipher.getAuthTag();
    
    // 组合：iv:authTag:ciphertext
    const combined = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    
    logger.debug('Encryption successful', { plaintextLength: plaintext.length });
    return combined;
  } catch (err) {
    logger.error('Encryption failed:', err);
    throw new Error('Encryption failed');
  }
}

/**
 * 解密数据（AES-256-GCM）
 * @param {string} ciphertext - 密文（格式：iv:authTag:ciphertext）
 * @returns {string} 明文
 */
export function decrypt(ciphertext) {
  try {
    if (!ciphertext) return null;
    
    // 分解：iv:authTag:ciphertext
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    // 创建解密器（MASTER_KEY 已经是 Buffer）
    const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
    decipher.setAuthTag(authTag);
    
    // 解密
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    logger.debug('Decryption successful', { ciphertextLength: ciphertext.length });
    return decrypted;
  } catch (err) {
    logger.error('Decryption failed:', err);
    throw new Error('Decryption failed');
  }
}

/**
 * 加密字段（如果已加密则跳过）
 * @param {string} plaintext - 明文
 * @param {string} existingCiphertext - 已存在的密文（用于避免重复加密）
 * @returns {string} 密文
 */
export function encryptField(plaintext, existingCiphertext = null) {
  // 如果已加密（格式正确），则跳过
  if (existingCiphertext && existingCiphertext.includes(':')) {
    try {
      // 验证是否可以正确解密
      decrypt(existingCiphertext);
      return existingCiphertext; // 已加密且可以正确解密，跳过
    } catch (err) {
      // 解密失败，重新加密
    }
  }
  
  // 加密
  return encrypt(plaintext);
}

/**
 * 解密字段（处理 null 和格式错误）
 * @param {string} ciphertext - 密文
 * @returns {string|null} 明文或 null
 */
export function decryptField(ciphertext) {
  if (!ciphertext) return null;
  
  try {
    return decrypt(ciphertext);
  } catch (err) {
    logger.warn('Failed to decrypt field, returning as-is', { error: err.message });
    return ciphertext; // 解密失败，返回原始值
  }
}

/**
 * 加密对象中的多个字段
 * @param {Object} obj - 对象
 * @param {Array<string>} fields - 需要加密的字段列表
 * @returns {Object} 加密后的对象
 */
export function encryptObject(obj, fields) {
  const encrypted = { ...obj };
  for (const field of fields) {
    if (obj[field]) {
      encrypted[field] = encrypt(obj[field]);
    }
  }
  return encrypted;
}

/**
 * 解密对象中的多个字段
 * @param {Object} obj - 对象
 * @param {Array<string>} fields - 需要解密的字段列表
 * @returns {Object} 解密后的对象
 */
export function decryptObject(obj, fields) {
  const decrypted = { ...obj };
  for (const field of fields) {
    if (obj[field]) {
      try {
        decrypted[field] = decrypt(obj[field]);
      } catch (err) {
        logger.warn(`Failed to decrypt field ${field}`, { error: err.message });
        // 保留原始值
      }
    }
  }
  return decrypted;
}

/**
 * 生成新的 AES 密钥（用于密钥轮换）
 * @returns {Object} { key, iv }
 */
export function generateNewKey() {
  const key = crypto.randomBytes(KEY_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  
  logger.info('New encryption key generated');
  return {
    key: key.toString('hex'),
    iv: iv.toString('hex'),
  };
}

/**
 * 使用 RSA 公钥加密 AES 密钥（用于密钥分发）
 * @param {string} key - AES 密钥（hex 字符串）
 * @param {string} publicKey - RSA 公钥（PEM 格式）
 * @returns {string} 加密后的密钥（base64 字符串）
 */
export function encryptKeyWithRSA(key, publicKey) {
  try {
    const encrypted = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(key, 'hex')
    );
    
    logger.debug('Key encrypted with RSA successfully');
    return encrypted.toString('base64');
  } catch (err) {
    logger.error('RSA key encryption failed:', err);
    throw new Error('Key encryption failed');
  }
}

/**
 * 使用 RSA 私钥解密 AES 密钥（用于密钥检索）
 * @param {string} encryptedKey - 加密后的密钥（base64 字符串）
 * @param {string} privateKey - RSA 私钥（PEM 格式）
 * @returns {string} 解密的 AES 密钥（hex 字符串）
 */
export function decryptKeyWithRSA(encryptedKey, privateKey) {
  try {
    const decrypted = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encryptedKey, 'base64')
    );
    
    logger.debug('Key decrypted with RSA successfully');
    return decrypted.toString('hex');
  } catch (err) {
    logger.error('RSA key decryption failed:', err);
    throw new Error('Key decryption failed');
  }
}

/**
 * 生成 RSA 密钥对（用于初始化）
 * @returns {Object} { privateKey, publicKey }
 */
export function generateRSAKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });
  
  logger.info('RSA key pair generated');
  return { privateKey, publicKey };
}

/**
 * 计算字段的哈希值（用于搜索，不存储明文）
 * @param {string} value - 明文
 * @returns {string} 哈希值（SHA-256）
 */
export function hashField(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 验证字段的哈希值
 * @param {string} value - 明文
 * @param {string} hash - 哈希值
 * @returns {boolean} 是否匹配
 */
export function verifyHash(value, hash) {
  const computedHash = hashField(value);
  return crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(hash, 'hex'));
}

export default {
  encrypt,
  decrypt,
  encryptField,
  decryptField,
  encryptObject,
  decryptObject,
  generateNewKey,
  encryptKeyWithRSA,
  decryptKeyWithRSA,
  generateRSAKeyPair,
  hashField,
  verifyHash,
};
