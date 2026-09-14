# ClipSync 桌面端 AI 内联化 + 全端端到端加密 工单（并行执行版）

> **依据**：2026-09-14 用户批准的两份方案（① 五个主页面 AI 功能内联化；② 端到端加密全端实现，桌面/服务端/移动端一次做全）。
> **分支**：`feature/desktop-ui-kimi`（基线 fc999f0，clearline UI 重构已合入）
> **执行方式**：子代理并行；**同波工单文件所有权互斥**；子代理禁止一切 git 操作。
> **工单总数**：A 线 8 张（AI 内联化）+ B 线 12 张（E2E），共 20 张。依赖关系见各线 Wave 划分。

---

## 一、全局约束（对所有执行子代理）

1. **文件所有权**：只允许修改本工单「独占文件」清单内的文件；确需越界改动时在交付报告中说明，由编排者合并处理。同波工单之间文件所有权互斥，绝不共享写同一文件。
2. **禁止 git 操作**：不执行任何 git commit/push/checkout；只改代码、跑验证、输出交付报告。
3. **架构事实基线**（免调查，直接采信；与代码冲突时以代码为准并在报告中标注）：
   - 服务端 `content_encrypted` 列现状是**伪 E2E**：客户端传明文（桌面 `src/desktop/src/composables/clipboardUpload.ts:362/:449`、移动 `src/mobile/lib/services/clipboard_capture.dart:259`），服务端原样落盘（`src/server/src/routes/clipboard.js:514-519/:628-633`），GET 无解密。
   - `devices` 表已有 `public_key TEXT` 列（`src/server/src/db/migrate.js:46`，恒为空）；设备注册接口目前不接收公钥（`src/server/src/routes/device.js:159-223`）。
   - 服务端有一套未接线的 E2E 脚手架：`src/server/src/crypto/keyExchange.js`（ECDH P-256 + HKDF + AES-GCM + DeviceKeyManager），除自身外无任何 import，可在 B0/B2 中激活改造。
   - 桌面上传全在前端 TS：文本/图片走 `POST /api/clipboard`（`clipboardUpload.ts`），文件 ≤10MB 走 `POST /api/media/file`，>10MB 走 `utils/chunkedUpload.ts`；Rust 侧（`src/desktop/src-tauri/src/clipboard_monitor.rs`）只做剪贴板监听 emit 事件，无上传无加密。
   - 文件在服务端磁盘是**明文落盘**：`content_encrypted` 对文件类型存磁盘文件名，`media.js:968-1060` text-preview 据此读明文返回。
   - WS 广播 `new_clipboard`（clipboard.js:672-683）payload 含明文 `contentPreview`（≤5000 字符）。
   - 移动端无任何加密依赖（`item_actions_api_service.dart:23` 注明不加 crypto 包，受保护条目走服务端解锁协议）。
   - AI：客户端入口 `POST /api/ai/chat`（SSE 流式，`aiChat.js:25`，conversationId 可选即天然支持单轮）；另有现成单发非流式端点族（`/summarize` `/similarity` `/refactor-prompt` `/suggest`，走 `aiChatCore.js` 的 `runChatLoop`，不建会话）。AI 挂载点有 `aiFlagGuard = requireFlag('enable_ai_agent')`（`index.js:469-470`）；桌面调用链 `api/ai.ts` 的 `streamChat`（:511-568）。
   - 套餐 JSON 已含 `e2e_encryption` 特性位（`db/migrate.js:200-202`，三档全 true）；管理台设备页已按 `d.public_key` 计算 fingerprint 展示（`routes/admin/devices.js:218-241`，公钥恒空所以目前恒显示未设置）。
   - 条目级密码保护（`routes/protection.js` + `useItemPassword.ts` + 移动端服务端解锁协议）是**应用层**能力，与 E2E（传输/存储层）独立共存，**本两线一律不改动**，纠缠问题出现时在交付报告说明。
