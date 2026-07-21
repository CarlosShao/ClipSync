import { Router } from 'express';
import pool from '../db/pool.js';
import { isValidUUID } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';
import {
  setupAdvancedProtection,
  unlockWithPassword,
  unlockWithRecoveryKey,
  rotatePassword,
  hashRecoveryKey,
  verifyRecoveryKey,
  wrapDEKWithPassword,
  wrapDEKWithRecoveryKey,
  generateSalt,
  generateRecoveryKey
} from '../utils/protectionCrypto.js';

const router = Router();

// ============================================
// Unified Protection Level API
// ============================================

/**
 * POST /api/protection/setup - Set up protection for an item
 * Body: { itemId, level: 'pin'|'advanced', password?, recoveryKey? }
 * For level 'advanced': generates DEK, wraps with password and recovery key
 * Returns: { success, recoveryKey? (only for advanced level) }
 */
router.post('/setup', apiLimiter, async (req, res) => {
  try {
    const { itemId, level, password } = req.body;

    if (!isValidUUID(itemId)) {
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    if (!['pin', 'advanced'].includes(level)) {
      return res.status(400).json({ error: 'Invalid protection level' });
    }

    // Get the item
    const itemResult = await pool.query(
      'SELECT id, content_encrypted, content_type FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = itemResult.rows[0];

    if (level === 'pin') {
      // PIN protection: just update the protection level
      // Content is already encrypted server-side, PIN just controls UI access
      await pool.query(
        `UPDATE clipboard_items 
         SET protection_level = 'pin'
         WHERE id = $1 AND user_id = $2`,
        [itemId, req.userId]
      );

      res.json({ success: true, level: 'pin' });
    } else if (level === 'advanced') {
      // Advanced protection: DEK dual encryption
      if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
      }

      // Get the plaintext content (from content_encrypted column)
      // Note: In production, this should come from the client, not the database
      // For now, we'll assume the client sends the plaintext
      const { content } = req.body;
      
      if (!content) {
        return res.status(400).json({ error: 'Content is required for advanced protection' });
      }

      // Set up advanced protection
      const protectionData = setupAdvancedProtection(content, password);

      // Update the database
      await pool.query(
        `UPDATE clipboard_items 
         SET protection_level = 'advanced',
             content_encrypted = $1,
             wrapped_dek_password = $2,
             wrapped_dek_recovery = $3,
             protection_salt = $4,
             protection_iv = $5
         WHERE id = $6 AND user_id = $7`,
        [
          protectionData.encryptedContent,
          protectionData.wrappedDEKPassword,
          protectionData.wrappedDEKRecovery,
          protectionData.salt,
          protectionData.iv,
          itemId,
          req.userId
        ]
      );

      // Store recovery key hash
      await pool.query(
        `INSERT INTO recovery_keys (user_id, item_id, recovery_key_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, item_id) DO UPDATE SET recovery_key_hash = $3`,
        [req.userId, itemId, protectionData.recoveryKeyHash]
      );

      // Return recovery key to user (MUST be saved!)
      res.json({
        success: true,
        level: 'advanced',
        recoveryKey: protectionData.recoveryKey // User MUST save this!
      });
    }
  } catch (err) {
    logger.error('Setup protection error:', err);
    res.status(500).json({ error: 'Failed to set up protection' });
  }
});

/**
 * POST /api/protection/unlock - Unlock protected item
 * Body: { itemId, password? }
 * Returns: { success, content? }
 */
router.post('/unlock', apiLimiter, async (req, res) => {
  try {
    const { itemId, password } = req.body;

    if (!isValidUUID(itemId)) {
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Get the item with protection data
    const itemResult = await pool.query(
      `SELECT id, content_encrypted, protection_level, wrapped_dek_password, 
              protection_salt, protection_iv
       FROM clipboard_items 
       WHERE id = $1 AND user_id = $2`,
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = itemResult.rows[0];

    if (item.protection_level === 'none') {
      return res.status(400).json({ error: 'Item is not protected' });
    }

    if (item.protection_level === 'pin') {
      // PIN protection: verify PIN and return content
      // For now, return the encrypted content (client will handle PIN verification)
      res.json({ 
        success: true, 
        level: 'pin',
        content: item.content_encrypted 
      });
    } else if (item.protection_level === 'advanced') {
      // Advanced protection: unlock with password
      if (!item.wrapped_dek_password || !item.protection_salt) {
        return res.status(500).json({ error: 'Protection data missing' });
      }

      const content = unlockWithPassword(
        item.content_encrypted,
        item.wrapped_dek_password,
        password,
        item.protection_salt
      );

      if (content === null) {
        return res.status(401).json({ error: 'Invalid password' });
      }

      res.json({ success: true, level: 'advanced', content });
    }
  } catch (err) {
    logger.error('Unlock error:', err);
    res.status(500).json({ error: 'Failed to unlock item' });
  }
});

/**
 * POST /api/protection/recovery - Unlock with recovery key
 * Body: { itemId, recoveryKey }
 * Returns: { success, content? }
 */
router.post('/recovery', apiLimiter, async (req, res) => {
  try {
    const { itemId, recoveryKey } = req.body;

    if (!isValidUUID(itemId)) {
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    if (!recoveryKey || recoveryKey.length !== 128) {
      return res.status(400).json({ error: 'Invalid recovery key format' });
    }

    // Get the item with protection data
    const itemResult = await pool.query(
      `SELECT id, content_encrypted, protection_level, wrapped_dek_recovery, protection_salt
       FROM clipboard_items 
       WHERE id = $1 AND user_id = $2`,
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = itemResult.rows[0];

    if (item.protection_level !== 'advanced') {
      return res.status(400).json({ error: 'Item does not use advanced protection' });
    }

    if (!item.wrapped_dek_recovery || !item.protection_salt) {
      return res.status(500).json({ error: 'Recovery data missing' });
    }

    // Verify recovery key hash
    const keyResult = await pool.query(
      'SELECT recovery_key_hash FROM recovery_keys WHERE user_id = $1 AND item_id = $2',
      [req.userId, itemId]
    );

    if (keyResult.rows.length === 0 || !verifyRecoveryKey(recoveryKey, keyResult.rows[0].recovery_key_hash)) {
      return res.status(401).json({ error: 'Invalid recovery key' });
    }

    // Unlock with recovery key
    const content = unlockWithRecoveryKey(
      item.content_encrypted,
      item.wrapped_dek_recovery,
      recoveryKey,
      item.protection_salt
    );

    if (content === null) {
      return res.status(500).json({ error: 'Failed to decrypt content' });
    }

    // Mark recovery key as used
    await pool.query(
      'UPDATE recovery_keys SET used_at = NOW() WHERE user_id = $1 AND item_id = $2',
      [req.userId, itemId]
    );

    res.json({ success: true, content });
  } catch (err) {
    logger.error('Recovery unlock error:', err);
    res.status(500).json({ error: 'Failed to unlock with recovery key' });
  }
});

/**
 * POST /api/protection/rotate-password - Rotate password for protected item
 * Body: { itemId, oldPassword, newPassword }
 * Returns: { success }
 */
router.post('/rotate-password', apiLimiter, async (req, res) => {
  try {
    const { itemId, oldPassword, newPassword } = req.body;

    if (!isValidUUID(itemId)) {
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'Both old and new passwords are required' });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters' });
    }

    // Get the item with protection data
    const itemResult = await pool.query(
      `SELECT id, protection_level, wrapped_dek_password, protection_salt
       FROM clipboard_items 
       WHERE id = $1 AND user_id = $2`,
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = itemResult.rows[0];

    if (item.protection_level !== 'advanced') {
      return res.status(400).json({ error: 'Item does not use advanced protection' });
    }

    // Rotate password
    const result = rotatePassword(
      item.wrapped_dek_password,
      oldPassword,
      newPassword,
      item.protection_salt
    );

    if (!result) {
      return res.status(401).json({ error: 'Invalid old password' });
    }

    // Update the database
    await pool.query(
      `UPDATE clipboard_items 
       SET wrapped_dek_password = $1, protection_salt = $2
       WHERE id = $3 AND user_id = $4`,
      [result.newWrappedDEK, result.newSalt, itemId, req.userId]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error('Rotate password error:', err);
    res.status(500).json({ error: 'Failed to rotate password' });
  }
});

/**
 * POST /api/protection/remove - Remove protection from item
 * Body: { itemId, password? }
 * Returns: { success, content? }
 */
router.post('/remove', apiLimiter, async (req, res) => {
  try {
    const { itemId, password } = req.body;

    if (!isValidUUID(itemId)) {
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    // Get the item
    const itemResult = await pool.query(
      `SELECT id, content_encrypted, protection_level, wrapped_dek_password, protection_salt
       FROM clipboard_items 
       WHERE id = $1 AND user_id = $2`,
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = itemResult.rows[0];

    if (item.protection_level === 'none') {
      return res.status(400).json({ error: 'Item is not protected' });
    }

    // For advanced protection, we need to decrypt the content first
    let content = null;
    if (item.protection_level === 'advanced' && password) {
      content = unlockWithPassword(
        item.content_encrypted,
        item.wrapped_dek_password,
        password,
        item.protection_salt
      );
      
      if (!content) {
        return res.status(401).json({ error: 'Invalid password' });
      }
    }

    // Remove protection
    await pool.query(
      `UPDATE clipboard_items 
       SET protection_level = 'none',
           wrapped_dek_password = NULL,
           wrapped_dek_recovery = NULL,
           protection_salt = NULL,
           protection_iv = NULL
       WHERE id = $1 AND user_id = $2`,
      [itemId, req.userId]
    );

    // Delete recovery key
    await pool.query(
      'DELETE FROM recovery_keys WHERE user_id = $1 AND item_id = $2',
      [req.userId, itemId]
    );

    // If we decrypted content, return it so client can re-encrypt or store as plaintext
    res.json({ success: true, content });
  } catch (err) {
    logger.error('Remove protection error:', err);
    res.status(500).json({ error: 'Failed to remove protection' });
  }
});

/**
 * GET /api/protection/status/:itemId - Get protection status
 * Returns: { level, hasRecoveryKey }
 */
router.get('/status/:itemId', apiLimiter, async (req, res) => {
  try {
    const { itemId } = req.params;

    if (!isValidUUID(itemId)) {
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    const result = await pool.query(
      `SELECT protection_level 
       FROM clipboard_items 
       WHERE id = $1 AND user_id = $2`,
      [itemId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const level = result.rows[0].protection_level;

    // Check if recovery key exists
    const recoveryResult = await pool.query(
      'SELECT id FROM recovery_keys WHERE user_id = $1 AND item_id = $2',
      [req.userId, itemId]
    );

    res.json({
      level,
      hasRecoveryKey: recoveryResult.rows.length > 0
    });
  } catch (err) {
    logger.error('Get protection status error:', err);
    res.status(500).json({ error: 'Failed to get protection status' });
  }
});

export default router;
