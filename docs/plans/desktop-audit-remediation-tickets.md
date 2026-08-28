# 桌面端功能健康度整改工单派发（2026-08-28）

> **依据**：[desktop_functional_health_audit_2026-08-28.md](../../desktop_functional_health_audit_2026-08-28.md)（本仓库根目录审核报告，含全部 文件:行号 证据）。行号为审核时快照，执行时以实际代码为准。
> **执行方式**：三条独立工作流（A/B/C）拆分工单，**默认最多 2 个子代理并行**（防并发限流），三流文件所有权无交集时可升到 3 并发。每张工单有独占文件所有权，波次之间设验证门禁。
> **产品纪律**：只修不堆新功能。假实现一律"接线或诚实摘除"，禁止保留看起来能用实际无效的入口。支付模块强依赖外部环境，本期仅做诚实占位（C7），不做真实对接。

---

## 一、全局约束（对所有执行子代理）

1. **文件所有权**：只允许修改本工单「独占文件」清单内的文件；「共享文件」按第二节主责规则处理；需要越界改动时在交付报告中说明，由编排者统一处理。
2. **禁止 git 操作**：子代理不执行任何 git commit/push/checkout/worktree；只改代码、跑验证、输出交付报告。
3. **验证门禁**（每张工单完成后自查，波次结束由编排者复验）：
   - 前端：`cd src/desktop && npx vue-tsc --noEmit` 零错误；`npx eslint src --quiet` 零 error。
   - Rust：`cd src/desktop/src-tauri && cargo check` 零错误（涉及 Rust 的工单）。
   - 构建：`npx vite build` 成功（波次结束）。
4. **行为红线**：纯修复不改产品语义；接口字段/返回结构变更必须同步全部消费方；新增 i18n key 必须同时写入 zh.json 与 en.json。
5. **视觉验收**：每个涉及 UI 的工单交付时附「视觉验收清单」（操作路径 + 可二进制观察的预期结果），供编排者汇总为最终验收流程。

---

## 二、并行策略与文件所有权

### 流划分

| 流 | 主题 | 独占范围 | 工单 |
|---|---|---|---|
| **A** | Rust 后端 + 系统集成 | `src-tauri/**`、`src/lib/tauri.ts`、`src/stores/configStore.ts`、`GeneralSettings.vue`、`AboutView.vue`、`ShortcutsSubPage.vue`、`ShortcutsModal.vue`、`PrivacySettings.vue` | A1–A10 |
| **B** | 剪贴板主链路 + 交互 | `src/composables/**`、`components/clipboard/**`（除 favorites-view.css 共有样式外全部）、`QuickPaste*`、`useWebSocket.ts`、`HomeView.vue`、`components/modals/VersionHistoryModal.vue`、`ExportModal.vue` | B1–B10 |
| **C** | AI 模块 + i18n + 假实现清理 | `components/ai/**`、`AiSummaryFloat.vue`、`AiSuggestPopup.vue`、`locales/**`、`useI18n.ts`、`components/settings/settings-dialog/**`（除 A 独占的 4 个文件）、`components/settings/**`、`components/modals/**`（除 B 独占 2 个）、`stores/templateStore.ts`、`templateVariableStore.ts`、`styles/globals.css`、`router/index.ts`、`AuthPage.vue`、`AppSidebar.vue` | C1–C8 |

### 共享文件主责表（冲突高发点，合并顺序 A → B → C，后合并者负责 rebase）

| 文件 | 主责 | 其他流涉及时的处理方式 |
|---|---|---|
| `configStore.ts` | A（server_url/持久化/logout 撤销会话） | B、C 只读消费已有 ref，不修改 |
| `clipboardUpload.ts` | B | D1 摘牌时的字段更名由 B 代执行 |
| `HomeView.vue` | B（键盘层级栈/托盘事件 listen） | A 的托盘功能以 Tauri 事件（emit）提供，HomeView 侧 listen 由 B10 执行 |
| `ModalManager.vue` | C（假实现清理为主） | A8 仅改 updates 弹窗版本号一行，A 先行 |
| `GeneralSettings.vue` | A（autoSync 等设置消费） | C 不碰此文件文案 |
| `AboutView.vue` | A（更新接线，顺带处理其中 4 行中文） | C 不碰 |
| `PrivacySettings.vue` | B（清空剪贴板开关，顺带处理其中 19 行中文） | C 不碰 |
| `locales/zh.json`、`en.json` | C（key 收口） | B 可**追加式**新增 key（key 前缀沿用所在域命名），冲突由编排者合并 |
| `ModalDialog.vue` | C（a11y/z-index） | B 不碰 |

