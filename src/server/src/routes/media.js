import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { fileURLToPath } from 'url';
import pool from '../db/pool.js';
import { broadcastToUser } from '../ws/server.js';
import { isValidUUID } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { createIdempotencyMiddleware } from '../middleware/idempotency.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { getPlanLimits, checkUploadQuota, quotaHttpBody } from '../utils/planLimits.js';
// archiver@8 为纯 ESM 包：v7 的默认导出工厂函数已移除，改用命名导出类；
// 核心流式 API（file/abort/finalize/pipe/'error' 事件）与 v7 一致。
// H2 修复：不再顶层 import——改为 zip 打包分支内动态 import()，消除模块加载期
// 硬依赖（旧镜像缺少 archiver 包时，顶层 import 会让进程启动即崩）；import
// 失败在分支内返回 500 结构化错误，不影响其余路由。
// F1.3：DELETE 复用保留期清理的安全文件名判断与落盘文件删除抽象（uploads/files 口径）
import { deleteStoredClipFiles, isSafeStoredFilename } from '../services/fileRetentionCleanup.js';

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

// Generate thumbnail for images（600x600 高清缩略图，适应现代高清/Retina屏幕，杜绝模糊）
async function generateThumbnail(input, filename) {
  const thumbPath = path.join(IMAGE_DIR, 'thumbnails', `thumb_${filename}`);
  await sharp(input)
    .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 })
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

    // 高保真存储：保留原始上传图片字节，不主动进行有损二次压缩，确保跨端原画质同步
    const ext = req.file.mimetype === 'image/png' ? '.png' :
                req.file.mimetype === 'image/webp' ? '.webp' :
                req.file.mimetype === 'image/gif' ? '.gif' : '.jpg';
    const filename = `${uuidv4()}${ext}`;
    const filePath = path.join(IMAGE_DIR, filename);

    // 直接持久化原始全分辨率图片
    await fs.copyFile(req.file.path, filePath);
    const fileStats = await fs.stat(filePath);
    const storedSize = fileStats.size;

    // Generate thumbnail (生成 600x600 高清缩略图用于快速列表流加载)
    const thumbFilename = `thumb_${uuidv4()}.jpg`;
    await generateThumbnail(filePath, thumbFilename);

    // Get image metadata
    const metadata = await sharp(filePath).metadata();

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
        storedSize,
        JSON.stringify({
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          originalSize: req.file.size,
          compressedSize: storedSize,
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
        contentSize: storedSize,
        createdAt: item.created_at,
        sourceDeviceId,
      },
    });

    logger.info('Image uploaded', { itemId: item.id, filename, size: storedSize });
    
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
        compressedSize: storedSize,
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
      compressedSize: storedSize,
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

// ─── F1.2：多文件上传支持（单文件兼容旧契约）────────────────────────────────
// text/* 判定：text/* mime 前缀 + 复用模块底部导出的 TEXT_PREVIEW_EXTENSIONS
// 扩展名白名单（与 /:id/text-preview 端点同一口径，.json/.js 等非 text/* mime
// 的文本文件同样可生成预览）。TEXT_PREVIEW_EXTENSIONS 在模块底部声明，
// 本函数仅请求期执行，不存在 TDZ 问题。
function isTextLikeFile(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  return (
    (typeof file.mimetype === 'string' && file.mimetype.startsWith('text/')) ||
    TEXT_PREVIEW_EXTENSIONS.has(ext)
  );
}

// content_preview 截取字节数：列表接口返回该列，控制在 4KB 内
const MULTIFILE_TEXT_PREVIEW_BYTES = 4 * 1024;

// 读取落盘文件前 4KB（utf8）生成 content_preview。
// 容错：4KB 边界可能切断多字节字符（解码产生 U+FFFD）、二进制文件前 4KB 为乱码——
// 剥离尾部替换符与 NUL 字节后原样返回；读取失败由调用方回退为首文件原始名。
async function readTextPreviewHead(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { bytesRead, buffer } = await handle.read({
      buffer: Buffer.alloc(MULTIFILE_TEXT_PREVIEW_BYTES),
      position: 0,
      length: MULTIFILE_TEXT_PREVIEW_BYTES,
    });
    return buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/\ufffd+$/g, '')
      .replace(/\0/g, '');
  } finally {
    await handle.close().catch(() => {});
  }
}

