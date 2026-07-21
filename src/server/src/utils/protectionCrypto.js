import crypto from 'crypto';
import { logger } from './logger.js';

/**
 * Unified Protection Level System - Crypto Utilities
 * 
 * Implements DEK (Data Encryption Key) dual encryption:
 * - Content is encrypted with a random DEK (AES-256-GCM)
 * - DEK is wrapped with user password (PBKDF2)
 * - DEK is also wrapped with recovery key (PBKDF2)
 * - Both wrapped DEKs are stored on server
 * - Server never sees plaintext or raw DEK
 */

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const DEK_LENGTH = 32; // AES-256 requires 32 bytes
const RECOVERY_KEY_LENGTH = 64; // 64 random bytes = 128 hex chars

/**
 * Generate a random salt for key derivation
 */
export function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH).toString('base64');
}

/**
 * Generate a random IV for AES-GCM
 */
export function generateIV() {
  return crypto.randomBytes(IV_LENGTH).toString('base64');
}

/**
 * Derive a key from password using PBKDF2
 * @param {string} password - User password
 * @param {string} salt - Salt in base64
 * @returns {Buffer} Derived key (32 bytes)
 */
export function deriveKeyFromPassword(password, salt) {
  const saltBuffer = Buffer.from(salt, 'base64');
  return crypto.pbkdf2Sync(password, saltBuffer, PBKDF2_ITERATIONS, DEK_LENGTH, 'sha512');
}

/**
 * Generate a random Data Encryption Key (DEK)
 */
export function generateDEK() {
  return crypto.randomBytes(DEK_LENGTH);
}

/**
 * Wrap DEK with password (encrypt DEK with password-derived key)
 * @param {Buffer} dek - Data Encryption Key
 * @param {string} password - User password
 * @param {string} salt - Salt in base64
 * @returns {string} Wrapped DEK (base64 encoded)
 */
