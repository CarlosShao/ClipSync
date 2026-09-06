# ClipSync 后台管理系统 v1 任务工单（Admin Console · B 方案落地）

> **依据**：`design/01-后台管理系统方案.md` + `design/03-后台开发工程方案.md`（已获用户批准，2026-09-05）
> **视觉基线**：`design/mockups/admin-v2-light.html`（Daylight 亮色 · Ant Design 5）
> **分支**：`feature/admin-console`（worktree：`.worktrees/zcode-feature-admin-console`）
> **并发纪律**：最多 2 个 subagent 并行；同波工单文件所有权互斥；**子代理禁止一切 git 操作**（commit/push 由编排者统一处理）

---

## 一、全局约束（对所有执行子代理）

1. **文件所有权**：只允许修改/创建本工单「独占文件」清单内的文件；确需越界（如挂载路由到 `src/server/src/index.js`）在交付报告中明确列出改动行，由编排者复核。
2. **禁止 git 操作**：不执行任何 git add/commit/push/checkout；只改代码、跑验证、输出交付报告。
3. **验证门禁**（每张工单自查，波次结束编排者复验）：
   - 前端：`cd src/admin-console && npm run lint && npm run typecheck && npm run build` 全绿
   - 后端：`cd src/server && node --check <改动文件>`；`npm test` 运行并报告结果（若 DB 依赖测试因环境失败，需列出失败用例与原因，不得隐瞒）
4. **行为红线**：不修改现有用户端 API 行为；不动 `src/mobile`、`src/desktop`；后端新路由全部挂 `/api/admin/*` 并强制鉴权；写操作必须落审计（复用 `logAuditEvent`）。
5. **视觉对照**：前端每个页面完成后与 `design/mockups/admin-v2-light.html` 并排目检，布局/文案/状态色一致；草图数据可直接复用为 MSW mock 数据。
6. **文案语言**：界面中文；代码标识符英文。

## 二、契约基线（前后端共同遵守）

- 响应壳：`{ code: 0, data: T, message?: string }`；错误壳 `{ code: number, message: string }`（HTTP 状态码照常 4xx/5xx）
- 分页壳：`data = { list: T[], total: number, page: number, pageSize: number }`；查询参数 `?page=&pageSize=&q=&sort=`
- 类型单一来源：`src/admin-console/src/api/types.ts`（前端建），后端响应字段必须与之逐字段一致
- 关键数据字段（取自真实迁移，不得杜撰）：
  - `users`: id/phone(打码)/nickname/subscription_status/is_active/role_id/created_at
  - `payment_orders`: order_no/amount/currency/payment_channel/status(pending|paid|failed|cancelled|refunded)/transaction_id/created_at
  - `user_subscriptions`: status(active|canceled|past_due|expired)/billing_cycle(monthly|yearly)/current_period_end/auto_renew
  - `audit_logs`: user_id/action/resource_type/resource_id/details/ip_address/user_agent/status/created_at
  - `roles/permissions`: role_key/name/level/perm_key/category
- 品牌色 `#5a4bd1`；语义色 成功 #16a34a / 警告 #d97706 / 危险 #dc2626 / 信息 #2563eb

---

## 三、Wave 1 — 双线地基（2 并发）

