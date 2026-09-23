# 桌面端 Vue/TS 前端 审计

审计日期：2026-09-22
范围：`src/desktop/src` 全部（约 5.8 万行 TS/Vue）+ `src/desktop/index.html`、构建配置 + 仓库根 `src/components/`（遗留目录）。
方法：纯静态阅读 + 全仓 grep 扫描，未运行构建。

---

## 结论（≤3 句）

桌面端整体工程成熟度明显高于典型 v1 前夕项目：API 层有单飞刷新/幂等键/CSRF/超时/429 退避，同步链路有双族哈希去重、墓碑删除同步、乐观更新+回滚，todo 里记录的三大「假装可用」案例（版本历史、自动更新、归档）都已真实接线。但存在 1 个可利用的存储型 XSS（Markdown 预览未消毒，剪贴板内容跨设备可控，且 CSP `unsafe-inline` 不设防）和 1 组「会话被踢下线后跨用户数据残留」（离线队列会把上个用户的剪贴板内容刷进下个用户的账号），这两条必须先修再上 v1。此外死代码规模可观（11 个不可达弹窗态、6 个从未被 import 的组件、整个 `api/subscription.ts`、仓库根 `src/components/` 遗留目录），建议上线前集中清一次，防止日后被误接线复活成假 UI。

---

## 「功能不可达但 UI 假装可用」清单

逐条核对了 todo（2026-07-19）记录的案例，并地毯式排查了同类问题。**当前真实状态**如下：

### A. todo 记录的旧案例 —— 已全部修复（验证通过）

| # | 案例 | 当前状态 | 证据 |
|---|------|----------|------|
| A1 | 版本历史回滚「弹窗+后端就绪但 UI 无入口」 | **已接线，真实可用**。列表行「更多→版本历史」→ HomeView 写入 `versionItemId` → ModalManager → VersionHistoryModal 真实拉取 `GET /api/versions/:id` 并可 `POST /api/versions/restore/:id` | `src/desktop/src/views/HomeView.vue:410-414`（onVersionHistory）、`src/desktop/src/components/clipboard/ClipboardView.vue:626-631`、`src/desktop/src/components/modals/VersionHistoryModal.vue:22-52` |
| A2 | 自动更新「Rust 命令实现但前端从未调用，Updates 弹窗静态 mock」 | **设置→关于页已真实接入**：`tauri.checkForUpdates()` + `installUpdate()` + 强更标记（AN-04）+ 托盘「检查更新」入口；失败明确报错不谎报最新。**但** ModalManager 里的静态 `updates` 弹窗（打开即显示「已是最新」+ 4 条硬编码 changelog）仍在代码里，只是已无任何入口能打开它（见 C1，死代码） | `src/desktop/src/components/settings/settings-dialog/AboutView.vue:38-80`、`src/desktop/src/views/HomeView.vue:399-408`；静态弹窗残骸：`src/desktop/src/components/modals/ModalManager.vue:258-277` |
| A3 | 归档「只有图标无功能」 | **已完整实现**：`archiveItem`/`unarchiveItem` 乐观更新+回滚、归档分段视图（时间流/仅收藏/归档）、`/app/archive` 深链、批量恢复 | `src/desktop/src/composables/useClipboard.ts:832-885`、`src/desktop/src/components/clipboard/ClipboardView.vue:47-59`、`src/desktop/src/router/index.ts:9-18` |
| A4 | 发票 UI「尚未做」→「砍掉发票下载」 | **当前实际状态：发票/收据下载是真实功能**。设置→订阅与账单→账单历史（BillingSubPage）拉 `GET /api/invoices`，`GET /api/invoices/:id/download` 下载服务端 pdfkit 现生成的 PDF 收据，走 showSaveFilePicker/`<a download>` 落盘。**但**死代码 BillingModal 里还留着一个点了只弹「功能建设中」的假下载按钮（不可达，见 C1） | `src/desktop/src/components/settings/settings-dialog/sub-pages/BillingSubPage.vue:30-135`；假按钮残骸：`src/desktop/src/components/modals/BillingModal.vue:60-61` |
| A5 | 图片 objectURL 释放 | **已修且质量高**：id→url 映射精确跟踪，替换/删除/裁剪/登出全路径回收 | `src/desktop/src/composables/clipboardObjectUrls.ts:15-56` |
| A6 | 离线队列（P3-2 可视化未做） | 队列本身真实工作（串行锁、online/visibilitychange 自动 flush、登出清理），**但 `offlineQueueSize` 算出来后没有任何组件渲染它**——用户完全看不到待同步项，且入队瞬间还会收到误导性的「上传失败」toast（见问题 S2-6） | `src/desktop/src/composables/useClipboard.ts:1095`（computed 定义后无消费者，全仓 grep 仅 2 处命中均为定义/导出）、`src/desktop/src/composables/clipboardUpload.ts:415-432` |

