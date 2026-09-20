# ClipSync 支付场景矩阵（Payment Scenario Matrix）

> **文档版本**: v1.0
> **生成时间**: 2026-09-19 18:40 (+08:00)
> **事实基线**: 基于 **2026-09-19 生产联调实测**（支付宝电脑网站支付真机扫码全链路）+ 同日工作区代码快照
> **分支**: `test/admin-full-audit`
> **作者**: AI 助手（任务板 #14「支付场景全覆盖 + 管理后台联动核查」）

---

## 0. 阅读须知

### 0.1 状态口径（矩阵「状态」列只允许这 5 个取值）

| 标记 | 含义 | 判定标准 |
|---|---|---|
| `已验证` | 2026-09-19 生产真机实测走通 | 有人看到请求/回调/落库/界面四方一致；只看到日志不算 |
| `已实现未验证` | 代码已在仓库/工作区，但该分支未在生产真机走过 | 读代码可确认逻辑存在；无实测记录 |
| `未实现` | 无代码，或只有纯函数/渠道封装未接线 | 全仓 grep 无调用点 |
| `已禁用` | 有意关闭（返回错误码 / 无入口 / 产品决策不做） | 有显式拦截代码或产品决策记录 |
| `缺陷` | 上述任一状态 + 已确认存在阻断或语义错误 | 必须同时在 §4 清单里有对应条目 |

**没有实测过的分支一律写 `已实现未验证`，不写 `已验证`。** 这是本矩阵的核心纪律：
2026-09-19 之前的多起事故（假退款、回调不可达、subscribe 白送会员）都源于「文档说有 = 认为能用」。

### 0.2 快照警告（重要）

本文件写于 **2026-09-19 18:40 的工作区状态**，而以下文件在同一时刻正被并行修改（未提交）：

- `src/server/src/routes/payments.js`（create-order 折抵 + 409 拦截 + 真实 /refund）
- `src/server/src/services/orderFulfillment.js`（升级取代旧订阅）
- `src/server/src/utils/alipay.js`（`refundTrade`）
- `src/server/src/services/proration.js`（新增未跟踪）
- `src/server/src/db/migrations/072_refund_timestamp_columns.sql`、`073_subscription_expiry_notice.sql`（新增未跟踪）
- `src/desktop/src/components/payment/AlipayScanPay.vue`、`modals/PricingPaymentModals.vue`、`components/pricing/*`、`composables/useSubscriptionAccess.ts`

因此标为 `已实现未验证` 的**升级折抵 / 409 拦截 / 真实退款**三族场景，合入后需按 §5 复测清单重跑一遍再改状态。

### 0.3 证据规约

`证据` 列写 `文件:行`。行号是本快照的，代码移动后按符号名定位（函数名/注释关键字都写在正文里）。

---

## 1. 事实基线：链路与常量

### 1.1 端到端链路（2026-09-19 实测通过的主干）

```
桌面端「订阅/升级」卡 → 勾选协议 → POST /api/payments/create-order (JWT + CSRF)
  → 服务端建 payment_orders(status='pending', payment_method='alipay', plan_id, metadata{planId,billingCycle,proration?})
  → buildPagePayUrl(alipay.trade.page.pay, qr_pay_mode=4, qrcode_width=200, notify_url=ALIPAY_NOTIFY_URL)
  → 前端 <iframe> 内嵌收银台二维码（240×240 iframe + 204×204 裁剪窗，码贴左上角）
  → 用户手机支付宝扫码付款
  ├── 路径①：支付宝异步通知 POST /api/webhooks/alipay（无 JWT/CSRF；验签 + app_id 比对 + 金额闸）→ markOrderPaid
  └── 路径②：前端每 3s 轮询 GET /api/payments/order/:orderNo/status
              → 订单仍 pending 时服务端顺带 alipay.trade.query（响应强制验签 + 金额闸）→ markOrderPaid
  → markOrderPaid（统一履约入口）：BEGIN → SELECT ... FOR UPDATE（行级锁）
      → 幂等判定（paid/refunded 直接 already_paid）→ 终态判定（cancelled/failed 拒绝履约）
      → 金额闸（expectedAmount vs 订单 amount，容差 0.005）
      → 置 paid + 开/顺延/取代订阅 + 同步 users 冗余订阅态 + 开发票（失败不回滚支付）
      → COMMIT → 审计 payment_complete
  → 前端轮询到 paid → 关遮罩 → 成功结果页（订单号/金额/套餐/支付时间/到期时间，到期读 /api/subscriptions/current）
```

### 1.2 关键常量与时间参数（实测/代码）

| 项 | 值 | 来源 |
|---|---|---|
| 收银台二维码有效期 | **实测 99 s**（报文 `qrExpirySeconds=99`，官方文档标 120 s 不可改） | `AlipayScanPay.vue` 注释（2026-09-19 实测） |
| 前端转过期态的时刻 | 95 s（留 4 s 余量，避免「假活码」） | `AlipayScanPay.vue` `PAY_TIMEOUT_MS` |
| 前端轮询间隔 | 3 s（每次轮询服务端会打一次支付宝网关，故不可再调密） | `AlipayScanPay.vue` `POLL_INTERVAL_MS`、`payments.js` status 注释 |
| 本站订单超时关单 | pending 且创建 **> 24 h** → `status='cancelled'` + `metadata.auto_closed='timeout_unpaid'`，每小时扫一轮 | `services/orderCloseSweep.js` |
| 支付宝回调重试 | 官方节奏 4m/10m/10m/1h/2h/6h/15h，最长 24 h | `payments.js` status 路由注释 |
| 履约渠道幂等键 | `payment_orders.status`（paid/refunded 视为已履约）+ 行级锁 `FOR UPDATE` | `services/orderFulfillment.js` |
| 金额闸容差 | 0.005 元 | `orderFulfillment.js` S1 分支 |
| 下单未传渠道侧关单时间 | `biz_content` 无 `timeout_express` → 渠道侧关单时刻由支付宝默认值决定，**未实测**；本站只保证 24 h 清扫 | `utils/alipay.js` `buildPagePayUrl` |
| 单次折抵后订单下限 | 0.01 元（绝不出 0 元单） | `services/proration.js` `MIN_ORDER_AMOUNT` |

### 1.3 渠道与端点清单

