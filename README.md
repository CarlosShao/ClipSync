# ClipSync — 跨设备剪贴板同步工具

## 项目概述

ClipSync 是一款跨设备剪贴板同步工具，实现手机复制→电脑粘贴（反之亦然）的核心功能。

## 核心功能

- **实时剪贴板同步**：手机复制，电脑秒粘
- **多设备管理**：支持 macOS / Windows / iOS / Android
- **端到端加密**：隐私数据不经过服务器明文传输
- **AI 智能分类**：自动识别验证码、链接、代码、图片等类型
- **历史记录**：支持搜索、收藏、自动过期
- **文件同步**：支持图片、文件传输，最大50MB
- **离线支持**：断网时本地操作，联网后自动同步
- **深色模式**：支持浅色/深色/跟随系统主题

## 技术栈

| 层级 | 技术选型 |
|------|---------|
| 桌面端 | Tauri 2 (Rust + WebView) |
| 移动端 | Flutter 3.x (Dart) |
| 后端 | Node.js + Express + WebSocket |
| 数据库 | PostgreSQL + Redis |
| 加密 | AES-256-GCM 端到端加密 |
| 测试 | Vitest + Supertest |

## 快速开始

### 环境要求

- Node.js 22.x
- Flutter 3.x
- Rust 1.70+ (仅桌面端)
- Docker (可选，用于数据库)

### 1. 启动后端服务

```bash
cd src/server
npm install
npm run dev
```

服务器将在 http://localhost:3000 启动。

### 2. 启动移动端

```bash
cd src/mobile
flutter pub get
flutter run
```

### 3. 启动桌面端

```bash
cd src/desktop
cargo tauri dev
```

## 项目结构

```
ClipSync/
├── src/
│   ├── server/          # Node.js 后端服务
│   │   ├── src/
│   │   │   ├── routes/      # API 路由
│   │   │   ├── middleware/   # 中间件
│   │   │   ├── db/          # 数据库
│   │   │   ├── ws/          # WebSocket
│   │   │   └── utils/       # 工具函数
│   │   └── tests/         # 测试文件
│   ├── mobile/          # Flutter 移动端
│   │   ├── lib/
│   │   │   ├── screens/     # 页面
│   │   │   ├── widgets/     # 组件
│   │   │   ├── providers/   # 状态管理
│   │   │   └── services/    # 服务
│   │   └── l10n/          # 国际化
│   └── desktop/         # Tauri 桌面端
├── scripts/             # 脚本工具
├── docker-compose.yml   # Docker 编排
└── docs/                # 文档
```

## API 文档

### 认证接口

- `POST /api/auth/send-code` - 发送验证码
- `POST /api/auth/verify-code` - 验证码登录

### 设备管理

- `GET /api/devices` - 获取设备列表
- `POST /api/devices` - 注册新设备
- `PUT /api/devices/:id` - 更新设备信息
- `DELETE /api/devices/:id` - 删除设备

### 剪贴板

- `GET /api/clipboard` - 获取剪贴板列表
- `POST /api/clipboard` - 创建剪贴板项
- `PUT /api/clipboard/:id/favorite` - 切换收藏
- `DELETE /api/clipboard/:id` - 删除剪贴板项

### 文件同步

- `POST /api/media/image` - 上传图片
- `POST /api/media/file` - 上传文件
- `GET /api/media/:id/preview` - 预览文件

### 版本管理

- `POST /api/versions` - 创建版本
- `GET /api/versions/:clipboardItemId` - 获取版本历史
- `POST /api/versions/restore/:versionId` - 恢复版本

## 测试

### 运行测试

```bash
cd src/server
npm test
```

### 测试覆盖

- 单元测试：验证器、加密模块
- 集成测试：API 端点、数据库操作
- 端到端测试：完整用户流程
- 性能测试：并发、响应时间、内存稳定性
- 安全测试：SQL注入、XSS、认证绕过

## 部署

### Docker 部署

```bash
docker-compose up -d
```

### 生产环境配置

复制 `.env.production` 为 `.env` 并配置：

```bash
cp .env.production .env
```

## 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 许可证

MIT License