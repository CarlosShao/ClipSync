# ClipSync 桌面端 UI 重构 · 落地方案

> 基于 `ui-prototype/glm/` 两版原型(v1 Ink Bench / v2 Clearline)与 `src/desktop/src/` 现状盘点
> 结论先行:**以 v2「Clearline 澄明」为唯一视觉基底,吸收 v1 三个关键设计决策;采用 token 桥接 + 分阶段换装的增量策略,不重写组件体系**
> 版本: v1.0 · 2026-09-12 · 状态: 待评审(未动代码)

---

## 一、两版原型分析

### 1.1 本质差异

| 维度 | v1「Ink Bench 墨色工作台」 | v2「Clearline 澄明」 |
|---|---|---|
| 气质 | 编辑器物联风:墨黑 + 纸感 + 琥珀荧光笔 + 衬线数字 | 办公常驻舒适:白底大留白 + 一条蓝主线,飞书/Notion 级 |
| 默认主题 | 深色(Ink) | **浅色(Paper)**,深色为柔黑非纯黑 |
| 强调色 | 琥珀 `#F5A524` | 澄明蓝 `#3A6BE0` |
| 字体 | 三轨制:衬线大数 / 人文无衬线 / 等宽内容 | 双轨:无衬线界面 + **等宽承载内容**(继承 v1) |
| AI 定位 | **独立导航页**(三栏:会话栏/画布/检查器) | **全局常驻 dock**:标题栏呼出、上下文感知 chip、用量/记忆并入 popover |
| 导航 | 6 项(含 AI 助手) | **5 项(无 AI)** |
| Agent 确认 | 两级(批准/拒绝) | **三级**(拒绝 / 仅本次 / ▾信任此工具·全部)+ Esc=拒绝 |
| 收藏 | 简单合集侧栏 | **树形合集 + 标签体系**(对齐真实 API) |
| 动效 | 40ms 错峰上浮 | 30ms 更轻 + 统一 ease 曲线纪律 |

### 1.2 从业者视角的判断

**v1 的真正价值(要继承的)**:
1. **等宽字体承载剪贴内容**——全场最有价值的设计决策。剪贴板工具的内容(代码/链接/地址)与界面 chrome 用同一字体是真实存在的"同质化"问题,v1 用字体轨制解决,v2 已继承,落地时作为硬规则执行。
2. **状态可见性**:同步脉搏常驻导航页脚、AI 用量显性化、危险操作显性门控。
3. **详情抽屉内嵌"原位 AI 操作"**、置顶左条、hover 浮出操作条等微交互语言。

**v1 的风险(要放弃的)**:
1. 深色默认 + 高饱和琥珀,对 7×24 常驻桌角的工具视觉刺激偏强;衬线大数字在工具场景偏"出版物"。
2. **AI 做成导航页是架构倒退**:与真实代码不符(现有 `AiChatPanel` 本来就是 HomeView 宿主的全局侧栏,不是子视图),而且 AI 的核心价值恰恰是跨页面上下文——关进一个页面就丢了。

**v2 的决定性优势**:
1. v2 是对 v1 的**方向性修正**(design-contract 明确写了"两个根本性修正"),不是并列备选。
2. **AI dock 架构与现有代码吻合**:`AiChatPanel` 已是全局侧栏、已接收 `:view="currentSub"` 做上下文感知——v2 只是把这件事显性化(ctx-chip + 原位 AI 按钮),改造成本低;v1 则要新增页面并重排导航。
3. Agent 流(thinking→tool→三级确认→再思考→正文→proc-chips)与现有 SSE 协议(`useAiChat` 的 `pendingConfirm`/`approveToolAction`)一一对应。
4. 收藏树+标签、模板变量填充"记住此值"直接对齐现有 API(`favorites.ts` collections/tags、`templateVariableStore`)。
5. token 命名与 `globals.css` 现有体系近乎 1:1(见下),落地成本可控。

**v2 的短板(需补)**:人格偏弱、易"撞脸"飞书/Notion。通过微交互纪律(hover 浮出操作条、置顶左条、kbd 键帽密度、mono 内容)找回辨识度,而不是靠颜色。

### 1.3 结论:合并原则

> **v2 Clearline 为骨,v1 取三点为魂,放弃 v1 的风格层。**

---

## 二、现状盘点(落地的事实基础)

来自 `src/desktop/src/` 代码扫描,以下事实直接决定方案形状:

