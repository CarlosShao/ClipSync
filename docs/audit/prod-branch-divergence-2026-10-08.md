# 生产 vs 分支差异审计（2026-10-08）

- **目的**：2026-10-07 修短信/邮件时，同一功能**连踩 3 个"分支已修、生产没带上"的坑**
  （`POST /admin/configs/sms/test` 端点缺失、该路由依赖的 `generateCode`/`sendVerificationCodeSms`
  没 import、阿里云 SDK 互操作旧实现 ⇒ `Client is not a constructor`）。本审计一次性盘清还有多少这类坑，
  并给出"要不要升级、怎么升级"的可执行结论。
- **方法**：在生产 worktree 上 `git diff HEAD origin/test/admin-full-audit`（服务端）
  + 生产库 `schema_migrations` / `information_schema` 实测（只读，无任何写入）。

## 0. 结论先行

1. 生产 worktree 落后分支 **168 个提交**；`src/server/src` 有 **60 个文件**不同
   （**+5822 / -920 行**）。
2. 生产库**缺 8 个 schema 对象**（下表），但 `schema_migrations` 里 **没有 075-083 的记录**
   ⇒ **不是"改过的迁移不重跑"，而是这些迁移文件从未到过生产**。
   ⇒ **部署分支代码时它们会自动应用**（已核实全部幂等：`IF NOT EXISTS` + 自登记版本）
   ⇒ **schema 会自愈**，不需要手写补丁迁移。（我第一版判断为"被追加内容导致漂移"，是错的——
   直接把整份文件当成"新增行"，已在本文更正。）
3. ⚠️ 但**升这块代码不能只看迁移**：60 个文件里包含认证、支付、限流、审计等多个**修复类**改动，
   升级需要预演 + 冒烟清单（见 §3）。
4. 另有一条**机制性隐患**（078 注释里已记录、值得警惕）：`src/db/migrate.js` 对**旧式数字版本记录**
   有回填逻辑 —— 历史库里形如 `'040'` 的数字记录会让 `040_*.sql` 被判为「已执行」**即使它没跑过**
   （生产库里确实存在 `070`…`074` 这类数字记录）⇒ 这是**结构漂移的另一个入口**，升级前后都要核对。

## 1. 生产库缺的 schema（实测 `information_schema`）

| 对象 | 生产库 | 由哪个迁移创建 |
|---|---|---|
| `clipboard_items.content_diff` | ❌ 缺 | 075_content_diff.sql |
| `user_sessions.updated_at` | ❌ 缺 | 076_user_sessions_updated_at.sql |
| `shared_links.file_key` | ❌ 缺 | 077_shared_links_file_key.sql |
| `ai_settings` 的 memory/custom_system_prompt/parallel/search 六列 | ❌ 缺（回填 078） | 078_ai_settings_columns_backfill.sql |
| `feedback_tickets`（表） | ❌ 缺 | 079_feedback_tickets.sql |
| `ai_model_settings`（表） | ❌ 缺 | 081_ai_model_settings.sql |
| `ai_settings` 的思考强度五档 | ❌ 缺 | 082_thinking_strength_five_levels.sql |
| `ai_model_settings.enabled / alias / sort_order` | ❌ 缺 | 083_ai_model_library_v3.sql |

**影响举例**：`user_sessions.updated_at` 缺失 ⇒「踢出某设备 / 退出所有设备」恒 500（会话从未真正吊销）；
`ai_settings` 那几个列缺失 ⇒ `PUT /api/ai/settings` 整条 42703 ⇒ **所有 AI 设置一起存不进去**。

## 2. 60 个差异文件分类

### A. 整块功能未上线（用户可见的缺失）
- **AI 模型设置 / 模型库 v3**：`routes/aiModelSettings.js`(新)、`utils/aiModelSettings.js`(新)、
  `utils/modelPresets.js`(新)、`utils/modelProbe.js`(新)、`utils/aiLocale.js`(新)、`utils/aiFailure.js`(新)
  + `aiProviders/aiChat/aiChatCore/aiConversations/aiInline/aiOrchestrator/aiSettings/aiTools/aiSystemPrompt`
  的大幅改动 + 迁移 078/081/082/083
