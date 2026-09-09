# 工单：后台管理能力补齐（2026-09-08 缺口分析落地）

- **缺口来源**：[../../audit/admin-config-gap-2026-09-08.md](../../audit/admin-config-gap-2026-09-08.md)（功能 / 运维 / 代码 / 安全四维度）
- **配套修复**：[admin-audit-fix-tickets.md](./admin-audit-fix-tickets.md)（先修坏的，再补缺的）
- **状态标记**：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞

> **2026-09-08 执行回写**（lead 验收）：
> - ✅ AN-01 套餐与价格管理页（/plans 渲染 3 档实测；PATCH 白名单核对补齐；mocks 契约同步）
> - ✅ AN-09 配置键 consumer 登记（逐键 grep 查证后登记，ai_max_tokens/ai_default_provider 等如实标 null）+ settings「未接入」角标
> - ✅ AN-20 E2E 冒烟放开（smoke 4 例 + settings 写操作闭环 3 例，真实后端 7/7 passed；playwright 指定本机 chromium-1234）
> - 其余（AN-02~AN-08、AN-10~AN-15、AN-21~AN-22）⬜ 未开始，按文末批次表推进。
> - **2026-09-09 更新**：AN-05（公告 WS 实时推送）因用户验收打回提前落地——announcements POST 后 `broadcastToAllClients({type:'announcement.new'})`，桌面端 HomeView 收到即拉取；实测在线客户端实时收到。移动端公告消费待后续。
- **范围说明**：本文件只收「**后台现在管不到 / 根本没有**」的新增能力；每条给出表结构、接口与 UI 草案，可直接指派

---

## WP-P 平台核心能力（P0/P1）

### AN-01 套餐与价格管理页 ⬜ P0
- **问题**：G1。桌面端整套能力矩阵由 `subscription_plans` 驱动（单文件大小 / 总容量 / 单次文件数 / 保留天数 / features），**后端 `GET /`、`PATCH /:id` 已实现**（`src/server/src/routes/admin/plans.js:132,150`），但管理台 `src/api/` 无 `plans.ts`、9 个菜单无入口 → 改套餐只能改库
- **改动**：
  1. `src/admin-console/src/api/plans.ts`：`getPlans()` / `patchPlan(id, patch)`
  2. 新页面 `pages/plans/index.tsx`（表格 + 行内编辑抽屉）：`display_name`、`price_monthly`、`price_yearly`、`max_devices`、`max_clipboard_items`、`max_file_size_mb`、`max_storage_mb`、`max_files_per_clip`、`file_retention_days`、`is_active`
  3. `features`（JSONB）用 JSON 编辑器，并**标注哪些键已挂墙**（当前仅 `ai_classify`、`team_management` 有服务端强制点，其余配了不生效）
  4. 路由 `/plans` + `AdminLayout.NAV_ITEMS` 加「套餐与价格」（perm `admin.plans.view`）+ `RequireRole permission="admin.plans.view"`
  5. 写操作 `admin.plans.manage` 守卫（后端已有），变更记审计
- **前置核对**：`plans.js:150` 的 PATCH 白名单（9 字段）是否含 `max_files_per_clip`、`file_retention_days`、`features`、`max_devices`、`max_clipboard_items`；不含则先扩白名单
- **验收**：改 Free 的 `max_file_size_mb` 20→10 → 桌面端 `GET /api/subscriptions/current` 立即反映新值；无 `admin.plans.manage` 的角色保存按钮置灰

