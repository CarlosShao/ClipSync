# Tauri 桌面端全流程自动化测试文档

> **文档版本**: v1.1（已根据实际项目结构修正）  
> **适用平台**: Windows / Linux（macOS/iOS 已搁置）  
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
# 检查 Node.js 版本（需要 18+）
node --version

# 检查 Rust 版本（需要 1.70+）
rustc --version

# 检查 Tauri CLI
cd D:/work/java/AI-workspace/ClipSync/src/desktop
npx tauri --version
```

**预期结果**：
```
node v22.x.x
rustc 1.7x.x
tauri-cli 2.x.x
```

**失败处理**：
- 若 `npx tauri` 失败：运行 `npm install` 安装依赖
- 若 `rustc` 未找到：安装 Rust（https://www.rust-lang.org/tools/install）
- 若 WebView2 缺失：下载 [WebView2 Evergreen Bootstrapper](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

#### Linux

```bash
# 检查依赖
rustc --version
node --version
pkg-config --version
libwebkit2gtk-4.1-dev  # 需要安装：sudo apt install libwebkit2gtk-4.1-dev
```

---

### 1.2 项目依赖安装

```bash
# 进入 Tauri 项目目录
cd D:/work/java/AI-workspace/ClipSync/src/desktop

# 安装 Node.js 依赖
npm install

# 检查 Cargo 依赖
cd src-tauri
cargo check
cd ..
```

**预期结果**：
```
added XXX packages in Xs
   Compiling clipsync-desktop v0.1.0
```

**失败处理**：
- 若 `cargo check` 失败：检查 `src-tauri/Cargo.toml` 依赖，运行 `cargo update`
- 若网络问题：设置 Cargo 镜像 `setx CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse`

---

### 1.3 测试配置文件检查

确认以下文件存在且配置正确：

```
src/desktop/
├── package.json              # 包含 test 脚本
├── src-tauri/
│   ├── Cargo.toml          # Rust 依赖配置
│   ├── Cargo.lock          # 依赖锁定文件
│   ├── tauri.conf.json    # Tauri 配置文件
│   └── src/
│       ├── main.rs         # Tauri 入口
│       ├── lib.rs          # Tauri 命令导出
│       ├── clipboard_monitor.rs  # 剪贴板监控（真实存在）
│       ├── crypto.rs       # 加密模块（真实存在）
│       └── sync_client.rs # 同步客户端（真实存在）
```

**若缺少测试配置，添加到 `package.json`**：
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "tauri:test": "cargo test --manifest-path src-tauri/Cargo.toml"
  }
}
```

---

### 1.4 Rust 测试准备

```bash
# 进入 Rust 项目目录
cd D:/work/java/AI-workspace/ClipSync/src/desktop/src-tauri

# 运行所有 Rust 测试（需要先编译）
cargo test --no-run 2>&1 | head -20

# 若编译失败，检查 Rust 工具链
rustup show
```

**预期结果**：
```
Compiling clipsync-desktop v0.1.0
Finished test [unoptimized + debuginfo] target(s)
```

---

## 二、自动化测试的启动命令与参数说明

### 2.1 运行前端（JavaScript/TypeScript）测试

```bash
# 进入项目目录
cd D:/work/java/AI-workspace/ClipSync/src/desktop

# 运行所有前端测试（Vitest）
npm test

# 或使用 npx
npx vitest run
```

**预期结果**：
```
 ✓ src/test/clipboard_monitor.test.js (3)
 ✓ src/test/crypto.test.js (5)
 × src/test/sync_client.test.js (2)  ← 若文件不存在会报错
```

**参数说明**：
- `vitest run`：运行所有测试，不进入监听模式
- `vitest`（无参数）：进入监听模式，文件变更后自动重跑
- `--reporter=verbose`：显示每个测试用例名称
- `--coverage`：生成覆盖率报告

---

### 2.2 运行 Rust 测试

```bash
# 进入 Rust 项目目录
cd D:/work/java/AI-workspace/ClipSync/src/desktop/src-tauri

# 运行所有 Rust 测试
cargo test

# 运行指定模块的测试
cargo test clipboard_monitor

# 运行单个测试函数
cargo test test_clipboard_change_detected

# 显示输出（println! 内容）
cargo test -- --nocapture
```

