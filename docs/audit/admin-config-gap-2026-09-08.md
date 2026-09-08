# ClipSync 后台管理系统「配置项 / 管理项」缺口分析

- **日期**：2026-09-08
- **目标**：从**运维维度、代码维度、功能维度**回答一个问题——「桌面端（含移动端）真实存在的配置与能力，后台管理系统是否管得住？还缺什么？」
- **方法**：桌面端 `src/desktop` + Tauri 侧 + 服务端 `featureFlags / planLimits / runtimeLimits / subscription_plans` 全量代码调研，与 `src/admin-console` 现状逐项比对；配合运行时实测（见 [admin-runtime-audit-2026-09-08.md](./admin-runtime-audit-2026-09-08.md)）
- **关联**：[admin-config-audit-2026-09-07.md](./admin-config-audit-2026-09-07.md)（配置链路代码审查）、[feature-flags-fullchain-report-2026-09-07.md](./feature-flags-fullchain-report-2026-09-07.md)（开关全链路）

---

## 1. 桌面端「实际存在」的可管控项全景

### 1.1 客户端本地配置（20 项，全部 `localStorage` / Tauri Store，**服务端零管控**）

| 分类 | 配置项 | 存储键 | 默认值 | 服务端可管 |
|---|---|---|---|---|
| 外观 | 语言 / 主题风格 / 明暗模式 / 字号 / 字体 / 减少动效 | `clipsync-lang`、`clipsync-theme-*`、`clipsync-prefs` | zh / vercel / light / 1 / default / false | ❌ |
| 同步 | 自动同步 / 同步间隔 / 本地历史条数 / 图片压缩 / 服务器地址 | `clipsync-prefs` + Tauri AppConfig | true / 0 / 500 / false / 空 | ❌（仅"历史无限"受套餐门控） |
| 设备 | 开机自启 / 设备名 / 设备 ID | `clipsync-prefs`、`clipsync-device-id` | false / Desktop / — | ❌ |
| 快捷键 | 快速粘贴 / 唤窗 / AI 面板 / 复制 / 删除 / 搜索 | `clipsync-custom-shortcuts` + Rust AppConfig | Ctrl+Shift+V / Ctrl+Alt+Space / Ctrl+Shift+A … | ❌ |
| 隐私 | 隐私模式打码 / 失焦模糊 / 复制后清空剪贴板 / 本地 PIN / PIN 有效期 | `clipsync-prefs`、`clipsync-privacy-*` | 全 false / 无 PIN / 30s | ❌（PIN 明文存 localStorage） |
| 通知 | 新设备 / 同步完成 / 安全 / 更新 四类偏好 | `clipsync-sec-notif` + 后端 preferences | 全 true | ⚠️ 后端有存，**后台无管理入口** |

### 1.2 服务端下发的配置与能力（**通道现状**）

| 下发内容 | 客户端通道 | 服务端管理入口 | 通道状态 |
|---|---|---|---|
| 功能开关（5 键暴露） | WS `feature_flags.updated`（`GET /api/app/feature-flags` 未被调用） | `PATCH /api/admin/flags/:key` | ✅ 主链路可用（`enable_signup` 未暴露也未消费） |
| 维护模式 | WS `maintenance.updated` | `PATCH /api/admin/configs/maintenance_mode` | ✅ 落库；⚠️ `GET /api/app/maintenance` **404 未实现**，冷启动拿不到快照 |
| 公告 | `GET /api/app/announcements` | `POST /api/admin/announcements` | ⚠️ 只落库**不群发** |
| 套餐能力矩阵 | `GET /api/subscriptions/current`、`/plans` | 仅 `GET/PATCH /api/admin/plans`（**后台无 UI**） | ❌ 无管理页面 |
| 菜单可见性 `menu_overrides` | —— | `PATCH /api/admin/configs/menu_overrides` | ❌ 有写无读（客户端 `setOverrides()` 预留未调用） |
| 版本与更新 | `GET /api/app/version`、`/update.json` | 无 | ❌ 硬编码（`releaseDate=2026-06-24`、`hasUpdate=false`） |
| AI 供应商 / 偏好 | `GET /api/ai/providers`、`/api/ai/settings` | 无（用户级） | ❌ 无全局管理 |
| 工作流规则 / 模板变量 | `/api/workflow-rules` 等 | 无（用户级） | ❌ 无管理视图 |

