# ClipSync API 参考文档

## 基础信息

- 基础URL: `http://localhost:3000`
- 认证方式: Bearer Token (JWT)
- 内容类型: `application/json`

## 认证接口

### 发送验证码

**POST** `/api/auth/send-code`

**请求体:**
```json
{
  "phone": "13800138000"
}
```

**响应:**
```json
{
  "success": true,
  "message": "验证码已发送"
}
```

**错误响应:**
- `400` 参数验证失败
- `429` 发送过于频繁

### 验证码登录

**POST** `/api/auth/verify-code`

**请求体:**
```json
{
  "phone": "13800138000",
  "code": "888888"
}
```

**响应:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid",
    "phone": "13800138000",
    "nickname": "用户"
  }
}
```

## 设备管理

### 获取设备列表

**GET** `/api/devices`

**请求头:**
```
Authorization: Bearer <token>
```

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

### 注册新设备

**POST** `/api/devices`

**请求头:**
```
Authorization: Bearer <token>
```

**请求体:**
```json
{
  "deviceName": "My iPhone",
  "deviceType": "mobile",
  "platform": "ios",
  "platformVersion": "16.0"
}
```

**响应:**
```json
{
  "id": "uuid",
  "deviceName": "My iPhone",
  "deviceType": "mobile",
  "platform": "ios",
  "platformVersion": "16.0",
  "isOnline": true,
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### 更新设备信息

**PUT** `/api/devices/:id`

**请求头:**
```
Authorization: Bearer <token>
```

**请求体:**
```json
{
  "deviceName": "New Name"
}
```

**响应:**
```json
{
  "id": "uuid",
  "deviceName": "New Name",
  "deviceType": "mobile",
  "platform": "ios",
  "platformVersion": "16.0",
  "isOnline": true,
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

### 删除设备

**DELETE** `/api/devices/:id`

**请求头:**
```
Authorization: Bearer <token>
```

**响应:**
```json
{
  "success": true,
  "message": "设备已删除"
}
```

## 剪贴板

### 获取剪贴板列表

**GET** `/api/clipboard`

**查询参数:**
- `page` (可选): 页码，默认1
- `limit` (可选): 每页数量，默认20
- `search` (可选): 搜索关键词
- `type` (可选): 内容类型 (text/link/image/file)

**请求头:**
```
Authorization: Bearer <token>
```

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
      "sourceDevice": {
        "id": "uuid",
        "name": "iPhone 14",
        "platform": "ios"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

### 创建剪贴板项

**POST** `/api/clipboard`

**请求头:**
```
Authorization: Bearer <token>
```

**请求体:**
```json
{
  "contentEncrypted": "encrypted_content_base64",
  "contentType": "text",
  "contentPreview": "Hello World",
  "contentSize": 11,
  "sourceDeviceId": "uuid"
}
```

**响应:**
```json
{
  "id": "uuid",
  "contentType": "text",
  "contentPreview": "Hello World",
  "contentSize": 11,
  "isFavorite": false,
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### 切换收藏状态

**PUT** `/api/clipboard/:id/favorite`

**请求头:**
```
Authorization: Bearer <token>
```

**响应:**
```json
{
  "id": "uuid",
  "isFavorite": true,
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

### 删除剪贴板项

**DELETE** `/api/clipboard/:id`

**请求头:**
```
Authorization: Bearer <token>
```

**响应:**
```json
{
  "success": true,
  "message": "剪贴板项已删除"
}
```

### 批量删除

**DELETE** `/api/clipboard/batch`

**请求头:**
```
Authorization: Bearer <token>
```

**请求体:**
```json
{
  "ids": ["uuid1", "uuid2", "uuid3"]
}
```

**响应:**
```json
{
  "success": true,
  "deletedCount": 3,
  "message": "已删除3个项目"
}
```

## 文件同步

### 上传图片

**POST** `/api/media/image`

**请求头:**
```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**请求体:**
- `image`: 图片文件 (JPEG, PNG, WebP, GIF)
- `deviceId`: 设备ID

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

### 上传文件

**POST** `/api/media/file`

**请求头:**
```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**请求体:**
- `file`: 文件 (最大50MB)
- `deviceId`: 设备ID

**响应:**
```json
{
  "id": "uuid",
  "filename": "document.pdf",
  "mimeType": "application/pdf",
  "size": 1048576,
  "downloadUrl": "/api/media/id/download",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### 预览文件

**GET** `/api/media/:id/preview`

**请求头:**
```
Authorization: Bearer <token>
```

**响应:** 文件内容流

### 下载文件

**GET** `/api/media/:id/download`

**请求头:**
```
Authorization: Bearer <token>
```

**响应:** 文件内容流

## 版本管理

### 创建版本

**POST** `/api/versions`

**请求头:**
```
Authorization: Bearer <token>
```

**请求体:**
```json
{
  "clipboardItemId": "uuid",
  "contentEncrypted": "encrypted_content",
  "contentPreview": "版本内容预览",
  "contentSize": 1024,
  "metadata": {"key": "value"},
  "sourceDeviceId": "uuid",
  "changeDescription": "修改了内容"
}
```

**响应:**
```json
{
  "id": "uuid",
  "clipboardItemId": "uuid",
  "versionNumber": 2,
  "contentPreview": "版本内容预览",
  "contentSize": 1024,
  "changeDescription": "修改了内容",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### 获取版本历史

**GET** `/api/versions/:clipboardItemId`

**查询参数:**
- `page` (可选): 页码，默认1
- `limit` (可选): 每页数量，默认20

**请求头:**
```
Authorization: Bearer <token>
```

**响应:**
```json
{
  "versions": [
    {
      "id": "uuid",
      "versionNumber": 2,
      "contentPreview": "版本2内容",
      "contentSize": 1024,
      "changeDescription": "修改了内容",
      "createdAt": "2024-01-01T00:00:00Z",
      "device": {
        "id": "uuid",
        "name": "iPhone 14",
        "platform": "ios"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 5,
    "totalPages": 1
  }
}
```

### 获取版本详情

**GET** `/api/versions/detail/:versionId`

**请求头:**
```
Authorization: Bearer <token>
```

**响应:**
```json
{
  "id": "uuid",
  "clipboardItemId": "uuid",
  "versionNumber": 2,
  "contentEncrypted": "encrypted_content_base64",
  "contentPreview": "版本2内容",
  "contentSize": 1024,
  "metadata": {"key": "value"},
  "changeDescription": "修改了内容",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### 恢复版本

**POST** `/api/versions/restore/:versionId`

**请求头:**
```
Authorization: Bearer <token>
```

**响应:**
```json
{
  "success": true,
  "message": "版本已恢复",
  "newVersion": {
    "id": "uuid",
    "versionNumber": 3,
    "contentPreview": "恢复的内容",
    "changeDescription": "恢复到版本2"
  }
}
```

### 获取版本统计

**GET** `/api/versions/stats/overview`

**请求头:**
```
Authorization: Bearer <token>
```

**响应:**
```json
{
  "totalVersions": 100,
  "totalSize": 1048576,
  "averageVersionsPerItem": 2.5,
  "oldestVersion": "2024-01-01T00:00:00Z",
  "newestVersion": "2024-01-02T00:00:00Z"
}
```

### 清理旧版本

**POST** `/api/versions/cleanup`

**请求头:**
```
Authorization: Bearer <token>
```

**请求体:**
```json
{
  "retentionDays": 30,
  "maxVersionsPerItem": 10
}
```

**响应:**
```json
{
  "success": true,
  "deletedCount": 25,
  "message": "已清理25个旧版本"
}
```

## WebSocket 接口

### 连接

**URL:** `ws://localhost:3000/ws`

**认证:**
连接时在查询参数中传递 token:
```
ws://localhost:3000/ws?token=<jwt_token>&deviceId=<device_id>
```

### 事件

#### 客户端发送

**register** - 注册设备
```json
{
  "type": "register",
  "deviceId": "uuid"
}
```

**clipboard_update** - 更新剪贴板
```json
{
  "type": "clipboard_update",
  "data": {
    "contentEncrypted": "encrypted",
    "contentType": "text",
    "contentPreview": "内容"
  }
}
```

#### 服务端发送

**new_clipboard** - 新剪贴板项
```json
{
  "type": "new_clipboard",
  "data": {
    "id": "uuid",
    "contentPreview": "新内容",
    "contentType": "text",
    "sourceDeviceId": "uuid"
  }
}
```

**clipboard_deleted** - 剪贴板项删除
```json
{
  "type": "clipboard_deleted",
  "data": {
    "id": "uuid"
  }
}
```

**clipboard_favorite** - 收藏状态变更
```json
{
  "type": "clipboard_favorite",
  "data": {
    "id": "uuid",
    "isFavorite": true
  }
}
```

**device_online** - 设备上线
```json
{
  "type": "device_online",
  "data": {
    "deviceId": "uuid",
    "deviceName": "iPhone 14"
  }
}
```

**device_offline** - 设备离线
```json
{
  "type": "device_offline",
  "data": {
    "deviceId": "uuid"
  }
}
```

**notification** - 通知
```json
{
  "type": "notification",
  "data": {
    "title": "同步完成",
    "message": "已同步3个新内容",
    "type": "info"
  }
}
```

## 错误码

| 错误码 | 描述 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | 未认证或 token 无效 |
| 403 | 无权限访问 |
| 404 | 资源不存在 |
| 409 | 资源冲突 (如设备名已存在) |
| 429 | 请求过于频繁 |
| 500 | 服务器内部错误 |

## 限流规则

- API 调用: 100次/分钟
- 验证码发送: 5次/小时
- 登录失败: 5次/15分钟
- WebSocket 连接: 5个/用户