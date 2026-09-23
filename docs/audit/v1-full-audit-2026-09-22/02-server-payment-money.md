# 后端支付/订阅/退款 审计

- 审计日期：2026-09-22
- 范围：`src/server/src` 支付/订阅/退款/发票/套餐全链路（routes/payments.js、paymentWebhooks.js、subscriptions.js、invoices.js、admin/{orders,refundReviews,refundSettings,plans,subscriptions}.js、services/{refund,refundPolicy,refundRequest,proration,orderFulfillment,orderCloseSweep}.js、middleware/{idempotency,webhook-signature,planFeature,subscriptionCheck}.js、utils/alipay.js、db/migrations）+ 14 个支付相关测试文件
- 排除项依据：`docs/audit/external-dependency-audit-2026-09-09.md`、`docs/production-roadmap/external-dependencies.md`（微信商户号/Stripe 账号未办 = 外部依赖，不计问题；代码侧防护缺失才计）
- 纪律：只读审计，未运行任何测试/服务/真实支付

## 结论（≤3 句）

钱这一块的整体质量**显著高于项目其余部分**：验签强制 fail-closed（无跳过开关）、金额逐单比对、履约/退款全走 DB 行锁 + 状态机幂等、自助退款锚点防顺移已如实实现、退款渠道侧 out_request_no 幂等、测试大多真签真验真断言库状态。**可以带一个已知风险上 v1**：唯一的 S1 是「超时关单不调支付宝关单接口 + 无 timeout_express → 关单后仍可能被付款，钱收了权益不发且退款接口拒收 cancelled 单，只能去支付宝商家后台手工退」。除此之外无 S0；建议上线前补 S1 的关单闭环与金额异常告警，其余按 S2/S3 排期。

## 问题清单（按严重度从高到低）

### [S1-1] 超时关单不调用 alipay.trade.close，下单不传 timeout_express —— 「关单后到账」钱收了、权益不发、且系统内无路可退