### B. 现存「UI 假装可用」问题（可达路径，需处理）

| # | 项 | 状态 | 证据 |
|---|-----|------|------|
| B1 | **登录页「记住我」勾选框是纯装饰**：只把自己的布尔值存 localStorage，登录流程（验证码/密码/2FA 三条路径）从不读取它，不影响会话时长、不回填账号 | 点了没有任何实际效果 | `src/desktop/src/components/auth/AuthPage.vue:41,103-106,677,724`；`handleLogin`（约 180-310 行）全程未引用 `rememberMe` |
| B2 | **登录/注册页 7 个 OAuth 品牌按钮（WeChat/Apple/GitHub/WeCom）**：点击只弹「即将上线」toast。OAuth 本体属外部依赖（D6）不计问题，但 v1 正式版登录页保留 4 个不可用品牌按钮属于产品诚信/完成度问题，建议 v1 摘除 | 占位按钮仍在 | `src/desktop/src/components/auth/AuthPage.vue:741-766`（登录页 4 个）、`968-986`（注册页 3 个），`@click="toast.show(t('toast_signup_soon'), 'info')"` |
| B3 | **AI 建议弹窗的「收藏夹名称列表」永远为空**：ClipboardView 从 `localStorage.getItem('clipsync-favorites')` 读收藏夹名，但全仓**没有任何代码写入这个 key**（收藏夹真相在 collectionStore/服务端）。AI 建议「归类到收藏夹」时拿不到现有收藏夹名单 | 静默断线，功能半残 | 读：`src/desktop/src/components/clipboard/ClipboardView.vue:151-157`；写：全仓 grep `clipsync-favorites` 仅此 1 处命中 |
| B4 | **侧栏「同步脉搏」在线设备数不是实时状态**：`device.loadDevices()` 只在 HomeView 挂载和切到设备页时调用一次，之后永不刷新；WS 的 `connected/registered` 状态也没有任何 UI 消费。WS 静默断线（默认 syncInterval=0 时连兜底轮询都没有）时用户零感知，远端条目停止到达却显示「N 台设备在线」 | 半假状态展示 | `src/desktop/src/components/layout/AppSidebar.vue:39-41`、`src/desktop/src/views/HomeView.vue:445-446`；全仓 grep `ws.connected` 无模板消费 |

### C. 不可达的假 UI（死代码，当前用户看不到，但留着就是地雷）

| # | 项 | 说明 |
|---|-----|------|
| C1 | **ModalManager 中 11 个弹窗态无任何入口**：`updates`（静态「已是最新」）、`security`（**假 2FA 开关——只写 localStorage，注释自认「其余安全开关如 2FA 仅本地」**，真 2FA 在 SecuritySubPage）、`themes`、`notifications`、`add-device`（静态二维码图标占位）、`confirm`（HomeView `showConfirm` 定义后从未被调用）、`shortcuts`/`sessions`/`billing`（含假「发票建设中」按钮）/`feedback` 四个子弹窗、`forgot-password`（`showForgotPwd` 从未置 true）。可达的只有 `pricing/payment/pay-scan/payment-result/versions/pair-scan/pair-generate` 与预览类 | 证据：`src/desktop/src/components/modals/ModalManager.vue:107-334`；入口枚举：全仓 grep `open-modal`/`showModalType.value =` 仅产出 pricing、pair-scan、pair-generate、versions、confirm(未调用)；假 2FA：`ModalManager.vue:88,167-174` |
| C2 | 仓库根 `src/components/`（QuickPastePanel.vue、settings/DevicesView.vue、ProfileView.vue、SettingsView.vue、SharedLinksView.vue、**SubscriptionView.vue——已砍掉的订阅页**）是迁移前遗留，git 仍跟踪，无任何构建引用 | `git ls-files src/components` 6 个文件；desktop 端 import 全部解析到 `src/desktop/src/components` |
| C3 | `api/subscription.ts` 整个文件死亡**且实现是错的**：`api('/api/subscription', 'GET')` 把 path 传进了 method 位（api 签名是 `(method, path, body)`），端点也与服务端 `/api/subscriptions/*` 不符。谁接线谁炸 | `src/desktop/src/api/subscription.ts:1-13` |
| C4 | 从未被 import 的组件：`ClipboardFilterBar.vue`（被 FilterPanel 取代）、`ItemPasswordDialog.vue`（被 ProtectionDialog 取代）、`TemplateRow.vue`、`TemplateToolbar.vue`、`SharedLinksView.vue`（desktop 版；分享功能本体经 useClipboardOperations 存活）、`SettingsDialog.vue`（380 行，被 SettingsView 页面版取代） | 全仓 import 图扫描 0 引用 |
| C5 | 未被调用的 API 函数：`ai.ts` 的 getAiContext/fetchProviderModels/suggestClipboard、`auth.ts` 的 setPassword/forgotPassword/resetPassword（AuthPage 直接内联 `api('POST', ...)`）、`clipboard.ts` 的 fetchClips/uploadClip/setArchive、`device.ts` 的 fetchDevices/addDevice/deleteDevice | grep 0 外部引用 |

