# AI RBAC 权限体系后端实现 · 多 Agent 并行工单

> **依据设计**：[ai-rbac-system-design.md](docs/plans/ai-rbac-system-design.md)（v2，修订项 R1-R14）
> **交付形态**：后端实现（权限地基 + 管理工具 + 自动化测试）
> **明确延后（不在本工单）**：前端确认卡片增密码输入、Web 管理后台（含 L2 跨用户协助 REST）、L0 agent_service 角色

---

## 一、任务目标与范围

### Why
超级管理员当前无法通过 AI Agent 完整操作系统级功能（用户管理/系统配置/审计/订阅/跨用户）；且现有工具等级登记存在疏漏（save_memory、ocr_clip_image、read_clip_content 未登记 → 默认 L0 全开放，其中两个是写工具）。本工单按已审核的 v2 方案落地后端权限体系。

### What Changes（交付物清单）
1. **迁移 037**：超管唯一/禁删/禁降约束触发器（PostgreSQL 唯一索引不支持子查询，改用 trigger）
2. **迁移 038**：`system_configs` + `feature_flags` 表与种子数据（**不建 subscriptions 表、不改 audit_logs 列、不建 collections parent_id 列**）
3. **levels 等级修正**：4 个工具补登记 L1、`destroy_clips` 升 L3、4 个创建类工具降 L1
4. **角色等级读库驱动**：`roles.level >=100→L3 / >=50→L2 / 其余 L1`，DB 异常兜底 L1
5. **superAdminAudit 中间件**：超管敏感 REST 强制审计（不与 executeTool 的 logToolAudit 双写）
6. **新增 17 个工具**（见 §三 W2-D）+ 确认门控扩展 + approve 密码二次验证（可选）
7. **vitest 权限矩阵测试**

### 新增工具总表（等级 / 确认门控）

| 分组 | 工具 | 等级 | 需确认 |
|------|------|:---:|:---:|
| 用户管理 | list_users / create_user / disable_user | L3 | — |
| 用户管理 | update_user_role / delete_user / reset_user_password | L3 | ✅ |
| 系统设置 | get_system_config / get_audit_logs | L3 | — |
| 系统设置 | update_system_config / toggle_feature | L3 | ✅ |
| 设备管理 | list_all_devices | L2 | — |
| 设备管理 | unpair_device | L2 | ✅ |
| 订阅管理 | upgrade_subscription | L3 | — |
| 订阅管理 | downgrade_subscription | L3 | ✅ |
| 收藏夹 | create_sub_collection（ltree） | L1 | — |

> 登记规则（新增工具四处登记，漏一处即引入漏洞）：① `aiTools.js` TOOLS ② `executeToolInner` switch ③ `aiSystemPrompt.js` levels ④ `WRITE_TOOL_NAMES`/`READONLY_TOOLS`；需确认的工具追加进 `DESTRUCTIVE_CONFIRM_NEEDED`。

---

## 二、多 Agent 执行编排

按「文件所有权」划分并行波次，避免多 agent 改同一文件产生冲突：

```
Wave 1（3 个 agent 并行，零文件重叠）
  W1-A  数据库迁移（db/migrations/*.sql）
  W1-B  权限核心（utils/aiSystemPrompt.js + middleware/superAdminAudit.js + index.js）
  W1-C  测试骨架（tests/ai-rbac.test.js）
        │
        ▼
Wave 2（2 个 agent 并行，前置 = Wave 1 全部完成）
  W2-D  全部 17 个工具实现（routes/aiTools.js 独占 + aiSystemPrompt.js levels 登记）
  W2-E  确认门控核算 + approve 二次验证（routes/aiChat.js 独占）
        │
        ▼
Wave 3（1 个 agent）
  W3-F  启用全部测试，全量回归修复
```

**冲突纪律**：W2-D 与 W2-E 均需触碰 `DESTRUCTIVE_CONFIRM_NEEDED` 确认集合 —— 集合内容由 **W2-D 最终确定**（W2-E 只改 approve 校验逻辑，不碰集合）；如无法并行则 W2-E 推迟到 W2-D 之后串行执行。

