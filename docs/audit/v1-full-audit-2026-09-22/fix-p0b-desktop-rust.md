# P0-B「拆利用链」桌面端 Rust/Tauri 修复记录

> 范围：仅 `src/desktop/src-tauri/`（未触碰 `Cargo.toml`、前端、服务端、移动端）。
> 依据：`docs/audit/v1-full-audit-2026-09-22/07-desktop-tauri-rust.md` 中 4 个 S0/S1 问题。
> 日期：2026-09-23 ｜ 验证：`cargo check` 通过、`cargo test`（lib 14 + integration 13）全绿，均在本机 Windows + rustc 1.96.0 实测。
> 本文不含任何真实凭据值。

## 结论速览

| # | 问题 | 处置 |
|---|---|---|
| 1 | 生产包 `--remote-debugging-port=9222` | **已修**：从 `tauri.conf.json` 整体移除（Tauri 2 无 dev/prod 配置分离机制，dev 调试改用环境变量，见下） |
| 2 | `open_url` Windows `cmd /C start` 命令注入 | **已修（方案调整）**：改 `ShellExecuteExW` 直调 + 协议/目录白名单。任务假设的 `opener` crate **实际不在 Cargo.toml 里**（见「重要事实核正」），无法按原方案统一用 opener，且无需改 Cargo.toml |
| 3 | IPC 文件读取零路径校验 | **已修**：新增统一闸口 `file_guard`（canonicalize + 分量级目录包含 + 本机捕获路径登记表），套到全部 9 个路径类命令；`save_and_copy_file` 加 128MB 上限；8 个单元测试 |
| 4 | 密码管理器内容无差别记录 | **已修（Windows）**：检测微软官方文档定义的 3 个排除格式，命中即整条跳过；monitor 与轮询兜底两条采集链路 + 4 个按需读命令全部封堵。macOS 部分**不适用**（整个 crate 现状即 Windows-only，见核正 #3） |

## 重要事实核正（动手前复核发现，与任务/审计报告前提不符处）

1. **`opener` crate 不在 `Cargo.toml` 依赖里（HEAD 也没有）**，Cargo.lock 中亦无此 crate。
   `lib.rs` 原第 230/247 行的 `opener::open`/`opener::reveal` 都在 `#[cfg(not(target_os = "windows"))]` 块内，Windows 编译时被 cfg 掉，所以桌面（Windows）构建一直是绿的——但**非 Windows 目标在 HEAD 就编译不过**（未声明依赖）。审计报告与任务描述中「opener 已在依赖里」不成立。
   处置：本次把这两处非 Windows 分支改为 `xdg-open`/`open -R` 直调（argv 传参、无 shell 解析），**消除了对未声明依赖的全部引用**；Windows 主分支不引入 opener。全程未动 Cargo.toml。
2. **`clipboard-win`（Windows 专用 crate）在 Cargo.toml 是无条件依赖**，`clipboard_monitor.rs`、`lib.rs` 大量 Windows-only 代码无 cfg 门 → 整个桌面 crate 现状即 Windows-only。审计报告 07 的修复 4 要求「macOS 检测 `org.nspasteboard.ConcealedType`/`TransientType`」**没有可落点**（macOS 上此 crate 无法编译，不存在 macOS 剪贴板读取路径）。若未来恢复 macOS，需在该平台的读取路径补这两个 NSPasteboard 类型检测。
3. 审计报告提到的 `CF_EXCLUDECLIPBOARDHISTORY` **不是**微软文档定义的格式名。官方文档（Clipboard Formats → Cloud Clipboard and Clipboard History Formats）定义的排除机制是 3 个注册格式，本次全部检测（见修复 4）。
4. `tauri-plugin-shell` 的 `shell:allow-open`（capabilities 里已开）**不构成**第二条 cmd 注入链：插件以 `shellexecute-on-windows` feature 使用 `open` crate 5.3.5（Cargo.lock 锁定），该组合下 Windows 走 `ShellExecuteExW` 而非 `cmd /c start`；且插件默认 scope 正则 `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+` 拒绝裸本地路径。capabilities 未改动。