// POST /api/media/file - Upload file(s)
// F1.2 契约：multipart 同时接受旧字段 `file`（单文件，旧桌面客户端只发此字段，
// 绝不能删——换成 .array('files') 会让全部旧客户端 400）与新字段 `files`
//（多文件数组），handler 内归一化为统一数组后再分流。
// maxCount=50 决策：传输层上限提到 50（= Enterprise 档 max_files_per_clip），
// 保证 Free(3)/Pro(10)/Enterprise(50) 的合法多文件请求都能到达业务配额校验，
// 超限时返回结构化 413 TOO_MANY_FILES（quotaHttpBody），而不是 multer 的通用
// 错误；>50 属滥用，由 multer 在传输层提前中止（LIMIT_UNEXPECTED_FILE，
// 已落盘临时文件由 multer abortWithError 自动清理）。DoS 面可控：单文件 1GB
// 硬上限 + apiLimiter 限速 + diskStorage 落盘（不占内存）+ 业务配额 fail-closed；
// 残留 tmp 另有 fileRetentionCleanup 定时清扫兜底。
router.post(
  '/file',
  apiLimiter,
  idempotencyMiddleware,
  fileUpload.fields([
    { name: 'files', maxCount: 50 }, // 新字段：多文件数组（业务上限以 checkUploadQuota 为准）
    { name: 'file', maxCount: 1 },   // 旧字段：单文件（旧客户端契约，逐字段兼容）
  ]),
  async (req, res) => {
    // 归一化：新旧字段合并为统一数组（files 字段在前，file 字段在后）
    req.files = [...(req.files?.files || []), ...(req.files?.file || [])];
    const tmpPaths = req.files.map((f) => f?.path).filter(Boolean);
    const movedPaths = []; // 已 rename 进正式目录的最终文件路径（异常回滚删除，防泄漏）
    let succeeded = false; // DB 条目落库成功后置 true：此后磁盘文件必须保留（与 DB 一致）
    try {
      if (req.files.length === 0) {
        return res.status(400).json({ error: 'Please select a file to upload' });
      }

      // ========== 套餐配额校验（F0.2/F1.2）：multer 已拿到文件大小，正式落盘/入库前拦截。
      // multer diskStorage 先写 TMP_DIR（fileUpload limits 1GB 兜底），超限时临时文件由
      // 本 handler 的 finally 统一 unlink 清理，不会移入正式目录。
      // 单文件调用形状与 F0.2 完全一致（[{ size, count: 1 }]）；多文件按 N 个文件
      // 逐个计数，文件数 / 单次总大小 / 已用容量全部由 checkUploadQuota 判定
      //（业务上限以套餐 max_files_per_clip 为准，非 multer maxCount）。
      try {
        const limits = await getPlanLimits(req.userId);
        const verdict = await checkUploadQuota(
          req.userId,
          req.files.map((f) => ({ size: f.size, count: 1 })),
          limits
        );
        if (!verdict.allowed) {
          logger.warn('File upload rejected by plan quota', {
            userId: req.userId,
            code: verdict.code,
            size: req.files.reduce((sum, f) => sum + (Number(f.size) || 0), 0),
            count: req.files.length,
            plan: verdict.plan,
          });
          // 413 时所有文件仍在 TMP_DIR，由 finally 统一清理
          return res.status(413).json(quotaHttpBody(verdict));
        }
      } catch (quotaErr) {
        // planLimits 内部已 fail-open，此处异常不应阻塞上传主流程
        logger.error('Plan quota check failed unexpectedly', { error: quotaErr.message });
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

      // 落盘：将每个临时文件原子 rename 到正式目录（不拷贝进内存，P2 修复 OOM）。
      // file 条目统一进 FILE_DIR（mime 分流与现有单文件逻辑一致，N 个文件 N 次 rename）。
      const saved = req.files.map((f) => {
        const ext = path.extname(f.originalname).toLowerCase();
        const filename = `${uuidv4()}${ext}`;
        return { file: f, ext, filename, filePath: path.join(FILE_DIR, filename) };
      });
      for (const s of saved) {
        await fs.rename(s.file.path, s.filePath);
        movedPaths.push(s.filePath);
      }

      const first = saved[0];
      const isSingle = saved.length === 1;
      const totalSize = saved.reduce((sum, s) => sum + (Number(s.file.size) || 0), 0);

      // content_preview：单文件保持旧语义（原始文件名）；多文件取第一个 text/*
      // 文件落盘后的前 4KB 文本，全部非文本则存首文件原始名
      let contentPreview = first.file.originalname;
      if (!isSingle) {
        const firstText = saved.find((s) => isTextLikeFile(s.file));
        if (firstText) {
          try {
            contentPreview = await readTextPreviewHead(firstText.filePath);
          } catch (previewErr) {
            logger.warn('Multi-file text preview read failed, falling back to original name', {
              error: previewErr.message,
            });
          }
        }
      }

      // metadata：单文件保持旧字段（originalName/mimeType/extension，与现状逐字段一致）；
      // 多文件聚合 files/totalSize/totalCount/fileEncoding，并保留 originalName/
      // mimeType/extension（首文件口径，兼容 text-preview / download 等现有消费方）。
      const metadata = isSingle
        ? {
            originalName: first.file.originalname,
            mimeType: first.file.mimetype,
            extension: first.ext,
          }
        : {
            files: saved.map((s) => ({
              fileId: s.filename, // 落盘文件名（uuid.ext），download 端按 content_encrypted 找文件
              name: s.file.originalname,
              size: s.file.size,
              mimeType: s.file.mimetype,
            })),
            totalSize,
            totalCount: saved.length,
            fileEncoding: 'server',
            originalName: first.file.originalname,
            mimeType: first.file.mimetype,
            extension: first.ext,
          };

      // Save to database
      // content_encrypted = 首文件落盘文件名（uuid.ext）：服务端多处把该列当文件名
      // 消费（download / delete / text-preview），多文件聚合也绝不改成 JSON。
      const result = await pool.query(
        `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
         VALUES ($1, $2, 'file', $3, $4, $5, $6, $7)
         RETURNING id, content_type, content_preview, content_size, is_favorite, expires_at, created_at`,
        [
          req.userId,
          sourceDeviceId,
          first.filename,
          contentPreview,
          isSingle ? first.file.size : totalSize,
          JSON.stringify(metadata),
          expiresAt || null,
        ]
      );

      const item = result.rows[0];
      // 条目已落库：磁盘文件与 DB 绑定，此后任何异常都不得回滚删除文件
      succeeded = true;

      // Update device sync state
      await pool.query(
        `INSERT INTO device_sync_state (device_id, last_synced_item_id, last_sync_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (device_id) DO UPDATE
         SET last_synced_item_id = $2, last_sync_at = NOW()`,
        [sourceDeviceId, item.id]
      );

      // Broadcast：多文件也只广播一个聚合条目（单条 new_clipboard）
      broadcastToUser(req.userId, {
        type: 'new_clipboard',
        item: {
          id: item.id,
          contentType: 'file',
          contentPreview,
          contentSize: isSingle ? first.file.size : totalSize,
          createdAt: item.created_at,
          sourceDeviceId,
        },
      });

      logger.info('File uploaded', {
        itemId: item.id,
        filename: first.filename,
        size: isSingle ? first.file.size : totalSize,
        totalCount: saved.length,
      });

      // 审计日志：记录文件上传
      await logAuditEvent({
        userId: req.user?.userId,
        action: AUDIT_ACTIONS.UPLOAD_FILE,
        resourceType: 'clipboard_item',
        resourceId: item.id,
        details: {
          contentType: 'file',
          filename: first.filename,
          originalName: first.file.originalname,
          size: isSingle ? first.file.size : totalSize,
          mimeType: first.file.mimetype,
          ...(isSingle ? {} : { totalCount: saved.length, totalSize }),
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      }).catch((err) => logger.error('Audit log failed', { error: err.message }));

      // 响应：单文件（无论走 file 还是 files 单个）与现状逐字段一致；
      // 多文件在旧字段基础上新增 files/totalSize/totalCount
      res.status(201).json({
        id: item.id,
        contentType: 'file',
        filename: first.filename,
        originalName: first.file.originalname,
        size: first.file.size,
        mimeType: first.file.mimetype,
        createdAt: item.created_at,
        ...(isSingle
          ? {}
          : {
              files: saved.map((s) => ({
                fileId: s.filename,
                filename: s.filename,
                name: s.file.originalname,
                size: s.file.size,
                mimeType: s.file.mimetype,
              })),
              totalSize,
              totalCount: saved.length,
            }),
      });
    } catch (err) {
      logger.error('Upload file error', { error: err.message });
      res.status(500).json({ error: 'File upload failed' });
    } finally {
      // 临时文件清理：rename 成功则对应 temp 已不存在（ENOENT 被忽略）；失败则清理残留
      await Promise.all(tmpPaths.map((p) => fs.unlink(p).catch(() => {})));
      // 异常路径回滚：删除已 rename 进正式目录的文件，防止半成品泄漏（落库成功时跳过）
      if (!succeeded) {
        await Promise.all(movedPaths.map((p) => fs.unlink(p).catch(() => {})));
      }
    }
  }
);

// ─── F1.3：download 多文件支持 ──────────────────────────────────────────────
// zip 打包预检上限：metadata.files[].size 总和超过该值 → 400，要求按 fileIndex 逐个下载
const MULTIFILE_ZIP_MAX_BYTES = 100 * 1024 * 1024; // 100MB

// 磁盘文件存在性检查（与旧 download 内联 access+stat.isFile 检查逐行为等价的抽象：
// 目录 / 缺失 / 空文件名拼出目录本身等情况均返回 false → 404）
async function isReadableFileOnDisk(filePath) {
  try {
    await fs.access(filePath);
    const existsStat = await fs.stat(filePath);
    return existsStat.isFile();
  } catch {
    return false;
  }
}

// fileIndex 查询参数校验：undefined → 未传(null)；非负整数字符串且 < total → 有效下标；
// 其余（非数字 / 负号 / 空串 / 数组重复参数 / 越界）→ 无效(-1)
function parseFileIndex(rawIndex, total) {
  if (rawIndex === undefined) return null;
  if (!/^\d+$/.test(String(rawIndex))) return -1;
  const idx = parseInt(rawIndex, 10);
  return idx < total ? idx : -1;
}

// 单文件下载（200 全量 / 206 Range）。逻辑与改造前 download 的两个分支逐行等价，
// 仅把 mimeType / 下载名参数化：旧条目传 metadata 口径，多文件条目传 files[n] 口径。
async function serveFileWithRange(req, res, filePath, { mimeType, downloadName }) {
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
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName || 'download')}"`,
    });

    const stream = createReadStream(filePath, { start, end });
    stream.on('error', (streamErr) => {
      logger.error('Download stream error', { error: streamErr.message, filePath });
      res.destroy();
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName || 'download')}"`,
      'Accept-Ranges': 'bytes',
    });

    createReadStream(filePath)
      .on('error', (streamErr) => {
        logger.error('Download stream error', { error: streamErr.message, filePath });
        res.destroy();
      })
      .pipe(res);
  }
}

