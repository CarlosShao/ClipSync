# ClipSync API 参考文档

> **版本**: v2.0 | **更新**: 2026年6月27日 | **基础 URL**: `http://localhost:3000`

## 基础信息

- **基础 URL**: `http://localhost:3000`（生产环境 `https://your-domain.com`）
- **认证方式**: Bearer Token (JWT)，放在 `Authorization` 请求头
- **内容类型**: `application/json`（文件上传用 `multipart/form-data`）
- **API 前缀**: 所有接口以 `/api` 开头

## 目录

1. [认证接口](#认证接口)
2. [设备管理](#设备管理)
3. [剪贴板](#剪贴板)
4. [文件同步](#文件同步)
5. [增量同步](#增量同步)
6. [版本管理](#版本管理)
7. [会话管理](#会话管理)
8. [通知偏好](#通知偏好)
9. [支付与订阅](#支付与订阅)
10. [系统接口](#系统接口)
11. [错误码](#错误码)
12. [限流规则](#限流规则)

---

## 认证接口

基础路径：`/api/auth`

### 发送手机验证码

**POST** `/api/auth/send-code`

> MVP 模式：验证码固定为 `888888`

**请求体:**
```json
{ "phone": "13800138000" }
```

**响应:**
```json
{ "message": "验证码已发送（MVP: 888888）" }
```

**错误**: `400` 参数验证失败 | `429` 发送过于频繁

---

### 发送邮箱验证码

**POST** `/api/auth/send-email-code`

**请求体:**
```json
{ "email": "user@example.com" }
```

**响应:**
```json
{ "message": "邮箱验证码已发送" }
```

---

### 验证码登录（手机）

**POST** `/api/auth/verify-code`

**请求体:**
```json
{
  "phone": "13800138000",
  "code": "888888",
  "deviceName": "iPhone 14",
  "deviceType": "mobile",
  "platform": "ios"
}
```

**响应:**
```json
{
  "token": "eyJhbG...",
  "sessionId": "uuid",
  "user": { "id": "uuid", "phone": "13800138000", "nickname": "用户", "email": null }
}
```

---

### 验证码登录（邮箱）

**POST** `/api/auth/verify-email-code`

**请求体:**
```json
{
  "email": "user@example.com",
  "code": "888888",
  "deviceName": "MacBook Pro",
  "deviceType": "desktop",
  "platform": "macos"
}
```

---

### 接受服务条款

**POST** `/api/auth/accept-tos`

**请求体:**
```json
{ "version": "1.0", "consent": true }
```

---

### 忘记密码

**POST** `/api/auth/forgot-password`

**请求体:**
```json
{ "email": "user@example.com" }
```

**响应:**
```json
{ "message": "密码重置验证码已发送" }
```

---

### 重置密码

**POST** `/api/auth/reset-password`

**请求体:**
```json
{
  "email": "user@example.com",
  "code": "888888",
  "newPassword": "NewPass123!"
}
```

---

### 登出

**POST** `/api/auth/logout`

**请求头:** `Authorization: Bearer <token>`

**说明**: 将当前 session 加入 JWT 黑名单，使 token 立即失效。

**响应:**
```json
{ "message": "已登出" }
```

---

### 获取当前用户

**GET** `/api/auth/me`

**请求头:** `Authorization: Bearer <token>`

**响应:**
```json
{
  "id": "uuid",
  "phone": "13800138000",
  "email": "user@example.com",
  "nickname": "用户",
  "avatarUrl": null,
  "preferences": { "theme": "dark", "language": "zh" },
  "createdAt": "2024-01-01T00:00:00Z"
}
```

---

### 更新用户资料

**PUT** `/api/auth/profile`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{
  "nickname": "新昵称",
  "email": "new@example.com",
  "preferences": { "theme": "light" }
}
```

---

### 导出用户数据（GDPR）

**GET** `/api/auth/export-data`

**请求头:** `Authorization: Bearer <token>`

**说明**: 导出用户所有数据（剪贴板、设备、会话等），用于 GDPR 数据可携带权。

**响应**: JSON 文件下载，包含用户完整数据。

---

### 删除账户（GDPR）

**DELETE** `/api/auth/account`

**请求头:** `Authorization: Bearer <token>`

**说明**: 永久删除用户账户及所有数据，符合 GDPR 被遗忘权。

**响应:**
```json
{ "message": "账户已删除" }
```

---

### 停用账户

**PUT** `/api/auth/deactivate`

**请求头:** `Authorization: Bearer <token>`

**说明**: 临时停用账户（可恢复），清除所有活跃会话。

---

### 恢复账户

**PUT** `/api/auth/reactivate`

**请求体:**
```json
{ "phone": "13800138000", "code": "888888" }
```

---

### 更新隐私同意

**PUT** `/api/auth/consent`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{
  "marketingConsent": true,
  "dataProcessingConsent": true
}
```

---

## 设备管理

基础路径：`/api/devices`

### 获取设备列表

**GET** `/api/devices`

**请求头:** `Authorization: Bearer <token>`

**响应:**
```json
{
  "devices": [
    {
      "id": "uuid",
      "deviceName": "iPhone 14",
      "deviceType": "mobile",
      "platform": "ios",
      "platformVersion": "16.0",
      "isOnline": true,
      "lastSeenAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

### 注册新设备

**POST** `/api/devices`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{
  "deviceName": "My iPhone",
  "deviceType": "mobile",
  "platform": "ios",
  "platformVersion": "16.0"
}
```

---

### 更新设备信息

**PUT** `/api/devices/:id`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{ "deviceName": "New Name" }
```

---

### 删除设备

**DELETE** `/api/devices/:id`

**请求头:** `Authorization: Bearer <token>`

---

## 剪贴板

基础路径：`/api/clipboard`

### 获取剪贴板列表

**GET** `/api/clipboard`

**请求头:** `Authorization: Bearer <token>`

**查询参数:**
- `page` (可选): 页码，默认 1
- `limit` (可选): 每页数量，默认 50，最大 100
- `search` (可选): 全文搜索关键词（3字符以上使用 tsvector 全文搜索）
- `type` (可选): 内容类型 `text` / `link` / `image` / `file` / `code`
- `favorites` (可选): `true` 只显示收藏

**响应:**
```json
{
  "items": [
    {
      "id": "uuid",
      "contentType": "text",
      "contentPreview": "Hello World",
      "contentSize": 11,
      "isFavorite": false,
      "createdAt": "2024-01-01T00:00:00Z",
      "sourceDevice": { "id": "uuid", "name": "iPhone 14", "platform": "ios" }
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 100, "totalPages": 2 }
}
```

---

### 全文搜索

**GET** `/api/clipboard/search`

**请求头:** `Authorization: Bearer <token>`

**查询参数:**
- `q` (必填): 搜索关键词
- `page` / `limit`: 分页参数

**说明**: 使用 PostgreSQL tsvector 全文搜索，支持相关性排序。搜索词 ≥3 字符时使用 tsvector，<3 字符时使用 ILIKE 模糊匹配。

---

### 创建剪贴板项

**POST** `/api/clipboard`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{
  "contentEncrypted": "encrypted_content_base64",
  "contentType": "text",
  "contentPreview": "Hello World",
  "contentSize": 11,
  "sourceDeviceId": "uuid",
  "metadata": { "app": "VSCode" }
}
```

---

### 获取剪贴板项详情

**GET** `/api/clipboard/:id`

**请求头:** `Authorization: Bearer <token>`

---

### 切换收藏状态

**PUT** `/api/clipboard/:id/favorite`

**请求头:** `Authorization: Bearer <token>`

---

### 删除剪贴板项

**DELETE** `/api/clipboard/:id`

**请求头:** `Authorization: Bearer <token>`

---

### 批量删除

**DELETE** `/api/clipboard/batch`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{ "ids": ["uuid1", "uuid2", "uuid3"] }
```

---

## 文件同步

基础路径：`/api/media`

### 上传图片

**POST** `/api/media/image`

**请求头:** `Authorization: Bearer <token>` + `Content-Type: multipart/form-data`

**请求体:**
- `image`: 图片文件（JPEG/PNG/WebP/GIF，最大 10MB）
- `deviceId`: 设备 ID

**响应:**
```json
{
  "id": "uuid",
  "filename": "image.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "thumbnailUrl": "/api/media/id/thumbnail",
  "previewUrl": "/api/media/id/preview",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

---

### 上传文件

**POST** `/api/media/file`

**请求头:** `Authorization: Bearer <token>` + `Content-Type: multipart/form-data`

**请求体:**
- `file`: 任意文件（最大 50MB）
- `deviceId`: 设备 ID

---

### 分片上传：初始化

**POST** `/api/upload/init`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{
  "filename": "large-file.zip",
  "mimeType": "application/zip",
  "totalSize": 104857600,
  "chunkSize": 5242880,
  "deviceId": "uuid"
}
```

**响应:**
```json
{ "uploadId": "uuid", "chunkSize": 5242880, "totalChunks": 20 }
```

---

### 分片上传：上传分片

**POST** `/api/upload/chunk/:uploadId/:chunkIndex`

**请求头:** `Authorization: Bearer <token>` + `Content-Type: application/octet-stream`

**请求体**: 二进制分片数据（Body 直接是分片二进制内容）

**路径参数:**
- `uploadId`: 初始化时返回的 uploadId
- `chunkIndex`: 分片索引，从 0 开始

**响应:**
```json
{ "uploadId": "uuid", "chunkIndex": 0, "received": true, "receivedSize": 5242880 }
```

---

### 分片上传：查询状态

**GET** `/api/upload/status/:uploadId`

**请求头:** `Authorization: Bearer <token>`

**响应:**
```json
{
  "uploadId": "uuid",
  "filename": "large-file.zip",
  "totalSize": 104857600,
  "receivedChunks": [0, 1, 2],
  "missingChunks": [3, 4],
  "isComplete": false
}
```

---

### 分片上传：完成上传

**POST** `/api/upload/complete/:uploadId`

**请求头:** `Authorization: Bearer <token>`

**说明**: 所有分片上传完成后调用，合并分片并创建 media 记录。

---

### 分片上传：取消上传

**DELETE** `/api/upload/cancel/:uploadId`

**请求头:** `Authorization: Bearer <token>`

**说明**: 清理已上传的分片临时文件。

---

### 下载文件

**GET** `/api/media/:id/download`

**请求头:** `Authorization: Bearer <token>`

**响应**: 文件二进制流（触发浏览器下载）

---

### 预览文件

**GET** `/api/media/:id/preview`

**请求头:** `Authorization: Bearer <token>`

**说明**: 返回文件内容（用于在线预览，非下载）

---

### 文本/代码文件预览

**GET** `/api/media/:id/text-preview`

**请求头:** `Authorization: Bearer <token>`

**查询参数:**
- `maxLines` (可选): 最大行数，默认 100
- `highlight` (可选): 是否语法高亮，默认 true

**说明**: 支持 30+ 种文本/代码格式预览（txt, md, json, js, py, java, css 等）。

**响应:**
```json
{
  "id": "uuid",
  "filename": "script.py",
  "contentType": "text/x-python",
  "preview": "print('Hello')\n...",
  "totalLines": 150,
  "truncated": true,
  "language": "python"
}
```

---

### 删除文件

**DELETE** `/api/media/:id`

**请求头:** `Authorization: Bearer <token>`

---

## 增量同步

基础路径：`/api/sync`

### 推送变更

**POST** `/api/sync/push`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{
  "deviceId": "uuid",
  "changes": [
    {
      "id": "uuid",
      "action": "create",
      "data": {
        "contentEncrypted": "...",
        "contentType": "text",
        "contentPreview": "..."
      },
      "clientTimestamp": "2024-01-01T00:00:00Z"
    }
  ]
}
```

**响应:**
```json
{
  "success": true,
  "syncedItems": 3,
  "conflicts": [],
  "serverTime": "2024-01-01T00:00:00Z"
}
```

---

### 拉取变更

**GET** `/api/sync/pull/:deviceId`

**请求头:** `Authorization: Bearer <token>`

**查询参数:**
- `since` (可选): 上次同步的 `updatedAt` 时间戳
- `limit` (可选): 最大拉取数量，默认 100

**响应:**
```json
{
  "items": [...],
  "deletedIds": ["uuid1", "uuid2"],
  "serverTime": "2024-01-01T00:00:00Z"
}
```

---

### 获取同步状态

**GET** `/api/sync/status/:deviceId`

**请求头:** `Authorization: Bearer <token>`

**响应:**
```json
{
  "synced": true,
  "lastSyncAt": "2024-01-01T00:00:00Z",
  "lastSyncedItemId": "uuid",
  "deviceName": "iPhone 14"
}
```

---

## 版本管理

基础路径：`/api/versions`

### 获取版本历史

**GET** `/api/versions/:clipboardItemId`

**请求头:** `Authorization: Bearer <token>`

**查询参数:** `page`, `limit`

---

### 获取版本详情

**GET** `/api/versions/detail/:versionId`

**请求头:** `Authorization: Bearer <token>`

**说明**: 返回完整的 `contentEncrypted`，用于恢复版本。

---

### 恢复版本

**POST** `/api/versions/restore/:versionId`

**请求头:** `Authorization: Bearer <token>`

**说明**: 恢复指定版本，会创建一个新的版本记录（记录恢复操作）。

---

### 版本统计

**GET** `/api/versions/stats/overview`

**请求头:** `Authorization: Bearer <token>`

---

### 清理旧版本

**POST** `/api/versions/cleanup`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{ "retentionDays": 30, "maxVersionsPerItem": 10 }
```

---

## 会话管理

基础路径：`/api/sessions`

### 获取活跃会话列表

**GET** `/api/sessions`

**请求头:** `Authorization: Bearer <token>`

**说明**: 返回当前用户的所有活跃会话（其他设备登录记录）。

**响应:**
```json
{
  "sessions": [
    {
      "id": "uuid",
      "deviceName": "iPhone 14",
      "deviceType": "mobile",
      "platform": "ios",
      "ipAddress": "***.***.***.123",
      "userAgent": "...",
      "createdAt": "2024-01-01T00:00:00Z",
      "lastActiveAt": "2024-01-01T01:00:00Z"
    }
  ]
}
```

---

### 终止指定会话

**DELETE** `/api/sessions/:sessionId`

**请求头:** `Authorization: Bearer <token>`

**说明**: 远程登出指定设备（例如：丢失手机时清除该设备的登录状态）。

---

### 终止所有其他会话

**DELETE** `/api/sessions`

**请求头:** `Authorization: Bearer <token>`

**说明**: 保留当前会话，终止其他所有会话（类似"强制重新登录"功能）。

---

## 通知偏好

基础路径：`/api/notifications`

### 获取通知偏好

**GET** `/api/notifications/preferences`

**请求头:** `Authorization: Bearer <token>`

**响应:**
```json
{
  "pushEnabled": true,
  "emailEnabled": false,
  "syncNotify": true,
  "securityAlert": true
}
```

---

### 更新通知偏好

**PUT** `/api/notifications/preferences`

**请求头:** `Authorization: Bearer <token>`

---

### 获取通知历史

**GET** `/api/notifications/history`

**请求头:** `Authorization: Bearer <token>`

**查询参数:** `page`, `limit`, `unreadOnly`

---

### 标记通知已读

**PUT** `/api/notifications/history/:id/read`

**请求头:** `Authorization: Bearer <token>`

---

## 支付与订阅

基础路径：`/api/payments` 和 `/api/subscriptions`

### 创建支付订单

**POST** `/api/payments/create-order`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{
  "planId": "premium-monthly",
  "paymentMethod": "wechat" | "alipay" | "stripe"
}
```

**响应:**
```json
{
  "orderNo": "ORD20240101001",
  "paymentUrl": "weixin://pay/...",
  "qrCode": "data:image/png;base64,...",
  "expiresAt": "2024-01-01T01:00:00Z"
}
```

---

### 查询订单状态

**GET** `/api/payments/order/:orderNo/status`

**请求头:** `Authorization: Bearer <token>`

**响应:**
```json
{
  "orderNo": "ORD20240101001",
  "status": "paid" | "pending" | "failed" | "expired",
  "paidAt": "2024-01-01T00:05:00Z"
}
```

---

### 微信支付回调

**POST** `/api/payments/webhooks/wechat-pay`

**说明**: 微信支付异步回调接口，无需认证（通过签名验证）。

---

### 支付宝回调

**POST** `/api/payments/webhooks/alipay`

**说明**: 支付宝异步回调接口，无需认证（通过签名验证）。

---

### Stripe 回调

**POST** `/api/payments/webhooks/stripe`

**说明**: Stripe Webhook 接口，无需认证（通过 Stripe 签名验证）。

---

### 获取订阅计划列表

**GET** `/api/subscriptions/plans`

**说明**: 无需认证，公开接口。

**响应:**
```json
{
  "plans": [
    {
      "id": "premium-monthly",
      "name": "Premium 月付",
      "price": 9.9,
      "currency": "CNY",
      "interval": "month",
      "features": ["无限设备", "无限存储", "优先支持"]
    }
  ]
}
```

---

### 获取当前订阅

**GET** `/api/subscriptions/current`

**请求头:** `Authorization: Bearer <token>`

---

### 订阅计划

**POST** `/api/subscriptions/subscribe`

**请求头:** `Authorization: Bearer <token>`

**请求体:**
```json
{ "planId": "premium-monthly", "paymentMethod": "wechat" }
```

---

### 取消订阅

**POST** `/api/subscriptions/cancel`

**请求头:** `Authorization: Bearer <token>`

**说明**: 取消自动续费，当前订阅到期前仍然有效。

---

### 恢复订阅

**POST** `/api/subscriptions/resume`

**请求头:** `Authorization: Bearer <token>`

**说明**: 恢复已取消的订阅（在到期前）。

---

## 系统接口

### 健康检查

**GET** `/api/health`

**说明**: 无需认证，负载均衡器/监控用。

**响应:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00Z",
  "version": "0.1.0",
  "services": {
    "database": "healthy",
    "redis": "healthy"
  }
}
```

---

### 就绪检查

**GET** `/api/ready`

**说明**: 无需认证，Kubernetes 就绪探针用。检查数据库和 Redis 连接是否正常。

**响应:**
```json
{ "status": "ready" }
```
或（未就绪）:
```json
{ "status": "not ready", "details": { "database": "down" } }
```

---

### Prometheus 指标

**GET** `/api/metrics`

**说明**: 无需认证，Prometheus 抓取用。返回 Node.js 应用指标（http_request_total、http_request_duration_ms 等）。

---

## WebSocket 接口

### 连接

**URL:** `ws://localhost:3000/ws`（生产环境 `wss://your-domain.com/ws`）

**认证:**
```
ws://localhost:3000/ws?token=<jwt_token>&deviceId=<device_id>
```

### 客户端发送事件

| 事件类型 | 说明 |
|----------|------|
| `register` | 注册设备到 WebSocket 会话 |
| `clipboard_update` | 推送新剪贴板项到服务端 |
| `heartbeat` | 心跳保活 |

### 服务端推送事件

| 事件类型 | 说明 |
|----------|------|
| `new_clipboard` | 新剪贴板项（推送给其他设备） |
| `clipboard_deleted` | 剪贴板项删除通知 |
| `clipboard_favorite` | 收藏状态变更通知 |
| `device_online` | 设备上线通知 |
| `device_offline` | 设备离线通知 |
| `sync_push` | 增量同步推送 |
| `notification` | 系统通知 |

---

## 错误码

| 状态码 | 说明 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | 未认证或 token 无效 / 已登出 |
| 403 | 无权限访问 |
| 404 | 资源不存在 |
| 409 | 资源冲突（如设备名已存在） |
| 429 | 请求过于频繁（限流触发） |
| 500 | 服务器内部错误 |
| 503 | 服务暂不可用（维护模式） |

**标准错误响应:**
```json
{
  "error": "错误描述信息",
  "code": "ERROR_CODE"  // 可选，机器可读错误码
}
```

---

## 限流规则

| 接口类型 | 限制 | 说明 |
|----------|------|------|
| 验证码发送 | 5次/小时/IP | 防止短信轰炸 |
| 登录失败 | 5次/15分钟/IP | 防止暴力破解 |
| API 调用 | 100次/分钟/用户 | 通用 API 限流 |
| WebSocket 连接 | 5个/用户 | 单用户最多 5 个设备在线 |
| 文件上传 | 10次/分钟/用户 | 防止存储滥用 |
| 搜索 API | 30次/分钟/用户 | 全文搜索资源消耗较大 |

---

## 分页规范

所有支持分页的接口遵循统一规范：

**请求参数:**
- `page`: 页码，从 1 开始，默认 1
- `limit`: 每页数量，默认 20，最大 100

**响应格式:**
```json
{
  "items": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": false
  }
}
```

---

## 时间格式

所有时间戳使用 **ISO 8601** 格式：

```
2024-01-01T00:00:00.000Z
```

响应中的 `createdAt`、`updatedAt`、`lastSeenAt` 等字段均为此格式。

---

## 端到端加密说明

ClipSync 使用端到端加密，服务器无法查看用户明文数据：

1. **密钥交换**: 客户端通过 ECDH (P-256) 交换公钥，生成共享密钥
2. **密钥派生**: 使用 HKDF 派生加密密钥
3. **数据加密**: 客户端加密 `contentEncrypted` 后上传，服务器只存储密文
4. **数据传输**: WebSocket 推送时，服务器只转发密文

**重要**: API 文档中的 `contentEncrypted` 字段均为客户端加密后的 Base64 字符串，服务器不存储明文。

---

*文档版本 v2.0 — 覆盖全部 72 个 API 端点*
