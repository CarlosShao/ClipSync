# ClipSync 后台管理系统运行时审计（虚假功能排查）

- **日期**：2026-09-08
- **对象**：运营管理台 `src/admin-console`（前端 http://localhost:5273，后端 http://127.0.0.1:3001）
- **方法**：真实浏览器自动化全流程点击（非代码推测），8 个阶段脚本，覆盖 9 个页面 / 41 个可点击控件 / 60+ 次真实接口调用，并对写操作执行「改动 → 保存 → 接口复查 → 还原」闭环
- **账号**：13505110772 / 验证码 888888（登录后 `whoami` 返回 `roleKey=super_admin`，`roleLevel=100`，21 项 `admin.*` 权限）
- **关联**：[admin-config-audit-2026-09-07.md](./admin-config-audit-2026-09-07.md)（代码级配置审查）、[admin-config-gap-2026-09-08.md](./admin-config-gap-2026-09-08.md)（配置项缺口分析）

---

## 0. 审计环境确认（避免"测了假系统"）

| 项 | 实测结论 |
|---|---|
| 数据来源 | `.env.development.local` 已设 `VITE_ENABLE_MSW=false`，dev 模式**直连真实后端**（Vite proxy → 127.0.0.1:3001），**不是 MSW mock 数据** |
| 后端容器 | `clipsync`（3001）Up，`GET /api/health` 返回 `healthy` |
| 登录链路 | `POST /api/auth/send-code` 200 → `POST /api/auth/verify-code` 200 → `GET /api/admin/whoami` 200 |
| 数据规模 | 用户 23 / 设备 4（在线 0）/ 订单 19（已退款 18、待支付 1）/ 订阅 1 / 审计日志 1217 条 / 角色 4 |
| 数据还原 | 审计中所有写操作已还原：`signup_waitlist=false`、`rate_limit_api_per_min=300`、admin 角色权限原集合、订单 `ORD1788846974084kgtyq1` 回 `refunded`（退款额 1）、`AUDIT-FAKE-DEVICE` 回离线、测试用户回 `active` |

---

## 1. 结论速览

| 类别 | 数量 | 代表问题 |
|---|---|---|
| 🔴 A 类：点击后只弹「后续版本提供」的占位按钮 | 7 | 改套餐 / 调整套餐 / 赠期 / 强制下线 / 删除账户 / 订单导出 / 订单关闭 |
| 🔴 B 类：整卡保存链路失效（可编辑但永远存不进去） | 1 | 系统设置「系统参数」5 张卡（AI 能力、安全与会话、SMTP、日志、界面） |
| 🟠 C 类：指标恒空 / 数字是假的 | 6 | 待处理事项、运维请求数/错误数/p95、公告送达数、enable_signup 开关、admin.keys.view 权限 |
| 🟡 D 类：装饰控件 / 错误跳转 | 3 | 顶栏搜索、通知铃铛、Grafana 跳转指向后端 API 端口 |
| 🟡 E 类：功能可用但文案承诺 > 实际实现 | 5 | 退款不调支付网关、远程下线不断连接、菜单覆盖只写不读等 |

**一句话结论**：后台**主干能力（用户治理、订单查询、审计、角色权限、功能开关、维护模式、限流配置）是真实落库的**；但**用户抽屉的运营动作几乎全是占位**，**系统参数 5 张卡的保存按钮是死的**，**看板/运维有 4 处恒空指标**。用户最容易被误导的是"看着能点、点了也有提示、但什么都没发生"。

---

## 2. 逐页实测矩阵

判定图例：✅ 真实可用 ｜ ⚠️ 部分可用/半实现 ｜ ❌ 虚假/失效 ｜ ➖ 无数据无法验证

### 2.1 数据看板 `/dashboard`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 4 张 KPI 卡（注册用户 23 / 本月营收 ¥358.2 / MRR ¥19.9 / 在线设备 0） | `GET /api/admin/overview` 200，8 段真实 SQL 聚合，与用户页/订单页口径一致 | ✅ |
| 近 14 天订单金额柱图 | ECharts 正常渲染 | ✅ |
| 付费转化环 + Pro/Enterprise 分布 | 真实计算（付费 1 / 总 23） | ✅ |
| 支付渠道占比 | 真实（微信 100%） | ✅ |
| **待处理事项表格** | 恒 `暂无数据`；后端 `overview.js:216` 硬编码 `pendingItems: []` | ❌ |