| 端点 | 鉴权 | 用途 | 备注 |
|---|---|---|---|
| `POST /api/payments/create-order` | JWT + CSRF | 建单 + 返回收银台 URL | 渠道枚举 `alipay`/`mock`；`mock` 生产 403 |
| `GET /api/payments/order/:orderNo/status` | JWT + CSRF | 轮询；pending 时带渠道兜底查询 | 只查自己的单（`user_id` 条件） |
| `POST /api/webhooks/alipay` | 无（验签） | 支付宝异步通知 | 必须返回纯文本 `success` |
| `POST /api/payments/refund` | JWT + CSRF + `users.is_admin` | **真实**渠道退款（alipay.trade.refund，全额） | 2026-09-19 从 501 占位改为真实现，未验证 |
| `GET /api/payments/reconciliation` | JWT + `is_admin` | 老对账接口（区间查询） | 管理台**未**使用（走 `/api/admin/reconciliation`） |
| `POST /api/admin/orders/:orderNo/refund` | 管理台 RBAC `admin.orders.refund` | **记账式**人工标记退款（不动钱） | 与上一条语义相反，见 §4-A1 |
| `GET /api/admin/orders[/:orderNo]`、`GET /api/admin/reconciliation` | `admin.orders.view` / `.reconcile` | 管理台订单/对账 | 契约见 `admin-console/src/api/types.ts` |
| `POST /api/subscriptions/subscribe` | JWT | 建待支付单（返回 202） | 不写 `plan_id`，与 create-order 已不一致 |
| `GET /api/invoices[/:id]`、`GET /api/invoices/:id/download` | JWT + CSRF | 账单列表/详情/PDF | 列表与详情当前必 500，见 §4-B3 |

---

## 2. 产品决策基线（矩阵判定的依据，不可回退）

> 编号前缀 `PD` 专指产品决策，避免与 §3.4 的 D 组场景号（D1–D12）混淆。

| # | 决策 | 对代码的硬要求 | 现状 |
|---|---|---|---|
| PD1 | **无自动续费**（个体户被支付宝商家扣款拒开，任务板 #17/#18） | 全链路不得出现「自动续费/连续包月」文案；`auto_renew` 只能是历史遗留位 | 桌面端 `useSubscriptionAccess.ts` 已立红线；`user_subscriptions.auto_renew` 默认 **true** 仍在库里 → 管理台会显示「自动续费：是」，属文案/数据误导（§4-A5） |
| PD2 | **升级=折抵差价，只升不降** | 同套餐 409 `ALREADY_SUBSCRIBED`；低档 409 `DOWNGRADE_NOT_ALLOWED`；升档按残值折抵 | 服务端与桌面端均已接线（未验证）；服务端 `/subscribe` 侧仍无拦截（§4-A3） |
| PD3 | **退款=真实打款 + 立即收回权益** | 先调渠道、`fund_status='Y'` 才改库；订阅立即 `canceled` | `/api/payments/refund` 已按此实现（未验证）；**管理台退款按钮走的是另一条不动钱的端点**（§4-A1） |
| PD4 | ~~用户侧无退款入口~~ **2026-09-19 推翻**：个人资料页「申请退款」= 属主自助真实退款 | 自助三道闸（`services/refundPolicy.js` 唯一实现，与列表接口同源）：①必须是**当前生效订阅（active 且未到期）的最近一笔已支付订单**（锚点）②支付后 ≤7 天 ③渠道仅 alipay；否则 409 `NOT_CURRENT_SUB_ORDER`/`REFUND_WINDOW_EXPIRED` → 引导客服（管理台强退不受闸限制）。⚠️ 口径 2026-09-20 收紧过一次：旧口径①「用户最近一笔已付单」在退掉锚定单后会**顺移**到上一笔，等于把历史订单依次退干净（白嫖整个已用周期）；新口径把锚点绑在 active 订阅上——退款成功即订阅 `canceled` → 锚点消失 → 该用户余下单永不可自助退 | 客户端 PlanManagementCard 弹窗；`GET /api/payments/refundable-orders` 返回 refundable+reasonCode；生产实测（测试号 4 单）全部 `refundable=false` |
| PD5 | 微信支付**不接入**（300 元/年认证费） | 不留回调、不留渠道 | 已删；但渠道归一化仍把未知渠道兜底成「微信支付」（§4-A4） |
| PD6 | 支付宝主体=个体工商户，结算到经营者本人银行卡 | 不需要对公账户 | 见 `docs/product/payment-integration-guide.md` 2026-09-16 修正段 |

---

## 3. 支付场景矩阵

### 3.1 A 组 · 正常下单与履约

| # | 场景 | 触发条件 | 前端表现 | 服务端行为 | 资金流向 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|
| A1 | 首次订阅·月付（Pro） | Free/无订阅用户，选 Pro + 月付，勾协议 | 出码→等待→扫后轮询→成功页（订单号/¥金额/套餐/支付时间/到期时间） | create-order 建 pending 单（`plan_id`+`metadata.planId/billingCycle=monthly`）→ 回调/轮询履约 → 无 active 同套餐记录则 INSERT `user_subscriptions(active, +1 month)` → 回填订单 `subscription_id` → `users.subscription_status` → 开发票 | 用户→商户全额入账 | **已验证** | `payments.js:26-227`、`orderFulfillment.js:195-235`、`PricingPaymentModals.vue` onPaid |
| A2 | 首次订阅·年付 | 同上但切「年付」tab | 卡片价 ¥99 + 「省 17%」角标；结果页周期文案 `/年` | create-order `effectiveCycle='yearly'` → 金额取 `price_yearly` → 履约 INSERT 周期 `+1 year` | 同 A1 | **已实现未验证** | `payments.js` create-order（effectiveCycle）、`useSubscriptionAccess.ts` `yearlySavingPct/priceForCycle` |
| A3 | 已有到期订阅后重新订阅 | 订阅已过期（清扫为 expired 或 `current_period_end<=NOW()`） | 卡片重新变「订阅」，全价下单 | 折抵判定只认 `status='active' AND current_period_end>NOW()` → 不匹配即全价新订 | 全额入账 | **已实现未验证** | `payments.js` currentSubscription SQL |
| A4 | 下单时支付宝凭据不全 | `ALIPAY_APP_ID`/`PRIVATE_KEY` 缺失 | 二维码区错误 + 「重试」按钮 | create-order 先 503 `ALIPAY_NOT_CONFIGURED`；缺 `ALIPAY_NOTIFY_URL` 则 503 `ALIPAY_NOTIFY_URL_MISSING`。**绝不静默降级 mock** | 无 | **已实现未验证** | `payments.js:58-65,185-192` |
| A5 | 未登录调 create-order | 无 JWT | 桌面端 toast「登录已过期」 | `authenticateToken` 401（`/api/payments` 整挂在 JWT+CSRF 下） | 无 | **已实现未验证** | `index.js:468` |
| A6 | 带 JWT 但无 CSRF token | 跨站表单/漏带 `x-csrf-token` | 请求失败 | `csrfProtection` 403 | 无 | **已实现未验证** | `middleware/csrf.js`、`index.js:468` |
| A7 | 传入不存在/已停用的 planId | 管理台下架某档后老客户端下单 | 错误 + 重试 | create-order 404 `Plan not found`（`is_active=true` 条件） | 无 | **已实现未验证** | `payments.js` targetPlan 查询 |
| A8 | 传入他人/不存在的 subscriptionId | 越权尝试 | 错误提示 | 查询带 `AND us.user_id = $2` → 查不到即 404 `Subscription not found` | 无 | **已实现未验证** | `payments.js` subscriptionResult 查询 |
| A9 | 轮询他人订单号 | 用户 A 轮询 B 的 orderNo | 静默继续轮询（前端不区分） | `WHERE order_no=$1 AND user_id=$2` → 404 | 无 | **已实现未验证** | `payments.js:247-253` |
| A10 | 生产环境使用 mock 渠道 | 手工传 `paymentMethod='mock'` | 桌面端不传 mock | 403 `Mock payment is not available in production`（历史「白送会员」后门） | 无 | **已禁用** | `payments.js:51-56` |
| A11 | 非生产环境 mock 渠道 | 本地/测试显式传 mock + subscriptionId | — | 直接走 `markOrderPaid` 履约（同一入口，无双套逻辑） | 无 | **已实现未验证** | `payments.js:151-179` |
| A12 | 移动端下单 | Flutter 端订阅入口 | 明确提示「移动端暂不支持支付，请到桌面端完成」 | 移动端无任何支付调用（全仓无 create-order） | 无 | **已禁用** | `src/mobile/lib/l10n/app_localizations_*.dart`、`feature_flags_provider.dart:70` |

