import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import config from '../config.js';
import { logger } from '../utils/logger.js';
import { issueRefreshToken } from '../utils/refreshToken.js';
import { logAuditEvent } from '../utils/audit.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import {
  OAUTH_PROVIDERS,
  getOAuthConfig,
  listProviders,
  startDeviceFlow,
  pollDeviceFlow,
  fetchProviderProfile,
  resolveOrCreateUser,
} from '../services/oauthDevice.js';

/**
 * 第三方登录（设备码流）· 迁移 089
 *
 * 三条端点：
 *   GET  /api/auth/oauth/providers        —— 哪些 provider 已配置（前端据此显示/隐藏按钮）
 *   POST /api/auth/oauth/:provider/start  —— 拿 user_code + verification_uri（内含 opaque pollToken）
 *   POST /api/auth/oauth/:provider/poll   —— 轮询；授权成功后签发本站会话（token/sessionId/refreshToken）
 *
 * 设计取舍：
 *   - **不返回 device_code**：它是轮询密钥，加密进 pollToken（见 services/oauthDevice.js 顶部说明）。
 *   - 轮询频率由服务端按 provider 给的 interval 提示，前端据此节流；这里再挂一层 IP 限流兜底。
 *   - 未配置的 provider ⇒ 明确 409（前端也不会显示入口，双保险，避免"点了没反应"）。
 */

const router = Router();

/** 轮询限流：60 次/分钟/IP（设备码间隔通常 5s，够多标签页用；同时挡住暴力轮询）
 *  storeName 独立：不与其他限流器共用计数器，避免互相干扰 */
const oauthPollLimiter = createRateLimiter({ windowMs: 60_000, max: 60, storeName: 'oauthPoll' });

