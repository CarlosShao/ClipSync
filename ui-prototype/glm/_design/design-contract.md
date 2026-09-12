# Design Contract · ClipSync Redesign「Ink Bench 墨色工作台」

> 冻结时间：2026-09-12 · 本契约是所有页面的唯一真相源，子代理只许引用、禁止发明。

## 0. 技术栈与交付

- **stack**: vanilla HTML + CSS + JS（纯静态，零外部依赖，离线可开）
- **delivery**: `ui-prototype/glm/clipsync-redesign/`，入口 `index.html`
- **禁止**: 任何 CDN/网络字体/外链脚本；图标全部内联 SVG（Lucide 规格）

## 1. 风格定位

- style tier: brand-themed（编辑器物联风 / editorial-utilitarian）
- aesthetic: **Ink Bench 墨色工作台** —— 深夜油墨色桌面 + 纸张质感内容 + 荧光笔琥珀标记。
  剪贴板的隐喻是"纸签与剪报"：内容用等宽字体呈现（保留原文气质），数据用衬线字体呈现（编辑部气质）。
- tone keywords: 克制 / 高密度 / 工匠感 / 无玻璃拟态 / 无渐变紫
- 与既有方案（gemini 玻璃 Prism、minimax 流光 Pulse）刻意区分：**哑光、纸墨、衬线×等宽双排字**

## 2. Design Tokens（全部写死在 styles.css，页面只引用 class，不写裸值）

### 2.1 双主题（`html.dark` 默认 / `html.light`，localStorage `ib-theme` 持久化）

| token | dark (Ink) | light (Paper) |
|---|---|---|
| --bg-base | #0D0E12 | #F2F0E9 |
| --bg-nav | #101218 | #FAF8F1 |
| --bg-surface | #16181F | #FFFFFF |
| --bg-elev | #1C1F28 | #FFFFFF |
| --bg-hover | #20242E | #EDEAE0 |
| --bg-active | #272C38 | #E3DFD1 |
| --border | #262B35 | #E2DED0 |
| --border-sub | #1D212A | #EBE7DA |
| --border-strong | #39404E | #C9C3B0 |
| --text-1 | #ECEEF2 | #1D1F26 |
| --text-2 | #A2A8B4 | #5B6070 |
| --text-3 | #6D7380 | #8D927F…(以 css 为准) |
| --accent（荧光琥珀） | #F5A524 | #B97A08 |
| --accent-2（靛青，AI/链接） | #6E8EF5 | #3B5FD9 |
| --success / --warning / --danger | #3FB68B / #E8A33D / #E5534B | 同系加深 |
| --accent-soft | rgba(245,165,36,.12) | rgba(185,122,8,.12) |

### 2.2 字体 / 字阶 / 半径 / 阴影 / 动效

- --font-display: `Georgia, 'Times New Roman', serif` —— 仅用于：大数字 .stat-num、品牌字标、AI 引用强调
- --font-body: `'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI','PingFang SC',sans-serif`
- --font-mono: `'Cascadia Code','JetBrains Mono',Consolas,monospace` —— 剪贴内容、时间戳、快捷键、版本号
- 字阶: 11 / 12 / 13 / 14 / 16 / 20 / 24 / 30 / 38
- 半径: --r-sm 6 / --r-md 10 / --r-lg 14 / --r-full 999
- 阴影: --sh-card（轻）/--sh-elev（中）/--sh-modal（重），light 主题等比减弱
- 动效: 仅 opacity/transform；页载 .reveal 子项错峰上浮（40ms 步进，上限 8 项）；hover 120ms ease；`prefers-reduced-motion` 全禁
- z 阶梯: titlebar 50 / pop 60 / drawer 65 / modal 70 / toast 80

## 3. App Shell（冻结 · 每页逐字粘贴，仅 `<body data-page>` 与 `<main>` 内不同）

