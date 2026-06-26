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
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// Ensure upload directories exist
const UPLOAD_BASE = path.join(__dirname, '../../uploads');
const IMAGE_DIR = path.join(UPLOAD_BASE, 'images');
const FILE_DIR = path.join(UPLOAD_BASE, 'files');

async function ensureDirs() {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  await fs.mkdir(FILE_DIR, { recursive: true });
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

// Multer storage config for images
const imageStorage = multer.memoryStorage();
const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的图片类型: ${file.mimetype}`));
    }
  },
});

// Multer storage config for files
const fileStorage = multer.memoryStorage();
const fileUpload = multer({
  storage: fileStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (SAFE_FILE_EXTENSIONS.has(ext) || FILE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件类型: ${file.mimetype}`));
    }
  },
});

// Generate thumbnail for images
async function generateThumbnail(buffer, filename) {
  const thumbPath = path.join(IMAGE_DIR, 'thumbnails', `thumb_${filename}`);
  await sharp(buffer)
    .resize(150, 150, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toFile(thumbPath);
  return thumbPath;
}

// Compress image (optimize for storage)
async function compressImage(buffer, mimetype) {
  let pipeline = sharp(buffer).rotate(); // Auto-rotate based on EXIF

  if (mimetype === 'image/png') {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else if (mimetype === 'image/webp') {
    pipeline = pipeline.webp({ quality: 85, effort: 6 });
  } else if (mimetype === 'image/gif') {
    // Don't compress GIF to preserve animation
    return buffer;
  } else {
    // JPEG and others
    pipeline = pipeline.jpeg({ quality: 85, progressive: true });
  }

  return pipeline.toBuffer();
}

// POST /api/media/image - Upload an image
router.post('/image', apiLimiter, imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的图片' });
    }

    const { sourceDeviceId, expiresAt } = req.body;

    if (!sourceDeviceId || !isValidUUID(sourceDeviceId)) {
      return res.status(400).json({ error: 'sourceDeviceId 无效' });
    }

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [sourceDeviceId, req.userId]
    );
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: '设备不存在' });
    }

    // Compress image
    const compressed = await compressImage(req.file.buffer, req.file.mimetype);
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
    res.status(500).json({ error: '图片上传失败' });
  }
});

// POST /api/media/file - Upload a file
router.post('/file', apiLimiter, fileUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    const { sourceDeviceId, expiresAt } = req.body;

    if (!sourceDeviceId || !isValidUUID(sourceDeviceId)) {
      return res.status(400).json({ error: 'sourceDeviceId 无效' });
    }

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [sourceDeviceId, req.userId]
    );
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: '设备不存在' });
    }

    // Save file
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = `${uuidv4()}${ext}`;
    const filePath = path.join(FILE_DIR, filename);
    await fs.writeFile(filePath, req.file.buffer);

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
    res.status(500).json({ error: '文件上传失败' });
  }
});

// GET /api/media/:id/download - Download file/image (with Range support)
router.get('/:id/download', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'ID格式无效' });
    }

    // Get item from DB
    const result = await pool.query(
      `SELECT id, content_type, content_encrypted, content_preview, content_size, metadata
       FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '文件不存在' });
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
      return res.status(400).json({ error: '此类型不支持下载' });
    }

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: '文件未找到' });
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
    res.status(500).json({ error: '下载失败' });
  }
});

// GET /api/media/:id/preview - Get image thumbnail
router.get('/:id/preview', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'ID格式无效' });
    }

    const result = await pool.query(
      `SELECT id, content_type, content_encrypted, metadata
       FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const item = result.rows[0];
    const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;

    if (item.content_type !== 'image') {
      return res.status(400).json({ error: '仅图片支持预览' });
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
        return res.status(404).json({ error: '图片未找到' });
      }
    }
  } catch (err) {
    logger.error('Preview error', { error: err.message });
    res.status(500).json({ error: '预览失败' });
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
      return res.status(400).json({ error: 'ID格式无效' });
    }

    const result = await pool.query(
      `SELECT id, content_type, content_encrypted, content_preview, content_size, metadata
       FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const item = result.rows[0];
    const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;

    // Only support text/code preview for file-type items
    if (item.content_type !== 'file') {
      return res.status(400).json({ error: '仅文件类型支持文本预览' });
    }

    const ext = (metadata?.extension || '').toLowerCase();
    if (!TEXT_PREVIEW_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: '此文件类型不支持文本预览', ext });
    }

    const filePath = path.join(FILE_DIR, item.content_encrypted);
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: '文件未找到' });
    }

    // Read file content with size limit
    const stat = await fs.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) { // 5MB - skip preview for very large files
      return res.status(400).json({ error: '文件过大，不支持预览', size: stat.size });
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
    res.status(500).json({ error: '文本预览失败' });
  }
});

// DELETE /api/media/:id - Delete uploaded file/image
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'ID格式无效' });
    }

    const result = await pool.query(
      `SELECT id, content_type, content_encrypted, metadata
       FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '文件不存在' });
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

    res.json({ message: '文件已删除' });
  } catch (err) {
    logger.error('Delete media error', { error: err.message });
    res.status(500).json({ error: '删除失败' });
  }
});

export default router;
