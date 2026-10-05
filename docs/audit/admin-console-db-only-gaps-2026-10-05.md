# 管理台「不改库就做不了」的缺口盘点（2026-10-05）

> **起因**：owner 误给某用户赠期一个月 Pro，想收回，发现后端只有
> `POST /api/admin/subscriptions/:id/grant`（**单向**：只会前移档位 + 延长期限），
> 没有任何 revoke/降级端点 —— **只能改库**。于是顺手做了一次系统盘点：
> 还有多少同类「出事时只能找 DBA」的运维/客服动作。
>
> **本文档的性质**：分级建议清单，供排期；不是缺陷报告 —— 其中大部分是
> **从未实现**的能力，不是坏掉的功能。凡「已实现但缺 UI」的都单独标出来了。

---

## 0. 盘点口径与可信度

**什么算缺口**：管理台（或任何 HTTP 端点）**没有落点**，只能直接改生产库才能完成的运维动作。

改库为什么不能当常规手段（三条，按严重度）：

1. **不写审计** —— `audit_logs` 是这套系统的追责底座，改库留不下痕迹；
2. **多列一致性** —— 例如换手机号要同时改 `phone` / `phone_hash` / `phone_encrypted` 三列
   （口径见 `src/server/src/routes/auth.js:1047-1067` 的注册写入），人工改必错；
3. **复合事务** —— 例如补履约要复刻 `services/orderFulfillment.js` 的整段事务
   （订阅 + 发票 + `users` 快照），漏一步就是数据不一致。

**可信度说明**：清单来自一轮**只读代码盘点**（逐端点核对 + 前端调用方搜索）。
其中 4 条最关键的**已由我本人复核**并给出证据：

| 复核项 | 复核方式 | 结论 |
|---|---|---|
| 角色分配无 UI | 全仓搜 `reset-2fa` / `/role'` / `changeRole` / `assignRole` | **0 命中**（端点存在、前端零调用） |
| 管理员代重置密码 | `routes/admin/*.js` 搜 `password_hash` | **0 命中**（无端点） |
| 手动补履约 | `routes/admin/*.js` 搜 `markOrderPaid` | 仅 `overview.js:322` 一句注释，**无端点** |
| 手机号换绑 | `routes/admin/*.js` 搜 `phone_hash` / `phone_encrypted` | 仅注释与导出读取，**无写路径** |

另外两条与**既有审计**重合，本文档只是补上「还没做」的现状：
`docs/audit/v1-full-audit-2026-09-22/13-cross-end-contract-consistency.md:252`
已经记过「无法改角色、无法解救 2FA 丢失用户（客服流程缺口）」。

---

## 1. 高：出事时无替代路径

| 缺口 | 现状证据 | 为什么要紧 | 建议 |
|---|---|---|---|
| **管理员代重置密码** | `routes/admin/` 无 `password_hash` 写入；用户侧只有需验证码的 `auth.js` reset-password，或需旧密码的 change-password | 手机 + 邮箱双失效 ⇒ **账号永久锁死**，客服无任何办法 | `POST /users/:id/reset-password`：生成一次性密码（或强制下线 + 重置），理由必填、写审计、通知本人 |
| **手机号 / 邮箱换绑** | `routes/admin/` 只有列表**搜索**用到 phone（`users.js:284`）；无写路径。而手机号是登录标识 | 用户换号就登不上；**改库要同时动三列**（见 §0） | `POST /users/:id/rebind`（phone/email 二选一，复用注册时的 hash/encrypt 口径） |
| **手动补履约** | 履约只由渠道回调（`paymentWebhooks.js`）或**用户自己**查单兜底（`payments.js`，限定 `user_id=自己`）触发；admin 侧 0 落点 | 渠道回调丢失 = **钱到了、货没到**；目前只能等用户自己点开订单页触发兜底 | `POST /orders/:orderNo/fulfill`：**先 `queryTrade` 向渠道确认到账**再调 `markOrderPaid`，superAdminOnly + 审计 |
| **开票信息补录** | `invoices` 有 `title/tax_no` 列但履约链路从不写入（`utils/pdf-invoice.js` 注释自证）；admin 侧搜 `invoice` = 0 | 收据文案却写着「如需增值税发票请联系客服提供开票信息」⇒ **客服被文案指引却无工具**（合规面） | `PATCH /admin/invoices/:id`（补 title/tax_no + 重新生成） |

## 2. 中：有绕路，但麻烦或易错