### 派发波次

- **Wave 1（2 并发）**：流 A 全部 + 流 B 的 B1–B6
- **Wave 2（2 并发）**：流 C 全部 + 流 B 的 B7–B10（含决策项 D3/D4 落地）
- **Wave 3（编排者独占）**：合并、prettier `endOfLine` 全库格式化（独立提交，避免与功能改动冲突）、全量门禁、视觉验收、合并回 `dev/cnb`

---

## 三、流 A：Rust 后端与系统集成（10 张）

### A1 [P0][修复] 服务器地址可配置 + Rust 配置持久化
- **文件**：`lib.rs`、`configStore.ts`、`GeneralSettings.vue`
- **问题**：`configStore.ts:17,49` 强制覆写 `server_url='http://localhost:3001'` 且无配置入口；`lib.rs:1189` `send_verification_code` 硬编码 localhost:3001；`AppState` 每次启动用 `AppConfig::default()` 不落盘。
- **要求**：① 移除 load() 强制覆写，默认值仅在配置为空时生效；② GeneralSettings 新增"服务器地址"设置项（http/https 校验、默认值回填、修改后提示需重连）；③ Rust AppConfig 持久化到 app_config_dir 下的 JSON（读失败容忍）；④ `send_verification_code` 改读配置；⑤ server_url 为空时界面显示"未连接"状态。
- **验收**：修改 server_url 后重启仍保留；验证码请求打到配置地址（日志可见）；配置文件损坏时以默认值启动不崩溃。

### A2 [P0][修复] revealInFolder 命令名错配
- **文件**：`lib/tauri.ts`
- **要求**：`invoke('revealInFolder')` → `invoke('reveal_in_folder')`。
- **验收**：条目右键"在资源管理器中显示"能打开并选中文件；同函数其余 2 个调用点行为恢复。

### A3 [P1][修复] 剪贴板写回卫生
- **文件**：`lib.rs`
- **要求**：`set_clipboard_content` 在写入前调用 `raw::empty()`（对齐 `set_clipboard_files` 的做法），避免同步文本写入后残留旧图片/文件格式。
- **验收**：先复制图片，再触发跨设备文本写回，Ctrl+V 得到的是文本而非旧图片。

### A4 [P1][修复] 监听线程自愈与资源上限
- **文件**：`clipboard_monitor.rs`
- **要求**：① `Monitor::new` 失败或 `recv()` 出错后自动重建（指数退避，连续失败向上 emit 错误事件）；② DIBV5/PNG 读取加 50MB 上限（对齐 `check_clipboard_image_info`）；③ worker 队列设容量上限（满则丢最旧并告警）；④ `last_change_time` 启用时间防抖（约 300ms）。
- **验收**：模拟监听故障后自动恢复采集；超大位图不产生内存尖峰；连发复制不产生重复条目。

### A5 [P1][接线] 日志落盘与崩溃可诊断
- **文件**：`Cargo.toml`、`lib.rs`、`main.rs`
- **要求**：① 引入 `tauri-plugin-log`（文件 + stdout appender、轮转）；② 设置 panic hook 写日志；③ 全部 `eprintln!` 替换为 log 宏。
- **验收**：release 构建运行后日志目录有内容；人为 panic 在日志留有痕迹。

### A6 [P1][接线] 单实例锁与窗口状态记忆
- **文件**：`Cargo.toml`、`lib.rs`
- **要求**：引入 `tauri-plugin-single-instance`（二次启动聚焦已有窗口）与 `tauri-plugin-window-state`（记住位置尺寸）。
- **验收**：双击两次只出现一个实例；重启后窗口位置/尺寸保留。