4. **验证门禁**（每张工单自查，波次结束编排者复验）：
   - 桌面：`cd src/desktop && npx vue-tsc --noEmit` 零 error + `npx vitest run` 通过
   - 服务端：`cd src/server && node --check <file>` + 现有测试通过（若有）
   - 移动：`cd src/mobile && flutter analyze` 零 error
5. **行为红线**：不破坏非 AI 用户与老版本客户端的既有路径；E2E 全链路必须可灰度、可回退（服务端 flag + 客户端设置开关 + metadata 版本标记）；存量数据只能标记兼容、不可破坏性迁移。
6. **报告格式**：每张工单交付 = 改动文件清单 + 自检命令输出摘要 + 偏离工单的决策说明。

---

## 二、A 线：AI 功能内联化（桌面端）

**目标**：五个主页面 + 条目抽屉的 8 个 AI 入口不再依赖右侧 AI 侧栏对话，改为页内直接出结果；写操作类采用「AI 只产预览、用户决定采纳」的两段式；采纳执行按权限渲染（超管一键执行，普通用户仅预览）。每张结果卡右上角保留「在 AI 助手中继续」兜底（携带已产出结果作为上下文进侧栏）。

### Wave A0（串行前置）

#### A0 底座：useInlineAi + InlineAiCard + i18n 全量键
- **目标**：
  1. 新建 `src/server/src/routes/aiInline.js`：单轮非流式内联 AI 端点（复用 `aiChatCore.js` 的 `runChatLoop` 与 `resolveUserProvider`，参考现有 `/summarize` 的实现），`POST /api/ai/inline`，请求体 `{ prompt, context?, maxTokens? }`，响应 `{ ok, text }`；挂载到 `index.js` 同样的 `aiFlagGuard` 之后；**不建会话、不进侧栏消息流**。
  2. 新建 `src/desktop/src/composables/useInlineAi.ts`：`run(prompt, opts)` → `{ status: idle|loading|stream|done|error, text, error }`，支持取消（AbortController）、重试；底层先试 `/api/ai/inline`，404/flag 关闭时回退桌面现有 `streamChat` 聚合为整段文本。
  3. 新建 `src/desktop/src/components/ai/InlineAiCard.vue`：统一结果卡（clearline 卡面语言）——标题、加载骨架/流式文本、错误重试、`复制`/`关闭`/`在 AI 助手中继续`（dispatch 现有 `clipsync:toggle-ai` + `clipsync:ai-send-message` 事件并携带结果文本作为上下文）、可选 `actions` 插槽（供采纳类工单注入按钮）。
  4. **i18n 全量键**（本线其它工单只消费不再新增）：`inline_ai_*` 系列（标题/加载中/失败重试/复制/在助手中继续/采纳/放弃/仅预览提示/超管提示/整理分析中/生成中/诊断中/审查中），中英文一次补齐 `src/desktop/src/locales/zh.json` + `en.json`。
- **独占文件**：`src/server/src/routes/aiInline.js`（新）、`src/server/src/index.js`（仅挂载一行）、`src/desktop/src/composables/useInlineAi.ts`（新）、`src/desktop/src/components/ai/InlineAiCard.vue`（新）、`src/desktop/src/api/ai.ts`（仅追加 inline 调用函数）、`src/desktop/src/locales/zh.json` + `en.json`（本线唯一可写语言包的工单）。
- **依赖**：无。
- **验收**：vue-tsc 零 error；用 curl 直接调 `/api/ai/inline`（带 token）返回模型文本；关闭 `enable_ai_agent` flag 时返回 403 语义而非 500。

### Wave A1（A0 完成后并行，文件互斥）

