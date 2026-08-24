# AI Agent 能力边界与安全治理改造 — 分派工作单

> 本单按**能力域**划分为 8 个独立工作包（A–H），每个工作包可交给一个独立 Agent 在各自新建分支上完成。
> 各包之间以「契约接口」衔接（见文末契约表），严格按依赖批次开工。
> 当前基线分支：`dev/cnb`（已快进到 master 741ac9b）。**本单只负责分工，不产生代码。**

---

## 统筹信息（所有 Agent 必读）

- 技术栈：服务端 Express5 + PostgreSQL（全部**参数化 SQL**，事务必须用 `pool.connect()` + `client.query('BEGIN'/'COMMIT'/'ROLLBACK')`）；桌面端 Vue3 + TypeScript + shadcn-vue token（`--bg-*`/`--text-*`/`--accent`/`--danger`）。
- 三条硬性红线（服务端）：
  1. 所有跨表写操作 `WHERE user_id = $1` 硬隔离；
  2. `api_key_encrypted` / 用户正文解密只在服务端完成，绝不落明文日志；
  3. 新增写工具必须同时登记：① 权限矩阵（Agent-A）② `WRITE_TOOL_NAMES`（Agent-B）。
- 常用入口：AI 工具全集与执行器在 `src/server/src/routes/aiTools.js`；角色/权限判定在 `src/server/src/utils/aiSystemPrompt.js`；SSE 流式代理在 `src/server/src/routes/aiChat.js`；多代理编排在 `src/server/src/routes/aiOrchestrator.js`；工具执行流在 `src/server/src/routes/aiStream.js`；上下文聚合在 `src/server/src/utils/aiContext.js`；审计表已建 `src/server/src/utils/audit.js`（`audit_logs` 表）。
- 每个工作包完成后：跑相关单测/语法检查（`npx vitest run` 或 `node --check`），并在分支上自测启动服务。

---

## 批 1（可全并行）— 无前置依赖

### Agent-A：RBACv2 四级权限矩阵重构（后端权限域）

- **建议分支**：`feat/ai-rbacv2-matrix`
- **任务边界**：
  1. 在 `src/server/src/utils/aiSystemPrompt.js` 用「四级 × 四维」矩阵替换现有 `ROLE_PERMISSIONS`/`TOOL_PERMISSION_REQUIREMENTS`：
     - 等级：`L0 只读 / L1 操作 / L2 管理 / L3 超管 / L4 Agent服务`；
     - 四维：`read / write / destructive / cross_user`；
     - 角色映射：`user→L1`、`admin→L2`、`super_admin→L3`；未知角色降级 L1；L4 不参与角色映射。
  2. 实现 `getToolLevel(tool, args?)`、`isToolAllowedForLevel(tool, levelKey)`；改造 `assertToolAllowed(role, toolName)` 返回 `{ allowed, missing, level }`，`getToolsForRole` 返回带 `level` 标签的清单。
  3. 现有 4 个敏感工具（`get_security_overview`/`get_protected_clips`/`explain_deployment`/`get_project_architecture`）登记进矩阵（敏感读 → L3）。
  4. 预留新工具的登记位（`levels: { L1: [...], L2: [...] }` 结构便于 Agent-B 追加）。
- **验收**：`assertToolAllowed('admin','get_security_overview')` → 禁止；`getToolsForRole` 结果含 `level` 字段；全仓库 `ROLE_PERMISSIONS` 旧引用替换干净。
- **交接点**：向 Agent-B 交付矩阵登记结构；向 Agent-F 交付角色过滤口径。

### Agent-D：高级密码条目明文脱离聊天通道（后端隐私域）