---

## 问题清单（按严重度从高到低）

### [S0-1] Markdown 预览存储型 XSS：`marked.parse` 输出未消毒直接 `v-html`

- 证据：
  - `src/desktop/src/components/doc-preview/MarkdownPreview.vue:36`：
    ```html
    <div class="markdown-preview-content markdown-body" v-html="renderMarkdown(content)"></div>
    ```
  - `src/desktop/src/utils/docPreview.ts:37`：`return marked.parse(text, { renderer }) as string` —— marked 默认**透传内嵌原始 HTML**，无 DOMPurify（对比：`AiStreamText.vue:74`、`HtmlPreview.vue:13` 都过了 `sanitizeHtml`）。
  - 触发面 1（.md 文件）：`src/desktop/src/components/modals/DocPreviewModal.vue:58`：`if (['md','markdown','mdx','rst'].includes(ext)) return 'Markdown'` → 走 MarkdownPreview。
  - 触发面 2（纯文本嗅探）：`DocPreviewModal.vue:154-163`，Markdown 正则判定在 `isHtmlContent` **之前**，`# 标题\n<img src=x onerror=...>` 这类内容命中 `^#{1,6}\s` 判为 Markdown，绕过已消毒的 HtmlPreview 分支。
  - 防线失效：`src-tauri/tauri.conf.json:30` CSP `script-src 'self' 'unsafe-inline'` —— 内联事件处理器（onerror）不被拦截；`eslint.config.js` 还关掉了 `vue/no-v-html` 规则。
- 失败场景：攻击者（或用户自己任一设备上的恶意软件/恶意网页写入剪贴板）产出一条含 `#` 开头 + `<img onerror>` 的文本或 .md 文件 → 经跨设备同步落到受害者桌面端 → 用户在剪贴板列表点开预览 → onerror 脚本在 Tauri WebView 内执行。脚本可读 `localStorage` 里的 `clipsync-token`/`clipsync-refresh-token`/`clipsync-csrf`/`clipsync-content-cache-v2`（明文剪贴板缓存），并可经 `window.__TAURI_INTERNALS__` 调用已暴露的 IPC 命令（`open_url` 任意外链、`save_and_copy_file` 落盘任意 base64 内容等）。
- 影响：安全（账号接管 + 剪贴板全量外泄 + 本机写文件），S0；这也是「剪贴板内容渲染成 HTML」这一最高危面的直接失守。
- 修法：`renderMarkdown` 返回值统一过 `utils/html.ts` 的 `sanitizeHtml`（一行改动，与 AiStreamText 同口径）；同时把 `detectDocType` 的 HTML 嗅探提到 Markdown 判定之前。

### [S0-2] 会话被踢/过期（forceLogout）不清理用户数据：离线队列会把上个用户的剪贴板内容刷进下个用户的账号

- 证据：
  - `src/desktop/src/api/client.ts:158-179` `forceLogout()` 只清 token/refresh/csrf 三样：
    ```ts
    localStorage.removeItem('clipsync-token')
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem(CSRF_STORAGE_KEY)
    ```
    不清 `clipsync-offline-queue`、`clipsync-content-cache-v2`、`clipsync-avatar`、`clipsync-last-sync-at`、`clipsync-sync-log-v2`。对比正常登出 `configStore.logout()`（`stores/configStore.ts:147-172`）这些都清了，且注释明言「避免切换账号后旧数据残留」「跨用户清理」。
  - 刷入路径：下个用户登录后 HomeView 挂载 → `clip.startPolling()` → `initOfflineSync(...)`（`composables/useClipboard.ts:339-343`）→ `flushQueue()` 用**新用户的 token** 逐条 `POST /api/clipboard`（`utils/offlineQueue.ts:108-133`）。