| # | 现状 | 对方案的影响 |
|---|---|---|
| 1 | `HomeView.vue`(1240 行)是单壳,子视图为 `v-if` 链;路由白名单 8 项(clipboard/archive/favorites/templates/devices/profile/notifications/subscription) | 导航收敛需要 IA 归并表 + 旧路由重定向 |
| 2 | 主题 = `useTheme` composable + `globals.css`(933 行)里 7 套 `theme-*` token 块 × 明暗;token 名 `--bg-base/--bg-sidebar/--bg-surface/--text-primary/--accent/--radius-*/--shadow-*/--z-*`,另有 shadcn 别名块 | **新增一套 `theme-clearline` 即可,组件靠 token 自动换装**;砍旧主题 = 删 token 块 |
| 3 | `AiChatPanel`(1298 行)三槽位宿主(Nav/Canvas/Inspector),已接 `:view="currentSub"`、`aiSidebarOpen`、Ctrl+Shift+A 全局快捷键、`setKeyboardLayer('ai')` Esc 栈 | AI dock 化 = 保留宿主,重排三槽位 + 补上下文 chip + 原位入口,协议层零改动 |
| 4 | SSE 协议:thinking 分段/tool_call/`confirm_tool_action` → `pendingConfirm` → `POST /api/ai/chat/approve` | 三级批准的"信任此工具"需定 scope 存储位置(前端 session 或后端) |
| 5 | QuickPaste 两条线:独立浮窗 `QuickPasteStandalone`(660×58→470,Rust 侧 eval 激活)+ 应用内 `QuickPastePanel`(Ctrl+K) | 浮窗重绘为主;Ctrl+K 面板可升级为统一命令面板 |
| 6 | 主窗口用**原生标题栏**(`decorations: true`,1180×760),`set_titlebar_mode` 已有 | v2 的自定义标题栏是新增工程量,需要单独决策 |
| 7 | UI 底座:Tailwind v4(CSS-first)+ shadcn-vue(reka-ui)+ lucide 图标 + vue-sonner;101/149 文件是 scoped CSS | 不做全量 CSS 重写;shadcn 组件靠 token 换装,业务页按阶段迁移 |
| 8 | 设置已是 `SettingsDialog` 弹窗(懒加载) | 保留弹窗形态,内容按 v2 分组卡重排(改造成本 < 改页面) |
| 9 | i18n 自研 `useI18n`(zh/en 扁平字典) | 原型中文文案全部要走 `t()`,en 同步 |
| 10 | API 层纯 HTTP fetch,领域模块齐备(clipboard/favorites/templates/device/ai) | **数据层零改动**,本次纯表现层重构 |

---

## 三、信息架构(IA)归并

导航从 8 项收敛为 5 项,归并映射:

| 现有子视图 | 去向 | 说明 |
|---|---|---|
| clipboard | 保留,主页 | 时间流 |
| archive | **并入剪贴板页**的分段器(seg:时间流 / 仅置顶 / 仅收藏 / 已归档) | `ClipboardView` 本就支持 `mode="archive"`,改成分段传参 |
| favorites | 保留 | 树形合集 + 标签 |
| templates | 保留 | 变量填充 |
| devices | 保留 | 配对 + 同步日志 |
| notifications | **标题栏铃铛 → 通知 popover** | 复用 `useNotifications` |
| profile | **标题栏头像菜单**(账号信息 / 语言 / 退出登录) | |
| subscription | **设置页「订阅」分组**或头像菜单入口 | 保留 `can('nav.subscription')` 门控 |

路由白名单收窄 + 旧 deep-link 重定向(`/app/archive → /app/clipboard?view=archive`、`/app/notifications → /app/clipboard` 等),避免收藏夹/文档里的旧链接 404。

键盘:`Ctrl+1..4` 切导航、`Ctrl+,` 设置、`Ctrl+K` 命令面板、`Ctrl+Shift+A` AI dock(已有)、`Ctrl+Shift+V` 快速粘贴浮窗(已有)。

---

## 四、分阶段实施计划

> 总原则:**token 桥接先行,先换肤再动刀;每个 Phase 结束都是可发布状态**;`theme-clearline` 以 useTheme 现有机制接入,天然形成灰度/回退开关。
> 约束:全程不动 `src/api/`、`src-tauri/` 业务逻辑(标题栏与确认 scope 两处除外,均有替代方案)。

### Phase 0 · 设计契约冻结 + token 桥接(0.5–1 天)

**做什么:**
1. 将 `v2/_design/design-contract.md` + 本文件定为唯一真相源;v1 原型标记为 archived。
2. `globals.css` 新增 `theme-clearline.light` / `theme-clearline.dark` 两个 token 块,按 v2 色值填**现有 token 名**,映射表:

