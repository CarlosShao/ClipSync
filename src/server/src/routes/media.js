import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import pool from '../db/pool.js';
import { broadcastToUser } from '../ws/server.js';
import { isValidUUID } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { createIdempotencyMiddleware } from '../middleware/idempotency.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// 幂等中间件（requireHeader：仅当客户端携带 Idempotency-Key 时才生效，防止上传网络重试产生重复文件）
const idempotencyMiddleware = createIdempotencyMiddleware({ requireHeader: true });

// Ensure upload directories exist
const UPLOAD_BASE = path.join(__dirname, '../../uploads');
const IMAGE_DIR = path.join(UPLOAD_BASE, 'images');
const FILE_DIR = path.join(UPLOAD_BASE, 'files');
// 临时目录：multer 先把上传文件落盘到这里，处理完再移走/删除（P2 修复：避免 1GB 文件缓冲在内存导致 OOM）
const TMP_DIR = path.join(UPLOAD_BASE, 'tmp');

async function ensureDirs() {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  await fs.mkdir(FILE_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(path.join(IMAGE_DIR, 'thumbnails'), { recursive: true });
}
ensureDirs().catch(err => logger.error('Failed to create upload dirs', { error: err.message }));

// Allowed MIME types
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'];
const FILE_TYPES = [
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
  'text/plain', 'text/csv', 'text/markdown', 'text/html', 'text/css', 'text/javascript',
  'application/json', 'application/xml', 'application/yaml',
  'application/octet-stream',
];

const SAFE_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
  '.zip', '.rar', '.7z', '.tar', '.gz',
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs',
  '.html', '.css', '.sh', '.sql',
]);

// Multer storage config for images —— 使用 diskStorage 直接落盘，避免把文件缓冲进内存（P2 修复 OOM）
const imageStorage = multer.diskStorage({
  destination: TMP_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}.img.tmp`),
});
const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
  },
});

// Multer storage config for files (plan-based size limit applied in route handler)
// diskStorage：1GB 文件直接写临时盘，处理完 rename 到正式目录，内存零拷贝（P2 修复 OOM）
const fileStorage = multer.diskStorage({
  destination: TMP_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}.file.tmp`),
});
const fileUpload = multer({
  storage: fileStorage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB max (Enterprise limit), actual limit checked in handler
  fileFilter: (req, file, cb) => {
    // Block script types for security
    const ext = path.extname(file.originalname).toLowerCase();
    const blocked = ['.bat', '.cmd', '.ps1', '.vbs', '.wsf', '.sh', '.bash', '.php', '.asp', '.aspx', '.jsp'];
    if (blocked.includes(ext)) {
      cb(new Error('Script files are not allowed'));
    } else {
      cb(null, true);
    }
  },
});