- 失败场景：用户 A 在断网/后端不可达时复制了若干文本（进入离线队列），随后 A 的 refresh token 失效（管理台远程下线 / 过期）→ 前端 forceLogout 跳登录页 → 用户 B 在同一台机器登录 → B 首屏加载时 A 的离线剪贴板条目被静默上传进 **B 的账号**，出现在 B 的剪贴板列表并同步到 B 的所有设备。
- 影响：跨用户数据残留/串号（隐私 S0）；同时 A 的明文剪贴板内容（content-cache，最多 500KB）与头像无限期留在共享机器的 localStorage 里。
- 修法：`forceLogout()` 复用 `configStore.logout()` 的清理清单（离线队列、内容缓存、头像、last-sync-at、sync-log），或抽一个共享的 `clearUserData()`。

### [S1-1] docx 预览：mammoth 输出未消毒直接 `v-html`（XSS 同族，利用难度更高）

- 证据：`src/desktop/src/components/modals/DocPreviewModal.vue:245-246` `mammoth.convertToHtml({ arrayBuffer })` → `components/doc-preview/DocxPreview.vue:60` `<div ref="contentRef" class="docx-preview markdown-body" v-html="html" />`。全文件无 DOMPurify import（HtmlPreview/MarkdownPreview 之外唯一裸 v-html 的文档管道；PptxPreview 因 `[^<]*` 正则提取 + `<` 转义实际安全，`DocPreviewModal.vue:307-315`）。
- 失败场景：跨设备同步过来的恶意 .docx（OOXML 可携带超链接/域代码，mammoth 不做安全过滤）在桌面端预览时注入属性型 payload（如 `javascript:` href 诱导点击，或 mammoth 未来版本透传的属性）。
- 影响：安全，比 S0-1 难利用但同族；剪贴板产品的文件都来自「别的设备/别的来源」，不能信任。
- 修法：`docxHtml` 落 state 前过一次 `sanitizeHtml`。

### [S1-2] `ensureDeviceId` 取 `devList[0]`，桌面端可能冒用手机的设备身份

- 证据：`src/desktop/src/composables/clipboardUpload.ts:278-300`：
  ```ts
  const devRes = await api('GET', '/api/devices')
  const devList = devRes.data?.devices || devRes.data
  if (devRes.ok && Array.isArray(devList) && devList.length > 0) {
    deviceId = devList[0].id || devList[0].device_id
  ```
  不按 `deviceType === 'desktop'` / platform 过滤。且 AuthPage 三条登录路径都是手工 set token + 整页跳转（`AuthPage.vue:203-209` 等），**没有走 `configStore.completeLogin` → 不会注册 Desktop 设备**，首装桌面端大概率命中「列表里只有手机」的场景。
- 失败场景：用户先配对手机、后装桌面端 → 桌面端把手机的 deviceId 缓存为 `clipsync-device-id` → 桌面上传的条目标记为手机来源、WS 以手机身份注册；设备页两台「手机」互相顶掉在线状态；来源过滤（`isRemote`、自动复制回声过滤，`HomeView.vue:471-499`）在两台设备间产生误判（手机复制的内容桌面端当成「自己」不自动写入，或反之）。
- 影响：同步链路设备身份错乱（数据归属 + 自动复制行为异常），核心功能正确性 S1。
- 修法：`devList` 过滤 `deviceType==='desktop'`（且按本机特征/最近注册优先），没有再走 POST 注册；登录路径统一改走 `completeLogin`。

### [S1-3] 列表刷新失败被静默吞掉：错误态只在「列表为空」时渲染

- 证据：`src/desktop/src/components/clipboard/ClipboardView.vue:576`：
  ```html
  <div v-else-if="loadError && filteredItems.length === 0" class="error-state">
  ```
  `loadClipboardItems` 失败时若列表已有数据（正常使用中的绝大多数刷新：WS 触发 refresh、切分段、轮询），界面继续展示旧数据，无任何「同步失败/数据可能过期」提示（`clipboardLoad.ts:400` 设置了 loadError 但没人渲染）。
- 失败场景：后端宕机/断网 30 分钟后恢复前，用户看到的仍是最后一次的列表，误以为一切正常；期间在另一台设备的删除/新增全部不可见。
- 影响：同步断链无感知（可用性 + 产品诚信），S1。
- 修法：`loadError && items.length>0` 时渲染顶部警示条（可复用维护模式横幅样式）+ 重试按钮。

### [S2-1] 「记住我」勾选框无实际功能（同 B1）

- 证据/场景/影响：见 B1。用户勾选后期望「下次免登录/记住账号」，实际两者都不发生（会话续期完全由 refresh token 机制决定）。
- 修法：要么接到登录流程（记住账号回填），要么 v1 摘掉控件。