// GET /api/media/:id/download - Download file/image (with Range support)
// F1.3 多文件条目（metadata.files，F1.2 上传契约）扩展：
//   - ?fileIndex=n → 下载第 n 个文件（Range 逻辑与单文件完全一致），非法/越界 → 400
//   - 无 fileIndex 且 files.length>1 → 流式 zip 打包（archiver zlib level=1，不落临时
//     文件、不缓冲整体；打包前按 metadata.files[].size 预检 ≤100MB；忽略 Range 头）
// 旧单文件条目（无 metadata.files）与 image 走原路径，行为 100% 不变。
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

    // F1.3：仅 file 条目且 metadata.files 为数组时进入多文件分支；其余条目原样走旧路径
    const multiFiles =
      item.content_type === 'file' && Array.isArray(metadata?.files) ? metadata.files : null;

    if (multiFiles) {
      const idx = parseFileIndex(req.query.fileIndex, multiFiles.length);

      // ── 分支 1：fileIndex 指定单个文件下载 ──
      if (req.query.fileIndex !== undefined) {
        if (idx === -1) {
          return res.status(400).json({ error: 'Invalid fileIndex' });
        }
        const entry = multiFiles[idx];
        // fileId 是服务端生成的落盘文件名，防御性按安全文件名口径校验（防 DB 数据被注入路径）
        if (!isSafeStoredFilename(entry?.fileId)) {
          return res.status(404).json({ error: 'File not found on disk' });
        }
        const entryPath = path.join(FILE_DIR, entry.fileId);
        if (!(await isReadableFileOnDisk(entryPath))) {
          return res.status(404).json({ error: 'File not found on disk' });
        }
        // 下载名 / Content-Type 取该文件自身口径（metadata.originalName/mimeType 是首文件口径）
        await serveFileWithRange(req, res, entryPath, {
          mimeType: entry.mimeType,
          downloadName: entry.name,
        });
        return;
      }

      // ── 分支 2：多文件（>1）无 fileIndex → 流式 zip ──
      // files.length===1 的聚合形状按 F1.2 契约不会产生（上传端单文件写旧 metadata），
      // 防御性落到下方旧路径：content_encrypted 即该文件，口径一致。
      if (multiFiles.length > 1) {
        // 打包前预检（只读 metadata，不读文件内容）：files[].size 总和 ≤ 100MB
        const totalBytes = multiFiles.reduce((sum, f) => sum + (Number(f?.size) || 0), 0);
        if (totalBytes > MULTIFILE_ZIP_MAX_BYTES) {
          return res.status(400).json({
            error: 'zip too large, please download files individually by fileIndex',
          });
        }

        // 逐个校验落盘文件存在（任一缺失 → 404，避免 zip 中途截断）；zip 内条目名做
        // basename 归一化（剥离 / \ 与路径段，防 zip-slip 下游解压风险，正常文件名无损）。
        // N-1 加固：归一化结果为 '.' / '..' / 空串（如 '..'、'.'、'...' 之类仅由点号
        // 组成的名字）时改用 `file-<序号><原扩展名>` 兜底，杜绝 '..' 绕过净化后在下游
        // 解压时写出目录外文件；重名条目追加 (2)/(3) 序号去重，防止 zip 内同名互相覆盖。
        const zipEntries = [];
        const usedEntryNames = new Set();
        for (const [entryIdx, f] of multiFiles.entries()) {
          if (!isSafeStoredFilename(f?.fileId)) {
            return res.status(404).json({ error: 'File not found on disk' });
          }
          const entryPath = path.join(FILE_DIR, f.fileId);
          if (!(await isReadableFileOnDisk(entryPath))) {
            return res.status(404).json({ error: 'File not found on disk' });
          }
          const rawName = String(f?.name || '');
          const rawExt = path.extname(rawName).toLowerCase();
          let entryName = rawName.split(/[\\/]/).pop() || '';
          if (entryName === '.' || entryName === '..') entryName = '';
          if (!entryName) {
            // 兜底扩展名仅接受常规 `.xxx` 形式：path.extname 对 '..'/'a..' 这类
            // 仅由点号组成的名字会返回 '.'/'..' 退化值，直接拼接会产生尾点文件名
            const fallbackExt = /^\.[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
            entryName = `file-${entryIdx + 1}${fallbackExt}`;
          }
          if (usedEntryNames.has(entryName)) {
            const ext = path.extname(entryName);
            const stem = entryName.slice(0, entryName.length - ext.length);
            let seq = 2;
            while (usedEntryNames.has(`${stem}(${seq})${ext}`)) seq++;
            entryName = `${stem}(${seq})${ext}`;
          }
          usedEntryNames.add(entryName);
          zipEntries.push({ entryPath, entryName });
        }

        // H2：动态 import archiver（消除模块加载期硬依赖）。必须在 writeHead 之前
        // 完成——响应头未发出时才能返回 JSON 结构化错误体；失败 500 而非崩溃。
        let ZipArchive;
        try {
          ({ ZipArchive } = await import('archiver'));
        } catch (archiverErr) {
          logger.error('Failed to load archiver module', {
            error: archiverErr.message,
            itemId: id,
          });
          return res.status(500).json({ error: 'Zip packaging is unavailable on this server' });
        }

        const zipName = metadata?.originalName ? `${metadata.originalName}.zip` : `${id}.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(zipName)}"`,
        });

        const archive = new ZipArchive({ zlib: { level: 1 } });
        // archive 内部逐文件 createReadStream，读盘/压缩错误统一走 'error' → 销毁连接
        archive.on('error', (archiveErr) => {
          logger.error('Zip archive error', { error: archiveErr.message, itemId: id });
          res.destroy();
        });
        archive.on('warning', (warnErr) => {
          logger.warn('Zip archive warning', { error: warnErr.message, itemId: id });
        });
        // 客户端中断（连接关闭且响应未写完）：中止归档，防止内部文件流继续读取（fd 泄漏）
        res.on('close', () => {
          if (!res.writableEnded) {
            logger.warn('Zip download aborted by client', { itemId: id });
            archive.abort();
          }
        });

        for (const { entryPath, entryName } of zipEntries) {
          archive.file(entryPath, { name: entryName });
        }
        archive.pipe(res);
        // 必须显式 finalize：宣告条目追加完毕，写出 central directory 并结束归档，
        // 否则响应永不结束（客户端超时挂起）
        archive.finalize();
        return;
      }
    }

    let filePath;
    if (item.content_type === 'image') {
      if (filename && filename.startsWith('data:image')) {
        const matches = filename.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          const mime = matches[1];
          const buffer = Buffer.from(matches[2], 'base64');
          res.set('Content-Type', mime);
          res.set('Content-Length', buffer.length);
          res.set('Content-Disposition', `inline; filename="image.${mime.split('/')[1] || 'png'}"`);
          return res.send(buffer);
        }
      }
      filePath = path.join(IMAGE_DIR, filename);
    } else if (item.content_type === 'file') {
      filePath = path.join(FILE_DIR, filename);
    } else {
      return res.status(400).json({ error: 'This content type does not support download' });
    }

    // Check file exists
    // 注意：filename 为空时 path.join(IMAGE_DIR, '') 会拼出目录本身，而 fs.access(目录)
    // 同样返回成功，随后 createReadStream 读目录会抛 EISDIR。该错误走流的 'error' 事件
    // 而非 throw，try/catch 接不住；若不监听就会 uncaughtException 崩掉整个后端进程。
    //（isReadableFileOnDisk 与原内联检查等价：目录 stat.isFile() === false → 404）
    if (!(await isReadableFileOnDisk(filePath))) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    await serveFileWithRange(req, res, filePath, {
      mimeType: metadata?.mimeType,
      downloadName: metadata?.originalName,
    });
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

    // 如果是 dataURL 图片（如桌面端上传的剪贴板截图），直接从 base64 内存实时生成缩略图
    if (item.content_encrypted && item.content_encrypted.startsWith('data:image')) {
      const matches = item.content_encrypted.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const buffer = Buffer.from(matches[2], 'base64');
        const thumb = await sharp(buffer)
          .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 92 })
          .toBuffer();
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(thumb);
      }
    }

    // Serve thumbnail
    // 注意（崩溃根因）：metadata.thumbnail 为空时，path.join(..., 'thumbnails', '')
    // 会拼出 thumbnails 目录本身，而 fs.access(目录) 同样返回成功，随后
    // createReadStream 读目录即抛 EISDIR。该错误走流的 'error' 事件而非 throw，
    // try/catch 接不住；若无 .on('error') 监听就会 uncaughtException 崩掉整个后端进程。
    const thumbName = metadata?.thumbnail;
    const thumbPath = thumbName ? path.join(IMAGE_DIR, 'thumbnails', thumbName) : null;
    let served = false;

    if (thumbPath) {
      try {
        await fs.access(thumbPath);
        const thumbStat = await fs.stat(thumbPath);
        if (thumbStat.isFile()) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          const { createReadStream } = await import('fs');
          createReadStream(thumbPath)
            .on('error', (streamErr) => {
              logger.error('Preview thumbnail stream error', {
                error: streamErr.message,
                thumbPath,
              });
              res.destroy();
            })
            .pipe(res);
          served = true;
        }
      } catch {
        /* 缩略图不可用，回退到原图 */
      }
    }

    if (!served) {
      // Fallback to full image
      const imgName = item.content_encrypted;
      const imgPath = imgName ? path.join(IMAGE_DIR, imgName) : null;
      try {
        if (imgPath) {
          await fs.access(imgPath);
          const imgStat = await fs.stat(imgPath);
          if (imgStat.isFile()) {
            res.setHeader('Content-Type', metadata?.mimeType || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            const { createReadStream } = await import('fs');
            createReadStream(imgPath)
              .on('error', (streamErr) => {
                logger.error('Preview image stream error', {
                  error: streamErr.message,
                  imgPath,
                });
                res.destroy();
              })
              .pipe(res);
            served = true;
          }
        }
      } catch {
        /* 落到 404 */
      }

      if (!served) {
        return res.status(404).json({ error: 'Image not found' });
      }
    }
  } catch (err) {
    logger.error('Preview error', { error: err.message });
    res.status(500).json({ error: 'Preview failed' });
  }
});

