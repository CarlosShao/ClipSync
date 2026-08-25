# ClipSync 权限等级体系设计方案（修订版 v2）

> **日期**：2026-08-25（v1）→ 2026-08-25（v2 修订）
> **状态**：已按代码实际现状审核修订，待确认后按 P0 → P1 实现
> **目标**：设计四级权限体系，实现超级管理员对产品所有功能的完全控制，确保权限唯一且不可暴露

---

## 修订记录（v2）

| 修订点 | v1 原文 | v2 修正 | 原因 |
|--------|---------|---------|------|
| R1 | 超管唯一索引用部分唯一索引 + 子查询 | 改为**约束触发器**（详见 §3.1） | PostgreSQL 部分唯一索引的 WHERE 子句**禁止子查询**，原 SQL 直接报错 |
| R2 | audit_logs 新增 user_id/action_type/target_user_id 列 | **不新增列**，复用现有 `action`/`details`，目标用户进 details JSONB（详见 §6.1） | audit_logs 已于迁移 008 建好（user_id/action/resource_type/resource_id/details/status/error_message），`getAuditLogs` 过滤参数名为 `action` |
| R3 | 新建 `subscriptions` 表 | **不建表**，复用现有 `subscription_plans + user_subscriptions + payment_orders + invoices` 体系（详见 §6.1） | 订阅体系已于 004/010/011/011a/012 迁移建好，被 subscriptionCheck.js 消费；新建同名表会双轨割裂 |
| R4 | `ALTER TABLE collections ADD COLUMN parent_id` | **不加列**，复用现有 `favorite_collections.path`(ltree) 层级（详见 §5.6） | 收藏夹已有 ltree 层级（迁移 005），favorites.js 已支持 parentId 创建子收藏夹；表名正确写法是 `favorite_collections` |
| R5 | create_user 参数 email 必填 | 改为 **phone 必填、email 可选**（详见 §5.1） | 系统以手机号为核心注册链路（send-code/verify-code/register），用户表核心标识是 phone |
| R6 | change_password / enable_2fa / disable_2fa 作为 AI 工具 | **从 AI 工具方案中移除**，改走既有 REST（auth-password.js / two-factor.js）（详见 §5.3） | 2FA 是 UI 密集型流程（TOTP 二维码/验证码轮询/恢复码），让 LLM 直接操作凭据为高危面 |
| R7 | L2 admin 矩阵大量标记 `any`（跨用户读/写） | **v1 全部收敛为 own**（详见 §4.1） | 现有执行体全部 `WHERE user_id=$1` 硬隔离，无 cross_user 支撑机制；跨用户协助能力留待 Web 管理后台以常规 REST 实现 |
| R8 | destroy_clips 保持 L2 | **升级为 L3**（仅超管可物理删除，详见 §10.1） | 与"L2 禁止物理删除数据"的权限边界一致 |
| R9 | create_collection/create_template/update_template/create_shared_link 为 L2 | **降级为 L1**（普通用户可创建，详见 §10.1） | 属于用户自己的数据管理，L1 合理 |
| R10 | L0 agent_service 定义为内部角色 | **本期不实现，矩阵预留**（详见 §2.1） | 当前无 Agent 服务认证通道、roles 表无对应行、无内部任务调度场景；避免空头设计 |
| R11 | （缺失）未登记工具的默认等级规则 | 明确写入**「工具登记清单 + 默认等级规则」**（详见 §4.3） | 现状 read_clip_content/save_memory/ocr_clip_image 未登记等级 → 默认 L0 全开放，其中两个是写工具，属登记疏漏 |
| R12 | （缺失）新增工具落地四步登记 | 明确 TOOLS / switch / levels / WRITE_TOOL_NAMES / DESTRUCTIVE_CONFIRM_NEEDED 四处登记约束（详见 §4.3） | 漏登记会引入默认开放漏洞或子代理并发写竞争 |
| R13 | 等级数字双体系（roles.level=10/50/100 vs L0-L4） | 统一以 **roles.level 为唯一驱动源**，代码映射改为读库（详见 §2.3） | 改角色等级免发版，供日后 Web 管理后台调整 |
| R14 | （缺失）系统配置与用户 AI 提供商的关系 | 全局配置仅作默认值/开关，**优先级低于 per-user ai_providers**（详见 §5.2） | ai_providers 是用户私有表；全局 `ai_default_provider` 不得覆盖用户私有配置 |

---

## 一、现状分析（已与代码核实）

### 1.1 当前数据库角色

```sql
-- roles 表（migration 028）
super_admin  -- 超级管理员 (level=100)
admin        -- 管理员     (level=50)
user         -- 普通用户   (level=10)
```

### 1.2 当前 AI 工具权限等级（实际实现）

```
L0 只读       — 全开放（未登记工具的默认等级）
L1 操作级     — write_clip, tag_items, archive_items...
L2 管理级     — create_collection, destroy_clips...
L3 超管级     — get_security_overview, explain_deployment...
L4 Agent 专用 — 未使用
```

> **v2 核实发现**：`save_memory`、`ocr_clip_image` 属于写入类（已在 WRITE_TOOL_NAMES），但未登记进 levels，实际按默认 L0 全开放；`read_clip_content`（读明文）同样默认 L0。v1 文档未体现此现状，需在实现时一并修正（见 R11）。