**预期结果**：
```
running 3 tests
test clipboard_monitor::tests::test_change_detected ... ok
test crypto::tests::test_encrypt_decrypt ... ok
test sync_client::tests::test_ws_connect ... ok

test result: ok. 3 passed; 0 failed
```

**参数说明**：
- `cargo test`：编译并运行所有测试
- `cargo test --no-run`：只编译不运行（检查编译错误）
- `cargo test -- --nocapture`：显示测试中的 println! 输出
- `cargo test --release`：在 release 模式下运行测试

---

### 2.3 运行指定测试文件

```bash
# 前端：运行单个测试文件
npx vitest run src/test/clipboard_monitor.test.js

# Rust：运行指定模块的所有测试
cargo test clipboard_monitor::

# Rust：运行匹配名称的测试
cargo test -- change_detected
```

---

### 2.4 生成测试覆盖率报告

#### 前端覆盖率（Vitest + V8）

```bash
# 生成覆盖率报告
cd D:/work/java/AI-workspace/ClipSync/src/desktop
npx vitest run --coverage

# 查看 HTML 报告
start coverage/index.html  # Windows
```

**预期结果**：
```
 % Coverage report
 --------------|---------
 File          | % Stmts
 --------------|---------
 clipboard.ts |  85.71
 crypto.ts     |  92.30
 --------------|---------
 All files     |  88.23
```

#### Rust 覆盖率（需要 nightly 工具链）

```bash
# 安装 nightly（若未安装）
rustup toolchain install nightly

# 生成覆盖率（需要 cargo-tarpaulin）
cargo install cargo-tarpaulin

# 生成 HTML 报告
cd D:/work/java/AI-workspace/ClipSync/src/desktop/src-tauri
cargo tarpaulin --out html
start tarpaulin-report.html  # Windows
```

---

### 2.5 监听模式（开发时自动重跑）

```bash
# 前端：进入监听模式
cd D:/work/java/AI-workspace/ClipSync/src/desktop
npx vitest

# Rust：使用 cargo-watch（需要先安装）
cargo install cargo-watch
cd src-tauri
cargo watch -x test
```

---

### 2.6 CI/CD 中运行测试

#### GitHub Actions 示例（`.github/workflows/tauri-test.yml`）

```yaml
name: Tauri Tests

on: [push, pull_request]

jobs:
  test-frontend:
    name: "Frontend Tests"
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: |
          cd src/desktop
          npm install

      - name: Run frontend tests
        run: |
          cd src/desktop
          npx vitest run --coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: src/desktop/coverage/coverage-final.json

  test-rust:
    name: "Rust Tests"
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Cache Cargo dependencies
        uses: actions/cache@v4
        with:
          path: |
            src/desktop/src-tauri/target
            C:\Users\runneradmin\.cargo\registry
          key: ${{ runner.os }}-cargo-${{ hashFiles('src/desktop/src-tauri/Cargo.lock') }}

      - name: Run Rust tests
        run: |
          cd src/desktop/src-tauri
          cargo test --verbose

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: rust-test-results
          path: src/desktop/src-tauri/target/debug/deps/*.exe
```

---

## 三、测试覆盖范围

### 3.1 前端测试（JavaScript/TypeScript）

> **注意**：以下测试文件目前可能不存在，需要根据实际代码创建。

| 测试场景 | 测试文件（待创建） | 覆盖内容 |
|----------|----------------------|----------|
| 剪贴板监控 | `src/test/clipboard_monitor.test.js` | 变化检测、去重、防抖 |
| 加密模块 | `src/test/crypto.test.js` | ECDH 密钥交换、AES 加密/解密 |
| WebSocket 客户端 | `src/test/sync_client.test.js` | 连接、心跳、重连、消息发送 |
| 系统托盘 | `src/test/tray.test.js` | 托盘菜单、快捷操作 |

**示例测试代码**（`src/test/clipboard_monitor.test.js` 待创建）：
```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { ClipboardMonitor } from '../src/clipboard_monitor.js';

describe('ClipboardMonitor', () => {
  let monitor;

  beforeEach(() => {
    monitor = new ClipboardMonitor();
  });

  it('should detect clipboard change', async () => {
    const oldText = 'old content';
    const newText = 'new content';

    const result = await monitor.checkChange(oldText, newText);

    expect(result).toBe(true);
    expect(monitor.lastContent).toBe(newText);
  });

  it('should debounce rapid changes', async () => {
    const changes = [];
    monitor.onChange = (content) => changes.push(content);

    // 模拟快速变化
    await monitor.checkChange('', 'a');
    await monitor.checkChange('a', 'ab');
    await monitor.checkChange('ab', 'abc');

    // 等待防抖
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(changes.length).toBeLessThan(3);  // 防抖生效
  });
});
```

