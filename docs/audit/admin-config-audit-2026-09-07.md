# ClipSync 后台管理系统配置项全面审查报告

- **日期**：2026-09-07
- **视角**：管理人员（运营/客服/合规）+ 系统维护人员（运维/DBA/开发）
- **方法**：四端代码级全量盘点（admin-console / server / desktop / mobile）+ 配置链路交叉验证（docker-compose / k8s / monitoring / nginx / scripts）
- **关联**：[admin-audit-report-2026-09-06.md](./admin-audit-report-2026-09-06.md)（上一轮功能审计）；本次新增两份交付：本报告（任务①）与 [feature-flags-fullchain-report-2026-09-07.md](./feature-flags-fullchain-report-2026-09-07.md)（任务②实现+测试）

---

## 一、现有配置项全景清单

### 1.1 管理台运行时配置（改完即生效，无需重启）

**A. 功能开关（`feature_flags` 表，5 键）** —— 系统设置页卡片一
写库 → 进程缓存失效（≤5s）→ 服务端 `requireFlag` 403 强制 → WS `feature_flags.updated` 全端广播 → 客户端快照 `GET /api/app/feature-flags`。

| flag key | 名称 | 关闭语义 | 服务端强制点 |
|---|---|---|---|
| `enable_subscription` | 订阅功能 | 全部用户按 Free 配额执行，不改库不影响已有订单 | subscriptionCheck 中间件（devices/clipboard/media/sync/storage/upload/versions 七条路由族） |
| `enable_ai_agent` | AI 助手 | AI 全部接口 403 | `/api/ai`、`/api/ai/conversations`、`/api/ai/memories`、`/api/ai/settings` 四处挂载 |
| `enable_public_sharing` | 公开分享 | 禁止新建；已建链接仍可访问 | sharedLinks.js 新建/上传文件两路由 |
| `enable_2fa` | 两步验证 | 禁止新绑定；已绑定不受影响 | two-factor.js setup/enable 两路由 |
| `signup_waitlist` | 注册审核 | 新注册进待审核、登录被拦截，用户管理页审批 | auth.js/auth-verify.js 五处业务分支 |

**B. 系统参数（`system_configs` 表，管理台暴露 5 键）** —— 系统设置页卡片四

| config key | 名称 | 默认值 | 消费方 |
|---|---|---|---|
| `maintenance_mode` | 维护模式 | off | ⚠️ 仅存储+审计，**服务端无强制拦截**（见 2.1-D2） |
| `ai_max_tokens` | AI 单次最大 Token | 4096 | AI 工具链 |
| `ai_default_provider` | AI 默认服务商 | openrouter | AI 设置默认值 |
| `session_timeout_minutes` | 管理台会话超时 | 30 | admin-console 前端 idle 登出 |
| `audit_log_retention_days` | 审计保留天数 | 365 | ⚠️ 无归档/清理任务消费（见 2.1-D3） |

**C. 库中有种子但管理台不可改的隐藏键（2 个）**：`max_collection_depth`（=5）、`enable_audit_log`（=true）——PATCH 未知键返回 40404。

**D. 公告下发**（`admin_announcements` 表）：标题/内容/受众（all、pro_plus、free）/展示模式（once、persistent）。⚠️ 无客户端投递链路（见 2.1-D4）。

### 1.2 环境变量配置（改完需重启容器/进程）

| 类别 | 变量 | 现状 |
|---|---|---|
| 基础 | PORT/HOST/LOG_LEVEL/NODE_ENV | 正常 |
| 数据库 | DB_* 五项 + DB_POOL_* 超时 | 正常 |
| Redis | REDIS_HOST/PORT/PASSWORD | 正常 |
| 安全 | JWT_SECRET/JWT_EXPIRES_IN/ENCRYPTION_*/REFRESH_TOKEN_TTL_DAYS | 正常；生产缺省有启动告警 |
| CORS | `CORS_ORIGINS`（生效）| ⚠️ compose/k8s 设置的 `ALLOWED_ORIGINS` 是**死变量**，代码不读 |
| 上传 | UPLOAD_DIR/STORAGE_TYPE/S3_* 五项 | 生效；⚠️ `MAX_FILE_SIZE`（compose 设置 10MB）为**死变量** |
| 超时 | REQUEST_TIMEOUT/WS_HEARTBEAT_* | 生效，需重启 |
| 支付 | STRIPE_*/WECHAT_PAY_*/ALIPAY_* | webhook 验签用 |
| 限流 | —— | ⚠️ 无任何 env；`DISABLE_RATE_LIMIT`（compose 设置）为**死变量** |
| 邮件 | —— | ⚠️ `config.email` 消费者存在但配置源不存在，SMTP 永远走 console 兜底 |

### 1.3 代码内硬编码（改阈值需改代码）

