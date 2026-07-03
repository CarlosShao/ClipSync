import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { storeUploadSession, getUploadSession, deleteUploadSession } from '../utils/redis-client.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';

// 允许的文件 MIME类型（安全白名单）
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.android.package-archive',
  'text/plain',
  'text/csv',
  'application/json',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/plain',
  'text/csv',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);

// 危险的文件扩展名（可能被恶意利用）
const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.wsf',
  '.sh', '.bash', '.zsh', '.fish',
  '.php', '.phtml', '.php3', '.php4', '.php5', '.phps',
  '.asp', '.aspx', '.jsp', '.jspx',
  '.htaccess', '.htpasswd',
  '.py', '.pyc', '.pyo', '.rb', '.pl', '.cgi',
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// 分片上传目录
const CHUNK_DIR = path.join(__dirname, '../../uploads/chunks');
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// 确保目录存在  
async function ensureDirs() {
  await fs.mkdir(CHUNK_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}
ensureDirs().catch(err => logger.error('Failed to create upload dirs', { error: err.message }));

// 内存回退方案（当Redis不可用时）  
const memoryUploadSessions = new Map();

// 是否使用Redis  
const useRedis = process.env.NODE_ENV === 'production';

/**
 * 保存上传会话（支持Redis和内存）
 */
async function saveUploadSession(uploadId, sessionData) {
  if (useRedis) {
    try {
      await storeUploadSession(uploadId, sessionData);
      return;
    } catch (err) {
      logger.error('Failed to store upload session in Redis, falling back to memory', err);
      // 回退到内存
      memoryUploadSessions.set(uploadId, sessionData);
    }
  } else {
    memoryUploadSessions.set(uploadId, sessionData);
  }
}

/**
 * 获取上传会话（支持Redis和内存）
 */
async function loadUploadSession(uploadId) {
  if (useRedis) {
    try {
      const data = await getUploadSession(uploadId);
      return data;
    } catch (err) {
      logger.error('Failed to get upload session from Redis, falling back to memory', err);
      // 回退到内存
      return memoryUploadSessions.get(uploadId);
    }
  } else {
    return memoryUploadSessions.get(uploadId);
  }
}

/**
 * 删除上传会话（同时清理 Redis 和内存回退，防止泄漏）
 */
async function removeUploadSession(uploadId) {
  // 始终清理内存回退（无论 Redis 是否启用）
  memoryUploadSessions.delete(uploadId);

  if (useRedis) {
    try {
      await deleteUploadSession(uploadId);
    } catch (err) {
      logger.error('Failed to delete upload session from Redis', err);
      // 内存已清理，不影响一致性
    }
  }
}

// 内存存储分片（暂时保留，后续迁移到Redis）  
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per chunk  
});

/**
 * POST /api/upload/init - 初始化分片上传
 * Body: { filename, fileSize, mimeType, totalChunks }
 */
router.post('/init', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { filename, fileSize, mimeType, totalChunks } = req.body;
    
    if (!filename || !fileSize || !mimeType || !totalChunks) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // ========== P1-3: 文件类型验证（基础病毒扫描）==========
    // 检查 MIME 类型是否在白名单中
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      logger.warn('File upload rejected: Invalid MIME type', { 
        userId: req.userId, 
        filename, 
        mimeType 
      });
      return res.status(400).json({ 
        error: 'File type not allowed',
        allowedTypes: Array.from(ALLOWED_MIME_TYPES)
      });
    }
    
    // 检查文件扩展名是否危险
    const fileExt = path.extname(filename).toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(fileExt)) {
      logger.warn('File upload rejected: Dangerous file extension', { 
        userId: req.userId, 
        filename, 
        extension: fileExt 
      });
      return res.status(400).json({ 
        error: 'File type not allowed',
        reason: 'Potentially dangerous file type'
      });
    }
    
    // 检查文件大小（防止磁盘耗尽攻击）
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
    if (fileSize > MAX_FILE_SIZE) {
      return res.status(400).json({ 
        error: 'File too large',
        maxSize: MAX_FILE_SIZE,
        receivedSize: fileSize
      });
    }
    
    const uploadId = uuidv4();
    const userId = req.userId;
    
    // 创建上传会话（uploadedChunks使用数组，而非Set，以便序列化）  
    const sessionData = {
      userId,
      filename,
      fileSize,
      mimeType,
      totalChunks,
      uploadedChunks: [], // 使用数组，而非Set  
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24小时过期  
    };
    
    await saveUploadSession(uploadId, sessionData);
    
    // 创建临时目录  
    const tempDir = path.join(CHUNK_DIR, uploadId);
    await fs.mkdir(tempDir, { recursive: true });
    
    logger.info('Chunked upload initialized', { uploadId, filename, fileSize, totalChunks });
    
    res.json({
      uploadId,
      chunkSize: Math.ceil(fileSize / totalChunks),
      expiresAt: sessionData.expiresAt
    });
  } catch (err) {
    logger.error('Chunked upload init error', { error: err.message });
    res.status(500).json({ error: 'Failed to initialize upload' });
  }
});

