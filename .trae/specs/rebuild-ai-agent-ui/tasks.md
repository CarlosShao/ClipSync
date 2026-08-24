# Tasks — AI 前端全面重构（rebuild-ai-agent-ui）

> 按能力域划分工作包（UI-A ~ UI-G），与后端 `harden-ai-agent-boundaries`（Package A-H）独立并行开发；
> 前端工作包建立在后端**消息协议不变**的前提上，冲突文件分工见各包说明（重点关注 `useAiChat.ts` 与 Package F 的协同）。
> 现有前端基线：`src/desktop`（Vue3 + TS + Tailwind4 + shadcn-vue token）。

---

- [ ] Task UI-A: 设计 Token 体系与样式纪律（前端基建）
  - [ ] 1.1 修正 `globals.css`：每主题补 `--accent-rgb`（S1）；语义色换 `--success/--warning/--destructive` 补齐缺失主题（S2）；z-index 阶梯挂 token（S4）；字号阶梯 define（`--text-2xs`~`--text-base`），清半像素与 7px（S5）
  - [ ] 1.2 新增阴影 token 三档（`--shadow-sm/md/lg`）与统一 focus-visible ring（`:focus-visible`）
  - [ ] 1.3 新增全局 `@media (prefers-reduced-motion: reduce)` 兜底（覆盖全 `.ai-*` 动画）
  - [ ] 1.4 配置 stylelint（禁裸 hex、禁裸 z-index）；对照现有 `components.json` 保持不破坏
  - [ ] 1.5 各主题 `--text-tertiary` 对比度校准至 ≥4.5:1（S5 后半）
  - 涉及：`src/desktop/src/styles/globals.css`、`stylelint.config.*`（新增）、`package.json`
  - 验收：全局搜无裸 hex/z-index（除白名单）；7 主题 × 明暗 14 组合无 `--accent-rgb` 缺位；reduced-motion 生效

- [ ] Task UI-B: 三栏 Shell 重构（Nav + Canvas + Detail）
  - [ ] 2.1 `AiPanel.vue` 重构为三栏容器（去除旧右侧抽屉固定宽度模型），承载 Nav/Canvas/Inspector 三条插槽
  - [ ] 2.2 新增 `AiNavRail.vue`（会话栏位）：新建、搜索框（指令行）、会话列表、底部记忆/设置入口；支持 260px 与 48px icon-rail 两种形态
  - [ ] 2.3 新增 `AiInspector.vue`（Detail 栏）：token 用量环（迁移自 AiChatInput 圆环）、缓存命中、子代理总览、记忆速览；默认展开/收起逻辑（≥1440 展开，1100–1439 默认折叠）
  - [ ] 2.4 宽度/折叠状态持久化：复用 `useResizablePanel`，断点约束 min/max；添加容器查询断点（≥1440 / 1100–1439 / 820–1099 / <820）
  - [ ] 2.5 替换 `AISidebar.vue` 在 `App.vue` / 宿主侧的挂载方式（含 open/close 事件、open-settings 事件保留）
  - 涉及：`src/desktop/src/components/ai/AiPanel.vue`（重构）、`AiNavRail.vue`（新）、`AiInspector.vue`（新）、`AISidebar.vue`（删除或降级为薄壳转发）、`App.vue`、`composables/useResizablePanel.ts`、`useAiChatUi.ts`（新增承载布局状态）
  - 验收：三栏渲染正确；四档断点降级行为符合 spec 五章；宽度与折叠状态刷新后保持

- [ ] Task UI-C: 聊天主区重构（Composer + 消息流 + Markdown 节流）
  - [ ] 3.1 由 `AiChatInput.vue` 重构为 `AiChatComposer.vue`：保留 Enter/Shift+Enter、粘贴图片、思考强度/模式/模型 Popover、用量环（迁移至 Inspector 后 Composer 仅留触发点）；提示词优化失败/取消回滚原文；空输入不发请求；卸载 abort
  - [ ] 3.2 `AiMessageList.vue` / `AiMessage.vue` 重构：统一"过程折叠"（ThinkingCollapse → 工具时间线 → 内容），新增折叠态 chips 行（思考 Ns / 工具 N 次 / 子代理 N 个），复用 `AiProcessChips.vue`
  - [ ] 3.3 新增 `AiStreamText.vue`（Markdown 节流渲染原语）：增量累积 ≥100ms 或 ≥200 字符再 `marked.parse+sanitizeHtml` 一次；支持中断/终态刷新
  - [ ] 3.4 代码引用清理：删除 `utils/aiSystemPrompt.ts` 相关前端拼装（与 Package F 协作，避免叠加冲突）；如 `fetchContext`/`buildSystemPrompt` 调用被 Package F 处理，此处不做重复删除
  - [ ] 3.5 空态/加载态/错误态原子化：新增 `AiErrorBar.vue`、`AiDuplicateNotice.vue`（从 AISidebar 抽出）
  - 涉及：`AiChatComposer.vue`（新）、`AiMessage.vue`/`AiMessageList.vue`（重构）、`AiStreamText.vue`（新）、`AiProcessChips.vue`（新）、`AiErrorBar.vue`/`AiDuplicateNotice.vue`（新）、`AiChatInput.vue`（删除）
  - 依赖：UI-A（token 可用）
  - 验收：长回答滚动流畅（无逐 token 卡顿）；思考/工具/内容三段折叠正确；切换历史对话不回滚输入