### 1.3 套餐能力矩阵（`subscription_plans` 驱动，桌面端实际消费）

| 限制键 | 含义 | Free | Pro | Enterprise | 后台可改 |
|---|---|---|---|---|---|
| `max_file_size_mb` | 单文件上限 | 20 | 128 | 512 | ❌ 无 UI |
| `max_storage_mb` | 云端总容量 | 200MB | 20GB | 200GB | ❌ 无 UI |
| `max_files_per_clip` | 单次文件数 | 3 | 10 | 50 | ❌ 无 UI |
| `file_retention_days` | 文件保留天数 | 3 | 30 | 90 | ❌ 无 UI |
| `max_devices` / `max_clipboard_items` | 设备数 / 条数 | 2 / 50 | 2 / 50 | 2 / 50 | ❌ 无 UI |
| `features`（JSON） | `ai_classify`、`team_management`、`full_text_search`、`push_notification`、`offline_queue`、`e2e_encryption`、`audit_logs`、`version_history_days`、`ocr` | 见各档 | | | ❌ 无 UI |

> 注：`features` 中仅 `ai_classify`、`team_management` 在服务端有强制点，其余**未挂墙**（配了也不生效）。

---

## 2. 后台当前管理能力矩阵（能管什么）

| 维度 | 现有页面 | 能管的键/对象 | 真实落库 |
|---|---|---|---|
| 用户治理 | 用户管理 | 状态（启用/停用/审核）、角色、抽屉只读信息 | ✅ |
| 设备治理 | 设备管理 | 远程下线（改标志位） | ⚠️ 半实现 |
| 交易 | 订单与支付 | 查询、对账、退款（改状态） | ⚠️ 不调网关 |
| 订阅 | 订阅管理 | 赠期 / 调整套餐（接口存在） | ✅ |
| 审计 | 审计日志 | 查询、详情、CSV 导出 | ✅ |
| 权限 | 角色权限 | 角色权限矩阵（超管只读保护 + 高危拦截） | ✅ |
| 配置 | 系统设置 | 6 个功能开关、维护模式、5 项限流、公告、SMTP | ✅（**系统参数 5 卡保存失效**，见运行时审计 B 类） |
| 运维 | 运维监控 | **只读**：状态/DB/Redis/慢查询/备份扫描 | ⚠️ 指标卡恒空 |
| 看板 | 数据看板 | 只读聚合 | ⚠️ 待处理事项恒空 |

**一眼可见的空白区**：**套餐与价格**（后端已实现 API，前端无页面无 api 层）、**客户端策略**、**AI 全局**、**版本发布**、**通知触达**、**备份与告警**、**超管审计视图**。

---

## 3. 缺口清单

### 3.1 功能维度

