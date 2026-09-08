# 工单：配置能力补全与运维集中化（方案三落地）

- **方案**：[../design-proposals/admin-config-ops-enhancement.md](../design-proposals/admin-config-ops-enhancement.md)
- **缺陷来源**：[../../audit/admin-config-audit-2026-09-07.md](../../audit/admin-config-audit-2026-09-07.md)（D1-D12）
- **状态标记**：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞

---

## WP-C 部署级隐患修复（P1，最先做，无依赖）

> 2026-09-08 全量盘点回写：本节 ✅（CO-03 实现用 METRICS_TOKEN bearer 方案替代 JWT+角色，Prometheus 带 token 抓取，功能等价）

### CO-01 修复 /api/ready 恒 503 ✅ P1
- **缺陷**：D5
- **改动**：`src/server/src/index.js:286` `config.upload.dir` 加 `|| './uploads'` 兜底（对齐 routes/health.js:73 写法）
- **验收**：`GET /api/ready` 返回 200 且 filesystem:true；k8s readinessProbe 场景演练（k8s\base\api.yaml:82-89 指向它）

### CO-02 修复 Prometheus 告警指标失配 ✅ P1
- **缺陷**：D6
- **改动**：
  1. `monitoring/prometheus/rules/clipsync-alerts.yml`：5 条应用层规则指标名对齐实际导出（clipsync_requests_total / clipsync_errors_total / clipsync_response_time_seconds）
  2. WS 连接数：`src/server/src/middleware/metrics.js` 补 `clipsync_ws_connections` gauge（ws/server.js 连接/断开时增减），对应规则改用它；或删除该条规则（二选一，倾向补 gauge）
- **验收**：Prometheus targets 页无告警规则解析错误；人工触发一次 500 后 HighErrorRate 告警经 feishu-webhook 到达飞书群

### CO-03 metrics 端点加鉴权 ✅ P1
- **缺陷**：D7
- **改动**：`src/server/src/index.js:308-312` 两个 metrics 端点挂 authenticateToken + requireRole(50)；删除死代码 `src/server/src/routes/metrics.js`（index.js:63 死导入一并删）；`monitoring/prometheus/prometheus.yml` 抓取任务配 bearer_token（**与上一条同 PR，否则断数**）
- **依赖**：与 CO-02 同 PR
- **验收**：无 token 请求 /api/metrics → 401；带 Prometheus token 抓取正常

### CO-04 日志按天轮转 ✅ P1
- **缺陷**：D11
- **改动**：`src/server/src/utils/logger.js` 生产文件输出改 `clipsync-YYYYMMDD.log` + 启动时清理 14 天前旧文件
- **验收**：模拟跨天产生两个日志文件；旧文件被清理

---

## WP-A 限流配置化（P1）

> 2026-09-08 回写：本节 ✅（CO-12 nginx 仅剩一处 active limit_req 单 zone；限流计数桶共享缺陷已另行修复，见 CO-52）

### CO-10 运行时限流阈值读取层 ✅ P1
- **改动**：新增 `src/server/src/utils/runtimeLimits.js`（读 system_configs + 5s 缓存 + **失败回退硬编码默认值**，fail-closed 方向，注释写明与 featureFlags 的区别）；`src/server/src/middleware/rateLimiter.js` 四个 limiter 阈值改动态读取
- **验收**：改库后 ≤5s 生效；system_configs 不可达时限流按默认值继续工作

### CO-11 新增限流 config 键 + 管理台卡片 ✅ P1
- **改动**：
  1. 迁移 050：`rate_limit_api_per_min=300`、`rate_limit_send_code_per_hour=5`、`rate_limit_login_failed_per_15min=5`、`rate_limit_upload_per_min=20`、`rate_limit_disabled=false` 入 CONFIG_CATALOG（configs.js:42-68）
  2. `rate_limit_disabled=true` 时 PATCH 在 production 拒绝（configs.js 写路径校验 NODE_ENV）
  3. admin-console 系统设置页新增「限流配置」卡片（InputNumber，对齐现有四卡模式）
- **依赖**：CO-10
- **验收**：管理台改阈值→5s 生效→改回；audit 记录 admin.config.update

### CO-12 限流器补挂 + 死变量清理 ✅ P1
- **改动**：
  1. uploadLimiter 挂 /api/upload、chunked-upload；strictLimiter 挂 /auth/register、/auth/change-password、/auth/forgot-password
  2. 删除 docker-compose.dev.yml:102 `DISABLE_RATE_LIMIT` 死变量（注释留迁移说明）
  3. nginx limit_req 恢复启用（nginx/conf.d/clipsync.conf:41,59 去注释）
- **依赖**：CO-11
- **验收**：压测 /api/upload 触发 429；dev 重启后限流仍生效（此前 DISABLE_RATE_LIMIT 无效但注释误导）

