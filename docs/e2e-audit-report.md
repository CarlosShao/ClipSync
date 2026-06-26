# ClipSync E2E 全流程审计报告

> 生成时间：2026-06-23
> 审计方式：代码级逐流程审查（Docker未运行，无法执行实际测试）

---

## 一、用户认证流程

### 1.1 发送验证码 → 登录 → 获取用户信息

**流程**：POST /api/auth/send-code → POST /api/auth/verify-code → GET /api/auth/me

**验证结果**：
- ✅ 发送验证码：手机号格式验证、输入清理、速率限制
- ✅ 验证码登录：验证码有效性检查（未使用+未过期）、标记已使用、首次登录自动注册
- ✅ JWT生成和返回：token有效期可配置
- ✅ 密码登录：bcrypt密码验证
- ✅ 获取用户信息：认证中间件保护
- ✅ 更新用户资料：昵称长度和字符验证

**发现的问题**：
- ⚠️ CSRF保护对auth路由无效（authenticateToken在CSRF中间件之后运行，userId未设置导致CSRF跳过）→ **已修复**：将CSRF中间件移到authenticateToken之后

### 1.2 CSRF令牌流程

**流程**：GET /api/csrf-token → 在POST/PUT/DELETE请求中携带X-CSRF-Token

**发现的问题**：
- ⚠️ CSRF令牌为**单次使用**（validateCsrfToken验证后立即删除），客户端每次写操作前需重新获取 → 这是一个设计选择，不是bug
- ⚠️ CSRF存储为内存Map，生产环境应迁移到Redis → 已有注释说明

---

## 二、设备管理流程

### 2.1 注册设备 → 查看设备 → 更新设备 → 删除设备

**流程**：POST /api/devices → GET /api/devices → PUT /api/devices/:id → DELETE /api/devices/:id

**验证结果**：
- ✅ 设备注册：必填字段验证、设备名长度检查、重名检查（409冲突）、设备类型和平台白名单验证
- ✅ 设备列表：按last_seen_at排序
- ✅ 设备更新：可选字段更新
- ✅ 设备删除：广播删除事件给其他设备
- ✅ 自动创建device_sync_state

**潜在问题**：
- ⚠️ devices表的`device_type` CHECK约束包含`tablet`，但validator.js中`isValidDeviceType`也包含`browser`，两者不一致
- → 需要修复：migrate.js中devices表的CHECK约束应包含`browser`

---

## 三、剪贴板同步流程

### 3.1 创建剪贴板项 → 拉取列表 → 获取单项 → 收藏 → 删除

**流程**：POST /api/clipboard → GET /api/clipboard → GET /api/clipboard/:id → PUT /api/clipboard/:id/favorite → DELETE /api/clipboard/:id

**验证结果**：
- ✅ 创建项：contentEncrypted必填验证、大小限制(10MB)、内容类型自动检测、设备归属验证
- ✅ 拉取列表：分页、类型筛选、收藏筛选、ILIKE模糊搜索
- ✅ 获取单项：返回加密内容
- ✅ 收藏切换：广播收藏变更
- ✅ 删除单项：广播删除事件
- ✅ 批量删除：最多100条、ID格式验证

**发现的问题**：
- ❌ `clipboard_items`表缺少`updated_at`列，但sync.js和versionManager.js引用了它 → **已修复**：在migrate.js中添加了`updated_at`字段

---

## 四、媒体上传流程

### 4.1 图片上传 → 预览 → 下载 → 删除

**流程**：POST /api/media/image → GET /api/media/:id/preview → GET /api/media/:id/download → DELETE /api/media/:id

**验证结果**：
- ✅ 图片上传：multer multipart处理、sharp压缩（自适应PNG/WebP/JPEG）、缩略图生成(150x150)、设备验证
- ✅ 图片预览：优先返回缩略图、回退到原图、Cache-Control设置
- ✅ 文件下载：Range请求支持(206 Partial Content)、Content-Disposition设置
- ✅ 删除媒体：物理文件和DB记录同时删除
- ✅ 文件上传：类型白名单检查、扩展名验证

**未实现功能**：
- ⏳ 文本/代码文件预览端点未实现（仅支持图片预览）
- ⏳ PDF预览为V2规划

---

## 五、离线同步流程

### 5.1 Push离线队列 → Pull同步数据 → 同步状态

**流程**：POST /api/sync/push → GET /api/sync/pull/:deviceId → GET /api/sync/status/:deviceId

**验证结果**：
- ✅ Push：事务处理（BEGIN/COMMIT/ROLLBACK）、create/update/delete三种action、冲突检测
- ✅ 冲突解决：客户端timestamp < 服务端updated_at → 返回conflict状态和服务端数据
- ✅ Pull：since参数增量同步、无since参数全量同步、sync state自动更新
- ✅ 同步状态：返回lastSyncAt和lastSyncedItemId

**发现的问题**：
- ❌ `clipboard_items`表缺少`updated_at`列 → 冲突检测会报数据库错误 → **已修复**
- ⚠️ sync/pull查询中使用`NOT IN`子查询过滤device_id，逻辑可能不准确（应按user_id过滤，不应排除已同步item对应的device_id）

---

## 六、分片上传流程

### 6.1 Init → Upload Chunk → Status → Complete/Cancel

**流程**：POST /api/upload/init → POST /api/upload/chunk/:uploadId/:chunkIndex → GET /api/upload/status/:uploadId → POST /api/upload/complete/:uploadId

