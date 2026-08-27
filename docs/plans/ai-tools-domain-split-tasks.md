# Tasks — aiTools 分域拆分（split-ai-tools-domains / T1~T11）

> 目标：将 4978 行单文件 `src/server/src/routes/aiTools.js` 按 9 个业务域纯重构（纯移动，零逻辑改动）拆分为 `src/server/src/ai/tools/`。
> 导出面完全兼容：`TOOLS`、`WRITE_TOOL_NAMES`、`READONLY_TOOLS`、`WORKER_BLOCKED_TOOLS`、`getWorkerTools`、`DESTRUCTIVE_CONFIRM_NEEDED`、`approveToolRequest`、`runAskUserGate`、`respondAskUserRequest`、`cancelPendingForStream`、`abortPendingConfirm`、`peekPendingConfirmTool`、`cancelPendingForUser`、`executeTool`、default router。
> 约束：`aiChat.js` / `aiOrchestrator.js` / `aiStream.js` 现有 import 路径不变（最终由 `index.js` 聚合导出，或保留薄壳 re-export）。
> 目标目录结构：
> ```
> src/server/src/ai/tools/
> ├── definitions/      # 各域 TOOLS 定义段（每域一个文件）
> ├── handlers/         # 各域 handler 注册表（executeToolInner case 逐字迁移）
> ├── gates/confirmGate.js / askUserGate.js
> ├── execute.js        # 审计包装器（logToolAudit + executeToolInner）
> └── index.js          # 聚合导出（命名导出与原文件完全一致）
> ```

---

## 并行策略

- **T1~T9（并行）**：仅新增独立文件（definitions + handlers），**禁止**修改 `aiTools.js` 与 `executeToolInner`。因未被引用，现有 52 个 AI 测试保持全绿即该工单独立验收基线。
- **T10（可与 T1~T9 并行）**：迁移 confirmGate/askUserGate，在 `routes/aiTools.js` 保留 re-export 行，与域工单改动行不重叠。
- **T11（串行，最后）**：唯一修改者。将 `executeToolInner` 改造为从各域注册表聚合分发、删除已迁出 case 体、更新 `index.js` 与 3 处 import。

### 工具域归属表（9 域 A~I）

| 域 | 名称 | 工具 |
|----|------|------|
| A | collectionsTags（收藏夹/标签） | get_collections, create_collection, create_sub_collection, delete_collection, update_collection, move_collection, reorder_collections, get_collection_items, add_item_to_collection, remove_item_from_collection, update_collection_tags, get_tags, delete_tag, batch_move_to_collection |
| B | clips（剪贴板内容） | search_clips, get_clip_details, get_recent_clips, get_frequent_clips, analyze_clip_usage, get_clipboard_stats, write_clip, update_clip, update_clip_meta, tag_items, archive_items, unarchive_items, batch_favorite, batch_delete, destroy_clips, organize_by_type, read_clip_content, get_clip_meta, get_archived_clips, find_duplicates, ocr_clip_image, mark_sensitive, mark_clip_used |
| C | protectiveMedia（保护/媒体） | set_item_protection, remove_item_protection, get_protection_status, get_protected_clips, upload_image, upload_file |
| D | templates（模板/模板变量） | get_templates, create_template, update_template, delete_template, get_template_variables, upsert_template_variables, delete_template_variable |
| E | sharingDevices（共享链接/设备/会话） | create_shared_link, get_shared_links, delete_shared_link, show_diff_preview, get_devices, list_all_devices, unpair_device, update_device, unpair_own_device, list_my_sessions, terminate_session |
| F | notificationsWorkflow（通知/工作流/版本） | get_notifications, get_notification_preferences, update_notification_preferences, mark_notification_read, get_workflow_rules, create_workflow_rule, update_workflow_rule, delete_workflow_rule, get_version_history, restore_version |
| G | accountSubscription（账号/订阅/记忆/调查） | get_profile, update_profile, get_subscription_details, get_subscription_plans, upgrade_subscription, downgrade_subscription, cancel_subscription, resume_subscription, get_memories, save_memory, submit_survey |
| H | adminRbac（用户/系统/审计） | list_users, create_user, update_user_role, delete_user, reset_user_password, disable_user, get_system_config, update_system_config, toggle_feature, get_audit_logs, get_security_overview |
| I | operationsKnowledge（运维/知识/导出共享工具） | export_data, get_ai_context, get_slow_queries, explain_feature, explain_privacy_model, explain_deployment, get_project_architecture |

> 注：`ask_user` 为问答门控工具，随 T10 的 `askUserGate.js` 一并迁移；`get_security_overview` 归 H 域；工具归属以本表为准，TOOLS 数组顺序保持不变。

---

- [ ] Task T1: 域 A（collectionsTags）definitions + handlers 落地
  - [ ] 1.1 新增 `src/server/src/ai/tools/definitions/collectionsTagsDef.js`，将 `aiTools.js` TOOLS 数组中域 A 14 个工具定义条目**逐字**迁入
  - [ ] 1.2 新增 `src/server/src/ai/tools/handlers/collectionsTagsHandler.js`，将 `executeToolInner` 中域 A 各 case 实现体**逐字**迁入（含辅助函数按需同行迁移）
  - 涉及：`aiTools.js`（只读，不改）、新增 2 文件
  - 验收：4 个 AI 测试文件（orchestration / agent-ops / rbac / gates）全绿；git diff 校验域 A case 实现行零逻辑变化

