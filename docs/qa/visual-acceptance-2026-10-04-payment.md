# 支付相关视觉验收流程（2026-10-04）

- **范围**：本轮 14 个提交里与支付/订阅相关的部分，以及此前 agent 已提交的「支付可观测性 / 退款审核 / 管理台逃生口」改动。
- **结论先行**：**存在**可执行的视觉验收流程 —— 管理台、桌面端、移动端、官网四处都有真实界面可点。但**这些界面几乎没有任何 e2e/视觉自动化覆盖**（只有管理台两条 smoke 用例，且不碰支付面），因此下面每一项都需要人工过一遍。
- 每项的格式：`入口 → 操作 → 期望看到 → 代码锚点`。

---

## 0. 前置准备

| 项 | 说明 |
|---|---|
| 后端 | dev 栈：`docker compose -p clipsync -f docker-compose.dev.yml up -d`（API 在 :3001） |
| 管理台 | `cd src/admin-console && npm run dev`（:5273） |
| 桌面端 | `cd src/desktop && npm run tauri dev`（dev 构建：设置里可改后端地址） |
| 移动端 | `cd src/mobile && flutter run`（USB 真机） |

> ⚠️ **管理台 MSW 坑（会直接误导验收结论）**：dev 默认开启 MSW（`src/main.tsx:26-37`），但 mock 层**没有** `/admin/ops/alipay-status` 与 `/admin/refund-reviews` 两个端点。因此
> - 「渠道状态卡」会渲染成**「读取失败」**分支（灰字说明"这不代表支付宝渠道异常"）；
> - 「退款审核」表会是**空表**。
>
> → **验收 A1 / A6 必须连真实后端**：启动时给 `VITE_ENABLE_MSW=false`（或按 `src/admin-console/.env.development.local` 指向你的后端）。其余项 mock 下可看形态，但数据是假的。

管理台 e2e 的登录辅助是手机号 `13505110772` + 验证码 `888888`（`src/admin-console/tests/e2e/helpers.ts`）—— 印证 dev 下验证码本就是固定码。

---

## A. 管理台（重点）

### A1. 渠道状态卡「支付宝渠道状态」
- **入口**：侧栏「系统」→ **运维监控** `/ops`
- **操作**：打开页面，等自动刷新（30s 轮询）
- **期望**：
  - 卡片右上「只读自检 · 凭据异常时用户无法下单付款」
  - **「能否收款」= 绿「正常」**（生产凭据齐全时）
  - 「结论」行：正常 → 「支付宝渠道凭据正常」；异常 → 「支付宝渠道异常：当前无法收款」+ **逐条**待改项 `<ul>` 清单
  - 关键判读：**「读取失败」≠ 渠道坏**（灰字），别把它当成渠道异常上报
- **锚点**：`admin-console/src/pages/ops/index.tsx:432-479`、`pages/ops/alipayStatus.ts:13-20`、API `api/ops.ts:64-74`
- **反例验证**：故意把 `ALIPAY_PRIVATE_KEY` 留空重启后端 → 应变成「异常 + 需要处理 N 项」；恢复后变回正常

### A2. 看板待办（服务端共 **7 类**，不是 2 类）
- **入口**：`/dashboard` 滚到底「待处理事项」；或顶栏铃铛
- **操作**：对照数据库构造/找到对应订单，看它落在哪一类
- **期望**：表格列 = 事项 / 类型(Tag) / 关联对象 / 发生时间 / 操作；类型配色：支付=红、订阅=琥珀、对账=琥珀、安全=蓝、审批=琥珀
- **7 类清单**（按优先级，互斥）：
  1. 待审核用户（approval）
  2. 退款处理中（payment）
  3. **异常到账：渠道已付款但订单未履约**（reconcile）← 高优先级，**绝不能**标成"待支付"
  4. 待支付订单超 24 小时（payment）← 已排除 3/6/7 类
  5. 退款申请卡在处理中（reconcile）
  6. 金额不符，履约被拒（reconcile）← 已排除 3 类
  7. **渠道状态未知：无法核实是否已收款**（reconcile）← 本轮新增