### AN-02 客户端策略下发 ⬜ P1
- **问题**：G3。桌面端 20 项配置（语言 / 主题 / 字号 / 自动同步 / 同步间隔 / 历史条数 / 图片压缩 / 开机自启 / 快捷键 / 隐私模式 / 失焦模糊 / 复制后清空 / PIN 策略 / 通知偏好）全部 `localStorage` 或 Tauri 本地存储，**服务端零管控**，企业客户无法统一策略
- **改动**：
  1. 迁移：新表 `client_policies(id, scope, payload JSONB, updated_by, updated_at)`，`scope` 先支持 `global`
  2. 服务端：`GET /api/admin/policies`、`PATCH /api/admin/policies`（`admin.configs.view/manage`）；公开只读 `GET /api/app/policies`（optionalAuth）+ WS `policies.updated` 广播
  3. 桌面端：`usePolicy.ts` 启动拉取 + 监听 WS；与本地 prefs 合并（服务端值为默认，标记 `allowUserOverride` 的项允许用户改）
  4. 管理台新页面 `/policies`：分组表单（外观 / 同步 / 隐私 / 通知），保存记审计
- **边界**：本期只做全局策略，不做按用户/按套餐分组
- **验收**：后台关闭「允许用户修改同步间隔」并设为 15 分钟 → 桌面端设置项置灰且实际按 15 分钟同步；改回允许用户改后本地值恢复生效

### AN-03 AI 平台设置页 ⬜ P1
- **问题**：G4。`ai_providers`（含加密 API Key）、`ai_settings` 无管理视图；`ai_max_tokens` / `ai_default_provider` 两个配置项**无消费方**（配了不生效）
- **改动**：
  1. 后端 `GET/POST/PATCH/DELETE /api/admin/ai-providers`（Key 写库加密、读取脱敏；`admin.configs.view/manage`）+ 全局默认供应商/模型切换
  2. 新增键 `ai_global_max_tokens` 并在 AI 工具链接入消费；`ai_max_tokens` / `ai_default_provider` 二选一：接线消费 或 从 CONFIG_CATALOG 移除（推荐前者，改名避免歧义）
  3. 管理台新页面 `/ai`：供应商列表（名称 / baseUrl / 模型 / Key 脱敏 / 启用状态）+ 全局参数
- **验收**：后台禁用某供应商 → 桌面端该供应商不可选；改全局 token 上限 → AI 调用实际受限

### AN-04 版本与发布管理 ⬜ P1
- **问题**：G6。`GET /api/app/version` 硬编码 `releaseDate='2026-06-24'`、`notes='Bug fixes...'`；`update.json` 硬编码 `hasUpdate=false` → 无法发版、无法灰度/强制更新
- **改动**：
  1. 迁移：新表 `app_releases(id, version, name, release_date, notes, platforms JSONB, force_update, rollout_percent, published_at)`
  2. 服务端：`GET/POST/PATCH /api/admin/releases`；`app.js` 的 version / update.json 改为读库（带缓存），按 `rollout_percent` 决定是否返回更新
  3. 管理台新页面 `/releases`：发布列表 + 新建/编辑 + 发布/回滚
- **验收**：后台发布 v1.2.0 并设强制更新 → 桌面端 About 与更新检查均返回新版本；回滚后客户端不再提示

### AN-05 公告真实触达（WS 推送）⬜ P1
- **问题**：G7。公告只落库，用户端靠轮询 `GET /api/app/announcements` 才可见，运营以为"已下发"
- **改动**：`POST /api/admin/announcements` 成功后 `broadcastToAllClients({ type:'announcement.new', announcement })`（复用 `feature_flags.updated` 的广播通道）；两端监听即弹横幅；回执写 052 表
- **依赖**：AF-22（口径先修对再谈触达）
- **验收**：后台发送 → 在线桌面端 3s 内弹出；已读回执 +1

---

## WP-O 运维能力（P1/P2）

### AN-06 运维动作区 + 备份管理 ⬜ P1
- **问题**：O3/O5。运维页纯只读，无任何运维动作；备份无任务
- **改动**（全部走 `ConfirmReasonModal` + 审计 + `admin.ops.view`）：
  1. `POST /api/admin/ops/actions` 支持 `clear_cache`（清 flags/limits 缓存）、`reload_configs`、`force_logout_all`（全员下线）、`trigger_backup`
  2. 备份：`pg_dump` 到挂载目录 + 保留策略配置键 `backup_retention_days`（默认 7）+ 列表展示大小/时间