### 1.3 当前权限映射

```
user        → L1（roles.level=10）
admin       → L2（roles.level=50）
super_admin → L3（roles.level=100）
```

### 1.4 当前已确认的基础设施（v2 新增对照）

| 能力 | 现状 | 位置 |
|------|------|------|
| 收藏夹子层级 | 已有 ltree `path` 列 + `parentId` 创建接口 | 迁移 005；favorites.js |
| 订阅体系 | subscription_plans + user_subscriptions + payment_orders + invoices | 迁移 004/010/011/011a/012；subscriptions.js |
| 审计日志 | audit_logs 表 + logAuditEvent + logToolAudit + getAuditLogs | 迁移 008；utils/audit.js |
| 2FA | /2fa/status、/setup、/enable、/disable、/verify-login | two-factor.js |
| 改密码 | auth-password.js 已有 REST | auth-password.js |
| 角色注入 | authenticateToken 查库注入 roleKey/roleLevel | middleware/auth.js |

### 1.5 当前可用 AI 工具清单（实际 33 个，见 aiTools.js TOOLS）

| 分类 | 工具名 | 实际等级 |
|------|--------|---------|
| **只读查询** | get_clipboard_stats, get_ai_context, search_clips, get_clip_details, ocr_clip_image*, get_recent_clips, analyze_clip_usage, get_collections, get_tags, get_devices, get_templates, get_shared_links, get_memories, get_subscription_details, get_notifications, get_archived_clips, get_clip_meta, get_template_variables | L0（默认） |
| **写入操作** | write_clip, tag_items, archive_items, unarchive_items, update_clip_meta, batch_favorite, batch_delete, save_memory*, organize_by_type* | L1（save_memory/organize_by_type 实际 L0） |
| **管理创建** | create_collection, create_template, update_template, create_shared_link | L2 |
| **敏感读** | get_protected_clips, read_clip_content*, get_security_overview | L3（read_clip_content 实际 L0） |
| **破坏性** | destroy_clips | L2 |
| **知识讲解** | explain_feature, explain_privacy_model, explain_deployment, get_project_architecture | L0 / L3 |
| **AI 增强** | save_memory（写）、ocr_clip_image（写回） | 实际 L0（需修正） |

> `*` 标注的为 v2 审核发现的「等级登记缺失」项（默认落入 L0，见修订 R11）。

### 1.6 缺失能力

1. **用户管理**：创建/删除/禁用用户、修改用户角色、重置密码
2. **系统设置**：全局配置、功能开关（system_configs / feature_flags 表尚未存在）
3. **账号操作**：登录/注册/修改密码/2FA —— 修改密码与 2FA 已有 REST，**不做 AI 工具**（R6）
4. **设备管理**：管理员跨用户查看/解绑设备
5. **订阅管理**：管理员代为升级/降级套餐
6. **审计日志查看**：AI 侧查询 audit_logs
7. **子收藏夹**：AI 直接创建子收藏夹（复用 ltree，不新建列）

---

## 二、目标权限体系（四级）

### 2.1 等级定义

| 等级 | 角色名 | 代号 | 能力范围 |
|------|--------|------|----------|
| **L1** | 普通用户 | `user` | 管理自己的剪贴板/收藏夹/设备/模板/订阅 |
| **L2** | 管理员 | `admin` | L1 + 平台协助查看（设备在线状态等），但**不能**触碰敏感操作、**不能**跨用户读写数据 |
| **L3** | 超级管理员 | `super_admin` | L2 + **全系统管理**（用户/权限/配置/审计/跨用户） |
| **L0** | Agent 服务 | `agent_service` | **v2：预留，本期不实现**。无认证通道/无角色行/无调度场景，避免空头设计 |

> **v2 数据范围原则（R7）**：L1/L2 全部仅 `own`（所有执行体保持 `WHERE user_id=$1` 硬隔离，**不做任何 cross_user 改造**）。跨用户能力仅 L3，通过显式 `user_id` 参数 + 服务端校验 + 审计实现。L2 的"协助管理所有用户"能力（查全用户统计、解绑任意设备等）延后到 Web 管理后台以常规 REST 提供。

### 2.2 每级权限详情

#### 🔵 L1 普通用户（现有用户默认）

```
✅ 可做：
  - 读写自己的剪贴板内容
  - 管理自己的收藏夹（含子收藏夹）/标签/模板
  - 归档/取消归档自己的条目
  - 创建共享链接
  - 查看自己的订阅/设备/通知
  - 使用 AI 助手（基础功能）
  - 修改自己的密码（走既有 REST，不经 AI）

❌ 禁止：
  - 访问他人数据
  - 创建/删除用户、修改角色
  - 修改系统配置
  - 物理删除数据（destroy_clips）
  - 查看安全/部署/源码等内部信息
```

#### 🟡 L2 管理员（受信任协作者）

```
✅ 继承 L1 全部能力 +：
  - 查看所有设备的在线状态（list_all_devices，只读）
  - 解绑设备（unpair_device，需确认门控）
  - 使用全部 L1 工具管理自己的数据

❌ 禁止（v2 收敛，R7）：
  - 跨用户读取/写入任何用户数据（矩阵中不再有 any 能力）
  - 物理删除数据（destroy_clips 已升 L3）
  - 创建/删除用户、修改角色、重置密码
  - 查看安全/部署/架构详情、修改 AI 提供方配置
```