---

## 修复 1：生产包远程调试端口

**文件**：`src/desktop/src-tauri/tauri.conf.json`

- 前：`"additionalBrowserArgs": "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9222"`
- 后：`"additionalBrowserArgs": "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"`

**方式选择**：查证 tauri 2.11 / tauri-runtime-wry / wry 源码（本机 cargo registry），Tauri 2 **没有** dev/prod 配置文件分离（只有 `tauri.conf.json` + 平台变体 `tauri.<platform>.conf.json` + CLI `--config` 覆盖），且 wry **不会**在 dev 构建自动注入调试端口（grep wry/tauri-runtime-wry 源码无 `remote-debugging`）。按任务预案「无法只影响 dev 就整体删掉」执行。删除后字符串恰与 wry 内置默认值逐字一致，行为零漂移。

**dev 期还能不能调试**：能，且不用改仓库文件。WebView2 官方机制：设置环境变量
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
再启动 `tauri dev` 即可。已查证 CreateCoreWebView2EnvironmentWithOptions 文档：该环境变量的值是**追加**到宿主程序传入的 AdditionalBrowserArguments 之后（不会被 Tauri 传的默认参数顶掉）。也可临时改 tauri.conf.json（勿提交）。

**同配置其他安全项核对**（只核对，未再改动）：
- `withGlobalTauri`：未配置 → 默认 false ✅
- `dangerousRemoteDomainIpcAccess`：未配置 ✅
- `app.security.csp`：偏宽，**只评估未动手**，结论见文末「CSP 评估」
- capabilities（`capabilities/default.json`）：core:default + 按需窗口权限 + shell/global-shortcut/autostart/notification/updater，范围合理；`shell:allow-open` 见核正 #4 ✅
- `msSmartScreenProtection` 被 disable：与 wry 上游默认一致（tauri#1345），非本仓自定义劣化，保留
- `dragDropEnabled: false`、`transparent: false` ✅

## 修复 2：`open_url` 命令注入

**文件**：`src/desktop/src-tauri/src/lib.rs`（`open_url`、`reveal_in_folder`、新增 `validate_open_target` + `shell_execute` 模块）

- 前：Windows 分支 `Command::new("cmd").args(["/C","start","",&url])`——url 为剪贴板原文（可来自远端设备），cmd 元字符（`& | > ^ "`）二次解析 → RCE。
- 后：
  1. **协议白名单**（`validate_open_target`，两平台共用，先于任何 OS 调用）：
     - `url::Url::parse` 成功且 scheme ∈ {http, https} → 放行**归一化后**的 URL（WHATWG 解析会把 `"`、空格、反引号、`<` `>` 等百分号编码，顺带堵掉「引号逃逸浏览器命令行模板」的参数注入面）；
     - 其他任何 scheme（`file:`、`javascript:`、自定义协议…）→ `Err("URL scheme not allowed: <scheme>")`，**不回显完整 URL**；
     - 解析失败/单字母 scheme（`c:/dir` 是盘符不是 URL）→ 进入本地路径分支：仅接受**存在于本机、已登记（见修复 3 登记表）或位于应用根目录内、且是目录（非文件）、非 UNC** 的路径（`file:///…` 与任意可执行文件路径都被拒，防借 open 执行程序；UNC 被拒，防 Explorer 自动外连 SMB 泄露 NTLM 凭据）。
  2. **Windows 执行**：手工 `#[link(name="shell32")] extern "system"` 调 `ShellExecuteExW`（结构体布局取自 open crate 5.x 的 windows-sys 同源实现；`SEE_MASK_NOASYNC|SEE_MASK_FLAG_NO_UI`），全程无 cmd.exe、无 shell 字符串解析。**零新依赖**（opener 不可用，见核正 #1；windows-sys 已启用 feature 里没有 ShellExecute）。
  3. **非 Windows 分支**：`xdg-open`/`open`（macOS）argv 直调，替换掉引用未声明依赖的 `opener::open`（见核正 #1）。
  4. `reveal_in_folder` 同步加 `file_guard::validate_path` 校验（原来任意路径直接喂 explorer.exe `/select`，UNC 路径可触发 NTLM 外连）；非 Windows 分支的 `opener::reveal` 同样替换为 `open -R`/`xdg-open <parent>`。