### A7 [P1][接线] 更新链路真接线
- **文件**：`lib.rs`、`tauri.conf.json`、`AboutView.vue`、`lib/tauri.ts`
- **要求**：① AboutView"检查更新"调真实 `check_for_updates`（有更新 → 确认对话框 → download_and_install → relaunch）；② tauri.conf 修正 updater：`createUpdaterArtifacts` 开启、endpoint 走 https 占位；pubkey 未配置时检查更新返回明确错误"更新服务未配置"，**不得**再提示"已是最新"；③ 版本号改 `getVersion()` 动态获取（AboutView 硬编码 '0.1.0' 移除）；④ 托盘"检查更新/设置"菜单由 Rust emit 事件（`tray://check-updates`、`tray://open-settings`），前端 listen 归 B10；托盘"检查更新"菜单的 eval `window.checkForUpdates` 移除。
- **验收**：未配置 pubkey 时点击显示错误提示而非假成功；AboutView 版本号与 tauri.conf 一致。

### A8 [P1][接线] 快捷键冲突回传
- **文件**：`lib.rs`、`ShortcutsSubPage.vue`、`ShortcutsModal.vue`
- **要求**：① `set_global_shortcuts` 逐项返回实际生效键位（注册失败被备选键替代时明确返回 fallback 值与原因）；② 前端保存后展示"实际生效键位"，与用户选择不一致时警告；③ 录制时前端校验三个全局键互不重复。
- **验收**：故意设置已被占用的快捷键，UI 显示实际生效的备选键并说明。

### A9 [P2][修复] autoSync 开关生效 + Rust 安全杂项
- **文件**：`lib.rs`、`GeneralSettings.vue`
- **要求**：① `autoSync=false` 时不启动剪贴板监控且提供启停命令，设置切换实时生效；② `imgview-<ts>` 动态窗口纳入 capabilities；③ `base64::decode` 废弃 API 迁移 Engine API；④ CSP 从 null 配置为基线（决策 D6，需回归文档预览/HTML 预览）。
- **验收**：关闭自动同步后复制内容不再入列表；图片查看器窗口功能正常；HTML/文档预览在 CSP 下渲染正常。

### A10 [P2][清理] Rust 死代码与测试修复
- **文件**：`lib.rs`、`sync_client.rs`、`crypto.rs`、`tests/integration_test.rs`、`Cargo.toml`
- **要求**：① 删除死代码 `sync_client.rs`（若 D1 最终选择"接线加密"则保留 crypto.rs，否则一并删除）；② 删除 5 个从未被调用的命令（tray_show_window/tray_hide_window/tray_quit/start_clipboard_monitor/stop_clipboard_monitor —— 注意 A4/A9 若需要 start/stop 则保留并接线）；③ 清理 Cargo 未用依赖（tokio/env_logger/log 视 A5 落地情况）；④ 修复 `integration_test.rs` 至 `cargo test` 可编译通过（端口/快捷键/缺失字段）。
- **验收**：`cargo check` 零警告级错误；`cargo test` 通过。

---

## 四、流 B：剪贴板主链路与交互（10 张）

### B1 [P1][修复] 图片回写重复上传
- **文件**：`useClipboard.ts`、`clipboardQueue.ts`
- **问题**：copyItem 写回用 Rust fnv64 哈希、兜底轮询去重用 `simpleHash(dataUrl)`，两套哈希族永不相等；`skipNextPolls` 3 秒 < 轮询间隔 10 秒 → 复制图片条目后被重新上传。
- **要求**：① 写回成功后同时登记两族哈希；② skip 窗口 ≥ 轮询间隔 + 余量；③ 图片上传任务入队前与列表现有条目查重（对齐文本路径）。
- **验收**：点击图片条目复制后等待 30 秒无重复条目；快速粘贴面板选择图片同样不重复。

