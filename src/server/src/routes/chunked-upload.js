import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { storeUploadSession, getUploadSession, deleteUploadSession } from '../utils/redis-client.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { writeChunk, readChunk, mergeChunks, deleteChunks, getFilePath } from '../utils/storage.js';
import { broadcastToUser } from '../ws/server.js';
import { getPlanLimits, checkUploadQuota, quotaHttpBody } from '../utils/planLimits.js';

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

// 存储后端（与 storage.js 同默认值）：非 local（如 s3）时分片目标不在本地盘，
// chunk 阶段保留 readFile→writeChunk 旧链路，rename/pipe 优化仅对 local 生效
const STORAGE_BACKEND = process.env.STORAGE_TYPE || 'local';

// L-1：上传根目录与分片目录对齐 utils/storage.js 口径（process.env.UPLOAD_DIR
// 优先，默认 src/server/uploads）——原 CHUNK_DIR 硬编码 `../../uploads/chunks`
// 与 storage.js 的 UPLOAD_DIR 读取分裂，设置了 UPLOAD_DIR 时分片/合并产物
// 会写错目录。MULTER_TMP 派生自 CHUNK_DIR，随之跟随。
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const CHUNK_DIR = path.join(UPLOAD_DIR, 'chunks');
// multer 临时落盘目录（分片先写这里，再由 rename/pipe 零内存拷贝到分片目标）
const MULTER_TMP = path.join(CHUNK_DIR, '.multer-tmp');

