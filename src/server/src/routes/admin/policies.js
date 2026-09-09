// =============================================
// Admin Console · 客户端策略下发（AN-02）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/policies', policiesRouter)
//     → GET   /api/admin/policies   requirePerm('admin.configs.view')
//     → PATCH /api/admin/policies   requirePerm('admin.configs.manage')
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
//
// 响应契约（与 configs.js 风格一致）：
//   GET  { code: 0, data: { scope, updatedAt, policies: [{ key, name, description,
//          group, value, allowUserOverride, defaultValue, min, max, consumer }] } }
//   PATCH body { policies: { [key]: { value, allowUserOverride? } }, reason? }
//        → { code: 0, data: { ... }, message }
//
// 写路径：合并写入（未提及键不变）→ 失效进程缓存 → WS 广播 policies.updated
//         （在线桌面端即时生效，未连接端下次启动拉取兜底）→ 审计 admin.policy.update
// 键目录唯一真相源：utils/clientPolicies.js POLICY_CATALOG（consumer 登记 AN-09 机制）。
// =============================================

import { Router } from 'express';
import {
  POLICY_CATALOG,
  getClientPolicies,
  getClientPoliciesUpdatedAt,
  invalidatePoliciesCache,
  normalizePolicyPatch,
  mergeClientPolicies,
} from '../../utils/clientPolicies.js';
import { broadcastToAllClients } from '../../ws/server.js';
import { logAuditEvent } from '../../utils/audit.js';
import { logger } from '../../utils/logger.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

/**
 * GET /api/admin/policies
 * 全局客户端策略（目录顺序输出，含 consumer 登记与可编辑边界）。
 * RB-06：读侧细粒度权限 requirePerm('admin.configs.view')。
 */
router.get('/', requirePerm('admin.configs.view'), async (_req, res) => {
  try {
    const [snapshot, updatedAt] = await Promise.all([
      getClientPolicies(),
      getClientPoliciesUpdatedAt(),
    ]);
    const data = {
      scope: 'global',
      updatedAt,
      policies: POLICY_CATALOG.map((meta) => ({
        key: meta.key,
        name: meta.name,
        description: meta.description,
        group: meta.group,
        value: snapshot[meta.key]?.value ?? meta.defaultValue,
        allowUserOverride: snapshot[meta.key]?.allowUserOverride ?? true,
        defaultValue: meta.defaultValue,
        min: meta.min,
        max: meta.max,
        // AN-09 机制：null = 未接入（管理台打角标）；本目录当前逐键已登记真实消费方
        consumer: meta.consumer ?? null,
      })),
    };
    return res.json({ code: 0, data });
  } catch (err) {
    logger.error('[admin/policies] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取客户端策略失败' });
  }
});

/**
 * PATCH /api/admin/policies  body { policies, reason? }
 * 部分更新全局客户端策略（requirePerm('admin.configs.manage')，复用 configs 写权限——
 * 策略下发与系统参数同属「运营管控」域，不新增权限键，避免 043 迁移授权链再走一轮）：
 *  - policies 必填非空对象；未知键 404；值类型/边界越界 400（归一化夹取后写入）
 *  - 合并写入（未提及键保持原值）
 *  - 成功后：失效进程缓存 + WS 广播 policies.updated + 审计 admin.policy.update
 */
router.patch('/', requirePerm('admin.configs.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    const patch = body.policies;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
      return res.status(400).json({ code: 40002, message: 'policies 不能为空' });
    }

    const norm = normalizePolicyPatch(patch);
    if (!norm.ok) {
      const isUnknown = norm.unknownKey;
      return res
        .status(isUnknown ? 404 : 400)
        .json({ code: isUnknown ? 40404 : 40002, message: norm.error });
    }

    const row = await mergeClientPolicies(norm.normalized, req.user?.userId);
    if (!row) {
      return res.status(404).json({ code: 40404, message: '全局策略行不存在（请执行 057 迁移）' });
    }

    // 立即失效本进程缓存并向全部在线客户端广播新快照（与 feature_flags.updated 同通道模式）
    invalidatePoliciesCache();
    const policies = await getClientPolicies();
    broadcastToAllClients({ type: 'policies.updated', policies });

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.policy.update',
      resourceType: 'client_policy',
      resourceId: 'global',
      details: reason ? { policies: norm.normalized, reason } : { policies: norm.normalized },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/policies] policies updated', {
      keys: Object.keys(norm.normalized),
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: { scope: 'global', policies },
      message: '客户端策略已更新并写入审计',
    });
  } catch (err) {
    logger.error('[admin/policies] update failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '更新客户端策略失败' });
  }
});

export default router;
