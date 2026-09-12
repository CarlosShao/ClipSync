# ClipSync 桌面端前端完整重构方案 · Ink Bench（墨色工作台）

> **文档版本**: v1.0.0 (GLM Edition)
> **设计代号**: `Ink Bench` 墨色工作台 —— 编辑器物联风
> **目标工程**: ClipSync 桌面客户端 (Tauri 2 + Vue 3.5)
> **约束守则**: 仅限设计与原型输出，严禁触碰任何生产代码；所有产出封印于 `ui-prototype/glm/`
> **生成日期**: 2026-09-12

---

## 0. 一句话宣言

**把剪贴板从「数据库流水账」还原为「工匠工作台上的剪报册」**：
哑光油墨底、纸感内容卡、荧光笔琥珀标记、衬线数字 × 等宽内容的双排字系统。
无玻璃拟态、无紫渐变、无流光——与既有方案（gemini 的 Prism 玻璃、minimax 的 Pulse 流光）刻意走第三条路：**克制的、印刷品气质的工具美学**。

---

## 1. 现状审计摘要

基于 `src/desktop/src/` 实际代码扫描：

- **视图体系**：单壳 `HomeView` + 8 个子视图白名单（clipboard/archive/favorites/templates/devices/profile/notifications/subscription）；QuickPaste 为独立 Tauri 窗口（`mode=qp`）；AI 面板已是三栏 Shell（AiPanel: Nav/Canvas/Inspector）。
- **视觉体系**：7 套仿制主题（vercel/notion/linear/apple/raycast/arc…）× 明暗。Token 基建完善（`--bg-*`/`--text-*`/`--accent`/`--shadow-*`/`--z-*`），但风格是"换皮合集"，**没有自己的产品人格**。

### 核心诊断

| # | 现状 | 症结 | Ink Bench 对策 |
|---|------|------|---------------|
| 1 | 7 套主题换皮 | 品牌无重心、维护翻倍 | 收敛为 **1 套人格 + 明暗双态**（Ink / Paper） |
| 2 | 仿制品气质 | 界面像"别人的产品" | 自有隐喻：纸墨 + 荧光标记 + 衬线数字 |
| 3 | 内容与界面同质 | 代码/链接/地址都是同一种灰字 | **等宽字体承载内容原文**，界面用人文无衬线，数据用衬线——三种字各司其职 |
| 4 | 状态隐形 | 同步/加密/用量藏在角落 | 左栏常驻同步脉搏、AI 页常驻用量环、确认卡显性门控 |
| 5 | 键盘流弱 | 快捷键仅存在设置页 | 全局 `Ctrl+K` 命令面板 + 导航键帽 + QuickPaste 全键盘 |

---

## 2. 设计系统

### 2.1 色彩（双主题 token，CSS 变量驱动）

| 角色 | Ink（深色·默认） | Paper（浅色） |
|---|---|---|
| 基底 | `#0D0E12` 墨黑 | `#F2F0E9` 纸白 |
| 表面 | `#16181F` | `#FFFFFF` |
| 文字 | `#ECEEF2` | `#1D1F26` |
| **强调（荧光笔琥珀）** | `#F5A524` | `#B97A08` |
| 辅助（靛青·AI/链接） | `#6E8EF5` | `#3B5FD9` |
| 语义 | 绿 `#3FB68B` / 橙 `#E8A33D` / 红 `#E5534B` | 同系加深保证对比度 |

氛围层：全局 1% 透明度 SVG 噪点颗粒（纸墨质感），无渐变堆砌。

### 2.2 字体三轨制（原型离线可用，系统字体栈）

- **衬线 `Georgia/serif`**：大数字（.stat-num）、品牌字标 —— 编辑部气质
- **人文无衬线 `Segoe UI / 雅黑`**：界面文案
- **等宽 `Cascadia Code/Consolas`**：剪贴内容、时间戳、快捷键、版本号 —— 内容保留"原文"气质

### 2.3 组件与动效

- 半径 6/10/14，阴影三档克制分层；按钮/输入/chip/徽标/开关/分段器/页签全套
- 剪贴行 `.clip-item`：hover 浮起 + 右上角浮出操作条；置顶项左侧琥珀条
- AI 族：思考折叠块、工具时间线（done/run/wait 三态圆点）、**危险确认卡**（琥珀警示色 + 120s 倒计时 + 批准/拒绝状态机）
- 动效纪律：仅 opacity/transform；页载错峰上浮（40ms 步进）；`prefers-reduced-motion` 全禁

---

## 3. 信息架构（7 页）

```
clipsync-redesign/
├── index.html       剪贴板：时间流卡片 + 类型分段过滤 + 详情抽屉（原位 AI 操作）
├── favorites.html   收藏：合集侧栏 + 卡片网格 + 实时搜索
├── templates.html   模板：列表 + 编辑器 + {{变量}} 高亮预览 + 用量条
├── devices.html     设备：本机卡 + 对端列表 + 扫码配对 + 同步日志时间线
├── ai.html          AI 助手三栏：会话栏 / 聊天画布（流式+确认卡）/ 检查器（用量环+记忆）
├── settings.html    设置：7 分类 hash 路由 + 开关持久化 + 快捷键录制
├── quickpaste.html  快速粘贴浮窗（独立 surface，420px，全键盘操作）
├── styles.css       唯一样式真相源（tokens + shell + 全部组件类）
├── components.js    共享运行时（60 个内联 Lucide 图标/主题/toast/通知/命令面板）
├── mock.js          单一数据源（业务真实感中文 mock）
└── api.js           API 存根层（函数签名=未来真实 API 形状，含 HTTP 注释）
```

**App Shell 冻结**：标题栏（品牌印章 + 面包屑 + `Ctrl K` 命令栏 + 窗口控制）+ 224px 左侧导航（6 项 + 同步脉搏页脚），6 个 shell 页逐字一致，active 态由 `body[data-page]` 统一驱动。

---

## 4. 与工程对接的约定

- 所有数据经 `api.js` 存根（含 `delay` 模拟加载态），函数注释标明 HTTP 方法+路径，可机械替换为真实 API（如 `fetchClips → GET /api/clips`）
- SSE 协议不变：AI 页 mock 的 thinking/tool_call/confirm_tool_action 三态与后端协议字段一一对应
- 主题机制 = `html.dark/.light` 切换 CSS 变量，可直接映射到现有 7 主题基建的收敛版

## 5. 如何体验

双击打开 `clipsync-redesign/index.html`（零依赖离线可开）。推荐路径：
剪贴板 → 点任意卡片开抽屉 → `Ctrl+K` 命令面板 → AI 助手页点确认卡「批准」→ 标题栏切浅色 → 点浮窗图标看 QuickPaste。