### 3.2 B 组 · 档位变更（续费 / 升级 / 降档 / 重复购买）

| # | 场景 | 触发条件 | 前端表现 | 服务端行为 | 资金流向 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|
| B1 | 同套餐·到期后续费 | 上一周期已结束后再买同一套餐 | 卡片显示「订阅」→ 正常付款 | 无 active 记录 → 全价新订；履约时若已有同套餐 active 则**顺延**（`GREATEST(current_period_end,NOW())+1 cycle`），绝不插第二行 | 全额入账 | **已实现未验证**（顺延兜底自 2026-09-19 修复后未复测） | `orderFulfillment.js:195-231`（注释含「2026-09-19 联调实测」） |
| B2 | 同套餐·active 期间重复付款 | 用户在到期前又点同档 | 桌面端已置灰「当前套餐」，正常走不到；异常路径提示「已在该套餐」 | create-order 409 `ALREADY_SUBSCRIBED`（含 `subscriptionId`）→ 不建单。**副作用：active 期内续费一并被拦（本期不提供续费入口）** | 无 | **已实现未验证**（并行开发中） | `payments.js` decision.kind==='same' 分支、`proration.js:66-68` |
| B3 | 同套餐重复付款的兜底（绕过 409 建出单并付清） | 老客户端/竞态/手工建单 | 成功页 | 履约按「已有 active → 延长周期」处理；不再是「第二条 active 订阅」 | 全额入账 | **已实现未验证** | `orderFulfillment.js:200-231` |
| B4 | 升级 Pro→Enterprise（含残值折抵） | active 期内点更高档 | 卡片标「升级」；下单后结果页摊开「原价 / 折抵 −¥x / 实付」 | create-order：`decidePlanChange='upgrade'` → `computeProration(旧单实付 × 剩余天数/周期天数)` → 订单金额 = max(新价−残值, 0.01)，`metadata.proration{originalPrice,creditAmount,remainingDays,oldSubscriptionId,...}`；履约：为新套餐 INSERT active、旧订阅置 `canceled + canceled_at + auto_renew=false` | 用户付「差价」；旧周期钱已在旧单收过、被折抵不再退 | **已实现未验证**（并行开发中，且 §4-A6 展示断点） | `proration.js:89-125`、`payments.js` 折抵段、`orderFulfillment.js:113-190` |
| B5 | 折抵基准的取数口径 | 升级单原价怎么来 | — | 残值基准 = 该订阅**最近一条 paid 订单实付**（`COALESCE` 回退套餐标价），避免把上次折抵再折一遍；周期数据非法时残值按 0（宁可让用户多付） | 影响用户实付 | **已实现未验证** | `payments.js` currentResult SQL、`proration.js:101-108` |
| B6 | 折抵后金额触底 0.01 | 旧套餐残值 ≥ 新套餐价（异常定价） | 成功页实付 ¥0.01 | `floorApplied=true` → 金额取 `MIN_ORDER_AMOUNT`；渠道金额闸按此校验 | 入账 0.01 | **已实现未验证** | `proration.js:18,112-113` |
| B7 | 降档尝试（Enterprise→Pro / 同价不同套餐） | active 期内点更低档 | 卡片置灰「已包含」，正常走不到；异常路径提示等到期/找客服 | create-order 409 `DOWNGRADE_NOT_ALLOWED`（同价按降档处理） | 无 | **已实现未验证**（并行开发中） | `proration.js:49-72`、`payments.js` decision.kind==='downgrade' |
| B8 | 绕过前端直连 API 降档 | 手工 curl `planId=低价档` | — | 服务端 409 拦截已覆盖 create-order；**但 `POST /api/subscriptions/subscribe` 仍是敞口：同套餐只回 400、降档无任何判定、按目标套餐全价建 pending 单** | 无（该单仍需付款） | **缺陷 / 部分未实现** | `routes/subscriptions.js:169-224`（`current.plan_id === planId` 只回 400） |
| B9 | 升级订单未付款后旧权益 | 下单出码后不付 | 95 s 后转过期态 | 建单只写 pending，旧订阅不动（履约才动） | 无 | **已实现未验证** | `payments.js` 建单、`orderFulfillment.js` 才改订阅 |
| B10 | 7 天试用（终身一次） | 新用户点试用 | 桌面端有/无入口由 #13 治理 | `POST /api/subscriptions/start-trial`：只要历史上存在过任何订阅记录即 409 `TRIAL_ALREADY_USED`；发放 `status='trial'` 7 天 | 无 | **已实现未验证** | `routes/subscriptions.js:291-345` |

### 3.3 C 组 · 扫码环节的用户侧异常