- 限流阈值（rateLimiter.js 字面量）：apiLimiter 300/min、验证码 5/h、登录失败 5/15min
- 上传限制：sharedLinks 50MB、media 20MB（图）/1GB（企业上限）、chunked 每片 12MB
- `config.upload.maxImageSize/maxFileSize` 定义了但**无任何消费者**（死配置）

### 1.4 管理台九页面能力现状

数据看板/用户管理/设备管理/订单与支付/订阅管理/审计日志/角色权限/系统设置（+登录页）：13 项 admin.* 权限点、审计双写、CSV 导出、远程下线、赠期/退款等在 9-06 审计中已确认真实有效。**管理台完全没有运维监控类页面**。

---

## 二、发现的问题（配置视角）

### 2.1 配置缺陷（建议按飞书缺陷流程跟踪）

| # | 问题 | 影响 | 级别 |
|---|---|---|---|
| D1 | **限流三处失守**：`DISABLE_RATE_LIMIT` 死变量（dev 限流实际一直开着，注释误导）；`strictLimiter`/`uploadLimiter` 定义后零使用；nginx 层 limit_req 全部注释关闭。限流阈值全部硬编码，运维无法调整 | 攻击面/容量管理失控 | **P1** |
| D2 | **维护模式是纯展示配置**：可写库、可审计，但服务端无任何拦截中间件、无 WS 广播、无客户端提示——UI 宣称"同步请求返回维护提示"未落地 | 紧急运维手段实际不存在 | **P1** |
| D3 | `audit_log_retention_days` 有配置无消费者：无归档/清理任务，审计表将无限膨胀 | DB 容量/合规 | P2 |
| D4 | 公告链路客户端侧缺失（9-06 遗留项 1）：delivered_count 是受众数不是触达数 | 运营能力名不副实 | P2 |
| D5 | **`/api/ready` 恒 503**：引用未定义的 `config.upload.dir` → `fs.access(undefined)` 抛异常 → k8s readinessProbe 指向它，按 manifest 部署 Pod 永远 NotReady | 部署阻断级隐患 | **P1** |
| D6 | **Prometheus 告警规则 5 条应用层指标名不匹配**：规则用 `http_requests_total`/`pg_pool_*`/`ws_active_connections` 等，应用实际导出 `clipsync_*` 前缀——全部永不触发，故障无告警 | 监控形同虚设 | **P1** |
| D7 | `/api/metrics` 与 `/api/metrics/prometheus` 无认证暴露；`routes/metrics.js`（带鉴权版本）是死代码未挂载 | 信息泄露面 | P2 |
| D8 | 死配置/死代码群：`ALLOWED_ORIGINS`、`MAX_FILE_SIZE`、`CSRF_SECRET`（不需要）、strictLimiter/uploadLimiter、requestTimeout 路由超时表、routes/health.js、config.upload.*；配置误导运维 | 维护成本/误判 | P2 |
| D9 | SMTP 邮件链路断裂：`config.email` 无配置来源，邮箱验证码只打印到控制台 | 邮箱注册/找回密码不可用 | P2 |
| D10 | k8s base ConfigMap 中 JWT_SECRET/ENCRYPTION_KEY 明文 `CHANGE_ME`；staging kustomization.yaml 有 YAML 结构错误 | 安全/可用性 | P2 |
| D11 | 日志单文件追加无轮转（logs/clipsync.log），磁盘可被写满 | 运维事故 | P2 |
| D12 | 管理台隐藏配置键（max_collection_depth/enable_audit_log）不可见不可改，存在感为零 | 配置黑盒 | P3 |

### 2.2 缺失的关键配置模块（按用户指定方向 + 补充发现）

#### A. 系统限流配置模块（P1，用户指定方向）

现状：全部硬编码。建议新增管理台「限流配置」卡片（L3 权限），`system_configs` 新增键：

| 建议键 | 默认 | 说明 |
|---|---|---|
| `rate_limit_api_per_min` | 300 | 全局 API 滑动窗口阈值/分钟/用户（匿名按 IP） |
| `rate_limit_send_code_per_hour` | 5 | 验证码发送/小时/手机号 |
| `rate_limit_login_failed_per_15min` | 5 | 登录失败锁定阈值 |
| `rate_limit_upload_per_min` | 20 | 上传接口阈值（顺带把闲置的 uploadLimiter 挂到 /api/upload + chunked-upload） |
| `rate_limit_ws_conn_per_min` | 5 | WS 连接建立频率 |
| `rate_limit_disabled` | false | 限流总开关（取代死变量 DISABLE_RATE_LIMIT；生产禁开） |

必要性：① 限流是抗爆破/抗滥用第一道闸，目前阈值调整需发版；② 验证码短信有真实成本，运维需要应急调低；③ 故障排障时需要临时放宽而不重启。实现成本低：rateLimiter.js 改为从 system_configs 读（带 5s 缓存，同 featureFlags 模式）。

