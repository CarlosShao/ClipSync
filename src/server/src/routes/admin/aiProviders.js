// =============================================
// Admin Console · AI 平台管理（AN-03）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/ai-providers', aiProvidersAdminRouter)
//     → GET   /api/admin/ai-providers      全量供应商列表（脱敏：仅 has_key 布尔 + 用户手机号打码）
//     → PATCH /api/admin/ai-providers/:id  部分更新（启停 enabled / name / model / base_url）
//
// 说明：ai_providers 为 BYOK（Bring Your Own Key）表，每行绑定 user_id（024 迁移），
//   不存在"平台级供应商"，故不提供 POST / DELETE（管理台代用户创建/删除密钥属高危且
//   无对应产品语义）；管理台核心能力 = 禁用/启用 + 元数据修正。
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 本文件细粒度权限：全部端点 requirePerm('admin.ai.manage')
//   （062 迁移新增该键，仅授予 super_admin；roles.js PERM_CATALOG 未登记，
//   权限页不出现该键，与 admin.email_channels.manage 同策略）
//
// 禁用语义（与用户端链路联动）：
//   - GET /api/ai/providers（用户端）不返回 enabled=FALSE 行 → 桌面端不可选
//   - aiChat.js / aiOcr.js / aiRuntimeConfig.resolveUserProvider 统一过滤 → 调用 404
//   - api_key_encrypted 不解密、不回传，仅 has_key 布尔（与 smtp_pass 脱敏同策略，CO-30）
//
// 审计：admin.ai_provider.update（details 只记变更键名，不落密钥相关信息）
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { logAuditEvent } from '../../utils/audit.js';

const router = Router();

/** timestamptz → 'YYYY-MM-DD HH:mm'（与 configs.js formatDateTimeMinute 同口径） */
function formatDateTimeMinute(value) {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** 手机号打码：138****2765（与 routes/admin/users.js maskPhone 同口径） */
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length < 7) return s.slice(0, 1) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** 单值文本入参归一：undefined/null → 缺省标记，其余 trim 后返回 */
function pickText(v) {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

/** DB 供应商行 → 前端契约（AdminAiProvider，见 admin-console/src/api/ai.ts） */
function mapProviderRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    user_label: (row.nickname || '').trim() || maskPhone(row.phone) || '未知用户',
    provider: row.provider,
    name: row.name,
    base_url: row.base_url ?? '',
    model: row.model,
    has_key: Boolean(row.has_key),
    enabled: Boolean(row.enabled),
    is_default: Boolean(row.is_default),
    updated_at: formatDateTimeMinute(row.updated_at),
  };
}

/**
 * GET /api/admin/ai-providers
 * 全量供应商列表（updated_at DESC；用户手机号打码，密钥仅回 has_key 布尔）。
 */
router.get('/', requirePerm('admin.ai.manage'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.user_id, u.phone, u.nickname, p.provider, p.name, p.base_url, p.model,
              (p.api_key_encrypted IS NOT NULL AND p.api_key_encrypted <> '') AS has_key,
              p.enabled, p.is_default, p.updated_at
       FROM ai_providers p
       LEFT JOIN users u ON u.id = p.user_id
       ORDER BY p.updated_at DESC`
    );
    return res.json({ code: 0, data: rows.map(mapProviderRow) });
  } catch (err) {
    logger.error('[admin/ai-providers] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取 AI 供应商列表失败' });
  }
});

/**
 * PATCH /api/admin/ai-providers/:id
 * 部分更新供应商（AN-03 管理台口径）：
 *  - enabled（启停）: boolean，禁用后用户端列表/聊天/OCR 全链路不可用（见文件头）
 *  - name / model: 非空字符串（≤200）；base_url: 空串 = 清空（回退预设默认地址），否则须合法 http(s) URL
 *  - 不触碰 api_key_encrypted（密钥仅用户自己可设置）
 *  - 审计 admin.ai_provider.update（details 只记变更键名）
 */
router.patch('/:id', requirePerm('admin.ai.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const fields = {};

    if (body.enabled !== undefined) {
      fields.enabled = body.enabled === true || body.enabled === 'true';
    }

    const name = pickText(body.name);
    if (name !== undefined) {
      if (!name) return res.status(400).json({ code: 40002, message: '供应商名称不能为空' });
      if (name.length > 200) return res.status(400).json({ code: 40002, message: '供应商名称最长 200 字符' });
      fields.name = name;
    }

    const model = pickText(body.model);
    if (model !== undefined) {
      if (!model) return res.status(400).json({ code: 40002, message: '模型标识不能为空' });
      if (model.length > 200) return res.status(400).json({ code: 40002, message: '模型标识最长 200 字符' });
      fields.model = model;
    }

    const baseUrl = pickText(body.base_url);
    if (baseUrl !== undefined) {
      if (baseUrl) {
        try {
          const parsed = new URL(baseUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return res.status(400).json({ code: 40002, message: 'base_url 须为 http(s) 地址' });
          }
        } catch {
          return res.status(400).json({ code: 40002, message: 'base_url 格式不合法' });
        }
      }
      // 空串 = 清空自定义地址（用户端回退该供应商预设默认 base_url）
      fields.base_url = baseUrl || null;
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ code: 40002, message: '没有需要更新的字段' });
    }

    // 白名单拼 SET 子句（键名全部来自上方固定白名单，无注入面）
    const keys = Object.keys(fields);
    const setSql = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const params = [id, ...keys.map((k) => fields[k])];

    const { rows } = await pool.query(
      `UPDATE ai_providers SET ${setSql}, updated_at = NOW()
       WHERE id = $1
       RETURNING id, user_id, provider, name, base_url, model,
                 (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key,
                 enabled, is_default, updated_at,
                 (SELECT phone FROM users WHERE id = ai_providers.user_id) AS phone,
                 (SELECT nickname FROM users WHERE id = ai_providers.user_id) AS nickname`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: 'AI 供应商不存在' });
    }

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.ai_provider.update',
      resourceType: 'ai_provider',
      resourceId: id,
      details: { changed: keys },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });
    logger.info('[admin/ai-providers] provider updated', {
      id,
      changed: keys,
      operator: req.user?.userId,
    });
    return res.json({ code: 0, data: mapProviderRow(rows[0]), message: 'AI 供应商已更新' });
  } catch (err) {
    logger.error('[admin/ai-providers] update failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '更新 AI 供应商失败' });
  }
});

export default router;
