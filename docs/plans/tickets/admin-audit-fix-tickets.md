# 工单：后台管理系统审计缺陷修复（2026-09-08 运行时审计落地）

- **缺陷来源**：[../../audit/admin-runtime-audit-2026-09-08.md](../../audit/admin-runtime-audit-2026-09-08.md)（A/B/C/D/E 五类，均经真实浏览器点击实测）
- **缺口分析**：[../../audit/admin-config-gap-2026-09-08.md](../../audit/admin-config-gap-2026-09-08.md)
- **状态标记**：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞
- **分工说明**：本文件只收「**已有功能但坏了 / 是假的 / 对不上**」的修复项；新增能力见 [admin-capability-gap-tickets.md](./admin-capability-gap-tickets.md)
- **指派建议**：AF-01～AF-04 可并行（互不冲突）；AF-10/11/12 同属 UserDrawer 建议同一人；AF-20/21 同属指标类建议同一人

---

## WP-0 P0 阻断项（优先做，收益最高）

### AF-01 系统参数 5 张卡保存链路失效 ⬜ P0
- **问题**：审计 B 类。系统设置页「AI 能力 / 安全与会话 / 邮件（SMTP）/ 日志 / 界面」5 张卡的输入框**恒为空**，改值后点「保存（记入审计）」恒提示「内容未变化，无需保存」，**零 PATCH 请求**。等价于这 10+ 个配置项只能改库。
- **证据**：
  - `src/admin-console/src/pages/settings/index.tsx:451` 限流卡用 `<Form form={rateLimitForm}>` 包裹 → 保存**正常**（实测 300→307 落库成功）
  - 同文件 `:536-578` `PARAM_GROUPS.map()` 只渲染 `{items.map(renderConfigItem)}`，**没有 `<Form form={configForm}>` 包裹** → `Form.Item` 脱离 FormContext
  - 控制台稳定报 `Warning: Can not find FormContext` / `useForm is not connected to any Form element`
  - DOM 实测：`#ai_max_tokens`、`#session_timeout_minutes`、`#log_level`、`#smtp_host` 等 value 全空；`#rate_limit_api_per_min` = `300`
- **改动**：在 `PARAM_GROUPS.map` 返回的 `<Card>` 内用 `<Form form={configForm} requiredMark={false} labelWrap>` 包裹 `{items.map(renderConfigItem)}`（与限流卡 :451 写法一致）
- **验收**：
  1. 进 `/settings`，5 张卡输入框均回填当前值（如 `ai_max_tokens=16384`、`session_timeout_minutes=30`）
  2. 改 `ai_max_tokens` → 保存 → `PATCH /api/admin/configs/ai_max_tokens` 200 → 刷新后仍为新值
  3. 改 SMTP 任一键 → 保存 → PATCH 200
  4. 控制台无 `FormContext` 警告
  5. 还原测试值

### AF-02 运维监控「请求数 / 错误数 / p95」恒显示不可用 ⬜ P0
- **问题**：审计 C2。三张卡永远显示「不可用」。
- **证据**：`src/server/src/routes/admin/ops.js:84-88` 动态 import `middleware/metrics.js` 取 `getMetricsSnapshot`，而 `src/server/src/middleware/metrics.js` 只导出 `metricsMiddleware / setWsConnections / getMetrics / getPrometheusMetrics`，**无 `getMetricsSnapshot`**（全仓无定义）；`metricsMiddleware` 已挂载（index.js:199）且数据在采，只是取不到
- **改动**（二选一，倾向方案 a）：
  - a. 在 `middleware/metrics.js` 新增 `export function getMetricsSnapshot()`，复用现有计数器返回 `{ requests, errors, p95Ms, windowStart }`；ops.js 仍需按 CO-03 用 METRICS_TOKEN 鉴权（metrics 端点本身已鉴权）
  - b. 移除这 3 张卡，避免"永远不可用"的假象
- **验收**：`GET /api/admin/ops/overview` 的 `metrics` 非 null；人为刷 20 次请求 + 触发 1 次 500 后，请求数/错误数与 `getMetrics()` 交叉一致
- **回归**：`node scripts/admin-full-audit/run-audit.mjs`（建议新增 `opsmetrics` 阶段断言，见 AN-23）