### 2.2 用户管理 `/users`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 列表 / 分页（8 条 → 3 页） | 翻页请求 `page=2,3` 均 200，数据与 total 一致 | ✅ |
| 筛选（套餐 / 状态 / 注册时间）+ 查询 / 重置 | 实测选「已停用」→ `status=disabled` → 0 条，参数正确透传 | ✅ |
| 详情抽屉（资料 / 设备 / 最近动态） | `GET /api/admin/users/:id` 200，字段完整 | ✅ |
| 通过审核 | `POST /users/:id/approve` 200，Toast「已通过审核，用户现在可以登录」 | ✅ |
| 停用 / 启用 | `PATCH /users/:id/status` 200（`{status,reason}`），列表状态实时由「正常」→「已停用」→「正常」，撤销后恢复 | ✅ |
| **改套餐（列表行）** | 点击只弹 Toast「改套餐将在后续版本提供」，**零请求** | ❌ |
| **调整套餐（抽屉）** | Toast「调整套餐将在后续版本提供」，零请求 | ❌ |
| **赠期 1 个月（抽屉）** | Toast「赠期将在后续版本提供」，零请求（**注：订阅管理页有真实赠期入口，两处矛盾**） | ❌ |
| **强制下线（抽屉）** | Toast「强制下线将在后续版本提供」，零请求（**后端 `POST /users/:id/force-logout` 已实现，前端未接**） | ❌ |
| **删除账户（抽屉）** | 按钮 `disabled`，无请求（**后端 `DELETE /users/:id` 软删已实现，前端未接**） | ❌ |
| 查看审计日志（抽屉） | 仅 `navigate('/audit')` 裸跳转，**不带 userId 过滤**，等于重新打开审计页 | ⚠️ |

### 2.3 设备管理 `/devices`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 统计条（总 4 / 在线 0 / 平台分布） | `GET /api/admin/devices/stats` 200 真实 | ✅ |
| 列表 + 筛选 + 查询/重置 | 正常 | ✅ |
| 远程下线 | 造 1 台在线设备后点击 → `POST /devices/:id/offline` 200，列表状态实时变「离线」，Toast「设备已下线」 | ⚠️（仅改 DB 标志位，不断长连接，见 §3-E2） |

### 2.4 订单与支付 `/orders`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 状态 Tabs + 计数（全部 19 / 待支付 1 / 已支付 0 / 已退款 18） | 每个 Tab 独立 `pageSize=1` 取 total，数字与列表一致 | ✅ |
| 筛选（渠道 / 时间）+ 查询 | 正常 | ✅ |
| 订单详情弹窗 | `GET /api/admin/orders/:orderNo` 200，含状态时间线 | ✅ |
| 对账报告 | `GET /api/admin/reconciliation` 200，三渠道聚合 + 合计 | ✅ |
| 退款 | 造 1 笔 `paid` 订单后点击 → 弹窗默认全额 ¥19.90、原因必填 → `POST /orders/:no/refund` 200，订单转 `refunded` | ⚠️（不调支付网关，见 §3-E1） |
| **导出** | Toast「导出功能将在后续版本提供」，零请求 | ❌ |
| **关闭（待支付订单）** | 按钮 `disabled`，title「自动关单将在后续版本提供」 | ❌ |

### 2.5 订阅管理 `/subscriptions`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 列表 + 统计（active 1 / trialing 0 / 本月到期 0） | `GET /admin/subscriptions` + `/stats` 200 真实 | ✅ |
| 赠期 / 调整套餐弹窗 | 弹窗结构完整（目标套餐 + 延长月数 1–12 + 原因必填），本轮未执行到底（后端 `POST /subscriptions/:id/grant` 为真实写库） | ✅ |
| 查询 / 重置 / 分页 | 正常 | ✅ |

### 2.6 审计日志 `/audit`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 列表 + 筛选（动作 / 操作者 / 结果 / 日期）+ 分页（122 页） | 正常 | ✅ |
| 详情弹窗（含敏感操作标记、details JSON、UA/IP） | 正常，当前操作者 `CarlosShao` 已正确记入 | ✅ |
| **导出 CSV** | 连续 7 次 `pageSize=200` 拉取，Toast「已导出 1,217 条审计日志」 | ✅ |
| 终端用户筛选 | 后端 `audit.js:146` 用 `r.role_key='user'` 且 LEFT JOIN，`role_id` 为空的用户查不到 | ⚠️ |

