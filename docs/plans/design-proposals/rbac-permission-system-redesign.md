# 方案二：权限系统现状分析与重构方案

- **状态**：设计评审中（未实施）
- **日期**：2026-09-07
- **关联**：[feature-menu-access-control.md](./feature-menu-access-control.md)（方案一）；管理台审计 [admin-audit-report-2026-09-06.md](../../audit/admin-audit-report-2026-09-06.md)、[admin-config-audit-2026-09-07.md](../../audit/admin-config-audit-2026-09-07.md)
- **事实声明**：本文所有「现状」均逐文件核实并附证据位置；**未实现的权限项如实标记为未实现，不使用任何 mock/臆造数据**。记忆或文档中与代码不符的预期设计，以本文核实结果为准并明确标注差异。

---

## 一、体系全景：两套独立权限体系

当前系统存在**两套互不关联**的权限体系：

| | 体系 A：管理台 RBAC | 体系 B：AI Agent 能力等级 |
|---|---|---|
| 数据源 | `roles` + `permissions` + `role_permissions` 三表（028_roles.sql:9-32），`users.role_id` 关联 | 纯代码：`aiSystemPrompt.js` 的 `ROLE_TO_LEVEL` 字符串映射（L32-36） |
| 判定依据 | `roles.level` 数值（10/50/100）+ 权限键集合 | `role_key` 字符串（user/admin/super_admin→L1/L2/L3） |
| 校验位置 | `middleware/adminAuth.js`：requireRole（L45-55）+ requirePerm（L83-121，SQL JOIN + 60s 缓存） | `aiTools.js:2030` assertToolAllowed → `aiSystemPrompt.js` isToolAllowedForLevel |
| 管理界面 | 管理台「角色权限」页（13 项权限目录，可自定义角色） | 无任何管理界面（等级写死在代码矩阵里） |
| 交叉点 | **无** | **无**（AI 工具从不查 permissions 表；roles.level 数值从未传入 AI 闸门，见 3.2） |

---

## 二、体系 A 现状：13 项权限键 × 真实执行矩阵

### 2.1 执行矩阵（核心交付）

| # | permKey | 管理台显示 | 后端真实执行点 | 结论 |
|---|---|---|---|---|
| 1 | admin.users.view | 查看用户列表与详情 | users.js:316, 349（requirePerm） | ✅ 真实生效 |
| 2 | admin.users.manage | 停用/启用/强制下线/重置2FA | users.js:484, 564, 703, 760 | ✅ 真实生效 |
| 3 | admin.users.delete | 删除账户（高危） | users.js:819 | ✅ 真实生效 |
| 4 | admin.devices.manage | 设备远程下线/解绑 | devices.js:221 | ✅ 真实生效（**但设备读端点无 view 键**，见 2.2） |
| 5 | admin.subscriptions.grant | 人工赠期/调整套餐 | subscriptions.js:171 | ✅ 真实生效 |
| 6 | admin.orders.refund | 执行退款（高危） | orders.js:252 | ✅ 真实生效 |
| 7 | admin.plans.manage | 套餐与价格管理 | plans.js:150 | ✅ 真实生效 |
| 8 | admin.orders.reconcile | 查看对账报告 | orders.js:355 | ✅ 真实生效 |
| 9 | admin.audit.view | 查看审计日志 | audit.js:240 | ✅ 真实生效 |
| 10 | admin.roles.manage | 角色与权限管理（高危） | roles.js:194, 281; users.js:614 | ✅ 真实生效 |
| 11 | **admin.keys.view** | 设备密钥细节（仅超管） | **全仓无任何消费点**（仅 roles.js:49 目录元数据） | ❌ **完全未实现**：后端不存在「设备密钥细节」端点，目录先行、功能未建 |
| 12 | admin.configs.manage | 系统参数与功能开关 | configs.js:161, 255 | ✅ 真实生效 |
| 13 | admin.announce.send | 公告与通知下发 | announcements.js:110 | ✅ 真实生效 |