- **建议分支**：`fix/ai-password-off-chat`
- **任务边界**：
  1. `src/server/src/routes/aiTools.js` `read_clip_content`（L787 起）：`protection_level === 'advanced'` 一律返回「该条目受高级密码保护，无法在此读取」；**不再受理 password 参数**（保留字段但忽略并给出提示）。
  2. 新增 `ephemeral` 消息标记（user 消息字段）：`src/server/src/routes/aiConversations.js` 的 `saveMessages`（L299 起）跳过 `ephemeral === true` 的消息不落库；`/chat` 透传该标记但仅当轮生效。
  3. 明文一次性注入通道：客户端可在当轮请求携带 ephemeral 明文进入上下文，不持久化；`save_memory` 工具在 Prompt 层面禁止转存 ephemeral 内容（在 `aiTools.js` 的 `save_memory` 分支加 args 校验即可：ban 以 ephemeral 容器传参）。
- **验收**：`advanced` 条目任何模型/RBAC 路径拿不到明文；ephemeral 消息发送后 `GET /api/ai/conversations/:id` 不返回该消息；`save_memory` 无法保存以 ephemeral 方式传入的内容。
- **交接点**：向 Agent-F 提供 ephemeral 标记约定；向 Agent-G 说明前端需在发送时打标记。

### Agent-E：工具全量审计 + 上游安全修复（后端横切域）

- **建议分支**：`fix/ai-audit-and-upstream`
- **任务边界**：
  1. 审计：封装 `logToolAudit({ userId, role, tool, argsSummary, resultSummary, ok, durationMs, requestId })` 写 `audit_logs`（复用 `utils/audit.js`）；`argsSummary` 脱敏（password/apiKey/token 字段打码）。`executeTool` 成功与失败路径均调用。`requestId` 字段约定与 Agent-C 对齐（优先取下层传入，无则内部生成）。
  2. SSRF 收口（`src/server/src/routes/aiProviders.js` + `src/server/src/utils/aiProviders.js`）：
     - `fetch-models`（aiProviders.js L288）不再采信请求体 `baseUrl`，只使用库中 `base_url`；
     - `/providers/:id/test`（L311 起）fetch 加超时与 `AbortSignal`；
     - 抽取 `safeUpstreamFetch()`（现场解析+校验+禁 redirect+超时）供 chat/models/test/ocr 复用。
  3. Anthropic 默认 `max_tokens`：`utils/aiProviders.js` L380 `options.maxTokens || 1024` → `4096`（options 显式传值优先）。
  4. 清理死路由：`aiTools.js` 的 `/tools`、`/tools/execute`（L1092-1110）删除（前端未使用，index.js 也未挂载）。
- **验收**：任意工具调用（含失败）产生 audit_logs 行；`fetch-models` 无法用 body baseUrl 打内网；test 请求带超时；Anthropic 默认回复不再 1024 截断；`GET /api/ai/tools` 返回 404。
- **交接点**：向 Agent-B 提供可直接调用的 `logToolAudit`；向 Agent-C 提供 `requestId` 传递约定。

---

## 批 2（依赖批 1）— 可两两并行

### Agent-B：Agent 写工具面补齐 + 删除假工作流（后端工具域）

- **建议分支**：`feat/ai-agent-write-tools`
- **前置**：Agent-A（矩阵登记位）、Agent-E（`logToolAudit`）就绪后开工。
- **任务边界**：
  1. `src/server/src/routes/aiTools.js` 新增工具定义 + `executeTool` 分支（参考现有 SQL 写法，全部 `user_id` 隔离）：
     - L1：`write_clip`（把 AI 生成文本/类型写入剪贴板，AES-256-GCM 加密入库，`source_device_id` 置 null）、`tag_items`、`archive_items`、`unarchive_items`、`update_clip_meta`；
     - L2：`create_collection`、`create_template`、`update_template`、`create_shared_link`。
  2. 从 `TOOLS`/`WRITE_TOOL_NAMES`/`executeTool` 中**彻底删除**假工具 `create_workflow`、`execute_workflow_step`；确认 `services/workflowEngine.js` 仅被 `clipboard.js`（规则引擎）使用，本包不实现自动化。
  3. 新工具逐个登记进 Agent-A 的矩阵；全部加入 `WRITE_TOOL_NAMES`；全部接入 `logToolAudit`。
  4. `get_templates`/`get_shared_links`/`get_devices` 等只读工具的返回中剔除不必要的敏感字段（如 `shared_links.access_code` 不再返回明文）。