#### 🔴 L3 超级管理员（**唯一**，产品所有者）

```
✅ 继承 L2 全部能力 +：
  - 用户管理：创建/删除/禁用用户、修改角色、重置密码
  - 物理删除：destroy_clips（任意数据，需确认门控）
  - 系统配置：get/update_system_config、toggle_feature
  - 审计日志：get_audit_logs
  - 跨用户：显式 user_id 参数 + 服务端校验 + 审计
  - 订阅管理：upgrade/downgrade_subscription（操作 user_subscriptions）

🔒 特殊保护：
  - 超管账号**不可删除**、**不可降级**（DB 触发器 + 应用层双重保障，见 §3）
  - 超管账号**密码修改需二次验证**（既有 REST 已含）
  - 超管操作**强制审计**（写入 audit_logs）
```

#### ⚫ L0 Agent 服务（预留）

```
v2 决议：本期不实现。保留等级定义，矩阵统一标记「预留」。
待出现内部自动化任务（定时整理/备份）时，再补 agent_service 角色行、
系统级认证通道与 tools 登记，再进入迭代。
```

### 2.3 等级驱动源（R13）

- `roles.level` 为**唯一权限驱动源**：`level>=100 → L3`、`level>=50 → L2`、其余 `L1`。
- aiSystemPrompt.js 的 `ROLE_TO_LEVEL` 由硬编码映射改为**读库驱动**（启动时或校验时查询 roles 表），日后 Web 管理系统调整等级值即全局生效，无需发版。
- 保留代码内映射作为兜底（DB 查询失败时降级 L1，最小权限）。

---

## 三、超管唯一保障机制

### 3.1 数据库约束（R1 修正版：约束触发器）

> PostgreSQL 部分唯一索引的 WHERE 子句**不支持子查询**，v1 的 `CREATE UNIQUE INDEX ... WHERE role_id = (SELECT ...)` 会直接报错。改为约束触发器，同时承担「唯一性 + 禁删超管」两项保护：

```sql
-- 037_super_admin_protection.sql（放入 src/server/src/db/migrations/）
CREATE OR REPLACE FUNCTION protect_super_admin_row()
RETURNS trigger AS $$
DECLARE
  v_super_role UUID;
  v_count      INT;
BEGIN
  SELECT id INTO v_super_role FROM roles WHERE role_key = 'super_admin';
  IF v_super_role IS NULL THEN
    RETURN COALESCE(NEW, OLD);  -- roles 未初始化时放行
  END IF;

  -- ① 禁止物理删除超管行
  IF TG_OP = 'DELETE' THEN
    IF OLD.role_id = v_super_role THEN
      RAISE EXCEPTION 'SUPER_ADMIN_DELETE_FORBIDDEN';
    END IF;
    RETURN OLD;
  END IF;

  -- ② 禁止出现第二个超管（INSERT 新超管 / 普通用户被升级为超管）
  IF (TG_OP = 'INSERT' AND NEW.role_id = v_super_role)
     OR (TG_OP = 'UPDATE' AND NEW.role_id = v_super_role AND OLD.role_id IS DISTINCT FROM v_super_role)
  THEN
    SELECT COUNT(*) INTO v_count FROM users WHERE role_id = v_super_role;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'SUPER_ADMIN_EXISTS_ALREADY';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_super_admin
BEFORE INSERT OR UPDATE OF role_id OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION protect_super_admin_row();
```

> **服务端注意**：触发器 RAISE 的异常以 PG 错误形式抛出（sqlstate P0001），AI 工具执行体须捕获后转为结构化错误返回（`{ error:'SUPER_ADMIN_DELETE_FORBIDDEN' }`），并记录审计。

### 3.2 后端审计中间件（对齐现有挂载方式）

> v1 伪代码为 Express 全局限定 app.use，本项目路由以「Router 挂子路径」方式挂载（见 index.js：`app.use('/api/ai', authenticateToken, apiLimiter, csrfProtection, ...)`）。落地时在 **功能路由内** 处理：

```javascript
// 新增 middleware：超管敏感操作强制审计（挂到 /api/ai 链路上）
export async function superAdminAudit(req, res, next) {
  if (req.user?.roleKey === 'super_admin' && isSensitiveRequest(req)) {
    // 记录到 audit_logs（复用 logAuditEvent / logToolAudit）
    // 含：操作人 ID、操作类型、目标、脱敏详情、时间、结果
  }
  next();
}
```

### 3.3 关键操作二次验证（v2 补充实现路径）

> 现有确认协议为 `executeTool → DESTRUCTIVE_CONFIRM_NEEDED → confirm_tool_action(SSE) → POST /api/ai/chat/approve`（见 aiTools.js / aiChat.js）。管理工具确认**复用该协议**；密码二次验证作为验证增强：

- 需要二次验证的敏感操作（v1 §8.3 清单）追加进 `DESTRUCTIVE_CONFIRM_NEEDED`，走既有确认卡片；
- **v2 增强（可选）**：approve 请求体增加 `{ password }`，后端比对当前超管密码（复用 auth-password 校验逻辑），错误则拒绝执行并审计 `password_verify_failed`；
- 校验逻辑集中在 `approveToolRequest` 入口，不散落在各工具 case。