```html
<body data-page="clipboard"><!-- 每页改这个 key -->
<div class="app">
  <header class="titlebar">
    <div class="tb-left">
      <span class="brand-stamp"><i data-ic="scissors"></i></span>
      <span class="brand-word">ClipSync</span>
      <span class="tb-sep"></span>
      <span class="tb-crumb" id="tbCrumb">剪贴板</span><!-- 每页改文案 -->
    </div>
    <button class="cmdk" id="cmdkBtn" title="命令面板">
      <i data-ic="search"></i><span>搜索或命令…</span><kbd>Ctrl K</kbd>
    </button>
    <div class="tb-right">
      <button class="tb-btn" id="qpBtn" title="快速粘贴面板 · Ctrl+Shift+V"><i data-ic="panel-top"></i></button>
      <button class="tb-btn" id="themeBtn" title="切换明暗"><i data-ic="moon"></i></button>
      <button class="tb-btn" id="bellBtn" title="通知"><i data-ic="bell"></i><i class="dot" id="bellDot"></i></button>
      <span class="tb-sep"></span>
      <button class="tb-btn win" data-win="min"><i data-ic="minus"></i></button>
      <button class="tb-btn win" data-win="max"><i data-ic="square"></i></button>
      <button class="tb-btn win close" data-win="close"><i data-ic="x"></i></button>
    </div>
  </header>
  <aside class="app-nav">
    <div class="nav-sec">工作台</div>
    <a class="nav-item" data-nav="clipboard" href="index.html"><i data-ic="clipboard-list"></i><span>剪贴板</span><kbd>Ctrl 1</kbd></a>
    <a class="nav-item" data-nav="favorites" href="favorites.html"><i data-ic="star"></i><span>收藏</span><kbd>Ctrl 2</kbd></a>
    <a class="nav-item" data-nav="templates" href="templates.html"><i data-ic="layout-template"></i><span>模板</span><kbd>Ctrl 3</kbd></a>
    <a class="nav-item" data-nav="devices" href="devices.html"><i data-ic="laptop"></i><span>设备</span><kbd>Ctrl 4</kbd></a>
    <a class="nav-item" data-nav="ai" href="ai.html"><i data-ic="sparkles"></i><span>AI 助手</span><kbd>Ctrl 5</kbd></a>
    <div class="nav-sec">系统</div>
    <a class="nav-item" data-nav="settings" href="settings.html"><i data-ic="settings-2"></i><span>设置</span><kbd>Ctrl ,</kbd></a>
    <div class="nav-foot">
      <div class="sync-pill"><i class="pulse"></i><span>已同步 · 3 台设备</span></div>
      <div class="nav-ver">v0.4.2 · ink-bench</div>
    </div>
  </aside>
  <main class="app-main"><!-- 页面唯一可写区 -->
    <div class="page reveal">…</div>
  </main>
</div>
<script src="mock.js"></script>
<script src="api.js"></script>
<script src="components.js"></script>
<!-- 页面自有 script 最后 -->
</body>
```

- 定位：`.titlebar{position:fixed;top:0;left:0;right:0;height:44px;z-index:50}`
  `.app-nav{position:fixed;top:44px;left:0;bottom:0;width:224px}`
  `.app-main{margin:44px 0 0 224px;height:calc(100vh - 44px);overflow-y:auto}`
- active 规则：components.js 按 `body[data-page]` 给匹配 `.nav-item` 加 `.active`（琥珀左条 + accent-soft 底）
- quickpaste.html 是独立小窗 surface，不用此 shell（样式类 `.qp-*`）

## 4. 组件规格（class 已全在 styles.css，子代理只拼结构）

- 按钮：`.btn` 默认 surface 底 / `.btn-acc` 琥珀实底深字 / `.btn-ghost` / `.btn-danger`；尺寸 `.btn-sm` 28px、默认 34px；`.icon-btn` 28px 方形
- 输入：`.input`（focus 琥珀描边+soft 光晕）；`.search` 带左图标
- chip：`.chip`（过滤片，`.active` 琥珀）；`.badge` 类型徽标 `.b-text/.b-link/.b-code/.b-image/.b-file`（各色文字+soft 底）
- `.kbd` 等宽键帽；`.switch` 拨杆；`.seg` 分段器；`.tabs` 下划线页签
- 卡片：`.panel`（surface+border+r-md+sh-card）；`.stat` 数据格（serif 大数）；`.clip-item` 剪贴行（hover 浮出操作）
- 浮层：`.drawer`（右滑详情）/`.modal-mask>.modal` / `.pop` / `.toast`（components.js 提供 `toast(msg,type)`）
- AI：`.chat-*` 消息流、`.think`（折叠思考）、`.toolline`（工具时间线）、`.confirm-card`（危险确认卡）、`.composer`（输入坞）、`.ring`（conic 用量环）
- 设置：`.set-layout` 左右分栏、`.set-nav`、`.set-row`、`.set-group`
- 空态：`.empty`（icon+标题+描述+动作）