### AF-03 RB-06 收尾：7 处读端点未挂 requirePerm ⬜ P0
- **问题**：RB-06 工单标 ✅，但 2026-09-08 复核发现 7 个 GET 端点仍只靠顶层 `requireRole(50)`，自定义角色去掉 view 键后**直接调 API 仍能读全量数据**（前后端判权不一致）。
- **证据**（`src/server/src/routes/admin/`）：
  | 文件:行 | 端点 | 应挂权限 |
  |---|---|---|
  | `subscriptions.js:94` | `GET /` | `admin.subscriptions.view` |
  | `subscriptions.js:132` | `GET /stats` | `admin.subscriptions.view` |
  | `roles.js:133` | `GET /` | `admin.roles.view` |
  | `plans.js:132` | `GET /` | `admin.plans.view` |
  | `orders.js:186` | `GET /` | `admin.orders.view` |
  | `orders.js:219` | `GET /:orderNo` | `admin.orders.view` |
  | `announcements.js:184` | `GET /` | `admin.announce.view` |
  - 已正确的对照组：`users.js:316,349`、`devices.js:145,181`、`configs.js:238`、`audit.js:240`、`ops.js:126,217`
- **改动**：上表 7 处挂 `requirePerm(...)`（权限键已由迁移 049 建好）
- **验收**：空权限自定义角色调这 7 个端点 → 403；super_admin 与内置 admin 行为不变；`run-audit.mjs rb06` 阶段全绿（该阶段已存在，需确认覆盖这 7 个）

### AF-04 enable_signup 注册总开关服务端无守卫 ⬜ P0
- **问题**：CO-31 工单标 ✅，但服务端**零消费方**：后台把开关关掉，注册接口照常放行（虚假开关）。
- **证据**：全仓 `enable_signup` 仅出现于 `configs.js:188`（目录定义）、迁移 `051_signup_flag.sql`、`useFeatureFlags.ts:17`（类型）、`settings/index.tsx:86`（文案）、mock 与测试；**无任何 `isFlagEnabled('enable_signup')` / `requireFlag('enable_signup')` 调用点**（对照 `signup_waitlist` 有 5 处、`enable_2fa` 2 处）
- **改动**：注册链路挂 `requireFlag('enable_signup', '注册已由管理员关闭')`：
  - `src/server/src/routes/auth.js` 注册入口（`:353` waitlist 判断附近）
  - `src/server/src/routes/auth-verify.js:158,249`（验证码注册/登录新用户分支）
  - `src/server/src/routes/auth-password.js`（密码注册，若存在）
  - 语义对齐 051 注释：`enable_signup=false` → 注册 403；与 `signup_waitlist` 正交（关闭 > 审核 > 开放）
- **依赖**：无
- **验收**：关开关 → 三个注册入口均 403 且登录不受影响；开开关 → 恢复正常；`run-audit.mjs configs` 阶段补断言
- **注意**：`isFlagEnabled(key, fallback=true)` 缺键放行，与"默认开放"语义一致，无需改 fallback

---

## WP-A 占位假按钮处置（7 项，审计 A 类）

> 共同背景：这些按钮点击后只 `message.info('xxx将在后续版本提供')`，零请求、零审计。运营会误以为操作已生效。

### AF-10 用户抽屉「赠期 1 个月」接线 ⬜ P1
- **问题**：A3。后端 `POST /api/admin/subscriptions/:id/grant` 已实现且订阅页有真实入口，抽屉里却是假按钮（两个入口自相矛盾）
- **证据**：`src/admin-console/src/components/UserDrawer/index.tsx:151`
- **改动**：改为打开订阅页同款 `GrantSubscriptionModal`（`pages/subscriptions/GrantSubscriptionModal.tsx`），传 userId；成功后 invalidate `['users','subscriptions']`
- **验收**：抽屉点赠期 → 填月数+原因 → 提交 → `POST /subscriptions/:id/grant` 200 → 用户订阅到期日延长

### AF-11 用户抽屉「强制下线」接线 ⬜ P1
- **问题**：A4。后端 `POST /api/admin/users/:id/force-logout` 已实现（真实吊销 `user_sessions`），前端没接
- **证据**：`UserDrawer/index.tsx:152-158`
- **改动**：`api/users.ts` 增 `forceLogoutUser(id, reason?)`；按钮改为调用（建议复用 `ConfirmReasonModal`，原因写审计）
- **验收**：执行后该用户 `user_sessions` 失效、客户端需重新登录；审计日志记录该动作

