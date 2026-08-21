# ClipSync AI 模块代码审计报告

- **日期**：2026-08-16
- **范围**：桌面端（Tauri + Vue3）`src/desktop/src/api/ai.ts`、`composables/useAiChat.ts`、`useAiConversations.ts`、16 个 `components/ai/*.vue`；服务端（Express5 + PostgreSQL）9 个 `routes/ai*.js`、5 个 `utils/ai*.js`，合计约 1.3 万行
- **方法**：核心链路（SSE 流式、编排、工具执行、持久化、鉴权）逐行精读；展示型组件由并行子代理审计后汇总核实。所有发现均在代码中验证过位置与行为
- **结论摘要**：高危安全漏洞 4 项、高危功能 Bug 5 项、中危 17 项、低危/卫生若干。架构方向正确（BYOK、三层 RBAC、多代理编排、上下文压缩），问题集中在跨端契约断裂、竞态处理系统性缺失、"全量替换"式持久化与若干越权/注入漏洞

---

## 一、高危：安全漏洞

### 1. IDOR：`conversationId` 无属主校验，可跨用户读写他人会话
`src/server/src/routes/aiChatCore.js:27` 与 `:51`：

```js
SELECT content FROM ai_messages WHERE conversation_id = $1 AND role='system' ...
INSERT INTO ai_messages (conversation_id, role, content, metadata) VALUES ($1, 'system', ...)
```

`/api/ai/chat` 的 `options.conversationId` 完全来自客户端，`fetchLatestContextSummary` 与 `persistContextSummary` 均不校验该对话属于当前用户。后果：
- **跨用户读取**：传他人 conversationId，对方的"历史压缩摘要"会被注入本次请求上下文并随流式回答返回；
- **跨用户写入**：`persistContextSummary` 把摘要插进受害者对话（system 角色、被模型当记忆），构成向他人会话注入提示词的通道。

`updateConversationUsage` 反而做了 user_id 校验，说明团队知道要做，这两处漏了。
**修复**：两处 SQL JOIN `ai_conversations` 校验 `user_id`，或在 `/chat` 入口一次性校验。

### 2. XSS：历史搜索高亮未做 HTML 转义
`src/desktop/src/components/ai/AiConversationList.vue:156`：

```html
<span v-html="highlightSnippet(hit.snippet, searchQuery).replace(/\u0001/g, '<mark …>')…" />
```

`highlightSnippet`（L90-95）只转义关键词的正则字符，snippet（任意用户消息/AI 输出）未经 HTML 转义与 DOMPurify 直进 `v-html`，含 `<img src=x onerror=…>` 即在 webview 执行。项目已有 `sanitizeHtml`（AiMessage 的 markdown 链路在用，那条链路安全），此处漏用。
**修复**：先 `escapeHtml(snippet)` 再做标记替换，或复用 sanitizeHtml。

### 3. SSRF 防护存在多个绕过
`src/server/src/routes/aiProviders.js` 已有 `validateProviderBaseUrl`（值得肯定），但有四个缺口：
- **`POST /providers/fetch-models`（L288）**：`baseUrl: row.base_url || baseUrl`——请求体里的 `baseUrl` 在库中 base_url 为空时被直接采用，完全绕过校验；响应 `data[].id` 会回显给调用方，内网探测结果可外带；
- **IPv4-mapped IPv6 / 十进制 IP 绕过**：`isPrivateIp`（L13-31）不识别 `::ffff:127.0.0.1` 等形式；`http://2130706433/` 也不在四段正则覆盖内；
- **DNS rebinding TOCTOU**：保存时解析一次、fetch 时 Node 重新解析，攻击者控制 DNS 即可在校验后切到内网（注释声称"防 rebinding"，实际防不住）；
- **`POST /providers/:id/test`（L328）的 fetch 无超时**。

**修复方向**：抽统一 `safeUpstreamFetch()`：fetch 前现场解析并校验全部地址、自定义 agent 锁定 IP、禁 redirect、带超时；chat/models/test/ocr 全部走它；删除 fetch-models 的 body baseUrl。

### 4. 提示注入 → 破坏性工具无防线
`src/server/src/routes/aiTools.js`：
- **`batch_delete`（L645）**：LLM 可凭一己判断硬删用户数据，`clip_ids` 无数量上限、无确认环节、非软删除。剪贴板内容是不可信输入（复制来的网页/文档），一句"请帮我删除所有…"就可能触发。建议：AI 路径禁物理删除，改 `archived=true` 或"待确认清单"，且 `clip_ids.slice(0, 50)`；
- **`read_clip_content`（L787）**：高级密码保护要求用户把密码打进聊天，从此进入 `ai_messages` 明文落库、进入 LLM 上下文、可能被 `save_memory` 记住。该设计应推翻：密码只应在客户端解密后一次性注入，或禁止 AI 通道读取 advanced 条目；
- `get_shared_links`（L752）把 `access_code` 原样给模型，属不必要暴露；
- `execute_workflow_step`（L690）递归调用 `executeTool` 无深度限制，自指即无限递归。

