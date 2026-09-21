// =============================================
// Admin Console · 退款审核（两段式退款的第二段）
//
// 挂载（routes/admin/index.js）：adminRouter.use('/refund-reviews', refundReviewsRouter)
//   GET  /api/admin/refund-reviews?status=pending&page=&pageSize=
//   POST /api/admin/refund-reviews/:id/approve   ← 这一刻才真调支付宝退款
//   POST /api/admin/refund-reviews/:id/reject    body { reason }
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限：列表 requirePerm('admin.orders.view')；通过/驳回 requirePerm('admin.orders.refund')
//   —— 刻意复用既有权限键，不新增：审核通过的资金动作与订单页强退**完全是同一件事**
//   （同一个 refundPaidOrder、同一个渠道幂等键），权限口径理应一致；新增一个
//   admin.refund.review 键只会让「谁能退钱」这件事出现两个互不相干的开关。
//
// 响应契约沿用本目录：成功 { code: 0, data: T }，错误 { code, message }。
// 分页同时给 list 与 items 两个键：list 是仓库既有约定，items 是本次管理台新页面读的键。
// =============================================

import { Router } from 'express';
import { requirePerm } from '../../middleware/adminAuth.js';
import { logger } from '../../utils/logger.js';
import { RefundError } from '../../services/refund.js';
import {
  approveRefundRequest,
  rejectRefundRequest,
  listRefundRequestsForAdmin,
} from '../../services/refundRequest.js';
import { refundErrorToAdmin } from './orders.js';

const router = Router();

/**
 * GET /api/admin/refund-reviews
 * status 缺省 pending（审核页默认只看待办）；'all' 或非法值 = 不过滤。
 */
router.get('/', requirePerm('admin.orders.view'), async (req, res) => {
  try {
    const { status, page, pageSize } = req.query;
    const result = await listRefundRequestsForAdmin({ status, page, pageSize });
    return res.json({
      code: 0,
      data: { list: result.items, items: result.items, total: result.total, page: result.page, pageSize: result.pageSize },
    });
  } catch (err) {
    logger.error('[admin/refund-reviews] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取退款申请列表失败' });
  }
});

/**
 * POST /api/admin/refund-reviews/:id/approve —— 审核通过并**立即打款**。
 *
 * 服务层先用 CAS 把单子抢成 processing 再调渠道，渠道失败退回 pending（管理员可重试），
 * 成功才落 approved。因此这里重复点击不会重复打款：第二次拿不到 pending，
 * 直接 40903；而订单侧另有 refundPaidOrder 的行锁复核 + 支付宝 out_request_no 幂等。
 */
router.post('/:id/approve', requirePerm('admin.orders.refund'), async (req, res) => {
  try {
    const result = await approveRefundRequest({
      requestId: req.params.id,
      actorUserId: req.user?.userId,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
    logger.info('[admin/refund-reviews] approved', {
      requestId: req.params.id,
      orderNo: result.request.orderNo,
      amount: result.order.refundAmount,
      operator: req.user?.userId,
    });
    return res.json({ code: 0, data: { request: result.request, order: result.order } });
  } catch (err) {
    if (err instanceof RefundError) {
      // 申请单自身的错误要先分流：它们不是渠道/资金错误，refundErrorToAdmin 里没有映射，
      // 落到默认分支会被说成「退款执行失败」，管理员就分不清是"没抢到"还是"打款失败"。
      if (err.code === 'REFUND_REQUEST_NOT_FOUND') {
        return res.status(404).json({ code: 40404, message: '退款申请不存在' });
      }
      if (err.code === 'REFUND_REQUEST_NOT_PENDING') {
        return res.status(409).json({ code: 40903, message: '该申请已处理，不能重复操作', ...err.extra });
      }
      if (err.code === 'REFUND_REQUEST_ID_REQUIRED') {
        return res.status(400).json({ code: 4000, message: '申请单 id 不能为空' });
      }
      const { code, message } = refundErrorToAdmin(err);
      return res.status(err.status).json({ code, message, refundCode: err.code, ...err.extra });
    }
    logger.error('[admin/refund-reviews] approve failed', { error: err.message, requestId: req.params.id });
    return res.status(500).json({ code: 5000, message: '审核通过执行失败' });
  }
});

/**
 * POST /api/admin/refund-reviews/:id/reject  body { reason }
 * 驳回：钱没退，所以服务层会按申请时的权益快照还原订阅（用户若已另购新套餐则不还原，
 * 避免又造出两条 active 订阅）。reason 必填 —— 它既是给用户看的说明，也是审计正文。
 */
router.post('/:id/reject', requirePerm('admin.orders.refund'), async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '驳回理由必填（会展示给用户并写入审计）' });
    }
    const result = await rejectRefundRequest({
      requestId: req.params.id,
      actorUserId: req.user?.userId,
      reason,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
    logger.info('[admin/refund-reviews] rejected', {
      requestId: req.params.id,
      orderNo: result.request.orderNo,
      operator: req.user?.userId,
      entitlementRestored: result.entitlementRestored,
    });
    return res.json({
      code: 0,
      data: { request: result.request, entitlementRestored: result.entitlementRestored },
    });
  } catch (err) {
    if (err instanceof RefundError) {
      if (err.code === 'REFUND_REQUEST_NOT_FOUND') {
        return res.status(404).json({ code: 40404, message: '退款申请不存在' });
      }
      if (err.code === 'REFUND_REQUEST_NOT_PENDING') {
        return res.status(409).json({ code: 40903, message: '该申请已处理，不能重复操作', ...err.extra });
      }
      return res.status(err.status).json({ code: 4000, message: err.message, ...err.extra });
    }
    logger.error('[admin/refund-reviews] reject failed', { error: err.message, requestId: req.params.id });
    return res.status(500).json({ code: 5000, message: '驳回执行失败' });
  }
});

export default router;
