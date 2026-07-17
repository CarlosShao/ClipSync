# ClipSync 桌面端并发控制深度审核报告

> 审核范围：`src/desktop/src`（Vue3 前端）+ `src/desktop/src-tauri/src`（Rust 后端）
> 触发背景：修复"快速连续复制两个文件只同步一个"（上传队列竞态）后，全面排查其他同类隐患。
> 标注：✅ = 已逐行亲自核实；🔎 = 子代理报告、逻辑成立待复核。

---

## 一、优先级总览

| # | 位置 | 问题 | 级别 | 核实 |
|---|------|------|------|------|
| P1-1 | `utils/offlineQueue.ts` | 离线队列 `enqueue` 与 `flushQueue` 竞态 → **静默丢数据** | P1 | ✅ |
| P1-2 | `QuickPasteStandalone.vue` + `HomeView.vue` | 主窗口与 QP 窗口各自监控剪贴板 → **重复上传** | P1 | ✅ |
| P1-3 | `clipboard_monitor.rs` / `lib.rs` | `stop_clipboard_monitor` 是空操作，监控永不停、崩溃后无法重启 | P1 | ✅ |
| P1-4 | `lib.rs:88` `update_config` | 整体覆盖 `AppConfig`，与 `login` 抢写 → **token 被抹→静默登出** | P1(潜伏) | ✅ |
| P1-5 | `composables/useNotifications.ts` | `pushRealtime` 在 `loadHistory` 期间到达 → **通知被覆盖丢失** | P1 | 🔎 |
| P2-1 | `stores/configStore.ts` `save()` | 非原子 read-modify-write，无串行化 | P2(潜伏) | 🔎 |
| P2-2 | `api/client.ts` `getCsrfToken` | CSRF 缓存失效瞬间并发重取，无 in-flight 合并、无 403 重试 | P2 | 🔎 |
| P2-3 | `composables/useWebSocket.ts` | `handlers` 模块级共享 + `connect` 未关旧 socket → 重挂后消息双处理 | P2 | 🔎 |
| P2-4 | `useClipboard.ts` `startPolling` | 重复调用会泄漏 listener + 叠加 `setInterval` | P2 | 🔎 |
| P2-5 | `useClipboard.ts` 列表状态 | 乐观项 + 服务器响应 + WS 推送并发改 `items.value` → 闪烁/丢乐观项 | P2 | 🔎 |
| P2-6 | `lib.rs` `ensure_quick_paste_window` | 销毁+重建无互斥（TOCTOU），并发入口可致窗口创建失败 | P2 | 🔎 |
| P2-7 | `lib.rs` 托盘"快速粘贴" | 绕过 `last_qp_toggle` 防抖，与快捷键线程并发进重建 | P2 | 🔎 |
| P2-8 | `lib.rs` `toggle_window` | 主窗口可见性 read-modify-write 无锁，多入口并发抖动 | P2 | 🔎 |
| P2-9 | `clipboard_monitor.rs` | 图片按 size / 文件按 path 去重 → 相同尺寸/路径**重复复制被静默丢弃** | P2 | ✅ |
| P2-10 | `clipboard_monitor.rs` vs 命令 | 监控线程与 get/set 命令并发 `OpenClipboard` → Windows 独占瞬时失败 | P2 | 🔎 |
| P3-1 | `utils/perfMonitor.ts` / `errorReport.ts` | 无单例守卫，HMR 下叠加定时器/监听（仅开发环境） | P3 | 🔎 |
| P3-2 | `ModalManager.vue` / `AuthPage.vue` 倒计时 | `sendCode` 未清旧 interval，卸载不清理 → 双速倒计时/泄漏 | P3 | 🔎 |
| P3-3 | `useNotifications.ts` `markAllRead` | 回滚条件 `!n.read` 恒 false → 失败永不回滚（非并发） | P3 | 🔎 |

---

## 二、P1 详情（建议尽快修）

### P1-1 离线队列静默丢数据
**文件**：`utils/offlineQueue.ts:48-58`（enqueue）vs `61-103`（flushQueue）
`flushQueue` 在 67 行加载队列快照，经历网络 await（77-79 行），最后 92-93 行 `saveQueue(remaining)` **盲写覆盖**。而 `enqueue` 独立 `loadQueue→push→saveQueue`，**没有检查 `flushing` 标志**。
**竞态**：离线时复制内容 → `enqueue` 写入；同时重连触发 `flushQueue`。若 `enqueue` 发生在 flush 读取快照之后、`saveQueue(remaining)` 之前，新入队动作被覆盖删除，**永久丢失**。
**修法**：`enqueue` 也纳入串行（读改写在同一 tick 完成），或 flush 结束前重新 `loadQueue` 合并新增项再写。

### P1-2 双窗口重复监控
**文件**：`QuickPasteStandalone.vue:41` 与 `HomeView.vue`(≈81) 都调 `clip.startPolling`
两个窗口是**独立 webview = 独立 JS 上下文 = 独立模块状态**。Rust `emit('clipboard-changed')` 不指定目标 → **广播到所有窗口**。QP 窗口打开时（全局快捷键常态），两窗口各自入队上传，`recentUploadHashes`/队列跨上下文无法互相去重。文件类型后端能兜底去重，但**文本/链接/图片会无条件重复**。
**修法**：只允许一个"owner"上下文运行监控（QP 窗口不 `startPolling`，仅 `refresh` 读列表）；或加机器级去重键。