#### A1 剪贴板页·「总结今日动态」内联结果卡
- **目标**：页头按钮点击 → 页内弹出 InlineAiCard（右侧悬浮或页头下方插入，不跳侧栏），自动携带当天条目摘要调用 AI 流式输出总结；卡片支持复制/关闭/在助手中继续。
- **独占文件**：`src/desktop/src/components/clipboard/ClipboardToolbar.vue`、`src/desktop/src/components/clipboard/ClipboardView.vue`。
- **依赖**：A0。
- **验收**：点击按钮不打开侧栏；总结可见可复制；`enable_ai_agent` 关闭时按钮隐藏（沿用现有 aiEnabled 门控）。

#### A2 收藏页·「总结这个合集」+「AI 整理收藏」两段式
- **目标**：
  1. 「总结这个合集」→ InlineAiCard 内联输出，同 A1 模式。
  2. 「AI 整理收藏」→ **两段式流程卡**（独立组件 `FavOrganizeFlow.vue`）：阶段一「正在分析整理」（骨架/进度文案）→ 阶段二呈现整理预览（AI 返回 JSON：建议的合集分组与标签方案，渲染为可读的分组树/标签清单，标注每条涉及多少条目）→ 操作区按权限渲染：`useUser().isSuperAdmin` 为真显示「采纳执行」（前端按预览调既有收藏 API 重组：`createFavoriteCollection`/`moveCollection`/`setItemTags` 等，执行前 ConfirmDialog 确认条数）；否则显示「按建议手动整理」（仅预览 + 复制建议清单）+ 提示文案；恒有「放弃」。
  3. AI 输出契约：prompt 要求模型只输出 JSON `{ groups: [{ name, icon?, itemRefs: [索引] }], tags: [{ name, color?, itemRefs: [索引] }] }`，itemRefs 指向随 prompt 附带的收藏条目索引清单（id+摘要）；前端解析失败时降级为纯文本预览不提供采纳按钮。
- **独占文件**：`src/desktop/src/components/clipboard/FavoritesView.vue`、`src/desktop/src/components/clipboard/FavOrganizeFlow.vue`（新）。
- **依赖**：A0。
- **验收**：整理流程三阶段可视；超管采纳后收藏树真实变化且可撤销提示（toast）；非超管看不到采纳按钮；JSON 解析失败不白屏。

#### A3 模板页·「AI 生成模板」内联对话框
- **目标**：页头「AI 生成模板」→ 内联对话框：用户输入意图（一句话/要点）→ 调 AI 生成 `{ name, content, variables[] }` → 预览（变量高亮与现有模板详情一致）→「保存为模板」（走现有模板创建 API，普通用户可用自己的额度）+「重新生成」+「放弃」。
- **独占文件**：`src/desktop/src/components/clipboard/TemplatesView.vue`、`src/desktop/src/components/clipboard/TemplateGenerateDialog.vue`（新）。
- **依赖**：A0。
- **验收**：生成→预览→保存全链路可用；保存后模板出现在列表并选中；解析失败可重试。

#### A4 设备页·「AI 诊断同步」内联结果卡
- **目标**：页头「AI 诊断同步」→ InlineAiCard：携带设备在线状态 + 最近同步流水（`useSyncLog`）+ 加密状态生成诊断报告（健康度结论/异常点/建议清单）；支持「在助手中继续」。
- **独占文件**：`src/desktop/src/components/settings/DevicesView.vue`。
- **依赖**：A0。
- **验收**：不跳侧栏；报告内容引用真实流水；aiEnabled 关闭时按钮隐藏。

#### A5 设置页·「审查设置」内联结果卡 + 一键跳设置项
- **目标**：页头「审查设置」→ InlineAiCard：携带设置快照（现有 aiReview 的清单）让 AI 逐项给风险与建议，输出约定 JSON `{ items: [{ key, level: ok|warn|risk, advice }] }`；warn/risk 行内提供「前往设置」按钮 → 复用现有 `scrollToSection(key)` 滚动到对应分节并高亮。解析失败降级纯文本。
- **独占文件**：`src/desktop/src/components/settings/SettingsView.vue`。
- **依赖**：A0。
- **验收**：建议可跳转对应设置分节；无 AI 权限时按钮隐藏。