### 2.7 角色权限 `/roles`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 角色列表（超管 / 管理员 / 自定义 / 普通用户） | `GET /admin/roles` 200 真实，含 level 与人数 | ✅ |
| 权限树（21 项，5 分组）+ 勾选 | 勾选「套餐与价格管理」→ 保存 → `PATCH /roles/:id/permissions` 200 + Toast「权限已保存并写入审计日志」，接口复查已生效，随后还原 | ✅ |
| 高危权限拦截 | 为 level 50 角色勾选「删除账户（高危）」被拦并提示「仅超级管理员（level 100）可持有」 | ✅ |
| 超管角色只读保护 | 选中 super_admin 时权限树与保存/重置按钮均 `disabled`，有说明文案 | ✅ |
| **`admin.keys.view` 权限** | 可勾选但全仓无 `requirePerm` 校验、无承载端点 | ❌（死键） |

### 2.8 系统设置 `/settings`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 功能开关（6 个） | 切换「注册审核」→ `PATCH /api/admin/flags/signup_waitlist` 200 + 审计 + 接口复查 `enabled:false→true`，已还原 | ✅ |
| 维护模式 | 开启 → 原因必填 → `PATCH /configs/maintenance_mode` 200，页面显示「维护中」；恢复 → 「正常运行」，均落库 | ✅ |
| **限流配置卡保存** | 改 `rate_limit_api_per_min` 300→307 → 保存 → `PATCH` 200，复查生效，已还原 300 | ✅ |
| **AI 能力 / 安全与会话 / 邮件 SMTP / 日志 / 界面 5 张卡保存** | 输入框**全部为空**（未回填），修改后点保存恒提示「内容未变化，无需保存」，**零 PATCH 请求** | ❌ |
| 公告下发 | `POST /admin/announcements` 201 落库，但 `deliveredCount=23` 实为**受众人数**，非真实触达；已读/点击恒 0 | ⚠️ |
| SMTP 测试邮件 | 弹窗 → 发送 → `POST /admin/configs/smtp/test` 返回业务错误「收件人邮箱无效（未传 to 且 smtp_user 未配置）」 | ✅（错误提示清晰） |
| 第三方登录卡 | 明示「规划中 · 未实现」占位 | ✅（诚实占位，非虚假） |
| `enable_signup` 开关 | 管理台可切，但服务端**无任何消费方**，注册接口照常放行 | ❌（虚假开关） |

### 2.9 运维监控 `/ops`

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| 服务状态 / 版本 / 运行时长 / 内存 | 真实（`ops/overview` 200，version 0.2.0，uptime 4h29m） | ✅ |
| DB / Redis 探针（连通性 + 延迟） | 真实（PG 2ms / Redis 3ms） | ✅ |
| **请求数 / 错误数 / p95 响应时间** | 三张卡恒显示「**不可用**」；后端 `ops.js:84-88` 调用的 `getMetricsSnapshot` 在 `middleware/metrics.js` 中**根本不存在** | ❌ |
| **近 10 分钟趋势图** | 恒显示「等待下一次轮询采样…」 | ❌ |
| 备份概览 | 恒「暂无备份文件」（`ops/backups` 仅扫描 `backups/` 目录，无备份任务管理） | ⚠️ |
| 慢查询 TOP | 真实接口（`slow-queries` 200，pool 状态正常），当前无慢查询 | ✅ |
| **打开 Grafana 容器总览** | `href=http://localhost:3001` —— **指向 ClipSync 后端 API 端口**，打开是 `{"status":"healthy"...}`，不是 Grafana | ❌ |

### 2.10 全局（顶栏）

| 功能项 | 实测结果 | 判定 |
|---|---|---|
| **搜索：用户 / 订单 / IP** | 纯 `<div>` 装饰，无 `input`、无事件，点击无反应 | ❌ |
| **通知铃铛**（红点 Badge） | 点击零请求、零反应 | ❌ |
| 退出登录 | 清 store 并跳 `/login` | ✅ |
| 菜单权限裁剪 | 按 `whoami` 下发的 21 项权限渲染，9 个菜单全可见（超管） | ✅ |

---

## 3. 虚假功能清单（按严重度）

### 🔴 A 类：点击后只弹「后续版本提供」的占位按钮（7 项）

| # | 位置 | 按钮 | 实测 | 后端是否已有能力 |
|---|---|---|---|---|
| A1 | 用户列表行 | 改套餐 | Toast「改套餐将在后续版本提供」，0 请求 | ❌ 无（需新增套餐变更接口） |
| A2 | 用户抽屉 | 调整套餐 | Toast「调整套餐将在后续版本提供」 | ❌ 无 |
| A3 | 用户抽屉 | 赠期 1 个月 | Toast「赠期将在后续版本提供」 | ✅ 有（订阅页赠期接口 `POST /subscriptions/:id/grant`）→ **重复入口却不做** |
| A4 | 用户抽屉 | 强制下线 | Toast「强制下线将在后续版本提供」 | ✅ 有（`POST /users/:id/force-logout`，真实吊销 session）→ **前端没接** |
| A5 | 用户抽屉 | 删除账户 | `disabled` + 占位 | ✅ 有（`DELETE /users/:id` 软删）→ **前端没接** |
| A6 | 订单页 | 导出 | Toast「导出功能将在后续版本提供」 | ❌ 无（审计页已有 CSV 导出实现，可复用） |
| A7 | 订单行（待支付） | 关闭 | `disabled` + title「自动关单将在后续版本提供」 | ❌ 无 |