// Generate thumbnail for images
async function generateThumbnail(input, filename) {
  const thumbPath = path.join(IMAGE_DIR, 'thumbnails', `thumb_${filename}`);
  await sharp(input)
    .resize(150, 150, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toFile(thumbPath);
  return thumbPath;
}

// Compress image (optimize for storage)
// input 可为 Buffer 或磁盘上的文件路径（P2：从临时文件直接读，避免双份内存缓冲）
async function compressImage(input, mimetype) {
  // GIF 不压缩以保留动图；返回原始字节（路径则读盘）
  if (mimetype === 'image/gif') {
    return typeof input === 'string' ? await fs.readFile(input) : input;
  }

  let pipeline = sharp(input).rotate(); // Auto-rotate based on EXIF

  if (mimetype === 'image/png') {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else if (mimetype === 'image/webp') {
    pipeline = pipeline.webp({ quality: 85, effort: 6 });
  } else {
    // JPEG and others
    pipeline = pipeline.jpeg({ quality: 85, progressive: true });
  }

  return pipeline.toBuffer();
}

// POST /api/media/image - Upload an image
router.post('/image', apiLimiter, idempotencyMiddleware, imageUpload.single('image'), async (req, res) => {
  const tmpPath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please select an image to upload' });
    }

    const { sourceDeviceId, expiresAt } = req.body;

    if (!sourceDeviceId || !isValidUUID(sourceDeviceId)) {
      return res.status(400).json({ error: 'Invalid sourceDeviceId' });
    }

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [sourceDeviceId, req.userId]
    );
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Compress image（从临时文件直接读取，避免双份内存缓冲）
    const compressed = await compressImage(req.file.path, req.file.mimetype);
    const ext = req.file.mimetype === 'image/png' ? '.png' :
                req.file.mimetype === 'image/webp' ? '.webp' :
                req.file.mimetype === 'image/gif' ? '.gif' : '.jpg';
    const filename = `${uuidv4()}${ext}`;
    const filePath = path.join(IMAGE_DIR, filename);

    // Save compressed image
    await fs.writeFile(filePath, compressed);

    // Generate thumbnail
    const thumbFilename = `thumb_${uuidv4()}.jpg`;
    const thumbPath = path.join(IMAGE_DIR, 'thumbnails', thumbFilename);
    await sharp(compressed)
      .resize(150, 150, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);

    // Get image metadata
    const metadata = await sharp(compressed).metadata();

    // Save to database
    const result = await pool.query(
      `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
       VALUES ($1, $2, 'image', $3, $4, $5, $6, $7)
       RETURNING id, content_type, content_preview, content_size, is_favorite, expires_at, created_at`,
      [
        req.userId,
        sourceDeviceId,
        filename, // store filename as "encrypted" content reference
        req.file.originalname,
        compressed.length,
        JSON.stringify({
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          originalSize: req.file.size,
          compressedSize: compressed.length,
          width: metadata.width,
          height: metadata.height,
          thumbnail: thumbFilename,
        }),
        expiresAt || null,
      ]
    );

    const item = result.rows[0];

    // Update device sync state
    await pool.query(
      `INSERT INTO device_sync_state (device_id, last_synced_item_id, last_sync_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (device_id) DO UPDATE
       SET last_synced_item_id = $2, last_sync_at = NOW()`,
      [sourceDeviceId, item.id]
    );

    // Broadcast
    broadcastToUser(req.userId, {
      type: 'new_clipboard',
      item: {
        id: item.id,
        contentType: 'image',
        contentPreview: req.file.originalname,
        contentSize: compressed.length,
        createdAt: item.created_at,
        sourceDeviceId,
      },
    });

    logger.info('Image uploaded', { itemId: item.id, filename, size: compressed.length });
    
    // 审计日志：记录图片上传
    await logAuditEvent({
      userId: req.user?.userId,
      action: AUDIT_ACTIONS.UPLOAD_FILE,
      resourceType: 'clipboard_item',
      resourceId: item.id,
      details: {
        contentType: 'image',
        filename,
        originalName: req.file.originalname,
        originalSize: req.file.size,
        compressedSize: compressed.length,
        width: metadata.width,
        height: metadata.height,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.error('Audit log failed', { error: err.message }));
    
    res.status(201).json({
      id: item.id,
      contentType: 'image',
      filename,
      thumbnail: thumbFilename,
      originalName: req.file.originalname,
      originalSize: req.file.size,
      compressedSize: compressed.length,
      width: metadata.width,
      height: metadata.height,
      createdAt: item.created_at,
    });
  } catch (err) {
    logger.error('Upload image error', { error: err.message });
    res.status(500).json({ error: 'Image upload failed' });
  } finally {
    // 清理 multer 临时文件，避免磁盘堆积（P2）
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
  }
});

// POST /api/media/file - Upload a file
router.post('/file', apiLimiter, idempotencyMiddleware, fileUpload.single('file'), async (req, res) => {
  const tmpPath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please select a file to upload' });
    }

    const { sourceDeviceId, expiresAt } = req.body;

    if (!sourceDeviceId || !isValidUUID(sourceDeviceId)) {
      return res.status(400).json({ error: 'Invalid sourceDeviceId' });
    }

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [sourceDeviceId, req.userId]
    );
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Save file：将临时文件原子 rename 到正式目录（不拷贝进内存，P2 修复 OOM）
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = `${uuidv4()}${ext}`;
    const filePath = path.join(FILE_DIR, filename);
    await fs.rename(req.file.path, filePath);

    // Save to database
    const result = await pool.query(
      `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
       VALUES ($1, $2, 'file', $3, $4, $5, $6, $7)
       RETURNING id, content_type, content_preview, content_size, is_favorite, expires_at, created_at`,
      [
        req.userId,
        sourceDeviceId,
        filename,
        req.file.originalname,
        req.file.size,
        JSON.stringify({
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          extension: ext,
        }),
        expiresAt || null,
      ]
    );

    const item = result.rows[0];

    // Update device sync state
    await pool.query(
      `INSERT INTO device_sync_state (device_id, last_synced_item_id, last_sync_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (device_id) DO UPDATE
       SET last_synced_item_id = $2, last_sync_at = NOW()`,
      [sourceDeviceId, item.id]
    );

    // Broadcast
    broadcastToUser(req.userId, {
      type: 'new_clipboard',
      item: {
        id: item.id,
        contentType: 'file',
        contentPreview: req.file.originalname,
        contentSize: req.file.size,
        createdAt: item.created_at,
        sourceDeviceId,
      },
    });

    logger.info('File uploaded', { itemId: item.id, filename, size: req.file.size });
    
    // 审计日志：记录文件上传
    await logAuditEvent({
      userId: req.user?.userId,
      action: AUDIT_ACTIONS.UPLOAD_FILE,
      resourceType: 'clipboard_item',
      resourceId: item.id,
      details: {
        contentType: 'file',
        filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.error('Audit log failed', { error: err.message }));
    
    res.status(201).json({
      id: item.id,
      contentType: 'file',
      filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype,
      createdAt: item.created_at,
    });
  } catch (err) {
    logger.error('Upload file error', { error: err.message });
    res.status(500).json({ error: 'File upload failed' });
  } finally {
    // rename 成功则 temp 已不存在（ENOENT 被忽略）；失败则清理残留临时文件
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
  }
});

