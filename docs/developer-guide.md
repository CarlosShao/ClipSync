# ClipSync 开发者指南

## 开发环境设置

### 前置要求

- Node.js 22.x
- Flutter 3.x
- Rust 1.70+ (仅桌面端)
- Docker (可选)
- Git

### 克隆项目

```bash
git clone https://github.com/your-org/clipsync.git
cd clipsync
```

## 后端开发

### 项目结构

```
src/server/
├── src/
│   ├── routes/          # API 路由
│   ├── middleware/       # 中间件
│   ├── db/              # 数据库
│   ├── ws/              # WebSocket
│   ├── crypto/          # 加密模块
│   ├── validation/      # 输入验证
│   └── utils/           # 工具函数
├── tests/               # 测试文件
├── package.json
└── .env                 # 环境变量
```

### 启动开发服务器

```bash
cd src/server
npm install
npm run dev
```

服务器将在 http://localhost:3000 启动，支持热重载。

### 数据库设置

#### 使用 Docker

```bash
docker-compose up -d postgres redis
```

#### 手动设置

1. 安装 PostgreSQL 15+
2. 创建数据库和用户
3. 运行迁移脚本

### 添加新 API

1. 在 `src/routes/` 创建新路由文件
2. 在 `src/index.js` 注册路由
3. 添加输入验证
4. 编写测试用例

示例：

```javascript
// src/routes/example.js
import express from 'express';
import { pool } from '../db/index.js';
import { validateInput } from '../validation/validator.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM example');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

### 测试

#### 运行所有测试

```bash
npm test
```

#### 运行特定测试

```bash
npx vitest run tests/validator.test.js
```

#### 测试覆盖率

```bash
npx vitest run --coverage
```

## 移动端开发

### 项目结构

```
src/mobile/
├── lib/
│   ├── screens/         # 页面
│   ├── widgets/         # 组件
│   ├── providers/       # 状态管理
│   ├── services/        # 服务
│   ├── models/          # 数据模型
│   ├── theme/           # 主题
│   ├── utils/           # 工具函数
│   └── l10n/            # 国际化
├── test/                # 测试
└── pubspec.yaml
```

### 启动开发

```bash
cd src/mobile
flutter pub get
flutter run
```

### 添加新页面

1. 在 `lib/screens/` 创建新页面
2. 在路由配置中注册
3. 添加到导航菜单
4. 编写测试

### 状态管理

使用 Provider 模式：

```dart
// 创建 Provider
class MyProvider extends ChangeNotifier {
  int _count = 0;
  
  int get count => _count;
  
  void increment() {
    _count++;
    notifyListeners();
  }
}

// 使用 Provider
Consumer<MyProvider>(
  builder: (context, provider, _) {
    return Text('${provider.count}');
  },
)
```

### 国际化

1. 在 `lib/l10n/app_en.arb` 添加英文字符串
2. 在 `lib/l10n/app_zh.arb` 添加中文翻译
3. 运行 `flutter gen-l10n`
4. 使用 `AppLocalizations.of(context)!.stringName`

## 桌面端开发

### 项目结构

```
src/desktop/
├── src/
│   ├── main.rs          # 主入口
│   ├── lib.rs           # 库入口
│   ├── clipboard_monitor.rs  # 剪贴板监控
│   ├── crypto.rs        # 加密
│   └── sync_client.rs   # 同步客户端
├── src-ui/              # WebView 前端
├── Cargo.toml
└── tauri.conf.json
```

### 启动开发

```bash
cd src/desktop
cargo tauri dev
```

### 添加新功能

1. 在 Rust 端实现功能
2. 通过 Tauri 命令暴露给前端
3. 在 WebView 中调用
4. 编写测试

## 代码规范

### 后端

- 使用 ES6+ 语法
- 遵循 ESLint 规则
- 使用 JSDoc 注释
- 提交前运行 `npm run lint`

### 移动端

- 遵循 Dart 官方风格指南
- 使用 `flutter analyze` 检查
- 编写 Widget 测试
- 提交前运行 `flutter analyze`

### 通用

- 使用有意义的提交信息
- 一个提交只做一件事
- 提交前确保测试通过
- 代码审查后合并

## 部署

### 后端部署

```bash
# 构建
npm run build

# 启动
npm start
```

### 移动端发布

```bash
# iOS
flutter build ios --release

# Android
flutter build apk --release
```

### 桌面端发布

```bash
# 构建安装包
cargo tauri build
```

## 故障排除

### 常见问题

#### 数据库连接失败
- 检查 PostgreSQL 是否运行
- 检查连接配置
- 检查防火墙设置

#### WebSocket 连接失败
- 检查服务器地址
- 检查端口是否开放
- 检查认证 token

#### 构建失败
- 清理缓存：`flutter clean` 或 `cargo clean`
- 重新安装依赖
- 检查版本兼容性

### 获取帮助

- 查看项目文档
- 搜索 Issue 跟踪器
- 联系维护团队