### B2 [P1][修复] 复制后清空剪贴板改为可配置
- **文件**：`usePrivacy.ts`、`PrivacySettings.vue`
- **问题**：`useClipboardActions.ts:54` 每次复制 5 秒后无条件清空剪贴板，无开关，与产品形态冲突。
- **要求**：新增设置项"复制后自动清空剪贴板"（默认**关闭**）；开启时保留现行为；敏感条目的 5 秒清空不受此开关影响（维持隐私保护）。顺带处理 PrivacySettings 内 19 行硬编码中文接入 i18n（key 由本工单新增）。
- **验收**：默认设置下复制→切窗→Ctrl+V 正常粘贴；开启后 5 秒清空生效；敏感条目行为不变。

### B3 [P1][修复] 全局键盘层级栈
- **文件**：`HomeView.vue`、`useClipboardKeyboard.ts`、`ClipboardView.vue`
- **问题**：Ctrl+K 双通道 toggle 互相抵消；Esc 不覆盖 PIN 弹窗反而关掉底层；预览弹窗打开时列表快捷键仍生效；焦点行不 scrollIntoView。
- **要求**：① 移除 Ctrl+K 重复注册链（保留一条路径）；② 建立 Esc/快捷键仲裁顺序：PIN 弹窗 > 预览弹窗 > ModalManager 弹窗 > AI 面板 > 快速粘贴 > 列表；③ 有弹窗打开时冻结列表快捷键；④ focused 行 `scrollIntoView({block:'nearest'})`。
- **验收**：空态提示的 Ctrl+K 实际可用；PIN 弹窗上按 Esc 只关 PIN；预览打开时 Enter 不触发复制；键盘↑↓焦点行始终可见。

### B4 [P1][修复] 列表错误态与重试
- **文件**：`clipboardLoad.ts`、`ClipboardView.vue`、`FavoritesView.vue`
- **问题**：加载失败仅 toast，界面落"暂无内容"空态，失败与真空不可区分，无重试。
- **要求**：加载失败置 error 状态并渲染错误态（图标 + 说明 + 重试按钮）；DevicesView/SharedLinksView 同样处理。
- **验收**：断网打开列表显示错误态而非"暂无内容"，点击重试在恢复网络后成功加载。

### B5 [P1][修复] 离线与删除链路修复
- **文件**：`useClipboard.ts`、`offlineQueue.ts`、`sharedLinks.ts`、`useDevice.ts`
- **要求**：① 批量删除入队结构 `{ids}` 与 flush `payload.id` 对齐（修 `DELETE /api/clipboard/undefined`）；② `deleteSingle` 本地前缀清单补 `file-`/`browser-`；③ `uploadSharedFile` 补 X-CSRF-Token（对齐 client.ts 的 media 上传方案）；④ 设备名映射统一为单一取值函数（`d.name ?? device_name ?? deviceName ?? id`）。
- **验收**：离线删除多条 → 恢复网络 → 服务端确实删除；设备列表不再出现 Unknown Device 或裸 id。

### B6 [P2][修复] 数据一致性杂项
- **文件**：`useClipboard.ts`、`clipboardLoad.ts`、`HomeView.vue`
- **要求**：① `toggleFavorite`/`deleteSingle` 对 `local-` 前缀项走纯本地处理不发请求；② 收藏分支加载不覆盖 `mainTotalItems`；③ `ws.onMessage` 返回的取消函数保存，登出时清理（修 handler 叠加泄漏）；④ `loadMore` 失败不推进页码。
- **验收**：登出重登后一条推送只触发一次刷新；收藏页侧边栏计数正确；loadMore 失败重试拿到同一页数据。

### B7 [P1][决策 D3][修复] 二进制文件跨设备
- **默认方案**：捕获文件时对 ≤5MB 文件读取内容上传（现有文本通道扩展二进制 base64，需与服务端字段约定）；超限或上传失败时条目标注"仅本机可用"，对端点击给出明确提示而非 "Files not found" 报错。
- **文件**：`lib.rs` 读取侧（A 流协助接口）、`clipboardUpload.ts`、`ClipboardTableRow.vue`
- **验收**：跨设备复制 ≤5MB 二进制文件（如 png/zip）对端可还原下载；超限文件显示"仅本机"标识。