| v2 原型 token | 现有 globals.css token | 动作 |
|---|---|---|
| `--bg-base` | `--bg-base` | 直接实现 |
| `--bg-nav` | `--bg-sidebar` | 直接实现 |
| `--bg-surface` / `--bg-elev` | `--bg-surface` / 新增 `--bg-elev` | 一个对齐一个新增 |
| `--bg-hover` / `--bg-active` | `--bg-hover` / `--bg-active` | 已有 |
| `--border` / `--border-sub` / `--border-strong` | `--border-default` / `--border-subtle` / 新增 `--border-strong` | 两对齐一新增 |
| `--text-1/2/3` | `--text-primary/secondary/tertiary` | 语义映射 |
| `--accent` 系列(hover/press/fg/soft) | `--accent/--accent-hover/--accent-light/--accent-bg` | 已有,补 `--accent-press` |
| `--r-sm/md/lg/full` | `--radius-sm/md/lg/xl` | 已有 |
| `--sh-card/elev/modal` | `--shadow-card/elevated/dropdown/modal` | 已有,值按 v2 调轻 |
| `--ease` | 新增 `--ease: cubic-bezier(.25,.8,.3,1)` | 全局动效纪律 |
| `--font-mono` 内容规则 | 新增 `--font-content` | 硬规则:剪贴内容/时间戳/键帽/版本号一律 mono |
| z 阶梯(`ai-dock` 62) | `--z-*` 已有 | 补一档 |

3. 同步更新 shadcn 别名块(`--background/--primary/--sidebar*`…),`ui/` 下 shadcn 组件立即换装。
4. `useTheme.ts`:`allStyles` 增加 `'clearline'` 并设为默认;localStorage 旧 key 兼容(无值→clearline)。
5. 在 `App.vue`/全局层注入少量共享工具类(btn/input/chip/badge/kbd/switch/seg/type-tile/empty 的 Vue 版),来源即原型 styles.css 对应段落,但**放 token 化改写,不照抄**。

**验收:** 切到 clearline 主题后,所有现有页面在旧布局下直接变新皮肤,无布局损坏;明/暗切换正常;`set_titlebar_mode` 联动正常。

### Phase 1 · App Shell:标题栏 + 导航(3–5 天)

**做什么:**
1. `tauri.conf.json` → `decorations: false`,新建 `components/layout/TitleBar.vue`:品牌 + 面包屑 + **Ctrl+K 搜索条(按钮态)** + AI/快速粘贴/主题/通知铃铛(带红点)+ 头像菜单 + min/max/close。拖拽区 `data-tauri-drag-region`。
   - **Windows 关键决策**:优先评估 `tauri-plugin-decorum`(保留 Win11 snap layouts 飞出);若评估不通过,**退回保守形态:保留原生标题栏,搜索条下移到各页页头**——shell 其余部分不受此决策影响。
   - 窗口控制接 `getCurrentWindow().minimize()/toggleMaximize()/close()`;双击标题栏最大化、`set_titlebar_mode` 明暗联动。
2. `AppSidebar.vue` 重构为 v2 五项导航(剪贴板/收藏/模板/设备 + 系统:设置),**去掉 AI 入口与已归并项**;页脚 `sync-pill`(数据源:`useDevice` 在线设备数)+ 版本号。
3. HomeView 瘦身第一步:抽 `PageHeader.vue`(页标题/副标题/页级操作)与视图切换逻辑,为 Phase 2 铺路。
4. 路由白名单收窄 + 重定向(见 IA 表);`Ctrl+1..4`/`Ctrl+,` 绑定。

**验收:** 自定义标题栏拖拽/最大化/关闭/snap 行为正常;五项导航高亮态(蓝左条 + accent-soft 底)正确;旧链接重定向可达;通知铃铛 popover 与头像菜单可用。

### Phase 2 · 剪贴板页(4–6 天,最大表面)

