# 方案三：后台配置能力补全与运维集中化（配置审计落地方案）

- **状态**：设计评审中（未实施）
- **日期**：2026-09-07
- **来源**：由配置审查报告落成：[../../audit/admin-config-audit-2026-09-07.md](../../audit/admin-config-audit-2026-09-07.md)（缺陷编号 D1-D12 沿用该报告）
- **关联**：[feature-menu-access-control.md](./feature-menu-access-control.md)（方案一）、[rbac-permission-system-redesign.md](./rbac-permission-system-redesign.md)（方案二）；工单见 [../tickets/config-ops-tickets.md](../tickets/config-ops-tickets.md)
- **本文约定**：现状事实以审计报告为准（均有代码证据）；本方案只做「怎么改」的设计

---

## 一、方案总览

配置审计发现 12 项缺陷（P1×5）与 8 类缺失配置模块。本方案将其收敛为 **4 个工作包**：

| 工作包 | 内容 | 解决的缺陷 | 优先级 |
|---|---|---|---|
| WP-A 限流配置化 | 限流阈值从硬编码改为 system_configs 运行时可调 + 管理台「限流配置」卡片 | D1 | P1 |
| WP-B 紧急运维手段 | 维护模式真实落地（服务端强制 + WS 广播 + 两端横幅） | D2 | P1 |
| WP-C 部署级隐患修复 | /api/ready 恒 503、Prometheus 告警指标失配、metrics 鉴权、日志轮转 | D5、D6、D7、D11 | P1 |
| WP-D 配置补全与清理 | SMTP 配置、注册总开关、审计归档任务、备份可视化、死配置/死代码清理、隐藏键暴露 | D3、D4、D8、D9、D12 | P2 |

运维监控页（用户指定方向）拆为两步：第一步（管理台应用层页）挂在 WP-C 之后实施；第二步（容器/集群层）只读展示，见本文第五节。

---

## 二、WP-A：限流配置化（P1）

### 2.1 设计

复用 featureFlags 的成熟模式（进程内 5s TTL 缓存 + 管理台写库 + WS 推送），rateLimiter.js 的四个阈值从字面量改为读 `system_configs`：

**新增 config 键**（CONFIG_CATALOG 同步扩充，管理台系统设置页新增「限流配置」卡片，L3 权限）：

| key | 默认（对齐现硬编码值） | 说明 |
|---|---|---|
| `rate_limit_api_per_min` | 300 | 全局 API 滑动窗口/分钟/用户（匿名按 IP） |
| `rate_limit_send_code_per_hour` | 5 | 验证码发送/小时/手机号 |
| `rate_limit_login_failed_per_15min` | 5 | 登录失败锁定阈值 |
| `rate_limit_upload_per_min` | 20 | 上传接口阈值（**顺带把闲置的 uploadLimiter 挂到 /api/upload 与 chunked-upload**——现在这两个路由没挂限流器） |
| `rate_limit_disabled` | false | 限流总开关（生产禁开：写入时若 NODE_ENV=production 且值为 true 直接 400 拒绝） |

### 2.2 关键实现点

- 新增 `utils/runtimeLimits.js`：读 system_configs + 5s 缓存 + 失败回退硬编码默认值（限流配置系统故障时不能变成不限流——与 featureFlags 的 fallback 方向**相反**，这里必须 fail-closed 到保守默认）
- rateLimiter.js 各工厂函数在生成 limiter 时改为动态读阈值（Redis ZSET 的 limit 参数每次检查时取当前值，无需重建 limiter）
- **删除 compose 里的 `DISABLE_RATE_LIMIT` 死变量**（docker-compose.dev.yml:102），由 `rate_limit_disabled` 取代；dev 默认保持限流开启（当前实际就是开着的，注释是误导）
- strictLimiter（10/min）挂到敏感写路由：/auth/register、/auth/change-password、/auth/forgot-password
- 管理台卡片含「当前生效值 + 上次修改人/时间」（读审计）

### 2.3 兼容性

- 未配置新键时回退现硬编码值——升级零行为变化
- 管理台旧版本看不到新卡片，无影响

---