**白名单依据（前端调用点逐一 grep 核实）**：
- `useClipboardActions.ts:73`（openLink）与 `ClipDetailDrawer.vue:204`：link 型条目，前端分类正则 `^https?://`（`useClipItemDisplay.ts:260`、`FavoritesView.vue:758`）→ 只会是 http/https；
- `AppSidebar.vue:171,175`：管理台/外链，http(s)；
- `useClipboardOperations.ts:226,233,240`：reveal 失败时的回退，传**裸目录路径**（无 scheme）→ 由上述目录分支承接（要求目录已登记/在根内）。
- **全仓无 `mailto:`、`file://` 调用点** → 白名单只放 http/https，目录走登记校验。

**错误处理**：`openLink` 的 `.catch(() => window.open(url,'_blank'))`、reveal 回退的 `.catch(() => toast…)` 均已存在，不会静默失败。被拒时前端会收到 `URL scheme not allowed: …` / `Path not allowed` / `File not found` 字符串。

## 修复 3：IPC 任意文件读取

**新文件**：`src/desktop/src-tauri/src/file_guard.rs`（统一闸口 + 登记表 + 8 个单元测试）
**改动**：`src/lib.rs`（9 个命令接入 + setup 初始化）、`src/clipboard_monitor.rs`（捕获时登记）

### 正当用途调查结论

先 grep 了全部前端调用点，这些命令的合法路径来源只有三类：
1. **用户本机刚复制进剪贴板的文件**（CF_HDROP，任意位置）——monitor FILES 事件（`clipboard_monitor.rs`）与前端 10s 轮询兜底（`useClipboard.ts:127` → `get_clipboard_files`）两条采集链，随后 `clipboardUpload.ts`（get_file_size/read_file_range_base64/readFileContentBase64）、`DocPreviewModal.vue`、`useSharePayload.ts` 回读上传/预览。**这是核心产品能力，路径天然任意，不能简单圈进固定目录**；
2. **跨设备还原的落盘文件**——`save_and_copy_file` 写死在 `%TEMP%\clipsync`（文件名已消毒）；
3. 应用自有数据目录。

因此白名单模型 = **「本机捕获登记表」（用户复制动作即显式授权，登记持久化跨重启）∪「应用根目录」**，而不是任务提示的仅 app_data_dir/download_dir（那样会砍掉整个文件同步功能）。`download_dir` **未**列入根目录：全仓无任何合法流程从 Downloads 读文件，列入反而扩大远端条目可读面。攻击模型（远端设备把条目 `contentEncrypted` 写成受害者任意路径 → DocPreviewModal 回读）被登记表精确挡住：攻击者无法向受害者本机登记表写入。

### 校验函数语义（`file_guard::validate_path`）