**做什么:**
1. ClipboardView 按 v2 重排:页头(标题 + 副标题 + 「AI 总结今日动态」「清理历史」)、搜索框 + 类型 chip 过滤(文本/链接/代码/图片/文件,各配色)、seg 视图(时间流/仅置顶/仅收藏/**已归档**——archive 子视图就此并入)、批量选择 batch-bar、加载更多。
2. `clip-item` 新样式:type-tile 色块 + **mono 内容** + meta(badge/来源/mono 时间)+ hover 浮出操作条(收藏/置顶/AI/更多)+ 置顶左条;归档条目为恢复态。
3. 详情抽屉:mono 全文 + 元信息 + **原位 AI 按钮组**(总结/翻译/提取要点,带本条内容进 dock)+ 底部复制/收藏/删除。
4. 空态/加载态/错误态按 `.empty` 规范;数据层(`useClipboard`/`api/clipboard.ts`)**零改动**。

**验收:** 全类型条目(含图片/文件)渲染正确;过滤/搜索/置顶/收藏/归档/批量/分页回归通过;明暗两态检查;Esc 关抽屉与批量模式。

### Phase 3 · AI Dock 化(3–4 天)

**做什么(协议层零改动,只动呈现与入口):**
1. `AiChatPanel` 重排:取消常驻 Inspector 第三栏 → **用量环 + 长期记忆并入头部 gauge popover**;NavRail 会话列表收进头部 history popover(sm 断点本就是 overlay,交互不变);消息流气泡/think 折叠/toolline/confirm-card/proc-chips 按 v2 样式类重绘(组件已存在:`AiThinkingCollapse`/`AiToolTimeline`/`AiProcessChips` 等,改样式为主)。
2. **上下文感知显性化**:头部 `ctx-chip`「当前上下文 · 剪贴板」——数据源就是现有 `:view="currentSub"` prop;composer placeholder 带页面名;首次打开欢迎条。
3. **原位 AI 统一入口**:新增 `useAiDock()` composable(包一层现有 toggle/打开逻辑),暴露 `openAiDock({ action, target })`;各页 `data-ai` 按钮调用,动作 + 目标内容预填 composer。
4. **三级确认门控**:现有 `pendingConfirm` UI 扩展为 拒绝 / 仅本次允许 / ▾(信任此工具·本会话 / 全部允许);`Esc`=拒绝 接入现有 `setKeyboardLayer('ai')` 栈。scope 存储:**默认前端 session Set 自动批(不改后端)**;如后端愿意在 `/api/ai/chat/approve` 加 scope 参数则切后端(列为协调项,不阻塞)。

**验收:** dock 从任意页呼出,ctx-chip 随页面切换刷新;原位 AI 预填正确;SSE 三态(thinking/tool/confirm)与三级批准全流程走通;Esc 优先级(确认挂起时 Esc=拒绝,优先于关面板);宽窄断点布局不塌。

### Phase 4 · 收藏 / 模板 / 设备(5–7 天)

1. **收藏**:col-tree 树形合集(折叠箭头/计数/hover 操作:新建子夹·重命名·删除,对齐现有 `createCollection/updateCollection/deleteCollection`)+ tag-pill 筛选条 + 标签管理 modal(`createFavTag/updateFavTag/deleteFavTag`)+ 条目"编辑标签"(`setItemTags`)+ sensitive 标记。现有 FavoritesView 已有这些 API 对接,属视图重构。
2. **模板**:列表 + `{{var}}` 高亮编辑器 modal + 使用模板 → 变量填充表单("记住此值"→ localStorage 预填,对齐 `templateVariableStore`)+ 用量展示。
3. **设备**:本机卡 + 对端列表(在线/离线/暂停)+ 扫码配对 modal(扫码占位 + 手动输配对码,对齐 `device.ts` pairing)+ 同步日志时间线。

**验收:** 合集 CRUD/嵌套/拖拽归位;标签筛选与打标闭环;模板变量填充→复制全链路;配对 modal 走通现有 redeem 流程。

### Phase 5 · 快速粘贴 + 命令面板 + 设置(4–5 天)

1. **QuickPasteStandalone 重绘**:Clearline token + mono 内容 + 1–8 直选数字徽标;**行为零改动**(resize/startDragging/pinned localStorage/预测建议全保留)。
2. **Ctrl+K 升级为统一命令面板**:改造现有应用内 `QuickPastePanel` 为三段式——剪贴结果(主段,mono 预览)/ 页面导航(五项)/ 快捷操作(切换主题、开 AI、开设置);`Ctrl+K` 语义不变,价值升级。`Ctrl+Shift+V` 浮窗保持独立。
3. **设置**:保留 `SettingsDialog` 弹窗形态,内容重排为 v2 分组卡(外观 / 同步 / 隐私 / 快捷键录制 / 模板变量默认值 / 数据管理 / 订阅 / AI 会话),每卡独立保存;新增**快捷键录制控件**。
4. **主题选择器收敛**:外观分组改为「明 / 暗 / 跟随系统 + 强调色(可选扩展)」;7 套旧主题入口在本版保留为「经典主题」折叠项(回退用)。

**验收:** 浮窗全局热键、展开/收起、回冲行为不回归;Ctrl+K 三段搜索与键盘流;设置各卡保存持久化;快捷键录制可用。

### Phase 6 · 清理与回归(2–3 天)

1. 删除 6 套旧主题 token 块与死样式;`useTheme` 收敛为 clearline 单人格。
2. 全量 i18n 走查:原型中文文案全部进 `zh.json`/`en.json`(走 `t()`),不留硬编码。
3. 可达性与体检:`prefers-reduced-motion`(现有 `html.reduce-motion` 对齐)、焦点环、对比度、纯键盘走查。
4. 视觉回归矩阵:明/暗 × 6 页面 × 1180×760 与 1440+ 两档宽度。

---

## 五、风险清单与对策

| # | 风险 | 对策 |
|---|---|---|
| 1 | HomeView 1240 行是重灾区,样式与结构混改必炸 | Phase 1 先抽 PageHeader/ShellSlot;每 Phase 只碰自己负责的区块 |
| 2 | 自定义标题栏的 Windows 细节(snap layouts 飞出、双击最大化、多显示器) | 优先 `tauri-plugin-decorum`;评估不过立即退回原生标题栏 + 页头搜索条的保守形态(方案已预留) |
| 3 | 101 个 scoped CSS 文件,不可能全量重写 | 不重写;shadcn 组件靠 token 自动换装,业务页按 Phase 迁移,迁移完的文件顺手删旧样式 |
| 4 | 「信任此工具」的权限语义 | 默认前端 session 实现(不改后端);与后端协调 approve 接口加 scope 为增强项 |
| 5 | 砍 7 套主题是用户可感知的功能回退 | 保留一版「经典主题」折叠入口作回退,稳定后(下一版)再删 |
| 6 | 原型中文文案硬编码进组件 | Phase 0 起立规矩:所有新文案必须 `t()`,en 同步补;Phase 6 专项走查 |
| 7 | AI dock 改造碰到 1298 行的 AiChatPanel | 协议层(useAiChat/SSE)零改动;只动 AiPanel 槽位排布与样式组件;改动拆 PR |

---

## 六、工作量与交付节奏

| Phase | 内容 | 估时(1 人) |
|---|---|---|
| 0 | token 桥接 + 主题接入 | 0.5–1 天 |
| 1 | 标题栏 + 导航 + IA 归并 | 3–5 天 |
| 2 | 剪贴板页 + 抽屉 + 批量 | 4–6 天 |
| 3 | AI Dock 化 + 三级确认 | 3–4 天 |
| 4 | 收藏 / 模板 / 设备 | 5–7 天 |
| 5 | 快速粘贴 + 命令面板 + 设置 | 4–5 天 |
| 6 | 清理 + i18n + 回归矩阵 | 2–3 天 |
| **合计** | | **约 3.5–4.5 周** |

每个 Phase 独立成 PR、独立可发布;`theme-clearline` 在 Phase 6 前始终可通过旧主题回退。

---

## 七、待拍板决策(评审焦点)

1. **主题收敛**:彻底收敛为 1 套人格(明/暗 + 可选强调色)?→ **推荐:是**,旧主题保留一版作「经典主题」回退。
2. **自定义标题栏**:上 `decorum` 插件方案,还是保守原生标题栏?→ **推荐:先试 decorum,两天内评估不通过立即退保守方案**。
3. **设置形态**:保留弹窗(推荐,改造成本低)还是升级为独立页面?
4. **AI 会话列表**:收进头部 popover(推荐,腾出阅读宽度)还是宽屏保留内联 NavRail?
5. **Ctrl+K 语义**:升级为统一命令面板(推荐)还是维持纯快速粘贴?

---

## 附:原型 → 工程对照速查

| 原型产物 | 工程落点 |
|---|---|
| `styles.css` tokens | `globals.css` 新增 `theme-clearline.*` 块 + 少量新 token |
| App Shell(逐字粘贴) | `HomeView.vue` + 新 `TitleBar.vue` + `AppSidebar.vue` 重构 |
| `components.js` 注入的 dock/命令面板/toast | Vue 组件:`useAiDock()`、`QuickPastePanel` 升级、`vue-sonner`(已有) |
| `mock.js` | 弃用,直连现有 `useClipboard`/`useCollectionStore`/`templateStore`/`useDevice` |
| `api.js` 存根 | 弃用,现有 `src/api/*` 即真实实现,签名已对齐 |
| `quickpaste.html` | `QuickPasteStandalone.vue` 重绘 |
| 三级确认卡 | `pendingConfirm` UI 扩展 + `setKeyboardLayer('ai')` |