#### A6 抽屉·原位 AI 三按钮内联化
- **目标**：条目抽屉的「总结 / 翻译为英文 / 提取关键信息」不再跳侧栏：点击后在抽屉 AI 操作区下方内嵌展开结果区（InlineAiCard 小型变体），再次点击同一按钮收起；结果区保留「在助手中继续」。
- **独占文件**：`src/desktop/src/components/clipboard/ClipDetailDrawer.vue`。
- **依赖**：A0。
- **验收**：三个动作均在抽屉内出结果；切换条目时结果区收起；原有 emit('ai') 链路保留给「在助手中继续」使用。

#### A7 侧栏兜底通道
- **目标**：AiChatPanel 支持接收「携带上下文打开」：监听现有 `clipsync:ai-send-message` 事件时，若 detail 附带 `context` 字段则把上下文折叠为引用块置于输入框草稿上方（用户可删），不自动发送。
- **独占文件**：`src/desktop/src/components/ai/AiChatPanel.vue`、`src/desktop/src/composables/useAiChat.ts`（如需草稿状态）。
- **依赖**：A0。
- **验收**：从任一 InlineAiCard 点「在助手中继续」→ 侧栏打开且上下文以引用块呈现、不自动发送。

---

## 三、B 线：端到端加密（全端一次做全）

**目标**：剪贴板内容（文本/图片/文件）端到端加密——服务端与任何无密钥方只见密文；设备配对即交换公钥；存量明文数据标记兼容、平滑过渡；服务端明文功能（搜索/OCR/通知预览）按 B0 决策降级。

### Wave B0（串行前置，编排者或单工单）

#### B0 协议规范 + 明文功能降级决策
- **目标**：产出 `docs/plans/e2e-protocol.md`，冻结以下决策（后续工单照抄实现，不得各自发明）：
  1. **算法栈**：ECDH P-256（每设备静态密钥对；发送方为每条内容生成随机会话密钥 AES-256-GCM，用 ECDH(发送方临时对, 接收方静态公钥)+HKDF-SHA256 封装会话密钥）——以服务端 `crypto/keyExchange.js` 现有族为基础裁剪定稿。
  2. **信封格式**：`content_encrypted` 列存 base64 密文；`metadata.e2e = { v: 1, alg, epk, keys: { [deviceId]: wrappedKeyB64 } }`；`content_preview` 对 E2E 条目存固定占位（如 `[E2E]`）；无 `metadata.e2e` 的条目 = 旧明文条目，全链路按旧逻辑走。
  3. **密钥存储**：桌面 Rust 写 app-data 目录私钥文件（0600）；移动端 `flutter_secure_storage`；私钥永不出设备、不上传。
  4. **明文功能降级决策**（逐项）：全文搜索（content_preview 占位 → tsvector 自然为空，搜索降级到类型/来源/时间，UI 提示）；OCR（对 `metadata.e2e` 条目跳过）；WS 通知预览（占位文案）；AI 图片查重（跳过 E2E 条目）；管理台导出（维持 preview+元数据，注释更新）；条目级密码保护不受影响。
  5. **灰度与回退**：服务端 flag `enable_e2e`（复用现有 flags 机制）总开关 + 用户级设置开关；flag 关闭时客户端全部回退明文上传。
  6. **文件密文落盘**：文件字节由客户端加密后上传，服务端仅存密文 blob；`text-preview` 对 E2E 文件返回 4xx 语义（客户端走本地解密）。
- **独占文件**：`docs/plans/e2e-protocol.md`（新）。
- **依赖**：无。**被依赖**：B1-B11 全部。

### Wave B1（B0 完成后并行，文件互斥）