| # | 场景 | 触发条件 | 前端表现 | 服务端行为 | 资金流向 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|
| C1 | 扫码后在支付宝页取消支付 | 用户点收银台「取消」 | 本站遮罩不变，继续轮询到 95 s → 转过期态 + 「重试」 | 渠道 `WAIT_BUYER_PAY`：回调若到达，非成功态只记 info 并回 `success`，订单保持 pending | 无 | **已实现未验证** | `paymentWebhooks.js:92-94`、`AlipayScanPay.vue` startExpiry |
| C2 | 二维码过期（99 s） | 出码后不扫 | 95 s 时前端主动停轮询、显过期文案；点「重试」= 重新 create-order 拿**新单新码** | 旧单留 pending，24 h 后被清扫为 cancelled；支付宝侧交易自然失效 | 无 | **已验证（99 s 实测）+ 已实现未验证（重试分支）** | `AlipayScanPay.vue:47-52,142-147` |
| C3 | 重试产生的多张 pending 单 | 用户反复过期后重试 | 无感 | 每次重试都是新 order_no（`ORD{ts}{rand}`，无幂等），旧单堆到 24 h 清扫 | 无 | **已实现未验证**（管理台会看到同人多张待支付单，§4-A7） | `payments.js:113 orderNo`、`orderCloseSweep.js` |
| C4 | 支付中途关闭弹窗 | 用户点「关闭」 | 弹窗关闭、`onUnmounted` 清 timer，**前端不再轮询**；无任何「支付仍会完成」提示 | 回调路径不受影响：钱到账仍会履约、订阅照样开；用户下次进订阅页才看到生效 | 全额入账 | **缺陷（体验）** | `AlipayScanPay.vue:69 stopTimers/onUnmounted` |
| C5 | 关窗后钱才到、用户以为没付 → 再付一次 | 同 C4 后重试 | 第二次付款前若第一笔已履约，会被 B2 的 409 拦（新逻辑）；否则建第二张单 | 两笔各自履约：第二笔走「同套餐顺延」或 409 | 两笔都入账（用户可感知为重复扣款） | **已实现未验证** | `orderFulfillment.js` 顺延分支 + `payments.js` 409 |
| C6 | 用户在 iframe 里用支付宝 App 扫码但手机网络失败 | 渠道侧未完成 | 轮询一直 pending → 95 s 过期态 | 渠道无成功通知；`trade.query` 回 `TRADE_NOT_EXIST`/未付 → 不履约 | 无 | **已实现未验证** | `alipay.js queryTrade`、`payments.js` 兜底分支 |
| C7 | 付款成功但前端轮询期间断网 | 网络抖动 | 前端 `if (!res.ok) return` 静默重试（不打扰用户）；95 s 后仍会转过期态 | 回调侧独立履约，订单已 paid；用户看到「过期」但权益其实已开 | 全额入账 | **缺陷（体验）** | `AlipayScanPay.vue:110-112`、`paymentWebhooks.js` |
| C8 | 桌面端多窗口/重复挂载并发下单 | 两处同时开支付弹窗 | 两个二维码都能付 | 两笔订单各自履约（第二笔顺延） | 两笔入账 | **已实现未验证** | 无防重入代码 |

### 3.4 D 组 · 回调 / 轮询 / 并发 / 验签 / 金额

| # | 场景 | 触发条件 | 前端表现 | 服务端行为 | 资金流向 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|
| D1 | 回调先到（正常路径） | 支付宝 notify 早于轮询 | 下一次轮询即读到 paid | 验签+app_id 比对+金额闸 → `markOrderPaid` → 回纯文本 `success`；轮询侧此时不再外呼 | 入账 | **已验证** | `paymentWebhooks.js:39-98` |
| D2 | 轮询先到（回调迟到） | DNS/部署/网络导致 notify 未到 | 轮询内服务端主动 `trade.query` → 直接返回 paid | 兜底路径同样走 `markOrderPaid(expectedAmount=raw.total_amount, source:'poll_query')` | 入账 | **已实现未验证**（任务板 #5 明确推迟） | `payments.js:258-289` |
| D3 | 回调与轮询并发到达 | 两条路径同时履约 | 任一侧读到 paid 即停 | 两条路径共用 `FOR UPDATE` + `status` 裁判：先到者改状态、后到者 `already_paid`（changed=false），不重复开订阅/发票 | 入账一次 | **已实现未验证** | `orderFulfillment.js:44-68` |
| D4 | 支付宝重复投递同一通知 | 官方重试（24 h 内多次） | 无感 | 每次都重跑 handler；`webhookIdempotencyMiddleware` 只对 `res.json` 生效，而支付宝回的是 `res.send('success')` 纯文本 → **该中间件对本渠道实际不产生缓存**，真正的去重是履约层行锁+状态判定 | 入账一次 | **已实现未验证** | `middleware/idempotency.js:227-245`、`paymentWebhooks.js:97` |
| D5 | 回调金额与订单不符 | 报文 `total_amount` ≠ 订单 `amount`（>0.005） | 用户仍可能已真实付款（例如被篡改/串单） | ROLLBACK + `amount_mismatch` → 回 `failure` 让支付宝重试 + error 日志转人工。**不履约、不开权益** | 钱进商户账户但订单仍 pending，24 h 后清扫成 cancelled | **已实现未验证** | `orderFulfillment.js:81-96`、`paymentWebhooks.js:74-76` |
| D6 | 回调验签失败 | 伪造/被改写的报文 | 无 | `verifyParams` 假 → 401 `failure`；`ALIPAY_PUBLIC_KEY` 未配置 → 503 `failure`（**绝不信任未验签报文**） | 无 | **已实现未验证**（拒绝分支）/ 已验证（正向验签） | `paymentWebhooks.js:44-57`、`alipay.js:152-170` |
| D7 | `app_id` 与本商户不一致 | 他人合法签名打同一订单号 | 无 | 401 `failure`（在验签之后再加一道） | 无 | **已实现未验证** | `paymentWebhooks.js:59-64` |
| D8 | 网关响应被伪造（query/退款） | 中间人伪造 `trade_status`/`fund_status` | 无 | `callGateway` 强制对响应原文截段验签（`extractResponseNode`+`verifyResponseSignature`），缺 sign / 截不到 / 验签不过一律抛错 | 无 | **已实现未验证**（S3 已合入，正/反两向均未真机制造过伪造） | `alipay.js:272-280` |
| D9 | body parser 吞掉 webhook 报文 | 历史事故：自建 rawBody 中间件读流 | 无 | 已改用 body parser 的 `verify` 钩子留存 `rawBody`；`req.body` 正常解析。**回归风险点**：任何人再在 parser 之前读流，全链路静默失效 | — | **已验证（当日定位并修复）** | `index.js:142-176 captureRawBody` |
| D10 | 回调早于订单落库的极端竞态 | notify 比 INSERT 先落 | 前端继续轮询 | `order_not_found` → 500 `failure` → 支付宝按重试节奏再打 | 入账后履约 | **已实现未验证**（无法主动构造） | `paymentWebhooks.js:79-91`、`orderFulfillment.js:55-59` |
| D11 | Stripe 回调 | 事件 `checkout.session.completed` | 无（未接 Stripe） | handler 存在，履约时**不传 expectedAmount** → 金额闸形同虚设 | 不适用 | **未实现（渠道未接入）** | `paymentWebhooks.js:104-149` |
| D12 | 微信支付回调 | — | 无 | 明确不接入，回调实现已删除 | 不适用 | **已禁用** | `payments.js:310-320` 注释段 |

### 3.5 E 组 · 超时清扫后到账、退款与权益收回

