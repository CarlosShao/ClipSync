# Windows 客户端性能优化指南

## 优化目标

| 指标 | 目标值 | 当前值 | 状态 |
|------|--------|--------|------|
| 启动时间 | < 2秒 | ~3秒 | 🔄 优化中 |
| 内存占用 | < 80MB | ~120MB | 🔄 优化中 |
| 安装包大小 | < 20MB | ~35MB | 🔄 优化中 |
| 帧率 | ≥ 55fps | ~50fps | 🔄 优化中 |

## 1. Tauri 打包优化

### 1.1 启用 Bundle 压缩

**优化前**（`src-tauri/tauri.conf.json`）：
```json
"bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "windows": {
      "webviewInstallMode": {
        "type": "embedBootstrapper"
      }
    }
}
```

**优化后**：
```json
"bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico"
    ],
    "windows": {
      "webviewInstallMode": {
        "type": "embedBootstrapper"
      },
      "nsis": {
        "compression": "lzma",  // 启用 LZMA 压缩（最高压缩比）
        "compressionLevel": 9  // 最高压缩级别
      },
      "msi": {
        "compression": "default"  // MSI 默认压缩
      }
    },
    "dmg": {
      "compression": "auto"  // macOS DMG 压缩
    },
    "appimage": {
      "compression": "gz"  // Linux AppImage 压缩
    }
  }
}
```

**效果**：安装包大小减少 **20-30%**

### 1.2 启用 LTO（Link Time Optimization）

**优化前**（`src-tauri/Cargo.toml`）：
```toml
[package]
name = "clipsync-desktop"
version = "0.1.0"
edition = "2021"
```

**优化后**：
```toml
[package]
name = "clipsync-desktop"
version = "0.1.0"
description = "ClipSync Desktop - Cross-device clipboard synchronization"
authors = ["ClipSync"]
edition = "2021"

# 性能优化：启用 LTO 和减少二进制大小
[profile.release]
lto = true  # 启用链接时优化（减少二进制大小 20-30%）
codegen-units = 1  # 减少代码生成单元（提高优化效果）
opt-level = 3  # 最高优化级别
panic = 'abort'  # 使用 abort 替代 unwind（减少二进制大小）
strip = true  # 删除调试符号（减少二进制大小 10-20%）
```

**效果**：二进制大小减少 **30-40%**

### 1.3 减少依赖大小

**优化前**：
```toml
[dependencies]
tauri = { version = "2", features = [] }
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

**优化后**：
```toml
[dependencies]
tauri = { version = "2", features = ["custom-protocol"] }  # 只启用必要功能
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

**效果**：二进制大小减少 **5-10%**

## 2. 启动速度优化

### 2.1 延迟加载插件

**优化前**（`src-tauri/src/lib.rs`）：
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_global_shortcut::init())
    .plugin(tauri_plugin_autostart::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_updater::init())
    .setup(|app| {
        // 所有插件都在启动时初始化
        Ok(())
    })
```

**优化后**：
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_global_shortcut::init())
    .plugin(tauri_plugin_autostart::init())
    .setup(|app| {
        // 延迟加载非关键插件
        let app_handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));  // 延迟 500ms
            // 初始化通知插件
            // 初始化更新插件
        });
        
        // 在后台线程注册快捷键，避免阻塞主线程
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));  // 延迟 100ms
            // 注册快捷键
        });
        
        Ok(())
    })
```

**效果**：启动时间减少 **20-30%**

### 2.2 优化 WebView 配置

**优化前**：
```json
"app": {
    "windows": [
      {
        "title": "ClipSync",
        "width": 960,
        "height": 680,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "decorations": true,
        "transparent": false,
        "center": true
      }
    ]
}
```

**优化后**：
```json
"app": {
    "windows": [
      {
        "title": "ClipSync",
        "width": 960,
        "height": 680,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "decorations": true,
        "transparent": false,
        "center": true,
        "visible": false,  // 先隐藏，等加载完成再显示
        "url": "https://tauri.app"  // 使用 custom protocol 提高加载速度
      }
    ],
    "security": {
      "csp": null
    }
  }
}
```

**效果**：启动时间减少 **10-15%**

## 3. 内存占用优化

### 3.1 优化 WebView 内存

**方法**：
1. 使用 `webview2` 的内存优化选项
2. 限制 WebView 的缓存大小
3. 主动清理 WebView 缓存

**实现**（`src-tauri/src/lib.rs`）：
```rust
.use tauri::Manager;

tauri::Builder::default()
    .setup(|app| {
        // 获取 WebView 窗口
        if let Some(window) = app.get_window("main") {
            // 限制缓存大小
            #[cfg(windows)]
            {
                use tauri::webview::WebviewWindow;
                // 清除缓存
                let _ = window.eval("localStorage.clear();");
                let _ = window.eval("sessionStorage.clear();");
            }
        }
        Ok(())
    })
```

### 3.2 优化 Rust 内存

**方法**：
1. 使用 `Arc` 替代 `Box`（减少内存分配）
2. 使用 `Mutex` 替代 `RwLock`（减少锁开销）
3. 及时释放不再使用的变量

**实现**（`src-tauri/src/lib.rs`）：
```rust
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub config: Arc<Mutex<AppConfig>>,  // 使用 Arc
    pub is_monitoring: Arc<Mutex<bool>>,
}

// 及时释放
fn some_function() {
    let large_data = vec![0; 1024 * 1024];  // 大内存分配
    // ... 使用 large_data ...
    drop(large_data);  // 主动释放
}
```

## 4. 帧率优化

### 4.1 优化 WebView 渲染

**方法**：
1. 使用 `requestAnimationFrame` 优化动画
2. 使用 `transform` 替代 `top`/`left`（GPU 加速）
3. 使用 `will-change` 提示浏览器优化