### 3.4 超管账号保护（应用层兜底，保留 v1）

```javascript
// 禁止删除超管（DB 触发器为第一层，此处为应用层第二层）
async function deleteUser(userId, currentUser) {
  const targetUser = await getUserById(userId);
  if (targetUser.role === 'super_admin') throw new Error('SUPER_ADMIN_DELETE_FORBIDDEN');
  // ...
}

// 禁止降级超管
async function updateUserRole(userId, newRole, currentUser) {
  const targetUser = await getUserById(userId);
  if (targetUser.role === 'super_admin' && newRole !== 'super_admin') {
    throw new Error('SUPER_ADMIN_DEMOTE_FORBIDDEN');
  }
  // ...
}
```

---

## 四、AI 工具权限矩阵（v2 修订）

### 4.1 数据范围实现原则（R7）

```
v1（原矩阵）   →  v2（收敛后）
own            →  自己数据。唯一实现形态：全部执行体保持 user_id 硬隔离
any            →  仅 L3 可用（显式 user_id 参数 + 服务端校验 + logToolAudit 审计）
L2 不再拥有 any 能力（跨用户协助留待 Web 管理后台）
```

### 4.2 工具权限矩阵（v2）

| 工具名 | L1 user | L2 admin | L3 super_admin | 说明 |
|--------|:-------:|:--------:|:--------------:|------|
| **只读查询（own）** | | | | |
| get_clipboard_stats | ✅ | ✅ | ✅ | 仅返回自己数据的统计 |
| get_ai_context | ✅ | ✅ | ✅ | 同上 |
| search_clips | ✅ | ✅ | ✅ | 同上 |
| get_clip_details | ✅ | ✅ | ✅ | 同上 |
| get_recent_clips | ✅ | ✅ | ✅ | 同上 |
| analyze_clip_usage | ✅ | ✅ | ✅ | 同上 |
| get_collections | ✅ | ✅ | ✅ | 同上 |
| get_tags | ✅ | ✅ | ✅ | 同上 |
| get_devices | ✅ | ✅ | ✅ | 同上 |
| get_templates | ✅ | ✅ | ✅ | 同上 |
| get_shared_links | ✅ | ✅ | ✅ | 同上 |
| get_memories | ✅ | ✅ | ✅ | 同上 |
| get_subscription_details | ✅ | ✅ | ✅ | 同上 |
| get_notifications | ✅ | ✅ | ✅ | 同上 |
| get_archived_clips | ✅ | ✅ | ✅ | 同上 |
| get_clip_meta | ✅ | ✅ | ✅ | 同上 |
| get_template_variables | ✅ | ✅ | ✅ | 同上 |
| explain_feature | ✅ | ✅ | ✅ | 公开知识 |
| explain_privacy_model | ✅ | ✅ | ✅ | 公开知识 |
| **敏感读（own）** | | | | |
| get_security_overview | ❌ | ❌ | ✅ | 安全信息仅 L3 |
| get_protected_clips | ❌ | ❌ | ✅ | 受保护条目清单仅 L3 |
| explain_deployment | ❌ | ❌ | ✅ | 部署/架构仅 L3 |
| get_project_architecture | ❌ | ❌ | ✅ | 源码/架构仅 L3 |
| read_clip_content | ✅ | ✅ | ✅ | **补登记 L1**（原默认 L0，v2 修正 R11）；高级密码保护条目硬性拒绝返回明文 |
| **写入操作（own）** | | | | |
| write_clip | ✅ | ✅ | ✅ | |
| tag_items | ✅ | ✅ | ✅ | |
| archive_items | ✅ | ✅ | ✅ | 多条目需确认门控（既有） |
| unarchive_items | ✅ | ✅ | ✅ | 多条目需确认门控（既有） |
| update_clip_meta | ✅ | ✅ | ✅ | |
| batch_favorite | ✅ | ✅ | ✅ | |
| batch_delete | ✅ | ✅ | ✅ | 软删除语义 |
| save_memory | ✅ | ✅ | ✅ | **补登记 L1**（原默认 L0，v2 修正 R11） |
| ocr_clip_image | ✅ | ✅ | ✅ | **补登记 L1**（原默认 L0，v2 修正 R11） |
| organize_by_type | ✅ | ✅ | ✅ | **补登记 L1**（只读分析，明确登记避免语义含糊） |
| create_collection | ✅ | ✅ | ✅ | **降级 L1**（v2 R9） |
| create_sub_collection | ✅ | ✅ | ✅ | 新增，ltree 实现（v2 R4） |
| create_template | ✅ | ✅ | ✅ | **降级 L1**（v2 R9） |
| update_template | ✅ | ✅ | ✅ | **降级 L1**（v2 R9） |
| create_shared_link | ✅ | ✅ | ✅ | **降级 L1**（v2 R9） |
| **破坏性（L3 专属）** | | | | |
| destroy_clips | ❌ | ❌ | ✅ | **升级 L3**（v2 R8）；确认门控 + 单次 ≤50 |
| **用户管理（L3 专属，新增）** | | | | |
| list_users | ❌ | ❌ | ✅ | |
| create_user | ❌ | ❌ | ✅ | phone 必填（R5） |
| delete_user | ❌ | ❌ | ✅ | 确认门控 + 禁删超管/自身 |
| update_user_role | ❌ | ❌ | ✅ | 确认门控 + 禁降超管 |
| reset_user_password | ❌ | ❌ | ✅ | 确认门控；生成临时密码并提示可在登录后修改 |
| disable_user | ❌ | ❌ | ✅ | 禁禁用自身/超管 |
| **系统设置（L3 专属，新增）** | | | | |
| get_system_config | ❌ | ❌ | ✅ | |
| update_system_config | ❌ | ❌ | ✅ | 确认门控；AI 提供方配置仅作默认值/开关，不覆盖 per-user ai_providers（R14） |
| toggle_feature | ❌ | ❌ | ✅ | 确认门控 |
| get_audit_logs | ❌ | ❌ | ✅ | 复用 utils/audit.js getAuditLogs（参数 `action` 而非 action_type，R2） |
| **设备管理（L2+，新增）** | | | | |
| list_all_devices | ❌ | ✅ | ✅ | 只读在线状态 |
| unpair_device | ❌ | ✅ | ✅ | 确认门控 |
| **订阅管理（L3 专属，新增）** | | | | |
| upgrade_subscription | ❌ | ❌ | ✅ | 操作 user_subscriptions（R3） |
| downgrade_subscription | ❌ | ❌ | ✅ | 确认门控；处理 current_period_end/status 流转（缺口 5） |
| **账号操作（R6：不做 AI 工具）** | | | | |
| change_password / enable_2fa / disable_2fa | — | — | — | v2 移除；改走既有 REST（auth-password.js / two-factor.js） |