/**
 * POST /api/upload/chunk/:uploadId/:chunkIndex - 上传分片
 */
router.post('/chunk/:uploadId/:chunkIndex', authenticateToken, apiLimiter, upload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.params;
    const chunkIndexNum = parseInt(chunkIndex);
    
    // 验证上传会话  
    const session = await loadUploadSession(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    if (session.userId !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized access to this upload session' });
    }
    
    if (Date.now() > session.expiresAt) {
      await removeUploadSession(uploadId);
      return res.status(410).json({ error: 'Upload session expired' });
    }
    
    if (chunkIndexNum < 0 || chunkIndexNum >= session.totalChunks) {
      return res.status(400).json({ error: 'Invalid chunk index' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No chunk data found' });
    }
    
    // 保存分片到临时目录  
    const chunkPath = path.join(CHUNK_DIR, uploadId, `chunk_${chunkIndexNum}`);
    await fs.writeFile(chunkPath, req.file.buffer);
    
    // 记录已上传的分片（使用数组，避免重复）  
    if (!session.uploadedChunks.includes(chunkIndexNum)) {
      session.uploadedChunks.push(chunkIndexNum);
    }
    
    // 保存更新后的会话  
    await saveUploadSession(uploadId, session);
    
    logger.debug('Chunk uploaded', { uploadId, chunkIndex: chunkIndexNum, size: req.file.size });
    
    res.json({
      success: true,
      chunkIndex: chunkIndexNum,
      uploadedChunks: session.uploadedChunks.length,
      totalChunks: session.totalChunks
    });
  } catch (err) {
    logger.error('Chunk upload error', { error: err.message });
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

/**
 * GET /api/upload/status/:uploadId - 获取上传状态
 */
router.get('/status/:uploadId', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { uploadId } = req.params;
    
    const session = await loadUploadSession(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    if (session.userId !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized access to this upload session' });
    }
    
    // 获取已上传的分片列表（排序）  
    const uploadedChunks = session.uploadedChunks.sort((a, b) => a - b);
    
    // 计算缺失的分片  
    const missingChunks = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.uploadedChunks.includes(i)) {
        missingChunks.push(i);
      }
    }
    
    res.json({
      uploadId,
      filename: session.filename,
      fileSize: session.fileSize,
      mimeType: session.mimeType,
      totalChunks: session.totalChunks,
      uploadedChunks,
      missingChunks,
      progress: (session.uploadedChunks.length / session.totalChunks) * 100,
      expiresAt: session.expiresAt
    });
  } catch (err) {
    logger.error('Upload status error', { error: err.message });
    res.status(500).json({ error: 'Failed to get upload status' });
  }
});

/**
 * POST /api/upload/complete/:uploadId - 完成分片上传并合并
 */
router.post('/complete/:uploadId', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { uploadId } = req.params;
    
    const session = await loadUploadSession(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    if (session.userId !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized access to this upload session' });
    }
    
    if (Date.now() > session.expiresAt) {
      await removeUploadSession(uploadId);
      return res.status(410).json({ error: 'Upload session expired' });
    }
    
    // 检查所有分片是否已上传  
    if (session.uploadedChunks.length !== session.totalChunks) {
      const missingChunks = [];
      for (let i = 0; i < session.totalChunks; i++) {
        if (!session.uploadedChunks.includes(i)) {
          missingChunks.push(i);
        }
      }
      return res.status(400).json({ 
        error: 'Not all chunks have been uploaded',
        missingChunks 
      });
    }
    
    // 合并分片  
    const finalFilename = `${uuidv4()}${path.extname(session.filename)}`;
    const finalPath = path.join(UPLOAD_DIR, finalFilename);
    
    // 创建写入流  
    const writeStream = await fs.open(finalPath, 'w');
    const fileHandle = writeStream;
    
    try {
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(CHUNK_DIR, uploadId, `chunk_${i}`);
        const chunkData = await fs.readFile(chunkPath);
        await fileHandle.write(chunkData);
      }
    } finally {
      await fileHandle.close();
    }
    
    // 清理分片文件
    const chunkDir = path.join(CHUNK_DIR, uploadId);
    await fs.rm(chunkDir, { recursive: true, force: true });

    // Resolve source_device_id (must be valid UUID, FK → devices.id)
    let sourceDeviceId = (req.body && req.body.deviceId) || session.metadata?.deviceId || '';
    if (!sourceDeviceId || sourceDeviceId === 'unknown') {
      try {
        const devRes = await pool.query(
          'SELECT id FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 1',
          [req.userId]
        );
        if (devRes.rows.length > 0) {
          sourceDeviceId = devRes.rows[0].id;
          logger.info('Upload complete: resolved deviceId from devices table', { deviceId: sourceDeviceId });
        } else {
          // No device found — create a placeholder so FK is satisfied
          const devInsert = await pool.query(
            `INSERT INTO devices (id, user_id, name, type, platform, app_version, is_online, last_seen_at)
             VALUES ($1, $2, 'Desktop', 'desktop', 'windows', '0.0.0', false, now())
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [uuidv4(), req.userId]
          );
          sourceDeviceId = devInsert.rows[0]?.id || devInsert.rows[0]?.id;
          logger.info('Upload complete: created placeholder device', { deviceId: sourceDeviceId });
        }
      } catch (devErr) {
        logger.error('Upload complete: failed to resolve deviceId', { error: devErr.message });
        return res.status(500).json({ error: 'Failed to resolve device' });
      }
    }

    // 保存到数据库
    const result = await pool.query(
      `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata)
       VALUES ($1, $2, 'file', $3, $4, $5, $6)
       RETURNING id, content_type, content_preview, content_size, created_at`,
      [
        req.userId,
        sourceDeviceId,
        finalFilename,
        session.filename,
        session.fileSize,
        JSON.stringify({
          originalName: session.filename,
          mimeType: session.mimeType,
          chunkedUpload: true,
          totalChunks: session.totalChunks
        })
      ]
    );
    
    // 清理会话  
    await removeUploadSession(uploadId);
    
    logger.info('Chunked upload completed', { uploadId, filename: finalFilename, itemId: result.rows[0].id });
    
    res.json({
      success: true,
      itemId: result.rows[0].id,
      filename: finalFilename,
      originalName: session.filename,
      fileSize: session.fileSize,
      contentType: 'file',
      createdAt: result.rows[0].created_at
    });
  } catch (err) {
    logger.error('Chunked upload complete error', { error: err.message });
    res.status(500).json({ error: 'Failed to complete upload' });
  }
});

/**
 * DELETE /api/upload/cancel/:uploadId - 取消上传
 */
router.delete('/cancel/:uploadId', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { uploadId } = req.params;
    
    const session = await loadUploadSession(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    if (session.userId !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized access to this upload session' });
    }
    
    // 清理分片文件  
    const chunkDir = path.join(CHUNK_DIR, uploadId);
    await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    
    // 清理会话  
    await removeUploadSession(uploadId);
    
    logger.info('Chunked upload cancelled', { uploadId });
    
    res.json({
      success: true,
      message: 'Upload cancelled'
    });
  } catch (err) {
    logger.error('Chunked upload cancel error', { error: err.message });
    res.status(500).json({ error: 'Failed to cancel upload' });
  }
});

export default router;