| # | 场景 | 触发条件 | 前端表现 | 服务端行为 | 资金流向 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|
| E1 | pending 超 24 h 自动关单 | 建单未付 | 桌面端无感（早已过期） | 每小时扫描 → `cancelled` + `metadata.auto_closed='timeout_unpaid'` + 逐单审计 `payment_auto_close` | 无 | **已实现未验证** | `services/orderCloseSweep.js` |
| E2 | **关单后钱才到账**（用户在渠道侧极晚完成支付） | 渠道关单时间 > 本站 24 h | 用户称「付了钱没会员」 | 履约判定 `order_cancelled` → ROLLBACK + error 日志 + 回 `failure`（支付宝重试 24 h 后放弃）；轮询侧已付款订单不再被兜底改状态（status 只处理 pending） | **钱在商户账户、订单 cancelled、权益未开** → 只能人工：退款或改库 | **缺陷（无自助恢复路径）** | `orderFulfillment.js:70-79`、`payments.js` status 分支 |
| E3 | 真实退款成功（属主自助或管理员） | 订单 paid 且渠道 alipay | ①权限/自助闸（PD4 三闸，管理员跳过）→ ②enable_subscription 闸 → ③`alipay.trade.refund`（全额，`out_request_no=订单号` 幂等）→ ④渠道确认（现行接口 **code=10000 即成功态**，响应无 fund_status 字段；幂等重放 fund_change='N' 不算失败——2026-09-19 生产实测钉死）→ 事务+行锁复核：订单 `refunded`+`refunded_at`、订阅 `canceled`+`canceled_at`、`users.subscription_status='free'` → 审计 `payment_refund` | 全额退回买家（原路） | **已实现，生产验证中**（首笔 ¥0.01 真实退款已到账，响应验签口径修复后对账） | `payments.js` /refund、`refundPolicy.js`、`alipay.js refundTrade` |
| E4 | 真实退款渠道侧失败 | `code≠10000` / `fund_status='C'/'D'` / 验签失败 | — | 订单**保持 paid 不动**，502 `REFUND_CHANNEL_FAILED` / `REFUND_NOT_CONFIRMED` + `status='failure'` 审计 | 钱没退 | **已实现未验证** | 同上 |
| E5 | 真实退款「钱退了但本地没落」 | 渠道成功后 DB 异常 | — | ROLLBACK + error 日志 `CRITICAL` + 500 `REFUND_LOCAL_UPDATE_FAILED`（带 `out_request_no` 供人工补账） | 钱已退、库未改 | **已实现未验证**（这是设计好的人工补账出口，但需真演练一次） | 同上 |
| E6 | 重复发起退款 | 同单点两次 | — | 第二次 409 `ALREADY_REFUNDED`；并发时行锁复核 409 `REFUND_STATE_CONFLICT`；渠道侧 `out_request_no` 幂等兜底 | 不重复打款 | **已实现未验证** | 同上 |
| E7 | 未支付订单申请退款 | pending/failed/cancelled | — | 400 `ORDER_NOT_REFUNDABLE`；E2 的 cancelled 单**因此无法通过退款接口处置** → 只能人工 | 无 | **缺陷（E2 的死锁面）** | `payments.js` status 校验 |
| E8 | 非支付宝渠道订单退款（历史 mock/stripe 单） | 老数据 | — | 400 `REFUND_CHANNEL_UNSUPPORTED`，注释指明改走 `admin/orders.js` 记账式退款 | 线下处理 | **已实现未验证** | `payments.js` channel 校验 |
| E9 | **管理台「退款」按钮 = 记账式标记（不动钱）** | 超管在 `/orders` 点退款 | 弹窗预填全额、原因必填；成功 toast「已标记退款 ¥x（线下退款完成后标记）」 | `POST /api/admin/orders/:orderNo/refund`：只 UPDATE `status='refunded'` + `metadata.refund_amount/reason/by/at`，**不调任何渠道 API**；仅「年付+全额」才把订阅置 canceled | **钱不退**；月付/部分退款连权益都不收 | **缺陷（与 PD3 语义相反）** | `routes/admin/orders.js:252-343`、`RefundModal/index.tsx:80-82` |
| E10 | 管理台标记式退款的「重复发起」 | 已 refunded 再点 | 行操作列只在 `status==='paid'` 出按钮，UI 上点不到 | 服务端 40005 `仅已支付订单可退款` | 无 | **已实现未验证** | `orders/index.tsx:200`、`admin/orders.js:269-271` |
| E11 | 「退款处理中」伪状态 | `status='refunded'` 且 `metadata.refund_amount` 为空 | 订单页独立 Tab + 看板待办「退款处理中」 | 服务端两处同口径 SQL | — | **已实现未验证**：现行两条退款路径都会立刻写 `refund_amount`，此状态只会来自旧假退款/人工改库 | `mappers.ts:73-81`、`admin/orders.js:137-141`、`overview.js:213-231` |
| E12 | 退款后发票/账务 | 已开发票的单退款 | 管理台**无发票/红冲视图** | 订单退款不改 `invoices` 行（发票不会作废/红冲） | — | **未实现** | `orderFulfillment.js` 开票、`admin/orders.js` 退款不触碰 invoices |

### 3.6 F 组 · 开关、权限与入口治理