- **互斥验收（本轮改动）**：造一张 `created_at` 超 24h 且 `metadata.amount_mismatch='true'` 的 pending 单 → **只应出现第 6 类一条**，不应同时出现在第 4 类
- **锚点**：`admin-console/src/pages/dashboard/index.tsx:16-67,273-281`、`AdminLayout.tsx:188-195,278-286`、服务端 `src/server/src/routes/admin/overview.js:198-368`

### A3. 订单页 + 异常到账处置入口
- **入口**：侧栏「业务运营」→ **订单与支付** `/orders`
- **操作**：找一张「渠道已付款但本地未履约」的单（`metadata.channel_reports_paid=true` 且 status≠paid）
- **期望**：
  - 状态 Tabs 里有 **「已关闭」**（异常到账/关单溯源需要）
  - 操作列出现灰底红字的 **「异常退款」** 按钮（普通单只有「详情」+「退款」）
  - 右上「对账报告」按钮 → 弹窗显示 渠道/笔数/成交额/退款额
- **锚点**：`pages/orders/index.tsx:42-56, 234-279, 329-331`

### A4. 订单详情弹窗（异常到账红色告警）
- **操作**：点 A3 的「详情」
- **期望**：`channelReportsPaid` 时顶部**红色 Alert**「异常到账：渠道已付款，但本地订单未履约」+ 动作按钮 **「异常到账：发起退款」**；时间线按 `autoClosed` / `closedByChannel` / `channelReportsPaid` 分流显示
- **锚点**：`components/OrderDetailModal/index.tsx:29-93, 139-173`

### A5. 退款弹窗（异常到账黄色告警 + 全额只读）
- **操作**：点「退款」/「异常退款」
- **期望**：异常到账时黄色 Alert「异常到账处置：渠道已收款，本地未履约」；金额**全额只读**（无输入框）；原因必填
- **反向验收**：普通已付单试图部分退款 → 应被拒并显示 `PARTIAL_REFUND_NOT_SUPPORTED` 说明（一期只支持全额退）
- **锚点**：`components/RefundModal/index.tsx:124-165`

### A6. 退款审核页
- **入口**：侧栏「业务运营」→ **退款审核** `/refund-review`
- **期望**：
  - 页头说明「通过的那一刻才调用支付宝原路退回」
  - 顶部「退款设置」卡（自助退款时限 / 审核承诺工作日）可保存
  - Tabs：待审核 / 处理中 / 已通过 / 已驳回 / 全部
  - **「处理中」行的按钮是「对账并重试」+ 副文案「卡住时先查单再重试」**（这就是审计 H3 的逃生口，此前在 UI 上不可达）
  - 通过 = 红色 Alert「不可撤销」；驳回 = 必填理由
- **锚点**：`pages/refund-review/index.tsx:43-54, 347-401, 406-469, 490-560`

### A7. 订阅管理 / 套餐与价格
- **入口**：侧栏「业务运营」→ 订阅管理 `/subscriptions`；「配置」→ 套餐与价格 `/plans`
- **期望**：订阅表可看状态并有「赠期」弹窗；套餐页可改价格/配额/features（**注意**：改 features/限额会**即时影响已购用户**，改价只影响新单）
- **锚点**：`pages/subscriptions/index.tsx:61-80`、`pages/plans/index.tsx:23-32`

---

## B. 桌面端（支付主链路）

> 桌面端**没有**独立的订阅页面/路由（`router/index.ts:9-18`），订阅 UI 只在弹窗 + 设置子页 + 个人资料卡里。

### B1. 套餐弹窗
- **入口**：侧栏账号区「升级」胶囊 / 账号菜单「升级」；或 设置 →「订阅与账单」→「当前套餐」
- **期望**：三档 Free/Pro/Enterprise 卡 + 月付/年付分段 + 价格（来自后端 `GET /api/subscriptions/plans`）+「热门」角标
- 有生效付费订阅时，底部出现「剩余时长将折抵差价」（`PlanCards.vue:109-111,167`）
- **锚点**：`components/pricing/PlanCards.vue`、`components/modals/PricingPaymentModals.vue`