#### B1 服务端·剪贴板存储与广播透传
- **目标**：`clipboard.js` 接收并原样存储信封（校验 `metadata.e2e` 结构与长度上限：keys ≤ 32 项、单 wrapped ≤ 256B，非法 400）；`content_preview` 接受客户端传来的占位；WS `new_clipboard` 广播透传 `metadata.e2e`（仅推给用户自己的设备）；GET 列表/详情原样返回信封；搜索/排序对占位条目不报错。**不引入服务端 flag**（灰度走客户端双闸门：套餐特性位 + 用户设置，见 e2e-protocol.md §5）。
- **独占文件**：`src/server/src/routes/clipboard.js`、`src/server/src/index.js`（仅 flags 注册处，与 A0 挂载点不同段落）。
- **依赖**：B0。
- **验收**：node --check 通过；curl 模拟带 `metadata.e2e` 的 POST → GET 原样返回；不带 e2e 的旧格式行为不变。

#### B2 服务端·设备公钥注册与配对交换
- **目标**：`device.js` 注册/更新接口接收 `public_key`（校验 PEM/SPKI 格式与长度，入库 `devices.public_key`）；`GET /api/devices` 返回各设备 `public_key`（供发送方封装会话密钥）；配对 redeem 支持携带公钥注册；激活/裁剪 `crypto/keyExchange.js` 为公钥校验工具（格式/指纹）。管理台 fingerprint 无需改动（已就绪）。
- **独占文件**：`src/server/src/routes/device.js`、`src/server/src/crypto/keyExchange.js`。
- **依赖**：B0。
- **验收**：注册带公钥 → devices 表落库 → GET 返回；非法公钥 400。

#### B3 服务端·文件通道密文化
- **目标**：`media.js` + `chunked-upload.js` 接收客户端已加密的文件字节（原样落盘）；`text-preview` 对 `metadata.e2e` 文件条目返回 409 语义（提示客户端本地解密），不再读盘返回明文；下载端点原样透传密文；多文件 `metadata.files` 结构保留。
- **独占文件**：`src/server/src/routes/media.js`、`src/server/src/routes/chunked-upload.js`。
- **依赖**：B0。
- **验收**：上传密文文件 → 下载字节一致；e2e 条目 text-preview 返回 409 而非明文。

#### B4 服务端·明文功能降级
- **目标**：按 B0 决策落实——`utils/aiOcr.js`/clipboard.js 调用点对 `metadata.e2e` 条目跳过 OCR；`utils/imageHash.js` 查重跳过；`routes/admin/users.js` 导出注释与字段核对（preview 为占位）；相关单测/日志文案更新。
- **独占文件**：`src/server/src/utils/aiOcr.js`、`src/server/src/utils/imageHash.js`、`src/server/src/routes/admin/users.js`。
- **依赖**：B0。
- **验收**：带 e2e 标记的图片上传不触发 OCR；旧明文图片 OCR 照旧。

### Wave B2（B1/B2 验收后并行）

#### B5 桌面 Rust·密钥库与 e2e commands
- **目标**：新增 `src/desktop/src-tauri/src/e2e_crypto.rs`：设备密钥对生成（P-256）、私钥持久化（app-data 目录 0600 文件，启动加载）、公钥导出；`#[tauri::command]`：`e2e_status` / `e2e_ensure_keypair` / `e2e_public_key` / `e2e_encrypt(content_b64, recipient_pubkeys) -> envelope` / `e2e_decrypt(envelope) -> content_b64`（算法按 B0，可用 p256/aes-gcm crate）；lib.rs 挂载。前端仍负责组织信封与调用时机，Rust 只做原语。
- **独占文件**：`src/desktop/src-tauri/src/e2e_crypto.rs`（新）、`src/desktop/src-tauri/src/lib.rs`（挂载段）、`src/desktop/src-tauri/Cargo.toml`（依赖项）。
- **依赖**：B0。
- **验收**：`cargo check` 通过；`tauri dev` 下前端 invoke e2e_ensure_keypair 生成密钥、e2e_encrypt→e2e_decrypt 还原一致。

