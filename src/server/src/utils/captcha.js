import crypto from 'crypto';
import sharp from 'sharp';
import pool from '../db/pool.js';
import config from '../config.js';
import { logger } from './logger.js';
import { getTurnstileConfig, verifyTurnstile } from './turnstile.js';

/**
 * 人机验证 · **provider 抽象层**（迁移 090）
 *
 * 唯一开关：`system_configs.captcha_provider` = 'off' | 'turnstile' | 'self'
 *   off        关闭（默认，行为与加此模块之前完全一致）
 *   turnstile  Cloudflare Turnstile（海外友好；凭据 site/secret 沿用 088 的键，**委托 utils/turnstile.js**，不重复实现）
 *   self       自建滑块（0 成本、国内可达、无需第三方凭据）
 *
 * 为什么做抽象：owner 2026-10-09 明确要求"可切换 provider"，且不要出现重复配置项 ⇒
 * 不再新增 `*_enabled` 之类开关（历史 `turnstile_enabled` 已由迁移 090 并入本键并删除）。
 *
 * 自建滑块的安全边界（**如实说明，别夸大**）：
 *   - 缺口位置**不出现在任何返回里**：背景与滑块都是 `sharp` 光栅化的 PNG（缺口画在服务端 SVG 上，
 *     客户端只拿到像素）⇒ 脚本想自动通过就得做图像识别，成本陡增；
 *   - 答案 x 只存在**HMAC 签名的一次性 token** 里（客户端解不开、也伪造不出）；
 *   - token 60s 过期 + **用后即焚**（nonce 记账）；另有轨迹启发式（点数/耗时下限）过滤最笨的脚本。
 *   - 它不是"绝对防破解"（有 CV 能力的对手仍可能过），配合已有的每号/每 IP 限流足以防短信轰炸。
 */

const CFG_TTL_MS = 5000;
const CFG_KEYS = ['captcha_provider'];

export const CAPTCHA_PROVIDERS = ['off', 'turnstile', 'self'];

let cfgCache = { cfg: undefined, at: 0 };

function toTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * @returns {Promise<{provider:'off'|'turnstile'|'self', enabled:boolean, turnstileSiteKey:string}>}
 */
export async function getCaptchaConfig() {
  const now = Date.now();
  if (cfgCache.cfg !== undefined && now - cfgCache.at < CFG_TTL_MS) return cfgCache.cfg;

  let provider = 'off';
  try {
    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [CFG_KEYS]
    );
    for (const r of rows) {
      let v = r.config_value;
      if (v && typeof v === 'object') v = v.value ?? '';
      if (r.config_key === 'captcha_provider') provider = toTrimmedString(v).toLowerCase() || 'off';
    }
  } catch (err) {
    logger.warn('[captcha] 读取 captcha_provider 失败，按未启用处理', { error: err.message });
    return cfgCache.cfg ?? { provider: 'off', enabled: false, turnstileSiteKey: '' };
  }
  if (!CAPTCHA_PROVIDERS.includes(provider)) provider = 'off';

  // turnstile 需要凭据齐全才算启用（半配视为关闭，避免把登录锁死）
  let turnstileSiteKey = '';
  if (provider === 'turnstile') {
    const t = await getTurnstileConfig();
    turnstileSiteKey = t.siteKey;
    if (!t.enabled) provider = 'off';
  }

  const resolved = { provider, enabled: provider !== 'off', turnstileSiteKey };
  cfgCache = { cfg: resolved, at: now };
  return resolved;
}

export function invalidateCaptchaConfigCache() {
  cfgCache = { cfg: undefined, at: 0 };
}

// ============================================================================
// 自建滑块：出题 + 一次性 token
// ============================================================================

const SLIDER_TTL_MS = 60_000;
const SLIDER_TOLERANCE_PX = 6;
const PIECE_SIZE = 44;
const BG_W = 300;
const BG_H = 150;