### AF-12 用户抽屉「删除账户」接线 ⬜ P1
- **问题**：A5。后端 `DELETE /api/admin/users/:id`（软删 `is_active=false`）已实现且权限键 `admin.users.delete` 已校验，前端按钮 `disabled`
- **证据**：`UserDrawer/index.tsx:183-189`
- **改动**：接 `ConfirmReasonModal`（标题「删除账户」，danger）→ `DELETE /users/:id`；`hasPerm('admin.users.delete')` 守卫保留
- **验收**：删除后列表状态变「已删除/停用」，可再次启用；无权限角色按钮置灰并提示

### AF-13 「改套餐 / 调整套餐」处置 ⬜ P1 ⛔ 需产品决策
- **问题**：A1/A2。用户列表「改套餐」与抽屉「调整套餐」均为占位
- **证据**：`pages/users/index.tsx`（行操作改套餐）、`UserDrawer/index.tsx:150`
- **推荐方案（a，与 AN-01 联动）**：实现 `PATCH /api/admin/users/:id/plan`（直接改 `user_subscriptions.plan_id`，原因必填 + 审计），两处共用；依赖 AN-01 的套餐页存在（否则无套餐可选）
- **备选方案（b，低成本）**：两处按钮改为 `disabled + Tooltip「请在订阅管理页操作」`，并跳 `/subscriptions`
- **验收**（a）：改套餐后订单/订阅页口径一致，审计留痕

### AF-14 订单「导出」实现 ⬜ P1
- **问题**：A6。审计页已有成熟 CSV 导出（`pages/audit/auditCsv.ts`，实测导出 1217 条成功），订单页没有
- **证据**：`src/admin-console/src/pages/orders/index.tsx:255`
- **改动**：复用 `auditCsv.ts` 的下拉工具函数，导出当前筛选条件下的订单（订单号/用户/套餐/渠道/金额/退款/支付时间/状态），文件名 `orders-{YYYYMMDD}.csv`
- **验收**：导出文件列数与表头一致、条数与当前筛选 total 一致、中文不乱码（BOM）

### AF-15 订单「关闭」按钮处置 ⬜ P2 ⛔ 需产品决策
- **问题**：A7。待支付订单行有 `disabled` 的「关闭」按钮，title 写「自动关单将在后续版本提供」
- **证据**：`pages/orders/index.tsx:196-200`
- **方案 a**：实现「手动关单」`POST /api/admin/orders/:orderNo/close`（`admin.orders.manage`）—— 需新增权限键或复用 `admin.orders.refund` 之外的新键
- **方案 b（推荐）**：移除该按钮，改为后端定时任务自动关单（`expired_at` 过期 → `cancelled`），前端不做。若要保留 UI 提示，改 `Tag「待支付 · 超时自动关闭」`
- **验收**：（a）关单后订单转 cancelled 且不可退款；（b）按钮消失，超时订单自动 cancelled

---

## WP-B 指标与展示真实性（审计 C 类）

### AF-20 数据看板「待处理事项」恒空 ⬜ P1
- **问题**：C1。表格永远「暂无数据」，运营会误判"没有待办"
- **证据**：`src/server/src/routes/admin/overview.js:216` 硬编码 `pendingItems: []`（注释自述"后续迭代接入"）
- **改动**（最小可用）：聚合三类真实待办 —— ① `registration_status='pending'` 的待审核用户数；② `status='refunding'` 的退款处理中订单；③ 24h 内登录失败次数 ≥ 阈值的账号（或 `signup_waitlist` 待审）。返回 `{ id, type, title, target, occurredAt, actionLabel, actionTo }`，`actionTo` 指向对应页面
- **验收**：制造 1 条待审核用户 + 1 笔退款中订单 → 看板出现 2 条且点击能跳到对应页面；无待办时显式展示「暂无待办」而非空表

### AF-21 运维监控趋势图恒「等待下一次轮询采样…」 ⬜ P2
- **问题**：C3。`src/admin-console/src/pages/ops/index.tsx` 页内本地采样（MAX_SAMPLES=20 × 30s），无历史数据，首屏永远空
- **改动**：后端 `ops/overview` 增加 `series: [{ t, requests, errors }]`（近 20 个 30s 桶，来自 metrics 环形缓冲；缓冲不存在则先落一个内存 ring，重启丢失可接受并注明），前端改为消费后端序列
- **依赖**：AF-02（metrics 快照先能取到）
- **验收**：打开页面即有近 10 分钟曲线；重启后曲线从空开始且页面标注「自进程启动起」