**结论：12/13 真实生效；1 项（admin.keys.view）配置了但从未实现。** 写操作（manage/refund/grant/manage/reconcile/send）全部有细粒度校验——当前权限模型实际是「**写细粒度、读靠角色门槛**」。

### 2.2 读端点覆盖缺口

以下 9 个「读列表」端点**只过顶层 requireRole(50)**，无任何 admin.*.view 键校验（各文件头注释自认）：

```
GET /api/admin/devices/stats   devices.js:144      GET /api/admin/roles        roles.js:133
GET /api/admin/devices         devices.js:179      GET /api/admin/permissions  roles.js:153
GET /api/admin/orders          orders.js:186       GET /api/admin/configs      configs.js:137
GET /api/admin/orders/:orderNo orders.js:219       GET /api/admin/flags        configs.js:225
GET /api/admin/subscriptions   subscriptions.js:94       （subscriptions/stats subscriptions.js:132、
GET /api/admin/subscriptions/stats subscriptions.js:132    plans plans.js:132、announcements announcements.js:184 同）
GET /api/admin/plans           plans.js:132
GET /api/admin/announcements   announcements.js:184
```

**安全含义**：任何 level≥50 的自定义角色，即使权限集为空，也能读取设备/订单/订阅/套餐/角色/系统参数/公告全部数据（仅用户列表和审计日志例外——这两处有 view 键）。「查看对账报告」在 UI 上是一个独立勾选项，但订单列表本身任何管理员都能看，权限语义不自洽。

### 2.3 管理台前端感知现状（覆盖率 2/13）

| 位置 | 消费点 | 文件 |
|---|---|---|
| 设备页「远程下线」按钮 | admin.devices.manage | pages\devices\index.tsx:68 |
| 订阅页「赠期」按钮 | admin.subscriptions.grant | pages\subscriptions\index.tsx:108 |
| 用户页停用/删除/改角色按钮、订单页退款按钮、设置页开关 | **无前端裁剪**（点了靠后端 403） | — |
| 左侧导航 8 项 | 静态，不按权限过滤 | layouts\AdminLayout.tsx:11-20 |
| 路由守卫 | 仅校验 roleKey ∈ {admin, super_admin}，不校验权限点 | router\RequireRole.tsx:16-27 |

前端 hasPerm 工具已存在（utils\permissions.ts:7-13，注释明示"仅 UX 裁剪，真正鉴权以后端为准"）——地基在，覆盖没做。

### 2.4 体系 A 其它问题清单

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| A-1 | **角色分配后 60s 权限缓存滞留**：users.js:614-692 给用户改角色不调 clearPermCache()，旧角色权限最长滞留 60s（改角色权限本身有清，roles.js:356） | adminAuth.js:24-27,93-97 | 降权操作最长 60s 内旧权限仍可用 |
| A-2 | **users.is_admin 布尔残留双体系**：auth.js:75 仍注入 isAdmin（`Boolean(u.is_admin) || roleKey==='super_admin'`）；`GET /api/admin/slow-queries` 旧端点（index.js:320-332）**游离在 RBAC router 之外**，用 is_admin 判断 | index.js:320-332 | is_admin 与 role_id 可能不一致；slow-queries 绕过 admin.* 权限体系 |
| A-3 | **whoami 下发非管理台权限键**：028 种子的 6 个 ai.* + 2 个 platform.* 键与 admin.* 同表混存，whoami 全量返回（index.js:53-67），super_admin 返回 21 键；前端把 super_admin 归一 `['*']`（api\auth.ts:37）掩盖了问题 | 028_roles.sql:45-54 | 概念混淆；ai.*/platform.* 共 8 键**全仓无消费点**（迁移注释自认"后续接入"，028_roles.sql:5-6） |
| A-4 | GET /api/metrics、/api/ready 无认证（关联配置审计 D5/D7，此处仅登记） | index.js:237-312 | — |

---

## 三、体系 B 现状：AI Agent 能力等级

### 3.1 等级模型与真实工具矩阵（核实结果）

