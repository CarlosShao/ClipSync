# ClipSync RBAC 角色与权限设计（可配置三级）

> 状态：设计稿（待评审后实现）
> 关联需求：用户要求「可配置角色」+「三级权限」+「AI 大管家数据范围隔离」
> 关联文档：`docs/MISSING_FEATURES_DESKTOP.md`（后台管理 / RBAC 章节）

## 一、设计目标

1. **角色可配置**：角色不是硬编码的枚举，而是落在数据库里的数据。超管可以在后台（或将来 Web 管理台）增删角色、调整每个角色的权限。
2. **三级默认角色 + 自由扩展**：
   - `super_admin`（级别 100）：产品拥有者/开发者，开顶格后门，AI 可见一切（含数据库结构、部署、安全、他人数据）。
   - `admin`（级别 50）：可派发给朋友帮忙测试，有管理能力，**但拿不到敏感数据**（看不到库表、看不了安全实现、查不了别人数据）。
   - `user`（级别 10）：普通 / 企业 / VIP 用户，只能看平台公开能力，**绝不允许** AI 泄露内部实现、数据库、代码、他人数据。
3. **AI 数据范围按角色收敛**：这是安全核心。普通用户（甚至 2 级 admin）问「数据库有哪些表」「用户密码怎么存的」「代码怎么实现的」，AI 必须拒绝，因为 backend 根本不会把这些信息注入 prompt、也不会开放对应工具。
4. **向后兼容**：现有 `users.is_admin` 布尔字段仍被 4 处代码引用，迁移时不能一刀切，需平滑替换或保留推导字段。

## 二、ER 关系

```
roles 1 ──< role_permissions >── 1 permissions
  │
  │ (users.role_id 引用)
  ▼
users (role_id, level 冗余可选)
```

## 三、表结构（DDL）

### 3.1 roles — 角色定义表（可自定义）

```sql
CREATE TABLE roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,            -- 显示名，如「超级管理员」
  role_key      VARCHAR(50)  UNIQUE NOT NULL,     -- 机器键：super_admin / admin / user / custom_xxx
  level         INTEGER NOT NULL DEFAULT 10,      -- 级别：100=顶格超管, 50=管理员, 10=普通用户
  description   TEXT DEFAULT '',
  is_system     BOOLEAN DEFAULT FALSE,            -- 系统角色(super_admin/admin/user)不可删除，权限可改
  is_assignable BOOLEAN DEFAULT TRUE,             -- 是否可被分配给用户
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_roles_level ON roles(level);
```

- `level` 用于层级约束：高级别可管理/分配低级别角色，低级别不能越权。
- `is_system=true` 的三个角色键固定，删不掉；但 `role_permissions` 里的权限可以改（满足「可配置」）。

### 3.2 permissions — 权限目录（所有可授权项注册表）

```sql
CREATE TABLE permissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_key  VARCHAR(100) UNIQUE NOT NULL,   -- 如 ai.view_database_schema
  category        VARCHAR(50)  NOT NULL,           -- admin.users / admin.devices / ai.scope ...
  description     TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_permissions_category ON permissions(category);
```

`category` 用于后台 UI 分组展示。

### 3.3 role_permissions — 角色-权限映射（可编辑）

```sql
CREATE TABLE role_permissions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id      UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted      BOOLEAN NOT NULL DEFAULT TRUE,      -- 显式允许；未来可支持 deny 覆盖
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(role_id, permission_id)
);

CREATE INDEX idx_rp_role ON role_permissions(role_id);
```

### 3.4 users — 改造：用 role_id 取代 is_admin

```sql
ALTER TABLE users ADD COLUMN role_id UUID REFERENCES roles(id) ON DELETE SET NULL;
-- 兼容字段：由 role.level >= 50 推导，代码侧逐步统一读 role.level，后续废弃
-- 保留 is_admin 不删，迁移脚本回填，避免 4 处现有代码立刻崩
```

## 四、权限目录（核心：AI 数据范围）

按 `category` 分组。带 🔒 的权限**只授予 super_admin**，是敏感数据闸门。

### 4.1 后台管理类（admin.*）

| permission_key | 说明 | 默认授予 |
|----------------|------|----------|
| admin.manage_roles | 角色与权限配置（仅超管） | super_admin |
| admin.manage_users | 用户增删改 / 封禁 | super_admin, admin |
| admin.view_users | 查看用户列表 | super_admin, admin |
| admin.assign_roles | 给用户分配角色 | super_admin, admin |
| admin.manage_devices | 设备管理 | super_admin, admin |
| admin.view_devices | 查看设备 | super_admin, admin |
| admin.manage_subscriptions | 订阅/支付管理 | super_admin, admin |
| admin.view_audit | 审计日志查看 | super_admin, admin |
| admin.view_sessions | 会话/登录历史 | super_admin, admin |
| admin.revoke_sessions | 撤销会话(JWT黑名单) | super_admin, admin |
| admin.manage_keys | 密钥/设备密钥管理 | super_admin, admin |