- 证据：
  - `src/server/src/services/orderCloseSweep.js:25-33`：关单只改本地库，无任何渠道调用：
    ```js
    const { rows } = await pool.query(
      `UPDATE payment_orders
       SET status = 'cancelled', ...
       WHERE status = 'pending'
         AND created_at < NOW() - ($1 || ' hours')::interval
    ```
  - 全仓 grep `trade.close` / `tradeClose` → **0 命中**（支付宝关单接口从未实现）。
  - `src/server/src/utils/alipay.js:314-331` `buildPagePayUrl` 的 `biz_content` 只有 `out_trade_no/total_amount/subject/product_code/qr_pay_mode/qrcode_width`，**无 `timeout_express`** → 渠道侧交易可支付时长由支付宝默认值决定（可能远超本站 24h，矩阵 §1.2 也标注「未实测」）。
  - `src/server/src/services/orderFulfillment.js:118-126`：cancelled 单收到支付 → 拒绝履约：
    ```js
    if (order.status === 'cancelled' || order.status === 'failed') {
      ...
      return { ok: false, changed: false, reason: `order_${order.status}`, order };
    ```
  - `src/server/src/services/refund.js:145-150`：退款只接受 `status === 'paid'`，cancelled 单 → 400 `ORDER_NOT_REFUNDABLE`。
- 失败场景：用户建单后把收银台二维码/页面留着，第 25 小时才付款（或支付宝渠道侧关单时间晚于本站 24h 扫描）。本站订单已被 sweep 置 `cancelled`；支付宝 TRADE_SUCCESS 通知到达 → `markOrderPaid` 判 `order_cancelled` → webhook 回 `failure`，支付宝按 4m/10m/…/15h 重试 24h 后放弃。结果：**用户 99 元进了商户账户，订阅没开，订单是 cancelled，`/api/payments/refund`、`/api/admin/orders/:orderNo/refund`、退款审核全部拒收**——系统内没有任何一条路径能把这笔钱退出去，只能人工登支付宝商家后台退款 + 手工对账。轮询兜底也救不了：`payments.js:458` 只对 `status==='pending'` 的单外呼查单。
- 影响：钱 + 可用性。单量小则低频，但每一笔都是「收了钱不给货且系统无法自愈」的最恶性客诉形态；产品矩阵 E2/E7 自己也标了「缺陷（无自助恢复路径）」。
- 修法：三件套——① `buildPagePayUrl` 加 `timeout_express`（如 `15m`，与前端 95s 过期态和 24h 扫描对齐）；② sweep 关单前对支付宝单先 `trade.query`、确认未付再 `trade.close`、渠道关单成功才置 cancelled；③ 兜底：允许对「cancelled + 渠道已收款」的单走 `refundPaidOrder`（放宽状态闸或在管理台加「异常到账退款」入口），并把 `order_cancelled` 履约失败接入告警。

### [S2-1] 回调 app_id 校验是「条件执行」，且无 seller_id 校验——防线依赖环境变量恰好配对

- 证据：`src/server/src/routes/paymentWebhooks.js:60-64`：
  ```js
  const expectedAppId = process.env.ALIPAY_APP_ID || '';
  if (expectedAppId && appId && appId !== expectedAppId) {
    ...
    return res.status(401).send('failure');
  }
  ```
  `expectedAppId` 为空（env 漏配/改名）**或** 报文 `app_id` 为空时，比对整体静默跳过；全仓 grep `seller_id` → 0 命中（支付宝官方建议的 seller_id/收款方校验缺失）。
- 失败场景：攻击者自己是支付宝商户，用**自己的 app** 对 `out_trade_no=<他在 ClipSync 建的 99 元年费订单号>`、`total_amount=99.00`、`notify_url=ClipSync 回调` 发起一笔真实交易并付 99 元（钱在他自己商户账户内空转，成本≈0.6% 手续费 ≈0.59 元）。支付宝向 ClipSync 回调**合法签名**的通知（签名是他自己 app 的私钥体系签的、用ClipSync 配置的支付宝公钥能验过——支付宝平台公钥对所有商户通知是同一套验签体系，`app_id` 是唯一区分商户的字段）。若 `ALIPAY_APP_ID` 恰好未配置，app_id 闸跳过、验签通过、金额 99.00 与订单一致 → 0.59 元成本白得 99 元年费。当前生产下单侧必须配 `ALIPAY_APP_ID` 才能签名（`alipay.js:32,177-178`），所以**实际可利用前提是运维改环境时丢了该变量**——属于「fail-open 的条件防线」。
- 影响：钱/安全。低概率但一旦触发是可批量薅的资损口子，且日志不会报任何异常（一切校验都"通过"）。
- 修法：改成 fail-closed——`expectedAppId` 为空直接 503 拒收；`app_id` 缺失同样拒收；顺手加 `seller_id`（配置为商户 PID）比对。

### [S2-2] `refundPaidOrder` 无条件把 users 打回 free——「用户已有另一条生效订阅时被直退旧单」会丢新订阅权益

- 证据：`src/server/src/services/refund.js:307-313`：
  ```js
  // 退款即收回权益：users 上的冗余状态同步回 free（配额判定读这里）
  await client.query(
    `UPDATE users
        SET subscription_status = 'free', current_subscription_id = NULL
      WHERE id = $1`,
    [order.user_id]
  );
  ```
  对比：审核通过路径**知道这个问题**并兜了底——`services/refundRequest.js:419-424` 在 `refundPaidOrder` 之后补一次 `recomputeUserEntitlement`（注释原话：「refundPaidOrder 无条件把 users 写成 free；若用户在审核期间又买了新套餐…」）。但**管理台强退**（`routes/admin/orders.js:340-346` → refundPaidOrder，无 recompute）和 **/api/payments/refund 管理员分支**（`routes/payments.js:617-624`，同样无 recompute）没有这层兜底。
- 失败场景：用户对旧订单 A（订阅 S1，已 canceled 或仍在）有在途退款申请 → S1 被收回 → 用户随即全价买了新订阅 S2（active，付 9.9）→ 管理员从**订单页**直接强退 A（不走审核页）→ `refundPaidOrder` 把 `users.subscription_status` 写成 `free`、`current_subscription_id=NULL`。此后 `subscriptionCheck.js:64-67`、`planFeature.js:84-87` 都按 users 冗余列走 Free 分支 → **用户付了钱的 S2 权益凭空消失**，且没有任何任务会自愈（S2 行在 user_subscriptions 里仍是 active，但读侧全部先信 users 列）。
- 影响：数据/钱（付了费享受不到），触发需要「双订阅并存 + 直退路径」组合，概率低但发生后用户视角就是"付钱掉档"。
- 修法：`refundPaidOrder` 落库事务内直接调用 `recomputeUserEntitlement(client, order.user_id)` 替代无条件写 free（refundRequest.js:85 已有现成实现，一行替换即可统一三条路径）。

### [S2-3] 无渠道侧对账、无「钱与状态不一致」告警——出了 S1-1/D5 类事故只能靠客诉发现

- 证据：
  - 对账仅有两处**本地聚合**：`routes/admin/orders.js:412-424`（近 30 天 `payment_orders` GROUP BY 渠道）与 `routes/payments.js:804-888`（区间查询）。全仓无支付宝对账单下载（`alipay.data.dataservice.bill.downloadurl.query`）调用、无「渠道成功但本地 pending/cancelled」的扫描任务。
  - 资金异常全部只落 `logger.error`：`orderFulfillment.js:120`（关单后到账）、`orderFulfillment.js:135`（金额不符）、`refund.js:320`（`CRITICAL: refund succeeded at channel but local update failed`）。grep 全仓无 feishu/sentry/告警接线（`docs/audit/external-dependency-audit-2026-09-09.md` D2/D3 也证实告警/错误追踪未集成）；`routes/admin/overview.js:21` 自注「对账差异…后续迭代接入」。
- 失败场景：发生 S1-1（关单后到账）或 D5（金额不符拒履约）时，钱已进商户账户而订单永远不会变 paid；没有告警、没有对账差异清单，管理员只有等用户投诉「付了钱没会员」才知道，且要人肉翻日志定位 orderNo。E5（渠道退款成功但本地落库失败）同理——代码注释自己都写了「必须人工补账」，但没有任何机制把这条 CRITICAL 日志变成待办。
- 影响：钱（发现与追回延迟）、可运维性。v1 单量小可人肉，但这是「对账困难」定义下的标准 S2。
- 修法：最小性价比方案——每小时 sweep 顺带扫「status IN ('pending','cancelled') 且 created_at>48h」的支付宝单跑一次 `trade.query`，发现渠道已收款的写入管理台待办（overview.js 的 pendingItems 已有占位）+ 打一条可被告警系统抓取的固定标记日志；后续再接对账单文件。

### [S2-4] `POST /api/subscriptions/subscribe` 是绕过全部下单治理的第二通道（无 flag 闸、无档位判定、无折抵、可建 0 元单，且建出的单永远无法支付）

- 证据：`src/server/src/routes/subscriptions.js:145-268`：
  - 无 `isFlagEnabled('enable_subscription')` 检查（grep 该文件 0 命中；`payments.js:90` 的 create-order 有）；
  - 档位处理只有 `if (current.plan_id === planId) return 400`（:173-175），**降档无任何判定**、升级**无 proration 折抵**，按目标套餐全价建 pending 单（:188-202）；
  - 价格兜底 `plan.price_yearly || plan.price_monthly * 10`（:161），与 create-order 的「未配价 → 400 PLAN_PRICE_MISSING」口径相反，且允许 Free 套餐建 **0 元 pending 单**；
  - 该路由不返回收银台 URL、也从不向支付宝注册 `out_trade_no` → 这些单**永远付不掉**，24h 后全部进 sweep 变 cancelled（管理台待支付 Tab 被垃圾单刷屏，正是矩阵 A7/C3 的放大器）。
- 失败场景：① 管理员关闭 `enable_subscription`（如支付故障应急下线），curl `POST /api/subscriptions/subscribe` 照样建单——F2 治理的「收钱链路关门」被留了一个没关的侧门（虽然付不了钱，但订单表持续被污染、flag 语义被破坏）；② 老客户端若仍调用该端点做「升级」，用户看到 202「Order created, payment required」+ 一个无法支付的订单，升级全价无折抵，与 create-order 的 PD2 口径直接冲突（矩阵 B8 标「缺陷」至今未修）。
- 影响：数据（垃圾订单）、一致性（两套下单口径漂移）。无直接资损（单付不掉），定 S2。
- 修法：最低成本是把 `/subscribe` 改为 410/409 指向 `create-order`（前端已不调用它，矩阵 §1.3 也注明「与 create-order 已不一致」）；若要保留则补齐 flag 闸 + decidePlanChange + proration + 收银台 URL。

### [S3-1] `webhookIdempotencyMiddleware` 对支付宝回调是 no-op，且幂等存储本身 get-then-set 非原子

- 证据：`src/server/src/middleware/idempotency.js:227-245` 只拦截 `res.json`；而支付宝 handler 全部用 `res.send('success'/'failure')`（`paymentWebhooks.js:56,90,97`）→ 缓存永不写入、去重永不命中。存储侧 `loadProcessed` 命中检查与 `saveProcessed` 之间无锁，Redis 用的是 `setEx`（`utils/redis-client.js:195-199`）而非 `SET NX`，并发同 key 双写都会放行。
- 失败场景：无实际资损——真正的去重靠 `markOrderPaid` 的 `FOR UPDATE` + status 裁判（`orderFulfillment.js:93-115`），这层是对的且有测试。但中间件的存在让读代码的人误以为回调有一层独立幂等（矩阵 D4 已如实标注「实际不产生缓存」），属误导性死代码。
- 影响：代码异味/防御错觉。
- 修法：要么删掉支付宝路由上的该中间件（注释说明幂等由履约层负责），要么改成拦截 `res.send` + Redis `SET NX PX` 原子占位。

### [S3-2] 履约金额闸是「条件校验」：`expectedAmount` 缺失/空串即整体跳过

- 证据：`src/server/src/services/orderFulfillment.js:130-133`：
  ```js
  if (expectedAmount != null && expectedAmount !== '') {
    const channelAmt = Number(expectedAmount);
  ```
  Stripe 路径（`paymentWebhooks.js:131-135`）调用 `markOrderPaid` 时根本不传 `expectedAmount`（矩阵 D11 已标注「金额闸形同虚设」；Stripe 未接入，暂为死代码）。
- 失败场景：对支付宝不可利用——真实 TRADE_SUCCESS 通知必带 `total_amount` 且在签名内，删改即验签失败。风险在于未来接新渠道的人沿用「不传金额也能履约」的调用形状。
- 影响：防御完整性（fail-open 参数设计）。
- 修法：`markOrderPaid` 对 `channel==='alipay'` 强制要求 expectedAmount 非空，否则拒绝履约。

### [S3-3] `GET /api/invoices/:id` 引用 `sp.price`——011a 重建过的库没有这一列（迁移顺序 010→011a 造成的环境相关 schema 漂移）

- 证据：`src/server/src/routes/invoices.js:328` `sp.price AS plan_price`；`db/migrations/010_subscription_plan_columns.sql:9` 加过 `price` 列，但 `011a_fix_subscription_schema.sql:40-54` 对旧 INTEGER 表环境**整表重建**且新表定义无 `price`（011a 排在 010 之后执行）。全新库（004 已是 UUID 版）010 生效、011a no-op → 列存在。
- 失败场景：在经历过 011a 重建的环境（011a 头注释自证「当前环境」执行过重建）调 `GET /api/invoices/:id` → PG 42703 → 500「Failed to get invoice detail」。测试库有该列，`invoices-read.test.js:139` 全绿，把漂移完全遮住。
- 影响：可用性（单端点、单环境相关）。列表/下载不受影响（不引用该列）。
- 修法：改读 `sp.price_monthly`，或补一条迁移 `ADD COLUMN IF NOT EXISTS price`。

### [S3-4] 管理员两套口径并存 + 自申请自批无职责分离

- 证据：`routes/payments.js:575-583` 用 `users.is_admin` 布尔列判管理员（可**不经审核**直退任何人的任何已付单，含自己的）；管理台走 RBAC `requirePerm('admin.orders.refund')`（`admin/orders.js:296`、`refundReviews.js:57`）。`approveRefundRequest`（`refundRequest.js:355-462`）不校验 `actorUserId !== rr.user_id`——同一管理员可以自己提交退款申请再自己批准。
- 失败场景：持有 `admin.orders.refund` 权限的账号被盗 → 攻击者可对任意订单走「申请+自批」或直接从订单页强退，资金全额原路退回给订单属主（不能退给自己除非自己就是属主），审计有留痕但无第二人复核。个体户单人运营下这是接受度问题而非漏洞。
- 影响：安全（内部权限），审计链完整（payment_refund + admin.orders.refund + refund_approve 三套 action 都落 audit_logs 带 ip/ua）。
- 修法：v1 可接受；将来加「approve 时 actor==requester 则 403」一行闸 + 收敛 is_admin/RBAC 双口径（矩阵 A2 遗留）。

### [S3-5] 试用/到期权益判定三处口径不一致（trial 用户配额、expired 状态翻转、cancel_at_period_end 无人消费）

- 证据：
  - `utils/planLimits.js:120-121` JOIN 条件 `us.status = 'active'` → **trial 订阅不算数**，试用用户上传配额按 Free（20MB/3 文件），而 `subscriptionCheck.js:71-99` 与 `/subscriptions/current` 给 trial 用户展示并放行套餐级 features/maxDevices——同一个试用用户两套权益；
  - 无任何后台任务把过期订阅翻成 `expired` / 消费 `cancel_at_period_end`（grep 仅 `migrate.js` 命中 'expired'；`subscriptions.js:389-391` cancel 只写标记）——全靠读侧 `current_period_end` 懒判定 + `subscriptionCheck.js:84-89` 懒降级，能用但 `user_subscriptions.status` 长期失真（active 但已过期），管理台统计跟着失真；
  - `admin/subscriptions.js:137` stats 数 `status = 'trialing'`，而库里存的是 `'trial'`（`subscriptions.js:331`）→ trialing 恒 0。
- 影响：数据一致性/展示，非资损。
- 修法：加一个订阅到期 sweep（expired 翻转 + cancel_at_period_end 消费），planLimits 的 JOIN 放宽到 `status IN ('active','trial')`，stats 改 'trial'。

### [S3-6] 其他轻微项（合并列出）

- **履约发票挂错订阅 id**：`orderFulfillment.js:274-286` INSERT invoices 用的是加锁时读到的 `order.subscription_id`（新订阅单此刻为 null），新订阅 id 只回填到了 payment_orders（:249-253），发票行 subscription_id 恒 null，靠 `invoices.js:102` 的 `COALESCE(i.subscription_id, po.subscription_id)` 兜住——能用但绕。
- **退款不红冲发票**：订单 refunded 后 `invoices.status` 仍 'issued'（refund.js 全程不碰 invoices），仅 PDF 渲染时按订单状态标「已退款」（invoice-download.test.js:283）。矩阵 E12「未实现」，v1 收据形态可接受。
- **create-order 无幂等/复用**：重复点击堆多张 pending 单（`payments.js:292` 每次新 orderNo），`expired_at` 列存在但从不写（004:98）；放大 S1-1 的暴露面。
- **`/subscribe` 年付兜底 `price_monthly * 10`**（subscriptions.js:161）凭空造价，与 create-order 的 400 口径冲突（已并入 S2-4）。
- **文档漂移**：`docs/production-roadmap/phases-10-payments.md`（「Mock已实现」「需支付宝商户号」）与 `external-dependencies.md`（「支付宝 🚫 阻塞」）均落后于「支付宝真实渠道已接通并生产实测过退款」的现状；`user_subscriptions.auto_renew DEFAULT true`（004:54）与 PD1「无自动续费」矛盾（矩阵 A5）。
- **`subscriptionCheck`/`planFeature` 在 `NODE_ENV==='test'` 整体跳过**（subscriptionCheck.js:11-13、planFeature.js:116-118）——三套 compose 文件均显式设置 NODE_ENV（dev=development/prod=production），无生产触发路径，仅提示别把 test 值带上线。

## 重点攻击面逐条查证结果（无问题项）

| 攻击面 | 结论 | 关键锚点 |
|---|---|---|
| 验签强制性 | **通过**。公钥未配置 → 503 拒收；验签失败 → 401 'failure'；无任何 debug/test 跳过分支；验签实现（ASCII 升序、剔空值、排 sign+sign_type、裸 base64 补 PEM）与官方口径一致且被真 crypto 测试钉死 | paymentWebhooks.js:44-57、utils/alipay.js:115-170、tests/alipay.test.js:134-201 |
| 网关响应验签 | **通过**。trade.query/refund 响应强制截原文验签，缺 sign/截不到/验不过一律抛错，绝不降级信任；口径经 2026-09-19 生产实测钉死并有防回退测试 | alipay.js:279-287、tests/alipay.test.js:287-293 |
| 金额比对 | **通过**（支付宝两路径都传 expectedAmount；容差 0.005 元覆盖浮点噪声；不符 → ROLLBACK + failure + error 日志）。「1 分钱买年费」需先伪造签名，不可行 | orderFulfillment.js:130-143、paymentWebhooks.js:74-76、payments.js:466-468 |
| trade_status 状态机 | **通过**。只认 TRADE_SUCCESS/TRADE_FINISHED；其余状态记日志回 success；本地状态机 pending→paid 单向、paid/refunded 终态、cancelled/failed 拒收 | paymentWebhooks.js:69-94、orderFulfillment.js:22,111-126 |
| 通知重放幂等 | **通过**。同一 trade_no 重放 N 次：`FOR UPDATE` 行锁串行化 + status 裁判 → 第 2..N 次 already_paid，只发一次权益（有测试：升级单双到不插第二条 active）。middleware 层幂等是 no-op 但不影响正确性（S3-1） | orderFulfillment.js:93-115、tests/subscription-upgrade.test.js:405-444 |
| 回调 vs 轮询并发双发货 | **通过**。两条路径共用 markOrderPaid 同一把行锁 | payments.js:458-475、orderFulfillment.js:84 |
| 退款超额/多次退 | **通过**。一期只全额退（金额=订单 amount，不可能>已付）；管理台显式 amount 必须等于全额否则 400 PARTIAL_REFUND_NOT_SUPPORTED；渠道侧 out_request_no=订单号天然幂等；本地 status 闸 + 行锁复核双保险；并发双退测试通过 | refund.js:140-150,168,192-196,263-280、admin/orders.js:317-336、tests/refund-service.test.js:407 |
| 退款失败回滚 | **通过**。渠道失败/未确认 → 本地一字不动 + 502 + failure 审计；渠道成功但本地落库失败 → CRITICAL 日志 + 500 带 out_request_no（重放同请求号渠道幂等，可自愈重试）——但无告警（S2-3） | refund.js:197-239,316-339 |
| 审核通过执行幂等 | **通过**。CAS `pending→processing` 认领，重复批 409；渠道失败退回 pending 可重试；订单已在别处退过 → 收敛为 approved 不重复打款 | refundRequest.js:359-408、tests/refund-request.test.js:371 |
| 自助退款锚定当前生效订阅、防顺移 | **通过，与 memory 中设计意图一致**。锚点 SQL 钉死 `us.status='active' AND us.current_period_end > NOW()` JOIN `po.status='paid'`；申请即收回权益 → 订阅 canceled → 锚点消失 → 历史单永不顺移；列表与强制点同源同一个 `evaluateSelfRefund`；paid_at 缺失按超窗 fail-closed；有回归测试（4 单全拒） | refundPolicy.js:181-200,216-231、tests/refund-policy.test.js、tests/payment-refund.test.js:503-513 |
| proration 公式与边界 | **通过**。残值=min(实付, 实付×剩余/周期) 线性折算 → **100% 折残值，符合既定要求**；四舍五入到分（toPrecision(12) 消浮点噪声）；剩余 0 天→残值 0 全额；周期数据非法→残值 0（宁可多收不少收）；残值≥新价 → 兜底 0.01 元绝不出 0/负数单；同一天升级按剩余时间比例正常折；降级/退订不产生负数应付（降档直接 409 不建单） | proration.js:89-125、tests/proration.test.js（42 断言含全部边界） |
| 金额单位与精度 | **通过**。DB 全 `DECIMAL(10,2)`/`NUMERIC(12,2)`；JS 侧 Number + roundToCent 归一；渠道侧字符串 toFixed(2)；`parseFloat` 只出现在响应展示层，不参与算钱；币种硬编码 CNY（单渠道可接受，subscription_plans 无 currency 列） | 004:18-19,89,113-114、074:49、proration.js:25-29、alipay.js:317,388 |
| IDOR | **通过**。订单状态轮询/退款候选/我的申请/发票列表/详情/下载全部带 user_id 条件；非属主非管理员退款返回与「不存在」完全同壳的 404（防探测有测试）；发票下载 UUID 校验 + 越户 404 不泄露存在性 | payments.js:443,672、invoices.js:175,333、tests/payment-refund.test.js:204-216 |
| 用户自改档位 | **通过**。档位只能经支付履约或管理台 grant（RBAC + 审计 + 高危限流）变更；mock 渠道生产 403 | payments.js:116-119、admin/subscriptions.js:174+ |
| 门禁判定依据 | **通过**。planFeature/subscriptionCheck 均**查库**（users 冗余列 + user_subscriptions.current_period_end），不信 token 声明——token 里根本没有档位字段；开关关闭全员按 Free | planFeature.js:57-107、subscriptionCheck.js:18-21 |
| 免费额度绕过 | **部分**。试用终身一次（含 canceled/expired 记录都算）防了同账号循环；但换新手机号重注册即可再领 7 天试用（无设备指纹/风控），且短信验证码当前是固定码（外部依赖 A4，排除项）。设备数限制在 POST /api/devices 有真实 count 校验 | subscriptions.js:314-323、subscriptionCheck.js:155-192 |
| plans 改动对已购用户 | 管理台改 `features`/限额**即时影响**已购用户（读侧实时 JOIN subscription_plans），改价只影响新单；有逐字段审计。属设计选择（无价格快照/权益快照机制），涨价降配无保护——v1 单人运营可接受 | admin/plans.js:155-229 |

## 支付场景矩阵覆盖度核对（对照 docs/product/payment-scenario-matrix.md，2026-09-19 快照）

矩阵中 11 项「缺陷」的现状复核（本次审计以当前代码为准）：

| 矩阵项 | 矩阵状态 | 当前代码状态 | 锚点 |
|---|---|---|---|
| A1 管理台假退款 | 缺陷(P0) | **已修复**：管理台退款走真实 `refundPaidOrder`，部分金额显式 400，有真库端到端测试 | admin/orders.js:296-395、tests/refund-service.test.js:433-575 |
| A2 双管理员口径 | 缺陷 | **未修**（is_admin vs RBAC 并存）→ 本报告 S3-4 | payments.js:575、adminAuth.js:93 |
| A3/B8 /subscribe 无档位拦截 | 缺陷 | **未修** → 本报告 S2-4 | subscriptions.js:169-224 |
| A4 未知渠道算成微信 | 缺陷 | **已修复**：ELSE 'unknown'，单独成行 | admin/orders.js:45-52,443-452 |
| A5 auto_renew 默认 true | 缺陷 | **未修**（文案/数据误导，无资金影响）→ S3-6 | 004:54 |
| A7 pending 单无限张 | 缺陷 | **未修** → S3-6 | payments.js:292 |
| A11 审计筛选 LIKE 漂移 | 缺陷 | **已修复**且有回归测试（6 类 action 全命中） | tests/admin-payment-surfaces.test.js:282-357 |
| A12 赠期 planId 必 400 | 缺陷 | **已修复**（套餐名/UUID 双分流）+ 测试 | admin/subscriptions.js:206-217、admin-payment-surfaces.test.js:168-264 |
| E2 关单后到账 | 缺陷 | **未修** → 本报告 S1-1 | orderCloseSweep.js、orderFulfillment.js:118 |
| E7 cancelled 单退款死锁 | 缺陷 | **未修** → 并入 S1-1 | refund.js:145 |
| E9/E12 发票红冲 | 未实现 | **未实现**（PDF 标「已退款」为唯一体现）→ S3-6 | refund.js 全文不碰 invoices |
| F2 flag 关不死收钱 | 缺陷 | **create-order/refund/refundable-orders/refund-request 已修复**（四处 isFlagEnabled + 测试）；**/subscribe 仍是漏网**（S2-4） | payments.js:90,592,666,750、tests/subscription-flag-gate.test.js |
| G2/G3/G4 发票接口 500/501 | 缺陷 | **已修复**（真实列映射 + PDF 下载实现 + 越权测试）；G3 遗留 sp.price 漂移 → S3-3 | invoices.js、tests/invoices-read.test.js、invoice-download.test.js |
| D1-D10 回调/验签/金额/并发 | 多为已实现未验证 | 代码全部在位（本次逐行核对通过）；D11 Stripe 金额闸缺失（未接渠道，死代码）→ S3-2 | 见上表 |
| PD2 升级=100% 折残值、只升不降 | 要求 | **已实现**：线性全额折抵 + 0.01 兜底 + 同档/降档 409 | proration.js、payments.js:243-269 |
| PD4 两段式退款 + 锚点防顺移 | 要求 | **已实现且有回归测试**（含防顺移 4 单全拒用例） | refundRequest.js、refundPolicy.js、tests/refund-request.test.js:259 |

矩阵之后新增能力（矩阵未覆盖）：退款时限/审核工作日后台可配（refundSettings.js，边界 1-365/1-30 + 写侧清缓存 + 审计）、退款审核高危限流（admin/index.js:62-64）、grant 套餐名兼容。

## 测试有效性评估

**真实有效的测试（断言到金额/状态迁移/渠道调用次数，非 200 即过）：**
- `tests/alipay.test.js`（471 行）：**真 crypto**——测试内生成 RSA 密钥对，真签真验；篡改金额/订单号/公钥不符/响应截段口径全部断言 false；退款 fund_status C/D、幂等重放 fund_change='N'、伪造响应验签都有独立用例。没有把验签 mock 掉。
- `tests/payment-refund.test.js`（527 行）：断言渠道 fetch 调用次数（`expect(fn).not.toHaveBeenCalled()` 反复出现）、DB 终态（refunded/canceled/free/审计行）、biz_content 报文逐字段（out_request_no=订单号）、防探测同壳 404、列表与强制点同源。质量高。
- `tests/refund-service.test.js`（93 断言）：并发双退行锁、渠道失败本地不动、管理台部分退款 400、无权限 403 且零渠道调用。
- `tests/refund-request.test.js`（76 断言）：申请零渠道调用、重复审核 409、渠道失败退回 pending、驳回还原权益、审核期另购不还原（防双 active）。
- `tests/proration.test.js`、`tests/subscription-upgrade.test.js`、`tests/refund-policy.test.js`、`tests/subscription-flag-gate.test.js`、`tests/invoice-download.test.js`、`tests/invoices-read.test.js`、`tests/admin-payment-surfaces.test.js`：均断言具体金额/周期/状态/权限，窗口边界精确到 1ms。

**假/弱测试：**
- `tests/webhook.test.js`：**同义反复**——全部用例只断言「导出的是个 function」，对验签逻辑零覆盖（幸好 alipay.test.js 补上了真验证）。
- `tests/subscriptions.test.js`：只断言 200 + `toHaveProperty`；唯一实质用例被 `it.skip`；else 分支 `expect(true).toBe(true)`。
- `tests/subscription-api.test.js`：schema 存在性检查，非行为测试。

**未覆盖的真实风险场景（按重要性）：**
1. **合法签名的支付宝通知端到端履约**：没有任何测试用测试私钥签一条 notify、POST `/api/webhooks/alipay`、断言返回纯文本 `success` + 订单 paid + 订阅开通（webhook 测试只测了拒绝分支和可达性）。验签→app_id→金额闸→履约的**正向串联**无自动化保护。
2. **金额闸拒绝分支（D5）**：`expectedAmount` 不符 → amount_mismatch → 订单仍 pending，无用例（所有 markOrderPaid 测试都传匹配金额或不传）。
3. **app_id 不符拒绝（D7）**：无用例。
4. **orderCloseSweep**：整个服务零测试（含 E2 竞态、24h 边界、审计写入）。
5. **轮询兜底路径（D2）**：`GET /order/:orderNo/status` 触发 queryTrade→履约的分支无测试。
6. **/subscribe、/start-trial**：无行为测试（B8 缺陷因此长期存活）。
7. **回调与轮询真并发**（Promise.all 双发 markOrderPaid）：只有顺序双到用例，行锁的并发正确性靠实现审读背书。
8. **TRADE_FINISHED 状态、非成功状态通知**：无用例。

## 设计层面的观察

1. **「顺序即安全」的退款编排是教科书级的**：渠道打款在事务外（不跨网络持行锁）→ 成功后行锁复核落库 → 失败留 CRITICAL 日志 + out_request_no 供人工补账；幂等键固定在渠道侧。文件头注释把「为什么」写全了，可维护性远超仓库其他部分。
2. **两段式退款 + 权益前置收回 + 锚点防顺移**闭环完整：申请（不动钱、收权益、快照）→ 批（CAS 认领、真打款、recompute）→ 驳（按快照还原、防双 active）。「审核期用掉的天数不退」是明示的产品取舍。
3. **升级退款的产品空洞**：升级单被退时只退差价，被取消的旧订阅残值既不恢复也不补偿（旧订阅在升级履约时已 canceled，退款不回头）。用户视角：Pro 剩半月升 Enterprise 付 10 元，次日后悔退款 → 拿回 10 元但 Pro 残余半月也没了。建议至少在退款确认文案里写明。
4. **users 冗余订阅列是第二真相源**：三处写入（履约、退款、recompute）+ 一处懒降级（subscriptionCheck），refundPaidOrder 的无条件写 free 已经咬人一次（S2-2）。长期看应收敛为单一 `recomputeUserEntitlement` 出口。
5. **状态懒过期策略**（无 expiry sweep，读侧按 current_period_end 判）省了一个任务但让 `user_subscriptions.status` 和管理台统计失真；订单侧反而有 sweep——两侧策略不对称。
6. 金额全链路「DB DECIMAL + JS Number + roundToCent + 渠道字符串 toFixed(2)」在当前量级（≤999999.99）是安全的；容差 0.005 的浮点比较对两位小数金额无误判空间。若未来上多币种/分单位再重构。

## 建议补充的功能（按性价比排序）

1. **下单带 `timeout_express`（如 15m）+ sweep 关单前 trade.query/trade.close**（半天工作量，根除 S1-1 的存量来源）。
2. **金额异常/关单后到账/退款落库失败的告警接线**（固定标记日志 + 管理台待办，overview.js 已有 pendingItems 占位；飞书 webhook 属外部依赖，先用待办兜住）。
3. **cancelled/pending 老单的渠道侧扫描对账任务**（每小时对 >24h 未终态的支付宝单跑 trade.query，发现「渠道已收款」进待办——同时是 S1-1 的自愈网和 S2-3 的最小对账）。
4. **`/subscribe` 收敛或删除**（一小时，消掉 S2-4 和矩阵 B8 老缺陷）。
5. **webhook 正向端到端测试**（测试私钥签 notify → 断言 'success' + 落库；顺带补金额闸/app_id 闸拒绝分支——这是全链路唯一没有自动化保护的关口）。
6. **refundPaidOrder 改用 recomputeUserEntitlement**（一行替换，修 S2-2 并统一三条退款路径）。
7. **管理台「异常到账处置」入口**（对 cancelled+渠道已收款的单允许发起渠道退款，把 S1-1 的人工路径从支付宝后台搬回系统内，留审计）。
8. 订阅到期 sweep + trial 配额口径统一 + stats 'trialing' 修正（S3-5 一揽子）。