| # | 缺口 | 现状证据 | 影响 | 优先级 |
|---|---|---|---|---|
| G1 | **套餐与价格管理页缺失** | 后端 `GET/PATCH /api/admin/plans` 已实现；`src/admin-console/src/api/` 无 `plans.ts`，9 个菜单无套餐入口，权限键 `admin.plans.manage/view` 仅存在于 mock 与 DB | 改套餐额度/价格只能改库；运营无法做定价实验 | **P0** |
| G2 | **系统参数 5 卡保存失效** | `settings/index.tsx:536-578` 缺少 `<Form form={configForm}>` 包裹（对照 :451 限流卡） | `ai_*` / `session_timeout` / `audit_log_retention` / `log_level` / `menu_overrides` / SMTP 全组不可改 | **P0** |
| G3 | **客户端默认策略无下发通道** | 20 项本地配置零管控；无 `client_policies` 表/端点 | 无法统一企业客户策略（如强制隐私模式、禁用同步间隔、统一下发服务器地址） | P1 |
| G4 | **AI 全局管理缺失** | `ai_providers`（含加密 Key）、`ai_settings` 用户级偏好无管理视图；`ai_max_tokens` / `ai_default_provider` 无消费方 | 平台级 AI 供应商故障无法后台切换；"可改不生效" | P1 |
| G5 | **`menu_overrides` 有写无读** | 后台可改，客户端未消费，无只读端点与 WS 推送 | 典型"填了没反应" | P1（补齐或下架） |
| G6 | **版本与更新发布缺失** | `app.js:43-44` 硬编码 releaseDate/notes；`update.json` 硬编码 `hasUpdate=false` | 无法发布版本公告、无法灰度/强制更新 | P1 |
| G7 | **公告无触达** | `announcements.js` 只落库，`deliveredCount` = 受众数 | 运营以为发到了，用户零感知 | P1 |
| G8 | **通知偏好无管理** | 后端存了 4 类偏好，后台无入口 | 无法统一关闭某类通知 | P2 |
| G9 | **用户级数据无管理视图** | 工作流规则、模板变量、AI 供应商配置均用户级无后台视图 | 客服无法代客排查配置 | P2 |

### 3.2 运维维度

| # | 缺口 | 现状 | 建议 | 优先级 |
|---|---|---|---|---|
| O1 | **可观测指标恒空** | `ops.js` 调 `getMetricsSnapshot`（不存在）→ 请求数/错误数/p95 恒"不可用" | 在 `middleware/metrics.js` 导出 `getMetricsSnapshot()`（已有 `getMetrics` 可复用），或移除这 3 张卡 | **P0** |
| O2 | **Grafana 跳转错误** | `GRAFANA_URL` 兜底 `http://localhost:3001`（= 后端 API 端口） | `grafana_url` 纳入 CONFIG_CATALOG 可后台配置 + 跳转前可达性探测 | P1 |
| O3 | **无备份任务管理** | `ops/backups` 仅扫描目录，恒空 | 新增"立即备份 / 保留策略 / 备份位置"；或明确该功能未启用并隐藏卡片 | P1 |
| O4 | **无告警与阈值** | monitoring 栈（Prometheus/Grafana）存在但未接入后台 | 增加告警规则页或只读告警列表（Prometheus API 代理） | P2 |
| O5 | **无运维动作区** | 无"清缓存 / 重载配置 / 强制全端下线 / 断开指定连接" | 增加受限运维动作（全部走 ConfirmReasonModal + 审计） | P2 |
| O6 | **管理台自身无限流** | `index.js:482` 挂载 `/api/admin` 时未挂 `apiLimiter` | 补 `apiLimiter` 或管理台专用限流 | P1 |
| O7 | **环境变量死变量** | `ALLOWED_ORIGINS`、`MAX_FILE_SIZE`、`DISABLE_RATE_LIMIT` 代码不读取（见 09-07 报告 §1.2） | 要么接线，要么从 compose/k8s 删除，避免误导 | P2 |
| O8 | **会话超时未生效** | `session_timeout_minutes` 无消费方（管理台无 idle 登出） | 前端接入或移除该配置项 | P2 |
| O9 | **`log_level` 不热生效** | `logger.setLogLevel()` 从未被调用 | PATCH 后调用 `setLogLevel`，或从配置卡移除 | P2 |
| O10 | **无存储用量 TopN / 清理归档** | 只见个人用量，无全局视图与回收任务 | 增加"存储与用量"页 + 归档任务 | P2 |