---

### 3.2 Rust 测试（后端逻辑）

> **注意**：以下测试函数需要手动添加到对应的 `.rs` 文件中。

| 测试场景 | 测试文件（真实存在） | 覆盖内容 |
|----------|----------------------|----------|
| 剪贴板监控 | `src-tauri/src/clipboard_monitor.rs` | 变化检测、内容过滤 |
| 加密模块 | `src-tauri/src/crypto.rs` | 密钥生成、加密/解密 |
| 同步客户端 | `src-tauri/src/sync_client.rs` | WebSocket 连接、消息序列化 |
| 命令导出 | `src-tauri/src/lib.rs` | Tauri 命令调用 |

**示例测试代码**（需要添加到 `src-tauri/src/crypto.rs`）：
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt() {
        let key = generate_key();
        let plaintext = "Hello, ClipSync!";

        let encrypted = encrypt(plaintext, &key).unwrap();
        let decrypted = decrypt(&encrypted, &key).unwrap();

        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_key_exchange() {
        let (pub_key, priv_key) = generate_keypair();

        // 模拟 ECDH 密钥交换
        let shared_secret = derive_shared_secret(&pub_key, &priv_key).unwrap();

        assert!(!shared_secret.is_empty());
    }
}
```

**如何运行 Rust 测试**：
```bash
cd D:/work/java/AI-workspace/ClipSync/src/desktop/src-tauri
cargo test
```

---

### 3.3 E2E 测试（Tauri 应用启动）

> **当前状态**：E2E 测试框架尚未配置，以下为推荐方案。

#### 方案一：使用 `@tauri-apps/test`（官方推荐）

```bash
# 安装测试依赖
cd D:/work/java/AI-workspace/ClipSync/src/desktop
npm install --save-dev @tauri-apps/test
```

创建 `src/test/e2e/app.test.js`：
```javascript
import { expect, test } from '@tauri-apps/test';

test('应用应正常启动', async ({ page }) => {
  // 等待应用加载
  await page.waitForLoadState('networkidle');

  // 验证窗口标题
  const title = await page.title();
  expect(title).toBe('ClipSync');
});
```

运行 E2E 测试：
```bash
npx tauri test  # 会自动启动应用并运行测试
```

#### 方案二：使用 Spectron（旧版，不推荐）

```bash
npm install --save-dev spectron
```

---

## 四、测试报告的查看方式

### 4.1 控制台输出

测试运行后，控制台会显示：
```
 ✓ passed (12)
 × failed (3)
 ○ skipped (2)
```

- `✓ passed`：通过的测试数
- `× failed`：失败的测试数
- `○ skipped`：跳过的测试数

---

### 4.2 前端覆盖率报告（Vitest）

```bash
# 生成覆盖率
cd D:/work/java/AI-workspace/ClipSync/src/desktop
npx vitest run --coverage

# 查看 HTML 报告
start coverage/index.html
```

**报告内容**：
- 每个文件的覆盖率百分比
- 未覆盖的代码行（高亮显示）
- 分支覆盖率

---

### 4.3 Rust 测试报告

```bash
# 运行测试并显示详细输出
cd D:/work/java/AI-workspace/ClipSync/src/desktop/src-tauri
cargo test -- --nocapture
```

**输出示例**：
```
running 3 tests
test crypto::tests::test_encrypt_decrypt ... ok
test crypto::tests::test_key_exchange ... FAILED
test clipboard_monitor::tests::test_change_detected ... ok

failures:

---- crypto::tests::test_key_exchange stdout ----
thread 'main' panicked at 'assertion failed', src/crypto.rs:42
note: run with `RUST_BACKTRACE=1` for a backtrace
```

---

### 4.4 JUnit 报告（CI/CD 集成）

#### 前端测试：Vitest 生成 JUnit 报告

```bash
# 安装 junit 报告器
npm install --save-dev vitest-junit-reporter

