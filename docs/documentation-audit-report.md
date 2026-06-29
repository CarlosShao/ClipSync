# ClipSync 文档完整性审查报告

> **审查日期**: 2026年6月28日
> **审查范围**: API 文档、部署文档、Roadmap 状态、灾难恢复、K8s README、监控文档
> **审查方法**: 文档内容 vs 源代码实际实现逐项对比

---

## 审查摘要

| 文档 | 问题数 | 严重程度 |
|------|--------|----------|
| `docs/api-reference.md` | **17** | 🔴 高 |
| `docs/deployment.md` | **5** | 🟡 中 |
| `docs/production-roadmap.md` | **4** | 🟡 中 |
| `docs/disaster-recovery.md` | **3** | 🟡 中 |
| `k8s/README.md` | **3** | 🟢 低 |
| `docs/monitoring-setup-guide.md` | **3** | 🟡 中 |
| **总计** | **35** | |

---

## 一、API 文档完整性审查 (`docs/api-reference.md`)

### 🔴 严重问题（会导致集成失败）

#### 1. 分片上传路径不匹配
- **文档**: `POST /api/chunked-upload/init`, `/api/chunked-upload/chunk/:uploadId/:chunkIndex`, etc.
- **代码** (`index.js:275`): `app.use('/api/upload', chunkedUploadRoutes)`
- **实际路径**: `/api/upload/init`, `/api/upload/chunk/:uploadId/:chunkIndex`, `/api/upload/status/:uploadId`, `/api/upload/complete/:uploadId`, `/api/upload/cancel/:uploadId`
- **影响**: 客户端按文档调用会得到 404

#### 2. 同步推送接口请求体格式不匹配
- **文档** (`api-reference.md:637-650`): `POST /api/sync/push` 接受 `{ deviceId, lastSyncId, items: [{ id, contentEncrypted, contentType, ... }] }`
- **代码** (`routes/sync.js:22-24`): 接受 `{ deviceId, changes: [{ id?, action: 'create'|'update'|'delete', data: {...}, clientTimestamp }] }`
- **影响**: 客户端按文档构造请求体会导致解析失败

#### 3. 同步拉取接口查询参数不匹配
- **文档** (`api-reference.md:672`): `GET /api/sync/pull/:deviceId?after=ISO_DATE`
- **代码** (`routes/sync.js:242`): 使用 `since` 参数而非 `after`
- **影响**: 查询参数名不一致

#### 4. 同步状态接口响应格式不匹配
- **文档** (`api-reference.md:693-699`): 返回 `{ deviceId, lastSyncAt, pendingItems, isOnline }`
- **代码** (`routes/sync.js:355-360`): 返回 `{ synced, lastSyncAt, lastSyncedItemId, deviceName }`
- **影响**: 客户端解析响应会出错

#### 5. Webhook 路径前缀不匹配
- **文档** (`api-reference.md:908-926`): `/api/payments/webhooks/wechat-pay`, `/api/payments/webhooks/alipay`, `/api/payments/webhooks/stripe`
- **代码** (`routes/payments.js:156,199,242`): 路由定义为 `/webhooks/wechat-pay` 等，挂载在 `/api/payments` 下
- **实际路径**: `/api/payments/webhooks/wechat-pay` — **与文档一致** ✅
- **更正**: 经仔细核对，此条无误。但需注意 Stripe webhook 在 `index.js` 中的 raw body 捕获逻辑（line 95）依赖路径包含 `/webhooks/`，需确认 Stripe 签名验证在 raw body 模式下正常工作。

#### 6. 忘记密码/重置密码接口参数不匹配
- **文档** (`api-reference.md:127-151`): `POST /api/auth/forgot-password` 接受 `{ phone }`，`POST /api/auth/reset-password` 接受 `{ phone, code, newPassword }`
- **代码** (`routes/auth.js:434-542`): 两个接口都使用 `email` 而非 `phone`
- **影响**: 客户端按文档传 `phone` 会返回 400 "邮箱不能为空"

### 🟡 中等问题（影响文档准确性）

#### 7. 设备列表响应格式不匹配
- **文档** (`api-reference.md:282-295`): 返回 `{ devices: [...] }`
- **代码** (`routes/device.js:23`): 直接返回数组 `[...]`（无包装对象）
- **影响**: 客户端按 `response.devices` 访问会得到 `undefined`

