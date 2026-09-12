# Design Contract v2 · ClipSync Redesign「Clearline 澄明」

> 冻结：2026-09-12 · v2 唯一真相源。v1（Ink Bench）保留为备选风格，本版**彻底换方向**。

## 0. 相对 v1 的两个根本性修正

1. **风格转向**：v1 文艺（衬线/墨黑/琥珀）→ v2 **办公常驻舒适**。长时间挂在桌面角落的工具：低饱和、大留白、柔和中性色、轻阴影、丝滑动效。默认**浅色**（Paper 白），深色同理念（柔黑非纯黑）。
2. **AI 架构修正**：AI **不是导航页**，而是**全局常驻 dock**——对齐真实代码逻辑（AiChatPanel 挂 HomeView 宿主，`aiSidebarOpen` 全局开合）。任意页面右上角/快捷键呼出，右侧滑出 380px 面板，**自动携带当前页面上下文**：dock 顶部常驻「当前上下文：剪贴板/收藏/…」chip，用户直接问"当前是什么页面"AI 即可回答；各业务页的"原位 AI"按钮也是把上下文带进 dock，而不是跳转。

## 1. 技术栈与交付

- vanilla HTML+CSS+JS 纯静态、零外链、离线可开；目录 `v2/clipsync-clearline/`，入口 `index.html`
- 图标：内联 SVG（Lucide 规格），`<i data-ic="name">` 占位由 components.js 注入

## 2. 风格定位

- style tier: minimal-light（安静生产力）
- aesthetic: **Clearline 澄明** —— 飞书/Notion 级的办公舒适度：白底呼吸感 + 一条柔和蓝主线 + 无噪音
- tone: 干净 / 宽松 / 低刺激 / 高效
- 禁用：衬线大标题、大面积深色、玻璃拟态、紫渐变、噪点纹理

## 3. Tokens（styles.css 唯一来源）

### 浅色（默认 `html.light` 或 `:root`）
| token | 值 |
|---|---|
| --bg-base | #F4F5F7 |
| --bg-nav | #FBFBFC |
| --bg-surface / --bg-elev | #FFFFFF |
| --bg-hover / --bg-active | #EEF0F3 / #E5E8EE |
| --border / --border-sub / --border-strong | #E4E6EB / #ECEEF1 / #CBD0D8 |
| --text-1 / -2 / -3 | #20242B / #5F6672 / #9AA1AC |
| **--accent 澄明蓝** | #3A6BE0（hover #2F5BCC / press #264CAB / fg #FFFFFF） |
| --accent-soft / -soft2 | rgba(58,107,224,.10) / .18 |
| 类型色 | 文本 #3A6BE0 / 链接 #2E9E6B / 代码 #0D9488 / 图片 #D97706 / 文件 #7A8494 |
| 语义 | success #2E9E6B / warning #D98A16 / danger #D94A3A / info #3A6BE0 |
### 深色（`html.dark`，柔黑非纯黑）
--bg-base #16181C / nav #1A1D22 / surface #1F2228 / elev #24272E / hover #282C34 / active #2E333C
--border #2C3038 / sub #262A31 / strong #3A404B；--text-1 #E8EAEE / -2 #A6ACB8 / -3 #7A818D
--accent #6E93FF（hover #86A5FF / fg #10152B）；语义色同系提亮

### 字体/字阶/半径/阴影/动效
- --font-body: 'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI','PingFang SC',sans-serif（正文/标题统一，标题靠字重与字号分层）
- --font-mono: 'Cascadia Code',Consolas,monospace（剪贴内容/时间戳/键帽/版本号）
- 字阶 11/12/13/14/16/20/26；标题 20px 600 即可，不用巨字
- 半径 --r-sm 8 / --r-md 12 / --r-lg 16 / --r-full 999
- 阴影轻且扩散：--sh-card `0 1px 2px rgba(16,24,40,.04)`、--sh-elev `0 12px 32px rgba(16,24,40,.10)`、--sh-modal `0 24px 64px rgba(16,24,40,.16)`
- **动效丝滑纪律**：统一 `--ease: cubic-bezier(.25,.8,.3,1)`；常规 hover 160ms；面板/抽屉 260ms；dock 滑入 280ms；仅 opacity/transform；页载 reveal 错峰 30ms（更轻）；reduced-motion 全禁
- z 阶梯：titlebar 50 / pop 60 / **ai-dock 62** / drawer 65 / modal 70 / toast 80

## 4. App Shell（冻结 · 每页逐字粘贴）