# 生成 JUnit 报告
npx vitest run --reporter=junit --outputFile=test-results.xml
```

#### Rust 测试：cargo 原生支持 JSON 输出

```bash
cd D:/work/java/AI-workspace/ClipSync/src/desktop/src-tauri
cargo test --format=json > test-results.json
```

---

## 五、常见问题排查指引

### 5.1 `cargo test` 编译失败

**错误信息**：`error[E0432]: unresolved import`

**原因**：依赖未正确安装或 `Cargo.toml` 配置错误。

**解决方法**：
```bash
# 清理缓存并重新安装
cd D:/work/java/AI-workspace/ClipSync/src/desktop/src-tauri
cargo clean
cargo update
cargo check
```

---

### 5.2 `npx tauri` 命令未找到

**错误信息**：`command not found: tauri`

**原因**：`@tauri-apps/cli` 未安装或 `node_modules/` 缺失。

**解决方法**：
```bash
cd D:/work/java/AI-workspace/ClipSync/src/desktop
npm install
npx tauri --version  # 验证安装
```

---

### 5.3 WebView2 缺失（Windows）

**错误信息**：`WebView2 runtime not found`

**解决方法**：
1. 下载 [WebView2 Evergreen Bootstrapper](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
2. 以管理员权限运行安装程序
3. 重启终端，重新运行测试

---

### 5.4 Rust 测试运行时报 `tauri::test` 模块找不到

**原因**：Tauri 2.x 的测试模块需要手动启用。

**解决方法**：在 `src-tauri/Cargo.toml` 中添加：
```toml
[dev-dependencies]
tauri = { version = "2", features = ["test"] }
```

---

### 5.5 测试覆盖率偏低

**原因**：Rust 的某些模块（如系统托盘、全局快捷键）难以单元测试。

**解决方法**：
1. 将业务逻辑抽取到纯 Rust 函数（易于测试）
2. 使用 `#[cfg(test)] mod tests` 为关键路径编写详细测试
3. 使用 `mockall` 库 Mock 外部依赖

---

### 5.6 `cargo test` 运行缓慢

**原因**：Rust 编译时间长，每次运行都重新编译。

**解决方法**：
```bash
# 使用 cargo-watch 监听文件变化
cargo install cargo-watch
cargo watch -x test

# 或使用 nextest（更快的测试运行器）
cargo install cargo-nextest
cargo nextest run
```

---

## 附录：测试命令速查表

| 命令 | 说明 |
|------|------|
| `npx vitest run` | 运行所有前端测试 |
| `npx vitest` | 监听模式（自动重跑） |
| `npx vitest run --coverage` | 生成覆盖率报告 |
| `cargo test` | 运行所有 Rust 测试 |
| `cargo test --no-run` | 只编译不运行 |
| `cargo test -- --nocapture` | 显示 println! 输出 |
| `cargo tarpaulin --out html` | 生成 Rust 覆盖率报告（需要 nightly） |
| `npx tauri test` | 运行 E2E 测试（需要配置） |

---

## 当前测试状态（真实）

### 已存在的测试文件
- ❌ 前端：`src/test/*.test.js` — **不存在，需要创建**
- ❌ Rust：`src-tauri/src/*/tests.rs` — **不存在，需要手动添加测试模块**

### 已存在的源代码文件（可以为其编写测试）
- ✅ `src-tauri/src/clipboard_monitor.rs`
- ✅ `src-tauri/src/crypto.rs`
- ✅ `src-tauri/src/sync_client.rs`
- ✅ `src-tauri/src/lib.rs`

### 下一步建议
1. 为 `crypto.rs` 添加 `#[cfg(test)]` 测试模块（最高优先级，加密逻辑必须测试）
2. 为 `clipboard_monitor.rs` 添加测试（剪贴板监控是核心功能）
3. 创建前端测试文件 `src/test/crypto.test.js`（测试 JavaScript 加密封装）

---

**文档版本**：1.1（已修正）  
**创建日期**：2026-06-29  
**修正日期**：2026-06-29（移除虚构路径和 Apple 平台内容）  
**作者**：ClipSync Development Team  
**更新日志**：
- 2026-06-29：初始版本（v1.0）
- 2026-06-29：修正版本（v1.1）— 移除所有虚构测试文件路径，移除 Apple 平台内容，标注真实存在的文件