- **边界**：不做容器重启、扩缩容、部署触发
- **验收**：每项动作执行后返回明确结果并落审计；`force_logout_all` 后所有客户端需重新登录

### AN-07 管理台接口限流 ⬜ P1
- **问题**：O6。`src/server/src/index.js:482` 挂载 `/api/admin` 时**未挂 `apiLimiter`**，管理面无限流
- **改动**：`/api/admin` 挂 `apiLimiter`（阈值走 `rate_limit_api_per_min`）；`POST /api/admin/*` 高危写操作（退款 / 删除 / 关维护 / 全员下线）额外挂 `strictLimiter`
- **验收**：短时间高频调管理接口触发 429；正常操作不受影响

### AN-08 存储用量与清理归档 ⬜ P2
- **问题**：O10。只见个人用量，无全局视图与回收能力
- **改动**：`GET /api/admin/storage/top`（用户 × 用量 TopN + 总计）；配置键 `storage_cleanup_enabled` / 全局 `file_retention_days`；`db/cleanup.js` 增加过期文件清理任务
- **验收**：TopN 与 `SUM(content_size)` 交叉一致；开启清理后过期文件被回收且用量下降

### AN-09 配置键治理：消费方登记与「未接入」角标 ⬜ P1
- **问题**：C1。`session_timeout_minutes`、`ai_max_tokens`、`ai_default_provider`、`max_collection_depth`、`enable_audit_log`、`menu_overrides`、`log_level` 等均可改但**无消费方**，运营无法分辨"改了没用"
- **改动**：`CONFIG_CATALOG`（`configs.js:42-150`）每键增 `consumer` 字段（消费方文件或 `null`）；管理台对 `consumer === null` 的键显示「未接入」角标并在卡片顶部汇总数量
- **验收**：无消费方的键在 UI 上一眼可见；有消费方的键点击可看消费方文件

### AN-10 开关全链路自检显示 ⬜ P2
- **问题**：`enable_signup` 这类"UI 有、后端无强制点"的开关缺乏自检手段（AF-04 修完后仍可能再犯）
- **改动**：`GET /api/admin/flags` 增 `enforced: boolean`（该键是否存在 `requireFlag/isFlagEnabled` 调用点，可用构建期生成的清单或启动时扫描源码缓存）；运维/设置页显示「DB 值 / 进程缓存值 / 是否强制」三列，不一致即告警
- **验收**：人为在库中改 flag 绕过管理台 → 页面显示 DB 与缓存不一致

### AN-15 告警接入（只读）⬜ P2
- **问题**：O4。`monitoring/` 已有 Prometheus + Grafana + 飞书 webhook 告警规则，但管理台无告警视图，排查必须自行开 Grafana（而 AF-30 之前跳转还是错的）
- **改动**：`GET /api/admin/ops/alerts` 代理 Prometheus `/api/v1/alerts`（地址走新增配置键 `prometheus_url`，超时 3s 降级）；运维页新增「活跃告警」列表（级别 / 名称 / 触发时间 / 跳转 Grafana 对应面板）
- **边界**：只读，不做规则编辑与静默
- **依赖**：AF-30（Grafana 地址先修对）
- **验收**：人为触发一次 500 → 告警在运维页出现；Prometheus 不可达时卡片显示「告警服务不可用」而非报错

### AN-16 邮件多通道（多 SMTP 账号 + 按用途路由 + failover）⬜ P2 ⛔ 需决策
- **问题**：用户提出。当前 SMTP 为单套全局配置（`system_configs.smtp_*` 6 键，050 迁移），`utils/email.js` 全站唯一 transporter、无路由概念。单通道的 3 个真实缺陷：
  1. **送达率/信誉**：验证码（事务）与公告（批量）混用同一发件人，信誉互相拖累；QQ 个人邮箱对国外邮箱送达率一般
  2. **量级**：QQ 免费邮箱每日约数百封上限，超限暂时封禁 → 验证码服务整体不可用
  3. **无容灾**：授权码过期/服务商限流时邮件全断，无备用通道
  - 注意澄清：技术上**一个 SMTP 账号即可向任意邮箱（含 Gmail）发信**，"用户用 Gmail 注册"不构成多配置的必要理由；真正驱动是上面 3 点