### P1-3 停止监控是空操作
**文件**：`clipboard_monitor.rs:20-32`（`start_monitor` 是 `loop{}`，且函数只接 `app_handle`，**根本拿不到 `is_monitoring`**）；`lib.rs:824-832`（`stop` 只置标志）
循环体从不读标志 → `stop_clipboard_monitor` 无效，"隐私模式/暂停同步"形同虚设。且监控线程一旦 panic 退出，`is_monitoring` 仍为 true → `start` 判断直接 return → **永久无法重启**。
**修法**：用 `AtomicBool`/`mpsc` 信号让循环 `break`；线程退出时复位标志。

### P1-4 update_config 抹 token
**文件**：`lib.rs:88-90` `*state.config.lock().unwrap() = config`（整体替换）vs `lib.rs:715-721`（login 写 token）
前端保存设置时通常回写从 `get_config` 拿到的快照。若快照 `token` 为 None（或与 login 写入存在 TOCTOU 窗口），一次"保存设置"就把 token 抹成 None → 后续上传 401、用户被静默登出。
**修法**：`update_config` 改字段级合并，`token`/`user_id`/`device_id` 不被整体覆盖。

### P1-5 实时通知被历史加载覆盖 🔎
**文件**：`useNotifications.ts:47-63`(loadHistory) / `95-108`(pushRealtime)
`loadHistory` 异步 fetch 后 53 行 `notifications.value = res.data.map(...)` **整体重写**。若 WS 通知在 fetch 在途期间到达，`pushRealtime` 基于旧数组插入，随后被 loadHistory 覆盖丢弃。
**修法**：先 `loadHistory` 再连 WS；或加载完成后重放期间缓存的实时项。

---

## 三、P2 / P3 详情

- **P2-1 configStore.save**：`{...config.value, ...partial}` 读改写无串行，两次 save 重叠会互相覆盖字段。当前调用点恰好顺序执行属潜伏。修法：Promise 链串行化。
- **P2-2 CSRF**：`getCsrfToken` 缓存失效瞬间多请求并发重取；若后端轮换单次令牌，先发的请求 403，且无 403→重取→重试路径。需确认后端是否轮换。
- **P2-3 useWebSocket**：`handlers` 模块级共享，`onMessage` 订阅但 HomeView 未反订阅 → 重挂追加重复 handler → 消息双处理；`connect` 未关闭 CONNECTING 中的旧 socket。
- **P2-4 startPolling 重入**：二次调用覆盖 `unlistenEvent` 泄漏旧 listener，并叠加第二个 `setInterval`。加单例守卫。
- **P2-5 列表状态并发**：乐观项在上传在途时被 WS `new_clip`/fallback `refresh` 的整表重写挤掉，服务器响应回来 `find(localId)` 落空。多为闪烁，服务器为准，自愈于下次刷新。
- **P2-6 ensure_quick_paste_window**：close→sleep(10ms)→build 无互斥，固定 label；并发进入时 build 因 label 仍存在而 Err → 无可用窗口。去掉 sleep hack，加互斥或改幂等（存在即复用）。
- **P2-7 托盘入口无防抖**：`lib.rs:1123` 托盘"快速粘贴"直接 `ensure_quick_paste_window`，绕过 300ms 防抖，是最易触发 P2-6 的路径。统一入口。
- **P2-8 toggle_window RMW**：`is_minimized/is_focused` 读后再操作，多线程（命令/快捷键/托盘）无共享锁 → 并发抖动。收敛到单一加锁入口。
- **P2-9 监控去重反向 bug**：相同 size 图片/相同 path 文件二次复制 `== last_*` → 不 emit，用户"想再同步一次"被静默丢弃。改内容哈希（文本 hash / 文件 mtime+size / 图片像素）。
- **P2-10 OpenClipboard 争用**：监控线程 700ms open 与前端 get/set 命令 open 互斥 → 偶发读写失败（非死锁，作用域即关）。串行化或 open 失败退避重试。
- **P3-1**：`perfMonitor`/`errorReport` 无单例守卫，HMR 叠加。仅开发环境。
- **P3-2**：`sendCode` 未清旧 `countdownTimer`，卸载不清 → 双速倒计时/悬挂 interval。
- **P3-3**：`markAllRead` 乐观置 `n.read=true` 后回滚条件 `!n.read` 恒 false，失败不回滚（一致性 bug，非并发）。

---

## 四、建议修复顺序

1. **P1-1、P1-2、P1-3、P1-4**：直接影响数据正确性与登录态，优先。
2. **P1-5、P2-1、P2-2**：状态一致性，其次。
3. **P2-3~P2-10**：健壮性加固。
4. **P3-***：清理项，可择机。

> 本报告为只读分析，未改动任何业务代码。请确认要修复的条目后再执行。
