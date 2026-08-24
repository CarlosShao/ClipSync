# AI 前端全面重构 Spec（rebuild-ai-agent-ui）

## Why

当前 AI 前端（右侧浮动抽屉 + 15 个碎片化组件）与市面主流 agent 产品（Cursor / Claude / Raycast / Linear）的观感差距大：无导航层级、组件职责重叠（AiThinking / AiWaiting / AiThinkingOrb / AiCompressProgress 均为"状态展示"）、约 1/3 颜色/字号/z-index 硬编码绕过设计 token（S1-S12 已核验）、无统一 focus/reduced-motion 兜底、键盘可达性弱。

目标：按主流 agent 产品的设计标准，全面推翻重构 AI 前端 —— 现代、简洁、易用，且以前端为纯渲染层，与后端 Agent 逻辑文档（`docs/plans/ai-agent-boundary-task-assignment.md`，Package A-H）的**消息协议保持硬契约不变**。

## What Changes

- **BREAKING** AI 面板由"右侧浮动抽屉"重构为「会话栏 + 聊天主区 + 上下文 Inspector」三栏 Shell（可折叠、宽度持久化）。
- **BREAKING** 15 个 AI 组件重组为 6 大组件族（Shell / Conversation / Agent / State / Side / Shared），删除 orbs-js 第三方副本与职责重叠组件。
- 设计 token 先行：统一字号阶梯、圆角四档、阴影三档、z-index 阶梯、focus-visible 环形、`prefers-reduced-motion` 全局兜底；修复 S1(`--accent-rgb`) / S2(语义色硬编码) / S4(z-index) / S5(字号/对比度)。
- 交互升级：确认门控卡片（对接后端 `confirm_tool_action`）、流式 markdown 渲染节流、Composer 提示词优化错误回滚、思考/工具/子代理过程统一折叠态。
- 三栏布局窄宽自适应降级：桌面三栏 → 两栏 → 抽屉（移动端/窄窗）。

## Impact

- Affected specs：AI 模块前端全部（无后端协议变更）
- Affected code：
  - `src/desktop/src/components/ai/*`（删除/重命名/新增）
  - `src/desktop/src/composables/useAiChat.ts` / 新增 `useAiChatUi.ts`（渲染状态与协议层分离）
  - `src/desktop/src/styles/globals.css`（token 补齐与修正）
  - `src/desktop/src/stores/configStore.ts`（UI 布局偏好持久化，若与现有互斥键冲突则新增）
  - `src/desktop/src/locales/zh.json` / `en.json`（新 UI 文案）
  - `src/desktop/src/main.ts` / `App.vue`（Shell 挂载）

---

## 一、整体设计理念与视觉风格定位

### 1.1 设计语言：三层信息密度（Nav / Canvas / Detail）

仿 Cursor 与 Claude 的分层思路，把界面按"信息密度"拆为三层，各层视觉权重递减：

| 层 | 含义 | 视觉特征 |
|---|---|---|
| **Nav（会话栈）** | 会话列表、新建、搜索、记忆/设置入口 | 最轻：icon 为主、次级文字、hover 露操作 |
| **Canvas（对话主区）** | 消息流、Composer | 最高权重：留白、主字重、markdown 排版是核心 |
| **Detail（Inspector）** | token 用量、上下文、子代理状态、确认卡片 | 次级：紧凑 meta 文字、进度条、可折叠 |

### 1.2 视觉风格定位

- **基调**：极简（minimal）优先于装饰；一切元素为"读取与连续输入"服务。
- **参考锚点**：布局参考 Cursor/Claude 三栏；排版留白参考 Claude；命令感微交互参考 Raycast；信息密度参考 Linear/Vercel。
- **暗色优先**：dark-first 渲染（受现有 `theme-*` `.dark/.light` 驱动，不新增主题机制）。
- **动效纪律**：时长 150–250ms；只用 `opacity/transform` 合成器属性；`prefers-reduced-motion` 全局兜底（globals.css 一条规则覆盖全模块）。
- **克制层次**：无大阴影、无玻璃拟态滥用；阴影仅 3 档 token（`--shadow-sm/md/lg`）；圆角收敛 4 档（6 控件 / 8 卡片 / 999 胶囊 / 50% 圆）。