**危害**：运营以为"点了就生效"，实际无任何动作也无审计留痕（连失败记录都没有）。
**建议**：
- 后端已有能力的 A3/A4/A5 → **直接接线**到 `UserDrawer/index.tsx:150-189`，成本最低；
- 后端无能力的 A1/A2/A6/A7 → 要么排期实现，要么**从 UI 移除**（比留一个假按钮更诚实），或改为 `disabled + Tooltip「规划中 · 预计 v0.3」`。

### 🔴 B 类：系统参数 5 张卡保存链路整体失效（最严重的功能性 Bug）

**现象**：系统设置页「AI 能力 / 安全与会话 / 邮件（SMTP）/ 日志 / 界面」5 张卡的输入框**全部为空**（未回填当前值），修改任意值后点「保存（记入审计）」恒提示「内容未变化，无需保存」，**不产生任何 PATCH 请求**。

**根因**：`src/admin-console/src/pages/settings/index.tsx`：
- 限流配置卡（第 451 行）用 `<Form form={rateLimitForm}>` 包裹 → 回填与保存**正常**（实测 300→307 落库成功）；
- 系统参数卡（第 536-578 行 `PARAM_GROUPS.map`）**只渲染 `{items.map(renderConfigItem)}`，没有 `<Form form={configForm}>` 包裹** → `Form.Item` 脱离 FormContext。

**证据**：
1. 浏览器控制台稳定复现两条警告：`Warning: Can not find FormContext...` / `Instance created by 'useForm' is not connected to any Form element`；
2. DOM 实测：`#ai_max_tokens`、`#session_timeout_minutes`、`#log_level`、`#smtp_host` 等 value **全为空**，而 `#rate_limit_api_per_min` = `300`（有 Form 的那张卡正常）；
3. `saveConfigGroup()` 因 `form.validateFields()` 拿不到字段 → `diffChanged()` 恒为空 → 走「内容未变化」分支。

**影响**：`ai_max_tokens` / `ai_default_provider` / `session_timeout_minutes` / `audit_log_retention_days` / `log_level` / `menu_overrides` / SMTP 六项 —— **全部无法在后台修改**，只能改库。

**修复**：在 `PARAM_GROUPS.map` 返回的 `<Card>` 内用 `<Form form={configForm} requiredMark={false} labelWrap>` 包裹 `{items.map(renderConfigItem)}`（与限流卡一致）即可；建议顺带补一条断言型单测（表单回填 + 保存触发 PATCH）。

### 🟠 C 类：指标恒空或数字是假的（6 项）

| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| C1 | 看板·待处理事项 | 恒为空数组 | `routes/admin/overview.js:216` `pendingItems: []`（注释自述"后续迭代接入"） |
| C2 | 运维·请求数/错误数/p95 | 恒「不可用」 | `routes/admin/ops.js:84-88` 调用 `getMetricsSnapshot`，而 `middleware/metrics.js` 无此导出（指标其实在采，只是取不到） |
| C3 | 运维·近 10 分钟趋势 | 恒「等待下一次轮询采样…」 | 无数据源 |
| C4 | 公告·送达人数 | `deliveredCount` = 受众人数，非真实触达 | `announcements.js:130-133` `deliveredCount = await countAudience(audience)`，且**不群发**（无推送链路） |
| C5 | 设置·`enable_signup` 开关 | 可切换但服务端零校验，注册照常放行 | 全仓无 `isFlagEnabled('enable_signup')` 调用点（迁移 051 承诺 403 未实现） |
| C6 | 角色·`admin.keys.view` | 可勾选但无承载端点、无校验 | 全仓无 `requirePerm('admin.keys.view')`，也无 `/admin/devices/:id/keys` 端点 |

### 🟡 D 类：装饰控件与错误跳转（3 项）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| D1 | 顶栏「搜索：用户 / 订单 / IP」 | 纯 `<div>`，无 input、无事件 | 要么实现全局搜索，要么删掉（现在的形态最容易被当成"搜索坏了"） |
| D2 | 顶栏通知铃铛（红点） | 点击零反应 | 接公告/告警或移除红点 |
| D3 | 运维·打开 Grafana 容器总览 | `GRAFANA_URL` 兜底为 `http://localhost:3001`，与后端 API 端口冲突，点开是 health JSON | 把 `grafana_url` 纳入后端 CONFIG_CATALOG（可后台配置），并在跳转前做一次可达性探测，不可达时按钮置灰 + Tooltip 说明 |