### [S2-2] OAuth 占位按钮留在正式登录页（同 B2）

- 修法：v1 摘除或折叠为「更多登录方式即将上线」一行文字。

### [S2-3] token / refresh token / CSRF / 明文剪贴板内容缓存全部裸存 localStorage

- 证据：`api/client.ts:85-103,143`（`clipsync-token`、`clipsync-refresh-token`、`clipsync-csrf`）、`stores/configStore.ts:129`、`composables/clipboardCache.ts:6,86`（`clipsync-content-cache-v2`，每条最多 5000 字符明文，总量 500KB）、`components/settings/ProfileView.vue:130`（`clipsync-avatar` 存最多 5MB 的 dataURL，且 logout 不清理——下个用户首屏短暂显示上个用户头像，若新用户无头像则**永久**显示，因为 `fetchUserProfile` 只在 `data.avatarUrl` 存在时覆写，`configStore.ts:311`）。
- 失败场景：任一 XSS（见 S0-1）即可一次性拿走长期凭证与剪贴板明文；共享电脑上换账号后头像/缓存残留。
- 影响：安全纵深（与 S0-1 组合成完整利用链）+ 跨用户残留，S2（桌面 WebView 场景下属常见取舍，但 avatar 残留与 5MB dataURL 挤占 localStorage 配额是实打实的缺陷）。
- 修法：至少把 avatar、content-cache 纳入 logout/forceLogout 清理；avatar 压缩到 ≤200KB；中期把 token 移到 Rust 侧（Keyring）。

### [S2-4] AI 建议弹窗收藏夹名单永远为空（同 B3）

- 修法：改从 `collectionStore.flatCollections` 取名。

### [S2-5] WS 连接状态零可视化 + 侧栏在线设备数一次性加载后不再刷新（同 B4）

- 修法：标题栏/侧栏加同步状态点（connected/registered/reconnecting），设备数随 WS 事件刷新。

### [S2-6] 离线上报的用户提示与事实相反：入队成功却弹「上传失败」

- 证据：`composables/clipboardUpload.ts:415-432`：`apiOrEnqueue` 在断网时把 create 入队并返回 `{ok:false,status:0}`，`uploadToServer` 随即**删除乐观条目**并 `toast.show(t('text_upload_failed') + ...)`。条目实际会在恢复联网后静默出现在列表里。
- 失败场景：断网复制文本 → 看到「文本上传失败: Failed to fetch」+ 条目消失 → 用户以为丢了；联网后条目又「凭空」出现。
- 影响：体验/诚信，S2。
- 修法：status 0 且已入队时改提示「已离线保存，联网后自动同步」，乐观条目保留 pending 态（这也顺带解决 P3-2 可视化的一半）。

### [S2-7] 模板页/通知页缺错误态：加载失败渲染成「暂无内容」

- 证据：`stores/templateStore.ts:91,106` 维护了 `error` ref，但 `TemplatesView.vue` 全文不消费它，失败落到 `components/clipboard/TemplatesView.vue:220-225` 的空态「创建第一个模板」；`NotificationsView.vue:131-134` 同样只有空态（`useNotifications.loadHistory` 失败仅 console.warn）。
- 影响：三态不全，用户把后端故障误读为「我的模板/通知没了」，S2。
- 修法：消费 store.error，渲染错误态+重试（ClipboardView 已有现成模式可抄）。

### [S2-8] i18n：27 个使用中 key 双语词典缺失，英文用户看到中文兜底；另有约 25+ 处硬编码中文

- 详见下方「i18n 完整性核对」。影响：英文环境完成度，S2。

### [S2-9] 无虚拟滚动 + 「加载更多」无总量护栏：Pro「无限历史」下可把上万行堆进 DOM

- 证据：`clipboardState.ts:84-94`（`maxHistoryCap=0` 时不裁剪、`hasMore` 只看服务端 total）、`ClipboardView.vue:226-233`（滚动到底自动 `loadMore`，每页 50 行全量 DOM，每行含预览/图标/时间轴分组 computed）。todo 自认「虚拟滚动已舍弃」。
- 失败场景：重度用户 5000+ 条历史，滚动加载数十页后 WebView 内存与滚动帧率劣化（时间线分组 `timelineSections` 每次刷新对全量数组重算）。
- 影响：性能不达标风险，S2。
- 修法：给 append 总量设软上限（如 1000 条后提示「使用搜索定位更旧的记录」），或恢复窗口化渲染。

### [S2-10] WS 握手 token 走 URL query

