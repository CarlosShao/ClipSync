/**
 * 可配置存储服务
 *
 * 通过 STORAGE_TYPE 环境变量切换存储后端：
 *   - local: 本地磁盘（开发/测试）
 *   - s3: 阿里云 OSS / 腾讯 COS / AWS S3（生产）
 *
 * 不设置 STORAGE_TYPE 时默认使用 local。
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

const STORAGE_TYPE = process.env.STORAGE_TYPE || 'local';

// ===== Local Storage =====

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(import.meta.dirname, '../../uploads');
const CHUNK_DIR = path.join(UPLOAD_DIR, 'chunks');

async function ensureDirs() {
  await fs.mkdir(CHUNK_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

const localStorage = {
  async init() {
    await ensureDirs();
    logger.info('[Storage] Using local storage:', { uploadDir: UPLOAD_DIR });
  },

  async writeChunk(uploadId, chunkIndex, data) {
    const chunkDir = path.join(CHUNK_DIR, uploadId);
    await fs.mkdir(chunkDir, { recursive: true });
    const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
    await fs.writeFile(chunkPath, data);
  },

  async readChunk(uploadId, chunkIndex) {
    const chunkPath = path.join(CHUNK_DIR, uploadId, `chunk_${chunkIndex}`);
    return await fs.readFile(chunkPath);
  },

  async mergeChunks(uploadId, totalChunks, filename, ext) {
    const mergedPath = path.join(UPLOAD_DIR, `${uploadId}${ext}`);
    const writeStream = (await import('fs')).createWriteStream(mergedPath);

    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(CHUNK_DIR, uploadId, `chunk_${i}`);
      const chunkData = await fs.readFile(chunkPath);
      writeStream.write(chunkData);
    }

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      writeStream.end();
    });

    // Clean up chunks
    await fs.rm(path.join(CHUNK_DIR, uploadId), { recursive: true, force: true });

    return mergedPath;
  },

  async deleteFile(filePath) {
    try { await fs.unlink(filePath); } catch { /* ignore */ }
  },

  async getFileSize(filePath) {
    try {
      const stat = await fs.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  },

  async getFilePath(filename) {
    return path.join(UPLOAD_DIR, filename);
  },
};

// ===== S3 Storage (阿里云 OSS / 腾讯 COS / AWS S3) =====

let s3Client = null;
let s3Bucket = '';

async function initS3() {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');

  s3Bucket = process.env.S3_BUCKET || '';
  const region = process.env.S3_REGION || 'auto';
  const endpoint = process.env.S3_ENDPOINT || undefined;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || '';

  s3Client = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // 阿里云 OSS / 腾讯 COS 兼容 S3 协议
    forcePathStyle: !!endpoint,
  });

  logger.info('[Storage] Using S3 storage:', { bucket: s3Bucket, region, endpoint: endpoint || '(default)' });
}

const s3Storage = {
  async init() {
    await initS3();
  },

  async writeChunk(uploadId, chunkIndex, data) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const key = `chunks/${uploadId}/chunk_${chunkIndex}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: data,
    }));
  },

  async readChunk(uploadId, chunkIndex) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const key = `chunks/${uploadId}/chunk_${chunkIndex}`;
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: s3Bucket,
      Key: key,
    }));
    return await response.Body.transformToByteArray();
  },

  async mergeChunks(uploadId, totalChunks, filename, ext) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    // S3 没有真正的 merge，直接组装完整数据上传
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = await s3Storage.readChunk(uploadId, i);
      chunks.push(chunk);
    }

    const merged = Buffer.concat(chunks);
    const key = `files/${uploadId}${ext}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: merged,
    }));

    // Clean up chunks
    await s3Storage.deleteChunks(uploadId);

    return key; // 返回 S3 key 而非本地路径
  },

  async deleteChunks(uploadId) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    // S3 没有批量删除，逐个删除（或用 deleteObjects）
    for (let i = 0; i < 100; i++) { // 最多100个分片
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: s3Bucket,
          Key: `chunks/${uploadId}/chunk_${i}`,
        }));
      } catch {
        break; // 分片不存在，停止
      }
    }
  },

  async deleteFile(key) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await s3Client.send(new DeleteObjectCommand({
      Bucket: s3Bucket,
      Key: key,
    }));
  },

  async getFileSize(key) {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const response = await s3Client.send(new HeadObjectCommand({
        Bucket: s3Bucket,
        Key: key,
      }));
      return response.ContentLength || 0;
    } catch {
      return 0;
    }
  },

  async getFilePath(filename) {
    // S3 返回 URL 而非本地路径
    const endpoint = process.env.S3_ENDPOINT || `https://${s3Bucket}.s3.${process.env.S3_REGION || 'auto'}.amazonaws.com`;
    return `${endpoint}/files/${filename}`;
  },
};

// ===== Export =====

const storage = STORAGE_TYPE === 's3' ? s3Storage : localStorage;

export async function initStorage() {
  await storage.init();
}

export async function writeChunk(uploadId, chunkIndex, data) {
  return storage.writeChunk(uploadId, chunkIndex, data);
}

export async function readChunk(uploadId, chunkIndex) {
  return storage.readChunk(uploadId, chunkIndex);
}

export async function mergeChunks(uploadId, totalChunks, filename, ext) {
  return storage.mergeChunks(uploadId, totalChunks, filename, ext);
}

export async function deleteChunks(uploadId) {
  if (storage.deleteChunks) {
    return storage.deleteChunks(uploadId);
  }
  // local storage: mergeChunks 已经清理了
}

export async function deleteFile(filePath) {
  return storage.deleteFile(filePath);
}

export async function getFileSize(filePath) {
  return storage.getFileSize(filePath);
}

export async function getFilePath(filename) {
  return storage.getFilePath(filename);
}