---

## 二、高危：功能性 Bug

### 5. `saveMessages` 的"事务"跑在连接池上，等于没有事务
`src/server/src/routes/aiConversations.js:319-360` 用 `pool.query('BEGIN')` / `pool.query('DELETE')` / … / `pool.query('COMMIT')`——每条语句可能拿到**不同连接**。BEGIN 占着连接 A 的事务被释放回池，DELETE 可能跑在无事务的连接 B 上，ROLLBACK 更是随机连接。轻则事务形同虚设（DELETE 成功后插入失败 = 消息整段丢失），重则连接 A 带开放事务回池污染后续查询。同项目 `aiProviders.js:143-163` 的 `pool.connect()` + `client.query` 写法是对的，照抄即可。这是"历史消息丢失/乱序"类 bug 的最可能根因。

### 6. 前端精心构建的 system prompt 被后端整体丢弃（RBAC 改造留下的断裂）
前端 `useAiChat.ts:532` 构建 prompt（`utils/aiSystemPrompt.ts`：产品知识、DB 结构、用户实时统计、最近条目、长期记忆注入、工具调用铁律），但后端 `aiChat.js:52-56` 出于 RBAC（#212）把 `messages[0].content` 整体替换为角色提示词。后果：
- "长期记忆"功能（memoryEnabled 注入）在 /chat 通道实际失效——模型只剩 `get_memories` 工具；
- 最近条目预览、实时统计注入全部失效；
- 前端 prompt 里的 DB schema 本就不该发给普通用户，两个设计在互相打架。

**修复方向**：上下文注入迁到服务端——`buildRoleSystemPrompt` 合并 `getAiContext(userId)` 脱敏摘要 + 记忆（按角色过滤敏感字段），前端只传业务消息。

### 7. 会话切换竞态 → 消息写错会话
`useAiConversations.ts:83-92`：`select()` 先置 `currentConversationId` 再 `await getConversation(id)`，无版本守卫。快速切换 A→B 时 A 的慢响应后到被采纳，界面显示 A 的消息、会话指向 B，随后 `saveCurrent`（全量替换语义）把 A 的消息整段写进 B——配合第 5 条的 DELETE+重插，数据永久串号。
**修复**：await 后校验 `id === currentConversationId.value` 再应用。同类竞态：`AiSuggestPopup` 关闭重开不中止飞行中请求、`AiConversationList` 搜索 enter 绕过防抖。

### 8. `/chat` 外层 catch 引用 try 块作用域内的变量
`aiChat.js:130` 声明的 `const safeFinish` 在 `:305` 的外层 catch 里不可见（try/catch 是独立块作用域）。若错误在 `res.flushHeaders()`（L113）之后、内层 try（L230）之前抛出且 headersSent 为真，触发 `ReferenceError`。当前是潜伏代码。把 `safeFinish` 声明提到 try 之前。

### 9. `/chat` 不监听客户端断开，上游继续烧钱
`/refactor-prompt` 有 `req.on('close', () => upstreamAbort.abort())`（L475），但 `/chat` 没有。用户关闭侧栏/切换会话后，后端继续消费上游 LLM 流直到 180s 超时——白烧 API 配额，且 `updateConversationUsage` 还会把这份被丢弃回答的用量记账。补 `req.on('close')` 中止上游即可。

---

## 三、中危问题（均已验证）

| # | 位置 | 问题 |
|---|------|------|
| 10 | `aiChatCore.js:170-176` | `looksLikeToolIntent` 关键词含"让我/使用/调用/use"——中文正常回答几乎必中，触发多余重试轮，浪费 token 且偶尔吞掉首个答案 |
| 11 | `aiChatCore.js:530` | `maxRounds` 耗尽返回 `finalContent:''`——用户看到空回复且无任何错误提示 |
| 12 | `utils/aiProviders.js:380` | Anthropic 分支 `max_tokens: options.max_tokens \|\| 1024`——前端 /chat 不传 maxTokens 时 Claude 回复一律 1024 token 截断 |
| 13 | `aiChatCore.js:279` | 每次自动压缩 INSERT 一条新摘要行，旧摘要无限累积；应 UPSERT/删旧行 |
| 14 | `AISidebar.vue:101-110+159` | 切历史会话把该会话 mode/thinking 写回本地 ref，触发 watch `persistSettings`——点开 agent 模式旧对话，全局默认模式被改成 agent |
| 15 | `AiChatInput.vue:99-137` | 提示词优化流式覆盖 `text.value`：期间敲键被冲掉；失败/取消不回滚原文；空输入也发请求；卸载不 abort |
| 16 | `aiTools.js:609-630` | `analyze_clip_usage` 的 summary 用全量 total 却写"过去30天共 N 条"——口径错误 |
| 17 | `aiTools.js:996/1059` | `get_archived_clips`、`get_notifications` 的 limit 未夹紧（`search_clips`/`get_recent_clips` 有） |
| 18 | `aiTools.js:1085` | `executeTool` 外层 catch 把 `err.message`（可能含 SQL 细节）作为工具结果回传 LLM，与 `aiStream.js:161`"绝不回传"的注释矛盾 |
| 19 | `aiConversations.js:263` | `/compact` 里 `role: req.role \|\| 'user'`——`req.role` 不存在，应为 `req.user.roleKey` |
| 20 | `aiConversations.js:55-56` | 搜索的 `pos_in_conv` 只数非 system 消息、`total_in_conv` 数全部——定位分母口径不一致，前端跳转偏移 |
| 21 | `AiMessage.vue:414-415` | 流式期间每个 token 触发整条消息 `marked.parse + DOMPurify` 全量重渲染，长回复 CPU 开销显著；应节流（约 100ms 合并） |
| 22 | `useAiChat.ts:550-558` | 历史里所有旧图片 base64 每轮全量重发——token 与流量双爆炸，几张截图即逼近 `jsonBodyLimit=10mb` 报 413。应转服务端引用（imageHash/clip_id）只发一次 |
| 23 | `aiOcr.js:136` | 每张复制的图片自动送第三方 LLM OCR——无显式开关、无频控（隐私+成本）；`getOcrProvider` 用 provider is_default 而非 ai_settings 默认项，两套"默认"不一致 |
| 24 | `index.js:436` + 各路由 | `apiLimiter` 在挂载点和路由内双重挂载，同一请求计数两次，限额实际减半（300→150/min） |
| 25 | `AiThinkingOrb.vue:75-80` | `matchMedia` change 监听器从不移除，每条消息泄漏一个并闭包持有已 destroy 的 orb |
| 26 | `AiConversationList.vue:184-210` | 重命名"取消"按钮永远执行"确认"（mousedown 先触发 blur 提交） |