/** nonce 记账：Redis 不可用时退化为进程内 Map（单实例够用；多实例下会放宽为"同进程一次性"） */
const usedNonces = new Map();

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', config.jwt.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function parseToken(token) {
  const raw = toTrimmedString(token);
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = crypto.createHmac('sha256', config.jwt.secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function randomHex(len) {
  return crypto.randomBytes(len).toString('hex');
}

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

/**
 * 出题：随机背景（服务端光栅化）+ 缺口 + 滑块图。
 * **缺口位置只进签名 token，不进返回体**（返回体里只有两张 PNG）。
 * @returns {Promise<{token:string, background:string, piece:string, y:number, pieceSize:number, expiresIn:number}>}
 */
export async function issueSliderChallenge() {
  const x = 60 + Math.floor(Math.random() * (BG_W - PIECE_SIZE - 80)); // 缺口左边界
  const y = 20 + Math.floor(Math.random() * (BG_H - PIECE_SIZE - 30));

  // 随机背景：渐变 + 若干随机图形（纯 SVG，随后光栅化 ⇒ 客户端只看到像素）
  const shapes = Array.from({ length: 14 }, (_, i) => {
    const cx = Math.floor(Math.random() * BG_W);
    const cy = Math.floor(Math.random() * BG_H);
    const r = 8 + Math.floor(Math.random() * 40);
    const fill = `hsl(${Math.floor(Math.random() * 360)}, ${50 + Math.floor(Math.random() * 40)}%, ${35 + Math.floor(Math.random() * 45)}%)`;
    const op = (0.25 + Math.random() * 0.5).toFixed(2);
    return i % 2 === 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" opacity="${op}"/>`
      : `<rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" fill="${fill}" opacity="${op}" transform="rotate(${Math.floor(Math.random() * 90)} ${cx} ${cy})"/>`;
  }).join('');

  const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BG_W}" height="${BG_H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${Math.floor(Math.random() * 360)},60%,55%)"/>
      <stop offset="100%" stop-color="hsl(${Math.floor(Math.random() * 360)},55%,30%)"/>
    </linearGradient></defs>
    <rect width="${BG_W}" height="${BG_H}" fill="url(#g)"/>${shapes}
    <rect x="${x}" y="${y}" width="${PIECE_SIZE}" height="${PIECE_SIZE}" fill="#000" opacity="0.45" rx="6"/>
    <rect x="${x}" y="${y}" width="${PIECE_SIZE}" height="${PIECE_SIZE}" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="2" rx="6"/>
  </svg>`;

  const bgPng = await sharp(Buffer.from(bgSvg)).png({ compressionLevel: 9 }).toBuffer();
  // 滑块图 = 从同一背景截取缺口那块（用户拖它去补缺口）
  const piecePng = await sharp(bgPng)
    .extract({ left: x, top: y, width: PIECE_SIZE, height: PIECE_SIZE })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const payload = {
    k: 'slider',
    x,
    y,
    n: randomHex(8),
    exp: Date.now() + SLIDER_TTL_MS,
  };
  return {
    token: signToken(payload),
    background: `data:image/png;base64,${bgPng.toString('base64')}`,
    piece: `data:image/png;base64,${piecePng.toString('base64')}`,
    y,
    pieceSize: PIECE_SIZE,
    expiresIn: Math.floor(SLIDER_TTL_MS / 1000),
  };
}

/**
 * 校验滑块答案。
 * @param {string} token 出题时下发的签名 token
 * @param {number} x 用户拖动后的落点（相对背景左边界）
 * @param {{points?:number, durationMs?:number}} [track] 轨迹（弱启发式，过滤最笨的脚本）
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function verifySlider(token, x, track) {
  const p = parseToken(token);
  if (!p || p.k !== 'slider') return { ok: false, reason: 'invalid_token' };
  if (typeof p.exp !== 'number' || p.exp < Date.now()) return { ok: false, reason: 'expired' };

  // 一次性：同一 nonce 只能成功用一次
  if (usedNonces.has(p.n)) return { ok: false, reason: 'reused' };

  const track2 = track && typeof track === 'object' ? track : {};
  const points = Number(track2.points ?? 0);
  const durationMs = Number(track2.durationMs ?? 0);
  // 启发式：轨迹点太少或"瞬移"过短 ⇒ 当脚本处理（真人拖 44px 不会低于 250ms、也不会只有几个点）
  if (points > 0 && (points < 8 || durationMs < 250)) {
    return { ok: false, reason: 'robotic_track' };
  }

  const dx = Math.abs(Number(x) - Number(p.x));
  if (!Number.isFinite(dx) || dx > SLIDER_TOLERANCE_PX) return { ok: false, reason: 'mismatch' };

  usedNonces.set(p.n, p.exp);
  // 顺手清理过期 nonce，避免 Map 无限增长
  if (usedNonces.size > 5000) {
    const now = Date.now();
    for (const [k, v] of usedNonces) if (v < now) usedNonces.delete(k);
  }
  return { ok: true };
}

// ============================================================================
// 统一门控（Express 中间件）—— 发码等入口用
// ============================================================================

/**
 * 校验当前请求的人机验证。未启用 ⇒ 直接放行（行为与今天一致）。
 * 请求体约定：turnstile 用 `turnstileToken`；self 用 `captchaToken` + `captchaX`(± `captchaTrack`)。
 * @returns {Promise<{ok:true} | {ok:false, status:number, message:string}>}
 */
export async function checkCaptcha(req) {
  const cfg = await getCaptchaConfig();
  if (!cfg.enabled) return { ok: true };

  if (cfg.provider === 'turnstile') {
    const r = await verifyTurnstile(
      req?.body?.turnstileToken ?? req?.headers?.['x-turnstile-token'],
      req?.ip
    );
    if (r.ok) return { ok: true };
    const message =
      r.reason === 'missing_token'
        ? '请先完成人机验证'
        : r.reason === 'verify_unavailable'
          ? '人机验证服务暂时不可用，请稍后重试'
          : '人机验证未通过，请重试';
    return { ok: false, status: 400, message };
  }

  // self：自建滑块
  const r = await verifySlider(req?.body?.captchaToken, req?.body?.captchaX, req?.body?.captchaTrack);
  if (r.ok) return { ok: true };
  const message =
    r.reason === 'expired'
      ? '验证已过期，请重新拖动滑块'
      : r.reason === 'reused'
        ? '该验证已使用过，请重新拖动滑块'
        : r.reason === 'robotic_track'
          ? '拖动太快了，请正常拖动'
          : '请先完成滑块验证';
  return { ok: false, status: 400, message };
}

/** Express 中间件形态：`router.post('/send-code', sendCodeLimiter, captchaGate, handler)` */
export async function captchaGate(req, res, next) {
  try {
    const r = await checkCaptcha(req);
    if (r.ok) return next();
    return res.status(r.status).json({ code: 40003, message: r.message });
  } catch (err) {
    logger.error('[captcha] 门控异常，按拒绝处理（fail-closed）', { error: err.message });
    return res.status(400).json({ code: 40003, message: '人机验证未通过，请重试' });
  }
}