### 3.3 代码维度

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| C1 | **配置键无"消费方登记"机制** | `session_timeout_minutes`、`ai_max_tokens`、`ai_default_provider`、`max_collection_depth`、`enable_audit_log`、`menu_overrides`、`log_level` 均可改但无消费者 | 在 `CONFIG_CATALOG` 增加 `consumer` 字段，无消费者的键在 UI 打「未接入」角标 |
| C2 | **权限键无单一事实来源** | 权限键散落在业务文件内常量；044/049/052/053 迁移分散新增；`admin.keys.view` 为死键 | 建立 `permissions` 目录表为唯一源 + 启动自检（有键无端点则告警） |
| C3 | **5 个 `*.view` 键后端不校验** | `orders/subscriptions/plans/roles/announcements` 的 GET 端点仅 `requireRole(50)`，无 `requirePerm` | 补全 `requirePerm`，前后端判权一致 |
| C4 | **E2E 全量注释态 + 断言写死 mock 数据** | `tests/e2e/smoke.spec.ts` `SMOKE_ENABLED=false`，断言「12,847 用户」等假数据 | 放开冒烟，断言改为真实数据；至少覆盖 5 条写操作闭环 |
| C5 | **MSW 假数据体量过大易误判** | `mocks/data.ts` 42KB + `handlers.ts` 35KB | 保留但对 dev 启动日志明确打印当前模式（现已有 `VITE_ENABLE_MSW=false` 约定，建议在页面角标显示"MOCK 数据"） |
| C6 | **占位按钮与真实按钮代码形态相同** | `onClick={() => message.info('xxx将在后续版本提供')}` | 约定统一 `TODO_UI` 标记 + lint 规则（禁止 `message.info('...后续版本')`） |

### 3.4 安全与合规维度

| # | 缺口 | 现状 | 建议 |
|---|---|---|---|
| S1 | **超管操作无独立视图** | `super_admin_action` 表只写不读 | 审计页增加"超管操作"筛选/页签 |
| S2 | **管理员账号安全策略缺失** | 无强制 2FA、无登录 IP/地域限制、无管理员会话列表 | 增加"管理员安全"页（强制 2FA 开关 + 会话管理 + 登录地异常提示） |
| S3 | **`enable_signup` 虚假开关** | 后台可切，服务端无校验 | 接线或下架（同 C5 角标机制） |
| S4 | **数据合规能力缺失** | 无用户数据导出（GDPR 可携）/ 彻底删除 / 匿名化 | 增加"数据主体请求"页（导出 + 软删 + 硬删审批） |
| S5 | **PIN 明文存 localStorage** | `clipsync-privacy-pin` 明文 | 桌面端改为加密/哈希；后台可下发 PIN 强度策略（G3 顺带） |
| S6 | **审计终端用户筛选失效** | `audit.js` LEFT JOIN + `r.role_key='user'` 漏掉 `role_id` 为空用户 | 改为 `role_id IS NULL OR r.role_key='user'` |

---

## 4. 建议新增的配置项与管理页面（落地草案）

### 4.1 新增页面（按优先级）

| 页面 | 路由 | 依赖接口 | 关键字段 |
|---|---|---|---|
| **套餐与价格** | `/plans` | `GET/PATCH /api/admin/plans`（已有） | display_name、price_monthly/yearly、max_*（6 项）、features（JSON 编辑器，标注哪些已挂墙）、is_active |
| **客户端策略** | `/policies` | 新增 `GET/PATCH /api/admin/policies` + 客户端 `GET /api/app/policies` | 默认语言/主题/字号、autoSync、syncInterval、maxHistory、imageCompress、privacyMode、autoBlur、PIN 策略（最小长度/有效期）、是否允许用户覆盖 |
| **AI 平台设置** | `/ai` | 新增 `GET/POST/PATCH /api/admin/ai-providers` + 全局 `ai_settings` | 供应商（name/baseUrl/model/apiKey 加密）、默认供应商、全局 token 上限、是否允许用户自定义 Key |
| **版本与发布** | `/releases` | 新增 `GET/POST /api/admin/releases` | 版本号、releaseDate、notes、平台包 URL、强制更新开关、灰度比例（替换 `app.js` 硬编码） |
| **运维动作** | `/ops` 内区块 | 新增 `POST /api/admin/ops/actions` | 清缓存、重载配置、强制全端下线、触发备份（全部原因必填 + 审计） |
| **数据主体请求** | `/dsr` | 新增 | 用户数据导出 / 删除审批流 |