### 4.3 工具登记清单与默认等级规则（R11/R12）

```
规则一（默认等级）：
  未登记进 levels 的工具默认按最低等级开放。只读工具可依赖默认开放（执行体含 user_id 硬隔离，无越权面）；
  写入/破坏性/管理类工具【禁止】依赖默认开放，必须显式登记等级。

规则二（新增工具四处登记，漏一处即引入漏洞或漂移）：
  ① TOOLS 数组（routes/aiTools.js）            —— schema 定义
  ② executeToolInner switch（routes/aiTools.js）—— 执行体
  ③ levels 分级（utils/aiSystemPrompt.js）      —— 权限等级
  ④ WRITE_TOOL_NAMES / READONLY_TOOLS          —— 子代理只读隔离（写工具漏登记会被并发子代理误调用）
  需确认门控的工具：追加进 DESTRUCTIVE_CONFIRM_NEEDED（aiTools.js）

规则三（v2 已知需修正的登记项）：
  save_memory / ocr_clip_image / read_clip_content / organize_by_type → 登记 L1
  destroy_clips                        → 由 L2 升至 L3
  create_collection / create_template / update_template / create_shared_link → 由 L2 降至 L1
  change_password / enable_2fa / disable_2fa → 不登记（走 REST）
```

### 4.4 三层安全闸门（现有实现，保持不变）

```
1) buildRoleSystemPrompt —— 后端覆盖前端 system 提示词（按角色）
2) getToolsForRole        —— 下发给 LLM 的工具按等级过滤
3) assertToolAllowed      —— 敏感工具执行前硬性校验（executeToolInner 顶部）
新增工具只要正确登记 levels，三层闸门零改动即可生效。
```

---

## 五、新增 AI 工具详细设计（v2）

> 所有工具遵循 §4.3 登记规则；`level` 字段在实现中体现为 levels 分级；`requires_confirmation` 映射到 DESTRUCTIVE_CONFIRM_NEEDED（§3.3）。

### 5.1 用户管理工具（L3 专属）

#### list_users — 列出所有用户
```json
{
  "name": "list_users",
  "description": "列出系统中所有用户（仅超级管理员可用）",
  "level": "L3",
  "parameters": {
    "keyword": { "type": "string", "description": "搜索关键词（用户名/邮箱/手机号）", "required": false },
    "page": { "type": "integer", "description": "页码", "required": false },
    "page_size": { "type": "integer", "description": "每页数量", "required": false }
  }
}
```

#### create_user — 创建新用户（R5：phone 必填）
```json
{
  "name": "create_user",
  "description": "创建新用户账号（仅超级管理员可用）。手机号必填，邮箱可选",
  "level": "L3",
  "parameters": {
    "phone": { "type": "string", "description": "手机号（唯一，格式校验同注册链路）", "required": true },
    "email": { "type": "string", "description": "邮箱（可选）", "required": false },
    "nickname": { "type": "string", "description": "昵称", "required": false },
    "password": { "type": "string", "description": "初始密码（bcrypt 哈希入库）", "required": true },
    "role": { "type": "string", "enum": ["user", "admin"], "description": "角色，默认 user", "required": false }
  }
}
```