### 1.3 Token 体系建设（修复既有断链）

- 字号阶梯：`--text-2xs:10px` / `--text-xs:11px` / `--text-sm:12px` / `--text-base:13px`，禁半像素字号，7px 圆环数字改用 ≥10px 或移除。
- 修复 `--accent-rgb` 全主题缺定义（S1）：每主题补 `--accent-rgb: R G B;` 或统一改 `color-mix`。
- 语义色走 token：`--success/--warning/--destructive`（S2），补齐缺失主题的 `--destructive`。
- z-index 阶梯统一挂 token：弹层 999 / 抽屉 1000 / 确认卡 60（S4）。
- 各主题 `--text-tertiary` 对比度提至 ≥4.5:1（S5）。
- 启用 stylelint 禁裸 hex 与裸 z-index（防止样式债复发）。

---

## 二、页面布局与信息架构

### 2.1 三栏 Shell（AiPanel 重构）

```
┌─────────┬──────────────────────────────┬──────────────┐
│ Nav     │ Canvas                       │ Detail        │
│ 会话栏   │ 消息流 + Composer            │ Inspector     │
│ 260px   │ 自适应 flex:1                │ 300px (可折叠)│
└─────────┴──────────────────────────────┴──────────────┘
```

- **Nav 会话栏**（可收起成 48px icon rail）：新建对话、搜索框（指令行风格）、会话列表（标题/时间/消息数/模式徽章）、底部记忆与设置入口。
- **Canvas 聊天主区**：`AiMessageFlow`（消息流）+ 底部 `AiChatComposer`；顶部细条 = 当前对话标题 + Inspector 开关。
- **Detail Inspector**（默认展开于 1440px+，1100–1440 默认折叠）：token 用量环（沿用圆环，缩放适配新 token）、上下文缓存命中、子代理总览、记忆速览。
- 宽度：Nav 260px、Inspector 300px，均拖拽可调 + localStorage 持久化（复用 `useResizablePanel`）。

### 2.2 信息架构（层级 3 层，操作 3 级）

- 层级：会话（Conversation）→ 消息（Message）→ 过程（Thinking/Tools/Agents）。
- 操作级：内容区常驻（主操作）/ hover 显露（次级）/ 折叠态摘要（低频）。

---

## 三、核心交互流程

### 3.1 发送 → 生成（统一"过程折叠"）

1. Composer 输入 → Enter 发送（Shift+Enter 换行）；粘贴图片预览不变。
2. 生成中：`AiThinkingCollapse`（统一折叠条，含 loading 扫光 + 计时）→ 思考结束自动折叠为"深度思考 Ns"。
3. 工具调用出现 → 工具时间线内嵌至消息条；工具开始即收束 thinking。
4. 答案流式输出 → markdown 渲染**节流 ~100ms 合并**（消除逐 token 全量重渲染）。
5. 流结束（或中途切换会话）→ 整条过程折叠为一行摘要条（含 chips：思考 Ns / 工具 N 次 / 子代理 N 个）。

### 3.2 确认门控卡片（对接后端 Package C）

- 收到 SSE `meta.type==='confirm_tool_action'`（含 requestId/tool/argsSummary/impact）→ Canvas 顶部或消息内渲染 `AiConfirmCard`：「AI 想执行 [动作]（影响 N 条）—— 允许 / 拒绝」。
- 允许：`POST /api/ai/chat/approve{requestId, allow:true}`；拒绝同 false。等待期显示"等待确认"状态机；拒绝后时间线标注 REJECTED。
- 契约字段以 `docs/plans/ai-agent-boundary-task-assignment.md` 契约表为准（前端只消费字段，不定义协议）。