### B2. 结账弹窗 —— 一个弹窗干完全部 ★（2026-10-05 改版）
- **操作**：B1 里点某档的「升级 / 订阅」
- **改版说明**：旧的「套餐卡 → 支付方式 → 扫码 → 结果」**四个弹窗接力**已合并为**一个 checkout 弹窗**
  （左＝折抵明细，右＝支付方式 + 二维码；支付成功后**原地**切结果页）。
  外部入口仍只有模态类型 `'pricing'`；`payment` / `pay-scan` / `payment-result` 已退场。
- **期望**：
  - **左栏折抵明细**，进弹窗**立即**显示 —— 走只读试算 `POST /api/payments/upgrade-quote`，**不建单**
    （所以不会为了看明细而多出一条 pending 单）：
    - 「当前套餐」段：当前套餐支付金额 / 已使用金额 / 剩余可抵扣金额 / 当前有效期至
    - 「升级后套餐」段：新套餐价格 / 新套餐有效期至（**预计** —— 履约是「从 NOW() 起完整一个周期」，
      下单前算不出精确值，支付成功后结果页显示服务端真实到期时间）
    - **需支付的差额**（大字）
  - 无生效订阅（全价新订）→ **只出现「升级后套餐」段**，不显示一个空的「当前套餐」
  - 赠期/mock 订阅（该订阅无支付记录）→ 多一行「该订阅没有支付记录，上表按套餐标价折算」
    （服务端 `creditSource='plan'`）——**不能让它读成「你付过这笔钱」**
  - **残值高于新价**时 → 多一行**作废金额**（owner 2026-10-05 口径：保持作废，但必须写明，
    否则用户自己一算「剩 ¥89.10 为何只付 ¥0.01」就是一笔糊涂账）
  - **右栏**：套餐名 + 周期；渠道两格 = **支付宝（激活）** + **微信支付（禁用占位，带「暂未开放」）**
  - 二维码旁金额必须是**折抵后差额**，不是目录标价（旧实现显示标价 → 界面 ¥19.90 / 订单 ¥19.89 对不上）
  - 试算接口失败**不阻断支付**：明细区如实说明「折抵明细读取失败 / 实付以订单为准」，扫码区照常可用
- **锚点**：`components/modals/PricingPaymentModals.vue`、`components/payment/checkoutMath.ts`（金额口径纯函数）

### B3. 扫码支付（协议遮罩 + 3s 轮询）
- **期望**：
  - **未勾选协议时二维码区是斜纹遮罩**「勾选协议后显示二维码」（不得默认勾选）
  - 勾选后露出支付宝收银台二维码 + 「等待支付…」
  - 下单失败 / 95s 过期各有说明 + 「重试」
- **锚点**：`components/payment/AlipayScanPay.vue`（遮罩 `:216-221`、协议 `:247-260`、轮询 `:80, 136-155`）
- **自动化护栏（2026-10-05 新增）**：`components/payment/__tests__/AlipayScanPay.test.ts` 7 例
  （未勾选绝不下单 / 下单一次并抛顶层 proration / 3s 轮询命中 paid 停表 / cancelled→过期文案 /
  95s 转过期态 / 409 走本地文案不漏服务端英文 / hideFooter）

### B4. 支付结果（**同一个弹窗内**，不再另开）
- **期望**：成功态（绿对勾）+ 明细（订单号/套餐/原价/折抵/实付/支付时间/到期时间）
- **注意**：只有 `success` 会被写入，`pending`/`fail` 无代码路径（见 §F）
- **锚点**：`PricingPaymentModals.vue`（checkout 弹窗的 `paymentResult` 分支）