| # | 场景 | 触发条件 | 前端表现 | 服务端行为 | 资金流向 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|
| F1 | `enable_subscription` 关闭·桌面端入口 | 管理台关掉开关 | 侧栏 `nav.subscription` 与设置项隐藏（WS 推送 + 拉取），已挂载的弹窗也兜一层不再出卡 | 无 create-order 侧拦截 | 见 F2 | **已实现未验证** | `useMenuAccess.ts:52-54`、`PricingPaymentModals.vue`（can 判定） |
| F2 | `enable_subscription` 关闭·直接打 API 付款 | 老客户端/curl | 入口看不见但接口照样能用 | **create-order / refund / 履约全链路无任何 flag 判定**；只有 `subscriptionCheck`/`planFeature` 把权益按 Free 判定 | **钱照常收**、订阅照常开（只是按 Free 生效） | **缺陷** | `planFeature.js:78-80`、`subscriptionCheck.js:51-54`、`payments.js` 全文无 flag |
| F3 | `enable_subscription` 关闭·移动端入口 | 同上 | 订阅入口隐藏（`flags: ['enable_subscription']`） | 同 F2 | 无 | **已实现未验证** | `feature_flags_provider.dart:70`、`settings_screen.dart:320` |
| F4 | 开关关闭期间存量订阅 | 开关切回开启 | 权益恢复 | 开关只影响判定，不改库、不动订单 | 无 | **已实现未验证** | `planFeature.js:78` 注释 |
| F5 | 非属主且非管理员调 `/api/payments/refund` | 普通登录用户退**别人**的单 | 桌面端只列自己的单，正常走不到 | 404 `ORDER_NOT_FOUND`（与「订单不存在」**完全同壳**，防订单存在性探测；`ADMIN_REQUIRED` 仅在调用方账号行不存在时出现） | 无 | **已实现未验证** | `payments.js` 属主/管理员分支 |
| F5b | 属主自助退款被闸拒 | 用户点「申请退款」里非锚点的单 / 超窗的单 | 弹窗列表预标 reasonCode，点击前即知原因（判定与强制点同源，不会漂移） | 非锚定单 → 409 `NOT_CURRENT_SUB_ORDER`；支付超 7 天或 paid_at 缺失 → 409 `REFUND_WINDOW_EXPIRED`（fail-closed），均不碰渠道 | 无 | **已实现，单测+生产冒烟通过** | `refundPolicy.js`、`PlanManagementCard.vue` |
| F5c | 可退订单清单 | `GET /api/payments/refundable-orders`（本人最近 10 条 paid/refunded） | 退款弹窗数据源；升级单摊开 原价/折抵/实付 | flag 关闭 503；不返回隐私字段；reasonCode 与 POST /refund 同源 | 无 | **已实现，生产冒烟通过** | `payments.js`、`refundPolicy.js` |
| F5d | **顺移退历史单**（薅羊毛攻击） | 用户退掉锚定单后，再点列表里上一笔已付单 | 列表显示「不属于当前订阅，请联系客服」 | 锚定单退款成功 → 订阅 `canceled` → `findSelfRefundAnchorOrderId` 返回 null → 其余任何 paid 单一律 409 `NOT_CURRENT_SUB_ORDER`，零渠道调用 | 无（旧口径在此处可被连续退款，2026-09-20 已堵） | **已实现，回归用例 + 生产实测通过**（测试号 4 单全 `refundable=false`） | `refundPolicy.js:162-177`、`tests/payment-refund.test.js:297` |
| F6 | 管理台角色无 `admin.orders.refund` | 内置 admin 角色 | 退款按钮 disabled + Tooltip「缺少权限」 | 后端 `requirePerm` 403 `code:4030` | 无 | **已实现未验证** | `orders/index.tsx:121-122`、`adminAuth.js:93-134` |
| F7 | 管理台角色无 `admin.orders.reconcile` | 自定义角色 | 「对账报告」按钮**未按权限裁剪**，点了才报错 | 403 | 无 | **缺陷（小）** | `orders/index.tsx:270` 无 `hasPerm` |
| F8 | 管理台「人工赠期」 | 超管在 `/subscriptions` 赠期 | 弹窗选 Pro/Enterprise + 1-12 月 + 原因 | 服务端要 **UUID**（`UUID_RE.test(planId)` + `WHERE id=$1`），前端发的是 `'pro'`/`'enterprise'` → **真实后端必 400** | 无 | **缺陷** | `admin/subscriptions.js:181,197-200` vs `GrantSubscriptionModal.tsx:27-60` |
| F9 | 人工关单 | 老需求 | 订单页已无「关闭」按钮（AF-15） | 只有 E1 的自动关单 | 无 | **已禁用** | `orders/index.tsx:215-217` 注释 |

### 3.7 G 组 · 发票与账务可见性

| # | 场景 | 触发条件 | 前端表现 | 服务端行为 | 资金流向 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|
| G1 | 履约时开票失败（钱已收） | `invoices` INSERT 抛错 | 用户无感；订单仍 paid、订阅仍 active | `try/catch` 内 error 日志，**不回滚支付**；`invoiceNo=null` | 入账，发票缺 | **已实现未验证** | `orderFulfillment.js:198-221` |
| G2 | 账单列表查询 | 桌面端「账单」页 `GET /api/invoices` | `catch {}` 静默 → 显示「暂无账单」（把 500 伪装成空态） | SELECT 了不存在的 `i.tax` / `i.invoice_url` → 42703 → 500 | 无 | **缺陷** | `routes/invoices.js:20-24`、`BillingSubPage.vue:31-40`、`004_subscription_tables.sql:105-119` |
| G3 | 账单详情 | `GET /api/invoices/:id` | 同上静默 | `i.tax`、`i.invoice_url` 不存在（`sp.price` 由 010 迁移补过，可用） | 无 | **缺陷** | `routes/invoices.js:129-167` |
| G4 | 发票 PDF 下载 | 点下载 | 请求失败 | 先 `setHeader('Content-Type','application/pdf')` 再 `res.status(501).json(...)` —— 明确未实现 | 无 | **未实现** | `routes/invoices.js:88-123` |
| G5 | 管理台看发票/开票状态 | — | **管理台无发票模块**（`src/admin-console/src/api` 无 invoices.ts），订单详情也没有 `invoiceNo` 字段 | 发票只存在于 `invoices` 表与订单 `invoiceNo`（履约返回值），管理台读不到 | 无 | **未实现** | `api/types.ts` Order 契约、`admin/orders.js mapOrderRow` |
| G6 | 财务对账口径 | 超管点「对账报告」 | 三行（微信/支付宝/Stripe）+ 合计 + 生成时间 | 本站 `payment_orders` 近 30 天按渠道聚合；`generatedAt`=请求时刻 | 只读 | **已实现未验证**（且渠道行会被未知渠道计入「微信支付」，§4-A4） | `admin/orders.js:349-397`、`ReconciliationModal/index.tsx` |

### 3.8 合计与状态分布

| 分组 | 场景数 | 已验证 | 已实现未验证 | 未实现 | 已禁用 | 缺陷 |
|---|---|---|---|---|---|---|
| A 下单与履约 | 12 | 1 | 9 | 0 | 2 | 0 |
| B 档位变更 | 10 | 0 | 9 | 0 | 0 | 1 |
| C 扫码交互 | 8 | 1 | 5 | 0 | 0 | 2 |
| D 回调/轮询/验签 | 12 | 2 | 8 | 1 | 1 | 0 |
| E 清扫/退款 | 12 | 0 | 8 | 1 | 0 | 3 |
| F 开关与权限 | 9 | 0 | 5 | 0 | 1 | 3 |
| G 发票与账务 | 6 | 0 | 2 | 2 | 0 | 2 |
| **合计** | **69** | **4** | **46** | **4** | **4** | **11** |

**结论：截至本快照，生产实测过的只有 4 项 —— 首次订阅月付全链路（A1）、回调先到履约（D1）、
rawBody 解析修复（D9）、二维码 99 s 过期（C2）。**
其余 46 项是「读代码可得、但未在真机/生产走过这条分支」的推断状态，4 项未实现、4 项有意禁用、
**11 项已确认缺陷**（其中 §4-A1 管理台假退款、§4-A8 迁移 072 前置为合入阻断项）。
`D6 验签失败` 一行的正向部分（真签名被接受）随 A1 一并实测过，拒绝分支未测，故该行按主状态计入 `已实现未验证`。

---

## 4. 缺陷清单（与矩阵状态列联动，按严重度排序）

> 编号 A1–A20 是**审计发现**条目：矩阵 §3 的「缺陷」状态列与「§4-Ax」引用都指向这里。
> 一条发现可能让多个场景标为缺陷，也可能不改变任何单行状态（纯契约/文案类，如 A11/A13）。
> 标 **（待决策）** 的条目不在本次改动范围内（属 `src/server` 或保护清单文件）。