- 等级：L0 只读 / L1 操作 / L2 管理 / L3 超管 / L4 Agent 服务（L4 已定义但 levels.L4 为空、不参与映射）；高等级继承低等级（LEVEL_RANK，aiSystemPrompt.js:47）
- 工具共 **100 个，全部真实实现**（aiTools.js TOOLS 定义 + executeToolInner switch；全文件 grep TODO/mock/假数据/placeholder **零命中**）——**不存在 mock 工具**
- 三层闸门：后端强制 system prompt（前端提示词不可信，aiChat.js:47-58）→ 按角色过滤工具清单（getToolsForRole，低等级工具对模型不可见）→ 执行前 assertToolAllowed（aiTools.js:2030）
- 脱敏：list_users/create_user 经 maskPhone/maskEmail（aiTools.js:57-72, 3136-3137）；list_all_devices 目标手机号脱敏（L3434）
- 破坏性操作 11 个工具 + 批量归档有前端确认卡片门控（DESTRUCTIVE_CONFIRM_NEEDED，L1696-1712）；全程 logToolAudit 审计（L4596-4661）

### 3.2 与预期设计不符的核实结论（重点）

| # | 核实结论 | 证据 |
|---|---|---|
| B-1 | **约 30 个工具未登记等级 = L0（对所有角色开放）**：get_devices、search_clips、get_clip_details、get_recent_clips、get_collections、get_tags、get_templates、get_shared_links、get_memories、get_profile、get_subscription_details、get_subscription_plans、list_my_sessions、get_notifications 等用户自数据只读工具。当前实际无害（L0 与 L1 对 user 角色等效、且全部 `WHERE user_id=自己` 隔离），但 L0 语义是"连 Agent 内部服务都可用"，登记缺位使「未登记即最开放」成为默认 | aiSystemPrompt.js getToolLevel L180-187（找不到返回 'L0'） |
| B-2 | **roles.level 数值从未传入 AI 闸门**：levelKeyForRole 支持 roleLevel 参数（≥100→L3、≥50→L2），但全部调用点只传 role_key 字符串（aiChat.js:60、aiOrchestrator.js:392、aiTools.js:1687、2030）。**后果：自定义管理员角色（level 50-99，role_key 为 custom_*）在 AI 里永远是 L1，拿不到 L2 管理工具**——与管理台 RBAC 的等级语义直接矛盾 | aiSystemPrompt.js:168-176；四个调用点 |
| B-3 | **4 个「预期存在」的 AI 工具实际不存在**：change_password、enable_2fa、disable_2fa、list_devices 均非 AI 工具（改密走 auth-password.js、2FA 走 two-factor.js，为常规 HTTP 路由）。近似物：get_devices（自己设备，未登记=L0）、list_all_devices（L2）、unpair_device（L2，可解绑**任意用户**设备）、unpair_own_device（L1，仅自己） | aiTools.js 全量定义清单 |
| B-4 | **AI 工具不校验 admin.\* 权限键**：L3 工具（list_users/update_system_config/toggle_feature/get_audit_logs 等）只看 role_key 映射，与体系 A 的 13 键零关联。一个被勾选了 admin.configs.manage 的自定义角色在管理台能改配置，但在 AI 里连工具都看不到（B-2 的另一面） | aiSystemPrompt.js 全文无 permissions 查询 |
| B-5 | 028 已种子 6 个 ai.* 权限键（ai.view_database_schema/ai.view_deployment/ai.view_security_data/ai.view_source_code/ai.access_other_user_data/ai.explain_internal）**全仓无消费**——是当年预留的接缝，可作为 B-4 治理的落点 | 028_roles.sql:45-54；迁移注释 L5-6 |
| B-6 | 两个敏感读未脱敏/明文：`reset_user_password` 把明文临时密码返回给 AI 对话（L3284，设计如此——管理员需要转告用户，且有确认门控+审计）；`get_audit_logs` 用 SELECT * 返回全量行含 detail（L3400-3414，未做字段裁剪） | aiTools.js |
| B-7 | `destroy_clips`（物理删除）在 aiSystemPrompt.js 登记 L3（:139），aiTools.js:2431 的注释写"L2 起"——过时注释，行为以 L3 为准 | — |