- **方案（推荐 A）**：
  - 新表 `email_channels`：`id / name / purpose(transactional|marketing) / provider(smtp，预留 aliyun_dm、sendgrid) / host / port / secure / username / password(AES-GCM，沿用 encryption.js) / from_addr / enabled / priority / created_at / updated_at`
  - 迁移：把现有 `system_configs.smtp_*` 自动导入为「默认事务通道」，原键保留只读兼容一个版本后废弃
  - `email.js`：transporter 按 channelId 缓存（现按连接参数串）；`sendEmail({ channel/purpose })` 按用途选通道；主通道失败自动按 priority 降级一次
  - 管理台「邮件 (SMTP)」卡改造：通道列表（新增/编辑/删除/启用/发送测试邮件/设默认），操作记审计
  - 权限：新增 `admin.email_channels.manage`，挂到 configs 相关角色
- **备选方案 B（最小改）**：维持单套 SMTP，仅加一个「备用 SMTP」键 + 主失败切备。成本低，但解决不了信誉隔离与用途路由
- **依赖**：AF-01（系统参数 Form 修复，通道 UI 才有承载）、CO-30（现有 SMTP 配置化基础）
- **验收**：配置两个 SMTP 通道 → 用「发送测试邮件」分别测试通过；停用主通道后验证码自动走备用通道发出；审计日志可查通道变更与测试记录
- **建议时机**：P2；若上线后用专业邮件服务商（阿里云邮件推送/Resend 等）可直接按本表结构接入，不必再迁移

### AN-11 超管操作审计视图 ⬜ P2
- **问题**：S1。`super_admin_action` 表只写不读
- **改动**：审计页增加「超管操作」页签（筛选 + 详情），或在筛选器增「操作者级别=super_admin」
- **验收**：执行退款/维护模式后，该页签能查到对应记录（含 reason）

### AN-12 管理员安全策略 ⬜ P2
- **问题**：S2。管理员账号无强制 2FA、无会话管理、无登录地/IP 限制
- **改动**：新增开关 `force_2fa_for_admin`（管理台登录时若为管理角色且未开 2FA → 引导强制开启）；管理台「管理员会话」列表（复用 `user_sessions`，可强制下线）
- **验收**：开启强制 2FA 后，未绑 2FA 的管理员登录被拦截并引导绑定

### AN-13 数据主体请求（导出 / 删除）⬜ P2
- **问题**：S4。无用户数据导出（可携权）与彻底删除能力
- **改动**：管理台用户抽屉增「导出用户数据」（打包剪贴板/文件清单/订阅/订单为 JSON）与「彻底删除」（硬删 + 关联清理，需二次确认 + reason + 超管权限）
- **验收**：导出文件字段完整；彻底删除后该用户所有关联数据不可恢复（审计仍留痕）

### AN-14 死变量 / 死配置清理（第二轮）⬜ P2
- **问题**：O7/C1。09-07 报告的 `ALLOWED_ORIGINS`、`MAX_FILE_SIZE`、`DISABLE_RATE_LIMIT` 已清一轮；本轮继续清理无消费方配置键（与 AN-09 联动）
- **改动**：AN-09 完成后，对 `consumer === null` 且产品确认无规划的键：从 CONFIG_CATALOG 移除 + 迁移标注废弃（不删历史数据）
- **验收**：管理台配置项总数下降且无「未接入」项残留

---

## WP-Q 质量防护（防止假功能再犯）