### P0 · 资金/权益语义相反，合入前必须处理

- **A1 — 管理台「退款」按钮不动钱，而真实退款端点没有管理台入口。**
  `POST /api/admin/orders/:orderNo/refund`（`src/server/src/routes/admin/orders.js:252-343`）只做「标记」：不调 `alipay.trade.refund`、允许部分金额、且只有「年付+全额」才取消订阅。
  同日新实现的 `POST /api/payments/refund`（真实打款 + 订阅立即收回）在管理台**没有任何调用点**（`src/admin-console/src` 全文无 `/api/payments/*`）。
  后果：超管在管理台点「退款」→ 订单显示「已退款」、审计写成功、用户钱没退、权益可能还在 —— 正是 2026-09-19 用户在用户侧被 501 阻断的那个假退款，在管理台仍然活着。
  建议（择一，需主控决策）：① 管理台退款改接真实退款（需后端为管理端暴露带 RBAC + 幂等的渠道退款端点，前端 `refundOrder` 换 URL、金额字段收敛为只读全额）；② 在渠道退款接通前把管理台退款按钮禁用并说明「走客服/`/api/payments/refund`」。

- **A2 — 真实退款的权限口径与管理台 RBAC 不一致。**
  `/api/payments/refund` 用 `users.is_admin` 布尔列（`payments.js`），管理台全站用 `roles.level`/`permissions`（`adminAuth.js`）。两套身份判定并存 → 谁能退钱取决于历史列没被关掉。建议收敛为 `requirePerm('admin.orders.refund')` 或让管理端专用端点承载真实退款。

### P1 · 会算错钱 / 会误判

- **A3 — `/api/subscriptions/subscribe` 无档位拦截。** 同套餐只回 400、降档完全无判定、按目标套餐全价建单（`routes/subscriptions.js:169-224`），与 create-order 的 409 口径分叉；前端不再调用它，但它是活的。
- **A4 — 渠道归一化把「认不出的渠道」算成微信支付。** `CHANNEL_CASE_SQL` 的 `ELSE 'wechat'`（`admin/orders.js:40-46`）会把 `mock`、空 `payment_channel`（历史 pending 单未履约时 `payment_channel` 为 NULL）全部计入「微信支付」行 —— 而项目根本没有微信渠道。对账/看板/占比三处一起虚高。
- **A5 — `user_subscriptions.auto_renew` 默认 true 且无消费方。** 在「无自动续费」（PD1）前提下，管理台订阅列表/用户抽屉仍会显示「自动续费：是」。
- **A6 — 升级折抵明细在桌面端取不到。** 服务端 create-order 把 `proration` 放在**响应顶层**（并另在 `order` 里给 `originalAmount/creditAmount`），桌面端 `PricingPaymentModals.vue` 的 `onOrderCreated(order)` 读的是 `order.metadata.proration` → 恒 undefined → 折抵三行永不渲染。属并行开发中的接线缺口，合入前需复核。
- **A7 — 同一 pending 订单可无限张。** 每次「重试二维码」都新建 order_no，`create-order` 无「同用户同套餐 pending 单复用/取消旧单」逻辑，也没有 `expired_at`（该列存在但从不写）。管理台待支付 Tab 与看板「超 24 h 待支付」会被同一人的多张单刷屏。
- **A8 — 迁移 072 是真实退款/升级取代的硬前置。** `payment_orders.refunded_at`、`user_subscriptions.canceled_at` 只存在于未提交的 072；若 072 未在生产执行，真实退款会在「钱已退出去」之后 UPDATE 失败（走 E5 人工补账），升级履约则整体回滚 → 用户付钱不开订阅。上线前必须确认迁移已应用。

### P2 · 管理台/后台数据与文案

- **A9 — `Order.outTradeNo` 恒为空。** 后端从不写 `payment_orders.out_trade_no`（支付宝侧商户单号其实就是 `order_no`）。已修：详情弹窗空值回退 `—`，并在 `types.ts` 注明（`OrderDetailModal/index.tsx`）。
- **A10 — `Order.planLabel` 在未履约订单上为空/错标周期。** 旧建单不写 `plan_id` → `COALESCE(us.plan_id, po.plan_id)` 无值；`billing_cycle` 只从关联订阅取 → 年付新单在履约前显示「月付」。create-order 现已补写 `plan_id`，但**周期仍取自订阅**，需服务端改读 `metadata->>'billingCycle'` 才能修好（不在本次可改范围）。
- **A11 — 审计页「支付相关」筛选在生产上一次都命中不了。** 后端 `action=payment` 写成 `LIKE 'payment.%' OR LIKE 'admin.refund.%'`（`admin/audit.js:133-134`），而真实 action 值是 `payment_create` / `payment_complete` / `payment_auto_close` / `payment_refund`（下划线，`utils/audit.js:253-259`）与 `admin.orders.refund`。mock handlers 里用的是 `admin.refund.execute`，把这条漂移遮住了（mock 测试全绿）。服务端修 `LIKE 'payment\_%' OR action='admin.orders.refund'` 即可，属 `src/server` 范围。
- **A12 — 人工赠期在真实后端必 400。** 见 F8：前端发 `'pro'`、后端要 UUID。最小修法在服务端（`WHERE id=$1 OR name=$1` 再取 id）；前端改法是「拉 plans 换 UUID」，牵动 `types.ts` 契约，属较大改动 → **待决策**。
- **A13 — 对账报告文案谎称来源。** 「数据来源各支付渠道日终对账文件」实际是本站订单表即时聚合 → 已修（`ReconciliationModal/index.tsx` 页脚 + `types.ts` 契约注释）。
- **A14 — 退款后对账弹窗读旧缓存。** `['reconciliation']` 不在 `['orders']` 前缀下 → 已修（`orders/index.tsx` 退款成功回调里一并失效）。
- **A15 — 订单页缺「已关闭」Tab。** 无法筛 `cancelled` 去看 E1/E2 的单 → 已修（`STATUS_TABS` 增加 `cancelled`）。
- **A16 — 「对账报告」按钮未按 `admin.orders.reconcile` 裁剪**（F7）；自定义角色点了才报错。**未改，待决策**（涉及全站按钮裁剪惯例）。
- **A17 — 看板 14 天柱状图只有 2 个日期刻度。** `axisLabel.interval` 写成 `data.length-4`（14 天=10）→ 已修为「最多约 7 个刻度」；同处 `.replace('-','-')` 是空操作，已删（`charts/OrderBarChart.tsx`）。
- **A18 — mock 与真实后端的三处形状漂移（保护清单文件，仅记录不动）：**
  ① `mocks/handlers.ts` 的退款审计 action 用 `admin.refund.execute`（真实是 `admin.orders.refund`）；
  ② mock 赠期校验 `planId ∈ {pro,enterprise}`（真实要 UUID），把 A12 完全遮住；
  ③ mock 订单渠道含 wechat/stripe 且退款单必带 `refundAmount`（真实「处理中」态在 mock 里永远出不来），`mocks/data.ts` 的 128 笔总量也是硬编码。
  这三条都在 `src/admin-console/src/mocks/*` 与 `pages/settings/index.tsx` 保护清单内，**交主控决定**。