---

## 四、重构方案

### 4.1 设计原则

1. **一个用户、一套身份**：roleKey/roleLevel 是唯一身份事实（users.role_id→roles），两套体系都必须消费它；admin.* 权限键管「管理台能做什么」，AI 等级管「Agent 能力多深」，但判定输入统一。
2. **配置必须可追溯**：管理台上每一个可勾选的权限项，必须要么有真实执行点，要么明确标注「未实现/预留」并从可勾选目录隔离——不允许「看起来能配、实际不存在」。
3. **fail-closed 不变**：requirePerm 的 DB 异常 500 拒绝、AI 兜底 L1 语义保留。
4. **兼容优先**：内置三角色行为不变；自定义角色能力只增不减（本次修复 B-2 会让自定义管理员角色**获得**应有的 AI 能力）。

### 4.2 改造项（按优先级）

#### P1-1：AI 闸门接入 roles.level（修 B-2，最高性价比）
- 改动：四个调用点把 `req.user.roleLevel` 传入 `levelKeyForRole(roleKey, roleLevel)`（aiChat.js:60、aiOrchestrator.js:392、aiTools.js:1687、2030）——roleLevel 已由 auth 中间件每请求注入（auth.js:74）
- 效果：super_admin→L3、admin(50)→L2、自定义 level≥50→L2、level≥100→L3、其余 L1；内置角色行为完全不变
- 回归：内置三角色工具清单 diff 为空；自定义 level 50 角色获得 L2 工具

#### P1-2：admin.keys.view 处置（修唯一未实现项）
- 现状：无承载功能。**建议：从 PERM_CATALOG 与管理台 UI 移除**（044 迁移的表记录保留，仅目录不再展示），待「设备密钥细节」功能真实立项时再加回——禁止保留一个不可验证的勾选项
- 备选（若产品坚持保留）：实现 `GET /api/admin/devices/:id/keys`（设备同步凭证的脱敏摘要，仅 super_admin），但这是新功能开发，不属于权限重构范围

#### P1-3：角色分配清缓存（修 A-1）
- users.js 角色分配成功后调用 `clearPermCache()`（与 roles.js:356 对齐）；顺手把 clearPermCache 从"全清"加"按用户清"重载（Map 遍历 value 匹配 userId），避免全站缓存抖动

#### P2-1：读端点补 view 键（修 2.2 缺口）
- 049 迁移新增 6 个 view 键并授予 super_admin/admin：`admin.devices.view`、`admin.orders.view`、`admin.subscriptions.view`、`admin.plans.view`、`admin.roles.view`（roles/permissions 列表）、`admin.configs.view`（configs/flags 列表）、`admin.announce.view`（公告历史）——**7 个**；对应 9 个 GET 端点加 requirePerm
- 管理台内置 admin 角色默认全勾（迁移里授予），**现有 admin 角色行为不变**；自定义角色此后可精确控制「只读不下线」「只看订单不能退款」
- announcements.js:184 的 GET（历史）与 POST（发送）分离后，「能看历史不能发」成为可配项
- PERM_CATALOG（roles.js:38-52）同步加 7 项元数据；管理台 mocks/data.ts:819-831 镜像同步

#### P2-2：管理台前端权限裁剪全覆盖（修 2.3）
- AdminLayout 导航按 hasPerm 过滤（无 audit.view 隐藏审计页…）；各页操作按钮统一 canXxx 守卫（用户页 3 按钮、订单页退款、设置页保存）；路由守卫 RequireRole 支持 permission 参数
- 口径：super_admin 恒真；普通 admin 按 permissions 数组；与后端 requirePerm 键一一对应

#### P2-3：未登记 AI 工具补登记（修 B-1）
- ~30 个用户自数据只读工具统一登记 **L1**（语义正确：登录用户可用；L0 保留给 L4 Agent 服务与真正无身份场景）；逐个过一遍确认无越权字段（已核实均按 userId 隔离）