### AF-22 公告「送达 / 已读 / 点击」口径修复 ⬜ P1
- **问题**：C4。`deliveredCount` 实为**受众人数**（不是触达数）；后台列表**不返回已读数**，前端 `item.readCount` 恒 undefined 显示 0
- **证据**：`src/server/src/routes/admin/announcements.js:130-133`（`deliveredCount = await countAudience(audience)`）；`:187` SELECT 列表只有 `delivered_count, click_count`，**无 read_count**；前端 `settings/index.tsx:523-527` 展示 `readCount`
- **改动**：
  1. `announcements.js` 列表 SQL 增加 `read_count`（来自 052 回执表 `admin_announcement_reads` 的 COUNT），映射 `readCount`
  2. 列名语义澄清：`delivered_count` 保留"受众数"，前端标签改为「受众 N」，与「已读 / 点击」并列展示（不要混称"送达"）
  3. 若 CO-35 的真实触达需要独立字段，新增 `reached_count`（WS/推送成功数），未做推送前**不要**显示"送达"
- **验收**：发公告 → 用户端读 1 次 → 后台「已读 1」；点击 → 「点击 1」；标签文案与实际语义一致

### AF-23 备份概览恒空 ⬜ P2
- **问题**：`GET /api/admin/ops/backups` 只扫 `backups/` 目录，无任何备份任务 → 卡片恒「暂无备份文件」
- **改动**（二选一）：a. 实现备份任务（pg_dump + 保留策略）+ 手动触发按钮；b. 该卡片仅在检测到备份文件时渲染，否则显示「未启用备份（当前无备份任务）」并隐藏空表
- **依赖**：AF-02 无依赖；若做 a 需运维确认备份落盘路径与容器内挂载
- **验收**：（a）手动触发一次 → 文件出现 + 列表显示大小/时间；（b）卡片不再显示空表

---

## WP-C 装饰控件 / 错误跳转 / 筛选缺陷（审计 D 类 + 其他）

### AF-30 Grafana 跳转指向后端 API 端口 ⬜ P1
- **问题**：D3。运维页「打开 Grafana 容器总览」`href=http://localhost:3001`，而 3001 是 ClipSync 后端 API，点开是 `{"status":"healthy"...}`
- **证据**：`src/admin-console/src/pages/ops/index.tsx:22`（`GRAFANA_URL = import.meta.env.VITE_GRAFANA_URL || 'http://localhost:3001'`）；`docker-compose.monitoring.yml` 中 Grafana 端口需核对
- **改动**：
  1. 后端 `configs.js` CONFIG_CATALOG 增 `grafana_url`（默认空）+ 管理台「运维」分组可配置
  2. `ops/overview` 返回 `grafanaUrl`；前端优先用后端下发值，空则按钮置灰并 Tooltip「未配置 Grafana 地址」
  3. 顺带核对 `docker-compose.monitoring.yml` Grafana 实际映射端口（3001 与 API 冲突需改映射，如 3004:3000）
- **验收**：配置真实 Grafana 地址后点击能打开 Grafana；未配置时按钮不可点

### AF-31 顶栏「搜索：用户 / 订单 / IP」是纯装饰 ⬜ P2 ⛔ 需产品决策
- **问题**：D1。`AdminLayout.tsx:92-95` 是一个 `<div>`，无 input、无事件
- **方案 a**：实现全局搜索（用户按手机号/昵称、订单按订单号、审计按 IP），下拉结果跳转
- **方案 b（推荐，本工单默认）**：直接移除该装饰块（比"看着像搜索但点了没反应"更诚实）
- **验收**：（b）顶栏不再出现搜索框；（a）输入手机号能定位到用户抽屉

### AF-32 顶栏通知铃铛点击无反应 ⬜ P2
- **问题**：D2。`AdminLayout.tsx:96-100` Badge 红点 + 按钮，点击零请求
- **改动**：接真实数据源 —— 待审核用户数 / 退款中订单数（复用 AF-20 的待办聚合），点击展开下拉列表并跳对应页；无数据时不显示红点
- **依赖**：AF-20
- **验收**：有待办时红点出现且下拉条目可点跳；无待办时无红点

### AF-33 审计日志「终端用户」筛选漏数据 ⬜ P2
- **问题**：`audit.js:146` 用 `r.role_key = 'user'` 过滤，而查询是 LEFT JOIN，`role_id IS NULL` 的终端用户查不到
- **改动**：条件改为 `(r.role_key = 'user' OR al.user_role_id IS NULL)`（按实际列名调整）
- **验收**：构造一条 `role_id` 为空用户的审计记录 → 「终端用户」筛选能查出