| 缺口 | 现状 | 建议 |
|---|---|---|
| **订阅周期人工收窄** | `grant` 只能延长（`GREATEST(period_end, NOW()) + months`）；`revoke` 对**有已付订单**的订阅一律 409（保护闸，正确）。「既有已付单、又被误赠」的混合场景仍是改库 | 保持保护闸；补 `mode=shorten_to_paid_end`（按剩余付费期重算 `period_end`） |
| **单用户配额覆盖** | 限额只来自套餐行（`utils/planLimits.js`）；`PATCH /plans/:id` 是**改全套餐所有人** | per-user override（列或表）+ `POST /users/:id/limits` |
| **违规昵称/头像处置** | admin 无任何 profile 写端点；管理员只能停用/删号 | `PATCH /users/:id/profile`（清空/替换，写审计）——比停用整个账号比例适当 |
| **设备强制解绑** | `devices.js` 只有 `offline`（不断开设备行），设备仍占 `max_devices` 配额；而权限目录文案已承诺「远程下线 **/ 解绑**」（`admin/roles.js:43`） | `DELETE /devices/:id`，或把权限目录文案改掉（**两者选一，别留着自相矛盾**） |
| **合并重复账号** | `mergeDuplicateAccounts` 只在登录时自动触发，且默认**关闭**（`IDENTITY_MERGE_ENABLED !== 'true'` 直接 return）；无 admin 入口 | `POST /users/merge`（手动指定 canonical/duplicate，避开"按昵称/未验证邮箱匹配"的窃取风险） |
| **公告撤回** | announcements 只有 POST/GET；客户端拉取「最新 20 条」**无撤回过滤** | `POST /announcements/:id/withdraw`（软撤回 + 拉取侧过滤）；硬删可行但会丢送达/已读统计 |
| **试用重置/再赠** | 试用「终身一次」以「存在任何 `user_subscriptions` 行」判定；admin 无重置端点，grant 也只能给正式套餐 | `POST /users/:id/trial`，或给 grant 加 `asTrial` 参数 |

## 3. 低：维持改库可接受（**建议别补**）

| 缺口 | 为什么可以不改库也可接受 |
|---|---|
| **手动改订单状态（pending→paid/cancelled）** | **审计里明确记着这条口径已被取消**（`admin-console/src/placeholders.ts` AF-15：改为服务端超时自动关单）。且手动置 `paid` 等于**伪造履约**，是资损面。关单已有 `orderCloseSweep` 自动兜底 |
| AI 供应商删除 | BYOK 行属用户自己的 key，`enabled=false` 已能全链路屏蔽 |
| 角色删除/改名 | 角色极少增删，且删角色要处理 `users.role_id` 外键；一次性 SQL 更可控 |
| 新建套餐 | 新套餐通常伴随定价与功能位设计，走迁移更可控 |
| 审计/看板/对账目录只读 | **本就应该只读**，非缺口 |

## 4. 已覆盖：别重复补

| 场景 | 已有落点 |
|---|---|
| 退款卡 `processing` 的重试 | 重复调 `POST /refund-reviews/:id/approve`（CAS 抢单 + 冷却；前端已有提示） |
| 无用户申请的订单手动退款 | `POST /orders/:orderNo/refund`，且放宽到「渠道已确认收款的 pending/cancelled」 |
| 发布包下架 / 回滚 | `PATCH /releases/:id` 切 `is_published=false` 即撤回；拉取侧取最高已发布版本 ⇒ 撤掉新版自动回落 |
| **收回人工授予的权益** | **2026-10-05 已补**：`POST /api/admin/subscriptions/:id/revoke`（含付费单保护闸） |
| **对单个用户定向通知** | **2026-10-05 已补**：`POST /api/admin/users/:id/notify` |

## 5. 纯缺 UI（端点早就存在，成本最低）

| 端点 | 现状 |
|---|---|
| `PATCH /api/admin/users/:id/role` 分配角色 | 端点 + 权限键 + 审计齐全；`api/users.ts` 无对应函数，前端 0 调用 |
| `POST /api/admin/users/:id/reset-2fa` 重置两步验证 | 同上（`13-cross-end-contract-consistency.md:252` 已记为客服流程缺口） |

## 6. 建议排期

1. **两个纯缺 UI**（角色分配、重置 2FA）—— 后端零改动，几乎零风险；
2. **管理员代重置密码 + 手机号换绑** —— 用户救援刚需，且换绑改库必错；
3. **手动补履约** —— 资金/权益对账的唯一人工出口（务必先向渠道确认到账）；
4. **开票信息补录** —— 客服被产品文案主动引向的能力空洞；
5. 中/低档按实际工单量再排。

---

## 附：2026-10-05 本轮已落地的两项

| 端点 | 关键设计 |
|---|---|
| `POST /api/admin/subscriptions/:id/revoke` | **保护闸**：该订阅有真实已付订单（`status='paid'`）一律 409，引导走退款审核 —— 用户花钱买到的权益不能在管理台点一下就没收。只处理人工给出去的部分（赠期/mock/补偿）。`mode` 两档（立即/期末）；原因必填；审计 `admin.subscriptions.revoke` 带 `paidOrders:0` 自证 |
| `POST /api/admin/users/:id/notify` | 复用 `sendNotification`（落 `notification_history` + WS 实时推）；类型走服务端白名单（四类都落在客户端**已有**分类上 ⇒ 不需要客户端升级）；刻意**不**检查 `notification_preferences`（那是产品推送开关，不该屏蔽客服直接告知） |

两项都已登记进高危写限流名单 `ADMIN_STRICT_WRITE_PATTERNS`（`routes/admin/index.js`）。

> ⚠️ **遗留**：管理台 dev 的 MSW mock 层**没有**这两个端点的 handler ⇒ 在 mock 模式下
> 这两个按钮会失败。生产/真实后端不受影响（owner 本机 `VITE_ENABLE_MSW=false`）。