**验证结果**：
- ✅ 初始化：uploadId生成、会话管理、24小时过期
- ✅ 上传分片：用户身份验证、分片索引范围检查
- ✅ 状态查询：已上传和缺失分片列表、进度计算
- ✅ 完成合并：所有分片检查、合并写入DB、清理临时文件
- ✅ 取消上传：清理临时文件和会话
- ✅ 过期清理：每小时自动清理过期会话

**潜在问题**：
- ⚠️ uploadSessions为内存Map，重启后丢失 → 生产环境应迁移到Redis
- ⚠️ 完成合并时sourceDeviceId默认为'unknown'，应从init时携带或从body获取

---

## 七、版本管理流程

### 7.1 创建版本 → 查看历史 → 查看详情 → 恢复版本 → 统计 → 清理

**流程**：POST /api/versions → GET /api/versions/:clipboardItemId → GET /api/versions/detail/:versionId → POST /api/versions/restore/:versionId → GET /api/versions/stats/overview → POST /api/versions/cleanup

**验证结果**：
- ✅ 创建版本：自动版本号递增、事务保护
- ✅ 查看历史：分页、关联设备信息
- ✅ 恢复版本：更新clipboard_items + 创建新版本记录
- ✅ 统计信息：总版本数、有版本的项数、大小统计
- ✅ 清理：按时间和数量两种策略清理

**发现的问题**：
- ❌ `file_versions`表未在migrate.js中定义 → 所有版本操作会报数据库错误 → **已修复**
- ❌ `clipboard_items`表缺少`updated_at`列 → restoreVersion中的`SET updated_at = NOW()`会报错 → **已修复**
- ⚠️ file_versions UNIQUE约束(clipboard_item_id, version_number)依赖并发控制，高并发下可能冲突

---

## 八、WebSocket实时同步流程

### 8.1 连接 → 注册设备 → 剪贴板广播 → 心跳 → 断开

**流程**：ws://host:port/ws?token=JWT → {type: 'register', deviceId} → {type: 'clipboard', ...} → {type: 'ping'} → disconnect

**验证结果**：
- ✅ JWT认证：从query参数或header获取token
- ✅ 设备注册：验证设备归属、更新在线状态、存储连接
- ✅ 剪贴板广播：仅转发给同用户其他设备
- ✅ 心跳机制：ping/pong + 定时检查 + 超时断开
- ✅ 断开处理：删除连接、更新离线状态
- ✅ 用户级广播：broadcastToUser、sendNotification

**潜在问题**：
- ⚠️ connections为内存Map，重启后所有WebSocket连接丢失 → 生产环境需要Redis pub/sub
- ⚠️ WebSocket连接限流(wsConnectionLimiter)未被实际调用

---

## 九、安全防护流程

### 9.1 认证保护 → 速率限制 → 输入验证 → 安全头

**验证结果**：
- ✅ 认证中间件：Bearer token验证、过期和无效token区分
- ✅ 速率限制：API(100/min)、验证码(5/hour)、登录(5/15min)
- ✅ 输入验证：手机号/UUID/内容类型/设备类型/平台/分页/搜索
- ✅ XSS防护：sanitizeString HTML实体编码
- ✅ SQL注入防护：所有查询使用参数化
- ✅ 安全响应头：X-Frame-Options、X-Content-Type-Options、X-XSS-Protection、Referrer-Policy、Permissions-Policy、HSTS(生产)
- ✅ CORS：开发环境全开放、生产环境白名单

**已修复的问题**：
- ✅ CSRF保护中间件顺序修正（authenticateToken → csrfProtection）

---

## 十、系统运维流程

### 10.1 健康检查 → 指标 → Prometheus → 优雅关闭

**验证结果**：
- ✅ 健康检查：DB连接检测、内存使用、版本信息
- ✅ JSON指标：请求计数、方法分布
- ✅ Prometheus格式：text/plain格式输出
- ✅ 优雅关闭：SIGTERM/SIGINT → HTTP关闭 → WS关闭 → DB池关闭 → 10秒超时强制退出
- ✅ 过期清理：定期清理expired clipboard items
- ✅ 未捕获异常处理

---

## 发现的Bug汇总（已修复）

| # | Bug | 严重级别 | 影响 | 修复 |
|---|-----|---------|------|------|
| 1 | clipboard_items缺少updated_at列 | 🔴 严重 | sync冲突检测和版本恢复会报数据库错误 | ✅ 已在migrate.js添加updated_at |
| 2 | file_versions表未定义 | 🔴 严重 | 所有版本管理操作会报数据库错误 | ✅ 已在migrate.js添加file_versions表 |
| 3 | CSRF保护对认证路由无效 | 🟠 高 | 所有写操作的CSRF保护被跳过 | ✅ 已调整中间件顺序 |

## 发现的潜在问题（未修复，需关注）

| # | 问题 | 严重级别 | 建议 |
|---|------|---------|------|
| 1 | devices表CHECK约束不含'browser' | 🟡 中 | migrate.js devices的CHECK约束应包含'browser' |
| 2 | uploadSessions内存存储 | 🟡 中 | 生产环境迁移到Redis |
| 3 | connections内存存储 | 🟡 中 | 生产环境迁移到Redis pub/sub |
| 4 | csrfTokens内存存储 | 🟡 中 | 生产环境迁移到Redis |
| 5 | WebSocket限流未被调用 | 🟡 中 | ws/server.js应调用checkWsConnectionLimit |
| 6 | sync/pull的NOT IN子查询逻辑 | 🟡 中 | 需重新设计过滤条件 |
| 7 | chunked-upload完成时sourceDeviceId默认unknown | 🟢 低 | 应从init或complete body获取 |