### B8 [P2][修复] 死设置消费接线
- **文件**：`HomeView.vue`、`clipboardLoad.ts`、`clipboardUpload.ts`
- **要求**：① `syncInterval` 接入轮询间隔（0=纯事件驱动不停轮）；② `maxHistory` 前端按上限裁剪本地列表；③ `imageCompress` 接入上传压缩（开=压缩质量 0.8；关=仅超尺寸等比缩放）。只消费 `configStore` 现有 ref，不修改该文件。
- **验收**：三个设置修改后行为立即可观察（间隔/列表上限/图片体积）。

### B9 [P2][决策 D2/D4][清理] 死入口诚实化
- **文件**：`QuickPasteStandalone.vue`、`VersionHistoryModal.vue`、`ExportModal.vue`、`HomeView.vue`
- **要求**：① 快速粘贴 footer "↵ 粘贴"改为"↵ 复制"（自动粘贴本期不做）；② 版本历史：先探明服务端版本 API，有则接线（HomeView 补 `versionItemId` 传递），无则移除入口与死弹窗；③ 移除从未触发的 ExportModal 挂载。
- **验收**：全应用无"有 UI 无行为"入口；文案与实际行为一致。

### B10 [P2][接线] 托盘事件接通 + 收藏分页
- **文件**：`HomeView.vue`、`clipboardLoad.ts`、`FavoritesView.vue`
- **要求**：① listen A7 的托盘事件：`tray://open-settings` 打开设置、`tray://check-updates` 触发更新检查；② 收藏页改为分页加载（解除 200 条上限），顺带处理 SharedLinksView 空态 emoji 🔗 换 lucide 图标。
- **验收**：托盘两个菜单项点击生效；收藏超过 200 条可继续滚动加载。

---

## 五、流 C：AI 模块 + i18n + 假实现清理（8 张）

### C1 [P1][修复] AiSummaryFloat 可控化
- **文件**：`AiSummaryFloat.vue`、`GeneralSettings.vue`（开关 UI 由 A 代放？否——放 AIProviderSettings 或 AppearanceSettings，均归 C）
- **问题**：对每一次文本复制无差别自动发起 LLM summarize，无开关/节流/abort，隐私与成本隐患。
- **要求**：① 新增设置"复制后自动 AI 摘要"（**默认关闭**）；② 同内容 10 分钟节流；③ 在途请求 abort 后再发新请求；④ providerId 失效时静默跳过而非报错。
- **验收**：默认设置下复制内容不触发任何 LLM 调用；开启后连续复制同内容仅调用一次。

### C2 [P1][修复] AI i18n 补课与错误通道
- **文件**：`AiToolTimeline.vue`、`AiAskUserCard.vue`、`AiSuggestPopup.vue`、`AiChatPanel.vue`、`AIProviderSettings.vue`、`AiUsageMeter.vue`、`AiNavRail.vue`、`AiInspector.vue`、`AiChatComposer.vue`、`locales/*.json`
- **要求**：① 上述组件模板硬编码中文全部接入 `t()`；② 补 3 个缺失 key：`ai_no_provider_selected`/`ai_streaming_busy`/`ai_approve_failed`；③ 错误条渲染统一过 `t()`（禁止直接渲染原始 error 字符串中的 i18n key）；④ `AiToolTimeline.vue:150` 的 eslint no-useless-assignment 修复；⑤ 移除 `AiMessage.vue:300` 调试 console.log。
- **验收**：切换英文后 Agent 全流程（工具卡/ask_user/确认卡/错误提示/设置页）无中文残留、无裸 key。

### C3 [P2][修复] AI 确认系统收敛
- **文件**：`AiConfirmCard.vue`（删除）、`useAiChatUi.ts`、`AiChatPanel.vue`、`useAiChat.ts`
- **要求**：① 删除孤儿 `AiConfirmCard.vue` 与 `useAiChatUi.ts:122-175` 第二套确认状态机及 `approveAiChatTool` 孤儿函数；② approve 请求失败保留卡片并显示错误（不再无条件收起）；③ 绑定 Esc→deny（AI 面板内层级，不与全局 Esc 冲突，与 B3 仲裁顺序对齐）；④ 切换会话时 `mode.value = conversation.mode` 不再触发全局默认模式持久化（仅用户主动切换时写回）。
- **验收**：断网点批准卡片保留并提示重试；Esc 拒绝当前确认而非关闭面板；打开旧 agent 会话后新建会话默认模式不变。