---

## 三、工单明细

### W1-A · 数据库迁移工单

**涉及文件**：`src/server/src/db/migrations/037_super_admin_protection.sql`（新建）、`038_rbac_admin_tables.sql`（新建）

**实施步骤**
1. `037`：`CREATE OR REPLACE FUNCTION protect_super_admin_row()` —
   - 查 `roles` 取 `super_admin` 的 role_id，查不到则 `RETURN COALESCE(NEW, OLD)` 放行；
   - `TG_OP='DELETE'` 且被删行为超管 → `RAISE EXCEPTION 'SUPER_ADMIN_DELETE_FORBIDDEN'`；
   - `INSERT` 新行是超管、或 `UPDATE` 由非超管改为超管时，若已存在超管 → `RAISE EXCEPTION 'SUPER_ADMIN_EXISTS_ALREADY'`；
   - 创建 `BEFORE INSERT OR UPDATE OF role_id OR DELETE ON users` 触发器；
   - 登记 `schema_migrations` 版本 `037`。
2. `038`：`system_configs`（id/config_key UNIQUE/config_value JSONB/description/category/updated_by/updated_at）与 `feature_flags`（id/flag_key UNIQUE/enabled/description/updated_at）；
   - 种子数据：`ai_max_tokens`、`ai_default_provider`（仅默认值语义）、`max_collection_depth=5`、`enable_audit_log`、`session_timeout_minutes=30` + 4 个 feature_flags（全部 `ON CONFLICT DO NOTHING`）；
   - 登记 `schema_migrations` 版本 `038`。

**完成标准**
- 迁移可重复执行不报错；
- 触发器行为验证：插入第二超管 / 删除超管均被 RAISE 拒绝；
- 已确认不动：subscription_plans/user_subscriptions/audit_logs/favorite_collections（无新增列、无新增表）。

---

### W1-B · 权限核心工单（levels + 读库驱动 + 审计中间件）

**涉及文件**：`src/server/src/utils/aiSystemPrompt.js`（改）、`src/server/src/middleware/superAdminAudit.js`（新建）、`src/server/src/index.js`（改）

**实施步骤**
1. **levels 修正**（aiSystemPrompt.js）：
   - L1 追加：`save_memory`、`ocr_clip_image`、`read_clip_content`、`organize_by_type`、`create_collection`、`create_template`、`update_template`、`create_shared_link`；
   - L2 移除 `destroy_clips`；L3 追加 `destroy_clips`（管理工具等级由 W2-D 登记）。
2. **读库驱动**：`ROLE_TO_LEVEL` 由硬编码改为按 roleLevel 数值解析（>=100→L3、>=50→L2、其余 L1），roleLevel 缺失时回退 roleKey 兜底；DB 失败兜底 L1。保持 `getToolLevel`/`isToolAllowedForLevel`/`assertToolAllowed` 三层闸门语义不变。
3. **superAdminAudit 中间件**：`req.user?.roleKey==='super_admin'` 且命中敏感集合（POST/PUT/DELETE/PATCH，或路径含管理段）→ `logAuditEvent` 写 `super_admin_action`；**排除工具入口路径**（/api/ai/chat、/summarize 等）避免与 logToolAudit 双写；失败仅记日志不阻断。
4. **index.js**：在 `/api/ai`（及 conversations/memories/settings）链路的 authenticateToken 之后挂载该中间件。

**完成标准**
- `getToolLevel('save_memory')==='L1'`、`getToolLevel('destroy_clips')==='L3'`、`getToolLevel('create_collection')==='L1'`；
- `assertToolAllowed('user','destroy_clips').allowed===false`、`('super_admin',...)===true`；
- 调整 roles.level 后权限即时变化；roles 查询异常时角色降级 L1 不崩溃；
- super_admin 的普通 REST 写请求产生审计，/api/ai/chat 不产生中间件审计。

---

### W1-C · 测试骨架工单

**涉及文件**：`src/server/tests/ai-rbac.test.js`（新建）