### AF-34 用户抽屉「查看审计日志」不带用户过滤 ⬜ P2
- **问题**：E4。`UserDrawer/index.tsx:190` 仅 `navigate('/audit')` 裸跳转，用户以为会看到"这个人的审计"
- **改动**：跳 `/audit?userId=<id>`；审计页参数解析已存在则复用，否则在 `useTableQuery` 中新增 `userId` 过滤（下拉/标签展示"仅看该用户"）
- **验收**：跳转后列表只含该用户相关日志，且可一键清除过滤

---

## WP-D 文案与实现对齐（审计 E 类）

### AF-40 退款：文案承诺与实现不符 ⬜ P1 ⛔ 需产品决策
- **问题**：E1。弹窗写「退款将通过原渠道退回，1–3 个工作日到账」，实际只 `UPDATE payment_orders` 改状态，**不调用任何支付网关**；财务对账会失真
- **证据**：`src/server/src/routes/admin/orders.js:290-297`；前端 `components/RefundModal/index.tsx:80`
- **方案 a（正解，工作量大）**：接支付渠道退款 API（微信/支付宝/Stripe），落退款流水表，异步回调更新状态
- **方案 b（本工单默认）**：先改文案与状态语义 —— 弹窗改「标记为已退款（线下完成转账后操作）」，状态改为 `refunded_manual` 或在 metadata 标 `refund_channel='manual'`，并在订单详情时间线注明"人工标记"
- **验收**：（b）文案不再承诺自动到账；财务导出能区分"人工标记"与"渠道退款"

### AF-41 远程下线：文案承诺与实现不符 ⬜ P2
- **问题**：E2。弹窗写「下线后该设备立即退出登录，剪贴板同步中断」，实际只改 `devices.is_online`，不吊销凭证、不断长连接
- **证据**：`src/server/src/routes/admin/devices.js:217-223`（含 TODO 注释）；前端 `pages/devices/index.tsx:231-236`
- **改动**：
  1. 后端：吊销该设备 `user_sessions` + 通过 WS 向该设备发 `force_logout`（若有通道）或加入短时黑名单
  2. 前端文案在未完成前改为「标记离线：该设备将在下次心跳时退出登录」
- **验收**：（最小版）下线后该设备 session 失效，需重新登录；文案与实际一致

### AF-42 menu_overrides 有写无读 ⬜ P2 ⛔ 需决策
- **问题**：E3。后台可改 `menu_overrides`，但客户端 `useMenuAccess.ts:82-90` 的 `setOverrides()` 预留未调用，无公开只读端点、无 WS 推送 → 典型"填了没反应"
- **方案 a**：补齐下发（`GET /api/app/menu-overrides` + WS 推送 + 客户端调用 `setOverrides()`）
- **方案 b（推荐）**：从管理台配置卡移除该键（功能立项再加回）
- **验收**：（a）后台改完客户端菜单即时变化；（b）管理台不再出现该配置项

### AF-43 admin.keys.view 承载端点（RB-02 落地）⬜ P2
- **问题**：C6。RB-02 工单已拍板"实现真实端点"，但 2026-09-08 复核**仍未实现**：全仓无 `requirePerm('admin.keys.view')`，也无 `/api/admin/devices/:id/keys`
- **改动**：新增 `GET /api/admin/devices/:id/keys`（`requirePerm('admin.keys.view')`，返回设备公钥指纹/创建时间等**脱敏摘要**，禁止返回私钥），管理台设备页「查看密钥摘要」入口
- **验收**：super_admin 可查看摘要；无该权限角色 403；响应体不含任何私钥/明文密钥
- **备选**：若产品确认不做，则从 `PERM_CATALOG`（roles.js:49）与权限树移除该键（需同步迁移删除）

---

## WP-X 收尾补漏（P2/P3，单条很小但都是"名不副实"）

### AF-50 设备在线状态：4 台设备长期全离线 ⬜ P1 ⚠️ 先排查再改
- **问题**：E5。审计实测 `devices` 4 台 `is_online` 全为 false；管理员看板「在线设备」恒 0，设备管理页的「远程下线」按钮也因此**永远不可见**（`devices/index.tsx:144` 仅 online 才渲染），等于该功能在数据层面不可达
- **现状**：`devices` 表有 `last_seen_at`、`idx_devices_online`（`is_online = true` 部分索引），服务端有心跳更新逻辑
- **改动（分两步，禁止未排查直接改）**：
  1. **排查**：确认桌面端/移动端是否上报心跳、WS 断连是否回写 `is_online=false`、有无定时扫描把超时设备置离线、dev 环境客户端是否根本没连 WS —— 输出根因结论到本工单备注
  2. **修复**：按根因实施（心跳缺失则补上报；无超时扫描则加定时任务，如 5 分钟无心跳置离线；阈值走配置键 `device_offline_timeout_minutes`，默认 5）