### C4 [P2][决策 D5][修复] AI 杂项与历史保真
- **文件**：`AiMessageList.vue`、`AiChatPanel.vue`、`AiInspector.vue`、`AiUsageMeter.vue`、`useAiConversations.ts`、`api/ai.ts`
- **要求**：① `AiMessageList :key="i"` 改稳定消息 id；② "刷新模型"在未保存表单时提示先保存，禁止隐式 createProvider 落库；③ 费用单价按 provider 拆分或明确标注"按 OpenAI 基准价估算"；④ Inspector"子代理总览"接线 `agentRuns` 真实数据（D5 默认）或移除占位区块；⑤ 删除死代码 `similarityCheck` API、`AiSuggestPopup` 的 `duplicateEntries` 空计算与 `candidates` prop 链路；⑥ 截图/子代理卡片历史保真（需服务端 `ai_messages` 加列，**跨 src/server，由编排者决定是否本周期实施**，默认后置）。
- **验收**：截断会话后消息组件状态不错位；无"占位"字样；无孤儿 API。

### C5 [P1][修复] 全局 i18n 补课（AI 之外）
- **文件**：`useI18n.ts`、`locales/*.json`、`AuthPage.vue`、`ProtectionDialog.vue`、`ItemPasswordDialog.vue`、`WorkflowRuleSettings.vue`、`FavoriteStarCell.vue`、`QuickPasteStandalone.vue`、`TemplateRow.vue`、`TablePreview.vue`、`TemplateEditorDialog.vue`、`ExportSubPage.vue`、`ThemeSubPage.vue`、`AppearanceSettings.vue`、`doc-preview/*`、`stores/templateStore.ts`、`templateVariableStore.ts`、`useCollections.ts`、`useClipboard.ts`、`useSonner.ts`、`clipboardLoad.ts`、`index.html`
- **要求**：① 首次启动按 `navigator.language` 选语言；登录页加语言切换入口；`setLang` 同步更新 `document.lang`；② 上述文件模板硬编码中文接入 i18n（ProtectionDialog 整体本地字典约 30 条迁移）；③ TS 层约 20 条中文 toast 接入；④ 补 6 个 zh 缺失 key（`sess_current`/`login_quote`/`feat_team`/`feat_api`/`auth_failed_op`/`sp_set_pwd_fail`）与 en 缺失的 `pin_countdown`。
- **验收**：英文环境从登录到设置全流程巡检无中文残留；中文环境无英文混入；首次启动英文系统直接显示英文。