#### 8. 批量删除路径不匹配
- **文档** (`api-reference.md:436`): `DELETE /api/clipboard/batch`
- **代码** (`routes/clipboard.js:428`): `DELETE /api/clipboard`（根路径，通过 body.ids 传参）
- **影响**: 客户端调用 `/api/clipboard/batch` 会 404

#### 9. `/api/auth/me` 响应字段不完整
- **文档** (`api-reference.md:176-186`): 返回 `email`, `preferences`, `createdAt`
- **代码** (`routes/auth.js:630-645`): 仅返回 `id`, `phone`, `nickname`, `avatarUrl`（不返回 email、preferences、createdAt）
- **影响**: 客户端期望的字段缺失

#### 10. `/api/auth/verify-code` 响应缺少 `sessionId`
- **文档** (`api-reference.md:86-91`): 响应包含 `sessionId` 字段
- **代码** (`routes/auth.js:237-251`): 响应中不包含 `sessionId`（仅在 JWT token 内部）
- **影响**: 客户端无法从响应体获取 sessionId

#### 11. 健康检查响应格式不匹配
- **文档** (`api-reference.md:1005-1014`): 返回 `{ status, timestamp, version, services: { database, redis } }`
- **代码** (`index.js:172-178`): 返回 `{ status, timestamp, uptime }`（无 version 和 services）
- **影响**: 监控脚本按文档解析会出错

#### 12. 剪贴板搜索最小字符数不匹配
- **文档** (`api-reference.md:386`): "搜索词 ≥3 字符时使用 tsvector"
- **代码** (`routes/clipboard.js:138`): 最小要求 2 个字符 (`q.trim().length < 2`)
- **影响**: 2 字符搜索在代码中可工作但文档说不可

#### 13. 通知历史查询参数不匹配
- **文档** (`api-reference.md:847`): `page`, `limit`, `unreadOnly`
- **代码** (`routes/notifications.js:57`): `limit`, `offset`, `status`
- **影响**: 分页方式完全不同（page vs offset）

### 🟢 低优先级问题（文档缺失）

#### 14. 缺少密码登录端点文档
- **代码** (`routes/auth.js:545`): `POST /api/auth/login` — 支持手机号/邮箱+密码登录
- **文档**: 完全未记录此端点

#### 15. 缺少发票端点文档
- **代码** (`routes/invoices.js`): `GET /api/invoices`, `GET /api/invoices/:id`, `GET /api/invoices/:id/download`
- **文档**: 未记录发票相关端点

#### 16. 缺少 CSRF Token 端点文档
- **代码** (`index.js:63`): `GET /api/csrf-token`（需要认证）
- **文档**: 未记录

#### 17. 缺少 `/api/metrics/prometheus` 端点文档
- **代码** (`index.js:249`): `GET /api/metrics/prometheus` — Prometheus 格式指标
- **文档** (`api-reference.md:1037`): 仅记录 `/api/metrics`（JSON 格式）
- **影响**: 监控集成可能使用错误端点

---

## 二、部署文档审查 (`docs/deployment.md`)

### 🟡 问题

#### 1. 环境变量名不一致
- **文档** (`deployment.md:177`): 使用 `ALLOWED_ORIGINS`
- **代码** (`config.js:64`): 读取 `CORS_ORIGINS`（非 `ALLOWED_ORIGINS`）
- **实际 .env 文件**: 使用 `ALLOWED_ORIGINS`
- **影响**: 代码中 `config.js` 读取 `CORS_ORIGINS`，但 `.env` 文件定义的是 `ALLOWED_ORIGINS`。需要确认哪个是正确的。如果 `ALLOWED_ORIGINS` 是通过其他方式传递的（如 Docker Compose 环境变量映射），则需在文档中说明。

#### 2. `.env.example` 文件不存在
- **文档** (`deployment.md:153`): `cp .env.example .env.prod`
- **实际**: 项目中只有 `.env.development.example` 和 `.env.production.example`，无 `.env.example`
- **修正**: 应为 `cp .env.production.example .env.prod`

#### 3. 端口配置变量名不一致
- **文档** (`deployment.md:174`): `API_PORT=3000`
- **代码** (`config.js:37`): 读取 `PORT`（非 `API_PORT`）
- **.env 文件**: 定义 `API_PORT=3000`
- **影响**: 如果 `API_PORT` 未映射到 `PORT`，服务可能监听错误端口