1. 空串/UNC（`\\`、`//` 开头）直接拒；
2. `std::fs::canonicalize` 解析 `..`、符号链接/junction、`\\?\` verbatim 前缀（不存在 → `File not found`）；canonical 后仍是 UNC → 拒；
3. 命中登记表（canonical key，Windows 大小写不敏感归一）→ 放行；
4. 否则按**路径分量**（非字符串前缀）判断是否位于允许根内（app_data_dir、%TEMP%\clipsync，均取自 Tauri path resolver / env，无硬编码盘符路径）；`C:\app\data2` 不会被 `C:\app\data` 误收；
5. 拒绝时返回固定文案 `Path not allowed`，**不回显请求路径**（防探测）；未初始化 fail-closed；锁 poison-safe（`panic='abort'` 下不新增崩溃点）。

### 登记表

- 写入点仅两处：monitor 的 FILES 捕获（`handle_content`，emit **之前**登记，前端收到事件立即回读也不会竞态）、`get_clipboard_files`（轮询兜底同源）。`copy_local_files` 等**消费**前端路径的命令一律不登记（否则远端条目可自我授权）。
- 持久化：`%APPDATA%\com.clipsync.desktop\captured_paths.json`（仅路径字符串，无内容），上限 4096 条 FIFO 淘汰，启动加载。

### 接入命令清单（逐一核对，✅=本次接入）

| 命令 | 处置 |
|---|---|
| `read_file_content` ✅ | validate_path；5MB 文本上限保留 |
| `read_file_content_base64` ✅ | validate_path；10MB 上限保留 |
| `get_file_size` ✅ | validate_path（原可探测任意路径元数据） |
| `read_file_range_base64` ✅ | validate_path；64MB/片上限保留 |
| `copy_local_files` ✅ | 逐路径 validate；missing 清单只回显**文件名**不再回显完整路径；CF_HDROP 仍写原始路径串（消费方兼容） |
| `set_clipboard_files` ✅ | 过滤未通过校验的路径，全拒 → Err |
| `reveal_in_folder` ✅ | validate_path（含 UNC 拒绝） |
| `open_url` ✅ | 目录分支复用 validate_path（见修复 2） |
| `save_and_copy_file`（写侧）✅ | 目标本就限 `%TEMP%\clipsync` + 文件名消毒（复核有效：`/`、`\`、`:` 均被替换，无穿越）；**新增解码后 128MB 上限**（对齐服务端 Pro 档单文件上限），解码前先按 base64 长度快速拒绝，防磁盘写满 |
| 其余路径无关命令 | config/auth/shortcuts/e2e/updater/图像转换（入参为 data URL 非路径）/monitor 启停 —— 不涉及 |

**无需 dialog 插件改造的命令**：经调用点核查，不存在「正当用途=用户显式选任意文件」的命令（本产品无文件选择器流程，文件全部经剪贴板捕获进入）——登记表即「用户显式动作」的等价物。若未来加"导入任意文件"，应走 `tauri-plugin-dialog`（需新增依赖）。

### 行为变化 / 迁移影响（需要知晓）

- **部署本修复前**捕获的旧文件条目：其路径不在登记表 → 本机回读被拒。前端既有回退链兜底：预览走服务端 text-preview/download 端点、复制走服务端 base64 还原（`useClipboard.ts:471-496`），多数场景无感；**例外**：`DocPreviewModal.vue:544-581` image 分支读失败只 console.error、无服务端回退（见前端配合清单）。用户重新复制一次文件即可刷新登记。
- 远端设备/被入侵服务端伪造的条目路径：读取、复制、reveal、目录打开全部被拒（攻击链断点）。

## 修复 4：敏感剪贴板（密码管理器）排除

**文件**：`src/desktop/src-tauri/src/clipboard_monitor.rs`（新增 `clipboard_is_marked_excluded` + monitor 读取入口接入）、`src/lib.rs`（4 个按需读命令接入）

- **检测依据**：微软官方文档定义的 3 个注册格式（即 `GetClipboardMetadata` 报告 `isTransient` 的数据来源，直查格式无需 Win10 1809+ 新 API、无需新依赖，复用已在用的 `clipboard_win::raw::register_format/is_format_avail/get`）：
  - `ExcludeClipboardContentFromMonitorProcessing`：存在任意数据即排除（1Password/Enpass/KeePass 等普遍设置）；
  - `CanIncludeInClipboardHistory`：DWORD==0 排除；
  - `CanUploadToCloudClipboard`：DWORD==0 排除（本产品会同步上云，语义完全对口）。
- **封堵点（两条采集链 + 全部按需读，一个不漏）**：
  1. `read_clipboard_raw`（monitor 事件链）：open 后最先检测，命中返回 `Empty` → `handle_content` 不 emit、不记内容；
  2. `get_clipboard_content`（前端 10s 轮询兜底 + AI 模板取剪贴板 `templateStore.ts:75`）：命中返回空串（与空剪贴板同路径）；
  3. `get_clipboard_files`（轮询文件链）：命中返回空列表；
  4. `check_clipboard_image_info` / `read_clipboard_image_raw`（→`get_clipboard_image`）：命中按无图处理。
- **三处「不落」确认**：不 emit → 前端拿不到 → ①不进同步链路（上传由 `clipboard-changed` 事件/轮询结果驱动）②不落本地库（条目仅由前端从上述两源创建）③不打日志（Rust 侧仅 debug 一行"skipped"事实、无内容；前端收不到事件自然无日志）。
- **用户开关**：未加。原生检测完整可行（任务的开关要求是「实现代价过大时」的次优方案），排除恒开=安全默认=行业惯例（Windows 剪贴板历史本身即无条件尊重这些标记）。加无 UI 的隐藏配置字段属死代码，违反「不顺手加东西」纪律。若产品要提供「仍捕获密码管理器内容」开关，需要 AppConfig 字段 + 前端设置项联动（前端配合清单 #4）。
- **macOS**：不适用（核正 #2：crate 现状 Windows-only，无 macOS 剪贴板读取路径可挂检测）。

### 验证局限（如实说明）

检测逻辑经编译 + 静态审查；**未做真机行为验证**（需要用 1Password/Bitwarden 实际复制密码观察日志跳过——按纪律未启动应用）。格式名与语义均有微软官方文档背书。建议 QA 用例：密码管理器复制 → ClipSync 列表无新条目、日志出现 `transient/excluded`、Win+V 历史同样无此条（旁证标记确实被来源设置）。

---

## 验证记录

| 项 | 结果 |
|---|---|
| `cargo check`（Windows dev profile） | ✅ 通过，无警告 |
| `cargo test --lib` | ✅ 14/14（file_guard 8 新增 + e2e_crypto 6 既有） |
| `cargo test`（含 `tests/integration_test.rs`） | ✅ 13/13 integration + doc-tests 0 |
| file_guard 测试覆盖 | 正常路径通过 ✅；`..` 穿越拒绝 ✅；符号链接/junction 逃逸拒绝 ✅（本机 symlink 创建成功，非跳过，--nocapture 确认）；前缀相似目录（data2 vs data，含 `C:\app\data2` vs `C:\app\data` 纯分量断言）✅；UNC 拒绝 ✅；空路径 ✅；verbatim 前缀还原 ✅；登记表命中/未命中 ✅ |
| 未编译验证的部分 | 非 Windows cfg 分支（xdg-open/open -R，Windows 上被 cfg 剔除，仅静态审查）；ShellExecuteExW 真机拉起浏览器（未启动应用，静态审查 + 与 open crate 5.3.5 同源实现比对） |
| 编译期 API 差异踩坑（已解决） | rustc 1.96 中 `std::path::PrefixKind` 已并入 `Prefix`（`PrefixComponent::kind()` 返回 `Prefix`）；`std::os::windows::fs::junction` 未稳定（测试改用 `symlink_dir` + `mklink /J` 回退） |

## 需要前端（`src/desktop/src/**`）配合的改动

1. **`FavoritesView.vue:832`**：`plugin-shell` 的 `mod.open(裸目录路径)` 本来就会被插件 scope 正则拒绝（现状即失效），应改为 `revealInFolder(m.paths[0])` 或 `openUrl(dir)`（后者现在只对已登记目录放行）。
2. **`DocPreviewModal.vue:544-581`（image 文件分支）**：`read_file_content_base64` 失败只 console.error，无服务端回退。对「登记表部署前捕获的旧条目」会白屏。建议比照 docx/pdf 分支（616-627 行）补 `/api/media/:id/download` 回退。
3. **错误文案映射（可选体验优化）**：Rust 侧新错误串 `Path not allowed` / `File not found` / `URL scheme not allowed: <scheme>` / `No accessible paths` / `File too large to save`，可在 `useClipboard.ts` 复制失败 toast、`useClipboardOperations.ts` reveal 回退等处映射为友好文案（如「该文件非本机捕获，请重新复制一次」）。不改也不会静默失败（均有 catch+toast/回退）。
4. **（仅当产品决策要开关）**「不捕获密码管理器内容」设置项：需要前端设置 UI + `AppConfig` 新字段 + `update_config` 字段级合并清单同步（Rust 侧届时再加字段）。当前排除恒开、无开关。
5. 无需改动的确认：`openLink`/`AppSidebar`/`ClipDetailDrawer` 的 http(s) 调用、`clipboardUpload.ts` 上传链（捕获即登记，无竞态）、`useClipboard.ts` 复制回退链，均与新白名单天然兼容。

## 需要改 `Cargo.toml` 才能做的事

- **本次 4 项修复均不需要**（已用 ShellExecuteExW 手工 extern 替代 opener；windows-sys 未扩 feature）。
- 遗留（不在本批、留给用户决策）：若将来要恢复非 Windows 构建，需要处理 `clipboard-win` 无条件依赖与 Windows-only 代码的 cfg 门（现状 HEAD 即编不过，与本次改动无关；本次反而清掉了其中 `opener` 未声明这一处）。若按审计报告原方案引入 `opener = "0.2"`，亦可，但当前实现已不依赖它。

## CSP 收紧评估（只评估，未动手）

现状：`script-src 'self' 'unsafe-inline'`；`style-src 'self' 'unsafe-inline'`；`connect-src … https: ws: wss:`；`img-src … http: https:`；`frame-src … alipay 域`。

- **`script-src 'unsafe-inline'` 可以去掉，但要单独排期验证**：Vite 构建产物是外部 JS（Vue SFC 模板已预编译，不用运行时 eval）；Tauri 2 会给自己的注入脚本/内联脚本自动加 hash/nonce。风险点：① `index.html` 若残留内联脚本需确认被 Tauri hash 机制覆盖；② 文档预览库（docx/xlsx/pdf.js worker）与支付 iframe 流程需回归。**去掉收益明确**（XSS 落地难度大幅提高，是本批 4 项修复的纵深补充）。
- **`style-src 'unsafe-inline'` 建议保留**：UI 库/动态内联 style 属性依赖它，去掉收益低、破坏面大。
- **`connect-src https: wss:` 通配建议保留**：产品支持用户自配 `server_url`（任意自托管域名），收敛到固定白名单与产品形态冲突；`ws:` 通配可收敛为 `ws://localhost:1420`（仅 dev HMR 需要）。
- **`img-src http: https:`**：可收敛（剪贴板图片都是 data:/blob:，http(s) 图仅出现在富文本预览），中收益，随 script-src 一起排期。
- 结论：**CSP 不是本批阻塞项**（调试端口已关 + 命令面已校验，CSP 从「唯一防线」退回「纵深」），建议独立工单：去 script-src 'unsafe-inline' + img-src 收敛 + ws: 收窄，配一轮全功能回归（预览/支付/更新）。

## 顺带发现但未改（不在本批范围）

1. 报告 07 的 S1-2（`update_config` 无 https/白名单硬闸、login/send-code 明文无超时）、S2 各项（`panic='abort'`+unwrap、`Instant-10s` 下溢、BMP w*h*4 OOM、Cargo.lock 未入库、`get_config` 回传 token）、S3 各项——**均未动**（任务边界明确排除）。
2. `open_image_viewer`（lib.rs）手写 HTML 转义——未动（S3，静态审查确认当前 dataURL 字符集下无实际注入）。
3. 建议（未实施）：ClipSync 自己向剪贴板**写入**用户粘贴的密码类条目时，可反向设置 `ExcludeClipboardContentFromMonitorProcessing`，避免被 Windows 历史/其他剪贴板工具捕获——属产品增强，需前端标记敏感条目配合。
4. `check_clipboard_image_info` 存在「open→close→再 open」的双开结构（既有代码），排除检测加在第一次 open 内，行为正确，但结构值得后续整理（未动）。
5. `tests/integration_test.rs` 使用 `Instant::now() - 10s` 构造 AppState（与 lib.rs:1921 同款下溢模式）——测试代码，未动。