#### delete_user / update_user_role / reset_user_password / disable_user
```json
{
  "name": "delete_user",
  "description": "永久删除用户账号（仅超级管理员可用，不可删除自身与超管）",
  "level": "L3", "requires_confirmation": true,
  "parameters": { "user_id": { "type": "string", "required": true } }
}
{
  "name": "update_user_role",
  "description": "修改用户角色（仅超级管理员可用，不可修改自身角色、不可降级超管，promote 为 super_admin 时校验唯一性）",
  "level": "L3", "requires_confirmation": true,
  "parameters": {
    "user_id": { "type": "string", "required": true },
    "role": { "type": "string", "enum": ["user", "admin"], "description": "新角色", "required": true }
  }
}
{
  "name": "reset_user_password",
  "description": "重置用户密码为临时随机密码（仅超级管理员可用，返回临时密码一次，提示用户登录后修改）",
  "level": "L3", "requires_confirmation": true,
  "parameters": { "user_id": { "type": "string", "required": true } }
}
{
  "name": "disable_user",
  "description": "禁用用户账号（仅超级管理员可用，不可禁用自身与超管）",
  "level": "L3",
  "parameters": {
    "user_id": { "type": "string", "required": true },
    "reason": { "type": "string", "description": "禁用原因", "required": false }
  }
}
```

> **实现要点**：全部用户管理工具写入 `audit_logs`（触发 superAdminAudit 中间件 + logToolAudit）；禁用账号同时吊销其 JWT（复用黑名单/会话失效逻辑，见 auth.js）。

### 5.2 系统设置工具（L3 专属）

```json
{
  "name": "get_system_config",
  "description": "查看系统配置（仅超级管理员可用）",
  "level": "L3",
  "parameters": { "category": { "type": "string", "enum": ["general", "ai", "security", "subscription"], "required": false } }
}
{
  "name": "update_system_config",
  "description": "修改系统配置（仅超级管理员可用）。AI 相关 key 仅作默认值/开关，不覆盖用户私有 ai_providers 配置",
  "level": "L3", "requires_confirmation": true,
  "parameters": {
    "config_key": { "type": "string", "required": true },
    "config_value": { "type": "any", "required": true }
  }
}
{
  "name": "toggle_feature",
  "description": "开启/关闭功能开关（仅超级管理员可用）",
  "level": "L3", "requires_confirmation": true,
  "parameters": {
    "feature": { "type": "string", "required": true },
    "enabled": { "type": "boolean", "required": true }
  }
}
{
  "name": "get_audit_logs",
  "description": "查看系统审计日志（仅超级管理员可用）。action 取值见审计常量（login/ai_tool_call/config_change 等）",
  "level": "L3",
  "parameters": {
    "action": { "type": "string", "required": false },
    "user_id": { "type": "string", "required": false },
    "start_time": { "type": "string", "description": "ISO 时间", "required": false },
    "end_time": { "type": "string", "required": false },
    "page": { "type": "integer", "required": false }
  }
}
```

> **R14（系统配置 vs per-user AI 提供方）**：全局配置只读写新增的 `system_configs` 表；`ai_providers` 仍是用户私有。若未来需要「全局默认 AI 提供方」，仅作为未配置用户的回退默认值，**优先级低于用户私有配置**。

### 5.3 账号操作工具（已移除，走 REST）

v1 的 change_password / enable_2fa / disable_2fa **不再作为 AI 工具**（R6）。原因：
- 2FA 是 UI 密集型流程（TOTP 二维码展示、验证码轮询、恢复码管理），函数往返式 AI 工具无法承载；
- LLM 直接操作凭据属高危面（模型幻觉 / 上下文误用 / 审计不完整）；
- 现有 REST 已覆盖：auth-password.js（改密）、two-factor.js（2FA 全流程）。

### 5.4 设备管理工具（L2+）

```json
{
  "name": "list_all_devices",
  "description": "列出所有设备的在线状态（管理员及以上可用，只读）",
  "level": "L2",
  "parameters": {
    "online_only": { "type": "boolean", "description": "仅显示在线设备", "required": false }
  }
}
{
  "name": "unpair_device",
  "description": "解绑设备（管理员及以上可用）",
  "level": "L2", "requires_confirmation": true,
  "parameters": { "device_id": { "type": "string", "required": true } }
}
```

> **v2 收敛**：`unpair_device` 不再收 `user_id` 跨用户参数（R7）。若需要跨用户解绑 → 进入 Web 管理后台 REST 通道。

### 5.5 订阅管理工具（L3 专属）

```json
{
  "name": "upgrade_subscription",
  "description": "升级用户订阅（仅超级管理员可用）。操作 user_subscriptions，同步 current_period_start/end 与 status",
  "level": "L3",
  "parameters": {
    "user_id": { "type": "string", "required": true },
    "plan": { "type": "string", "enum": ["Free", "Pro", "Enterprise"], "required": true },
    "duration_months": { "type": "integer", "required": false }
  }
}
{
  "name": "downgrade_subscription",
  "description": "降级用户订阅（仅超级管理员可用）。保留剩余期限规则：当前周期不立即降档，period_end 后生效并更新 status",
  "level": "L3", "requires_confirmation": true,
  "parameters": {
    "user_id": { "type": "string", "required": true },
    "plan": { "type": "string", "enum": ["Free", "Pro"], "required": true }
  }
}
```

> **实现要点（缺口 5）**：降级需遵循订阅业务规则 —— 已有 `subscriptions.js / subscriptionCheck.js` 定义了套餐映射与状态流转，**复用其查询逻辑**，AI 工具只做「管理员代改」并写审计，不另起一套订阅语义。

### 5.6 收藏夹增强工具（L1）