```html
<body data-page="clipboard"><!-- 每页改 key：clipboard/favorites/templates/devices/settings -->
<div class="app">
  <header class="titlebar">
    <div class="tb-left">
      <span class="brand-mark"><i data-ic="clipboard-list"></i></span>
      <span class="brand-word">ClipSync</span>
      <span class="tb-sep"></span>
      <span class="tb-crumb">剪贴板</span><!-- 每页改文案 -->
    </div>
    <button class="cmdk" id="cmdkBtn"><i data-ic="search"></i><span>搜索或命令…</span><kbd>Ctrl K</kbd></button>
    <div class="tb-right">
      <button class="tb-btn ai-trigger" id="aiBtn" title="AI 助手 · Ctrl+Shift+A"><i data-ic="sparkles"></i><span>AI</span></button>
      <button class="tb-btn" id="qpBtn" title="快速粘贴 · Ctrl+Shift+V"><i data-ic="panel-top"></i></button>
      <button class="tb-btn" id="themeBtn" title="切换明暗"><i data-ic="moon"></i></button>
      <button class="tb-btn" id="bellBtn" title="通知"><i data-ic="bell"></i><i class="dot" id="bellDot"></i></button>
      <span class="tb-sep"></span>
      <button class="tb-btn win" data-win="min"><i data-ic="minus"></i></button>
      <button class="tb-btn win" data-win="max"><i data-ic="square"></i></button>
      <button class="tb-btn win close" data-win="close"><i data-ic="x"></i></button>
    </div>
  </header>
  <aside class="app-nav">
    <a class="nav-item" data-nav="clipboard" href="index.html"><i data-ic="clipboard-list"></i><span>剪贴板</span><kbd>Ctrl 1</kbd></a>
    <a class="nav-item" data-nav="favorites" href="favorites.html"><i data-ic="star"></i><span>收藏</span><kbd>Ctrl 2</kbd></a>
    <a class="nav-item" data-nav="templates" href="templates.html"><i data-ic="layout-template"></i><span>模板</span><kbd>Ctrl 3</kbd></a>
    <a class="nav-item" data-nav="devices" href="devices.html"><i data-ic="laptop"></i><span>设备</span><kbd>Ctrl 4</kbd></a>
    <div class="nav-sec">系统</div>
    <a class="nav-item" data-nav="settings" href="settings.html"><i data-ic="settings-2"></i><span>设置</span><kbd>Ctrl ,</kbd></a>
    <div class="nav-foot">
      <div class="sync-pill"><i class="pulse"></i><span>已同步 · 3 台设备</span></div>
      <div class="nav-ver">v0.4.2 · clearline</div>
    </div>
  </aside>
  <main class="app-main"><div class="page reveal">…页面内容…</div></main>
</div>
<script src="mock.js"></script>
<script src="api.js"></script>
<script src="components.js"></script>
</body>
```

- 定位：titlebar fixed 44px；app-nav fixed top44 left0 bottom0 width 216px；app-main margin 44px 0 0 216px
- active 规则：components.js 按 body[data-page] 加 .active（accent-soft 底 + 蓝左条）
- quickpaste.html 独立小窗 surface（.qp-*），不用此 shell
- **导航只有 5 项，没有 AI**（AI 在 titlebar + dock）

## 5. AI Dock（全局感知面板 · components.js 统一注入，页面不手写）

- components.js 在 DOMContentLoaded 时幂等注入 `<aside id="aiDock" class="ai-dock">` 骨架 + 遮罩；**所有 shell 页自动拥有**
- 开合：`openAiDock({context})` / `closeAiDock()` / `toggleAiDock()`；绑定 titlebar #aiBtn、快捷键 Ctrl+Shift+A、各页"原位 AI"按钮（data-ai 属性）；280ms 滑入滑出
- **上下文感知**：面板顶条常驻 `.ctx-chip`：「当前上下文 · {页面名}」（读 body[data-page] → PAGE_LABEL 映射）；首次打开有欢迎条说明可基于当前页提问
- mock 感知回答：api.js 的 askAI 检测"当前/哪个/什么页面/这页"等关键词 → 回答当前页面名与该页功能简介
- 结构：头部（sparkles+标题+历史 popover 按钮+用量环入口+关闭）/ 消息流（user/ai 气泡、think 折叠、toolline、confirm-card 复用组件类）/ composer（输入+模型 sel+发送）
- 用量与记忆并入头部 popover，不做第三栏
- 各业务页的原位 AI 按钮：`data-ai="总结"` 等 → openAiDock 并把动作+选中内容摘要预填进 composer