### T-A0 [P0][前端] admin-console 脚手架 + MSW 全量 mock
- **独占文件**：`src/admin-console/**`（整个目录新建）、`.github/workflows/admin-console.yml`
- **要求**：
  1. Vite 6 + React 18 + TypeScript 5(strict) 脚手架，包名 `clipsync-admin-console`；依赖：antd@^5.2x、@ant-design/icons、@tanstack/react-query@^5、zustand@^5、axios@^1、react-router@^7（library 模式，从 `react-router` 导入 BrowserRouter/Routes/Route）、dayjs、echarts@^5.5 + echarts-for-react@^3、msw@^2（dev）；devDeps 含 typescript-eslint、eslint-plugin-react-hooks、eslint-plugin-react-refresh、prettier、husky、lint-staged、@commitlint/cli、@playwright/test@^1.61
  2. 目录结构按 `design/03-后台开发工程方案.md` §2 逐目录建齐（api/queryKeys/stores/layouts/components/pages/router/theme/styles/utils/hooks）
  3. `theme/antd.ts`：colorPrimary #5a4bd1、colorBgLayout #f4f5fa、borderRadius 8、Table.headerBg #f7f8fc；zhCN locale
  4. `AdminLayout`：顶部主导航（数据看板/用户管理/订单与支付/审计日志/角色权限/系统设置）+ DEV 环境标 + 搜索框占位 + 通知铃铛 + 用户头像 + 退出；样式用 CSS Modules 还原草图 B 顶栏
  5. 路由：`/login` + 布局内子路由 `/dashboard /users /orders /audit /roles /settings`（全部 lazy）+ `RequireRole` 守卫 + 403 页
  6. 登录页：按草图 B 双栏（左品牌区含安全文案，右表单：账号/密码/TOTP），提交走 `api/auth.ts`（MSW 模拟），成功写入 authStore 并跳 /dashboard
  7. `api/client.ts`：axios 实例（Bearer 注入、401 单次刷新、错误壳展开 message.error、请求头带 X-CSRF-Token 占位）；`api/types.ts` 按 §二 契约定义全部领域类型；`queryKeys.ts` 工厂
  8. **MSW 全量 handlers**（`src/mocks/`）：覆盖 §二 全部资源 + dashboard overview 聚合；mock 数据复用草图数据（12,847 用户、订单 CS20260905xxxx、Yuki/Leo/Mia 角色等）；`VITE_ENABLE_MSW` 开关控制启用
  9. 工程化：`eslint.config.js`（flat config，按 03 §3.2）、`.prettierrc.json`（继承根：semi/singleQuote/printWidth 100/lf）、husky+lint-staged+commitlint（scope: admin）、`npm scripts`: dev/build/lint/typecheck/test/format；`.github/workflows/admin-console.yml`（npm ci → lint → typecheck → build）
  10. E2E 冒烟骨架：`tests/e2e/smoke.spec.ts`（登录→看板→用户列表→开抽屉→退款弹窗 5 步，可先以 MSW 模式跑通）
- **验收**：`npm run lint && npm run typecheck && npm run build` 全绿；`npm run dev` 后登录→看板空壳可走通；MSW 拦截网络面板可见；交付报告含目录树与启动说明

### T-W0 [P0][官网] website 脚手架 + 全量页面工程化还原
- **独占文件**：`src/website/**`、`.github/workflows/website.yml`
- **要求**：
  1. Vite 6 多页模式脚手架（`rollupOptions.input` 留 index 单页），包名 `clipsync-website`，原生 TS 无框架
  2. 以 `design/mockups/website-v2-minimal.html` 为像素基线拆分工程化：`styles/tokens.css`（--ink/--accent #5a4bd1/--line 等与草图一致）、`base.css`、`sections/` 按 hero/sync/encrypt/ai/pricing/download/faq/footer 分文件，**类名与草图保持一致**
  3. `data/pricing.ts` 定价常量（Free ¥0 / Pro ¥9.9·¥99 年 / Enterprise ¥19.9·¥199 年，功能矩阵与草图一致）；`data/download-links.ts` 占位链接常量
  4. `main.ts`：IntersectionObserver 入场动画、FAQ 原生 details、导航滚动状态、锚点平滑滚动（草图脚本迁移）
  5. SEO：title/description/OG/Twitter 卡、`lang="zh-CN"`、语义化标签、价格区 JSON-LD（Product+Offer）；`public/og-cover.png` 占位
  6. 响应式：≥1440 / 960–1440 / <960 三档，与草图 media query 一致
  7. `npm scripts`: dev/build/preview + `check`（node 脚本校验 dist 产物存在与 index.html 引用完整）；`.github/workflows/website.yml`（npm ci → build → lighthouse ci 可选注释态）
- **验收**：`npm run build` 全绿；`npm run preview` 渲染与草图肉眼一致（编排者将浏览器目检）；无三方运行时 JS 依赖

---

## 四、Wave 2 — 后端地基 + 前端首批页面（2 并发）