**实施步骤**
1. 用 `test-helpers.js` 构造 user/admin/super_admin 三角色会话与鉴权；
2. 按 checklist（§四）铺用例**骨架**：等级过滤、assertToolAllowed、超管触发器、确认门控、工具 schema 完整性（与 aiTools.js TOOLS 逐一对比 name 集合）；
3. 工具未实现的用例先 `test.skip` 占位，W2 完成后由 W3-F 启用。

**完成标准**
- 测试文件结构完整可运行（`npm test` 不报语法错误）；已生效部分（levels/触发器）用例为绿色；占位用例显式 skip 并注释待启用。

---

### W2-D · 管理工具实现工单（核心）

**涉及文件**：`src/server/src/routes/aiTools.js`（改）、`src/server/src/utils/aiSystemPrompt.js`（仅登记 tools 名）

**实施步骤**（全部工具遵循：成功返回不带 error、失败 `{ error, code }`；参数 trim/限长；参数化 SQL；执行前依赖既有 `assertToolAllowed` 闸门）

1. **用户管理 6 工具**（levels L3 登记）：
   - `list_users`：keyword（phone/email/nickname）模糊 + 分页，返回脱敏列表；
   - `create_user`：**phone 必填**（`isValidPhone` + users.phone_hash 唯一性），email/nickname 可选，password 必填 bcrypt（复用 auth.js 同款哈希）；role ∈ user/admin；
   - `update_user_role`：目标为自身/超管 → 拒绝；仅 user/admin 可设；
   - `delete_user`：目标为自身/超管 → 拒绝；复用会话吊销逻辑（blacklistJti 或 user_sessions.is_active=false）；
   - `reset_user_password`：生成临时随机密码一遍 bcrypt 入库，返回一次并提示登录后修改；
   - `disable_user`：目标为自身/超管 → 拒绝；置 is_active=false + 吊销会话；reason 入 details。
   - 全部写审计（logToolAudit 自动覆盖 + action 语义）。
2. **系统设置 4 工具**（levels L3）：
   - `get_system_config`：category 过滤，允许键白名单读取；
   - `update_system_config`：config_key 白名单 upsert；AI 类 key 仅为默认值，**不**覆盖 per-user ai_providers；
   - `toggle_feature`：flag_key upsert enabled；
   - `get_audit_logs`：参数 `action`/user_id/start_time/end_time/page → 复用 `utils/audit.js getAuditLogs`（**参数名是 action，非 action_type**）。
3. **设备管理 2 工具**（list_all_devices L2 / unpair_device L2）：只读在线状态；unpair 校验存在性；**不带 user_id 参数**（跨用户延后）。
4. **订阅管理 2 工具**（levels L3）：操作 `user_subscriptions`，套餐映射用 `subscription_plans.name`（Free/Pro/Enterprise）；upgrade 更新 current_period_start/end/status；downgrade 遵循现有状态流转规则（复用 subscriptions.js/subscriptionCheck.js 的查询模式），不另起订阅语义。
5. **create_sub_collection**（levels L1）：校验父收藏夹存在且属于当前用户；`path = parent.path + '.col_' + 新id（去-）`；INSERT favorite_collections；**不新建任何列**，写法对照 favorites.js parentId 分支。
6. **登记**：上表全部工具追加进 `levels` 对应等级 + `WRITE_TOOL_NAMES`（写类）+ 需确认工具追加 `DESTRUCTIVE_CONFIRM_NEEDED`: `delete_user/update_user_role/reset_user_password/update_system_config/toggle_feature/unpair_device/downgrade_subscription`（含既有 destroy_clips 及 archive/unarchive 多条确认）。

**完成标准**
- 17 个工具全部可被 super_admin 调用成功且写审计；L1/L2 对 L3 工具收到 ROLE_FORBIDDEN；创建类降级后 L1 可用；
- create_user 重复手机号 → PHONE_EXISTS；删除/降级/禁用超管与自身被拒；禁用用户后 token 失效；
- 订阅升降级后 `get_subscription_details` 反映新套餐；子收藏夹创建后应用内层级可见。