#### create_sub_collection — 创建子收藏夹（R4：ltree 实现）

```json
{
  "name": "create_sub_collection",
  "description": "在指定收藏夹下创建子收藏夹，复用现有 ltree 层级（path = parent.path.col_<new_uuid>），逻辑对齐 favorites.js 的 parentId 创建",
  "level": "L1",
  "parameters": {
    "name": { "type": "string", "required": true },
    "parent_id": { "type": "string", "description": "父级收藏夹 ID（需属于当前用户）", "required": true },
    "icon": { "type": "string", "required": false },
    "description": { "type": "string", "required": false }
  }
}
```

> **注意**：**不新建 `parent_id` 列、不新建 `collections` 表**（与现有 ltree 双体系会导致一致性分裂），子收藏夹通过 ltree path 表达父子关系。

---

## 六、数据库改造方案（v2 修正）

### 6.1 新增/修改内容（收敛后）

```sql
-- =============================================
-- 037_super_admin_protection.sql（含 §3.1 触发器，此处不重复）
-- 038_rbac_admin_tables.sql（本文件）
-- =============================================

-- ① system_configs：全局配置表（新增，无现状冲突）
CREATE TABLE IF NOT EXISTS system_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key VARCHAR(100) UNIQUE NOT NULL,
  config_value JSONB NOT NULL,
  description TEXT,
  category VARCHAR(50) DEFAULT 'general', -- general | ai | security | subscription
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ② feature_flags：功能开关表（新增，无现状冲突）
CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key VARCHAR(100) UNIQUE NOT NULL,
  enabled BOOLEAN DEFAULT FALSE,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ③ audit_logs：不新增列（v2 R2）。目标用户、action 语义均入现有列：
--    action（如 ai_tool_call / delete_user / config_change）、details(JSONB)。
--    索引已有（idx_audit_logs_user_id / action / created_at），无需再加。

-- ④ 订阅：不新建 subscriptions 表（v2 R3），复用 user_subscriptions。
--    如需按 plan 查询加速，补一个普通索引即可：
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan ON user_subscriptions(plan_id);

-- ⑤ 收藏夹：不新建 parent_id 列（v2 R4），父子关系由现有 ltree path 表达。
--    （迁移 005 已建 idx_favcol_path GIST 索引）
```

### 6.2 初始化数据（新增表）

```sql
INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('ai_max_tokens', '4096', 'AI 最大回复 token 数（默认值，用户私有配置优先）', 'ai'),
  ('ai_default_provider', '"openrouter"', 'AI 默认提供方（仅未配置用户的回退值）', 'ai'),
  ('max_collection_depth', '5', '收藏夹最大嵌套层级', 'general'),
  ('enable_audit_log', 'true', '启用审计日志', 'security'),
  ('session_timeout_minutes', '30', '会话超时时间（分钟）', 'security');

INSERT INTO feature_flags (flag_key, enabled, description) VALUES
  ('enable_ai_agent', TRUE, '启用 AI Agent 功能'),
  ('enable_subscription', TRUE, '启用订阅功能'),
  ('enable_public_sharing', TRUE, '启用公开分享'),
  ('enable_2fa', TRUE, '启用两步验证');
```

---

## 七、实现任务拆分（v2 修订）

### 7.1 优先级 P0（权限地基）

| 任务 | 描述 | 产出 |
|------|------|------|
| **Task 1** | 迁移 037/038：超管唯一约束触发器（§3.1）+ system_configs + feature_flags（§6.1） | 迁移文件 |
| **Task 2** | levels 等级修正：save_memory/ocr_clip_image/read_clip_content/organize_by_type → L1；destroy_clips → L3；create_collection 等 4 个 → L1（§4.3 规则三） | aiSystemPrompt.js |
| **Task 3** | 角色等级改为读库驱动（roles.level 映射，DB 失败兜底 L1）（§2.3） | aiSystemPrompt.js |
| **Task 4** | superAdminAudit 中间件 + 挂入 /api/ai 链路（§3.2） | middleware/ |

### 7.2 优先级 P1（核心 AI 管理工具）

| 任务 | 描述 | 产出 |
|------|------|------|
| **Task 5** | 用户管理工具：list_users / create_user / delete_user / update_user_role / reset_user_password / disable_user（§5.1） | aiTools.js + 迁移 |
| **Task 6** | 系统设置工具：get_system_config / update_system_config / toggle_feature / get_audit_logs（§5.2） | aiTools.js |
| **Task 7** | 设备管理工具：list_all_devices / unpair_device（§5.4） | aiTools.js |
| **Task 8** | 订阅管理工具：upgrade_subscription / downgrade_subscription（复用 user_subscriptions 业务规则，§5.5） | aiTools.js |
| **Task 9** | create_sub_collection（ltree 实现，§5.6） | aiTools.js |
| **Task 10** | 确认门控扩展至全部 requires_confirmation 工具；approve 密码二次验证（§3.3，可选） | aiTools.js / aiChat.js |

### 7.3 优先级 P2（扩展）

| 任务 | 描述 |
|------|------|
| **Task 11** | 权限矩阵自动化测试（vitest）：等级过滤 + assertToolAllowed + 超管唯一/禁删/禁降 + 确认门控（对应 §9 验收） |
| **Task 12** | 超管操作二次验证前端实现（确认卡片增密码输入） |
| **Task 13** | Web 管理后台：L2 跨用户协助能力（统计/解绑/通知回复）以常规 REST 提供（v2 R7 延后项） |

