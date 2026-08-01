import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_BASE = path.join(__dirname, '../../uploads');

/**
 * 将剪贴板存储值（data URL / 裸 base64 / 磁盘文件名）还原为图片字节。
 * 与 aiOcr.resolveImageDataUrl 逻辑对齐，但返回 Buffer（用于哈希）。
 */
async function resolveImageBytes(stored) {
  if (!stored || typeof stored !== 'string') return null;

  // data URL：data:image/png;base64,xxxxx
  const m = /^data:[^;]+;base64,(.*)$/s.exec(stored);
  if (m) {
    try { return Buffer.from(m[1], 'base64'); } catch { return null; }
  }

  // 裸 base64
  if (/^[A-Za-z0-9+/=+\r\n]+$/.test(stored.slice(0, 64))) {
    try { return Buffer.from(stored.replace(/\s+/g, ''), 'base64'); } catch { return null; }
  }

  // 磁盘文件（UPLOAD_BASE 下的 images / files）
  for (const sub of ['images', 'files', '']) {
    try {
      return await fs.promises.readFile(path.join(UPLOAD_BASE, sub, stored));
    } catch { /* 尝试下一个目录 */ }
  }
  return null;
}

/** 计算剪贴板图片的内容哈希（基于明文字节，跨复制去重用）。 */
export async function hashImageStored(stored) {
  const buf = await resolveImageBytes(stored);
  return buf ? crypto.createHash('sha256').update(buf).digest('hex') : null;
}

/** 从 AI 消息里的图片 data URL（或裸 base64）直接计算内容哈希。 */
export function hashImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  let b64 = null;
  const m = /^data:[^;]+;base64,(.*)$/s.exec(dataUrl);
  if (m) b64 = m[1];
  else if (/^[A-Za-z0-9+/=+\r\n]+$/.test(dataUrl.slice(0, 80))) b64 = dataUrl.replace(/\s+/g, '');
  if (!b64) return null;
  try {
    return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 从 AI 消息数组中提取所有图片 data URL。
 * 兼容 OpenAI 多模态 content 数组（[{type:'image_url',image_url:{url}}]）与字符串内嵌 data URL。
 */
export function extractImageDataUrls(messages) {
  const urls = [];
  for (const msg of messages || []) {
    const c = msg && msg.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && part.type === 'image_url' && typeof part.image_url?.url === 'string') {
          urls.push(part.image_url.url);
        }
      }
    } else if (typeof c === 'string') {
      const re = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g;
      const found = c.match(re);
      if (found) urls.push(...found);
    }
  }
  return urls;
}