### 3.3 子代理可视化（合并 AiAgentSummary/Run/Drawer）

- 主区：`AiAgentCards` 紧凑网格（状态图标 + 名称 + 状态文字 + 计时）；点击任意卡展开 `AiAgentDrawer`（详情：thinking / 工具时间线 / 结论）。
- 折叠态：折叠头 chips 展示 `N 个子代理 · 完成 M`。

### 3.4 其它

- 会话切换/新对话/重命名/删除：沿用现有交互，适配新 Nav 栏样式与 i18n 兜底文案修正。
- Inspector 打开/关闭：Canvas 顶部按钮（布局类开关，不入 DB，仅 localStorage）。
- 提示词优化（Sparkles）：流式覆盖 Composer 前先备份原文，失败或取消回滚；空输入不发请求；卸载 abort。

---

## 四、组件划分（6 大组件族）

| 组件族 | 职责 | 组成（目标） |
|---|---|---|
| **Shell** | 三栏框架与布局状态 | `AiPanel.vue`（重构，含拖拽/折叠）、`AiNavRail.vue`（会话栏，新）、`AiInspector.vue`（新） |
| **Conversation** | 会话与消息流 | `AiConversationList.vue`（重构）、`AiMessageList.vue`（重构）、`AiMessage.vue`（重构：Markdown 节流渲染）、`AiChatComposer.vue`（由 AiChatInput 重构：含 Popover 弹出、用量环、图片预览） |
| **Agent** | 过程与子代理可视化 | `AiThinkingCollapse.vue`（合并 AiThinking+AiWaiting，新）、`AiToolTimeline.vue`（重构）、`AiAgentCards.vue`（合并 AiAgentSummary，新）、`AiAgentDrawer.vue`（重构，内部渲染简化） |
| **State** | 状态与确认 | `AiConfirmCard.vue`（新，确认门控）、`AiErrorBar.vue`（原子化）、`AiDuplicateNotice.vue`（抽出图片重复条） |
| **Side** | 详情面板内容 | `AiMemoryPanel.vue`（重构，纳入 Inspector 或独立弹层）、`AiUsageMeter.vue`（token/缓存/费用，新） |
| **Shared** | 跨族公共 | `AiProcessChips.vue`（折叠态 chips，新）、`AiStreamText.vue`（节流渲染原语，新）、icon/typo 语义层 |

**删除**：`AiThinkingOrb.vue` + `orbs-js/`（第三方算法副本，无 LICENSE —— 合规风险）、`AiCompressProgress.vue`（并入 AiUsageMeter/进度条）、`AiWaiting.vue`（并入 AiThinkingCollapse）、`AiSuggestPopup.vue`（如无调用方则随 G 包确认后移除）。

---

## 五、响应式适配策略

| 视口宽度 | 布局 | 行为 |
|---|---|---|
| ≥1440px | 三栏全开 | Nav 260 + Canvas + Inspector 300 |
| 1100–1439px | Inspector 默认折叠 | Canvas 顶栏按钮可随时呼出 Inspector（浮层） |
| 820–1099px | 两栏 | Nav 收成 48px icon rail（hover 展开浮层），仅 Canvas + Inspector |
| <820px | 单栏 | AI 为整页聊天：Nav 恢复抽屉式（汉堡呼出）、Inspector 隐藏、Composer 固定底部、输入区键盘弹出滚动保护 |

- 断点用 CSS 容器查询 + 少量媒体查询（Container Queries 优于媒体查询，避免依赖固定窗口宽度）。
- 拖拽宽度持久化受断点约束（min/max clamp 防布局溢出）。

---

## 六、与现有 Agent 逻辑文档的衔接