export function wrapDEKWithPassword(dek, password, salt) {
  const key = deriveKeyFromPassword(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:encryptedDEK (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Unwrap DEK with password (decrypt DEK with password-derived key)
 * @param {string} wrappedDEK - Wrapped DEK (base64 encoded)
 * @param {string} password - User password
 * @param {string} salt - Salt in base64
 * @returns {Buffer|null} Decrypted DEK or null if password is wrong
 */
export function unwrapDEKWithPassword(wrappedDEK, password, salt) {
  try {
    const [ivB64, authTagB64, encryptedB64] = wrappedDEK.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const encrypted = Buffer.from(encryptedB64, 'base64');
    
    const key = deriveKeyFromPassword(password, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (err) {
    // Password is wrong or data is corrupted
    logger.warn('Failed to unwrap DEK with password:', err.message);
    return null;
  }
}

/**
 * Wrap DEK with recovery key (encrypt DEK with recovery-key-derived key)
 * @param {Buffer} dek - Data Encryption Key
 * @param {string} recoveryKey - Recovery key (hex string)
 * @param {string} salt - Salt in base64
 * @returns {string} Wrapped DEK (base64 encoded)
 */
export function wrapDEKWithRecoveryKey(dek, recoveryKey, salt) {
  const key = deriveKeyFromPassword(recoveryKey, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:encryptedDEK (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Unwrap DEK with recovery key (decrypt DEK with recovery-key-derived key)
 * @param {string} wrappedDEK - Wrapped DEK (base64 encoded)
 * @param {string} recoveryKey - Recovery key (hex string)
 * @param {string} salt - Salt in base64
 * @returns {Buffer|null} Decrypted DEK or null if recovery key is wrong
 */
export function unwrapDEKWithRecoveryKey(wrappedDEK, recoveryKey, salt) {
  try {
    const [ivB64, authTagB64, encryptedB64] = wrappedDEK.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const encrypted = Buffer.from(encryptedB64, 'base64');
    
    const key = deriveKeyFromPassword(recoveryKey, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (err) {
    logger.warn('Failed to unwrap DEK with recovery key:', err.message);
    return null;
  }
}

/**
 * Encrypt content with DEK
 * @param {string} plaintext - Content to encrypt
 * @param {Buffer} dek - Data Encryption Key
 * @returns {{ ciphertext: string, iv: string, authTag: string }}
 */
export function encryptWithDEK(plaintext, dek) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

/**
 * Decrypt content with DEK
 * @param {string} ciphertext - Encrypted content (base64)
 * @param {Buffer} dek - Data Encryption Key
 * @param {string} iv - Initialization vector (base64)
 * @param {string} authTag - Authentication tag (base64)
 * @returns {string|null} Decrypted plaintext or null if decryption fails
 */
export function decryptWithDEK(ciphertext, dek, iv, authTag) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      dek,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final()
    ]);
    
    return decrypted.toString('utf8');
  } catch (err) {
    logger.warn('Failed to decrypt with DEK:', err.message);
    return null;
  }
}

/**
 * Generate a recovery key (128 hex characters = 64 bytes)
 * @returns {string} Recovery key (hex string)
 */
export function generateRecoveryKey() {
  return crypto.randomBytes(RECOVERY_KEY_LENGTH).toString('hex');
}

/**
 * Hash recovery key for storage
 * @param {string} recoveryKey - Recovery key (hex string)
 * @returns {string} SHA-256 hash (hex string)
 */
export function hashRecoveryKey(recoveryKey) {
  return crypto.createHash('sha256').update(recoveryKey, 'hex').digest('hex');
}

/**
 * Verify recovery key against hash
 * @param {string} recoveryKey - Recovery key (hex string)
 * @param {string} hash - Stored hash (hex string)
 * @returns {boolean} True if recovery key matches
 */
export function verifyRecoveryKey(recoveryKey, hash) {
  const computedHash = hashRecoveryKey(recoveryKey);
  return crypto.timingSafeEqual(
    Buffer.from(computedHash, 'hex'),
    Buffer.from(hash, 'hex')
  );
}

/**
 * Complete protection setup: generate DEK, wrap with password and recovery key
 * @param {string} plaintext - Content to protect
 * @param {string} password - User password
 * @returns {Object} Protection data to store
 */
export function setupAdvancedProtection(plaintext, password) {
  // Generate DEK and salt
  const dek = generateDEK();
  const salt = generateSalt();
  
  // Wrap DEK with password
  const wrappedDEKPassword = wrapDEKWithPassword(dek, password, salt);
  
  // Generate recovery key and wrap DEK with it
  const recoveryKey = generateRecoveryKey();
  const wrappedDEKRecovery = wrapDEKWithRecoveryKey(dek, recoveryKey, salt);
  
  // Encrypt content with DEK
  const { ciphertext, iv, authTag } = encryptWithDEK(plaintext, dek);
  
  // Hash recovery key for verification
  const recoveryKeyHash = hashRecoveryKey(recoveryKey);
  
  return {
    encryptedContent: `${iv}:${authTag}:${ciphertext}`, // Encrypted content format
    wrappedDEKPassword,
    wrappedDEKRecovery,
    recoveryKey, // Return this to user - MUST be saved!
    recoveryKeyHash,
    salt,
    iv
  };
}

/**
 * Unlock with password: unwrap DEK and decrypt content
 * @param {string} encryptedContent - Encrypted content (iv:authTag:ciphertext)
 * @param {string} wrappedDEKPassword - Wrapped DEK (password)
 * @param {string} password - User password
 * @param {string} salt - Salt
 * @param {string} iv - IV for content encryption
 * @returns {string|null} Decrypted content or null if password is wrong
 */
export function unlockWithPassword(encryptedContent, wrappedDEKPassword, password, salt) {
  // Unwrap DEK with password
  const dek = unwrapDEKWithPassword(wrappedDEKPassword, password, salt);
  if (!dek) return null;
  
  // Parse encrypted content
  const [contentIV, authTag, ciphertext] = encryptedContent.split(':');
  
  // Decrypt content with DEK
  return decryptWithDEK(ciphertext, dek, contentIV, authTag);
}

/**
 * Unlock with recovery key: unwrap DEK and decrypt content
 * @param {string} encryptedContent - Encrypted content (iv:authTag:ciphertext)
 * @param {string} wrappedDEKRecovery - Wrapped DEK (recovery key)
 * @param {string} recoveryKey - Recovery key
 * @param {string} salt - Salt
 * @returns {string|null} Decrypted content or null if recovery key is wrong
 */
export function unlockWithRecoveryKey(encryptedContent, wrappedDEKRecovery, recoveryKey, salt) {
  // Unwrap DEK with recovery key
  const dek = unwrapDEKWithRecoveryKey(wrappedDEKRecovery, recoveryKey, salt);
  if (!dek) return null;
  
  // Parse encrypted content
  const [contentIV, authTag, ciphertext] = encryptedContent.split(':');
  
  // Decrypt content with DEK
  return decryptWithDEK(ciphertext, dek, contentIV, authTag);
}

/**
 * Rotate password: re-wrap DEK with new password
 * @param {string} wrappedDEKPassword - Current wrapped DEK
 * @param {string} oldPassword - Current password
 * @param {string} newPassword - New password
 * @param {string} salt - Current salt
 * @returns {{ newWrappedDEK: string, newSalt: string }|null}
 */
export function rotatePassword(wrappedDEKPassword, oldPassword, newPassword, salt) {
  // Unwrap DEK with old password
  const dek = unwrapDEKWithPassword(wrappedDEKPassword, oldPassword, salt);
  if (!dek) return null;
  
  // Generate new salt and wrap DEK with new password
  const newSalt = generateSalt();
  const newWrappedDEK = wrapDEKWithPassword(dek, newPassword, newSalt);
  
  return {
    newWrappedDEK,
    newSalt
  };
}