- **反馈工单**：`routes/feedback.js`(新)、`utils/feedbackMailer.js`(新)、迁移 079
- **共享链接**：`routes/sharedLinks.js`、迁移 077

### B. 修复类未上线（风险最高，必须逐条看）
| 域 | 文件 |
|---|---|
| 认证 / CSRF | `routes/auth.js`(+146/-107)、`auth-password.js`、`auth-session.js`、`middleware/auth.js`、`middleware/csrf.js` |
| 资金 | `routes/payments.js`、`services/refund.js`、`services/orderCloseSweep.js` |
| 限流 / 审计 / 加密 | `middleware/rateLimiter.js`(+173/-60)、`utils/audit.js`、`utils/encryption.js` |
| 订阅 / 权限 | `middleware/subscriptionCheck.js`、`middleware/planFeature.js` |
| 同步 / 实时 | `routes/sync.js`、`routes/clipboard.js`、`ws/server.js`、`utils/redis-map.js` |
| 其它 | `routes/device.js`、`media.js`、`invoices.js`、`favorites.js`、`sessions.js`、`versions.js`、`config.js`、`index.js`、`db/migrate.js`、`middleware/adminAuth.js`、`utils/email.js`、`utils/searchProviders.js`、`utils/versionManager.js`、`utils/aiOcr.js`、`routes/admin/overview.js` |

### C. 已被"按需 backport"打补丁的（与分支**不等价**，仍显示为差异）
`routes/admin/configs.js`、`utils/sms.js`、`utils/email.js`、`index.js` 等 —— 今天为修生产问题
逐个用锚点式补丁对齐了**行为**，但不是字节级一致（生产还落后 273 个文件时 `git apply` 会冲突）。
⇒ 一次完整升级会把这些补丁**收敛回单一来源**，正是升级的价值之一。

## 3. 建议路径（推荐：一次完整升级，但先预演）

**为什么不建议继续按需 backport**：今天证明它每次都要人工判断锚点、且**只能修已知的坑**；
60 个文件里未暴露的（认证/资金/限流）没有被"需要时"的机会 ⇒ 风险是**隐性**的。

**步骤（每步都有验收）**
1. **预演（本地/影子）**：用分支代码 + **生产库的 dump** 起一套，跑迁移 + 冒烟 → 确认
   075-083 干净应用、缺的 8 个对象被创建、服务能起、AI 设置/分享/反馈可用。
2. **备份**：`backup-prod` 的 dump + 手工再打一份（记录文件名与大小）。
3. **窗口升级**：停 api → 拉分支代码 → 起（迁移自动跑）→ 观察日志
   （重点看 `schema_migrations` 是否新增 075-083、是否有 42703/42P01 报错）。
4. **冒烟清单**：登录/发码（短信已修好）、订单与退款、AI 设置保存、分享链接创建+撤销、
   反馈提交、踢出设备、WebSocket 同步。
5. **客户端兼容**：桌面端 0.1.1 与分支服务端的契约 —— 今天那些端点都是**新增**的（向后兼容 ✓）；
   AI 模型设置那块即使客户端不升级也无副作用（新端点无人调用）。

**若暂时不想升级**：至少定期跑一次本审计（一条命令即可复现），并把"新发现的坑"登记到本文件。

## 4. 复现命令（只读）

```bash
# 生产 worktree 上
git fetch origin test/admin-full-audit
git diff --shortstat HEAD origin/test/admin-full-audit -- src/server/src
git diff --name-only HEAD origin/test/admin-full-audit -- src/server/src | sort
git log --oneline HEAD..origin/test/admin-full-audit | wc -l

# 生产库里核对 schema
docker exec clipsync-postgres-prod psql -U clipsync -d clipsync \
  -c "SELECT version FROM schema_migrations WHERE version ~ '^0(7|8)' ORDER BY version"
```

## 5. 变更记录
- **2026-10-08**：首次审计（起因：同一天在同一功能上连踩 3 个"已修未上线"的坑）。
  更正：初判"迁移被追加内容导致漂移"错误 —— 实为迁移文件从未到过生产，且会自愈。