// Text/code previewable extensions and their MIME types
// M-3：扩充常见代码/文本扩展（tsx jsx vue swift kt rb lua cs php），
// 去重合并保留既有条目——白名单外代码扩展名此前预览退化为文件名。
export const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.js', '.ts', '.tsx', '.jsx', '.vue', '.py', '.java', '.c', '.cpp', '.h',
  '.go', '.rs', '.cs', '.php', '.swift', '.kt', '.rb', '.lua',
  '.html', '.css', '.sh', '.sql', '.log', '.ini', '.conf', '.env',
  '.toml', '.cfg', '.properties', '.gitignore', '.dockerfile',
]);

const CODE_SYNTAX_MAP = {
  '.js': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
  '.py': 'python', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
  '.go': 'go', '.rs': 'rust', '.html': 'html', '.css': 'css',
  '.sh': 'bash', '.sql': 'sql', '.json': 'json', '.xml': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.md': 'markdown', '.csv': 'csv',
  '.toml': 'toml', '.ini': 'ini', '.conf': 'conf',
  // M-3：与 TEXT_PREVIEW_EXTENSIONS 扩充对齐，新扩展名 language 字段不再是 'text'
  '.vue': 'vue', '.swift': 'swift', '.kt': 'kotlin', '.rb': 'ruby',
  '.lua': 'lua', '.cs': 'csharp', '.php': 'php',
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

    // F1.3：多文件条目（metadata.files，F1.2 契约）支持 ?fileIndex=n——缺省时与改造前
    // 完全一致（metadata.extension / content_encrypted 均为首文件口径）；fileIndex 指定
    // 时预览对应文件（落盘名 files[n].fileId，扩展名/展示名取 files[n].name）。
    let ext = (metadata?.extension || '').toLowerCase();
    let storedName = item.content_encrypted;
    let previewFileName = metadata?.originalName || item.content_preview;

    if (Array.isArray(metadata?.files) && req.query.fileIndex !== undefined) {
      const idx = parseFileIndex(req.query.fileIndex, metadata.files.length);
      if (idx === -1) {
        return res.status(400).json({ error: 'Invalid fileIndex' });
      }
      const entry = metadata.files[idx];
      if (!isSafeStoredFilename(entry?.fileId)) {
        return res.status(404).json({ error: 'File not found on disk' });
      }
      storedName = entry.fileId;
      ext = path.extname(String(entry?.name || '')).toLowerCase();
      previewFileName = entry?.name || previewFileName;
    }

    if (!TEXT_PREVIEW_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: 'This file type does not support text preview', ext });
    }

    const filePath = path.join(FILE_DIR, storedName);
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
      fileName: previewFileName,
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
      await fs.unlink(imgPath).catch(() => {});
      // F1.3 加固：缩略图名经安全文件名校验后再删（空值 / 含路径注入时跳过，防误删目录外文件）
      if (isSafeStoredFilename(metadata?.thumbnail || '')) {
        await fs.unlink(path.join(IMAGE_DIR, 'thumbnails', metadata.thumbnail)).catch(() => {});
      }
    } else if (item.content_type === 'file') {
      // F1.3：多文件条目需删除全部落盘文件——复用 fileRetentionCleanup.deleteStoredClipFiles：
      // 覆盖 content_encrypted（首文件落盘名）+ metadata.files[].fileId 逐个（Set 去重），
      // 均经 isSafeStoredFilename 口径校验（无路径分隔符、非 data:、basename 归一化等值，
      // 杜绝 path traversal），单个 unlink 失败不中断。旧单文件条目（无 metadata.files）
      // 只删 content_encrypted，与改造前行为一致。
      await deleteStoredClipFiles(item);
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
