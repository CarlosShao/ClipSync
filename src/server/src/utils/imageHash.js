import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_BASE = path.join(__dirname, '../../uploads');

/**
 * E2E 条目判定（协议 docs/plans/e2e-protocol.md §2）：metadata.e2e 存在即端到端加密条目，
 * content_encrypted 为密文、preview 为 "[E2E]" 占位，服务端一切消费内容明文的功能
 * （哈希/查重/OCR 等）必须对这类条目跳过；不存在则按旧明文条目走原逻辑。
 */
export function isE2eItem(metadata) {
  return !!metadata?.e2e;
}

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

/**
 * 计算剪贴板图片的内容哈希（基于明文字节，跨复制去重用）。
 * E2E 守卫：E2E 条目（metadata.e2e 存在）的 content_encrypted 是密文，对其哈希既无意义
 * 又会污染明文图片查重库（协议 §6），直接返回 null 跳过。
 * 调用方应传入条目 metadata 以启用跳过；未传 metadata 时无法判定，按原逻辑处理。
 */
export async function hashImageStored(stored, metadata) {
  if (isE2eItem(metadata)) return null;
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
 * 从 AI 消息数组中提取所有图片 data URL，以及前端可能提供的原图哈希。
 * 兼容 OpenAI 多模态 content 数组、前端 images 数组与字符串内嵌 data URL。
 * 返回 { url, hash? }[]；hash 为空时由调用方自行计算。
 */
export function extractImageHashes(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (!msg || msg.role !== 'user') continue;

    // 前端多模态消息里的 images 数组（AiChatInput 粘贴的截图）
    // 注意：前端 images[].data 是裸 base64，需要根据 mime 拼接成 data URL。
    if (Array.isArray(msg.images)) {
      for (const img of msg.images) {
        if (!img || typeof img.data !== 'string') continue;
        let url = img.data;
        if (!url.startsWith('data:image/')) {
          const mime = img.mime || 'image/png';
          url = `data:${mime};base64,${img.data}`;
        }
        out.push({ url, hash: img.hash || msg.imageHash || null });
      }
    }

    // OpenAI 风格 content 数组 / 字符串内嵌 data URL
    const c = msg.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && part.type === 'image_url' && typeof part.image_url?.url === 'string') {
          out.push({ url: part.image_url.url, hash: msg.imageHash || null });
        }
      }
    } else if (typeof c === 'string') {
      const re = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g;
      const found = c.match(re);
      if (found) {
        for (const url of found) out.push({ url, hash: msg.imageHash || null });
      }
    }
  }
  return out;
}

export function extractImageDataUrls(messages) {
  return extractImageHashes(messages).map((entry) => entry.url);
}