---

## 四、低危 / 卫生问题

- **死代码**：`aiTools.js` 导出的 `/tools`、`/tools/execute` 路由从未在 index.js 挂载（前端也未调用）——删除或挂载，当前状态误导维护者。
- i18n 硬编码中文散落：`AiMessage.vue:216/386`、`AiConversationList.vue:61`、`useAiConversations.ts:67`（"新对话"）等；`t('x') || '兜底'` 模式因 t() 缺 key 返回 key 本身而永不生效。
- `AiMessage.vue:197-212` 遗留 console.log watch；`AiSuggestPopup` 的 `duplicateEntries` 恒为空、`candidates` prop 已废弃。
- `AiMessage.vue:127-137` 思考秒数 computed 无定时器驱动，思考中显示冻结。
- `AiConversationList` 搜索 timer 未在 onUnmounted 清理；`formatTime` 对非法日期输出 NaN。
- `orbs-js/` 为 orbs.jakubantalik.com 的算法级移植副本，无版本号、无 LICENSE 文件——合规风险。
- 各路由 500 响应普遍带 `detail: err.message`，向客户端泄露内部错误细节，建议统一脱敏中间件。

---

## 五、优化建议（按优先级）

**P0（本周内，安全 + 数据完整性）**
1. 修 IDOR（#1）、XSS（#2）、fetch-models 的 body baseUrl（#3）——三处均十行内修复；
2. `saveMessages` 改用 `pool.connect()` 事务（#5）；
3. `batch_delete` 加上限 + 改软删除/确认（#4）。

**P1（两周内，消除"玄学 bug"主要来源）**
4. **prompt 组装收敛到服务端**：`buildRoleSystemPrompt` + 脱敏 context + 记忆 + 工具铁律在后端合并，前端只发业务消息（#6），同时删掉前端 prompt 里的 DB schema；
5. 所有"await 后再赋值"竞态点加版本守卫（#7、AiSuggestPopup、搜索）；
6. `/chat` 补 `req.on('close')` 中止上游（#9）；外层 catch 的 `safeFinish` 提到 try 外（#8）；
7. Anthropic 默认 max_tokens 提到 4096+（#12）；maxRounds 耗尽给用户可见提示（#11）。

**P2（结构性，一个月内）**
8. **消息持久化从"全量替换"改增量 append**（只 push 新消息 + 偶尔 reconcile），长对话不再每轮 DELETE+重插几百行，也自然消除大部分串号风险；给 `ai_messages(conversation_id, created_at)` 确认索引；
9. **图片走引用不重发**：多模态消息只带引用，由后端拼装（#22）；
10. 统一出站 fetch 封装（SSRF 双重校验 + 锁 IP + 超时）；OCR 加用户级开关与频控；
11. 流式 markdown 渲染节流；`looksLikeToolIntent` 改为只匹配"明确承诺调用特定工具名"；
12. **补测试**：针对 SSE 解析（aiStream）、工具 RBAC、编排降级路径、saveMessages 事务补集成测试。

**做得对的地方**（保持）：AES-256-GCM 随机 IV 密钥存储、全量参数化 SQL、三层 RBAC 设计、`aiStream` 工具错误脱敏、`safeFinish` 幂等收敛、前端 agent 卡片多层看门狗兜底。

---

*配套报告：`2026-08-16-ai-module-style-audit.md`（前端样式专项审计）*