#### B6 桌面前端·加密上传链路
- **目标**：新建 `src/desktop/src/utils/e2eCrypto.ts`：类型定义（信封/公钥）、封装 Rust commands 调用、`isEnabled()`（服务端 flag + 用户开关 + 收件人公钥可得性）；`clipboardUpload.ts` 三条上传路径（文本/图片/文件+分片）在启用时改为：取在线设备公钥列表 → e2e_encrypt → 信封入 `metadata.e2e` + 密文入 `contentEncrypted` + `contentPreview` 置占位；flag 关闭或无收件人公钥时回退旧明文路径（行为不变）。
- **独占文件**：`src/desktop/src/utils/e2eCrypto.ts`（新）、`src/desktop/src/composables/clipboardUpload.ts`、`src/desktop/src/utils/chunkedUpload.ts`（仅加密挂点）。
- **依赖**：B0、B5。
- **验收**：开启开关后新上传条目在 DB 中 content_encrypted 为密文、preview 为占位；关闭开关回退明文；离线队列兼容（入队前已加密）。

#### B7 桌面前端·接收解密 + 设置开关 + 设备公钥状态
- **目标**：`useWebSocket`/`HomeView` 的 `new_clipboard` 处理与 `clipboardLoad` 的内容拉取：检测 `metadata.e2e` → 经 `e2eCrypto.ts` 调 Rust `e2e_decrypt` 还原（本设备在 keys 映射中才可解；不在则显示占位卡片「该条目来自未持有密钥的会话」）；自动写回系统剪贴板链路在解密成功后进行；通知预览用占位文案；设置 → 隐私安全新增「端到端加密」开关（读写用户偏好，flag 关闭时禁用并提示）；设备列表/统计处展示本机公钥指纹（复用管理台 fingerprint 算法的前端版）。
- **独占文件**：`src/desktop/src/views/HomeView.vue`、`src/desktop/src/composables/useWebSocket.ts`、`src/desktop/src/composables/clipboardLoad.ts`、`src/desktop/src/composables/useDevice.ts`、`src/desktop/src/components/settings/settings-dialog/PrivacySettings.vue`。
- **依赖**：B0、B5、B6（消费 e2eCrypto.ts 的类型与函数，只 import 不改）。
- **验收**：两台桌面设备（或模拟第二密钥）互发：接收端自动解密入剪贴板；无密钥第三方只见占位；开关关闭后新条目回退明文。

### Wave B2（移动端，与桌面 Wave B2 并行）

#### B8 移动端·密钥库与设备注册带公钥
- **目标**：`pubspec.yaml` 增加加密依赖（cryptography / pointycastle 二选一，按 B0 算法栈）；新建 `lib/services/e2e_crypto.dart`：密钥对生成、`flutter_secure_storage` 私钥存取、公钥导出、encrypt/decrypt 原语（与 B0 协议一致，向量用 B0 文档中的测试向量对拍）；`auth_provider.dart` 设备注册携带 `public_key`。
- **独占文件**：`src/mobile/pubspec.yaml`、`src/mobile/lib/services/e2e_crypto.dart`（新）、`src/mobile/lib/providers/auth_provider.dart`、`src/mobile/lib/providers/device_provider.dart`。
- **依赖**：B0、B2。
- **验收**：flutter analyze 零 error；单测：加解密往返 + 与 B0 测试向量一致（可用 dart test 或集成到现有测试）。