- [ ] Task UI-D: Agent 过程可视化（ThinkingCollapse + ToolTimeline + AgentCards + Drawer）
  - [ ] 4.1 新增 `AiThinkingCollapse.vue`（合并 AiThinking+AiWaiting）：loading 扫光、计时、完成折叠（"深度思考 Ns"）；删除 AiWaiting.vue
  - [ ] 4.2 删除 `AiThinkingOrb.vue` + `orbs-js/` 目录；如 `.gitignore`/引用存在一并清理
  - [ ] 4.3 `AiToolTimeline.vue` 重构：写操作标注（来自 B 包 tool_result，走 i18n key + 兜底人性化）、破坏性动作红色标签、等待确认状态
  - [ ] 4.4 新增 `AiAgentCards.vue`（合并 AiAgentSummary）：紧凑网格 + 状态图标 + 计时；点击进 `AiAgentDrawer`（重构，简化内部、统一 token）
  - [ ] 4.5 `AiCompressProgress.vue` 并入进度条原语（AiUsageMeter 或新组件），删除原文件
  - 涉及：`AiThinkingCollapse.vue`（新）、`AiToolTimeline.vue`（重构）、`AiAgentCards.vue`（新）、`AiAgentDrawer.vue`（重构）、`AiAgentSummary.vue`/`AiAgentRun.vue`/`AiThinking.vue`/`AiWaiting.vue`/`AiThinkingOrb.vue`/`orbs-js/`/`AiCompressProgress.vue`（删除）
  - 依赖：UI-A、UI-C（组件挂载点）
  - 验收：思考/工具/子代理三条可视化路径在新 Shell 内正确工作；orbs-js 无残留；子代理详情抽屉可开合

- [ ] Task UI-E: 确认门控卡片 + Inspector 详情（对接后端 Package C）
  - [ ] 5.1 新增 `AiConfirmCard.vue`：监听 `meta.type==='confirm_tool_action'`，展示工具名/argsSummary/impact；允许/拒绝 → `POST /api/ai/chat/approve{requestId, allow}`（路径以契约表为准）；"等待确认"状态机（进行中/已批准/已拒绝/超时）
  - [ ] 5.2 新增 `AiUsageMeter.vue`：token 用量环（迁移）、缓存命中率、费用估算、上下文压缩进度——供 Inspector 与 Composer 触发点共用
  - [ ] 5.3 `AiMemoryPanel.vue` 重构：纳入 Inspector（速览）与独立弹层（管理）两态共用同一组件
  - 涉及：`AiConfirmCard.vue`（新）、`AiUsageMeter.vue`（新）、`AiMemoryPanel.vue`（重构）、`AiInspector.vue`（补充内容）、`useAiChatUi.ts`（确认卡状态）
  - 依赖：UI-C；后端契约以 `harden-ai-agent-boundaries` 契约表字段为准（该包未就绪时先以 mock 事件自测）
  - 验收：模拟 SSE `confirm_tool_action` 能渲染确认卡片并完成 allow/deny 回调；Inspector 用量展示正确

- [ ] Task UI-F: Shell 与主区整合、i18n 补齐、组件清理（收尾）
  - [ ] 6.1 移除 `AiSuggestPopup.vue`（确认无调用方）；`AISidebar.vue` 删除；替换 `HomeView.vue` / 相关宿主引用
  - [ ] 6.2 补齐 i18n（zh/en）：新组件文案、`t('x')||fallback` 模式修正（缺失 key 不兜底问题）与新增 key
  - [ ] 6.3 键盘可达性：自绘按钮 focus-visible、可交互元素 tabindex 审计（对齐 S9 修复）
  - [ ] 6.4 全量 lint（npm run lint）与 TS 类型检查（vue-tsc）通过；删无引用文件清单核对
  - 涉及：`AISidebar.vue`/`AiSuggestPopup.vue`（删除）、`locales/zh.json`/`en.json`、全局 lint 配置
  - 依赖：UI-A~E
  - 验收：`npm run lint` `vue-tsc --noEmit` 零错误；无死文件引用；键盘可操作所有交互元素

- [ ] Task UI-G: 前端回归与视觉验收
  - [ ] 7.1 本地启动 server + desktop dev，跑通：问答流式、思考折叠、工具时间线、子代理网格/抽屉、记忆面板、会话 CRUD、粘贴图片、Inspector、确认卡（mock）
  - [ ] 7.2 明/暗 × 至少 3 套主题（选 vercel/clipsync/linear 或当前默认主题）截图对比：无 token 断链、无硬编码色漂移、对比度达标
  - [ ] 7.3 窄窗（<820px）与 1100–1440 区间断点行为截图核对
  - [ ] 7.4 回归：既有的 AiSummaryFloat.vue / QuickPastePanel 等引用 AI 能力的宿主组件不回归
  - 涉及：手动 QA + 截图留存（`docs/` 或对话内确认，不新增文档除非用户要求）
  - 依赖：UI-A~F
  - 验收：spec 六章所有场景手测通过；主题/断点无样式回归

---

# Task Dependencies

- UI-B → depends on UI-A（token 基建）
- UI-C → depends on UI-A（token）
- UI-D → depends on UI-A、UI-C（挂载点）
- UI-E → depends on UI-C；**协议字段以 `harden-ai-agent-boundaries` 契约表为准（可 mock 自测，不阻塞）**
- UI-F → depends on UI-A~E
- UI-G → depends on UI-A~F

批次建议：
- 批 1（并行）：UI-A
- 批 2（并行）：UI-B、UI-C（依赖 A 交付即可并行）
- 批 3（并行）：UI-D、UI-E（依赖 B/C 结构稳）
- 批 4：UI-F、UI-G

协同注意：`useAiChat.ts` 同时被 Package F（后端上下文组装）与 UI-C 引用 —— 建议**由 Package F 负责该文件的协议层改造，UI-C 只做挂载与 UI 消费**，两包合入前由统筹人做一次冲突合并排期。