## 5. 图标（Lucide 内联 SVG）

统一 `<i data-ic="name"></i>` 占位，components.js 启动时替换为内联 SVG（16px，stroke 1.75，currentColor）。
已注册图标名（只用这些）：scissors, clipboard-list, star, layout-template, laptop, smartphone, monitor, sparkles, settings-2, bell, moon, sun, minus, square, x, search, panel-top, pin, copy, trash-2, check, check-check, link-2, image, file-text, code-2, file, clock, refresh-cw, wifi, qrcode, plus, send, paperclip, brain, zap, chevron-down, chevron-right, more-horizontal, shield, shield-alert, database, info, alert-triangle, arrow-right, corner-down-left, keyboard, palette, history, message-square, folder, filter, command, loader, pencil, circle-check, globe, type, hash, download, gauge, cpu, archive, tag, user, play, bot, wrench, terminal, layers, eye, hard-drive, maximize-2

## 6. 页面清单（7 页）

| 文件 | data-page | 责任 | 关键交互 |
|---|---|---|---|
| index.html | clipboard | 剪贴板时间流：搜索/类型过滤/置顶/详情抽屉 | 过滤、复制 toast、pin/fav、抽屉、AI 原位操作 |
| favorites.html | favorites | 收藏夹：合集侧栏+卡片网格 | 合集切换、搜索、移出收藏 |
| templates.html | templates | 模板库：列表+编辑器预览+变量 | 新建/编辑、{{var}} 高亮、插入变量、使用计数 |
| devices.html | devices | 设备 mesh：本机卡+对端列表+配对 | 扫码配对 modal、同步日志、暂停/移除 |
| ai.html | ai | AI 三栏：会话栏+聊天画布+检查器 | 流式 mock、思考折叠、工具时间线、确认卡 allow/deny、会话切换 |
| settings.html | settings | 设置：左分类右表单 | 子页切换、开关持久化、快捷键录制 mock |
| quickpaste.html | （独立） | 快速粘贴浮窗 420×600 | 搜索过滤、键盘选中、粘贴回冲 |

## 7. Mock Schema（mock.js 单一数据源）

- DB.clips: {id,type(text|link|code|image|file),content,lang?,source,time,pinned,fav,size?,dims?,favicon?}
- DB.collections: {id,name,icon,count}; DB.favItems 引用 clips 形态 + collectionId
- DB.templates: {id,title,body(含 {{var}}),usage,updated,tag}
- DB.devices: {id,name,kind(desktop|laptop|phone),os,status(online|offline|paused),lastSync,ip}
- DB.syncLog: {id,time,dir(up|down),summary,device}
- DB.convos: {id,title,model,time,count}; DB.messages[convoId]: {role,html?,text?,think?,tools?,confirm?}
- DB.usage: {used,total,cacheHit,cost}; DB.memories: {id,key,value,updated}
- DB.notifications: {id,kind,title,desc,time,read}
- DB.user: {name,plan,email}

## 8. api.js 存根（形状即未来真 API，带 delay 与 TODO）

fetchClips({type,q}) · copyItem(id) · togglePin(id) · toggleFav(id) · removeClip(id)
fetchCollections() · fetchFavItems(cid,q) · fetchTemplates() · saveTemplate(t) · useTemplate(id)
fetchDevices() · pairDevice() · toggleDevice(id,action) · fetchSyncLog()
fetchConvos() · fetchMessages(cid) · askAI(text)（分段 delay 模拟流式）· resolveConfirm(id,allow)
fetchUsage() · fetchNotifications() · markAllRead()

## 9. 反 AI 廉价感红线

禁紫渐变、禁玻璃模糊、禁纯黑正文、禁 emoji 当图标、按钮/输入/列表必须有 hover+active 态、
空态必须有引导动作、所有列表数据 ≥8 条且文案真实业务化（中文为主）。