### AN-20 E2E 冒烟放开 + 真实数据断言 ⬜ P1
- **问题**：C4。`src/admin-console/tests/e2e/smoke.spec.ts` 顶部 `SMOKE_ENABLED = false`，全部用例 `test.skip`；且断言写死 mock 数据（「12,847 用户」「¥41,286」「退款申请待审核 × 2」），真跑也必然失败 → 后台长期无任何自动化回归保护
- **改动**：
  1. `SMOKE_ENABLED = true`；断言改为**相对断言**（KPI 非 null、表格行数 > 0、URL 变化），不写死业务数值
  2. 覆盖 5 条写操作闭环：登录 → 功能开关切换并还原 → 限流配置保存并还原 → 角色权限勾选保存并还原 → 审计导出
  3. 接入 CI（`npm run e2e`），失败阻断合并
- **依赖**：AF-01（否则"系统参数保存"用例必挂）
- **验收**：`npm run e2e` 全绿且可重复执行（写操作必须自带还原）

### AN-21 占位功能登记机制 + lint 约束 ⬜ P2
- **问题**：C6。占位按钮 `onClick={() => message.info('xxx将在后续版本提供')}` 与真实按钮代码形态相同，无法静态识别
- **改动**：
  1. 新增常量 `src/admin-console/src/constants/plannedFeatures.ts` 集中登记所有未实现功能（标题 + 预期版本 + 关联工单号）
  2. 统一渲染组件 `<PlannedButton feature="user.changePlan" />`（disabled + Tooltip「规划中 · 见工单 AF-13」）
  3. ESLint 规则：禁止在业务代码中出现 `message.info('...后续版本')` 字面量
- **验收**：全仓无占位 toast 字面量；所有规划中功能可在设置页「规划中功能」清单查看

### AN-22 run-audit 新增阶段断言 ⬜ P2
- **问题**：现有 `scripts/admin-full-audit/run-audit.mjs` 阶段未覆盖本轮发现的问题类型
- **改动**：新增阶段
  - `settings-form`：断言系统参数 5 卡输入框非空且保存能触发 PATCH（防 AF-01 复发）
  - `opsmetrics`：`ops/overview.metrics` 非 null（防 AF-02 复发）
  - `perm-matrix`：7 个 view 端点无权限 403 / 有权限 200（防 AF-03 复发）
  - `flags-enforced`：每个 flag 是否存在强制点（防 AF-04 复发）
- **验收**：`node run-audit.mjs all` 覆盖新阶段且全绿

---

## 验收总口径

1. 新增页面统一遵循现有惯例：`pages/<name>/index.tsx` + `api/<name>.ts` + 路由注册 + `AdminLayout.NAV_ITEMS` + `RequireRole permission` + **mocks/handlers 与 mocks/data 同步**并跑 `npm test`
2. 新增/修改配置键同步 `CONFIG_CATALOG` 与 `FLAG_CATALOG`，并填 `consumer` 字段（AN-09）
3. 新增权限键需同步：`PERM_CATALOG`（`roles.js:38-52`）+ 迁移授权 + 管理台权限树 + mocks
4. 所有写操作必须：原因/变更记审计 + 前端有 loading/失败提示 + 执行者可还原
5. 每项完成后 `node scripts/admin-full-audit/run-audit.mjs all` 全绿；前端工单另需真实浏览器验证（改 → 提交 → 接口复查 → 还原）

## 建议执行顺序

| 批次 | 工单 | 说明 |
|---|---|---|
| 第 1 批（并行） | AN-01、AN-09、AN-20 | 套餐页（收益最大）、治理基座、回归保护 |
| 第 2 批 | AN-02、AN-03、AN-05 | 三条下发/配置通道，均依赖 AN-09 的目录规范 |
| 第 3 批 | AN-04、AN-06、AN-07、AN-15 | 发版与运维（AN-15 依赖 AF-30） |
| 第 4 批 | AN-10、AN-21、AN-22 | 防复发机制 |
| 第 5 批 | AN-08、AN-11～AN-14、AN-16 | 存储、安全合规、邮件多通道（AN-16 依赖 AF-01；可先按备选 B 最小改） |