### B5. 设置 →「订阅与账单」→「账单历史」★
- **入口**：设置 → 订阅与账单 → 账单历史
- **期望**：发票列表（发票号/日期/金额/**下载**），点下载得到真 PDF；空态文案正常
- **为什么重点**：**本轮修掉的 500 就在这里** —— 账单详情此前引用不存在的 `sp.price` 列，在经 011a 重建过的库上必 500。若这条能打开，说明修复生效。
- **锚点**：`components/settings/settings-dialog/sub-pages/BillingSubPage.vue:94-186`、服务端 `src/server/src/routes/invoices.js:327-335`

### B6. 个人资料 →「套餐管理」卡
- **期望**：「一次性购买、无自动续费」说明；**付费生效且该订阅有真实已付订单支撑**时出现「申请退款」
  → 退款弹窗（订单清单 → 二次确认 → 提交）；有待审退款时显示「退款审核中」行
- **2026-10-05 判据收紧**：入口不再只看 `paidActive` —— 它是由**套餐目录价 > 0** 推出的，
  管理台**赠期**出来的订阅同样满足，于是「一分钱没付过」的账号也会冒出退款入口（owner 实测：
  赠期一个月 Pro 后立刻出现）。现在由服务端 `GET /api/subscriptions/current` 的 `purchaseBacked` 决定
  （判据 = 自助退款锚点查询 `refundPolicy.findSelfRefundAnchorOrderId`）。
  `purchaseBacked === false` 才收口；**字段缺失（旧后端）退回旧行为** —— 不能因为后端没升级
  就让所有人的退款入口集体消失，那是假故障。
- **退款弹窗（本轮同时修）**：顶部加**结论行**（有 N 笔可退 / 历史订单已全退 / 都退不了），
  并把**还能操作的单排到最前** —— 服务端按 `paid_at` 倒序返回，而唯一可自助退的锚点单通常最老，
  会被挤到折叠线以下（owner 就是这么判成「弹出的页面没有真正可以退款的地方」的）。
- **反例验证（赠期必须收口）**：给一个**从未付过钱**的账号赠期 → 客户端**不得**出现「申请退款」
- **锚点**：`components/settings/PlanManagementCard.vue`、`composables/useSubscriptionAccess.ts`
  （`canRequestSelfRefund` / `purchaseBacked`）、服务端 `routes/subscriptions.js` 的 `/current`

---

## C. 移动端

> 移动端**不做支付**，只引导到桌面端 —— 所以**没有支付结果页**（见 §F）。

### C1. 订阅管理（唯一订阅入口）
- **入口**：设置 tab →「订阅管理」`/subscriptions`
- **期望**：当前套餐卡（渐变顶边 + 「当前套餐」徽标 + 状态 chip + 到期/试用行 + 权益清单）；active 时底部「取消订阅」（红描边）/「恢复订阅」
- **锚点**：`screens/subscription/subscription_management_screen.dart:365-611`

### C2. 桌面端支付提示卡
- **期望**：「移动端暂不支持支付…请在桌面端…完成支付」
- **锚点**：同文件 `:640-676`

### C3. 可选套餐 + 账单记录 ★
- **期望**：每档套餐按钮为禁用的「请在桌面端完成支付」；账单记录区能列出/或空态「暂无账单记录」
- **为什么重点**：账单记录同样走 `/api/invoices`，与 B5 同一处修复
- **锚点**：同文件 `:682-824, 830-896`

---

## D. 官网

### D1. `#encrypt` 段（本轮改了文案）
- **期望**：标题「端到端加密，由你随时开启。」；正文含「未开启时由全链路 TLS 传输加密保护」；2.1 项写「**开启端到端加密后**，加解密全部发生在你的设备上」
- **锚点**：`src/website/index.html:118-137`（标题 `:121`、正文 `:122`、2.1 `:132`）

### D2. `#pricing` 段
- **期望**：三档价格 Free ¥0 / Pro ¥9.9·月 或 ¥99·年 / Enterprise ¥19.9·月 或 ¥199·年；定价表该行写「端到端加密（**可选**） · AI 分类 · 离线队列」；支付渠道注「支付宝」
- **锚点**：`index.html:157-204`（表行 `:172`、渠道注 `:185`）

> 官网构建自带产物校验：`cd src/website && npm run build && npm run check`，会断言关键文案（含「端到端加密」）与价格口径。

---

## E. 今天非 UI 改动对应的可观察点（跑一遍即回归）

| 改动 | 怎么观察到 |
|---|---|
| 升级折抵**试算**接口（`POST /api/payments/upgrade-quote`，只读不建单） | B2：点「升级」立即出明细；再连着点几次，**订单列表里不会多出 pending 单** |
| 试算 == 实收 | B2：明细里的「需支付的差额」与随后建单的实付**逐分一致**（服务端 `tests/upgrade-quote.test.js` 钉死） |
| 退款入口判据 `purchaseBacked` | B6：纯赠送（从未付过钱）的账号**不再**出现「申请退款」入口 |
| 残值高于新价 → 作废金额可见 | B2：明细里出现「本次折抵上限为新套餐价，超出部分 ¥X 不再结转」 |
| 账单详情 500 修复 | 桌面 B5 / 移动 C3 能打开并下载发票 |
| 看板待办互斥 + 新增第 7 类 | A2：同一单不再以两条待办重复出现 |
| 异常到账退款补 `paid_at` | 管理台「对账报告」与看板退款率 KPI 里**能见到**这笔退款（此前完全不可见） |
| 关单扫描 fail-closed | 缺签名凭据时超时单不再被本地关掉，而是出现在第 7 类待办 |
| WS 重连竞态 / 设备解绑踢连接 | 两台设备互相同步：断网重连后**仍能收到推送**；在 A 上删除 B → B 立刻停止接收 |
| `/api/sync/push` 补条数配额 | 免费账号推满条数后，同步推送应 403（此前可绕过） |
| E2 发行版地址 | dev 构建**不受影响**（可改地址）；release 包才会锁到 `api.clipchain.top` |

---

## F. 已知不存在 / 不可达（**别去找**）

1. **移动端没有支付流程**，也没有支付结果页 —— 只有对桌面端的引导（`subscription_management_screen.dart:640-676`）。
2. **桌面端没有独立订阅页/路由**（`router/index.ts:9-18` 的子页白名单里没有）。订阅只在弹窗 + 设置子页 + 个人资料卡。
3. **桌面「支付渠道接入中」是死分支**：`sub_result_pending` 文案存在（`locales/zh.json:808`），但没有任何代码路径把 `paymentResult.kind` 置为 `pending`/`fail`（只会是 `success`，`PricingPaymentModals.vue:177`）。
4. **官网 `src/data/pricing.ts` 不存在**：`index.html:187` 注释引用了它，实际价格内联在 HTML 里。
5. **旧版 `components/modals/BillingModal.vue` 是重复实现**（下载按钮仍是「功能建设中」），虽然还挂在 `ModalManager.vue:204`，但已无入口。真正的下载路径是 B5。

---

## G. 自动化覆盖现状（决定哪些必须人工点）

**已有的 e2e（仅管理台）**
- `src/admin-console/tests/e2e/smoke.spec.ts` —— 只断言 dashboard 标题/卡片、用户表 ≥1 行、订单页「订单与支付」标题 + 表格可见 + 审计表导出；**完全不碰**退款/对账/异常到账/详情弹窗
- `src/admin-console/tests/e2e/settings.spec.ts` —— 只覆盖设置页两项

**桌面 / 移动 / 官网：零 e2e**（仓库内除管理台外没有 playwright 配置）

**单测/接口测试（能挡住逻辑回归，但挡不住"界面看不到"）**
- 管理台 vitest：`pages/ops/alipayStatus.test.ts`、`api/refundReviews.test.ts`、`api/orders.test.ts`（含异常到账可退判定）
- 桌面 vitest：`composables/__tests__/useSubscriptionAccess.test.ts`
- 服务端：`admin-payment-surfaces` / `admin/refundReviews` / `admin/orders` / `admin/overview` / `admin/ops` / `payment-*` / `refund-*` / `subscriptions` / `invoice-download` / `invoices-read`

**结论**：§A 的 7 项与 §B 的 6 项**必须人工过**；§C §D 可快速扫一遍。建议在补 e2e 之前，每次动支付面都照本表走一遍 A1→A6。