- **A19 — 支付相关 view 权限键在角色页被分到「运营」组。** RB-06（迁移 049）为 `GET /admin/orders` 等 7 个读端点补了 `requirePerm('admin.*.view')`，但 `routes/admin/roles.js` 的 `PERM_CATALOG` 只登记了 3 个 view 键；`admin.orders.view` 等未登记 → `GET /admin/permissions` 兜底把它们归到 `category: 'operations'`、排在目录末尾。功能上可授予（PATCH 按 DB 校验），但角色权限页里「查看订单与退款流水」出现在错误分组，运营配置时容易漏 → 自定义角色漏授即订单页 403。
- **A20 — `routes/admin/orders.js` 文件头注释与实际不符。** 注释写「GET /orders、/orders/:orderNo → 无额外权限点（admin 等级即可见）」，代码两处都挂了 `requirePerm('admin.orders.view')`；退款段的「订阅联动」描述也落后于 PD3（只覆盖年付全额）。属 `src/server` 文件，未改。

---

## 5. 复测清单（把 §3 的 `已实现未验证` 转成 `已验证` 的最小集合）

| 优先级 | 要验的分支 | 最小做法 | 判定要点 |
|---|---|---|---|
| 1 | D2 轮询兜底成功 | 测试环境把 `ALIPAY_NOTIFY_URL` 指到不可达域，扫码付款 | 95 s 内轮询即返回 paid；日志有 `order fulfilled via poll fallback`（任务板 #5） |
| 2 | D3 回调/轮询并发 | 恢复 notify、把轮询间隔临时设 1 s | 只 1 次 `changed:true`；订阅/发票各 1 条 |
| 3 | D5 金额闸 | 用已配置密钥手工 POST 一条 `total_amount` 被改小的报文 | 500 `failure`、订单仍 pending、`amount mismatch` error 日志 |
| 4 | D6 验签失败 | 同上，`sign` 随便改一个字符 | 401 `failure`，无副作用 |
| 5 | B2/B7 409 两枚 | active 期内分别点同档/低档 | 409 + `ALREADY_SUBSCRIBED`/`DOWNGRADE_NOT_ALLOWED`，**库里不落单** |
| 6 | B4 升级折抵 | 买月付 Pro → 立刻升 Enterprise | 订单金额=新价−残值；旧订阅 `canceled`+`canceled_at`；结果页三行金额对得上；桌面端需先修 A6 |
| 7 | B1/B3 续费顺延 | 让同套餐 active 期内二次付款绕过 409（直接建单+mock 渠道，测试环境） | `current_period_end` 顺延 1 个月，**不出现第二行 active** |
| 8 | E3/E4/E6 真实退款 | 生产小额：付款→管理台/接口退款→重复再退→失败再退（可临时把密钥配错造失败） | 只在 `fund_status='Y'` 后库变；失败时订单仍 paid；重复 409；支付宝账单侧能查到退款 |
| 9 | E2 关单后到账 | 建单后挂起 >24 h（或临时把阈值调成 1 分钟）再付款 | 订单 cancelled、钱到账、权益未开、确认人工处置路径（当前只能改库或走渠道后台退款 → 见 A1/E7） |
| 10 | A2 年付 | 桌面端切「年付」买最小金额档 | `price_yearly` 计价、订阅 +1 year、管理台 `planLabel` 显示「年付」（现在会错显「月付」，见 A10） |
| 11 | G2 账单页 | 付款成功后开「账单」 | 现在必 500 且界面显示「暂无账单」；修 `i.tax`/`i.invoice_url` 后复测 |
| 12 | F2 flag 关不死支付 | 管理台关 `enable_subscription` 后直接 curl create-order | 目前仍能建单收款 —— 决定是否给 create-order 加 `requireFlag('enable_subscription')` |

---

## 6. 本次已落地的管理台小修复（与本矩阵同步提交）

| 对应缺陷 | 文件 | 改动 |
|---|---|---|
| A9 | `src/admin-console/src/components/OrderDetailModal/index.tsx` | 商户单号空值回退 `—` + 注明「后端从不写 out_trade_no，支付宝侧商户单号即订单号」 |
| A13 | `src/admin-console/src/components/ReconciliationModal/index.tsx`、`api/types.ts`、`api/orders.ts` | 删掉「数据来源各支付渠道日终对账文件」的错误口径，改为「本站订单表近 30 天聚合、generatedAt=请求时刻、不可当渠道核销依据」 |
| E9 | `src/admin-console/src/components/RefundModal/index.tsx`、`api/orders.ts` | 退款弹窗按实时输入金额给出诚实提示：部分退款/月付全额都不会收回订阅权益，管理台无「终止订阅」入口；`refundOrder` 注释标明「记账式标记、不调渠道」 |
| A14 | `src/admin-console/src/pages/orders/index.tsx` | 退款成功后同时失效 `['reconciliation']`（否则对账弹窗读退款前缓存） |
| A15 | `src/admin-console/src/pages/orders/index.tsx` | 状态 Tab 增加「已关闭」（`cancelled`），E1/E2 场景的单终于可筛 |
| A17 | `src/admin-console/src/components/charts/OrderBarChart.tsx` | 修 `axisLabel.interval`（14 天数据原本只剩 2 个刻度）+ 删除空操作 `.replace('-','-')` |
| A10 | `src/admin-console/src/api/types.ts` | `Order.planLabel` / `outTradeNo` 契约注释补齐两个已知数据缺口（改不了，只能先把坑写明） |

`npx tsc -b --force` 与 `npx vitest run`（83 例）全绿。未改动保护清单文件
（`api/configs.ts`、`mocks/*`、`pages/settings/index.tsx`）。

---

## 7. 与相邻文档的关系

- 渠道资质/申请步骤/沙箱信息：`docs/product/payment-integration-guide.md`（含 2026-09-16 主体口径修正）。
- 回调不可达、假 subscribe 等历史事故全貌：`docs/audit/external-dependency-audit-2026-09-09.md` B1 节。
- 管理台契约的单一事实来源：`src/admin-console/src/api/types.ts`（本矩阵 §4-A 各条已同步注释）。
- 本文只覆盖**支付场景状态**；管理台支付模块（`/orders`、`/subscriptions`、`/plans`、看板、审计页）与生产 API 的逐字段核对结论，全部落在本文 §4 的 A1–A20 条目里（含文件:行）。

---

**文档结束**