- **验收**：Agent 模式通过对话即可完成「建收藏夹→打标签→归档→建模板→写剪贴板→建共享链接」全流程且数据真实落库；`create_workflow` 不再存在于代码。
- **交接点**：向 Agent-G 交付新工具名清单与写操作成功后的 tool_result 结构；向 Agent-C 提供新增的破坏性工具清单（`destroy_clips` 属 C）。

### Agent-C：破坏性操作治理 + SSE 确认门控（后端执行域）

- **建议分支**：`feat/ai-confirm-gate`
- **前置**：Agent-A（L2 破坏性判定）就绪；与 Agent-B 并行（先把 `batch_delete`→`destroy_clips` 打通协议，再容纳 B 新增工具）。
- **任务边界**：
  1. `batch_delete`（aiTools.js L645 起）语义变更：
     - 默认动作改走 `archive_items`（软删除 `UPDATE ... SET archived=true`）；
     - 新增 `destroy_clips`（物理 DELETE）仅 L2+，`clip_ids` 上限 50（>50 拒绝并提示分批）；
     - `batch_favorite` 定为 L1。
  2. 破坏性动作**确认门控**（写工具先按此协议演进）：
     - `executeTool` 判定为“需确认”的破坏性工具时不直接执行，而是登记全局 `pendingRequests`（Map：requestId → {tool, args, userId, 超时 120s, 并发上限 1}），经 `sendDelta` 下发 `{ meta: { type: 'confirm_tool_action', requestId, tool, argsSummary, impact } }`，等待用户确认；
     - 新增确认入口（建议 `POST /api/ai/chat/approve`，带 requestId + allow/false + CSRF），批准后执行并把结果以 `tool_result` 回传 LLM；拒绝则回 `{ error: 'REJECTED_BY_USER' }`；
     - 超时/流中断（`safeFinish`）/客户端断开（`req.on('close')`）时清空对应 pending 项。
  3. 确认门控的 SSE 事件与 `requestId` 规范写入文末契约表，供 Agent-G 前端消费。
- **验收**：模型请求 `destroy_clips` 时前端收到 `confirm_tool_action`；批准→执行、拒绝→不执行且 LLM 得到 REJECTED_BY_USER；并发第二个破坏性请求被队列拒绝或等待；中途断流不残留 pending。
- **交接点**：向 Agent-G 交付 SSE 事件格式与 approve 接口契约。

### Agent-F：服务端统一上下文组装 + 前端死代码清理（跨端上下文域）

- **建议分支**：`refactor/ai-context-assembly`
- **前置**：Agent-A（角色过滤口径）。
- **任务边界**：
  1. `src/server/src/utils/aiSystemPrompt.js`（或新 `utils/aiContextPrompt.js`）新增 `buildSystemPrompt(userId, role, opts)`：产品知识精简段（复用 `aiKnowledge` 文档摘要，**不把 DB schema 发给普通用户**）+ `getAiContext(userId)` 脱敏统计段 + 按角色过滤的记忆段（尊重 `memoryEnabled`：用户开关决定是否注入）+ thinking/Agent 增强（保留现有 `enhanceSystemPrompt`）。
  2. `src/server/src/routes/aiChat.js` `/chat`（L43-56 附近）：用 `buildSystemPrompt` 组装完整 system，替代仅“覆盖角色提示”的现状；同时保留 duplicate_image 等既有注入逻辑。
  3. 前端 `src/desktop/src/composables/useAiChat.ts`：移除 `fetchContext()`/`buildSystemPrompt(ctxData)` 的调用与上下文拼装（L405-474 附近的 ctxData 构造删除），只传业务消息；确认 `src/desktop/src/utils/aiSystemPrompt.ts` 无引用后删除。
  4. `memoryEnabled` 生效链路理顺：开关持久化在 `ai_settings`，服务端组装时读取（或前端每轮透传布尔，二选一并统一——优先服务端读 `ai_settings`）。
- **验收**：抓包确认普通用户 system prompt 含产品知识+统计、不含 DB schema；开启记忆后 user 问“你记得我的偏好吗”能结合记忆作答；前端请求 payload 不再携带前端拼装的知识库。
- **交接点**：向 Agent-G 说明不再从前端注入上下文，确认卡片等交互不受影响。