## 三、WP-B：维护模式落地（P1）

现状：`maintenance_mode` 只是一个可写库、可审计的摆设——服务端无拦截、无广播、无客户端感知（管理台 UI 却宣称"同步请求返回维护提示"）。

### 3.1 设计（对齐 feature-flags 全链路模式）

```
管理台开启维护模式（原因必填，已有）
  → 写 system_configs + 审计（已有）
  → 【新增】WS broadcastToAllClients({ type: 'maintenance.updated', mode, message })
  → 【新增】服务端强制：maintenanceGuard 中间件挂 /api/clipboard、/api/sync、/api/media、/api/upload、/api/ws
      - 维护开启时返回 503 { error: '系统维护中', maintenance: true, retryAfter }
      - 白名单：/api/auth/*（登录放行）、/api/admin/*、/api/health、/api/ready、/api/app/*
  → 【新增】两端客户端：
      - 桌面端：App.vue 监听 WS + /api/app/configs 轮询兜底 → 全屏维护横幅（禁同步操作）
      - 移动端：FeatureFlagsProvider 同款模式 → MaterialBanner + 停止自动同步
```

### 3.2 设计决策

1. **拦截范围只含同步写链路**（clipboard/sync/media/upload/ws），**不拦读和登录**——维护通常是数据库/部署操作，读请求留活口便于排查；登录放行避免"维护期间所有人被登出且进不来"
2. **WS 连接不断开**：推送 maintenance.updated 后客户端自行暂停采集与自动同步，恢复时反向恢复——避免维护结束后的重连风暴
3. 管理台设置页文案改为与真实行为一致（拦截范围、白名单写清楚）
4. 新增公开只读端点 `GET /api/app/maintenance`（登录前客户端也能感知，配合维护公告展示）

### 3.3 兼容性

- 旧版客户端（无横幅逻辑）：请求收到 503 + 中文 error，走既有错误提示链路，行为等同"服务暂时不可用"
- maintenance_mode 当前值 off：升级后零行为变化

---

## 四、WP-C：部署级隐患修复（P1）

| 项 | 修法 | 量级 |
|---|---|---|
| D5 `/api/ready` 恒 503 | index.js:286 `config.upload.dir` 加 `|| './uploads'` 兜底（对齐 routes/health.js:73 的写法）；顺带确认 UPLOAD_DIR env 的真实值就是 uploads 目录 | 1 行 |
| D6 告警指标失配 | monitoring/prometheus/rules/clipsync-alerts.yml 五条规则改名对齐应用实际导出：`clipsync_requests_total`、`clipsync_errors_total`、`clipsync_response_time_seconds_*`、WS 连接数改由应用导出 `clipsync_ws_connections`（middleware/metrics.js 补一个 gauge）或删该条规则 | 小 |
| D7 metrics 无鉴权 | 挂 authenticateToken + requireRole(50)（与 slow-queries 同口径）；Prometheus 抓取配置加 bearer_token；删除死代码 routes/metrics.js（或将其挂载替代内联版，二选一，倾向后者） | 小 |
| D11 日志无轮转 | logger.js 改按天滚动文件（clipsync-YYYYMMDD.log）+ 启动时清理 N 天前旧文件；dev 环境保持 console | 小 |

---

## 五、运维集中化（用户指定方向，分两步）

### 第一步：管理台「运维监控」页（P2，纯应用层）

新增 admin 路由 `GET /api/admin/ops/overview`（聚合 health/ready/version/uptime/DB/Redis 状态 + 进程内存 + 近 1h 请求/错误率，数据全部来自已有 metrics 聚合器，无新采集器）+ 管理台新页面（复用 echarts）：

| 卡片 | 数据源 |
|---|---|
| 服务红绿灯 | /api/health、/api/ready（WP-C 修复后）、版本、uptime |
| 流量与错误 | 进程内 metrics（requests/errors/p95，近 1h 时序） |
| 慢查询 | 既有 /api/admin/slow-queries 表格化（P3-1 归位进 RBAC 后按 admin.audit.view 控权） |
| 日志级别 | system_configs 新键 `log_level`，logger.js 热生效 |
| 限流水位 | WP-A 的各 limiter 当前命中数（内存计数，可选） |