- [ ] Task T2: 域 B（clips）definitions + handlers 落地
  - [ ] 2.1 新增 `definitions/clipsDef.js`，迁入域 B 23 个工具定义条目（逐字）
  - [ ] 2.2 新增 `handlers/clipsHandler.js`，迁入域 B 各 case 实现体（逐字）
  - 涉及：`aiTools.js`（只读）、新增 2 文件
  - 验收：4 个 AI 测试全绿；git diff 校验零逻辑变化

- [ ] Task T3: 域 C（protectiveMedia）definitions + handlers 落地
  - [ ] 3.1 新增 `definitions/protectiveMediaDef.js`（6 工具，逐字）
  - [ ] 3.2 新增 `handlers/protectiveMediaHandler.js`（case 逐字）
  - 验收：4 个 AI 测试全绿；git diff 校验零逻辑变化

- [ ] Task T4: 域 D（templates）definitions + handlers 落地
  - [ ] 4.1 新增 `definitions/templatesDef.js`（7 工具，逐字）
  - [ ] 4.2 新增 `handlers/templatesHandler.js`（case 逐字）
  - 验收：4 个 AI 测试全绿；git diff 校验零逻辑变化

- [ ] Task T5: 域 E（sharingDevices）definitions + handlers 落地
  - [ ] 5.1 新增 `definitions/sharingDevicesDef.js`（11 工具，逐字）
  - [ ] 5.2 新增 `handlers/sharingDevicesHandler.js`（case 逐字）
  - 验收：4 个 AI 测试全绿；git diff 校验零逻辑变化

- [ ] Task T6: 域 F（notificationsWorkflow）definitions + handlers 落地
  - [ ] 6.1 新增 `definitions/notificationsWorkflowDef.js`（10 工具，逐字）
  - [ ] 6.2 新增 `handlers/notificationsWorkflowHandler.js`（case 逐字）
  - 验收：4 个 AI 测试全绿；git diff 校验零逻辑变化

- [ ] Task T7: 域 G（accountSubscription）definitions + handlers 落地
  - [ ] 7.1 新增 `definitions/accountSubscriptionDef.js`（11 工具，逐字）
  - [ ] 7.2 新增 `handlers/accountSubscriptionHandler.js`（case 逐字）
  - 验收：4 个 AI 测试全绿；git diff 校验零逻辑变化

- [ ] Task T8: 域 H（adminRbac）definitions + handlers 落地
  - [ ] 8.1 新增 `definitions/adminRbacDef.js`（11 工具，逐字）
  - [ ] 8.2 新增 `handlers/adminRbacHandler.js`（case 逐字）
  - 验收：4 个 AI 测试全绿；git diff 校验零逻辑变化

- [ ] Task T9: 域 I（operationsKnowledge）definitions + handlers 落地
  - [ ] 9.1 新增 `definitions/operationsKnowledgeDef.js`（7 工具，逐字）
  - [ ] 9.2 新增 `handlers/operationsKnowledgeHandler.js`（case 逐字）
  - 验收：4 个 AI 测试全绿；git diff 校验零逻辑变化

- [ ] Task T10: 门控迁移（confirmGate + askUserGate）
  - [ ] 10.1 新增 `gates/confirmGate.js`：迁移 `DESTRUCTIVE_CONFIRM_NEEDED`、`approveToolRequest`、`cancelPendingForStream`、`abortPendingConfirm`、`peekPendingConfirmTool`（逐字）
  - [ ] 10.2 新增 `gates/askUserGate.js`：迁移 `runAskUserGate`、`respondAskUserRequest`、`cancelPendingForUser`、`ask_user` 工具定义（逐字）
  - [ ] 10.3 在 `routes/aiTools.js` 保留以上符号 re-export 行（不与其他工单改动行重叠）
  - 验收：gates 测试全绿；`ask_user` 交互流程端到端可用

- [ ] Task T11: 集成改造（串行，唯一修改者）
  - [ ] 11.1 将 `executeToolInner` 改造为从 9 个域 handler 注册表聚合分发；删除已迁出 case 体
  - [ ] 11.2 新增 `src/server/src/ai/tools/execute.js`：审计包装器（logToolAudit + executeToolInner）逐字迁移
  - [ ] 11.3 新增 `src/server/src/ai/tools/index.js`：聚合 9 域 definitions/handlers + gates + execute，命名导出与原文件完全一致
  - [ ] 11.4 更新 `aiChat.js` / `aiOrchestrator.js` / `aiStream.js` 共 3 处 import 指向 `../ai/tools/index.js`（或保留薄壳 re-export 则不动 import）
  - [ ] 11.5 `routes/aiTools.js` 降为 re-export 薄壳（最终可删除，需确认无其他引用）
  - 涉及：`aiTools.js`（改造）、`aiChat.js`/`aiOrchestrator.js`/`aiStream.js`（import 或不动）、新增 `execute.js`/`index.js`
  - 依赖：T1~T10 全部完成
  - 验收：4 个 AI 测试全绿；端到端调用一次删除收藏夹 + 一次创建子收藏夹，行为与拆分前一致；`git diff` 业务实现行零内容变化（仅文件增删、import 路径、分发方式）