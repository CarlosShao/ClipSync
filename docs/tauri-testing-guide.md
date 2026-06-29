# Tauri 桌面端全流程自动化测试文档

> **文档版本**: v1.0  
> **适用平台**: Windows / macOS / Linux  
> **最后更新**: 2026年6月29日

---

## 目录

1. [测试环境准备](#一测试环境准备)
2. [自动化测试启动命令](#二自动化测试启动命令)
3. [测试覆盖范围](#三测试覆盖范围)
4. [测试报告查看方式](#四测试报告查看方式)
5. [常见问题排查指引](#五常见问题排查指引)

---

## 一、测试环境准备

### 1.1 系统依赖检查

#### Windows
```bash
# 检查 Node.js 版本（推荐 22.x）
node --version  # 应输出 v22.x.x

# 检查 Rust 版本（Tauri v2 需要）
rustc --version  # 应输出 1.75+

# 检查 WebView2（Windows 必需）
# 下载安装：https://developer.microsoft.com/en-us/microsoft-edge/webview2
```

#### macOS
```bash
# 检查 Xcode Command Line Tools
xcode-select -p  # 应输出 /Applications/Xcode.app/Contents/Developer

# 检查 Rust
rustc --version

# 检查环境变量（防止 Tauri 编码问题）
echo $LANG  # 应为 zh_CN.UTF-8 或 en_US.UTF-8
```

#### Linux
```bash
# Ubuntu/Debian 依赖
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

# 检查 Rust
rustc --version
```

---

### 1.2 项目依赖安装

```bash
# 进入 Tauri 项目目录（通常在 src/desktop）
cd /d/work/java/AI-workspace/ClipSync/src/desktop

# 安装 Node.js 依赖
npm install

# 检查 Tauri CLI 是否可用
npx tauri --version  # 应输出 tauri-cli 2.x.x
```

**预期结果**：
```
✔ 依赖安装完成
✔ `npx tauri --version` 输出版本号
```

**失败处理**：
- 若 `npm install` 失败：检查 `package.json` 是否存在，检查网络连接
- 若 `npx tauri` 报错：手动安装 Tauri CLI `npm install -g @tauri-apps/cli`

---

### 1.3 测试配置文件检查

确认以下文件存在且配置正确：

```
src/desktop/
├── package.json          # 包含 test 脚本
├── src-tauri/
│   ├── Cargo.toml      # Rust 依赖配置
│   └── tauri.conf.json # Tauri 应用配置
├── src/
│   └── test/           # 测试文件目录（若不存在则创建）
└── vitest.config.js     # 测试配置（若使用 Vitest）
```

**若缺少测试配置，创建 `vitest.config.js`**：
```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.js'],
    },
  },
});
```

---

## 二、自动化测试启动命令

### 2.1 运行所有测试

```bash
# 进入项目目录
cd /d/work/java/AI-workspace/ClipSync/src/desktop

# 运行所有测试（Vitest）
npm test

# 或使用 Tauri 专用测试命令（若配置了）
npx tauri test
```

**预期结果**：
```
 ✓ src/test/clipboard_monitor.test.js (5)
 ✓ src/test/system_tray.test.js (3)
 ✓ src/test/global_shortcut.test.js (4)

Test Files  3 passed (3)
     Tests  12 passed (12)
```

---

### 2.2 运行指定测试文件

```bash
# 运行单个测试文件
npm test -- src/test/clipboard_monitor.test.js

# 运行匹配名称的测试
npm test -- -t "剪贴板监控"
```

---

### 2.3 运行测试并生成覆盖率报告

```bash
# 生成覆盖率报告
npm test -- --coverage

# 生成 HTML 覆盖率报告（在 coverage/ 目录）
npm test -- --coverage --coverage.reporter=html
```

**预期结果**：
```
 % Coverage report from v8
-----------------------|---------|----------
 File                   | % Fil | % Branch
-----------------------|---------|----------
 src/main.js             | 95.45  | 88.24
 src/clipboard_monitor.js | 92.31  | 85.71
-----------------------|---------|----------
```

---

### 2.4 监听模式（开发时自动重跑）

```bash
# 进入监听模式（文件变更后自动重跑测试）
npm test -- --watch
```

---

### 2.5 Tauri 专用集成测试（Rust）

```bash
# 进入 Rust 项目目录
cd /d/work/java/AI-workspace/ClipSync/src/desktop/src-tauri

# 运行 Rust 测试
cargo test

# 运行指定测试
cargo test -- clipboard

# 生成 Rust 覆盖率报告（需要 nightly）
cargo +nightly test --coverage
```

---

## 三、测试覆盖范围

### 3.1 UI 流程测试

| 测试场景 | 测试文件 | 覆盖内容 |
|----------|----------|----------|
| 系统托盘 | `system_tray.test.js` | 左键单击显示/隐藏、右键菜单、退出 |
| 全局快捷键 | `global_shortcut.test.js` | Ctrl+Shift+V 激活面板、快捷键自定义 |
| 快速粘贴面板 | `quick_paste_panel.test.js` | 面板显示、搜索、预览、收藏 |
| 设置页面 | `settings.test.js` | 服务器地址配置、自启动、主题切换 |
| 引导流程 | `onboarding.test.js` | 5页引导、跳过、完成 |

**示例测试代码**（`src/test/system_tray.test.js`）：
```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TauriTrayMock } from './helpers/tauri-mock.js';

describe('系统托盘集成', () => {
  let trayMock;

  beforeAll(() => {
    trayMock = new TauriTrayMock();
  });

  it('左键单击应切换窗口显示状态', async () => {
    const initialState = await trayMock.getWindowVisibility();
    await trayMock.clickLeft();
    const newState = await trayMock.getWindowVisibility();
    expect(newState).not.toBe(initialState);
  });

  it('右键菜单应包含"退出"选项', async () => {
    const menu = await trayMock.getcontextMenu();
    expect(menu).toContain('退出');
  });
});
```

---

### 3.2 业务逻辑测试

| 测试场景 | 测试文件 | 覆盖内容 |
|----------|----------|----------|
| 剪贴板监控 | `clipboard_monitor.test.js` | 100ms 轮询、500ms 去抖、变化检测 |
| 剪贴板同步 | `clipboard_sync.test.js` | 本地缓存、离线队列、冲突解决 |
| 端到端加密 | `encryption.test.js` | ECDH 密钥交换、AES 加密/解密 |
| WebSocket 连接 | `websocket.test.js` | 连接、心跳、重连、消息发送 |

**示例测试代码**（`src/test/clipboard_monitor.test.js`）：
```javascript
import { describe, it, expect, vi } from 'vitest';
import { ClipboardMonitor } from '../src/clipboard_monitor.js';

describe('剪贴板监控', () => {
  it('应在变化时触发回调', async () => {
    const monitor = new ClipboardMonitor();
    const callback = vi.fn();
    monitor.onChange(callback);

    // 模拟剪贴板变化
    monitor.simulateChange('测试文本');

    // 等待去抖（500ms）
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(callback).toHaveBeenCalledWith('测试文本');
  });

  it('去抖应避免连续复制导致雪崩', async () => {
    const monitor = new ClipboardMonitor();
    const callback = vi.fn();
    monitor.onChange(callback);

    // 连续模拟 10 次变化
    for (let i = 0; i < 10; i++) {
      monitor.simulateChange(`文本${i}`);
    }

    // 等待去抖
    await new Promise(resolve => setTimeout(resolve, 600));

    // 应只触发 1 次回调（去抖）
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
```

---

### 3.3 端到端测试（E2E）

| 测试场景 | 测试工具 | 覆盖内容 |
|----------|----------|----------|
| 完整用户旅程 | Tauri E2E Helper | 启动应用 → 复制文本 → 同步到其他设备 |
| 跨设备同步 | Mock WebSocket Server | 多设备同时在线、消息广播 |
| 安装包验证 | `tauri build` + 手动验证 | 安装、卸载、自动更新 |

**E2E 测试示例**（`src/test/e2e/sync_flow.test.js`）：
```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TauriApp } from '../helpers/tauri-app.js';
import { MockWebSocketServer } from '../helpers/mock-ws-server.js';

describe('端到端同步流程', () => {
  let app;
  let wsServer;

  beforeAll(async () => {
    wsServer = new MockWebSocketServer(8080);
    await wsServer.start();

    app = new TauriApp();
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
    await wsServer.stop();
  });

  it('设备 A 复制文本后，设备 B 应收到同步', async () => {
    // 设备 A 复制文本
    await app.deviceA.copyText('测试同步');

    // 等待同步（WebSocket 推送）
    const received = await app.deviceB.waitForClipboardChange(3000);

    expect(received).toBe('测试同步');
  });
});
```

---

## 四、测试报告查看方式

### 4.1 控制台输出

测试运行后，控制台会显示：
```
 ✓ 通过的测试（绿色）
 ✗ 失败的测试（红色）+ 错误堆栈
 ○ 跳过的测试（灰色）
```

---

### 4.2 覆盖率报告

#### HTML 报告（推荐）
```bash
# 生成并打开 HTML 报告
npm test -- --coverage --coverage.reporter=html
open coverage/index.html  # macOS
xdg-open coverage/index.html  # Linux
start coverage/index.html  # Windows
```

**报告内容**：
- 每个文件的覆盖率百分比
- 未覆盖的代码行（高亮显示）
- 分支覆盖率

---

#### JSON 报告（CI/CD 集成）
```bash
npm test -- --coverage --coverage.reporter=json
cat coverage/coverage-final.json | jq '.total.lines.pct'
```

---

### 4.3 JUnit 报告（CI/CD 集成）

修改 `vitest.config.js`：
```javascript
export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: 'test-results.xml',
  },
});
```

**用于**：
- GitHub Actions 显示测试结果
- Jenkins/Azure DevOps 集成

---

## 五、常见问题排查指引

### 5.1 测试运行时报错 `TauriInvoke is not defined`

**原因**：测试环境中无法调用 Tauri API。

**解决方法**：创建 Tauri Mock。

```javascript
// src/test/helpers/tauri-mock.js
export class TauriMock {
  static invoke(command, args) {
    return new Promise((resolve) => {
      switch (command) {
        case 'get_clipboard':
          resolve('mock-clipboard-content');
          break;
        case 'set_clipboard':
          resolve(true);
          break;
        default:
          resolve(null);
      }
    });
  }
}

// 在测试文件中使用
globalThis.__TAURI__ = TauriMock;
```

---

### 5.2 测试覆盖率偏低

**原因**：E2E 测试和 UI 测试难以覆盖。

**解决方法**：
1. 将业务逻辑抽取到独立函数/类（易于单元测试）
2. 使用 Mock 替代真实 API 调用
3. 为关键路径（加密、同步、冲突解决）编写详细测试

---

### 5.3 Rust 测试编译失败

**错误信息**：`error[E0432]: unresolved import`

**解决方法**：
```bash
# 检查 Cargo.toml 依赖是否正确
cd src-tauri
cargo check  # 快速检查依赖

# 清理缓存后重新编译
cargo clean
cargo test
```

---

### 5.4 测试运行缓慢

**原因**：Tauri 应用启动时间长。

**解决方法**：
1. 使用 Mock 替代真实 Tauri 调用
2. 将测试分为单元测试（快速）和集成测试（慢速）
3. 使用 `--testTimeout` 调整超时时间

```bash
npm test -- --testTimeout=10000  # 10 秒超时
```

---

### 5.5 CI/CD 中测试失败

**原因**：CI 环境无显示器（无法启动 GUI）。

**解决方法**：使用虚拟显示器（Xvfb）。

```yaml
# .github/workflows/test.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Install xvfb
        run: sudo apt-get install -y xvfb

      - name: Run tests with virtual display
        run: |
          Xvfb :99 -screen 0 1024x768x24 &
          export DISPLAY=:99
          npm test
```

---

## 附录：测试命令速查表

| 命令 | 说明 |
|------|------|
| `npm test` | 运行所有测试 |
| `npm test -- --watch` | 监听模式（自动重跑） |
| `npm test -- --coverage` | 生成覆盖率报告 |
| `npm test -- -t "名称"` | 运行匹配名称的测试 |
| `npm test -- --reporter=verbose` | 详细输出模式 |
| `cargo test` | 运行 Rust 测试 |
| `npx tauri build` | 构建生产版本（可用于验证打包） |

---

**文档版本**：1.0  
**创建日期**：2026-06-29  
**作者**：ClipSync Development Team  
**更新日志**：
- 2026-06-29：初始版本