| 衔接项 | 约定 |
|---|---|
| **消息协议** | 前端**只改渲染不改协议**：SSE delta（thinking/content/tool_call/tool_result/agent/agent_id/meta usage/confirm_tool_action）结构以 `docs/plans/ai-agent-boundary-task-assignment.md` 契约为准；后端 Package A-H 不受影响 |
| **confirm_tool_action** | 消费 Package C 冻结的字段；approve 接口路径、requestId 生成由后端定，前端仅调用 |
| **写工具展示** | Package B 新增写工具的 `tool_result` 由 `AiToolTimeline` 承接展示（"已写入剪贴板"等），不硬编码工具名（走 i18n key + 兜底人性化） |
| **ephemeral 消息** | Package D 的 ephemeral 标记由 Composer 透传（截图/一次性明文），不在消息流持久化展示 |
| **上下文组装** | Package F 后前端不再自建 system prompt 拼装 —— 本重构同步移除 `useAiChat.ts` 中已失效的 `fetchContext/buildSystemPrompt(ctxData)` 调用与 `utils/aiSystemPrompt.ts`（与 Package F 协作完成，避免重复改动同一文件冲突） |
| **composable 分层** | `useAiChat.ts` 收敛为纯协议适配层；新增 `useAiChatUi.ts` 承载布局/折叠/确认卡等渲染状态 —— 后端不可知的 UI 状态能力独立演化 |

---

## ADDED Requirements

### Requirement: 三栏 Shell 与自适应降级

系统 SHALL 提供 Nav/Canvas/Detail 三栏布局，支持 Nav 折叠为 icon rail、Inspector 可折叠，且任一宽度下消息流保持可读。

#### Scenario: 窄窗聊天
- **WHEN** 窗口宽度 <820px
- **THEN** AI 呈现为整页单栏，Nav 以汉堡抽屉出现，Composer 固定底部，无横向溢出

### Requirement: 确认门控卡片

系统 SHALL 在收到 SSE `media.type==='confirm_tool_action'` 时渲染 `AiConfirmCard`（显示工具/args 摘要/impact），用户允许或拒绝后回调后端，等待态有明确状态机。

#### Scenario: 用户拒绝销毁请求
- **WHEN** 用户在确认卡片点"拒绝"
- **THEN** 卡片关闭，时间线标注拒绝，聊天继续并可展示后端返回的替代方案

### Requirement: 流式 Markdown 节流渲染

系统 SHALL 将流式增量合并（≥100ms 或 ≥N 字符）后一次性渲染，避免长回复逐 token 全量重排；渲染在 Web Worker 或空闲回调中执行（可选），主线程不可阻塞。

### Requirement: Token 体系与样式纪律

系统 SHALL 以 token 阶梯（字号/圆角/阴影/z-index/语义色）为唯一样式来源；stylelint 禁止裸 hex 与裸 z-index；`prefers-reduced-motion` 全局兜底。

### Requirement: composable 双层结构

系统 SHALL 将 `useAiChat` 与 `useAiChatUi` 分离：前者只负责协议收发与业务状态（供后端工作包契约稳定），后者承担全部 UI 渲染状态（折叠/确认卡/布局）。

## MODIFIED Requirements

### Requirement: 状态展示组件收敛
原 AiThinking / AiWaiting / AiThinkingOrb / AiCompressProgress 多组件并存 → 统一为 `AiThinkingCollapse` + 进度条原语；删除 orbs 副本。

### Requirement: Composer 提示词优化安全
原 AiChatInput「提示词优化流式覆盖 text.value」在失败/取消时回滚到优化前文本；空输入不请求；卸载时 abort。

## REMOVED Requirements

### Requirement: orbs-js 第三方思考球算法
**Reason**: 第三方算法级副本，无版本号与 LICENSE，合规风险且与极简风格不符。
**Migration**: 由 `AiThinkingCollapse` 的轻量扫光/脉冲动画替代。

### Requirement: 前端自建 AI system prompt 拼装（`aiSystemPrompt.ts`）
**Reason**: 后端统一上下文组装（Package F）已接管；前端拼装已失效且不应包含 DB schema。
**Migration**: 随 Package F 协作移除；本 spec 不再复用该文件。