# AI 前端全面重构 — 分派工作单（rebuild-ai-agent-ui）

> 本单按**能力域**将前端重构划分为 7 个独立工作包（UI-A ~ UI-G），每个工作包可交给一个独立 Agent 在各自新建分支完成。
> 与后端 agent 逻辑分单（`docs/plans/ai-agent-boundary-task-assignment.md`，Package A-H）**独立并行**，前端工作建立在「后端消息协议不变」的硬契约之上（协议字段以 agent 分单「契约表」为准，前端只消费不定义）。
> 当前基线分支：`dev/cnb`。**本单只负责分工，实现由各工作包 Agent 完成。**

---

## 统筹信息（所有 Agent 必读）

- 技术栈：`src/desktop`（Vue3 + TS + Vite + Tailwind4 + shadcn-vue 原语 + 7 套主题 token）。
- 样式纪律：全部使用 CSS 变量 token（`--bg-*`/`--text-*`/`--border-*`/`--accent-*`/`--success`/`--warning`/`--danger`/`--radius-*`/`--shadow-*`/`--z-*`）；禁止裸 hex / 裸 z-index；动画只用 `opacity/transform`。
- 既有现状（必须先读完再动手）：
  - 现 AI 面板为右侧浮动抽屉：`components/ai/AISidebar.vue`（含宽度拖拽 320–760px、历史 Popover、图片重复横幅、错误条、角色徽章）；
  - 消息渲染：`AiMessageList.vue` → `AiMessage.vue`（marked+DOMPurify，流式全量重渲）、`AiThinking.vue`、`AiToolTimeline.vue`、`AiAgentSummary.vue`/`AiAgentRun.vue`/`AiAgentDrawer.vue`；
  - 输入区：`AiChatInput.vue`（粘贴图片、Popover、用量圆环、提示词优化流式覆盖）；
  - 会话/记忆：`AiConversationList.vue`、`AiMemoryPanel.vue`；附加：`AiThinkingOrb.vue` + `orbs-js/`、`AiWaiting.vue`、`AiCompressProgress.vue`、`AiSuggestPopup.vue`。
- 红线：**不改变任何 SSE 消息协议字段名**（thinking/content/tool_call/tool_result/agent/agent_id/meta usage/confirm_tool_action）；不直 push master。
- 每次交付后跑 `npm run lint` + `vue-tsc --noEmit`；按包验收清单自测。

---

## 批 1（全并行 — 无前置依赖）

### UI-A：设计 Token 体系与样式纪律（前端基建）

- **建议分支**：`feat/ai-ui-tokens`
- **任务边界**：
  1. `src/desktop/src/styles/globals.css`：
     - 每主题（vercel/clipsync/notion/linear/apple/raycast/arc × 明暗）补 `--accent-rgb: R G B;`（S1 断链修复）；
     - 语义色改走 token：确认 `--success/--warning/--danger` 全部主题已定义，组件内裸 hex 交 UI-C/D 清理，本包只在 globals 层补齐缺失 `--destructive` 别名；
     - 定义字号阶梯 `--text-2xs:10px / --text-xs:11px / --text-sm:12px / --text-base:13px`（S5）；
     - 新增阴影三档 `--shadow-sm/md/lg`（保留 `--shadow-dropdown` 兼容别名）；
     - z-index 阶梯统一挂 token（复用在 `@theme inline` 已定义的 `--z-index-*`，补 `--z-confirm` 60 / `--z-rail` 档位）。
  2. 新增全局 `@media (prefers-reduced-motion: reduce)` 兜底（覆盖 `.ai-*` 全部动画类）。
  3. 新增 `stylelint.config.*`：禁裸 hex、禁裸 z-index（规则可先落在 AI 组件目录，避免一次性全量爆红）；接入 `package.json` scripts（`lint:style`），保证 `components.json` 不受破坏。
  4. 各主题 `--text-tertiary` 对比度校准至 ≥4.5:1（notion/linear 等暗色弱对比主题重点）。
- **验收**：14 组合主题无 `--accent-rgb` 缺位；字号阶梯生效且无 7px/半像素残留（样式层定义，组件清理在 C/D）；stylelint 能扫描 AI 目录并拦住裸 hex/z-index；reduced-motion 生效。
- **交接点**：向 UI-B/C/D 交付可用 token 清单（圆角/阴影/字号/z-index 阶梯表）。

---

## 批 2（依赖 UI-A — 可并行）

### UI-B：三栏 Shell 重构（Nav + Canvas + Detail）