#### B. 运维集中化管理模块（P1~P2，用户指定方向）

现状：monitoring/ 有完整 Prometheus+Alertmanager+Grafana+飞书 webhook 栈，但告警规则失配（D6）、管理台零运维可见性。建议分两步：

**第一步（P1，纯应用层，不碰集群）——管理台新增「运维监控」页**：
| 能力 | 数据源（已有） | 说明 |
|---|---|---|
| 服务健康总览 | `/api/health`、`/api/ready`（修复 D5 后）、版本/uptime | 红绿灯卡片：API/DB/Redis/文件系统 |
| 流量与错误指标 | `/api/metrics/prometheus`（先加鉴权，D7） | 请求量/错误率/p95 时延近 1h 趋势，复用 echarts（admin-console 已依赖） |
| 慢查询面板 | `/api/admin/slow-queries`（已有，is_admin） | 直接表格化 |
| 日志级别运行时调整 | system_configs 新键 `log_level` | logger.js 读配置热生效，避免改 env 重启 |
| 告警通知入口 | 现有飞书 webhook | 展示最近告警（Alertmanager webhook 回写或只放跳转） |

**第二步（P2，容器/集群层）**：
- **K8s/Docker 容器监控**：不建议把容器管理 API 直接做进应用后台（安全边界——管理台是业务后台，不是 k9s）。建议：node-exporter + cAdvisor 采集 → Grafana 出「容器总览」仪表盘 → 管理台运维页内嵌（Grafana iframe/匿名只读）或跳转链接。
- **扩缩容**：k8s base 已有 HPA（2-10 副本 CPU70%/Mem75%）。管理台只做**只读展示**（当前副本数/HPA 目标，经一个新的只读 admin 端点由运维侧提供或直接读 metrics 推算），不做写操作——应用后台直改集群属高危面，与 RBAC 模型冲突。docker compose dev 环境无需扩缩容能力。
- **部署管理**：保留 CI/CD（GitHub Actions）为唯一部署入口，管理台展示「当前运行版本/镜像/部署时间」（来自 `/api/app/version` + 启动时间），不做触发部署。

#### C. 其他对管理至关重要的缺失配置（补充发现）

| 模块 | 建议键/能力 | 级别 | 必要性 |
|---|---|---|---|
| 邮件 SMTP 配置 | system_configs 或 env：`smtp_host/port/user/pass/from` + 管理台「发送测试邮件」 | P2 | 修复 D9；邮箱验证码/找回密码前置条件 |
| 上传大小限制 | `max_upload_size_mb`（对齐代码硬编码处 + 修 D8 死变量） | P2 | 套餐表已管 per-plan 上限，全局硬顶应可配 |
| 注册总开关 | `enable_signup`（区别于 waitlist：完全关闭注册） | P2 | 运营常需（内测期/攻击期），目前只能靠 waitlist 变通 |
| 会话策略统一 | JWT 过期/refresh TTL 目前仅 env；`session_timeout_minutes` 只管管理台。建议管理台可调客户端 token 策略或明确文档化边界 | P3 | 安全事件响应时需要 |
| 备份状态可视化 | 管理台展示最近备份时间/大小/校验结果（prod sidecar 已有每小时备份） | P2 | 管理员目前对备份成败零感知 |
| AI 供应商治理 | 管理台只读视图：全站 BYOK 供应商分布/失效供应商清理（L3） | P3 | L3 工具清单已有 get/update_system_config，缺供应商视角 |
| 审计归档任务 | 消费 audit_log_retention_days 的定时归档/清理 | P2 | 修复 D3 |
| 公告投递 | `GET /api/app/announcements` + 两端 UI + 真实触达计数（9-06 遗留项 1） | P2 | 修复 D4 |

---

## 三、优先级路线图建议

| 优先级 | 事项 | 依赖 |
|---|---|---|
| P0 | （已随任务②完成）功能开关客户端全链路感知 | 无 |
| P1 | 修 D5 /api/ready 恒 503（一行兜底）；修 D6 告警指标名；限流配置模块 A | 无 |
| P1 | 维护模式落地：subscriptionCheck 式中间件 + WS 广播 + 两端横幅 | 无 |
| P2 | 运维监控页第一步（健康总览/指标/慢查询/日志级别） | D5、D7 先修 |
| P2 | SMTP 配置、注册总开关、审计归档、备份可视化、死配置清理（D8） | 无 |
| P3 | 容器层 Grafana 内嵌/跳转、AI 供应商治理、会话策略文档化 | 第一步运维页 |

## 四、测试资产

- `scripts/feature-flags-audit/run-flags-audit.mjs`：本次任务②的 34 项断言（5 开关全链路）
- 上一轮：`scripts/admin-full-audit/run-audit.mjs`（12 阶段 100+ 断言）