---

## WP-B 维护模式落地（P1）

> 2026-09-08 回写：✅。盘点曾发现 CO-20 拦截范围缺口（guard 仅挂 /api/upload），已补齐：clipboard/media/sync 挂载链 + /ws 握手拒绝（ws.close 4003）；CO-21/22 文案与行为已对齐

### CO-20 服务端维护强制中间件 ✅ P1
- **改动**：
  1. 新增 `src/server/src/middleware/maintenance.js`：读 system_configs.maintenance_mode（5s 缓存），开启时对 /api/clipboard、/api/sync、/api/media、/api/upload、/api/ws 返回 503 `{ error:'系统维护中', maintenance:true }`；白名单 /api/auth/*、/api/admin/*、/api/health、/api/ready、/api/app/*
  2. configs.js 维护模式 PATCH 成功后 broadcastToAllClients({ type:'maintenance.updated', mode, message })
  3. 新增公开端点 `GET /api/app/maintenance`
- **验收**：开启后剪贴板同步 503、登录/管理台/健康检查不受影响；关闭后 ≤5s 恢复；**白名单缺失管理台 = 死锁，必须测**

### CO-21 客户端维护横幅 ✅ P1
- **改动**：桌面端 App.vue/HomeView 监听 maintenance.updated + 启动拉 /api/app/maintenance → 全屏横幅 + 暂停自动同步；移动端 FeatureFlagsProvider 同款 → MaterialBanner + 停采集
- **依赖**：CO-20
- **验收**：两端横幅即时出现/消失（WS）；旧版客户端收 503 走既有错误提示

### CO-22 管理台文案对齐 ✅ P1
- **改动**：settings/index.tsx MAINTENANCE_HINT 改为真实行为描述（拦截范围+白名单）
- **依赖**：CO-20

---

## WP-D 配置补全与清理（P2）

> 2026-09-08 回写：CO-30/31/32/35/36 ✅（偏离备注见各项）；CO-33 ✅（本轮补齐）；CO-34 清理进行中（multi.yml 死变量 + requestTimeout 死导入，Wave B 收尾）

### CO-30 SMTP 配置化 ✅ P2（补「发送测试邮件」端点+按钮，本轮完成）
- **改动**：system_configs 新键组 smtp_host/port/user/pass/from/secure（pass 加密存、管理台脱敏显示）+ `utils/email.js` 改读 + 管理台「发送测试邮件」按钮；无配置维持 console 兜底
- **验收**：配置真实 SMTP 后邮箱验证码可达；清空配置回退 console

### CO-31 注册总开关 enable_signup ✅ P2（移动端无独立注册入口：注册表键 nav.signup 落位 + 服务端 403 兜底，如实记录）
- **改动**：feature_flags 新键（默认 true）+ 注册路由 403 守卫 + FLAG_CATALOG/CLIENT_FLAG_KEYS 纳入 + 两端注册入口隐藏 + 快照测试脚本加断言
- **验收**：关闭后注册接口 403、两端注册入口消失、登录不受影响；恢复正常

### CO-32 审计归档任务 ✅ P2（归档目录有意偏离：logs/audit-archive/（容器内已挂载），非 backups/audit/）
- **改动**：db/cleanup.js 增加 audit_log 按 `audit_log_retention_days` 的先归档（CSV → backups/audit/）后删除任务；系统参数卡片标注启用状态
- **验收**：插入过期测试日志 → 任务跑完归档文件存在、行被删

### CO-33 备份可视化 ✅ P2（本轮补齐：GET /api/admin/ops/backups + 运维页「备份概览」卡；全仓无 sidecar 机制故未读，未臆造）
- **改动**：`GET /api/admin/ops/backups`（扫 backups/ 元数据 + sidecar 最近备份）+ 运维页卡片
- **依赖**：运维页骨架（CO-41）

### CO-34 死配置/死代码清理 ✅ P2（2026-09-08 收尾：multi.yml CSRF_SECRET/ALLOWED_ORIGINS 两处已删；requestTimeout/ROUTE_TIMEOUTS 死代码剔除（文件重命名为 request-id.js，仅保留 requestId）；dev.yml/maxFileSize/strictLimiter 此前已清）
- **改动**：删 compose ALLOWED_ORIGINS/MAX_FILE_SIZE/CSRF_SECRET 死变量；删 config.upload.maxImageSize/maxFileSize 死配置；删 requestTimeout ROUTE_TIMEOUTS 死表（保留 requestId）；删 auth.js 未用 strictLimiter 导入
- **验收**：全量测试通过（这些删除不影响运行时行为）

### CO-35 公告投递链路 ✅ P2（语义偏离如实记录：delivered_count 保留"受众数"，真实触达由新增 read_count/click_count 承载（迁移 052 回执表，管理台两数并列）；桌面端公告横幅+弹窗本轮补齐。⚠️ 2026-09-08 二次修复：`GET /api/app/announcements`（optionalAuth 受众过滤）与 `POST /api/app/announcements/:id/read`（幂等回执）一度被工作树回写事件删除，已重建并通过 run-audit announce 阶段）
- **改动**：`GET /api/app/announcements`（受众过滤 + once/persistent）+ 两端 UI + 已读回执（delivered_count 改真实触达）
- **依赖**：建议在方案一菜单基建后做（复用横幅组件）
- **验收**：管理台发公告→两端可见→已读数准确

### CO-36 隐藏配置键暴露 ✅ P2（本轮补齐：CONFIG_CATALOG 进 max_collection_depth/enable_audit_log；038 种子实际值 '5'，未虚构默认值）
- **改动**：max_collection_depth、enable_audit_log 进 CONFIG_CATALOG
- **验收**：管理台可见可改可审计

---

## 运维监控页（P2/P3，用户指定方向）

> 2026-09-08 回写：CO-40 迁移实际落 052（051 被 CO-31 占用）；CO-41 偏离如实记录（日志级别下拉在设置页、趋势为页面本地采样、慢查询三列）；CO-42 本轮补齐管理台跳转 + k8s 部署形态字段（dev 无 K8s，replicas 返回 null；OCR/功能立项后挂墙记录于 planFeature.js 注释）

### CO-40 ops overview 聚合端点 ✅ P2
- **改动**：`GET /api/admin/ops/overview`（health/ready/version/uptime/DB/Redis/进程内存/近 1h 请求错误率，全来自既有 metrics）+ 新权限键 `admin.ops.view`（superAdminOnly，迁移 051，PERM_CATALOG + 前端镜像同步）
- **依赖**：CO-01、CO-03（ready 修复 + metrics 鉴权）
- **验收**：无 admin.ops.view 的自定义角色 403

### CO-41 管理台运维监控页 ✅ P2
- **改动**：admin-console 新页面（红绿灯卡片/时序图 echarts/慢查询表格/日志级别下拉写 system_configs.log_level + logger.js 热生效/限流水位可选）+ 导航项（按 admin.ops.view 裁剪，联动方案二工单 RB-14）
- **依赖**：CO-40
- **验收**：页面数据与 docker stats/真实错误率交叉一致

### CO-42 容器层只读接入 ✅ P3（本轮补齐：ops/overview 附 deployment {type,replicas}（仅 K8s 部署时可用，dev 返回 docker-compose）+ 运维页「部署形态」卡 + Grafana 只读跳转（VITE_GRAFANA_URL 兜底）；cAdvisor + containers-overview.json 仪表盘此前已在 monitoring 栈）
- **改动**：monitoring 栈加 cAdvisor + Grafana「容器总览」仪表盘；管理台运维页放只读跳转；ops/overview 附带 k8s 副本数（仅 k8s 部署时可用）
- **依赖**：CO-41
- **边界**：不做容器写操作/扩缩容写操作/触发部署

---

## 验收总口径

- 每工单完成后运行 `scripts/admin-full-audit/run-audit.mjs` 全绿 + 按工单验收项单测/手测
- 涉及迁移的工单（CO-11/31/32/36/40）迁移号递增且 migrate 链可重复执行
- 管理台改动同步 mocks/handlers 契约测试（对齐 admin-console-v1 惯例）

---

## 工单外补账（2026-09-08 盘点补录，均为已完成项）

### CO-50 系统参数页分组重构 ✅
- **背景**：用户反馈系统参数无分类、限流卡独立保存与其他配置单按钮割裂
- **改动**：settings/index.tsx 按 PARAM_GROUPS 分组为独立 Card，每卡右上角独立保存（仅提交本卡 keys，记入审计）；新增「第三方登录」预留卡片（GitHub/微信/Apple OAuth 配置占位，标注「规划中 · 未实现」，仅防遗忘）

### CO-51 限流计数桶共享修复 ✅
- **背景**：发送验证码按钮变灰（限流误触发）——多个 limiter 共享计数桶导致互相污染
- **改动**：middleware/rateLimiter.js 计数桶按 limiter 隔离；dev 固定码链路清理旧记录

### CO-52 环境级修复：wslrelay IPv6 黑洞 ✅
- **背景**：wslrelay.exe 抢占 [::1]:3001，localhost 解析 ::1 进入转发黑洞（2026-09-07 登录转圈事故）
- **改动**：desktop/admin-console 全部 localhost:3001 引用改 127.0.0.1；configStore 默认 server_url 与历史值迁移；admin-console vite `host: true` 双栈监听（SSO 外链 IPv4/IPv6 均可达）；桌面端管理台外链 hostname 强制 localhost（浏览器双栈回退）