### C6 [P1][修复] 主题与样式健壮性
- **文件**：`styles/globals.css`、`AiAskUserCard.vue`、`AiToolTimeline.vue`、`AiConfirmCard.vue`（若 C3 已删则跳过）、`AiChatPanel.vue`、`AiSummaryFloat.vue`、`stylelint.config.js`
- **要求**：① linear/raycast 补 light 变体（修复明暗切换失效）；② ai/* 卡片裸色值替换为主题 token（`rgba(0,0,0,0.05)`、`#ef4444`、`#f59e0b`、`#8b5cf6`、`#16a34a` 等）；③ `.text-primary` 类名冲突消解（自定义类改名 `.text-strong` 并同步全部使用点）；④ stylelint 范围扩大到全部组件目录并清零告警。
- **验收**：7 主题 × 明暗矩阵巡检无破相（重点：ai 卡片、ask_user 卡）；`npx stylelint` 全量通过。

### C7 [P2][修复] 假实现清理与诚实化（含 D1 默认方案、支付占位）
- **文件**：`ModalManager.vue`、`SubscriptionView.vue`、`PricingPaymentModals.vue`、`PricingSubPage.vue`、`FeedbackModal.vue`、`BillingModal.vue`、`BillingSubPage.vue`
- **要求**：① updates 弹窗硬编码 `v2.4.1` 改 `getVersion()`（A7 先行的单行改动对齐）；② 订阅统计页接真实 API（用量/套餐从 /api/auth/me 与订阅接口取），取不到则显示"—"而非 0/0MB/¥0；③ 假支付改为诚实占位：选渠道后提示"支付渠道接入中，请联系管理员开通"，**移除**"订阅成功"假提示与直接 POST subscribe；④ 取消订阅/发票下载占位统一文案"功能建设中"；⑤ FeedbackModal 与 FeedbackSubPage 统一（弹窗内嵌真实 API 调用或引导至设置页，二选一，禁止两处行为不一致）；⑥ BillingModal `/api/invoices` 与 BillingSubPage `/api/user/invoices` 端点统一；⑦ E2EE 摘牌（D1 默认方案）：移除 ModalManager 的 disabled E2EE 开关；`contentEncrypted` 字段更名 `content` 由 B 代执行（B 不改此弹窗）。
- **验收**：全应用无任何"假成功"提示；所有未接入功能入口均明示"建设中/未配置"；支付流程不再假装成功。

### C8 [P2][修复] 弹窗规范与路由健壮性
- **文件**：`ModalManager.vue`、`ModalDialog.vue`、`AiSuggestPopup.vue`、`AppSidebar.vue`、`router/index.ts`、`globals.css`
- **要求**：① Esc 改栈式关闭（ForgotPassword 与 showModalType 叠开时逐层关闭）；② AiSuggestPopup 支持 Esc/外点关闭；③ AppSidebar 折叠热区/user-chip 补 tabindex/role/Enter 触发；④ 路由补 catch-all 404 与 `/app/:sub` 白名单校验；⑤ z-index 收敛：AiSummaryFloat 9999 降到 toast 层之下，裸值统一到 `--z-*` 变量。
- **验收**：多层弹窗 Esc 逐层关闭；键盘 Tab 可操作侧栏核心功能；访问 `/app/anything` 显示 404 引导而非空白。

---

## 六、决策项（编排者与用户拍板后派发，均已给默认方案）

| ID | 决策 | 默认方案 | 影响工单 |
|---|---|---|---|
| D1 | 加密接线 vs 摘牌 | **摘牌**（移除 E2EE 占位开关、contentEncrypted 更名）；真实加密（含 DPAPI/Keychain 密钥存储）另立专项 | C7、B1 |
| D2 | 自动粘贴（模拟按键） | **本期不做**，文案诚实化 | B9 |
| D3 | 二进制文件跨设备 | **≤5MB 上传内容**，超限标注"仅本机" | B7 |
| D4 | 版本历史 | **先探明服务端 API**：有则接线，无则移除 | B9 |
| D5 | AI Inspector 子代理总览 | **接线 agentRuns** | C4 |
| D6 | CSP 基线 | **配置**，回归文档/HTML 预览 | A9 |
| D7 | 收藏大列表 | **分页**（不做虚拟滚动） | B10 |

---

## 七、Wave 3 汇总阶段（编排者独占）

1. **合并顺序**：A → B → C；冲突按共享文件主责表裁定。
2. **全库格式化**（独立提交）：prettier 配置补 `endOfLine: "lf"`，一次性格式化全库，消除 2.1 万条 CRLF 告警。
3. **全量门禁**：`vue-tsc --noEmit` 零错误；`eslint . --quiet` 零 error；`stylelint` 全量零告警；`cargo check` + `cargo test` 通过；`vite build` 成功。
4. **视觉验收**：按各工单验收清单汇总为完整验收流程（新行为 + 回归：默认主题/交互不破）。
5. **提交规范**：每工单独立提交 `fix(scope): 描述`（涉及类型标 `[fix|feat|chore|refactor]`）；完成后评估合并回 `dev/cnb`。

## 八、进度跟踪

| 工单 | 状态 | 执行者 | 提交 |
|---|---|---|---|
| A1–A10 | ☐ 待派发 | — | — |
| B1–B6 | ☐ 待派发 | — | — |
| B7–B10 | ☐ 待派发（依赖 D3/D4 拍板） | — | — |
| C1–C8 | ☐ 待派发 | — | — |
| Wave 3 | ☐ 待执行 | 编排者 | — |