// 确保目录存在  
async function ensureDirs() {
  await fs.mkdir(CHUNK_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(MULTER_TMP, { recursive: true });
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

// 磁盘存储分片：每个分片先落临时盘（MULTER_TMP），再由 rename/pipe 零内存拷贝到分片目标，
// 避免大文件分片全部缓冲进 Node 内存导致 OOM（原 memoryStorage 的隐患）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MULTER_TMP),
  filename: (req, file, cb) => {
    const { uploadId, chunkIndex } = req.params;
    cb(null, `${uploadId}_${chunkIndex}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 } // 12MB per chunk (10MB data + headroom)
});

/**
 * POST /api/upload/init - 初始化分片上传
 * Body: { filename, fileSize, mimeType, totalChunks }
 */
router.post('/init', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { filename, fileSize: rawFileSize, mimeType, totalChunks } = req.body;
    const fileSize = Number(rawFileSize);

    if (!filename || !fileSize || !mimeType || !totalChunks) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // ========== 安全验证 ==========
    // 禁止可远程执行的脚本类型（防止服务器被利用）
    const BLOCKED_SCRIPT_EXTENSIONS = new Set([
      '.bat', '.cmd', '.ps1', '.vbs', '.wsf',  // Windows 脚本
      '.sh', '.bash', '.zsh', '.fish',          // Shell 脚本
      '.php', '.phtml', '.php3', '.php4', '.php5', '.phps',  // PHP
      '.asp', '.aspx', '.jsp', '.jspx',         // 服务端脚本
      '.htaccess', '.htpasswd',                  // 服务器配置
    ]);
    const fileExt = path.extname(filename).toLowerCase();
    if (BLOCKED_SCRIPT_EXTENSIONS.has(fileExt)) {
      logger.warn('File upload rejected: Script type blocked', {
        userId: req.userId, filename, extension: fileExt
      });
      return res.status(400).json({
        error: 'Script files are not allowed for security reasons',
        blocked: fileExt
      });
    }

    // ========== 套餐配额校验（F0.2）：阈值读 DB，admin 不受限，超限统一 413 ==========
    try {
      const limits = await getPlanLimits(req.userId);
      logger.info('[Upload/init] Plan limits:', {
        filename, fileSize, mimeType, totalChunks,
        plan: limits.plan, isUnlimited: limits.isUnlimited,
        maxFileSizeBytes: limits.maxFileSizeBytes,
        userId: req.userId
      });
      // init 阶段按待传文件大小校验单文件 / 单次总大小 / 已用容量（文件数=1）
      const verdict = await checkUploadQuota(req.userId, [{ size: fileSize, count: 1 }], limits);
      if (!verdict.allowed) {
        logger.warn('[Upload/init] Upload rejected by plan quota:', {
          userId: req.userId, code: verdict.code, fileSize, plan: verdict.plan
        });
        return res.status(413).json(quotaHttpBody(verdict));
      }
    } catch (quotaErr) {
      // planLimits 内部已 fail-open，此处异常不应阻塞上传主流程
      logger.error('[Upload/init] Plan quota check failed unexpectedly', { error: quotaErr.message });
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
    
    // 保存分片：multer 已将分片落盘至 MULTER_TMP（req.file.path），零内存拷贝搬到分片目标。
    // 优化前链路（readFile 整片进内存 → writeChunk 二次写盘）存在双倍磁盘 IO + 一次全分片
    // 内存缓冲；现在 local 后端优先 fs.rename（MULTER_TMP 在 CHUNK_DIR 之下，同盘 rename
    // 原子且零拷贝），EXDEV（uploads/chunks 为独立挂载点等跨盘场景）降级为流式 pipe（恒定小
    // 内存）；非 local 后端（如 s3）分片目标不在本地盘，保留原 readFile→writeChunk 链路。
    if (STORAGE_BACKEND !== 'local') {
      const chunkBuffer = await fs.readFile(req.file.path);
      await writeChunk(uploadId, chunkIndexNum, chunkBuffer);
    } else {
      const chunkDir = path.join(CHUNK_DIR, uploadId);
      await fs.mkdir(chunkDir, { recursive: true });
      const targetPath = path.join(chunkDir, `chunk_${chunkIndexNum}`);
      try {
        await fs.rename(req.file.path, targetPath);
      } catch (renameErr) {
        if (renameErr?.code !== 'EXDEV') throw renameErr;
        try {
          await new Promise((resolve, reject) => {
            const rs = createReadStream(req.file.path);
            const ws = createWriteStream(targetPath);
            let failed = false;
            const fail = (err) => {
              if (failed) return;
              failed = true;
              rs.destroy();
              ws.destroy();
              reject(err);
            };
            rs.on('error', fail);
            ws.on('error', fail);
            ws.on('finish', resolve);
            rs.pipe(ws);
          });
        } catch (pipeErr) {
          // 流式复制失败：清理半成品目标文件，避免 mergeChunks 拿到不完整分片
          await fs.unlink(targetPath).catch(() => {});
          throw pipeErr;
        }
      }
    }
    
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
  } finally {
    // multer 中间件先于会话/参数校验就把分片落盘 MULTER_TMP：校验失败早退（404/403/410/400）、
    // 保存成功（rename 后临时文件已不存在，ENOENT 忽略）、异常路径统一在此清理，防临时文件泄漏
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
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
    
    // 合并分片（通过存储服务）
    const finalFilename = `${uuidv4()}${path.extname(session.filename)}`;
    const finalPath = await mergeChunks(uploadId, session.totalChunks, session.filename, path.extname(session.filename));

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

    // ── 落盘修复：合并文件此前写在 UPLOAD_DIR 根（uploadId 命名），而下载端点
    //    在 uploads/files/ 按 content_encrypted（finalFilename）查找 → 永远 404。
    //    统一移动到 files/ 子目录并使用与 DB 一致的最终文件名。
    const filesDir = path.join(path.dirname(finalPath), 'files');
    await fs.mkdir(filesDir, { recursive: true });
    const finalTarget = path.join(filesDir, finalFilename);
    try {
      await fs.rename(finalPath, finalTarget);
    } catch {
      // 跨盘 rename 失败时降级为复制+清理
      await fs.copyFile(finalPath, finalTarget);
      await fs.rm(finalPath, { force: true });
    }

    // ── 关联已有条目（桌面自动文件同步：先建条目→后台上传字节→完成回填）。
    //    提供 clipboardItemId 时不新建条目，改为回填该条目并广播更新。
    const clipboardItemId = (req.body && req.body.clipboardItemId) || null;
    let itemId;
    let createdAt;
    if (clipboardItemId) {
      const ownership = await pool.query(
        `SELECT metadata FROM clipboard_items WHERE id = $1 AND user_id = $2 AND content_type = 'file'`,
        [clipboardItemId, req.userId]
      );
      if (ownership.rows.length === 0) {
        await fs.rm(finalTarget, { force: true }).catch(() => {});
        return res.status(404).json({ error: 'Linked clipboard item not found' });
      }
      const prevMeta = typeof ownership.rows[0].metadata === 'string'
        ? (() => { try { return JSON.parse(ownership.rows[0].metadata || '{}'); } catch { return {}; } })()
        : (ownership.rows[0].metadata || {});

      // ── metadata.files 回填（对齐 media.js POST /file 多文件契约，字段名逐字一致）：
      //    files:[{fileId:落盘名, name:原始文件名, size:字节, mimeType}] + totalSize + totalCount。
      //    原始文件名/mime 取 init 表单字段（session.filename / session.mimeType，init 必填已
      //    收集，无需新增字段）。两种情形：
      //    - 条目无 files（localOnly 占位条目，单文件 chunked 主路径）→ 写入单元素 files 数组；
      //    - 条目已有 files（多文件+chunked 混合场景）→ 按 fileId 增量合并：同 fileId 就地更新、
      //      否则追加，绝不删除/覆盖其他文件项；totalSize/totalCount 按 files[] 重算保持一致。
      //    并发边界：complete 对同一 uploadId 只会执行一次（成功后即删会话），桌面端两步流程
      //    串行（建条目→分片→complete），同一条目同一时刻仅本 uploadId 在写 metadata，
      //    简单读改写可接受；若未来允许多 uploadId 并发回填同一条目，需升级为 JSONB 原子
      //    操作（jsonb_set / ||）或行级锁。
      const chunkFileEntry = {
        fileId: finalFilename,
        name: session.filename,
        size: session.fileSize,
        mimeType: session.mimeType,
      };
      const prevFiles = Array.isArray(prevMeta.files)
        ? prevMeta.files.filter((f) => f && typeof f === 'object')
        : null;
      let nextFiles;
      if (prevFiles) {
        const existedIdx = prevFiles.findIndex((f) => f.fileId === finalFilename);
        nextFiles = prevFiles.slice();
        if (existedIdx >= 0) {
          nextFiles[existedIdx] = { ...prevFiles[existedIdx], ...chunkFileEntry };
        } else {
          nextFiles.push(chunkFileEntry);
        }
      } else {
        nextFiles = [chunkFileEntry];
      }
      const mergedMetadata = {
        ...prevMeta,
        originalName: session.filename,
        mimeType: session.mimeType,
        chunkedUpload: true,
        totalChunks: session.totalChunks,
        fileSize: session.fileSize,
        localOnly: false,
        fileEncoding: 'server',
        source: 'auto-sync',
        files: nextFiles,
        totalSize: nextFiles.reduce((sum, f) => sum + (Number(f.size) || 0), 0),
        totalCount: nextFiles.length,
      };
      const updated = await pool.query(
        `UPDATE clipboard_items
         SET content_encrypted = $3, content_size = $4, metadata = $5, updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id, content_type, content_preview, content_size, created_at`,
        [clipboardItemId, req.userId, finalFilename, session.fileSize, JSON.stringify(mergedMetadata)]
      );
      itemId = updated.rows[0].id;
      createdAt = updated.rows[0].created_at;
    } else {
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
      itemId = result.rows[0].id;
      createdAt = result.rows[0].created_at;
    }

    // 清理会话
    await removeUploadSession(uploadId);

    // 广播（字段结构对齐 media.js 的 new_clipboard）
    broadcastToUser(req.userId, {
      type: 'new_clipboard',
      item: {
        id: itemId,
        contentType: 'file',
        contentPreview: session.filename,
        contentSize: session.fileSize,
        createdAt
      }
    });

    logger.info('Chunked upload completed', { uploadId, filename: finalFilename, itemId });

    res.json({
      success: true,
      itemId,
      filename: finalFilename,
      originalName: session.filename,
      fileSize: session.fileSize,
      contentType: 'file',
      createdAt
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
    
    // 清理分片文件（通过存储服务）
    await deleteChunks(uploadId).catch(() => {});
    
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