- 证据：`composables/useWebSocket.ts:80`：`url = ... + '/ws?token=' + encodeURIComponent(config.config.token || '')`。
- 影响：token 会进后端访问日志/代理日志（安全卫生，S2）。
- 修法：改为连接后首帧 `register` 消息携带 token（现有 register 帧已是第一帧，改造成本低）。

### [S2-11] 登录失败 toast 直接拼接后端原始 message

- 证据：`AuthPage.vue`（handleLogin 内两处）：`toast.show(t('login_failed') + msg, 'error')`，msg 为 `res.error` 原文（可能含内部细节/英文）；`new_user` 判定靠 `msg.includes('密码')` 这类字符串嗅探，后端文案一改即断。
- 修法：按后端 code 分支，文案走 i18n（退款流程 `refundErrorText` 已有成熟范式可复用）。

### [S3-1] 死代码集群（完整清单见「死代码/重复实现」节）

11 个不可达弹窗态 + 6 个未 import 组件 + 3 个死 API 模块（含参数序错误的 `api/subscription.ts`）+ 仓库根 `src/components/` 遗留 6 文件 + `SettingsDialog.vue`(380 行)。

### [S3-2] `ClipboardView` 空态用了未导入的 `<Copy>` 组件

- 证据：`ClipboardView.vue:669` `<Copy :size="14" class="empty-hint-icon" />`，而第 21 行 lucide 导入清单（Upload/ClipboardList/AlertTriangle/RefreshCw/Sparkles/Star/Trash2/X/ArchiveRestore）没有 Copy。运行时 Vue 报「Failed to resolve component」，图标不渲染。
- 失败场景：新用户第一次打开空的剪贴板页，三条使用提示里第一条缺图标 + 控制台警告。
- 修法：补 import。

### [S3-3] 生产 `index.html` 内置开发诊断遮罩

- 证据：`src/desktop/index.html`（本工作树未提交改动）：early error 遮罩把**原始错误+堆栈**全文红底展示给用户；挂载超时 8s 弹蓝底中文诊断，内含「在普通浏览器访问 http://localhost:1420/」等开发者指引。
- 影响：真出错时用户看到的是堆栈天书/localhost 指引，且样式不可关闭。诊断价值真实（Tauri 黑屏难排查），但应仅限 DEV 构建启用。
- 修法：用 `import.meta.env.DEV` 或构建期注入开关包一层。

### [S3-4] 工程卫生

- `console.log` 8 处（6 处集中在 `composables/clipboardLoad.ts:195,201,204,414,420,429`，1 处 `SecuritySubPage.vue:56`），违反自家 eslint `no-console: warn`（未阻断）。
- `vite.config.ts.timestamp-1784275661427-*.mjs` 被 git 跟踪（构建垃圾文件入库）。
- locales 约 340/1831 个 key 无静态引用（含 `role_*` 等动态拼接误报，实际残留约 300，占 ~16%）。
- `MIGRATION_CHECKLIST.md` 停在 2026-07-07，多项未勾选（AuthPage 16 个 raw input 等），与现状已脱节，应归档或更新。
- 支付摘要金额 `¥{{ selectedPlan.price }}` 未 `toFixed(2)`（`PricingPaymentModals.vue:196`），价格 9.9 显示「¥9.9」而结果页显示「¥9.90」，两处格式不一致（金额本身来自服务端目录，无资损）。

---

## i18n 完整性核对

**语言**：仅 `en.json` / `zh.json`，各 1831 key，两语言 key 集合完全对称（0 缺失方向差）。运行时按 localStorage 偏好→浏览器语言选择，`<html lang>` 同步维护（`useI18n.ts:12-27`）——这部分做得规范。

**缺失 key（代码在用、词典没有）：27 个静态 key + 2 个动态前缀误报**。全部经 `tf(key, fallback)` 或 `t(key, fallback)` 调用，因此界面**不会显示裸 key**，但英文环境会显示中文兜底文案：

- `tpl_ai_gen_*` ×12（TemplateGenerateDialog：AI 生成模板整个弹窗）
- `billing_dl_*` ×8（BillingSubPage：发票下载全部提示）
- `inline_ai_org_apply_fail` / `inline_ai_org_undo_hint` / `inline_ai_org_copy_list` / `fav_ai_org_groups` / `fav_ai_org_tags`（FavOrganizeFlow）
- `fav_tag_pop_empty`（FavoritesView）、`ai_content_waiting`（AiMessage）
- （`ai_strength_*`、`role_*` 为动态拼接，`role_free/pro/enterprise` 实际存在于词典）

**硬编码中文（未走 i18n 的用户可见文案）：约 25+ 处**，主要有：

