# 工单：权限系统重构（方案二落地）

- **方案**：[../design-proposals/rbac-permission-system-redesign.md](../design-proposals/rbac-permission-system-redesign.md)
- **现状矩阵来源**：方案二第二节（13 项权限键 × 真实执行矩阵）
- **状态标记**：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞
- **决策依赖**：RB-03 处置方式需拍板（推荐移出目录）；RB-30 是否启动需产品决策

---

## RB-01 AI 闸门接入 roles.level ✅ P1（四处调用点全部接入 roleLevel；run-audit `ailevel` 阶段断言已补齐并通过）
- **问题**：方案二 B-2——levelKeyForRole 支持 roleLevel 参数但从未被传入，自定义管理员角色（level≥50，role_key 为 custom_*）在 AI 里永远 L1，与管理台等级语义矛盾
- **改动**：四处调用点把 roleLevel 传入（roleLevel 已由 auth.js:74 每请求注入）：
  - `src/server/src/routes/aiChat.js:60`
  - `src/server/src/routes/aiOrchestrator.js:392`
  - `src/server/src/routes/aiTools.js:1687（getWorkerTools）`
  - `src/server/src/routes/aiTools.js:2030（assertToolAllowed）`
- **验收**：内置 user/admin/super_admin 三角色 AI 工具清单 diff 为空（行为不变）；自定义 level 50 角色获得 L2 工具；level 100 获得 L3；扩展 `run-audit.mjs` 加 AI 等级断言

## RB-02 admin.keys.view 处置 ✅ P1（2026-09-08 拍板追认：走备选方案——实现真实承载端点 GET /api/admin/devices/:id/keys（requirePerm('admin.keys.view')，脱敏摘要），键保留在目录；推荐方案（移出目录）作废）
- **问题**：方案二矩阵第 11 项——管理台可勾选但后端无任何承载功能（"设备密钥细节"端点不存在）
- **推荐处置**：PERM_CATALOG（roles.js:49）与管理台权限树移除该项（043/044 迁移的表记录保留）；功能真实立项时恢复
- **备选**：实现 `GET /api/admin/devices/:id/keys`（脱敏摘要，仅 super_admin）——属新功能开发，不进本工单
- **验收**：管理台权限树不再出现该项；whoami 对普通 admin 不再返回它

## RB-03 角色分配清权限缓存 ✅ P1（实现为全清语义（含单键缓存+键集合+等级缓存），粒度比按 userId 更粗但语义更强）
- **问题**：A-1——users.js:614-692 改角色不调 clearPermCache()，旧权限最长滞留 60s（降权窗口）
- **改动**：adminAuth.js clearPermCache 增加按 userId 清除重载；users.js 角色分配成功后调用
- **验收**：改角色后立即（<1s）以新权限判定（旧 60s 缓存复现用例转为 PASS）

## RB-04 AI 只读工具补登记 L1 ✅ P2（19 个只读工具登记 + validateToolRegistration 启动自检 + tests/ai-rbac.test.js 单测）
- **问题**：B-1——约 30 个工具未登记=L0 全开放（当前无害但默认方向错误）
- **改动**：aiSystemPrompt.js levels.L1 数组补登记（逐个核对：get_devices/search_clips/get_clip_details/get_recent_clips/get_collections/get_tags/get_templates/get_shared_links/get_memories/get_clip_meta/get_archived_clips/get_subscription_details/get_template_variables/get_notifications/explain_feature/explain_privacy_model/get_workflow_rules/get_notification_preferences/get_version_history/get_profile/get_subscription_plans/get_collection_items/get_frequent_clips/get_protection_status/list_my_sessions/get_clipboard_stats/get_ai_context/analyze_clip_usage 等）；L0 语义保留给 L4 Agent 服务
- **验收**：getToolLevel 无未登记工具（加启动断言或单测遍历 TOOLS 全登记）；普通用户工具可见性不变

## RB-05 敏感读收敛 ✅ P2（get_audit_logs 明确列清单 + details 500 字符截断脱敏；destroy_clips 注释修正为 L3+确认门控）
- **改动**：aiTools.js get_audit_logs（L3400-3414）SELECT 明确列清单 + detail 脱敏/截断（对齐管理台审计页口径）；reset_user_password 保持现状（确认门控+审计已覆盖），AI 系统提示词加"临时密码仅安全渠道转交"约束；aiTools.js:2431 destroy_clips 过时注释改正（实际 L3）
- **验收**：AI 返回的审计行无 detail 敏感字段全文

## RB-06 新增 7 个 view 权限键 + 读端点挂锁 ✅ P2（2026-09-08 收尾：devices.js GET /stats 与 GET / 均挂 requirePerm('admin.devices.view')（拍板结论）；run-audit `rb06` 阶段矩阵断言（空权限 403 → 授予 view → 200）已补齐并通过；index.js 挂载注释同步更新）
- **问题**：2.2 节——9 个读端点仅 requireRole(50)，无细粒度 view 键
- **改动**：
  1. 迁移 049：新增 admin.devices.view、admin.orders.view、admin.subscriptions.view、admin.plans.view、admin.roles.view、admin.configs.view、admin.announce.view，授予 super_admin + admin（内置角色行为不变）
  2. 九端点挂 requirePerm：devices.js:144,179 / orders.js:186,219 / subscriptions.js:94,132 / plans.js:132 / roles.js:133,153 / configs.js:137,225 / announcements.js:184
  3. PERM_CATALOG（roles.js:38-52）+ admin-console mocks/data.ts:819-831 镜像同步 7 项