### 4.2 新增配置项（服务端）

| 键 | 归属 | 建议默认 | 消费方 |
|---|---|---|---|
| `grafana_url` | `system_configs` | 空（空则按钮置灰） | 运维页跳转 |
| `client_policy_defaults` | 新表 `client_policies`（JSONB） | `{}` | `GET /api/app/policies` + WS 推送 |
| `ai_global_max_tokens` | `system_configs` | 16384 | AI 工具链（替换无消费方的 `ai_max_tokens`） |
| `force_2fa_for_admin` | `feature_flags` | false | 管理台登录中间件 |
| `backup_retention_days` | `system_configs` | 7 | 备份清理任务 |
| `storage_cleanup_enabled` / `file_retention_days`（全局兜底） | `system_configs` | false / 90 | 归档任务 |

### 4.3 配置项治理机制（治本）

1. **配置键登记制**：`CONFIG_CATALOG` 每键必填 `{ key, name, type, default, consumer, hotReload }`；`consumer` 为空 → 后台强标「未接入」，避免"可改不生效"。
2. **开关全链路自检**：启动或后台 `/ops` 页展示每个 flag 的「DB 值 / 进程缓存值 / 是否有强制点」三列，不一致即告警。
3. **占位功能登记**：所有"后续版本提供"的按钮集中到一个 `PLANNED_FEATURES` 常量，UI 统一渲染为 `disabled + 规划中` 角标，并纳入 `/settings` 的"规划中功能"清单，避免散落假按钮。

---

## 5. 优先级路线图

**P0（本周，都是"能用但用错了"的高收益项）**
1. 修系统参数卡 Form 包裹（G2）—— 1 行级改动，解锁 10+ 配置项
2. 新增套餐与价格管理页（G1）—— 后端 API 现成，前端工作量小
3. 补 `getMetricsSnapshot` 或移除 3 张恒空指标卡（O1）
4. 修 Grafana 跳转与 `enable_signup` 假开关（O2 / S3 / C5）

**P1（两周）**
5. 客户端策略下发（G3，含新表与端点）
6. AI 平台设置页（G4）+ 明确 `ai_max_tokens` / `ai_default_provider` 消费方或下架
7. 公告触达链路（G7，复用 WS）
8. 版本与发布页（G6）
9. 管理台限流（O6）+ 备份管理（O3）
10. 接线用户抽屉 3 个后端已有能力的按钮（赠期/强制下线/删除账户，见运行时审计 A 类）

**P2（一月）**
11. 超管审计视图（S1）、管理员安全页（S2）、数据主体请求（S4）
12. 告警接入（O4）、运维动作区（O5）、存储用量与归档（O10）
13. 配置键治理机制（4.3）+ E2E 冒烟放开（C4）+ 占位功能登记（C6）

---

## 6. 与 2026-09-07 报告的增量

| 项 | 09-07 报告 | 本次增量 |
|---|---|---|
| 视角 | 代码级配置链路盘点 | 运行时实测 + 桌面端反向比对 |
| 系统参数卡 | 未发现 | **发现保存链路整体失效（B 类）** |
| 套餐管理 | 未单列 | **明确为 P0 缺口（后端有 API、前端无页面）** |
| 客户端策略 | 未涉及 | **20 项本地配置零管控，建议新增下发通道** |
| 指标恒空 | 未涉及 | **实测确认 4 处（待处理事项、请求数/错误数/p95、趋势图、备份）** |
| Grafana | 未涉及 | **实测跳转指向后端 API 端口** |