| 位置 | 内容 |
|---|---|
| `components/layout/AppSidebar.vue:308` | `<span>公告</span>` |
| `components/clipboard/ClipDetailDrawer.vue:45-49` | 类型标签 文本/链接/代码/图片/文件 |
| `components/settings/SettingsView.vue:64-70` | 设置搜索索引 7 个 label + 值「开/关/实时/不限/分钟/条」 |
| `components/modals/DocPreviewModal.vue:312` | 「(本页无可提取文本)」 |
| `components/settings/settings-dialog/AIProviderSettings.vue:119,122` | 「博查 Bocha」「自建 SearXNG」 |
| `composables/useAiChat.ts:240`、`useAiConversations.ts:67` | 会话默认标题「新对话」 |
| `composables/useSyncLog.ts` kindLabel | 文本/图片/文件/链接 +「本机」「云端」 |
| `composables/useTheme.ts:37` | 主题名「Clearline 澄明」 |

**残留旧 key 规模**：约 340 个（18.6%）无任何静态引用（含少量动态拼接误报，如 `protection_*`、`item_password_*`、`nav_shared_links` 等整族属于已被 ProtectionDialog/新 IA 取代的旧文案）——与 memory 里「locales 旧文案 key 待清」一致，规模约 300+。

**日期/数字/货币本地化**：日期用 `toLocaleDateString/toLocaleString`（跟随系统 locale，合格）；货币一律手写 `¥` + `toFixed(2)`（产品仅 CNY，可接受，但格式函数分散 3 处：PricingPaymentModals.money、PlanManagementCard.money、BillingSubPage.formatAmount）。

---

## 死代码 / 重复实现清单

1. **仓库根 `src/components/`（git 跟踪，6 文件）**：QuickPastePanel.vue、settings/{DevicesView,ProfileView,SettingsView,SharedLinksView,SubscriptionView}.vue —— 迁移前旧版，与 `src/desktop/src/components` 同名并存；其中 SubscriptionView 对应已砍掉的订阅页。零引用，应整目录删除。
2. **`components/settings/settings-dialog/SettingsDialog.vue`（380 行）**：弹窗版设置编排层，被页面版 SettingsView 完全取代，零引用。
3. **从未被 import 的组件**：`clipboard/ClipboardFilterBar.vue`、`clipboard/ItemPasswordDialog.vue`、`clipboard/TemplateRow.vue`、`clipboard/TemplateToolbar.vue`、`settings/SharedLinksView.vue`。
4. **`api/subscription.ts` 整文件**（且 `api(path, method)` 参数序写反、端点错误）。
5. **未调用的 API 函数**：`ai.ts` getAiContext/fetchProviderModels/suggestClipboard；`auth.ts` setPassword/forgotPassword/resetPassword；`clipboard.ts` fetchClips/uploadClip/setArchive；`device.ts` fetchDevices/addDevice/deleteDevice。
6. **ModalManager 死弹窗态 ×11**（updates/security/themes/notifications/add-device/confirm/shortcuts/sessions/billing/feedback/forgot-password），连带 `ShortcutsModal.vue`、`SessionsModal.vue`、`BillingModal.vue`、`FeedbackModal.vue` 四个组件整体不可达（各自的 SubPage 版本才是活体）——**重复实现**：SubPage 与 Modal 两套并存，修 bug 只修了一套（如 BillingSubPage 发票下载已真实化，BillingModal 还是假按钮）。
7. `HomeView.showConfirm/confirmMessage`（定义未调用）、`useClipboard().offlineQueueSize`（导出未消费）、`collectionStore.reset()`（定义未调用——本应在 logout 用，见 S0-2 族问题）。
8. `vite.config.ts.timestamp-*.mjs`（入库的构建垃圾）。

---

## 工程质量指标