#### B9 移动端·加密上传链路
- **目标**：`clipboard_capture.dart` 文本/图片上传在启用时改为信封加密（拉取在线设备公钥 → 加密 → `metadata.e2e` + 密文 + 占位 preview）；离线队列 `pending_upload_queue.dart` 存密文；`feature_flags_provider.dart`/`settings_provider.dart` 增加开关（服务端 flag + 本地偏好）；flag 关闭回退明文。
- **独占文件**：`src/mobile/lib/services/clipboard_capture.dart`、`src/mobile/lib/services/pending_upload_queue.dart`、`src/mobile/lib/providers/feature_flags_provider.dart`、`src/mobile/lib/providers/settings_provider.dart`、`src/mobile/lib/screens/settings_screen.dart`（开关 UI）。
- **依赖**：B0、B8。
- **验收**：开启开关后手机复制的条目在服务端为密文；关闭回退；analyze 零 error。

#### B10 移动端·接收解密与同步链路
- **目标**：`ws_service.dart`/`sync_service.dart`/`clipboard_provider.dart`：收到/拉取到 `metadata.e2e` 条目 → 本设备在 keys 映射中则解密入本地库与剪贴板，否则展示占位；列表 UI 对占位条目的展示与复制行为（复制=复制解密后内容；无密钥则提示）。
- **独占文件**：`src/mobile/lib/services/ws_service.dart`、`src/mobile/lib/services/sync_service.dart`、`src/mobile/lib/providers/clipboard_provider.dart`。
- **依赖**：B0、B8、B9（消费 e2e_crypto.dart，只 import 不改）。
- **验收**：PC 复制 → 手机收到并解密可粘贴；手机复制 → PC 侧可见（与 B7 联调项）。

### Wave B3（收尾串行）

#### B11 兼容迁移、混合环境与全端联调
- **目标**：①存量明文条目统一补 `metadata.e2eLegacy = true` 标记（服务端一次性脚本或启动迁移，只加标记不改内容）；②混合环境规则落地：E2E 设备向含「无公钥设备」的账号发送时的降级策略（按 B0：默认仍走明文并在 UI 提示「存在不支持加密的设备」，设置页可强制只发加密）；③端到端联调清单执行：桌面↔桌面、桌面↔移动、明文↔密文共存、flag 开关切换、离线队列、受保护条目（应用层密码）叠加 E2E 的双层场景；④补齐两端的失败可视反馈（解密失败 toast/占位卡）。
- **独占文件**：`src/server/src/db/migrate.js`（仅追加迁移段）、`docs/plans/e2e-protocol.md`（回填联调结果）。
- **依赖**：B1-B10 全部。
- **验收**：联调清单逐项通过并记录在协议文档末尾。

---

## 四、交叉决策备忘（已固化进 B0，不再开放讨论）

1. E2E 上线后**服务端全文搜索/OCR/AI 图片查重对 E2E 条目失效**——属预期行为，UI 相应提示；这三项的恢复依赖未来客户端本地索引方案（不在本批工单）。
2. 条目级密码保护（protection）与 E2E 分层共存：protection 是应用层（服务端持包裹 DEK 参与解锁协议），E2E 是传输存储层，**互不改代码**；双层叠加场景仅在 B11 联调验证。
3. AI 内联化（A 线）读取的条目内容来自客户端本地（缓存/解密后），**不依赖服务端明文**——A 线与 B 线无代码耦合，可完全并行。
4. WS `new_clipboard` 的 preview 字段在 E2E 下为占位文案——桌面通知与自动写剪贴板逻辑均已按「先解密后使用」改造（B6/B7），移动端同理（B9/B10）。

## 五、总验收清单（编排者复验用）

- [ ] A 线：5 个主页面 + 抽屉共 8 个入口全部内联出结果，`enable_ai_agent` 关闭时全入口消失；整理收藏的采纳按钮仅超管可见；「在助手中继续」8 处兜底可用
- [ ] B 线：桌面↔桌面、桌面↔移动 双向加密同步；DB 中新条目 content_encrypted 为密文、preview 为占位；文件服务端磁盘只有密文 blob；flag 关闭全端回退明文；存量条目只读兼容不损坏
- [ ] 两线合并后全量门禁：桌面 vue-tsc + vitest、服务端 node --check + 测试、移动 flutter analyze 全绿