### T-A1 [P0][后端] admin 鉴权中间件 + 权限目录迁移 + 路由骨架
- **独占文件**：`src/server/src/db/migrations/043_admin_permission_catalog.sql`（新建）、`src/server/src/middleware/adminAuth.js`（新建）、`src/server/src/routes/admin/index.js`（新建）、`src/server/src/index.js`（仅追加挂载行）、`src/server/tests/admin/*.test.js`（新建）
- **要求**：
  1. 迁移 043：按 `design/03` §4 权限目录插入 `admin.users.view/manage/delete`、`admin.devices.manage`、`admin.subscriptions.grant`、`admin.orders.refund/reconcile`、`admin.plans.manage`、`admin.audit.view`、`admin.roles.manage`、`admin.configs.manage`、`admin.announce.send`；super_admin 授予全部，admin 授予除 delete/refund/roles/configs 外全部；幂等（ON CONFLICT DO NOTHING）
  2. `adminAuth.js`：`requireRole(minLevel)`、`requirePerm(permKey)`（查 role_permissions，带内存缓存 60s）；401/403 响应走错误壳
  3. `routes/admin/index.js`：Router 骨架挂 `authenticateToken + superAdminAudit`，子路由留待后续工单填充；在 `src/server/src/index.js` 追加 `app.use('/api/admin', adminRoutes)`（照抄 :352 附近现有挂载模式）
  4. 测试：中间件单测（vitest，mock pool）