### 4.2 AI 数据范围类（ai.scope）— 安全闸门

| permission_key | 说明 | 默认授予 |
|----------------|------|----------|
| ai.use_tools | 可使用 AI 工具（基础能力） | 全部角色 |
| ai.view_platform_data | 查看平台公开能力/帮助/功能说明 | 全部角色 |
| 🔒 ai.view_database_schema | 查看数据库表结构/元信息 | super_admin |
| 🔒 ai.view_deployment | 查看部署架构/服务器/环境变量 | super_admin |
| 🔒 ai.view_security_data | 查看加密实现/密钥/安全细节 | super_admin |
| 🔒 ai.view_source_code | 查看代码/实现细节 | super_admin |
| 🔒 ai.access_other_user_data | 查询他人数据/用户密码等 | super_admin |
| 🔒 ai.explain_internal | 解释内部实现机制 | super_admin |

> **关键结论**：普通用户和 2 级 admin 的 `role_permissions` 里**完全没有**这 6 个 🔒 权限。后端据此：① 构建角色化 system prompt（user/admin 版本明确禁止讨论库表、代码、安全、他人数据）；② 按角色过滤下发给 LLM 的 tools 列表；③ 工具执行前再校验一次权限。三层兜底，AI 无从泄露。

## 五、默认角色种子数据

| role_key | level | 权限范围 |
|----------|-------|----------|
| super_admin | 100 | 全部 admin.* + 全部 ai.*（含 6 个 🔒） |
| admin | 50 | 全部 admin.*（**不含** admin.manage_roles）+ ai.use_tools + ai.view_platform_data（**不含** 6 个 🔒） |
| user | 10 | ai.use_tools + ai.view_platform_data 仅此两项 |

自定义角色：admin 或 super_admin 可在后台新建 `role_key=custom_*` 的角色，从权限目录里挑权限组合，级别自定（但普通用户不可建高于自身的角色）。

## 六、迁移与兼容性处理

1. **新增迁移文件**（如 `src/db/migrations/0XX_rbac.sql`）：
   - 建 `roles` / `permissions` / `role_permissions` 三表。
   - 种子插入 3 个默认角色 + 权限目录 + `role_permissions` 映射。
   - `ALTER TABLE users ADD COLUMN role_id`。
   - 回填：`UPDATE users SET role_id = (SELECT id FROM roles WHERE role_key='super_admin') WHERE is_admin = TRUE;` 其余置 `user`。
2. **4 处 `is_admin` 引用改造**：
   - `src/server/src/index.js:316`（管理端点鉴权）→ 改为 `role.level >= 50` 或具体权限校验。
   - `src/server/src/middleware/subscriptionCheck.js:32`（admin 免订阅限制）→ `role.level >= 50`。
   - `src/server/src/routes/chunked-upload.js:203`（admin 突破文件大小）→ `role.level >= 50`。
   - `src/server/src/routes/payments.js:474`（admin 支付校验）→ `role.level >= 50`。
   - 过渡期保留 `is_admin` 列作为冗余；最终统一读 `role.level`。
3. **auth 中间件**：JWT 校验后把 `role_key` / `level` / 权限集合挂到 `req.user`，供 AI 路由与后台路由使用（避免每次查库）。
4. **前端**：登录响应 / `/api/auth/me` 返回 `roleKey`、`level`；AISidebar 顶部显示角色徽标（「超管模式」/「管理后台」/「用户」），让用户知道自己开了什么后门。

## 七、与 AI 后端的对接点（实现阶段）

- `routes/aiChat.js`：收到前端 messages 后，**用后端角色化 prompt 覆盖**第一条 system（不信任前端）。
- `routes/aiTools.js`：`getToolsForRole(permissions)` 按 `ai.*` 权限过滤工具；执行前再校验。
- `utils/aiSystemPrompt.js`（后端新增）：`buildSystemPrompt(roleKey, permissions)` —— super_admin 版含完整库表/部署/安全上下文；user/admin 版为精简版，明确「只能访问当前用户自己的数据，禁止讨论数据库元信息、加密实现、部署细节、代码实现、他人数据」。
- 敏感工具（`get_security_overview`、`get_protected_clips`、`explain_deployment`、`get_project_architecture` 等）绑定 `ai.view_security_data` / `ai.view_database_schema` / `ai.view_deployment` 等权限，普通用户根本不会出现这些工具。

## 八、后台管理（Web Admin）对应功能

见 `docs/MISSING_FEATURES_DESKTOP.md` 第三节「角色与权限管理」：
- 角色列表 / 新建自定义角色
- 权限目录可视化（按 category 分组勾选）
- 角色-权限分配
- 用户-角色分配
- 角色级别约束校验（不可越级赋权）