- **建议分支**：`feat/ai-three-pane-shell`
- **前置**：UI-A（token 可用）。
- **任务边界**：
  1. 新增 `composables/useAiChatUi.ts`：承载布局/折叠/确认卡 UI 状态（与 `useAiChat.ts` 协议层分离，不碰协议字段）。
  2. `AiPanel.vue` 重构为三栏容器（Nav 会话栏 + Canvas 聊天主区 + Detail Inspector）：使用插槽组织；改造 `AISidebar.vue` 为薄壳（保留 open/close、open-settings 事件签名，透传给 App.vue 宿主）。
  3. 新增 `AiNavRail.vue`：新建对话、搜索框（指令行风格）、会话列表（标题/时间/消息数/模式徽章）、底部记忆与设置入口；支持 260px 与 48px icon-rail 双形态，宽度/折叠持久化（复用 `useResizablePanel`，localStorage key 与旧 `ai-sidebar-width` 区分）。
  4. 新增 `AiInspector.vue`：token 用量环（迁移自 AiChatInput，数据仍由 `contextUsage` 驱动）、缓存命中、子代理总览、记忆速览；默认 ≥1440px 展开、1100–1439px 折叠（浮层可呼出）。
  5. 断点：CSS 容器查询 + 少量媒体查询实现 ≥1440 / 1100–1439 / 820–1099 / <820 四档降级。
- **验收**：三栏渲染正确；四档断点无横向溢出；宽度与折叠状态刷新后保持；open/close/open-settings 在宿主侧仍工作；`useAiChat` 协议层零改动。
- **交接点**：向 UI-C 交付 Canvas 挂载槽位与 Inspector 触发点；向 UI-E 交付 Inspector 内容槽位。

### UI-C：聊天主区重构（Composer + 消息流 + Markdown 节流）

- **建议分支**：`feat/ai-chat-main`
- **前置**：UI-A。
- **任务边界**：
  1. 由 `AiChatInput.vue` 重构为 `AiChatComposer.vue`：保留 Enter/Shift+Enter、粘贴图片预览、思考强度/模式/模型 Popover、用量环（触发点保留，面板迁至 Inspector）；**提示词优化**：流式覆盖前备份原文，失败/取消回滚，空输入不发请求，卸载 abort。
  2. 新增 `AiStreamText.vue`（Markdown 节流渲染原语）：增量累积 ≥100ms 或 ≥200 字符后一次 `marked.parse + sanitizeHtml`；支持终态刷新；不阻塞主线程。
  3. 重构 `AiMessageList.vue` / `AiMessage.vue`：统一「过程折叠」（ThinkingCollapse → 工具时间线 → 内容）；新增折叠态 chips 行（思考 Ns / 工具 N 次 / 子代理 N 个）——新增 `AiProcessChips.vue`。
  4. 新增原子状态组件：`AiErrorBar.vue`（错误条）、`AiDuplicateNotice.vue`（图片重复横幅，自 AISidebar 抽出）。
  5. 协作注意：`useAiChat.ts` 的协议层改造归后端 Package F；本包只做挂载与 UI 消费。`utils/aiSystemPrompt.ts` 删除需与 Package F 对齐时间，本包不重复删除（如 F 未动，此包跳过该文件）。
- **验收**：长回答滚动流畅（无逐 token 卡顿）；思考/工具/内容三段折叠正确；切换历史对话不回滚输入；空态/加载态/错误态原子组件生效。
- **交接点**：向 UI-D 交付消息条内部挂载点（ThinkingCollapse/ToolTimeline/AgentCards 插入位）。

---

## 批 3（依赖 UI-B/C — 可并行）

### UI-D：Agent 过程可视化（ThinkingCollapse + ToolTimeline + AgentCards + Drawer）

- **建议分支**：`feat/ai-agent-visuals`
- **前置**：UI-A、UI-C。
- **任务边界**：
  1. 新增 `AiThinkingCollapse.vue`（合并 `AiThinking`+`AiWaiting`）：loading 扫光、计时、完成折叠“深度思考 Ns”；删除 `AiWaiting.vue`。
  2. 删除 `AiThinkingOrb.vue` + `orbs-js/` 目录（第三方副本、无 LICENSE）；`.gitignore`/引用一并清理。
  3. 重构 `AiToolTimeline.vue`：写操作标注（工具名走 i18n key `ai_tool_<name>` + 人性化兜底）、破坏性动作红色标签、等待确认状态（消费后端 confirm 事件）。
  4. 新增 `AiAgentCards.vue`（合并 `AiAgentSummary`）：紧凑网格 + 状态图标 + 计时；点击进 `AiAgentDrawer`（重构，简化内部、统一 token）。
  5. `AiCompressProgress.vue` 并入 `AiUsageMeter`（进度条原语），删除原文件。
- **验收**：思考/工具/子代理三条可视化路径在新 Shell 内正确工作；无 orbs-js 残留引用；子代理详情抽屉可开合；写操作/破坏性动作标签区分正确。
- **交接点**：向 UI-E 确认 AiUsageMeter 的数据契约（derive 自 `contextUsage`）。

### UI-E：确认门控卡片 + Inspector 详情（对接后端 Package C）