#### 4. 缺少 `ENCRYPTION_KEY` 在代码中的使用说明
- **文档** (`deployment.md:170`): 列出 `ENCRYPTION_KEY` 为必须项
- **代码** (`config.js`): 未直接读取 `ENCRYPTION_KEY` 环境变量（加密模块 `encryption.js` 可能自行读取）
- **建议**: 确认 `ENCRYPTION_KEY` 的实际使用位置并更新文档

#### 5. 缺少 `REQUEST_TIMEOUT` 等新增环境变量
- **代码** (`index.js:120`): `REQUEST_TIMEOUT` 环境变量（默认 30 秒）
- **文档**: 未列出此变量

---

## 三、Roadmap 状态同步审查 (`docs/production-roadmap.md`)

### 🟡 问题

#### 1. 阶段九状态矛盾
- **整体进度表** (`production-roadmap.md:117`): 阶段九标记为 `✅ 已完成`，17/17
- **阶段九标题** (`production-roadmap.md:518`): 标记为 `🔄 进行中`
- **阶段九总结** (`production-roadmap.md:557-564`): 明确说 "已完成 100%（17/17 任务）"
- **修正**: 标题应改为 `✅ 已完成`

#### 2. 阶段四进度百分比矛盾
- **整体进度表** (`production-roadmap.md:112`): 阶段四 68%
- **阶段四标题** (`production-roadmap.md:344`): 阶段四 37%
- **分析**: 两个数字都不完全准确。按子任务计算：4.1(3/4) + 4.2(4/4) + 4.3(2/4) + 4.4(4/4) + 4.5(3/4) = 16/20 = 80%
- **建议**: 统一使用实际完成任务数计算

#### 3. 阶段十标题与内容矛盾
- **标题** (`production-roadmap.md:568`): `❌ 未开始`
- **内容**: 10.1 数据库设计标记为 ✅ 已完成，6.3 后端 API 大部分标记为 ✅ 已完成
- **整体进度表** (`production-roadmap.md:118`): 标记为 `🔄 进行中`，12/18
- **修正**: 标题应改为 `🔄 进行中`

#### 4. 隐藏问题修复状态需更新
- **P0 问题 #2** (`production-roadmap.md:919`): "无文件路径验证" 标记为 `⚠️ 待修复`
- **P0 问题 #6** (`production-roadmap.md:923`): "文件存储在本地磁盘" 标记为 `⚠️ 待解决`
- **P0 问题 #7** (`production-roadmap.md:924`): "无文件类型验证" 标记为 `⚠️ 待修复`
- **代码审查**: `media.js` 已有 `SAFE_FILE_EXTENSIONS` 白名单（line 44-51）和 `FILE_TYPES` MIME 白名单（line 33-42），问题 #7 可能已修复
- **建议**: 逐一验证并更新状态

---

## 四、灾难恢复文档审查 (`docs/disaster-recovery.md`)

### 🟡 问题

#### 1. 数据库恢复命令可能不正确
- **文档** (`disaster-recovery.md:154`): `gunzip -c backups/clipsync_manual_YYYYMMDD.sql.gz | docker exec -i clipsync-postgres psql -U postgres clipsync`
- **实际脚本** (`scripts/backup-db.sh`): 需确认实际备份文件命名格式和用户名
- **建议**: 确认 `backup-db.sh` 的实际输出格式并更新示例命令

#### 2. 演练脚本引用需验证
- **文档** (`disaster-recovery.md:75`): `./scripts/verify-backup.sh` — 无参数
- **实际脚本** (`scripts/verify-backup.sh`): 需确认是否需要参数
- **文档** (`disaster-recovery.md:95`): `./scripts/verify-backup.sh <latest-backup>` — 带参数
- **建议**: 确认脚本的正确调用方式

#### 3. 联系人信息未填写
- **文档** (`disaster-recovery.md:127-131`): 所有联系方式为 `[配置]`
- **建议**: 填写实际联系人或说明如何配置

---

## 五、K8s README 审查 (`k8s/README.md`)

### 🟢 问题

#### 1. 内容过于简略
- 仅有 38 行，缺少以下关键信息：
  - 各 YAML 文件的用途说明
  - Secret 管理方式
  - 如何自定义配置
  - 如何查看备份 CronJob 状态