/** 签发本站会话（与验证码登录同一口径：user_sessions + JWT + refreshToken） */
async function issueSession(user, req) {
  const sessionId = uuidv4();
  const deviceName = req.body?.deviceName || 'OAuth 登录';
  const deviceType = req.body?.deviceType || 'desktop';
  const platform = req.body?.platform || 'unknown';
  const ipAddress = req.ip || req.connection?.remoteAddress;
  const userAgent = req.get('User-Agent') || '';

  await pool.query(
    `INSERT INTO user_sessions (id, user_id, device_name, device_type, platform, ip_address, user_agent, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
    [sessionId, user.id, deviceName, deviceType, platform, ipAddress, userAgent]
  );

  const token = jwt.sign(
    { userId: user.id, phone: user.phone, email: user.email, sessionId, jti: sessionId },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
  const refreshToken = await issueRefreshToken(user.id, sessionId);
  return { token, sessionId, refreshToken };
}

function assertProvider(req, res) {
  const provider = String(req.params.provider || '').toLowerCase();
  if (!OAUTH_PROVIDERS.includes(provider)) {
    res.status(404).json({ code: 40404, message: '不支持的第三方登录方式' });
    return null;
  }
  return provider;
}

/** GET /api/auth/oauth/providers —— 前端据此决定显示哪些登录入口 */
router.get('/providers', async (_req, res) => {
  try {
    const cfg = await getOAuthConfig();
    return res.json({ providers: listProviders(cfg) });
  } catch (err) {
    logger.error('[oauth] providers failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '读取第三方登录配置失败' });
  }
});

/** POST /api/auth/oauth/:provider/start */
router.post('/:provider/start', async (req, res) => {
  const provider = assertProvider(req, res);
  if (!provider) return undefined;
  try {
    const result = await startDeviceFlow(provider);
    if (!result.ok) {
      const message =
        result.reason === 'not_configured'
          ? `未配置 ${provider} 登录（管理台 → 系统设置 → 第三方登录）`
          : `发起 ${provider} 登录失败：${result.detail || result.reason}`;
      return res.status(409).json({ code: 4090, message });
    }
    // ⚠️ 只回 userCode / 链接 / pollToken；device_code 与 client_id 都不外发
    return res.json({
      code: 0,
      data: {
        provider,
        userCode: result.userCode,
        pollToken: result.pollToken,
        verificationUri: result.verificationUri,
        verificationUriComplete: result.verificationUriComplete,
        expiresIn: result.expiresIn,
        interval: result.interval,
        message: result.message,
      },
      message: '请按提示在浏览器中完成授权',
    });
  } catch (err) {
    logger.error('[oauth] start failed', { provider, error: err.message });
    return res.status(500).json({ code: 5000, message: '发起第三方登录失败' });
  }
});

/** POST /api/auth/oauth/:provider/poll */
router.post('/:provider/poll', oauthPollLimiter, async (req, res) => {
  const provider = assertProvider(req, res);
  if (!provider) return undefined;
  try {
    const pollToken = typeof req.body?.pollToken === 'string' ? req.body.pollToken : '';
    if (!pollToken) return res.status(400).json({ code: 40002, message: '缺少 pollToken' });

    const polled = await pollDeviceFlow(provider, pollToken);
    // 诊断（临时）：非 pending 中间态一律记下来（pending 由 services 侧记，含 userCode）
    if (!polled.ok && polled.reason !== 'pending' && polled.reason !== 'slow_down') {
      logger.warn('[oauth] poll 非 pending 结果', {
        provider,
        reason: polled.reason,
        detail: polled.detail,
      });
    }
    if (polled.ok) logger.info('[oauth] poll 已拿到 access token', { provider });
    if (!polled.ok) {
      // pending / slow_down 是**正常中间态**：用 200 + status 表达，避免前端把 4xx 当失败弹错
      if (polled.reason === 'pending' || polled.reason === 'slow_down') {
        return res.json({ code: 0, data: { status: polled.reason }, message: '等待授权' });
      }
      const message =
        polled.reason === 'expired'
          ? '二维码/验证码已过期，请重新发起'
          : polled.reason === 'denied'
            ? '你取消了授权'
            : polled.reason === 'invalid_poll_token'
              ? '会话标识无效，请重新发起'
              : `授权失败：${polled.detail || polled.reason}`;
      return res.status(409).json({ code: 4090, message });
    }

    const profile = await fetchProviderProfile(provider, polled.accessToken);
    if (!profile.ok) {
      return res.status(409).json({ code: 4090, message: `获取 ${provider} 账号资料失败：${profile.detail || profile.reason}` });
    }

    const resolved = await resolveOrCreateUser(provider, profile);
    if (!resolved.ok) {
      return res.status(409).json({ code: 4090, message: '关联账号失败，请改用手机号登录' });
    }
    const user = resolved.user;
    if (user?.is_active === false) {
      return res.status(403).json({ code: 40301, message: '账号已停用' });
    }

    const session = await issueSession(user, req);

    await logAuditEvent({
      userId: user.id,
      action: 'oauth.login',
      resourceType: 'user',
      resourceId: user.id,
      details: {
        provider,
        providerUserId: profile.providerUserId,
        accountCreated: resolved.created,
        linkedExisting: resolved.linkedExisting,
        email: profile.email || undefined,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[oauth] 登录成功', {
      provider,
      userId: user.id,
      created: resolved.created,
      linkedExisting: resolved.linkedExisting,
    });

    return res.json({
      code: 0,
      data: {
        status: 'authorized',
        token: session.token,
        sessionId: session.sessionId,
        refreshToken: session.refreshToken,
        user: {
          id: user.id,
          phone: user.phone,
          email: user.email || null,
          nickname: user.nickname || null,
        },
        accountCreated: resolved.created,
        linkedExisting: resolved.linkedExisting,
      },
      message: resolved.created ? '账号已创建并登录' : linkedExistingNote(resolved),
    });
  } catch (err) {
    logger.error('[oauth] poll failed', { provider, error: err.message });
    return res.status(500).json({ code: 5000, message: '第三方登录轮询失败' });
  }
});

function linkedExistingNote(resolved) {
  return resolved.linkedExisting ? '已关联到既有账号并登录' : '登录成功';
}

export default router;