- **建议分支**：`feat/ai-confirm-card`
- **前置**：UI-B（Inspector 槽位）、UI-C（消息流挂载）。
- **任务边界**：
  1. 新增 `AiConfirmCard.vue`：监听 SSE `meta.type==='confirm_tool_action'`（字段 `requestId/tool/argsSummary/impact`），渲染卡片并回调 `POST /api/ai/chat/approve { requestId, allow }`（路径以后端契约为准，该接口未就绪时先 mock 事件自测）；状态机：进行中/已批准/已拒绝/超时（120s）。
  2. 新增 `AiUsageMeter.vue`：token 用量环（迁移）、缓存命中率、费用估算、上下文压缩进度——供 Inspector 与 Composer 触发点共用。
  3. 重构 `AiMemoryPanel.vue`：Inspector 速览态与独立管理弹层两态共用组件。
- **验收**：mock `confirm_tool_action` 能渲染确认卡片并完成 allow/deny 回调；Inspector 用量展示正确；AiMemoryPanel 两态可用。
- **交接点**：确认卡片状态机接入 `useAiChatUi`（供 UI-F 整合）。

---

## 批 4（依赖 UI-A~E）

### UI-F：Shell 整合、i18n 补齐、组件清理、静态检查（收尾）

- **建议分支**：`chore/ai-ui-finish`
- **前置**：UI-A~E。
- **任务边界**：
  1. 移除 `AiSuggestPopup.vue`（先确认无调用方）；删除 `AISidebar.vue`（薄壳使命完成）；替换 `HomeView.vue` / 宿主引用。
  2. 补齐 i18n（`locales/zh.json`/`en.json`）：新组件文案；修正 `t('x') || fallback` 模式（缺失 key 不兜底问题）与新增 key。
  3. 键盘可达性：自绘按钮 focus-visible、tabindex 审计（对齐 S9）。
  4. 全量 `npm run lint` + `vue-tsc --noEmit` 通过；导出删除文件清单核对无残留引用。
- **验收**：lint/tsc 零错误；无死文件引用；键盘可操作全部交互元素。

### UI-G：前端回归与视觉验收

- **建议分支**：`qa/ai-ui-regression`
- **前置**：UI-A~F。
- **任务边界**：
  1. 本地启动 server + desktop dev 全流程手测：问答流式、思考折叠、工具时间线、子代理/抽屉、记忆面板、会话 CRUD、粘贴图片、Inspector、确认卡（mock）。
  2. 明/暗 × ≥3 套主题截图对比（vercel / clipsync / linear）：无 token 断链、无硬编码色漂移、对比度达标。
  3. 窄窗 <820px 与 1100–1439 断点截图核对。
  4. 回归：`AiSummaryFloat.vue` / `QuickPastePanel` 等引用 AI 能力的宿主组件不回归。
- **验收**：spec 六章场景手测通过；主题与断点无样式回归。

---

## 契约表（跨 Agent 接口 / 与后端分单对齐）

| 契约 | 提供方 | 消费方 | 内容 |
|---|---|---|---|
| SSE 消息协议字段（thinking/content/tool_call/tool_result/agent/agent_id/meta usage） | 后端（不变） | UI-C/D/E | 结构以 agent 分单契约表为准，前端只消费 |
| confirm_tool_action 事件 + `POST /api/ai/chat/approve` | 后端 Package C | UI-E | `{ requestId, tool, argsSummary, impact }`；未就绪时 mock |
| token 阶梯表（字号/圆角/阴影/z-index/语义色） | UI-A | UI-B/C/D/E | 组件样式唯一来源 |
| useAiChat.ts 协议层归属 | 后端 Package F | UI-C | 协议层改造归 F，UI 包只挂载消费，避免文件冲突 |
| 写工具 tool_result 标注 | 后端 Package B | UI-D | 走 i18n key + 人性化兜底，不硬编码工具名 |
| ephemeral 消息标记 | 后端 Package D | UI-C | Composer 透传，不在消息流持久化展示 |
| useAiChatUi 布局/折叠/确认卡状态 | UI-B/E | UI-F | 收尾整合统一出口 |

## 批次与并行建议

1. **批 1（并行）**：UI-A 独立开工。
2. **批 2（并行）**：UI-A 交付后 → UI-B、UI-C 同时开工。
3. **批 3（并行）**：UI-B/C 结构稳定后 → UI-D、UI-E 同时开工。
4. **批 4**：UI-F（整合）→ UI-G（回归），可重叠收尾。

## 合入策略

- 每个工作包在各自分支自测通过后提 MR/PR 到 `dev/cnb`，由统筹角色（本会话）整合与回归；不允许任何 Agent 直 push master。
- 合入顺序：UI-A → UI-B → UI-C → UI-D → UI-E → UI-F → UI-G（串行合入便于定位回归，即便开发并行）。
- **与后端分单冲突治理**：`useAiChat.ts`、`utils/aiSystemPrompt.ts` 两文件同时被前端 UI-C/UI-F 与后端 Package F/D 引用——由统筹角色排期一次冲突合并（优先后端 Package F 先合，前端对应清理随后合，或反向，需在合入前统一）。