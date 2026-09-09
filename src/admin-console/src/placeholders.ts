/**
 * AN-21 占位功能唯一登记点（Placeholder Registry）
 * ============================================================
 * 约束（配合 eslint.config.js 的 no-restricted-syntax 规则）：
 *   1. 业务代码（src/pages、src/components 等）**禁止裸写**「后续版本」
 *      类占位文案（如 message.info('xxx将在后续版本提供')）——lint 直接报错。
 *   2. 确实未实现、需要占位展示的功能，必须在下方 PLACEHOLDER_FEATURES
 *      登记一条（id / 位置 / 原因 / 登记日期），并统一走占位组件渲染
 *      （disabled + Tooltip「规划中 · 见工单 xxx」），让占位功能在静态
 *      层面可识别、可清点。
 *   3. 占位功能接真实功能后，同步删除登记项 + 占位代码，并把工单号
 *      回写到 docs/plans/tickets/ 对应条目。
 * 守卫：`node scripts/admin-full-audit/run-audit.mjs placeholders`
 *       会静态扫描本目录（除本文件外）断言占位文案为 0 处。
 * ============================================================
 */

/** 占位功能登记项 */
export interface PlaceholderFeature {
  /** 稳定 ID（feature key），如 'user.changePlan' */
  id: string;
  /** 页面位置，如 'pages/users/index.tsx 行操作' */
  location: string;
  /** 占位原因（为什么没做 / 规划到哪） */
  reason: string;
  /** 登记日期 YYYY-MM-DD */
  registeredAt: string;
}

/**
 * 当前占位功能清单。
 * 2026-09-09：AF-13（改套餐 → 抽屉赠期）与 AF-15（订单人工关单口径取消，
 * 改为服务端超时自动关单）落地后已无裸占位，本清单为空——保留机制防再犯。
 */
export const PLACEHOLDER_FEATURES: PlaceholderFeature[] = [];