| 指标 | 数值 | 备注 |
|---|---|---|
| TS 严格度 | `strict: true`；`noUnusedLocals/Parameters: false` | tsconfig.json |
| `: any` 出现 | **272 处** | eslint 降为 warn，未阻断 |
| `eslint-disable` | **5 处**（均有理由注释，范围收敛） | 无大面积 disable |
| `console.log` 残留 | **8 处**（clipboardLoad.ts ×6、SecuritySubPage ×1、logger 内 1 处有 DEV 门控） | no-console 仅 warn |
| 空 catch | 显式 `catch {}` 3 处；`catch { /* ignore */ }` 注释型大量存在（多为刻意的 best-effort，可接受但建议统一走 logger） | |
| 超长文件 Top10（行） | FavoritesView 2219 / AuthPage 1819 / AiChatPanel 1436 / AIProviderSettings 1406 / HomeView 1353 / useClipboard 1211 / useAiChat 1196 / DocPreviewModal 1067 / ClipboardView 1015 / clipboardUpload 1014 | FavoritesView、AuthPage 已到必须拆分的体量 |
| 测试 | **仅 3 个测试文件**：`composables/__tests__/useMenuAccess.test.ts`、`useSubscriptionAccess.test.ts`、`components/settings/__tests__/useSettingsSearch.test.ts` | 组件/store/API 层/同步链路零测试；恰恰是纯函数模块（订阅语义、菜单权限）被测了，选型眼光好但覆盖太窄 |
| `dist/` | git-ignored ✓ | |
| 分包 | vite 无 manualChunks；重库（pdfjs/xlsx/mammoth/jszip/marked/hljs）经 ModalManager 异步门控，首屏未常驻 ✓ | |
| sourcemap | 生产默认（未开启）✓ | |

---

## 设计层面的观察

1. **状态管理是「Pinia 薄壳 + 模块级单例 composable」双轨制**：真正的核心状态（剪贴板 items/分页/筛选、用户 RBAC、套餐限额、订阅快照、通知、公告、同步日志）全在模块级 `ref` 单例里，Pinia store 只有 4 个且 configStore 一家独大。这个模式本身工作良好（避免了 props 钻透、天然跨组件共享），**代价是「登出清理」没有统一收口**：每个单例都要自觉提供 reset 且被 logout 记得调用——现状是 notif/ann/planLimits/subscription 记得了，items/unlockedCache/collectionStore/useUser/syncLog 忘了（S0-2 族的根因）。建议做一个 `resetAllUserState()` 注册表，login/logout/forceLogout 三处统一调用。
2. **「档位双真相」问题（c006dd3 修的）已有系统性缓解但根源仍在**：plan 同时存在于 `auth/me`（configStore.user.plan）、`/subscriptions/current`（useSubscriptionAccess + usePlanLimits 两份缓存）。当前靠「支付/退款/窗口焦点 60s 节流」三路 invalidate 收敛（`HomeView.vue:117-142`），逻辑正确但缓存 TTL（60s/5min）意味着仍有短暂窗口两处不一致。根治要么 auth/me 不再回 plan，要么 /current 快照统一供数。
3. **注释质量是全仓最大亮点**：几乎每个非平凡决策都带「为什么/踩过什么坑/铁律」注释（回声去重双族哈希、离线队列串行锁、L-3 缓存代数、只升不降红线……），可维护性远超均值。反面是注释与代码偶有脱节（VersionHistoryModal 内「versionItemId 未从上层接线」的注释已过时——实际已接线）。
4. **api/client.ts 是教科书级封装**（单飞刷新、匿名端点白名单、幂等键、429 倒计时 toast 防抖），但**调用方纪律不齐**：AuthPage 绕开 completeLogin 手拼登录收尾（丢了设备注册）、多处 `t('x') + res.error` 直出后端原文。
5. **键盘/焦点/无障碍基础好于预期**：ModalDialog 有焦点陷阱+Esc+aria-modal+焦点归还；HomeView 有全局键盘层级栈仲裁 Esc；列表有 ↑↓/Enter 导航。缺口在自定义弹层（PIN 弹窗、公告弹窗、用户菜单）无焦点陷阱、大量 div 无 tabindex。

---

## 建议补充的功能（按性价比排序）

1. **（修 S0-1/S0-2 后）统一登出清理 `resetAllUserState()`**：半天工作量，杜绝整族跨用户残留。
2. **同步状态可视化**：标题栏一个 WS 状态点（连接中/已断开/重连中）+ 离线队列徽标（`offlineQueueSize` 已经算好了，就差渲染）+ 刷新失败警示条。约 1 天，直接消掉 S1-3/S2-5/S2-6 三条。
3. **死代码一次性清理**（C1-C5 + 根 `src/components/`）：半天，删 ~3000 行，消灭全部「假 UI 地雷」。
4. **i18n 补漏**：27 个缺失 key 入典 + 25 处硬编码中文收编 + 300 残留 key 清理。约 1 天。
5. **登录路径收编**：三条登录成功路径统一走 `completeLogin`（补设备注册），顺手实现或摘除「记住我」。半天。
6. **模板/通知页错误态**（复制 ClipboardView 现成模式）。2 小时。
7. **列表加载总量软上限 + 「用搜索找更旧记录」引导**。2 小时。
8. （中期）token 迁移到 Rust Keyring、avatar 改走媒体接口而非 5MB dataURL 进 localStorage。