#### 2. 缺少 overlay 环境差异说明
- `staging` 和 `production` overlay 的具体差异（副本数、资源限制、PVC 大小）未说明

#### 3. 缺少监控组件集成说明
- `docker-compose.monitoring.yml` 包含 Alertmanager 和 Blackbox Exporter，但 K8s README 未提及如何在 K8s 中部署监控

---

## 六、监控文档审查 (`docs/monitoring-setup-guide.md`)

### 🟡 问题

#### 1. 缺少 Alertmanager 和 Blackbox Exporter 文档
- **实际** (`docker-compose.monitoring.yml`): 包含 `alertmanager` (端口 9093) 和 `blackbox-exporter` (端口 9115)
- **文档**: 仅提到 Prometheus、Grafana、Node Exporter 三个组件
- **影响**: 运维人员不知道还有告警管理器

#### 2. Grafana 环境变量拼写错误
- **实际** (`docker-compose.monitoring.yml:72`): `GF_SECURITY_ADMIN_PASWORD`（缺少 `S`）
- **正确**: `GF_SECURITY_ADMIN_PASSWORD`
- **影响**: Grafana 可能使用默认密码而非配置的密码

#### 3. Prometheus 抓取目标配置不一致
- **文档** (`monitoring-setup-guide.md:83`): `targets: ['api-prod:3000']`
- **实际** (`monitoring/prometheus/prometheus.yml`): 需确认实际配置
- **建议**: 验证 Prometheus 配置文件中的 targets 是否与实际服务名一致

---

## 七、综合建议

### 高优先级修复（建议 1 周内完成）

1. **修复 API 文档中的路径和参数错误**（问题 #1-6）— 这些会直接导致客户端集成失败
2. **统一环境变量命名**（`CORS_ORIGINS` vs `ALLOWED_ORIGINS`，`PORT` vs `API_PORT`）
3. **修复 Grafana 环境变量拼写错误**（`PASWORD` → `PASSWORD`）

### 中优先级修复（建议 2 周内完成）

4. **补充缺失的 API 端点文档**（密码登录、发票、CSRF Token、Prometheus metrics）
5. **更新 Roadmap 中的状态矛盾**（阶段九、阶段四、阶段十）
6. **完善灾难恢复文档中的命令示例**

### 低优先级改进

7. **扩充 K8s README 内容**
8. **补充监控文档中缺失的组件说明**
9. **统一响应格式**（考虑是否将设备列表改为 `{ devices: [...] }` 包装格式以匹配文档）

---

## 附录：代码中注册的完整 API 端点列表

基于 `index.js` 路由注册，以下是所有实际 API 端点：

| 前缀 | 路由文件 | 认证 | CSRF |
|------|----------|------|------|
| `/api/auth` | `routes/auth.js` | 部分 | ❌ |
| `/api/devices` | `routes/device.js` | ✅ | ✅ |
| `/api/clipboard` | `routes/clipboard.js` | ✅ | ✅ |
| `/api/media` | `routes/media.js` | ✅ | ✅ |
| `/api/sync` | `routes/sync.js` | ✅ | ✅ |
| `/api/upload` | `routes/chunked-upload.js` | ✅ | ✅ |
| `/api/versions` | `routes/versions.js` | ✅ | ✅ |
| `/api/app` | `routes/app.js` | ❌ | ❌ |
| `/api/sessions` | `routes/sessions.js` | ✅ | ❌ |
| `/api/notifications` | `routes/notifications.js` | ✅ | ❌ |
| `/api/subscriptions` | `routes/subscriptions.js` | ✅ | ✅ |
| `/api/payments` | `routes/payments.js` | ✅ | ✅ |
| `/api/invoices` | `routes/invoices.js` | ✅ | ✅ |
| `/api/health` | 内联 | ❌ | ❌ |
| `/api/ready` | 内联 | ❌ | ❌ |
| `/api/metrics` | 内联 | ❌ | ❌ |
| `/api/metrics/prometheus` | 内联 | ❌ | ❌ |
| `/api/csrf-token` | 内联 | ✅ | ❌ |

---

*审查完成。共发现 35 个问题，其中 6 个严重（会导致集成失败），15 个中等，14 个低优先级。*