---

## 批 3（依赖批 2）

### Agent-G：前端 Agent 交互配套（前端交互域）

- **建议分支**：`feat/ai-agent-confirm-ui`
- **前置**：Agent-C（确认门控协议）、Agent-B（写工具展示）。
- **任务边界**：
  1. `src/desktop/src/composables/useAiChat.ts` + `AISidebar.vue`：监听 `meta.type === 'confirm_tool_action'`，渲染确认卡片（工具名、args 摘要、impact、允许/拒绝按钮）；调用 `POST /api/ai/chat/approve`（requestId + allow）。
  2. `AiMessage.vue`/`AiToolTimeline.vue`：写操作成功后在时间线标注（如“已写入剪贴板”“已收藏 N 条”）；破坏性动作红色标签；等待确认时显示“等待确认”态。
  3. 样式复用既有 token，scoped 隔离，无全局污染；对照现有 `AiMessage` 折叠头（`ai-process-collapsed`）风格保持一致。
- **验收**：模型请求破坏性工具时出现确认卡片，允许/拒绝全流程可用；写操作后的 tool_result 在时间线可见；`AISidebar` 无回归（历史/记忆/模式切换正常）。

### Agent-H：后端测试与回归（测试域）

- **建议分支**：`test/ai-agent-ops`
- **前置**：Agent-A ~ E 全部合入后再编写。
- **任务边界**：新增 `src/server/tests/ai-agent-ops.test.js`，覆盖：
  1. 权限矩阵：user/admin/super 对 L0-L3 各工具允许/拒绝；
  2. 写工具落库与 user_id 隔离（`write_clip`/`create_collection`/`archive_items`）；
  3. `destroy_clips` 确认门控：收到 confirm→批准→执行；拒绝→不执行且错误标记；
  4. `read_clip_content` advanced 保护提示；ephemeral 消息不落库；
  5. 工具调用产生 audit_logs 行；
  6. 既有回归：`npm test` 全绿（重点 `security.test.js`/`integration.test.js`）。
- **验收**：新增用例全绿；既有测试零回归；启动服务手动冒烟 AI 面板基础对话正常。

---

## 契约表（跨 Agent 接口，先于实现冻结）

| 契约 | 提供方 | 消费方 | 内容 |
|---|---|---|---|
| 权限矩阵结构（LEVELS + LEVEL_TOOLS + getToolLevel） | Agent-A | B/C/F | 新工具登记位、level 标签、getToolsForRole 返回结构 |
| logToolAudit（含 argsSummary 脱敏规则） | Agent-E | B/C | 写工具与 destroy 调用签名 |
| requestId 约定（UUID，透传到 audit/confirm） | Agent-C | E/G | SSE 事件字段与 approve 请求体规范 |
| confirm_tool_action SSE 事件 + POST /chat/approve | Agent-C | G | `{ requestId, tool, argsSummary, impact }`；响应 `{ accepted, final? }` |
| destroy_clips / 破坏性工具级联清单 | Agent-B→C | G | 哪些工具会触发确认卡片 |
| ephemeral 标记（user 消息，saveMessages 跳过） | Agent-D | F/G | 前端发送时打标记；后端不落库 |
| memoryEnabled 读取位置（服务端 ai_settings） | Agent-F | — | 统一记忆注入口径 |

## 批次与并行建议

1. **批 1（并行）**：A、D、E 同时开工。
2. **批 2（并行）**：A/E 交付票后 → B、C、F 同时开工。
3. **批 3**：G（依赖 B/C 票）与 H（依赖 A–E 票）可并行收尾；H 最后跑全量回归。

## 合入策略

- 每个 Agent 在自己的分支完成并自测后，提 PR/MR 到 `dev/cnb`，由统筹角色（本会话）做整合与回归；**不允许任何 Agent 直接 push master**。
- 合入顺序：A → D → E → B → C → F → G → H（串行合入便于定位回归，即便开发并行）。