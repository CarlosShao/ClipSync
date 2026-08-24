# Checklist — AI 前端全面重构（rebuild-ai-agent-ui）

> 验收清单。每个 checkpoint 由对应工作包实现后核对；未通过 → 回补 tasks.md 新任务修复后复查。

## Task UI-A: 设计 Token 体系
- [ ] 每主题已补 `--accent-rgb`（无缺位）；语义色仅用 `--success/--warning/--destructive` 且所有主题补齐定义
- [ ] 字号阶梯确定且无半像素/7px 残留
- [ ] 阴影 3 档 token 存在；`--shadow-dropdown` 兼容保留或迁移
- [ ] z-index 阶梯挂 token；focus-visible ring 覆盖全部自绘按钮/可交互元素
- [ ] `prefers-reduced-motion` 全局兜底规则存在
- [ ] stylelint 已接入且禁裸 hex/z-index；`npm run lint` 通过

## Task UI-B: 三栏 Shell
- [ ] AiPanel 三栏（Nav/Canvas/Detail）渲染正确、互不遮挡
- [ ] Nav 260px ↔ 48px icon-rail 切换可用并持久化
- [ ] Inspector 默认展开/折叠符合断点（≥1440 展开，1100–1439 折叠）
- [ ] 四档断点（≥1440 / 1100-1439 / 820-1099 / <820）布局降级无横向溢出
- [ ] open/close、open-settings 事件在宿主侧仍可用；`useAiChatUi` 承载布局状态

## Task UI-C: 聊天主区
- [ ] Composer：Enter/Shift+Enter、粘贴图片、多 Popover、用量环触发点均可用
- [ ] Composer 提示词优化失败/取消回滚；空输入不发请求；卸载 abort
- [ ] 消息流"过程折叠"正确（思考→工具→内容）；折叠态 chips 行正确
- [ ] `AiStreamText` 节流渲染生效（长回答无逐 token 重渲染卡顿）
- [ ] 空态/加载/错误态原子组件生效；历史会话切换不回滚输入
- [ ] 与 Package F 的 `useAiChat.ts` 改动无冲突（协议层归 F，UI 层归本包）

## Task UI-D: Agent 过程可视化
- [ ] AiThinkingCollapse 替代 AiThinking/AiWaiting 且无残留引用
- [ ] orbs-js 目录与 AiThinkingOrb 已删除、无引用、无合规残留
- [ ] AiToolTimeline 支持写操作标注（i18n key 兜底）与破坏性标签
- [ ] AiAgentCards + AiAgentDrawer 工作正常；旧 AiAgentSummary/AiAgentRun 已删除
- [ ] AiCompressProgress 已并入进度条原语并删除原文件

## Task UI-E: 确认卡 + Inspector
- [ ] AiConfirmCard 渲染字段（tool/argsSummary/impact）正确；allow/deny 回调后端
- [ ] "等待确认" 状态机四态（进行中/已批准/已拒绝/超时）可自测（mock 事件）
- [ ] AiUsageMeter 在 Inspector 与 Composer 触发点均可用；缓存命中/费用/压缩进度正确
- [ ] AiMemoryPanel 两态（Inspector 速览 + 独立管理）共用组件可用

## Task UI-F: 整合与清理
- [ ] AiSuggestPopup / AISidebar 已删除且宿主引用替换完毕
- [ ] i18n zh/en 新文案补齐；`t('x')||fallback` 兜底模式修正（缺失 key 不再静默返回 key）
- [ ] 键盘可达性：全部自绘按钮有 focus-visible；tabindex 审计通过
- [ ] `npm run lint` + `vue-tsc --noEmit` 零错误；无死文件引用

## Task UI-G: 回归与视觉验收
- [ ] 全流程手测通过（问答/思考/工具/子代理/记忆/会话/粘贴图片/Inspector/确认卡 mock）
- [ ] 明暗 × 3 主题截图无 token 断链与硬编码色漂移，对比度达标
- [ ] 窄窗 <820px 与 1100–1439 断点截图符合 spec 五章
- [ ] AiSummaryFloat / QuickPastePanel 等宿主组件无回归

## 协同交付
- [ ] 前端重构不改变后端消息协议（SSE 结构与字段名逐一对齐契约表）
- [ ] `useAiChat.ts` 冲突排期完成（协议层与 UI 层分工明确）
- [ ] 全部改动在独立分支完成并提 MR 到 `dev/cnb`，不直 push master