### 🟡 E 类：功能可用但文案承诺大于实现（5 项）

| # | 位置 | 文案 | 实际 |
|---|---|---|---|
| E1 | 退款弹窗 | 「退款将通过原渠道退回，1–3 个工作日到账」 | 仅 `UPDATE payment_orders` 改状态，**不调用任何支付网关**；财务对账会失真 |
| E2 | 远程下线弹窗 | 「下线后该设备立即退出登录，剪贴板同步中断」 | 仅改 `devices.is_online`，不吊销凭证、不断长连接，客户端下次心跳才生效 |
| E3 | `menu_overrides` 配置项 | 描述为"服务端深合并消费" | 后台可写但**无客户端读取通道**（`useMenuAccess.ts` `setOverrides()` 预留未调用，无只读端点、无 WS 推送） |
| E4 | 用户抽屉·查看审计日志 | 暗示"看这个用户的审计" | 仅 `navigate('/audit')` 裸跳转，不带 `userId` 过滤 |
| E5 | 看板「在线设备（实时）」 | —— | 数值真实，但当前设备心跳/在线判定导致真机长期显示离线（4 台全离线），需另行排查设备在线状态上报 |

---

## 4. 已验证为真的功能（回归基线）

以下功能经真实点击 + 接口复查确认落库，可作为后续回归用例：

1. 验证码登录（send-code → verify-code → whoami 权限下发）
2. 看板 KPI / 订单柱图 / 转化环 / 渠道占比（真实聚合）
3. 用户：列表、分页、三维度筛选、详情抽屉、通过审核、停用/启用（含原因审计）
4. 设备：统计、列表、筛选、远程下线（改库生效）
5. 订单：Tabs 计数、筛选、详情、对账报告、退款（改库生效）
6. 订阅：列表、统计、赠期弹窗（参数与校验完整）
7. 审计：查询、详情、导出 CSV（1217 条）
8. 角色：列表、权限勾选、保存落库、高危权限拦截、超管只读保护
9. 设置：6 个功能开关、维护模式开/关、限流配置保存、SMTP 测试邮件（错误提示正确）、公告落库
10. 权限：路由级 `RequireRole` 守卫与菜单裁剪一致

---

## 5. 为什么这些问题一直没被发现

1. **E2E 冒烟全部处于注释态**：`tests/e2e/smoke.spec.ts` 顶部 `const SMOKE_ENABLED = false`，全部用例 `test.skip`；且断言写的是 mock 数据（12,847 用户 / ¥41,286 / 「退款申请待审核 × 2」），真跑也必然失败。
2. **没有任何"按钮必须有接口调用"的静态/运行时约束**：占位按钮的实现方式是 `onClick={() => message.info('xxx将在后续版本提供')}`，与真实按钮在代码形态上没有区别。
3. **MSW 与真实后端双模**：仓库内有 42KB `mocks/data.ts` + 35KB `mocks/handlers.ts` 的完整假数据，dev 默认关闭，但一旦有人开启 `VITE_ENABLE_MSW`，所有页面会"看似完美工作"，进一步掩盖真实链路缺陷。

**最小整改建议**：
- ① 修 B 类 Form 包裹 Bug（1 行级改动，收益最大）；
- ② 把 A 类中后端已有能力的 3 个按钮（赠期/强制下线/删除账户）接线；
- ③ 移除或明确标注 A 类剩余 4 个 + D 类 2 个装饰控件；
- ④ 给 C 类 4 处恒空指标补实现或加"未接入"角标；
- ⑤ 放开 `smoke.spec.ts` 并把断言改为真实数据断言（至少覆盖：登录、开关保存、限流保存、角色权限保存、审计导出）。

---

## 6. 复现方式

审计脚本运行于 `src/admin-console/`（依赖已装的 `@playwright/test` 与本地 chromium-1234），8 个阶段依次为：
登录与全页快照 → 全控件点击（打开→取消）→ 写操作全链路（角色/开关/参数/维护/公告/SMTP/抽屉/Grafana/退款入口）→ 表单回填与对照保存 → 退款与远程下线（SQL 造数据）→ 订单可见性排查与角色/SMTP 重测 → 退款与 SMTP（中文按钮空格匹配）→ 用户停用/启用与筛选器。

审计结束后临时脚本与产物已清理，本文件中的接口/响应/Toast 摘录即为留档证据。