- **验收**：`node --check` 通过；迁移 SQL 幂等可重复执行；无权限用户访问任意 /api/admin/* 返回 403 错误壳

### T-A2 [P0][前端] 看板页 + 用户管理页（对照草图）
- **独占文件**：`src/admin-console/src/pages/dashboard/**`、`pages/users/**`、`components/UserDrawer/**`、`components/ConfirmReasonModal/**`、`components/StatusTag/**`、`components/charts/**`、`hooks/useTableQuery.ts`、`utils/format.ts`
- **要求**：
  1. 看板页：4 KPI 卡（注册用户/付费用户·转化率/MRR/在线设备，含 delta 胶囊）+ ECharts 近 14 天订单柱图（含退款浅紫叠加）+ 付费转化环 + 渠道占比条 + 待处理事项表；数据走 `queryKeys.overview` → MSW
  2. 用户管理页：`useTableQuery` 驱动表格（搜索/套餐/状态/注册时间筛选、分页）；状态/套餐用 StatusTag；行点击开 `UserDrawer`（资料 kv、设备表、最近审计时间线、管理操作按钮组）；「停用账号」「删除账户」经 `ConfirmReasonModal`（原因必填）发 mutation 后 invalidate
  3. `utils/format.ts`：fmtMoney（千分位/¥）、fmtTime（YYYY-MM-DD HH:mm）、maskPhone、relativeTime
  4. 全部对照草图 B 目检一致
- **验收**：lint/typecheck/build 绿；看板与用户页交互完整（MSW 数据）；E2E smoke 前四步可通过

---

## 五、Wave 3 — 商务域（2 并发）

### T-A3 [P0][后端] 订单/退款/对账 + 订阅/套餐 APIs
- **独占文件**：`src/server/src/routes/admin/orders.js`、`subscriptions.js`、`plans.js`、`tests/admin/orders*.test.js` 等
- **要求**：GET /orders（status/channel/date 筛选+分页）、GET /orders/:orderNo、POST /orders/:orderNo/refund `{ amount, reason }`（仅 super_admin：requirePerm('admin.orders.refund')，复用现有退款逻辑思路：更新 payment_orders.status='refunded' + 写审计 + 降级订阅如年付全退）、GET /reconciliation（按渠道汇总 paid/refunded 金额与笔数）；GET /subscriptions（含用户摘要）、POST /subscriptions/:id/grant `{ planId, months, reason }`（写审计）；GET/POST/PATCH /plans（编辑 subscription_plans，features JSONB 校验）
- **验收**：`node --check` + 单测；所有写操作审计可查

### T-A4 [P0][前端] 订单页 + 设置页（对照草图）
- **独占文件**：`src/admin-console/src/pages/orders/**`、`pages/settings/**`、`api/orders.ts`、`api/configs.ts`
- **要求**：订单页状态 Tabs + 筛选 + 表格 + 退款弹窗（金额/原因）+ 对账报告抽屉；设置页功能开关列表（switch 即时 PATCH）+ 维护模式卡 + 系统参数表单 + 公告下发表单（含最近发送记录）
- **验收**：lint/typecheck/build 绿；交互与草图一致

---

## 六、Wave 4 — 治理域 + 设备订阅页（2 并发）

### T-A5 [P0][后端] 审计日志 + 角色/配置/公告 APIs
- **独占文件**：`src/server/src/routes/admin/audit.js`、`roles.js`、`configs.js`、`announcements.js`、对应 tests
- **要求**：GET /audit-logs（action/操作者/状态/IP/日期筛选+分页，join users 取昵称）；GET /roles（含权限目录与每个角色权限集合）、POST /roles（自定义角色 custom_*，级别 < 操作者）、PATCH /roles/:id/permissions；GET/PATCH /configs、GET/PATCH /flags；POST /announcements（调 notificationService 群发 + 记录）+ GET /announcements（发送历史）
- **验收**：`node --check` + 单测；角色级别约束（不可越级赋权）有测试

### T-A6 [P1][前端] 审计页 + 角色权限页 + 设备/订阅页
- **独占文件**：`src/admin-console/src/pages/audit/**`、`pages/roles/**`、`pages/devices/**`、`pages/subscriptions/**`
- **要求**：审计页（筛选区+表格+敏感行红底高亮+CSV 导出前端生成）；角色页（左角色列表含自定义角色+右权限树 checkbox 分组，超管角色置灰不可改+callout 提示）；设备页（全量表格+平台分布+远程下线）；订阅页（列表+赠期弹窗）
- **验收**：lint/typecheck/build 绿；与草图一致；E2E smoke 5 步全通

---

## 七、Wave 5 — 集成验收（编排者主导）

### T-A7 [P0][集成] 关 MSW 真联调 + 修复 + 部署配置
- 切 `VITE_ENABLE_MSW=false` 起后端（docker dev）逐页联调；修复字段/契约偏差；nginx `admin.clipstream.work`（或 /admin，待用户确认 DNS）配置草案；E2E 全绿；交付验收清单

---

## 八、派发状态看板（编排者维护）

| 工单 | 状态 | 派发波次 | 备注 |
|------|------|----------|------|
| T-A0 脚手架+MSW | ✅ 完成（09-05） | Wave 1 | lint/typecheck/build/test 全绿，目检通过 |
| ~~T-A2 看板+用户页~~ | ✅ 并入 T-A0 | Wave 1 | |
| T-A1 后端地基 | ✅ 完成（09-06） | Wave 2 | 043 迁移 + requireRole/requirePerm + whoami，18 测试 |
| T-A4 订单+设置页 | ✅ 完成（09-06） | Wave 2 | 退款/对账/开关/维护/公告，25 测试；含柱图修复 |
| T-A3 订单后端 | ✅ 完成（09-06） | Wave 3 | orders/refund/reconciliation/subscriptions/plans，与前端 refunding 契约对齐 |
| 审计+角色页 | ✅ 完成（09-06） | Wave 3 | 敏感高亮/CSV 导出/权限树/级别约束，38 测试 |
| T-A5 治理后端 | ✅ 完成（09-06） | Wave 4 | audit/roles/configs/flags/announcements + 044 迁移 |
| 设备/订阅页 | ✅ 完成（09-06） | Wave 4 | 平台分布/远程下线/赠期弹窗，48 测试 |
| T-A1.5 用户/设备/overview 后端 | ✅ 完成（09-06，补票） | Wave 5 | 排票遗漏补齐；users/devices/overview 全套 |
| T-A7 集成验收 | ✅ 完成（09-06） | Wave 5 | 043/044 已应用 dev 库；联调容器 clipsync-admin-int(:3003)；真后端登录/whoami/全页面走查通过；登录改造为验证码+密码双模式 |

**遗留事项（后续迭代）**：① 设备远程下线仅 DB 标记离线，真实密钥吊销待做；② 公告群发未接 notificationService（落表+TODO）；③ auth-refresh 真实契约未对齐（401 直接回登录页）；④ E2E smoke 为 skip 态骨架；⑤ dev 库 phone 列存在脏数据（如 `135****rged`），打码函数对非数字串显示原样。