## 6. 组件类（styles.css 已备，只拼不造）

.btn(.btn-acc/.btn-ghost/.btn-danger/.btn-sm) .icon-btn .input .search .chip(.active) .badge(.b-text/.b-link/.b-code/.b-image/.b-file/.b-gray/.b-ok) .kbd .switch .seg .tabs .bar .ring
.panel .stat .clip-item .type-tile(.t-text/.t-link/.t-code/.t-image/.t-file) .clip-acts
.modal-mask>.modal .drawer .pop .toast .empty .hintbar
AI 族：.ai-dock .dock-head .ctx-chip .dock-scroll .msg .think .toolline .confirm-card .composer
设置：.set-layout .set-nav .set-row .set-group .hotkey-pill
浮窗：.qp-body .qp-win .qp-search .qp-list .qp-item .qp-foot

## 7. 页面清单（6 页 + 全局 dock）

| 文件 | data-page | 责任 |
|---|---|---|
| index.html | clipboard | 剪贴板时间流：搜索/类型过滤/置顶/详情抽屉/原位 AI（进 dock） |
| favorites.html | favorites | 合集+卡片网格+搜索 |
| templates.html | templates | 列表+编辑器+{{var}} 高亮预览+用量 |
| devices.html | devices | 本机卡+对端+扫码配对+同步日志 |
| settings.html | settings | 7 分类 hash 路由+开关持久化+快捷键录制 |
| quickpaste.html | （独立） | 420px 浮窗，全键盘 |

## 8. Mock / API

- mock.js：DB.user/clips/collections/favItems/templates/devices/syncLog/convos/usage/memories/notifications + DB.PAGE_LABEL（clipboard→剪贴板 等 5 项）
- api.js 存根同 v1 形状；askAI(text,{pageKey}) 增加页面感知分支
- 所有函数带 delay 与 HTTP 注释，供后端机械替换

## 9. 红线

禁紫渐变/玻璃拟态/衬线大标题/emoji 图标/外链资源；列表 ≥8 条真实中文文案；所有交互有 hover/active/空态；导航 5 项无 AI。

## 10. 功能补全修订（2026-09-12 · 对齐真实系统）

### 10.1 AI Dock · Agent 流（强化，对齐 useAiChat SSE 事件序）
- 非页面感知提问一律走 `askAgent()`（api.js）：thinking 分段流入（`.think.live` + `.live-dot` 脉冲）→ 工具时间线（`.toolwrap>.toolline`，状态 run 旋转 / ok / wait / deny）→ 破坏性工具挂起出确认卡（`.confirm-card`，三级批准：拒绝 / 仅本次允许 / ▾信任此工具·全部允许；`Esc` = 拒绝，优先于关面板）→ 二次思考追加进同一 thinking 块 → 正文流入（开始时 thinking 自动折叠）→ `.proc-chips` 封段（时长 / 思考耗时 / 工具数 / 批准策略）
- 页面感知提问（"当前/哪个/什么页面"等）仍走 `askAI` 轻量流
- `AI_STATE.pendingConfirm`：确认挂起期间的全局 Esc 裁决钩子

### 10.2 收藏页（对齐 useCollections + setItemTags）
- 树形合集：`.col-tree>.col-node`（`.tw` 折叠箭头 / `.cnt` 计数 / `.node-acts` hover 操作：新建子收藏夹·重命名·删除）+ `.col-children` 缩进嵌套；新建/重命名/删除走 createCollection/updateCollection/deleteCollection
- 标签体系：`.tag-pill`（`--tagc` 色点，`.on` 选中态）筛选条 + 管理标签 modal（新建 createFavTag / 改色 updateFavTag / 删除 deleteFavTag）；条目渲染 tags + sensitive 标记；条目"编辑标签"调 setItemTags(id, tags, tagColors)
- API 新增：fetchFavItems(cid,q,tag) / addFavItem / moveCollection

### 10.3 模板页
- 新建模板 modal 编辑器（标题/分组/正文，{{变量}} 高亮）；删除模板 deleteTemplate
- 使用模板：解析 {{vars}} → 变量填充表单 modal（"记住此值"存 localStorage，下次预填）→ useTemplate(id, vars) → 结果复制

### 10.4 设备页 / 设置页
- 设备：补"扫一扫"配对入口（扫码占位 + 手动输入配对码备选）
- 设置：补外观 / 模板变量默认值 / 数据管理 / 订阅 / AI 会话卡片，每卡独立保存 + localStorage 持久化