#### P3-1：双体系残留清理（修 A-2/A-3）
- `GET /api/admin/slow-queries` 挪进 admin router（requireRole(50) + admin.audit.view）；index.js:320-332 旧挂载移除
- users.is_admin：auth.js:75 的 isAdmin 改为由 roleKey 推导（`roleKey==='admin'||'super_admin'`），is_admin 列保留但标记 deprecated（028 回填已保证一致，直接删列风险大）
- whoami/permissions 下发按 category 过滤：管理台前端只收 `admin.*`（ai.* 和 platform.* 不再下发前端，super_admin 的 `['*']` 归一逻辑保留）

#### P3-2：AI 敏感读收敛（修 B-6）
- get_audit_logs：SELECT 明确列清单 + detail 截断/脱敏（对齐管理台审计页脱敏口径）
- reset_user_password：保持现状（确认门控+审计已覆盖），在 AI 系统提示词中加"临时密码仅可通过安全渠道转交"约束

#### P3-3（可选，需产品决策）：AI 工具接入权限键
- 把 20 个 L2/L3 工具映射到权限键（复用 028 已种的 ai.view_security_data/ai.view_deployment/ai.view_source_code/ai.access_other_user_data 4 键 + 新增 ai.manage_users/ai.manage_system 等），assertToolAllowed 升级为「等级达标 && （无声明键 || 有该键）」
- 收益：自定义角色可精确控制 AI 管理能力；代价：角色页 UI 需要新增「AI 能力」分组。**建议等 P1 落地观察后再决定**，避免一次改太多

### 4.3 数据模型变更汇总

| 变更 | 迁移 | 说明 |
|---|---|---|
| 新增 7 个 admin.*.view 权限键 + 授予 super_admin/admin | 049_admin_view_permissions.sql | 结构不变，纯种子行 |
| admin.keys.view：表记录保留，PERM_CATALOG/前端目录移除 | 无（代码层） | 功能立项后再恢复 |
| 其余全部为代码改动 | 无 | roles/permissions/role_permissions 三表结构不动 |

---

## 五、未实现权限项清单（如实记录，禁止 mock）

| 项 | 状态 | 处置 |
|---|---|---|
| admin.keys.view（设备密钥细节） | 配置存在，功能不存在 | P1-2 移出目录，功能立项后恢复 |
| 028 的 6 个 ai.* + 2 个 platform.* 键 | 种子存在，零消费 | 保留（P3-3 的落点），whoami 不再下发前端 |
| AI 工具 change_password / enable_2fa / disable_2fa / list_devices | **不存在此 4 个 AI 工具**（此前设计预期与代码不符，以核实为准） | 不补造：2FA/改密已有常规路由且体验完整；设备查看已由 get_devices/list_all_devices 覆盖。若未来需要语音式改密，单独立项 |
| 自定义管理员角色的 AI L2 能力 | 角色等级语义存在，AI 闸门未消费 | P1-1 修复 |
| 管理台读端点细粒度控制 | view 键不存在 | P2-1 新增 |

## 六、实施路线图与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | AI 闸门接入 roleLevel；admin.keys.view 移出目录；角色分配清缓存 | 内置三角色 AI 工具清单 diff 为空；自定义 level50 角色可见 L2 工具；改角色后权限 ≤1s 生效；`run-audit.mjs` 全绿 |
| P2 | 7 个 view 键 + 9 端点挂 requirePerm；管理台导航/按钮/路由按权限裁剪；AI 只读工具补登记 L1 | 空权限自定义角色读不到设备/订单等列表（40304）；admin 角色行为不变；前端无权限按钮不可见 |
| P3 | slow-queries 归位；is_admin 收敛；whoami 过滤；get_audit_logs 脱敏；（可选）AI 工具权限键化 | whoami 仅返回 admin.*；审计 AI 返回脱敏字段 |

每阶段扩展 `scripts/admin-full-audit/run-audit.mjs` 增加对应断言（自定义角色 × 权限组合矩阵），禁止凭 UI 截图断言。