---

### W2-E · 确认门控与 approve 二次验证工单

**涉及文件**：`src/server/src/routes/aiChat.js`（改）

**实施步骤**
1. **核算确认集合**：最终 DESTRUCTIVE_CONFIRM_NEEDED = destroy_clips、delete_user、update_user_role、reset_user_password、update_system_config、toggle_feature、unpair_device、downgrade_subscription（集合定义在 aiTools.js，**由 W2-D 落地**，本工单仅核验覆盖完整并列出清单）；
2. **approve 密码二次验证（可选实现）**：`POST /api/ai/chat/approve` 请求体支持 `{ password }`；在 `approveToolRequest` 校验当前超管密码（复用 auth-password bcrypt 校验），失败返回 `password_verify_failed` 并审计；改造成本 > 风险收益时可在工单内标注「本期不做」并给出理由。

**完成标准**
- 每类确认工具拒绝/超时/断流返回 REJECTED_BY_USER 且不执行；批准后执行并审计；
- 若实现二次验证：错误密码被拒并写 audit，正确密码正常执行。

---

### W3-F · 全量测试与回归工单

**涉及文件**：`src/server/tests/ai-rbac.test.js`、（如需要）既有测试修复

**实施步骤**
1. 启用 W1-C 的全部 skip 用例（工具已实现）；
2. 对照 §四 验收清单逐项补断言（超管触发器、确认门控、17 工具 schema ↔ levels 一一对应）；
3. 跑全量后端测试，修复回归；权限用例全绿。

**完成标准**
- `npm test`（或项目既有测试命令）全绿；无范围外改动；无残留调试代码/临时文件。

---

## 四、验收清单（W3-F 核对）

- [ ] 迁移 037/038 可重复执行；schema_migrations 含 037/038
- [ ] system_configs / feature_flags 存在且种子数据完整
- [ ] 触发器：重复超管 / 删除超管均被拒
- [ ] levels：4 个补登记=L1、destroy_clips=L3、4 个创建类=L1；getToolLevel/assertToolAllowed 正确
- [ ] 角色等级读库驱动生效；DB 异常兜底 L1
- [ ] superAdminAudit 已挂载；不含工具入口的双写
- [ ] 17 个工具按矩阵可用：L3 工具对 L1/L2 返回 ROLE_FORBIDDEN；L1/L2 工具正常
- [ ] create_user phone 必填唯一；用户管理禁操作超管/自身；禁用即吊销会话
- [ ] get_audit_logs 参数为 action 且复用 utils/audit.js
- [ ] 订阅升降级操作 user_subscriptions 且遵循现有流转；L1/L2 被拒
- [ ] create_sub_collection 走 ltree，层级可见，错误处理正确
- [ ] 确认集合覆盖 8 个敏感工具；拒绝/超时/断流 → REJECTED_BY_USER 不执行
- [ ] （可选实现时）approve 密码二次验证错误密码被拒并审计
- [ ] 所有新增/变更工具写审计（操作人/类型/目标/脱敏详情/时间/结果）
- [ ] vitest 权限用例全绿，既有测试无回归
- [ ] 无范围外变更（前端 UI / Web 管理后台 / agent_service 未实现）

---

## 五、协同纪律（每个 agent 提交前自查）

1. **错误协议**：工具失败一律 `{ error, code }` 结构化返回，绝不抛裸异常给上游流。
2. **审计复用**：工具审计走 logToolAudit（自动脱敏）；REST 管理请求走 logAuditEvent；不新增审计实现。
3. **文件边界**：只改本工单「涉及文件」清单内的文件；改共享文件时遵循 §二 编排顺序。
4. **代码风格**：async/await、参数化 SQL、注释用中文、与周边代码风格一致；不引入无关重构。
5. **提交说明**：汇报内容含「改动文件 + 完成标准逐条自检结果 + 可复现的验证方式」；不留调试文件与临时脚本。
6. **不臆造**：所有行为以本工单与 v2 设计文档为准；实现不确定时在汇报中提问，禁止静默自由发挥。