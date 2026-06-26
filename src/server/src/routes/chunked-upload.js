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
 * 删除上传会话（支持Redis和内存）
 */
async function removeUploadSession(uploadId) {
  if (useRedis) {
    try {
      await deleteUploadSession(uploadId);
    } catch (err) {
      logger.error('Failed to delete upload session from Redis', err);
    }
  }
  memoryUploadSessions.delete(uploadId);
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
      return res.status(400).json({ error: '缺少必要参数' });
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
    res.status(500).json({ error: '初始化上传失败' });
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
      return res.status(404).json({ error: '上传会话不存在' });
    }
    
    if (session.userId !== req.userId) {
      return res.status(403).json({ error: '无权访问此上传会话' });
    }
    
    if (Date.now() > session.expiresAt) {
      await removeUploadSession(uploadId);
      return res.status(410).json({ error: '上传会话已过期' });
    }
    
    if (chunkIndexNum < 0 || chunkIndexNum >= session.totalChunks) {
      return res.status(400).json({ error: '分片索引无效' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: '未找到分片数据' });
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
    res.status(500).json({ error: '上传分片失败' });
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
      return res.status(404).json({ error: '上传会话不存在' });
    }
    
    if (session.userId !== req.userId) {
      return res.status(403).json({ error: '无权访问此上传会话' });
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
    res.status(500).json({ error: '获取上传状态失败' });
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
      return res.status(404).json({ error: '上传会话不存在' });
    }
    
    if (session.userId !== req.userId) {
      return res.status(403).json({ error: '无权访问此上传会话' });
    }
    
    if (Date.now() > session.expiresAt) {
      await removeUploadSession(uploadId);
      return res.status(410).json({ error: '上传会话已过期' });
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
        error: '分片未完全上传',
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
    
    // 保存到数据库  
    const result = await pool.query(
      `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata)
       VALUES ($1, $2, 'file', $3, $4, $5, $6)
       RETURNING id, content_type, content_preview, content_size, created_at`,
      [
        req.userId,
        req.body.deviceId || 'unknown',
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
    res.status(500).json({ error: '完成上传失败' });
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
      return res.status(404).json({ error: '上传会话不存在' });
    }
    
    if (session.userId !== req.userId) {
      return res.status(403).json({ error: '无权访问此上传会话' });
    }
    
    // 清理分片文件  
    const chunkDir = path.join(CHUNK_DIR, uploadId);
    await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    
    // 清理会话  
    await removeUploadSession(uploadId);
    
    logger.info('Chunked upload cancelled', { uploadId });
    
    res.json({
      success: true,
      message: '上传已取消'
    });
  } catch (err) {
    logger.error('Chunked upload cancel error', { error: err.message });
    res.status(500).json({ error: '取消上传失败' });
  }
});

export default router;