### 7.4 依赖关系

```
Task 1 (迁移) → Task 2-4 (权限核心) → Task 5-10 (AI 工具) → Task 11-13 (测试/前端/后台)
```

---

## 八、安全注意事项（v2 补充）

### 8.1 审计日志

所有超管操作必须记录到 `audit_logs` 表，包含：操作人 ID、操作类型（action：delete_user / update_user_role / config_change / subscription_change / ai_tool_call 等）、目标用户、脱敏详情、时间、结果。复用 utils/audit.js（logAuditEvent / logToolAudit，自带脱敏）。

### 8.2 敏感数据脱敏

已有 `deepSanitize`（utils/audit.js）自动打码 password/apiKey/token/authorization/access_code/content 等键；新增工具的参数摘要默认走 logToolAudit 即可，无需重复实现。

### 8.3 操作确认机制（映射到既有协议）

v1 清单 → v2 落地映射：

```
delete_user / update_user_role / reset_user_password / update_system_config /
toggle_feature / downgrade_subscription / unpair_device / destroy_clips
  → 追加进 DESTRUCTIVE_CONFIRM_NEEDED，走 executeTool → confirm_tool_action(SSE)
    → POST /api/ai/chat/approve 协议；
  → approve 可选支持密码二次验证（§3.3）。
```

### 8.4 防滥用机制（保留）

```javascript
// 超管操作频率限制（叠加 rateLimiter）
const SUPER_ADMIN_RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };
// 用户创建频率限制
const USER_CREATION_RATE_LIMIT = { windowMs: 3_600_000, maxRequests: 10 };
```

---

## 九、验收标准（v2 更新）

### 9.1 权限矩阵验收

- [ ] 普通用户（user）仅能调用 L1 工具；管理员（admin）L1+L2（清单见 §4.2）
- [ ] 管理员**无法**跨用户读写任何数据（R7 收敛验证）
- [ ] 超级管理员（super_admin）可调用全部工具；跨用户访问需显式 user_id 且被审计
- [ ] save_memory / ocr_clip_image / read_clip_content 已登记 L1（不再默认 L0）
- [ ] destroy_clips 仅 L3 可用；create_collection 等 4 个工具 L1 可用
- [ ] 超管账号唯一、不可删除、不可降级（触发器 + 应用层双保障）
- [ ] 所有超管操作均记录审计日志

### 9.2 AI 工具验收

- [ ] 用户管理工具正常（创建/删除/禁用/改角色/重置密码，phone 中枢）
- [ ] 系统设置工具正常（读/改配置、功能开关）
- [ ] 审计日志工具正常（按 action/user_id/时间过滤）
- [ ] 订阅升降级操作 user_subscriptions 且遵循现有业务规则
- [ ] 子收藏夹创建走 ltree，创建后可在应用内看到层级
- [ ] 所有 requires_confirmation 工具走确认门控，拒绝/超时可恢复

### 9.3 安全验收

- [ ] 未登记写工具触发 CI 检查失败（防回归 R11）
- [ ] 普通用户/管理员访问 L3 工具返回 ROLE_FORBIDDEN
- [ ] 敏感参数在审计日志中脱敏（password/apiKey/content 等）
- [ ] 超管操作频率限制生效
- [ ] 二次验证（若实现）在错误密码下拒绝并审计

---

## 十、附录

### 10.1 现有工具等级映射表（v2）

| 工具 | v1 等级 | v2 等级 | 变更说明 |
|------|:------:|:------:|---------|
| create_collection / create_template / update_template / create_shared_link | L2 | L1 | 降级：用户自己的数据管理 |
| destroy_clips | L2 | L3 | 升级：物理删除仅超管 |
| save_memory / ocr_clip_image / read_clip_content / organize_by_type | （默认 L0） | L1 | 补登记，修复默认开放 |
| get_security_overview / get_protected_clips / explain_deployment / get_project_architecture | L3 | L3 | 不变 |
| change_password / enable_2fa / disable_2fa | （新增规划） | 移除 | 走既有 REST（R6） |
| create_sub_collection / 用户管理 / 系统设置 / 设备管理 / 订阅管理工具 | （新增规划） | 新增 | 见 §4.2 |

### 10.2 术语表

| 术语 | 说明 |
|------|------|
| RBAC | Role-Based Access Control |
| L1/L2/L3 | 权限等级，以 roles.level 为驱动源（v2 R13） |
| L0 agent_service | 预留的内部 Agent 角色，本期不实现（R10） |
| own | 只能操作自己的数据（v1 唯一实现形态） |
| cross_user | 跨用户能力，仅 L3 + 显式 user_id + 审计（v2 收敛） |
| confirm gate | 破坏性/敏感操作确认门控（DESTRUCTIVE_CONFIRM_NEEDED → approve） |
| super_admin | 超级管理员，唯一的产品所有者（触发器保证唯一/不可删/不可降） |

---

**文档状态**：v2 已按代码现状全面修订（R1-R14）
**下一步**：用户确认修订后，按 P0（权限地基）→ P1（核心管理工具）→ P2（测试/前端/后台）依次实现