- **验收**：真机在线时管理台设备页与看板均显示「在线」且「远程下线」按钮出现；断网 5 分钟后自动转离线

### AF-51 session_timeout_minutes 无消费方 ⬜ P2 ⛔ 需决策
- **问题**：O8。管理台会话超时配置项存在但前端无 idle 登出逻辑
- **改动（a）**：管理台接入 —— `App.tsx` 加 idle 计时器（读 `session_timeout_minutes`），超时清 `authStore` 并跳 `/login`（临跳前提示）
- **改动（b）**：若无排期，按 AN-09 打「未接入」角标，并从"安全与会话"卡移除，避免误导
- **验收**：（a）设为 1 分钟后静置 → 自动登出；（b）UI 不再出现该键

### AF-52 log_level 修改后不热生效 ⬜ P2
- **问题**：O9。`utils/logger.js:214` 有 `setLogLevel()` 但从未被调用，管理台改 `log_level` 后仅落库不生效
- **改动**：`configs.js:266` PATCH 成功后，若 key 为 `log_level` 则调用 `logger.setLogLevel(value)`（并 invalidate 相关缓存）
- **验收**：改 `log_level=debug` → 不重启即出现 debug 日志；改回 `info` 后消失

### AF-53 权限键单一事实源 + 启动自检 ⬜ P2
- **问题**：代码维度 C2。权限键散落在各业务文件常量中，043/044/049/052/053 多批迁移分散新增，出现 `admin.keys.view` 这类"目录有、代码无校验、无端点"的死键（见 AF-43）
- **改动**：
  1. 以 `permissions` 表为唯一事实源，`PERM_CATALOG`（`roles.js:38-52`）仅作展示描述
  2. 启动时自检：目录中的键若全仓无 `requirePerm('<key>')` 调用点 → `logger.warn` 汇总（不阻断启动）
  3. 管理台角色页对无校验点的键显示「无承载端点」角标
- **验收**：人为插入一个死键 → 启动日志出现告警；角色页可见角标

### AF-54 MSW 模式可见化 ⬜ P3
- **问题**：代码维度 C5。仓库内 `mocks/data.ts`（42KB）+ `mocks/handlers.ts`（35KB）可让整个后台"看似完美工作"；`VITE_ENABLE_MSW=false` 才是真实后端，但页面无标识
- **改动**：`main.tsx` 启用 MSW 成功时在页面角标（顶栏 ENV 标签旁）显示醒目「MOCK 数据」红标
- **验收**：`VITE_ENABLE_MSW` 非 false 时角标出现；生产构建恒不出现

### AF-55 桌面端 PIN 明文存储 ⬜ P2
- **问题**：S5。`clipsync-privacy-pin` 以明文存 `localStorage`（`src/desktop/src/composables/usePrivacy.ts:4,40-47`）
- **改动**：改为存 PIN 的哈希（如 SHA-256 + 随机 salt，校验时比对），明文不落盘；PIN 强度策略纳入 AN-02 的客户端策略下发
- **验收**：本地存储中不再出现 PIN 明文；校验功能不变

---

## 验收总口径

1. 每工单完成后运行 `node scripts/admin-full-audit/run-audit.mjs all` 全绿（阶段：`auth|overview|users|devices|subs|orders|plans|audit|roles|configs|announce|rbac|rb06|ailevel|all`）
2. 涉及前端交互的工单（AF-01/10/11/12/14/22/30/34）必须**真实浏览器验证**：改 → 保存/提交 → 调接口复查 → 还原，禁止只看代码
3. 管理台契约改动同步 `src/admin-console/src/mocks/handlers.ts` + `mocks/data.ts` 并跑 `npm test`（admin-console 目录）
4. 涉及权限键/迁移的工单（AF-03/AF-43）迁移号递增（049 之后），与 `config-ops-tickets.md` 的迁移统一排号，避免冲突
5. ⛔ 标记项（AF-13/15/31/40/42）**先决策后动手**，未拍板不得自行选方案