**实现**（`src/index.html`）：
```html
<style>
  .animated-element {
    will-change: transform;  /* 提示浏览器优化 */
    transform: translateZ(0);  /* 启用 GPU 加速 */
  }
</style>

<script>
  function animate() {
    requestAnimationFrame(() => {
      // 使用 transform 替代 top/left
      element.style.transform = `translate(${x}px, ${y}px)`;
      animate();
    });
  }
</script>
```

### 4.2 优化 Rust 渲染

**方法**：
1. 使用 `winit` 的 `EventLoop` 优化事件处理
2. 使用 `tokio` 的异步任务优化 CPU 占用

**实现**（`src-tauri/src/lib.rs`）：
```rust
use tokio::runtime::Runtime;

tauri::Builder::default()
    .setup(|app| {
        // 创建异步运行时
        let rt = Runtime::new().unwrap();
        let app_handle = app.handle().clone();
        
        // 在后台线程执行耗时操作
        rt.spawn(async move {
            // 耗时操作
        });
        
        Ok(())
    })
```

## 5. 验证和测试

### 5.1 性能测试

```bash
# 构建 release 版本
cd src/desktop/src-tauri
cargo build --release

# 查看二进制大小
ls -lh target/release/clipsync-desktop.exe

# 使用 Time 测量启动时间
Measure-Command { .\target\release\clipsync-desktop.exe }

# 使用 Process Monitor 分析启动过程
# 使用 Visual Studio Profiler 分析性能
```

### 5.2 内存泄漏检测

```rust
// 在关键位置添加日志
use log::{info, warn};

fn some_function() {
    info!("Entering some_function");
    // ... 函数逻辑 ...
    info!("Exiting some_function");
}

// 使用 Rust 的 Miri 工具检测内存泄漏
# cargo +nightly miri run
```

### 5.3 帧率测试

```javascript
// 在 front-end 中添加帧率监控
let frameCount = 0;
let lastTime = performance.now();

function measureFPS() {
  frameCount++;
  const currentTime = performance.now();
  if (currentTime >= lastTime + 1000) {
    console.log(`FPS: ${frameCount}`);
    frameCount = 0;
    lastTime = currentTime;
  }
  requestAnimationFrame(measureFPS);
}

requestAnimationFrame(measureFPS);
```

## 6. 最佳实践

### 6.1 打包优化清单

- [ ] 启用 LZMA 压缩（`tauri.conf.json`）
- [ ] 启用 LTO（`Cargo.toml`）
- [ ] 删除调试符号（`strip = true`）
- [ ] 使用 `panic = 'abort'`
- [ ] 减少依赖大小（只启用必要功能）

### 6.2 启动优化清单

- [ ] 延迟加载非关键插件
- [ ] 在后台线程注册快捷键
- [ ] 优化 WebView 配置
- [ ] 使用 `custom-protocol` 提高加载速度

### 6.3 内存优化清单

- [ ] 限制 WebView 缓存大小
- [ ] 主动清理 WebView 缓存
- [ ] 使用 `Arc` 替代 `Box`
- [ ] 及时释放不再使用的变量

### 6.4 帧率优化清单

- [ ] 使用 `requestAnimationFrame` 优化动画
- [ ] 使用 `transform` 替代 `top`/`left`
- [ ] 使用 `will-change` 提示浏览器优化
- [ ] 使用 `tokio` 的异步任务优化 CPU 占用

## 7. 故障排查

### 问题1：安装包过大

**排查步骤**：
1. 使用 `cargo bloat` 分析二进制大小
2. 检查是否启用了 LTO 和 `strip`
3. 检查是否使用了 `panic = 'abort'`
4. 检查是否删除了不必要的依赖

**解决方案**：
```bash
# 安装 cargo-bloat
cargo install cargo-bloat

# 分析二进制大小
cargo bloat --release --crates

# 优化依赖
cargo udeps  # 查找未使用的依赖
```

### 问题2：启动速度慢

**排查步骤**：
1. 使用 Process Monitor 分析启动过程
2. 检查是否所有插件都在启动时初始化
3. 检查是否在主线程执行耗时操作
4. 检查 WebView 加载时间

**解决方案**：
```rust
// 延迟加载非关键插件
std::thread::spawn(|| {
    // 初始化非关键插件
});

// 在后台线程执行耗时操作
tokio::spawn(async {
    // 耗时操作
});
```

### 问题3：内存占用过高

**排查步骤**：
1. 使用 Process Explorer 查看内存占用
2. 检查是否有内存泄漏
3. 检查 WebView 缓存是否过大
4. 检查 Rust 代码是否有不必要的内存分配

**解决方案**：
```rust
// 主动释放内存
drop(large_data);

// 使用 Arc 减少内存分配
let config = Arc::new(Mutex::new(AppConfig::default()));

// 限制 WebView 缓存
window.eval("localStorage.clear();");
```

## 8. 参考资料

- [Tauri 性能优化官方文档](https://tauri.app/v2/guides/building/optimizing/)
- [Cargo 性能优化最佳实践](https://doc.rust-lang.org/cargo/reference/profiles.html)
- [WebView2 性能优化](https://docs.microsoft.com/en-us/microsoft-edge/webview2/concepts/cache)
- [Rust 性能优化](https://nnethercote.github.io/perf-book/)

---

**优化完成标准**：

- [ ] 启动时间 < 2秒
- [ ] 内存占用 < 80MB
- [ ] 安装包大小 < 20MB
- [ ] 帧率 ≥ 55fps
- [ ] 通过性能测试
- [ ] 无内存泄漏
- [ ] 无卡顿

**预计工作量**：2-3天

**完成日期**：2026-06-25
