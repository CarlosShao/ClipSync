# Flutter 移动端全流程自动化测试文档

> **文档版本**: v1.0  
> **适用平台**: Android / iOS / Web (测试)  
> **最后更新**: 2026年6月29日

---

## 目录

1. [测试环境准备与配置](#一测试环境准备与配置)
2. [自动化测试的启动命令与参数说明](#二自动化测试的启动命令与参数说明)
3. [测试覆盖范围](#三测试覆盖范围)
4. [测试报告的查看方式](#四测试报告的查看方式)
5. [常见问题排查指引](#五常见问题排查指引)

---

## 一、测试环境准备与配置

### 1.1 系统依赖检查

#### Windows
```bash
# 检查 Flutter 版本
flutter --version  # 应输出 Flutter 3.x.x + Dart 3.x.x

# 检查 Android SDK
flutter doctor  # 查看缺失依赖

# 检查设备连接（Android 真机/模拟器）
flutter devices
```

#### macOS
```bash
# 检查 Flutter 版本
flutter --version

# 检查 Xcode（iOS 测试需要）
xcode-select -p
xcodebuild -version

# 检查 iOS 模拟器
open -a Simulator

# 检查设备
flutter devices
```

#### Linux
```bash
# 安装 Flutter（若未安装）
# 参考：https://docs.flutter.dev/get-started/linux/install

# 检查依赖
flutter doctor
```

---

### 1.2 项目依赖安装

```bash
# 进入 Flutter 项目目录
cd /d/work/java/AI-workspace/ClipSync/src/mobile

# 获取依赖
flutter pub get

# 检查依赖树
flutter pub deps
```

**预期结果**：
```
Running "flutter pub get" in mobile...
Dependencies are now resolved.
```

**失败处理**：
- 若 `flutter pub get` 失败：检查 `pubspec.yaml` 语法，检查网络连接
- 若某个包下载失败：尝试更换 pub 镜像 `export PUB_HOSTED_URL=https://pub.flutter-io.cn`

---

### 1.3 测试配置文件检查

确认以下文件存在且配置正确：

```
src/mobile/
├── pubspec.yaml           # 包含 dev_dependencies：test、flutter_test、mockito
├── test/
│   ├── widget_test.dart  # Widget 测试
│   ├── unit/             # 单元测试目录
│   ├── integration/      # 集成测试目录
│   └── helpers/         # 测试辅助函数
└── integration_test/     # E2E 测试目录（Flutter 新版本推荐）
```

**若缺少测试依赖，添加到 `pubspec.yaml`**：
```yaml
dev_dependencies:
  flutter_test:
    sdk: flutter
  test: ^1.24.0
  mockito: ^5.4.2
  build_runner: ^2.4.0
  integration_test:
    sdk: flutter
```

---

### 1.4 模拟器/真机准备

#### Android
```bash
# 启动 Android 模拟器
emulator -list-avds  # 列出可用模拟器
emulator -avd Pixel_6_API_34  # 启动指定模拟器

# 或连接真机（开启 USB 调试）
adb devices  # 确认设备已连接
```

#### iOS（仅 macOS）
```bash
# 启动 iOS 模拟器
open -a Simulator
xcrun simctl list devices  # 列出可用模拟器
xcrun simctl boot "iPhone 15 Pro"  # 启动指定模拟器
```

---

## 二、自动化测试的启动命令与参数说明

### 2.1 运行所有单元测试/Widget 测试

```bash
# 进入项目目录
cd /d/work/java/AI-workspace/ClipSync/src/mobile

# 运行所有测试（默认在本地机器运行，如 Windows 则运行桌面版）
flutter test

# 指定设备运行（推荐，速度更快）
flutter test -d windows
flutter test -d macos
flutter test -d linux
```

**预期结果**：
```
00:02 +12: All tests passed!
```

**参数说明**：
- `-d <device>`：指定运行设备（如 `windows`、`macos`、`linux`、`emulator-5554`）
- `--coverage`：生成覆盖率报告
- `--reporter=expanded`：显示每个测试用例的名称
- `--timeout=10s`：设置测试超时时间

---

### 2.2 运行指定测试文件

```bash
# 运行单个测试文件
flutter test test/unit/clipboard_service_test.dart

# 运行匹配名称的测试
flutter test --name="剪贴板同步"
```

---

### 2.3 生成测试覆盖率报告

```bash
# 生成覆盖率数据（生成 coverage/lcov.info）
flutter test --coverage

# 查看覆盖率报告（需要 lcov）
# 安装 lcov（macOS）
brew install lcov
# 安装 lcov（Ubuntu）
sudo apt install -y lcov

# 生成并打开 HTML 报告
genhtml coverage/lcov.info -o coverage/html
open coverage/html/index.html  # macOS
xdg-open coverage/html/index.html  # Linux
start coverage/html/index.html  # Windows
```

**预期结果**：
- 浏览器打开 HTML 报告
- 显示每个文件的覆盖率百分比
- 点击文件名可查看未覆盖的代码行

---

### 2.4 运行集成测试（E2E）

#### 方式一：`integration_test` 包（推荐）

```bash
# 运行所有集成测试（需要在真机/模拟器上运行）
flutter test integration_test/

# 指定设备
flutter test -d emulator-5554 integration_test/

# 生成覆盖率（集成测试 + 单元测试合并）
flutter test --coverage --merge-coverage
```

#### 方式二：`flutter drive`（旧版，不推荐）

```bash
# 启动测试服务
flutter drive --target=test_driver/app.dart
```

---

### 2.5 监听模式（开发时自动重跑）

```bash
# 进入监听模式（文件变更后自动重跑测试）
flutter test --watch

# 指定测试文件并监听
flutter test --watch test/unit/clipboard_service_test.dart
```

---

### 2.6 CI/CD 中运行测试

#### GitHub Actions 示例（`.github/workflows/flutter-test.yml`）

```yaml
name: Flutter Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: macos-latest  # 需要 macOS 才能测试 iOS
    steps:
      - uses: actions/checkout@v3

      - name: Setup Flutter
        uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.16.0'

      - name: Install dependencies
        run: flutter pub get

      - name: Run unit tests
        run: flutter test --coverage

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          file: coverage/lcov.info
```

---

## 三、测试覆盖范围

### 3.1 UI 流程测试（Widget Test）

| 测试场景 | 测试文件 | 覆盖内容 |
|----------|----------|----------|
| 剪贴板列表显示 | `clipboard_list_test.dart` | 列表渲染、下拉刷新、空状态 |
| 剪贴板项点击 | `clipboard_item_test.dart` | 点击复制、长按菜单 |
| 快速粘贴面板 | `quick_paste_panel_test.dart` | 面板显示、搜索、预览 |
| 设置页面 | `settings_test.dart` | 主题切换、语言切换、服务器配置 |
| 订阅管理 | `subscription_test.dart` | 套餐选择、支付 Mock、订阅状态显示 |

**示例测试代码**（`test/widget/clipboard_list_test.dart`）：
```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:clipsync/main.dart' as app;

void main() {
  testWidgets('剪贴板列表应显示空状态提示', (WidgetTester tester) async {
    // 启动应用
    await tester.pumpWidget(app.MyApp());

    // 等待异步加载
    await tester.pumpAndSettle();

    // 验证空状态提示存在
    expect(find.text('暂无剪贴板'), findsOneWidget);
  });

  testWidgets('下拉刷新应触发同步', (WidgetTester tester) async {
    // 启动应用
    await tester.pumpWidget(app.MyApp());

    // 模拟下拉刷新
    await tester.drag(find.byType(RefreshIndicator), const Offset(0, 300));
    await tester.pumpAndSettle();

    // 验证加载指示器显示
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });
}
```

---

### 3.2 业务逻辑测试（Unit Test）

| 测试场景 | 测试文件 | 覆盖内容 |
|----------|----------|----------|
| 剪贴板服务 | `clipboard_service_test.dart` | 创建、查询、删除、冲突解决 |
| 缓存服务 | `cache_service_test.dart` | LRU 淘汰、过期清理、磁盘持久化 |
| 加密服务 | `encryption_service_test.dart` | ECDH 密钥交换、AES 加密/解密 |
| WebSocket 服务 | `websocket_service_test.dart` | 连接、心跳、重连、消息发送 |
| 离线队列 | `offline_queue_test.dart` | 离线操作、上线后同步、冲突处理 |

**示例测试代码**（`test/unit/clipboard_service_test.dart`）：
```dart
import 'package:test/test.dart';
import 'package:mockito/annotations.dart';
import 'package:clipsync/services/clipboard_service.dart';

@GenerateMocks([HttpClient])
void main() {
  group('ClipboardService 测试', () {
    late ClipboardService service;

    setUp(() {
      service = ClipboardService();
    });

    test('创建剪贴板应返回 ID', () async {
      final item = await service.createClipboard(
        content: '测试内容',
        contentType: 'text',
      );

      expect(item.id, isNotNull);
      expect(item.content, '测试内容');
    });

    test('冲突解决应使用服务器版本', () async {
      final local = ClipboardItem(
        id: '1',
        content: '本地版本',
        updatedAt: DateTime(2026, 6, 29, 10, 0, 0),
      );
      final remote = ClipboardItem(
        id: '1',
        content: '服务器版本',
        updatedAt: DateTime(2026, 6, 29, 10, 1, 0),  // 更晚
      );

      final result = service.resolveConflict(local, remote);
      expect(result.content, '服务器版本');
    });
  });
}
```

---

### 3.3 端到端测试（Integration Test）

| 测试场景 | 测试工具 | 覆盖内容 |
|----------|----------|----------|
| 完整用户旅程 | `integration_test/app_test.dart` | 启动 → 注册 → 复制文本 → 同步到其他设备 |
| 跨设备同步 | Mock WebSocket Server | 多设备同时在线、消息广播 |
| 离线 → 在线恢复 | 网络模拟 | 离线操作队列、上线后自动同步 |

**E2E 测试示例**（`integration_test/app_test.dart`）：
```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart' as integration_test;
import 'package:clipsync/main.dart' as app;

void main() {
  integration_test.integrationTestWidgets('端到端同步流程', (WidgetTester tester) async {
    // 启动应用
    app.main();
    await tester.pumpAndSettle();

    // 模拟复制文本（调用平台通道）
    const platform = MethodChannel('com.clipsync/clipboard');
    await platform.invokeMethod('setClipboard', {'text': 'E2E 测试'});

    // 等待同步（假设 2 秒）
    await tester.pump(const Duration(seconds: 2));

    // 验证列表中显示该文本
    expect(find.text('E2E 测试'), findsOneWidget);
  });
}
```

---

## 四、测试报告的查看方式

### 4.1 控制台输出

测试运行后，控制台会显示：
```
00:02 +12 -1: All tests passed!  # 12 通过，1 跳过
00:02 +10 ~2 -3: Some tests failed.  # 10 通过，2 跳过，3 失败
```

- `+`：通过的测试数
- `~`：跳过的测试数
- `-`：失败的测试数

---

### 4.2 覆盖率报告

#### 查看 LCOV 报告（推荐）
```bash
# 生成 HTML 报告
genhtml coverage/lcov.info -o coverage/html

# 打开报告
open coverage/html/index.html  # macOS
```

**报告内容**：
- 每个文件的覆盖率百分比
- 未覆盖的代码行（高亮显示）
- 分支覆盖率

#### 查看覆盖率摘要
```bash
# 使用 lcov 工具
lcov --summary coverage/lcov.info

# 或使用 flutter-coverage 包（需要安装）
flutter pub global activate flutter_coverage
flutter coverage --lcov-info=coverage/lcov.info
```

---

### 4.3 JUnit 报告（CI/CD 集成）

Flutter 本身不支持 JUnit 输出，但可以使用 `test` 包的 `--reporter=json` 参数，然后转换。

```bash
# 生成 JSON 格式测试结果
flutter test --machine > test-results.json

# 使用第三方工具转换为 JUnit
# 参考：https://github.com/dart-lang/test/blob/master/doc/json_reporter.md
```

---

## 五、常见问题排查指引

### 5.1 测试运行时报错 `MissingPluginException`

**原因**：测试环境中无法调用平台通道（Platform Channel）。

**解决方法**：使用 Mock 平台通道。

```dart
// test/helpers/mock_platform_channel.dart
import 'package:flutter/services.dart';

void setupMockPlatformChannel() {
  const channel = MethodChannel('com.clipsync/clipboard');

  TestDefaultBinaryMessengerBinding.instance!.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (call) async {
    if (call.method == 'getClipboard') {
      return 'mock-clipboard-content';
    }
    return null;
  });
}

// 在测试文件中使用
void main() {
  setUp(() {
    setupMockPlatformChannel();
  });

  test('...', () async {
    // 测试代码
  });
}
```

---

### 5.2 测试覆盖率偏低

**原因**：E2E 测试和平台通道调用难以覆盖。

**解决方法**：
1. 将业务逻辑抽取到纯 Dart 类（易于单元测试）
2. 使用 Mock 替代真实平台通道调用
3. 为关键路径（加密、同步、冲突解决）编写详细测试

---

### 5.3 集成测试在 CI/CD 中失败

**原因**：CI 环境无显示器（无法启动模拟器）。

**解决方法**：使用 Firebase Test Lab 或 BrowserStack。

```yaml
# .github/workflows/integration-test.yml
jobs:
  integration-test:
    runs-on: ubuntu-latest
    steps:
      - name: Run integration tests on Firebase Test Lab
        run: |
          gcloud firebase test android run \
            --type=ios \
            --device=model=iphone15pro,version=17.0 \
            --test=integration_test/
```

---

### 5.4 测试运行缓慢

**原因**：Flutter 应用启动时间长，集成测试需要真机/模拟器。

**解决方法**：
1. 使用 Mock 替代真实网络请求
2. 将测试分为单元测试（快速）和集成测试（慢速）
3. 使用 `--concurrency=4` 并行运行测试

```bash
flutter test --concurrency=4
```

---

### 5.5 `flutter test --coverage` 生成失败

**错误信息**：`Error: Coverage generator failed.`

**解决方法**：
```bash
# 清理缓存
flutter clean
flutter pub get

# 重新生成覆盖率
flutter test --coverage

# 若仍失败，手动检查 lcov 安装
which lcov  # 应输出路径
```

---

## 附录：测试命令速查表

| 命令 | 说明 |
|------|------|
| `flutter test` | 运行所有测试 |
| `flutter test --watch` | 监听模式（自动重跑） |
| `flutter test --coverage` | 生成覆盖率报告 |
| `flutter test --name="名称"` | 运行匹配名称的测试 |
| `flutter test integration_test/` | 运行集成测试 |
| `flutter test --machine` | 生成 JSON 格式测试结果 |
| `flutter drive` | 运行 E2E 测试（旧版） |
| `genhtml coverage/lcov.info -o coverage/html` | 生成 HTML 覆盖率报告 |

---

## 推荐的测试策略

### 测试金字塔

```
        /‾‾\
       /    \         E2E 测试（少量，关键路径）
      /______\
     /        \      集成测试（中量，服务层）
    /__________\
   /____________\    单元测试（大量，纯逻辑）
```

### 覆盖率目标

| 模块 | 目标覆盖率 |
|------|----------|
| 业务逻辑（services/） | > 90% |
| 工具函数（utils/） | > 95% |
| UI 组件（widgets/） | > 80% |
| 平台通道（platform/） | > 70%（需要 Mock） |

---

**文档版本**：1.0  
**创建日期**：2026-06-29  
**作者**：ClipSync Development Team  
**更新日志**：
- 2026-06-29：初始版本