权限：新权限键 `admin.ops.view`（superAdminOnly），纳入方案二的权限目录（RBAC 工单联动）。

### 第二步：容器/集群层（P3，只读）

- **边界决策**：管理台是业务后台，**不做**容器操作 API（不是 k9s）。容器监控走 node-exporter + cAdvisor → Grafana「容器总览」仪表盘，管理台运维页放跳转链接（Grafana 匿名只读 share）
- **扩缩容**：k8s HPA 已存在（2-10 副本），管理台只读展示当前副本数（经 ops/overview 附带或跳转 Grafana），不做写操作
- **部署**：GitHub Actions 为唯一部署入口，管理台展示当前版本/启动时间（`/api/app/version` 已有）

---

## 六、WP-D：配置补全与清理（P2）

| 项 | 设计 | 修复缺陷 |
|---|---|---|
| SMTP 配置 | system_configs 新键组 `smtp_host/port/user/pass/from/secure`（pass 写入走加密，读出仅管理台脱敏显示）+ email.js 改读 config + 管理台「发送测试邮件」按钮；无配置时维持 console 兜底 | D9 |
| 注册总开关 | feature_flags 新键 `enable_signup`（关闭=注册接口直接 403"暂未开放注册"），与 signup_waitlist 正交：关闭 > 审核 > 开放；两端注册入口按其隐藏 | — |
| 审计归档任务 | db/cleanup.js 增加按 `audit_log_retention_days` 的删除任务（每日定时，先归档 CSV 到 backups/audit/ 再删），管理台系统参数卡片标注"已启用自动清理" | D3 |
| 备份可视化 | `GET /api/admin/ops/backups`：扫 backups 目录元数据（文件名/大小/时间/sha256 是否存在）+ 最近 sidecar 备份时间；管理台运维页一张卡片 | — |
| 死配置/死代码清理 | 删除：compose 的 ALLOWED_ORIGINS/MAX_FILE_SIZE/CSRF_SECRET 死变量、config.upload.maxImageSize/maxFileSize 死配置、requestTimeout ROUTE_TIMEOUTS 死表（保留 requestId）、auth.js 未用 strictLimiter 导入；nginx limit_req 恢复启用（api_limit 10r/s 兜底层） | D8 |
| 公告投递 | `GET /api/app/announcements`（按受众过滤 + once/persistent 语义）+ 两端横幅/弹窗 UI + 阅读回执（POST 已读，delivered_count 改真实触达） | D4 |
| 隐藏键暴露 | max_collection_depth、enable_audit_log 进 CONFIG_CATALOG（L3） | D12 |

---

## 七、兼容性与风险

1. **限流 fail-closed 方向**：featureFlags 故障时放行（功能可用性优先），runtimeLimits 故障时必须回退保守默认（安全优先）——两套缓存工具不共用，注释写明
2. **维护模式白名单**必须含 /api/admin/*（否则维护期间管理员无法关闭维护模式，死锁）与 /api/auth/refresh（已登录用户保活）
3. **WP-C 的 metrics 加鉴权**会破坏现有 Prometheus 抓取——必须同 PR 内改 monitoring/prometheus.yml 的 bearer_token，否则监控断数
4. **enable_signup 新键**默认 true（开放），升级零行为变化
5. 死变量删除会影响 dev 环境使用 Git Bash 起 docker 的习惯路径——删除前在 compose 注释中留一行迁移说明

---

## 八、实施顺序与依赖

```
WP-C（部署隐患，全部独立小改）          ← 最先，无依赖
WP-A（限流配置化）                     ← 依赖 WP-C 的 metrics 改动完成后一起验
WP-B（维护模式）                       ← 依赖功能开关 WS 广播链路（已上线）
WP-D（按 ticket 独立推进）
运维监控页第一步                       ← 依赖 WP-C(D5/D7) + WP-A
运维第二步（容器层只读）               ← 依赖第一步
```

详细任务拆分见 [../tickets/config-ops-tickets.md](../tickets/config-ops-tickets.md)。