- **验收**：空权限自定义角色读设备/订单列表 403；admin 角色全页面可用；`run-audit.mjs` 加矩阵断言（7 键 × 有/无 × 读写）

## RB-07 管理台前端权限裁剪全覆盖 ✅ P2
- **问题**：2.3 节——前端仅 2/13 消费点，导航/路由不感知权限
- **改动**：
  1. AdminLayout.tsx NAV_ITEMS 按 hasPerm 过滤（audit→admin.audit.view、orders→admin.orders.view、settings→admin.configs.view ∥ admin.announce.send…）
  2. RequireRole.tsx 支持权限点校验
  3. 用户页停用/删除/改角色、订单页退款、设置页保存等按钮加 canXxx 守卫（现有 devices:68、subscriptions:108 两处对齐写法）
- **依赖**：RB-06（view 键存在后导航过滤才有意义）
- **验收**：空权限自定义角色登录后导航只剩有权限页；直接输 URL 访问无权限页被路由守卫拦截

## RB-08 slow-queries 归位 RBAC ✅ P3
- **问题**：A-2——index.js:320-332 旧端点游离在 admin router 外，用 is_admin 布尔判权
- **改动**：挪进 admin router（requireRole(50) + admin.audit.view）；删旧挂载与 is_admin 判断
- **验收**：无 audit.view 的管理员 403；super_admin 正常

## RB-09 is_admin 收敛 ✅ P3
- **改动**：auth.js:75 isAdmin 改由 roleKey 推导（`role_key IN ('admin','super_admin')`）；users.is_admin 列保留 deprecated（028 回填已一致，不删列）；全仓 grep isAdmin 消费点逐一核对
- **验收**：手动改 users.is_admin 不再影响鉴权结果

## RB-10 whoami 权限键过滤 ✅ P3（whoami 按 category='admin' 过滤；ai.* 键由 roles.js permissions 目录端点承载（RB-11 联动），super_admin ['*'] 归一保留）
- **问题**：A-3——whoami 把 028 的 ai.*/platform.* 8 个死键一并发给前端
- **改动**：index.js whoami SQL 按 category 过滤只回 admin.*（super_admin `['*']` 归一逻辑保留）；ai.*/platform.* 键保留在库（P3-3/方案二 P3-3 的落点）
- **验收**：super_admin whoami 只含 admin.* 或 ['*']

## RB-11 AI 工具权限键化 ✅ P3（2026-09-08 拍板"做就做完善"，已全量实施：迁移 053_ai_tool_permission_keys.sql + 054_ai_perm_descriptions.sql；PERM_CATALOG AI 组 9 键（category='ai'）；aiSystemPrompt TOOL_PERM_REQUIREMENTS 17 工具→键映射；isToolAllowedForPrincipal 双闸门（等级达标 && 未声明键∥持有键）；管理台角色页「AI 能力」分组 + mocks 契约断言；028 预留键启用 destroy_clips→ai.access_other_user_data）
- **前置决策**：是否把 L2/L3 工具映射到权限键（复用 028 已种子 4 个 ai.* 键 + 新增 ai.manage_users/ai.manage_system 等），角色页新增「AI 能力」分组
- **说明**：RB-01 落地后自定义管理员已能拿到整级工具；本项是更细粒度的可选项，建议观察 RB-01 效果后再定
- **改动**（若启动）：assertToolAllowed 升级为「等级达标 && （无声明键 ∥ 有该键）」；PERM_CATALOG 加 AI 分组

---

## 验收总口径

- RB-01 为第一优先：先做先验（1 处传参 + 等级断言），其余按序
- 每工单完成后 `scripts/admin-full-audit/run-audit.mjs` 全绿；RB-06/07 完成后补充"自定义角色 × 权限矩阵"阶段断言
- 迁移（RB-06 的 049）编号与 config-ops 工单的迁移统一递增，避免冲突（谁先合谁占号）
- 全程禁止 mock 数据：所有"已实现"断言必须打真实端点

---

## 工单外补账（2026-09-08 盘点补录，均为已完成项）

### RB-12 管理台单点登录（RB-SSO）✅ P1
- **背景**：用户要求管理员控制台外链做单点登录，且仅唯一超管（13505110772）可用
- **改动**：
  - 服务端 `POST /api/admin/sso/token`（requireRole(100)，签发 32 字节随机 code，Redis SET EX 60s）
  - 服务端 `POST /api/auth/sso-exchange`（匿名端点：GETDEL 原子单次消费防重放 → 校验账号在职 + 管理角色 level≥50 → 复用 createSessionAndGenerateToken 签发正式会话）
  - 桌面端 openAdminConsole：签发 code → 拼 `管理台/sso?code=xxx` → openUrl；失败降级纯外链
  - 管理台新增 /sso 兑换页（独立路由）：自动兑换 → setAuth → 跳 dashboard；sessionStorage 防 StrictMode 双调用；失败展示原因+返回登录
- **API 实测**：签发/兑换/重放 403/非法格式 400/非超管 403 全部通过
- **环境配套**：admin-console vite `host: true` 双栈监听（修复 IPv4 外链连接拒绝）；桌面端外链 hostname 强制 localhost

### RB-13 超管账号治理 ✅
- **内容**：库内核查 13505110772 为唯一 super_admin（roles.level=100 唯一索引约束）；桌面端侧栏徽章 roleKey=super_admin 显示「超级管理员」而非套餐名（修复"免费版"误导显示）；「管理控制台」入口仅超管可见（MA-06 联动）