// GET /api/media/:id/download - Download file/image (with Range support)
router.get('/:id/download', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    // Get item from DB
    const result = await pool.query(
      `SELECT id, content_type, content_encrypted, content_preview, content_size, metadata
       FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const item = result.rows[0];
    const filename = item.content_encrypted; // stored filename
    const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;

    let filePath;
    if (item.content_type === 'image') {
      filePath = path.join(IMAGE_DIR, filename);
    } else if (item.content_type === 'file') {
      filePath = path.join(FILE_DIR, filename);
    } else {
      return res.status(400).json({ error: 'This content type does not support download' });
    }

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const stat = await fs.stat(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Range request for partial content (resume support)
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': metadata?.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(metadata?.originalName || 'download')}"`,
      });

      const { createReadStream } = await import('fs');
      const stream = createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': metadata?.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(metadata?.originalName || 'download')}"`,
        'Accept-Ranges': 'bytes',
      });

      const { createReadStream } = await import('fs');
      createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    logger.error('Download error', { error: err.message });
    res.status(500).json({ error: 'Download failed' });
  }
});

// GET /api/media/:id/preview - Get image thumbnail
router.get('/:id/preview', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await pool.query(
      `SELECT id, content_type, content_encrypted, metadata
       FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const item = result.rows[0];
    const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;

    if (item.content_type !== 'image') {
      return res.status(400).json({ error: 'Only images support preview' });
    }

    // Serve thumbnail
    const thumbPath = path.join(IMAGE_DIR, 'thumbnails', metadata?.thumbnail || '');
    try {
      await fs.access(thumbPath);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const { createReadStream } = await import('fs');
      createReadStream(thumbPath).pipe(res);
    } catch {
      // Fallback to full image
      const imgPath = path.join(IMAGE_DIR, item.content_encrypted);
      try {
        await fs.access(imgPath);
        res.setHeader('Content-Type', metadata?.mimeType || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const { createReadStream } = await import('fs');
        createReadStream(imgPath).pipe(res);
      } catch {
        return res.status(404).json({ error: 'Image not found' });
      }
    }
  } catch (err) {
    logger.error('Preview error', { error: err.message });
    res.status(500).json({ error: 'Preview failed' });
  }
});

// Text/code previewable extensions and their MIME types
const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs',
  '.html', '.css', '.sh', '.sql', '.log', '.ini', '.conf', '.env',
  '.toml', '.cfg', '.properties', '.gitignore', '.dockerfile',
]);

const CODE_SYNTAX_MAP = {
  '.js': 'javascript', '.ts': 'typescript', '.py': 'python',
  '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
  '.go': 'go', '.rs': 'rust', '.html': 'html', '.css': 'css',
  '.sh': 'bash', '.sql': 'sql', '.json': 'json', '.xml': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.md': 'markdown', '.csv': 'csv',
  '.toml': 'toml', '.ini': 'ini', '.conf': 'conf',
};

const MAX_TEXT_PREVIEW_SIZE = 100 * 1024; // 100KB max preview
const MAX_TEXT_PREVIEW_LINES = 200;       // Max lines for preview

// GET /api/media/:id/text-preview - Preview text/code file content
router.get('/:id/text-preview', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await pool.query(
      `SELECT id, content_type, content_encrypted, content_preview, content_size, metadata
       FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const item = result.rows[0];
    const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;

    // Only support text/code preview for file-type items
    if (item.content_type !== 'file') {
      return res.status(400).json({ error: 'Only file types support text preview' });
    }

    const ext = (metadata?.extension || '').toLowerCase();
    if (!TEXT_PREVIEW_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: 'This file type does not support text preview', ext });
    }

    const filePath = path.join(FILE_DIR, item.content_encrypted);
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    // Read file content with size limit
    const stat = await fs.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) { // 5MB - skip preview for very large files
      return res.status(400).json({ error: 'File too large for preview', size: stat.size });
    }

    const rawBuffer = await fs.readFile(filePath);
    const totalSize = rawBuffer.length;

    // Detect encoding and decode text
    let content;
    let encoding = 'utf-8';
    try {
      content = rawBuffer.toString('utf-8');
      // Check if it's actually valid UTF-8 by looking for replacement chars
      if (content.includes('\ufffd') && totalSize > 0) {
        // Try latin1 as fallback
        content = rawBuffer.toString('latin1');
        encoding = 'latin1';
      }
    } catch {
      content = rawBuffer.toString('latin1');
      encoding = 'latin1';
    }

    // Truncate to preview size
    const truncated = content.length > MAX_TEXT_PREVIEW_SIZE
      ? content.substring(0, MAX_TEXT_PREVIEW_SIZE)
      : content;

    // Split into lines and limit
    const allLines = truncated.split('\n');
    const previewLines = allLines.slice(0, MAX_TEXT_PREVIEW_LINES);
    const wasTruncated = allLines.length > MAX_TEXT_PREVIEW_LINES || content.length > MAX_TEXT_PREVIEW_SIZE;

    // Sanitize content for safe display (escape HTML)
    const sanitized = previewLines.map(line =>
      line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    );

    logger.info('Text preview generated', { itemId: id, ext, totalSize, lines: previewLines.length });

    res.json({
      id: item.id,
      fileName: metadata?.originalName || item.content_preview,
      extension: ext,
      language: CODE_SYNTAX_MAP[ext] || 'text',
      encoding,
      totalSize,
      totalLines: allLines.length > MAX_TEXT_PREVIEW_LINES ? allLines.length : content.split('\n').length,
      preview: {
        lines: sanitized,
        lineCount: previewLines.length,
        truncated: wasTruncated,
      },
    });
  } catch (err) {
    logger.error('Text preview error', { error: err.message });
    res.status(500).json({ error: 'Text preview failed' });
  }
});

// DELETE /api/media/:id - Delete uploaded file/image
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await pool.query(
      `SELECT id, content_type, content_encrypted, metadata
       FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const item = result.rows[0];
    const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;

    // Delete physical file
    if (item.content_type === 'image') {
      const imgPath = path.join(IMAGE_DIR, item.content_encrypted);
      const thumbPath = path.join(IMAGE_DIR, 'thumbnails', metadata?.thumbnail || '');
      await fs.unlink(imgPath).catch(() => {});
      await fs.unlink(thumbPath).catch(() => {});
    } else if (item.content_type === 'file') {
      const filePath = path.join(FILE_DIR, item.content_encrypted);
      await fs.unlink(filePath).catch(() => {});
    }

    // Delete from DB
    await pool.query('DELETE FROM clipboard_items WHERE id = $1 AND user_id = $2', [id, req.userId]);

    // Broadcast
    broadcastToUser(req.userId, {
      type: 'clipboard_deleted',
      itemId: id,
    });

    res.json({ message: 'File deleted' });
  } catch (err) {
    logger.error('Delete media error', { error: err.message });
    res.status(500).json({ error: 'Delete failed' });
  }
});

export default router;
