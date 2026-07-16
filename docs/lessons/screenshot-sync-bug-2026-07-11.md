# 截图同步 Bug 修复教训记录

## 时间
2026-07-11

## 症状
- 截图同步速度极慢（每张 200-500ms+）
- 连续快速截图 4 次，只同步 2 张或 1 张
- 诊断计数器显示 `events.total = 0`（Tauri 事件从未到达前端）

## 根因（逐层深挖）

### 第一层（表面）
- 前端 `listen` 回调用了 `await`，导致事件串行化
- 前端 `processClipboardQueue` 对图片类型 `await`，串行上传

### 第二层（Tauri 事件系统）
- Rust `app.emit("clipboard-changed", ...)` 从后台线程 emit
- Tauri 2.x 的事件通道在 async runtime 上，后台线程 emit 不可靠
- 加了 `core:event:default` 权限也没用
- 加了 `tauri::async_runtime::spawn` 也没用
- **结论：Tauri 2.x 事件系统从非主线程 emit 完全不工作**

### 第三层（真正的根因）
- **580e6df 的 Rust monitor 循环停止条件 inverted**：
  ```rust
  // WRONG: is_monitoring=true 时退出
  if stop_flag.load(Ordering::Relaxed) { break; }
  ```
  `is_monitoring = true` 表示"正在运行"，但代码在 true 时退出。
  导致 monitor 线程启动后**立即退出**。

- 580e6df 之前截图"正常"的原因：
  - Rust monitor 从来没运行过
  - 实际在工作的是 **JS fallback poll（每10秒）**
  - 10 秒轮询只检测"当前剪贴板内容"，快速截图中间态全部丢失
  - 用户感知为"慢 + 丢图"，但误以为"正常"

### 第四层（我犯的错误）
1. 回滚到 580e6df 后，没有验证 monitor 是否真的在运行
2. 在 monitor 不运行的情况下，反复改前端代码（事件处理、去重、并行上传）
3. 加了诊断计数器但 `events.total = 0`，仍然没意识到是 Rust 端问题
4. 被"应该能恢复"这种猜测误导，没有逐行审查代码

## 修复
只改了一行：
```rust
// 修复前（WRONG）
if stop_flag.load(Ordering::Relaxed) { break; }

// 修复后（CORRECT）
if !stop_flag.load(Ordering::Relaxed) { break; }
```

commit: `a7f9613`

## 验证方法
1. Rust 终端看到 `[ClipMon] change detected (windows alive)` — monitor 在运行
2. Rust 终端看到 `[ClipMon] IMAGE: ... emit` — 图片被 emit 到前端
3. 快速截 4 张图，前端出现 4 张 — 完整同步

## 教训

### 1. 回滚前必须验证回滚版本的正确性
- 不能假设"之前正常"就一定是正确的
- 回滚后要逐行审查关键逻辑（如 stop_flag 语义）

### 2. 诊断数据必须追到源头
- `events.total = 0` 的根因是 Rust 端，不是前端
- 应该第一时间检查 Rust monitor 是否在运行，而不是改前端代码

### 3. AtomicBool 的语义必须明确
- `true` 表示什么？`false` 表示什么？
- 所有引用该变量的人必须达成一致
- 建议命名：`should_stop` 而非 `is_monitoring`，避免歧义

### 4. 不要猜测，要验证
- "应该能恢复" → 不，要确认代码逻辑正确
- "可能 X 问题" → 不，要加日志确认是 X 还是 Y
- 每次修改后必须验证效果，而不是假设

### 5. 修改范围要最小化
- 只改一行就只改一行
- 不要一次改 7 个文件、600 行代码
- 改完一处验证一处

## 防止再犯
- 下次修改 Rust monitor 时，先检查 stop_flag 的语义是否正确
- 加 `[ClipMon] HB:` 心跳日志，每 1.5s 输出一次，确认 monitor 存活
- 不要再用 `is_monitoring` 这种歧义命名，改用 `should_stop`
