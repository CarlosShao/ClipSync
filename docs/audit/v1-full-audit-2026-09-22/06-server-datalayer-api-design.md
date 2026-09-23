# 数据层 / API 设计 / 校验 / 错误处理 审计

> 审计范围：`src/server/src/db/**`、`src/server/src/config*`、`src/server/src/validation/**`、`src/server/src/utils/**`、`src/server/src/middleware/{metrics,request-id,maintenance,idempotency,auth,csrf,rateLimiter}.js`、`src/server/src/index.js`、`src/server/src/routes/{app,health,metrics,templates,templateVariables,surveys,sync,clipboard,media}.js`、`src/server/src/routes/admin/**`、`scripts/init-db.sql`、`scripts/migrations/**`、`src/server/{package.json,vitest.config.js,check-syntax.js,fix-*.js}`、`.env.*.example`、`src/server/tests/**`
> 审计方式：只读静态分析（Read / Grep / Glob / 只读 bash）。未运行测试、未启动服务、未接触 docker。
> 排除项已读：`docs/audit/external-dependency-audit-2026-09-09.md`、`docs/production-roadmap/external-dependencies.md`。凡「需要云资源」的缺口（Sentry/APM、Vault、PG/Redis 单实例 SPOF、对象存储、SMS/SMTP/CAPTCHA/OAuth）本报告不重复计入问题项，仅在「设计层面的观察」一句带过。
> 报告中不出现任何真实凭据的值。

## 结论（≤3 句）

**后端骨架不能上 v1。** 有 2 个 S0：①`pool.query('BEGIN')` 伪事务让「先 DELETE 全部消息再逐条 INSERT」的 AI 会话保存接口在中途失败时**不可回滚地销毁用户数据**，同时把带开放事务的连接扔回连接池污染后续无关请求；②生产配置校验只 `console.warn` 不 fail-fast，且 JWT 密钥黑名单不含仓库里公开的 compose 默认值——而 `src/server/.env.test` **已被 git 跟踪**并含真实密钥，等于签名密钥公开、可伪造任意用户 token。另有 11 个 S1，其中 4 条是「代码依赖某列但 schema 里没有」——`clipboard_items.image_hash`（迁移版本号 `031` 撞车被永久吞掉 → 核心写入 500）、`clipboard_items.content_diff`（只有从未被调用的 `migrate-manager.js` 会建 → 增量同步全断）、`c.type/c.content/c.is_archived`（AI 工具）、`user_sessions.updated_at`（**会话撤销/强制下线/全端登出三个安全操作 100% 失效**）——**全部只在全新库（=生产库）暴露**：dev 库因历史手工执行过而正常，测试因 mock 掉 pool、桩掉 auth 而全绿。

**统计：S0 × 2，S1 × 11，S2 × 21，S3 × 8（共 42 条）。**
修复优先级建议：**S1-11（3 行 SQL，救回一个安全控制）→ S0-1（事务范式，防数据销毁）→ S1-1/S1-2/S1-3（4 条 schema 缺陷，一次迁移 + 3 处改名）→ S0-2（配置 fail-fast + 密钥轮换）→ S1-5（限流 XFF）→ 其余。**

---

## 问题清单（按严重度从高到低）

### [S0-1] `pool.query('BEGIN')` 伪事务：AI 会话保存接口会不可回滚地删除用户消息，并把 idle-in-transaction 连接扔回池

- **证据**：`src/server/src/routes/aiConversations.js:303`（路由声明）、`:323`、`:325-329`、`:367`、`:370`
  ```js
  router.post('/:id/messages', apiLimiter, async (req, res) => {
  ...
      await pool.query('BEGIN')                       // :323
      try {
        await pool.query(
          `DELETE FROM ai_messages
           WHERE conversation_id = $1
             AND COALESCE(metadata->>'is_context_summary', 'false') <> 'true'`,
          [id],
        )                                             // :325-329  全量删除
        for (const m of messages) { ... await pool.query(`INSERT INTO ai_messages ...`) }  // :333-364 逐条重插
        await pool.query('COMMIT')                    // :367
      } catch (txErr) { await pool.query('ROLLBACK'); throw txErr }   // :370
  ```
  `pool.query()`（node-postgres）的语义是「从池里取一条连接 → 执行 → 立刻归还」。因此 `BEGIN`、`DELETE`、每一次 `INSERT`、`COMMIT`、`ROLLBACK` **各自跑在不同的物理连接上，每条都是独立的 autocommit 语句**。同一缺陷另有两处：
  - `src/server/src/routes/favorites.js:116` / `:125` / `:127`（收藏夹批量重排）
  - `src/server/src/routes/aiTools.js:3795` / `:3803` / `:3805`（AI 工具 `reorder_collections`）

  对照：全仓其余 11 处事务（`clipboard.js:632`、`sync.js:50`、`services/orderFulfillment.js:89`、`services/refundRequest.js:155/420/479`、`services/refund.js:257`、`utils/versionManager.js:47/187`、`routes/admin/roles.js:338`、`routes/aiProviders.js:153/231`、`db/migrate.js:220`、`db/reset.js:8`）都正确使用了 `const client = await pool.connect()` + `finally { client.release() }`。**连接泄漏一处没有**——逐文件核对 `pool.connect()` 与 `.release()` 计数（11 个文件，全部 1:1）并确认每处 `release()` 都在 `finally` 块内。问题纯粹是这 3 处根本没取 client。

- **失败场景**：
  1. 用户 A 有一个 200 条消息的 AI 会话，桌面端调 `POST /api/ai/conversations/<id>/messages` 全量保存。
  2. `:325` 的 `DELETE` 在连接 #7 上**立即提交**——200 条消息此刻已从库里消失。
  3. 循环逐条 `INSERT`（N+1，200 次往返），跑到第 37 条时命中 `db/pool.js:33` 的 `SET SESSION statement_timeout = 30000`，或 `connectionTimeoutMillis: 2000`（`pool.js:15`）取不到连接（池 `max` 默认 50，集群模式下还要除以 worker 数，见 `index.js:606`），或 `messages` 里某条内容触发约束错误。
  4. `catch` 执行 `pool.query('ROLLBACK')`——落在连接 #23 上，PG 回一句 `WARNING: there is no transaction in progress`，**什么都没回滚**。
  5. 客户端收到 `500 {"error":"Failed to save messages"}`（`:375`）。会话永久只剩 36 条消息，**无法恢复**。

  另两条并发后果：
  - `messages` 数组**无长度上限**（`:308` 只校验 `Array.isArray && length>0`），受限于 `index.js:174` 的 `express.json({limit:'10mb'})`，即可塞进上万条消息 → 上万次串行 INSERT。`index.js:184-216` 的 `REQUEST_TIMEOUT=30000` 到点只发 408 响应头，**不会中断循环**，服务端继续插入；随后 `:368` 的 `res.status(201).json()` 撞 `ERR_HTTP_HEADERS_SENT` → 再进 catch → 再发一次响应。
  - `:323` 那条 `BEGIN` 所在的连接执行完 `BEGIN` 就被归还池中，**事务从未关闭**。下一个不幸抽到它的请求，其 SQL 会加入这个永不提交的事务：行锁一直持有、WAL 无法回收、autovacuum 对该表停摆。反复调用可累积到 `max_connections` 打满 → 全站不可用。`docker-compose.multi.yml` 跑两个 api 实例，`index.js:598-613` 还支持 `CLUSTER_WORKERS=auto`，放大系数 = 实例数 × worker 数。

- **影响**：**数据（不可逆用户数据销毁）+ 可用性（连接池中毒 → 全站 500）+ 钱**（AI 会话历史是 `enable_ai_agent` 门控的付费能力核心资产）。本次审计最严重的一条。

- **修法**：三处一律改成 `const client = await pool.connect(); try { await client.query('BEGIN'); /* 所有语句都用 client */ await client.query('COMMIT') } catch { await client.query('ROLLBACK').catch(()=>{}); throw } finally { client.release() }`；`aiConversations.js` 的逐条 INSERT 合并成单条多值 `INSERT ... VALUES (...),(...),...`（或 `unnest($1::uuid[], $2::text[], ...)`）消除 N+1；对 `messages.length` 加上限（建议 ≤500，超限 400）。同时加一条静态检查/单测禁止 `pool.query('BEGIN'|'COMMIT'|'ROLLBACK')` 出现。

---

### [S0-2] 生产必填配置只 warn 不 fail-fast，JWT 密钥黑名单漏掉仓库公开的 compose 默认值；`src/server/.env.test` 已被 git 跟踪并含真实密钥

- **证据**：
  - `src/server/src/config.js:85-105` —— 生产校验的全部后果是 `console.warn`：
    ```js
    if (nodeEnv === 'production') {
      const warnings = [];
      if (!config.jwt.secret || config.jwt.secret === 'clipsync-dev-secret') {
        warnings.push('JWT_SECRET must be set in production (not using dev default)');
      }
      ...
      if (warnings.length > 0) {
        console.warn('⚠️  Production configuration warnings:');
        warnings.forEach(w => console.warn(`  - ${w}`));
      }
    }
    ```
    没有 `process.exit(1)`。对照 `utils/encryption.js:25-39` 对 `ENCRYPTION_KEY` 是**正确的 fail-fast**（`process.exit(1)`），说明这是遗漏而非风格选择。
  - `config.js:13-14` —— `NODE_ENV` 未设置时静默落到 development 配置：
    ```js
    const nodeEnv = process.env.NODE_ENV || 'development';
    const envConfig = envConfigs[nodeEnv] || developmentConfig;
    ```
    未知值（如 `prod`、`Production`）同样静默回退 development。此时 `jwt.secret='clipsync-dev-secret'`、`cors.origins='*'`、`db.password='<REDACTED:DB_PASSWORD>'`、`logLevel='debug'`，且**整段生产校验被跳过**；`index.js:111-113` 的 CORS 变成「反射任意 Origin」同时 `credentials: true`（`:127`）。
  - `docker-compose.dev.yml:87` —— `JWT_SECRET: ${JWT_SECRET:-<REDACTED:JWT_SECRET>}`，默认值硬编码在仓库里；这个字符串**不在 `config.js:87` 的黑名单里**（黑名单只有 `'clipsync-dev-secret'`）。
  - `.gitignore:15` —— `!.env.test` 显式取消忽略；`git ls-files --error-unmatch src/server/.env.test` 返回 **TRACKED**。该文件含 `DB_PASSWORD`、`REDIS_PASSWORD`、`JWT_SECRET`、`ENCRYPTION_KEY`、`CSRF_SECRET` 五项真实值。经安全比对（不打印明文）确认其 `JWT_SECRET` 与 `docker-compose.dev.yml:87` 的默认值**逐字符相同**。
  - `src/server/src/middleware/auth.js:30` —— `jwt.verify(token, config.jwt.secret)`；payload 只需 `{userId}`（`auth.js:41-42` 直接 `req.userId = decoded.userId`；`:57` 的 `LEFT JOIN user_sessions s ON s.id = $2` 对不存在的 jti 返回 `session_active = NULL`，`:69` 的 `=== false` 判定不成立 → 放行）。

- **失败场景**：运维照 `docker-compose.dev.yml` 起一套对外可达的环境（或生产部署漏配 `JWT_SECRET` 而 compose 的 `:-` 默认值生效），启动日志只多出一行 warn（或一行都没有，因为该值不在黑名单里），服务照常 200。任何读过这个公开仓库的人本地执行
  `jwt.sign({ userId: '<受害者 users.id>' }, '<仓库里公开的 dev JWT 密钥>', { expiresIn: '7d' })`，
  带上 `Authorization: Bearer <该 token>` 即可读取/修改/删除该用户全部剪贴板、设备、订阅、AI 供应商 API Key 密文。若目标是 `028_roles.sql:66-69` 硬编码为 `super_admin` 的那个手机号账号（见 S3-5），直接拿到管理台全部权限。
  第二条路径：`.env.test` 里的 `ENCRYPTION_KEY` 同样是公开值，而 `routes/auth.js:30` 的 `HASH_SALT = process.env.ENCRYPTION_KEY?.substring(0, 16)`——盐一旦公开，`users.phone_hash` 就是可对约 10^9 量级手机号空间秒级暴破的普通加盐 SHA-256（见 S2-13）。

- **影响**：**安全（任意账户接管 / 权限提升）+ 合规（密钥入库）**。属任务定义中「生产用了不安全默认值」与「必填配置缺失时静默用默认值跑起来」两条 S0 判据的交集。

- **修法**：`config.js` 生产分支改为 fail-fast（收集到任何 warning 即 `logger.error(...)` + `process.exit(1)`），黑名单换成「最小长度 32 + 已知弱值集合（含 `<REDACTED:JWT_SECRET>`、`dev_encryption_key_32chars_min!!`、`clipsync-dev-secret`、`clipsync-test-secret`）」；`nodeEnv` 遇未识别值直接退出而不是回退 development；`git rm --cached src/server/.env.test` + 删掉 `.gitignore:15` 的 `!.env.test`，并**轮换其中全部五项密钥**；`docker-compose.dev.yml` 的 `:-默认值` 改为无默认（缺失即启动失败）。

---

### [S1-1] 迁移版本号撞车：`031_image_hash.sql` 被 `031_ai_provider_context_window.sql` 永久吞掉 → 全新库缺 `clipboard_items.image_hash` → 核心写入 `POST /api/clipboard` 恒 500

- **证据**：`src/server/src/db/migrate.js:245` 用文件名首段做版本主键：
  ```js
          const version = file.split('_')[0]; // 提取版本号（如 "004"）
          const result = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
          if (result.rows.length === 0) { ...执行并 INSERT version... } else { ...(skipped, already applied)... }
  ```
  `src/server/src/db/migrations/` 下 70 个 `.sql` 文件里，版本号唯一重复的就是 `031`（`ls *.sql | awk -F_ '{print $1}' | sort | uniq -c | awk '$1>1'` → `2 031`）：
  - `031_ai_provider_context_window.sql:3` → `ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS context_window INTEGER;`
  - `031_image_hash.sql:4` → `ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS image_hash VARCHAR(64);`

  `migrate.js:242` 按文件名排序，`031_a...` < `031_i...`，前者先跑并把 `version='031'` 写进 `schema_migrations`；后者从此**在每一个新库上都被判为「已应用」而跳过**，日志只打一行 `(skipped, already applied)`。
  全仓只有 `031_image_hash.sql` 建这一列（`grep -rn image_hash db/migrations/*.sql` → 仅 `031` 命中），`scripts/init-db.sql` 也没有。消费方是核心写入 `src/server/src/routes/clipboard.js:687-691`：
  ```js
      const result = await client.query(
        `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, content_hash, image_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ```

- **失败场景**：`docker-compose.prod.yml` 的 postgres 服务**没有挂载 `init-db.sql`**（只有 `docker-compose.dev.yml:25` 挂了 `./scripts/init-db.sql:/docker-entrypoint-initdb.d/init-db.sql:ro`），全新生产库完全依赖 `migrate.js`。首次部署后任意登录用户复制一段文本 → 桌面端 `POST /api/clipboard` → PG 报 `column "image_hash" of relation "clipboard_items" does not exist` → `clipboard.js:723-729` 捕获 → `500 {"error":"Failed to create clipboard item"}`。**产品的核心动作 100% 失败**。dev 库因历史上手工执行过 031 而正常；`tests/admin/*.test.js` 全部 `vi.mock('../../src/db/pool.js')`（见 `tests/admin/audit.test.js:23-26`），mock 掉的 pool 永远不会报列不存在，测试全绿。

- **影响**：**可用性（核心写入全挂）+ 数据（同步链路完全不可用）**。只在生产首次部署时暴露，是「上线当天才发现」的最典型形态。

- **修法**：把 `031_image_hash.sql` 重命名为未占用的版本号（如 `075_image_hash.sql`）；`migrate.js:245` 改用**完整文件名**做版本主键（`version = file.replace(/\.sql$/,'')`），并在启动时检测 `schema_migrations` 里的重复前缀后 fail-fast。补一条启动自检：把代码里静态可提取的 INSERT/UPDATE 列名与 `information_schema.columns` 交叉校验（见「建议补充的功能」#1）。

---

### [S1-2] `clipboard_items.content_diff` 没有任何生效迁移会创建 → `GET /api/sync/pull/:deviceId` 恒 500、`POST /api/sync/push` 整批失败并丢数据

- **证据**：`grep -rn content_diff src/server/src/db/migrations/*.sql src/server/src/db/migrate.js scripts/init-db.sql` → **零命中**。唯一建列处是一个从未被调用的并行迁移系统 `src/server/src/db/migrate-manager.js:65-69`：
  ```js
      description: 'Add content_diff column for incremental sync',
      migrations: [
        `DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clipboard_items' AND column_name = 'content_diff') THEN
            ALTER TABLE clipboard_items ADD COLUMN content_diff TEXT DEFAULT NULL;
  ```
  `migrate-manager.js` 的引用者只有它自己（`:421` 的 `process.argv[1].includes('migrate-manager')` CLI 守卫）；`index.js:43` 只 `import migrate from './db/migrate.js'`，`package.json:15-16` 只有 `db:migrate`/`db:seed`，`Dockerfile` 的 `CMD` 是 `["node","src/index.js"]`。**没有任何路径会执行它。**
  消费方共 4 处，全在增量同步主链路 `src/server/src/routes/sync.js`：
  - `:125` `content_diff = $4,`（`UPDATE clipboard_items`）
  - `:265`、`:281` `ci.content_diff,`（`GET /api/sync/pull/:deviceId` 的 since 分支与全量分支，路由声明在 `:239`）
  - `:310` `contentDiff: item.content_diff, // Incremental sync support`

  全仓 `ci.*` 列引用共 20 个不同列名，与 `clipboard_items` 真实 schema 逐一比对后**唯一对不上的就是 `content_diff`**。

- **失败场景**：
  - **拉取侧**：设备重连后调 `GET /api/sync/pull/<deviceId>?since=2026-09-22T00:00:00Z` → `:265` 的 SELECT 触发 `column ci.content_diff does not exist` → `sync.js` 外层 catch → `500`。**每次增量同步都失败**，客户端只能反复重试或退回全量拉取（`:281` 同样带该列，也 500）。
  - **推送侧（会丢数据）**：离线队列 flush `POST /api/sync/push`，`changes` 里含一条 `action:'update'` → `:125` 的 UPDATE 报错 → `:152-158` 的**逐条**内层 catch 把它记成 `{status:'error'}` 然后 `continue`，但此时 PG 事务已进入 aborted 状态（`current transaction is aborted, commands ignored until end of transaction block`），**同一批里后续所有 create/update/delete 全部失败**，`:162` 的 `COMMIT` 也失败 → 外层 `:163-166` `ROLLBACK` + rethrow → `500 {"error":"Sync push failed"}`。用户离线期间攒的最多 50 条变更（`:34-36` 的上限）**一条都没落库**。
  - 附带：内层 catch 把 `err.message`（PG 原始报错，含 SQL 片段与列名）直接塞进响应的 `results[].error` 返回客户端（`:155`），属内部细节泄漏。

- **影响**：**可用性（增量同步全断）+ 数据（离线队列整批丢失）+ 安全（错误信息泄漏）**。

- **修法**：新增 `076_clipboard_content_diff.sql`（`ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS content_diff TEXT;`）；删除或彻底废弃 `db/migrate-manager.js`（两套迁移系统是本次多条 schema 漂移的共同根因，见 S3-2）；`sync.js` 的内层 catch 在事务里必须改为「记录 + `ROLLBACK` + 中断整批」或用 `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`，绝不能在 aborted 事务上继续执行；`results[].error` 改为错误码而非 `err.message`。

---

### [S1-3] `aiTools.js` 引用 `clipboard_items` 三个不存在的列（`type` / `content` / `is_archived`）→ AI 工具 `find_duplicates`、`export_data` 恒失败

- **证据**：`src/server/src/routes/aiTools.js:2112-2117`
  ```js
        let query = `
          SELECT c.id, c.type, c.content, c.content_preview, c.created_at, c.is_favorite
          FROM clipboard_items c
        `
        const params = [userId]
        let whereClauses = ['c.user_id = $1', 'c.is_archived = FALSE', "COALESCE(c.protection_level, 'none') = 'none'"]
  ```
  同样的三行在 `:2248-2253`（`export_data`）重复一次。
  `clipboard_items` 的真实列名是 `content_type` / `content_encrypted` / `archived`（`db/migrate.js:58-59`；`:206` 的 `ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`；同项目 `routes/clipboard.js:688` 的 INSERT 用的就是正确列名）。
  交叉核对：`grep -rhoE "\bc\.[a-z_]+" routes/aiTools.js | sort -u` → `content content_preview created_at id is_archived is_favorite metadata protection_level type user_id`，其中 `content`、`is_archived`、`type` **三个不存在**。`aiTools.js` 自身其余 30+ 处查询用的都是正确的 `content_type` / `archived`（如 `:2390`、`:2480`、`:2509`、`:3085`），说明这 2 个 case 是孤立笔误而非全局约定。

- **失败场景**：Pro 用户对 AI 助手说「帮我找出重复的剪贴板内容」→ LLM 调 `find_duplicates` → `:2129` 拼出的 SQL 触发 `column c.type does not exist` → `executeToolInner` 抛出 → 工具返回错误 → AI 回复「查询失败」。`export_data`（「把我的剪贴板导出成 markdown」）同样。注意 `:2117` 的 `c.is_archived` 会在 `c.type` 修好之后继续报错，**必须三个一起改**。

- **影响**：**可用性（两个已发布 AI 工具 100% 不可用）+ 钱**（AI 助手是付费能力）。

- **修法**：`c.type`→`c.content_type`、`c.content`→`c.content_encrypted`、`c.is_archived`→`c.archived`（`:2112-2117` 与 `:2248-2253` 两处）；下游 `:2135-2140` 与 `:2266-2272` 读 `row.type` / `row.content` 的地方同步改名。修完补一条**真库**集成测试（不 mock pool）覆盖每个 AI 工具的 SQL。

---

### [S1-4] `AUDIT_ACTIONS.CLIPBOARD_CREATE` / `.CLIPBOARD_DELETE` 键不存在 → 剪贴板增删审计 100% 静默丢失，且每次写入白付 2 次失败 INSERT

- **证据**：`src/server/src/utils/audit.js:245`、`:248` 定义的是 `CREATE_CLIPBOARD: 'create_clipboard'` 与 `DELETE_CLIPBOARD: 'delete_clipboard'`；调用方用的是另一套名字：
  - `src/server/src/routes/clipboard.js:710` `action: AUDIT_ACTIONS.CLIPBOARD_CREATE,`
  - `src/server/src/routes/clipboard.js:1069` `action: AUDIT_ACTIONS.CLIPBOARD_DELETE,`

  两者求值均为 `undefined`。`db/migrations/008_audit_logs.sql:8` 是 `action VARCHAR(50) NOT NULL`。`utils/audit.js:50-65` 的 INSERT 因此违反 NOT NULL → `:70` catch → `:74-82` 兜底重试**同样传 undefined action** → 再失败 → `:84` `logger.error('Audit event dropped after retry')`。
  代码里已写明知道这件事却没修，`utils/audit.js:266-271`：
  ```js
  // ⚠️ 同类漏键还有 CLIPBOARD_CREATE / CLIPBOARD_DELETE（routes/clipboard.js:710,1069），
  // 本次未一并处理（不在支付审计范围），见交付报告「未尽事项」。
  ```
  交叉核对：`AUDIT_ACTIONS.*` 全仓共引用 22 个不同键，与 `utils/audit.js:234-272` 定义的 29 个键逐一比对，**只有这 2 个对不上**。

- **失败场景**：任意用户复制一条内容 → `POST /api/clipboard` 成功返回 201，但 `audit_logs` 里**没有** `clipboard_create` 记录；删除同理。管理台「审计日志」页按剪贴板动作筛选永远为空。合规视角：剪贴板内容的创建/删除是个人信息处理行为，属必须留痕的操作，现在完全无痕。性能视角：每一次剪贴板写入都额外付出 2 次注定失败的 INSERT 往返 + 2 条 error 日志。

- **影响**：**合规（审计链断裂）+ 数据（安全事件无法溯源）+ 可用性（热路径白付 2 次 DB 往返）**。

- **修法**：`utils/audit.js` 补 `CLIPBOARD_CREATE` / `CLIPBOARD_DELETE`（或改调用方用现有键名，二选一，但要与 `routes/admin/audit.js` 的 `action` 筛选清单对齐）；`logAuditEvent` 入口加 `if (!action) { logger.error(...); return; }` 早退，避免无声失败；`:74-82` 的兜底分支要把 `fallbackDetails` 真正传进 `insert()`（当前 `:82` 的 `void fallbackDetails;` 是空操作，注释声称的「把原始标识并入 details」并未发生，见 S3-6）。

---

### [S1-5] 限流键取自客户端可伪造的 `X-Forwarded-For`，且未设 `trust proxy` → apiLimiter / adminLimiter / adminStrictLimiter 全部可绕过

- **证据**：`src/server/src/middleware/rateLimiter.js:245-251`
  ```js
      keyGenerator: (req) => {
        // 已登录请求按用户限流（C5 修复）；匿名请求回退到 IP（兼容配对/匿名路由）
        if (req.userId) return `user:${req.userId}`;
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.ip ||
               req.connection?.remoteAddress;
  ```
  `adminLimiter`（`:375-378`）与 `adminStrictLimiter`（`:393-399`）**无条件**取 `x-forwarded-for.split(',')[0]`，不看 `req.userId`。
  `grep -rn "trust proxy" src/server/src/` → **零命中**，即 `req.ip` 恒为 nginx 容器地址（所有客户端同一个值），XFF 是唯一的区分依据。
  `nginx/conf.d/clipsync.conf:32` `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` —— `$proxy_add_x_forwarded_for` 是**在客户端传来的值后面追加** `$remote_addr`，不是覆盖。所以客户端发 `X-Forwarded-For: 1.2.3.4` 到后端变成 `1.2.3.4, <真实IP>`，`.split(',')[0]` 取到的正是攻击者填的值。
  `adminStrictLimiter` 的注释（`:383-386`）明确声称它保护「退款 / 强制下线 / 运维动作」，`adminLimiter` 的注释（`:366-367`）明确声称「按 IP 而非用户计数，避免单个被盗管理员凭据在多出口 IP 下绕过阈值」——两者都被这一行击穿。

- **失败场景**：攻击者拿到一个被盗的管理员 Bearer token，逐个批准退款，每次请求换一个随机 `X-Forwarded-For: 10.0.<i/256>.<i%256>` → 每个请求落在一个全新的 `ratelimit:adminStrict:10.0.x.y:refund-requests` 桶里，10 次/分钟（`:390`）的阈值形同不存在，可批量批准退款（直接资金损失）。同理，未认证路径（`/api/app/*`、`/api/shared-links/public/*`、`/api/webhooks/*`、`/api/auth/*`）的 `apiLimiter` 300 次/分钟也可用同样手法绕过 → 无限刷接口 / 放大 DoS。
  `sendCodeLimiter`、`loginFailedLimiter` 的键是手机号（`:264-267`、`:280-283`），**不受影响**，短信轰炸面没被打开。

- **影响**：**安全（管理面高危写操作失去速率防护 → 资金）+ 可用性（全局限流可绕过 → DoS）**。

- **修法**：`index.js` 加 `app.set('trust proxy', 1)`（或按实际反代层数），三个 keyGenerator 统一改为 `req.ip`（由 Express 依据 trust proxy 从 XFF 右侧取可信跳数）；或把 nginx 改成 `proxy_set_header X-Forwarded-For $remote_addr;`（覆盖而非追加）再配合 `trust proxy`。补一条集成测试：同一 IP 换 XFF 打 N+1 次必须收到 429。

---

### [S1-6] `GET /api/clipboard?all=true` 取消 LIMIT，单请求把用户全量历史（含 `ocr_text`）拉进 Node 堆 → OOM 打挂整个实例

- **证据**：`src/server/src/validation/validator.js:200-211`
  ```js
  export function validatePagination(page, limit, opts = {}) {
    const { all } = opts
    if (all) return { page: 1, limit: Infinity }
    let pageNum = parseInt(page) || 1;
    let limitNum = parseInt(limit) || 50;
    pageNum = Math.max(1, Math.min(1000, pageNum));
    limitNum = Math.max(1, Math.min(100, limitNum));
  ```
  `src/server/src/routes/clipboard.js:57`、`:60`、`:164`、`:176`
  ```js
    const pagination = validatePagination(page, limit, { all: all === 'true' });
    const useLimit = pagination.limit < Infinity
    ...
    const limitClause = useLimit ? `LIMIT $${paramIndex} OFFSET $${paramIndex + 1}` : ''
  ```
  即 `all=true` 时 SQL **完全没有 LIMIT/OFFSET**。SELECT 列表（`:166-170`）含 `ci.content_preview`（`db/migrations/016_expand_text_preview.sql` 已把上限从 200 提到 **5000 字符**）与 `ci.ocr_text`（`029_ocr_text.sql`，TEXT 无上限）。响应体在 `:178-197` 用 `.map()` 再复制一份。

- **失败场景**：一个开了半年自动捕获的重度用户积累 20 万条剪贴板（跨设备剪贴板同步产品的正常量级），平均 preview 1KB + ocr_text 2KB → 单请求在 Node 堆里物化约 600MB × 2（rows + map 结果）≈ **1.2GB**。`GET /api/clipboard?all=true` 一次即触发 `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`，容器被 OOMKill，**该实例上所有用户的全部在途请求（含 WebSocket 连接）一起断**。攻击者只需用自己的账号反复调用即可持续打挂服务。
  另外 `:194` 的 `totalPages: Math.ceil(total / pagination.limit)` = `Math.ceil(total/Infinity)` = `0`，客户端拿到 `total=200000, totalPages=0` 的自相矛盾分页壳。

- **影响**：**可用性（单请求 OOM → 全实例崩溃，影响所有租户）**。

- **修法**：删掉 `validatePagination` 的 `all` 分支（或钳到硬上限，如 `limit ≤ 1000` 且必须走 keyset 分页）；`GET /api/clipboard` 一律带 LIMIT；确需「全量导出」应做成异步导出任务（生成文件 + 下载链接），不能在请求线程里物化。`tests/validator.test.js:111-128` 目前**没有覆盖 `{all:true}` 这条分支**（只测了 `(1,50)`/`(-1,0)`/`(1,200)`），补上。

---

### [S1-7] 多实例 / 多 worker 下 `migrate.js` 与 5 个定时任务没有 advisory lock / leader 选举 → 启动期迁移竞态崩溃 + 审计归档 CSV 重复与交错写

- **证据**：
  - `docker-compose.multi.yml:68`、`:115` —— `container_name: clipsync-api-1` 与 `clipsync-api-2`，两个 api 实例并列在 nginx 之后。
  - `src/server/src/index.js:598-608` —— `CLUSTER_WORKERS=auto` 时按 CPU 核数 `cluster.fork()`。
  - `index.js:616-619` —— **每个 worker / 每个实例**都执行 `await migrate()`；`migrate.js:248-264` 的「查 `schema_migrations` → 没有则执行 → INSERT」是**无锁的 check-then-act**。
  - `index.js:679-695` —— 每个 worker 都调 `startCleanupScheduler()`、`startVersionCleanupScheduler()`、`startFileRetentionCleanup()`、`startDeviceOnlineSweep()`、`startOrderCloseSweep()`。
  - `grep -rn "advisory_lock\|pg_try_advisory\|leader" src/server/src/{db,services,utils}` → **零命中**（唯一的 advisory lock 用在 `clipboard.js:646` 的去重上，与调度无关）。
  - 非幂等的迁移语句实例：`db/migrations/011a_fix_subscription_schema.sql:33-38`（`DROP TABLE IF EXISTS invoices CASCADE` + `ALTER TABLE subscription_plans RENAME TO subscription_plans_legacy_004`）、`048_subscription_status_check.sql:18-19`（`DROP CONSTRAINT` 后 `ADD CONSTRAINT`）。
  - 归档写盘：`db/cleanup.js:114`（`AUDIT_ARCHIVE_DIR = path.resolve('logs','audit-archive')`）、`:157-166`（SELECT）、`:196`（`fs.appendFile`）、`:206`（DELETE）。两实例 SELECT 到**同一批**超期行，各自 append 到同一路径同名文件，然后各自 DELETE。

- **失败场景**：
  - **迁移竞态**：`docker compose -f docker-compose.multi.yml up` 两个 api 容器同时启动，两边都跑到 `048`：A 执行 `DROP CONSTRAINT` 成功后 B 也执行 `DROP CONSTRAINT IF EXISTS`（无错），A `ADD CONSTRAINT` 成功，B `ADD CONSTRAINT` 撞 `duplicate_object` → `migrate.js` 抛出 → `index.js:621-624` `process.exit(1)` → 容器重启 → 再撞 → **crash loop**。`011a` 的 RENAME 分支同理（一边 RENAME 走了，另一边的 RENAME 找不到表）。
  - **归档重复/损坏**：两实例把同一批审计行各写一遍 → `logs/audit-archive/audit-YYYYMMDD.csv` 里每条审计出现两次；两个进程对同一文件并发 `appendFile` 大缓冲（超过 `PIPE_BUF` 不保证原子）→ 行与行互相穿插，CSV 结构损坏。审计归档是合规留存物，损坏即等于审计失效。
  - **启动期全表改写**：`migrate.js:212-215` 的 `postMigrations` 里有一条**每次启动都跑**的全表 `UPDATE clipboard_items SET metadata = jsonb_set(...)`（注释自称「服务端每次启动自愈一次」）；两实例 × N worker 同时跑 → 互相等行锁，启动时间随表大小线性恶化，配合 `db/pool.js:33` 的 `statement_timeout=30000` 会直接超时失败 → `process.exit(1)`。

- **影响**：**可用性（启动 crash loop）+ 数据（审计归档重复/损坏）+ 合规**。

- **修法**：`migrate()` 整体包在 `SELECT pg_advisory_lock(<固定key>)` … `pg_advisory_unlock` 里；5 个 scheduler 只在「抢到 advisory lock 的 leader」上启动，或每个 tick 用 `pg_try_advisory_xact_lock` 做互斥；归档改为 `SELECT ... FOR UPDATE SKIP LOCKED` + 每实例写**带实例标识的文件名**（`audit-YYYYMMDD-<hostname>.csv`）；`postMigrations` 的全表 UPDATE 移进带版本号的迁移文件，只跑一次。

---

### [S1-8] `POST /api/clipboard` 在开放事务里调 `logAuditEvent`（走 `pool` 而非 `client`）→ 每请求占 2 条连接，池耗尽即 500；且审计与业务写入非原子

- **证据**：`src/server/src/routes/clipboard.js:632`（`await client.query('BEGIN')`）→ `:707-722`
  ```js
      // 审计日志：记录剪贴板创建（在事务内，保证一致性）
      await logAuditEvent({
        userId: req.userId,
        action: AUDIT_ACTIONS.CLIPBOARD_CREATE,
        ...
      });

      await client.query('COMMIT');
  ```
  而 `src/server/src/utils/audit.js:11` 是 `import pool from '../db/pool.js'`，`:50` 是 `await pool.query(...)` —— **审计走的是池里另一条连接**，不在 `client` 的事务里。注释「在事务内，保证一致性」与实现不符。

- **失败场景**：每个 `POST /api/clipboard` 在 `BEGIN`…`COMMIT` 期间同时持有 2 条连接（`client` + 审计临时借的一条）。`db/pool.js:13` `max` 默认 50，`index.js:606` 在集群模式下还要 `Math.floor(50 / workerCount)`（8 核 auto → 每 worker 6 条）。一个 worker 只要有 3 个并发剪贴板写入就吃满 6 条；第 4 个请求的 `pool.connect()` 在 `connectionTimeoutMillis: 2000`（`pool.js:15`）后抛 `timeout exceeded when trying to connect` → `clipboard.js:530-534` 直接 `500 {"error":"Failed to create clipboard item"}`。多设备同时复制（本产品的常态）即可稳定复现。
  一致性后果：审计 INSERT 在独立连接上自动提交，若 `:722` 之前任何语句失败导致 `ROLLBACK`（`:724-725`），业务写入回滚而**审计记录已落库** → 出现「审计说创建了、库里没有」的幽灵审计。当前因 S1-4 审计必然失败，这个不一致暂时被掩盖；一旦修好 S1-4 就会显形。

- **影响**：**可用性（连接池自我挤兑 → 核心写入 500）+ 数据（审计与业务不原子）**。

- **修法**：给 `logAuditEvent` 增加可选执行器参数（`logAuditEvent(params, executor = pool)`），事务内传 `client`；或把审计移出事务、放在 `COMMIT` 之后（与 `services/orderFulfillment.js:307-314` 的做法一致，那里的注释「审计在事务外做（失败不影响履约）」是正确范式）。

---

### [S1-9] `POST /api/media/file`：multer `maxCount: 50` × `fileSize: 1GB`，套餐配额校验发生在**全部字节落盘之后** → 单请求可写 50GB 临时盘

- **证据**：`src/server/src/routes/media.js:89-96`
  ```js
  const fileStorage = multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `${uuidv4()}.file.tmp`),
  });
  const fileUpload = multer({
    storage: fileStorage,
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB max (Enterprise limit), actual limit checked in handler
  ```
  `:320-328` 路由挂载 `{ name: 'files', maxCount: 50 }`；配额判定在 handler 内部、multer 之后，`:344-352`：
  ```js
        const limits = await getPlanLimits(req.userId);
        const verdict = await checkUploadQuota(
          req.userId,
          req.files.map((f) => ({ size: f.size, count: 1 })),
          limits
        );
  ```
  `:315-319` 的注释断言「DoS 面可控：单文件 1GB 硬上限 + apiLimiter 限速 + diskStorage 落盘（不占内存）+ 业务配额 fail-closed」——但**没有单次请求的总字节上限**，`limits` 里只有 per-file 的 `fileSize`。
  另注：`config.upload.maxFileSize`（`config/production.js:54`，50MB）与 `.env.*.example` 里的 `MAX_FILE_SIZE` **全仓零读取**（`grep -rn "process.env.MAX_FILE_SIZE" src/server/src/` → 0），三处上传上限各写各的（`media.js:77` 20MB、`media.js:95` 1GB、`chunked-upload.js:164` 12MB）。

- **失败场景**：一个 Free 套餐用户（`subscription_plans.max_file_size_mb = 1`，见 `db/migrate.js:199` 的种子数据）发一个 multipart 请求，50 个 part 都叫 `files`、每个 200MB → multer 把 **10GB** 逐个写进 `TMP_DIR`，全部写完后 handler 才在 `:352` 判配额并回 413。`uploadLimiter` 是 20 次/分钟（`rateLimiter.js:409-413`）→ 单用户 200GB/分钟的落盘速率。容器磁盘（通常几十 GB）瞬间打满；PostgreSQL 若同机则 WAL 写失败 → **数据库进入只读/崩溃**，全站不可用。`finally` 里的 unlink 只在请求结束后释放，磁盘峰值已经发生。

- **影响**：**可用性（磁盘耗尽 → 全站含数据库不可用）**。

- **修法**：加**请求级**总字节前置闸——一个在 multer 之前的中间件按 `Content-Length` 先拒（超过套餐单次上限即 413，不落一个字节）；`limits.fileSize` 降到与套餐上限同量级（企业版 50MB 而非 1GB）；`files` 的 `maxCount` 从 50 降到与 `max_files_per_clip`（`042_file_sync_plan_limits.sql`）一致；把 `MAX_FILE_SIZE`/`config.upload.maxFileSize` 接成真正的单一事实来源。

---

### [S1-10] `db/pool.js` 未把 `config.db.ssl` 传给 `pg.Pool` → `DB_SSL=true` 静默无效，生产 DB 连接始终明文；`poolMax` 配置也被忽略

- **证据**：`src/server/src/config/production.js:13-20`
  ```js
  db: {
    host: process.env.DB_HOST || 'localhost',
    ...
    poolMin: 5,
    poolMax: 20,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  },
  ```
  `src/server/src/db/pool.js:7-19` 的 `new Pool({...})` 参数清单是 `host / port / database / user / password / max / idleTimeoutMillis / connectionTimeoutMillis / query_timeout / keepAlive` —— **没有 `ssl` 键**，也从未引用 `config.db.ssl`。同一处还忽略了 `poolMin`/`poolMax`：`pool.js:13` 直接读 `parseInt(process.env.DB_POOL_MAX) || 50`，即**生产配置写的 20 与实际生效的 50 不一致**，配置文件成了误导性文档。
  附带：`pool.js:29-35` 的 `connect` 事件里 `client.query('SET SESSION statement_timeout = 30000')` **没有 `.catch()`**，是一条 unhandled rejection 源（会被 `index.js:792-796` 的 handler 记一条无上下文的日志）。

- **失败场景**：运维按 `config/production.js` 的注释设 `DB_SSL=true`，期望到 PG 的链路被 TLS 保护；实际 `pg` 收到 `ssl: undefined` → 走明文连接。若 PG 不在同一 docker 网络（例如托管 RDS / 跨可用区），`DB_PASSWORD`、全部查询与结果集（含 `content_encrypted`、`phone_encrypted`、AI `api_key_encrypted`）以明文过网。没有任何日志或启动检查会提示——配置被无声丢弃。
  连接数场景：运维按 `poolMax: 20` × 2 实例 = 40 规划 PG `max_connections`（默认 100），实际是 `50 × 2 = 100`，再叠加 `CLUSTER_WORKERS` 放大 → 撞 `FATAL: sorry, too many clients already`。

- **影响**：**安全（传输明文）+ 可用性（连接数规划失真）+ 配置可信度**。

- **修法**：`pool.js` 补 `ssl: config.db.ssl`、`max: config.db.poolMax`、`min: config.db.poolMin`（保留 env 覆盖但让 config 成为默认来源）；`connect` 事件里的 `SET SESSION` 补 `.catch()`；启动时 `SELECT ... SHOW ssl` 校验并在生产未加密时 fail-fast 或高声告警。

---

### [S1-11] `user_sessions.updated_at` 列不存在 → 「撤销会话 / 强制下线 / 全端登出」三个安全操作 100% 失败，被盗 token 无法吊销

> 说明：本条按任务分级规则（「schema 与代码不符导致 500」）归入 S1，但它的**实际后果是一个安全控制完全失效**，修复优先级应与 S0 并列，是全清单里性价比最高的一条（改 3 行 SQL 或加 1 个列）。

- **证据**：`user_sessions` 在整个生效迁移链里**只被 CREATE，从未被 ALTER**：
  ```
  $ grep -rn "user_sessions" src/server/src/db/migrations/*.sql
  db/migrations/012_schema_completion.sql:27:CREATE TABLE IF NOT EXISTS user_sessions (
  db/migrations/012_schema_completion.sql:39:CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ...
  db/migrations/012_schema_completion.sql:40:CREATE INDEX IF NOT EXISTS idx_user_sessions_active ...
  $ grep -rn "ALTER TABLE user_sessions" src/server/src/db/migrations/*.sql src/server/src/db/migrate.js
  （零命中）
  ```
  列定义（`db/migrate.js:88-99` 与 `db/migrations/012_schema_completion.sql:27-38` 两处完全一致）：
  ```sql
  CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name VARCHAR(100) DEFAULT 'Unknown Device',
    device_type VARCHAR(20) DEFAULT 'browser',
    platform VARCHAR(20) DEFAULT 'unknown',
    ip_address VARCHAR(45),
    user_agent TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    revoked_at TIMESTAMP WITH TIME ZONE
  )
  ```
  **没有 `updated_at`**。而三处代码写它：
  - `src/server/src/routes/sessions.js:77-82`（`DELETE /api/sessions/:sessionId`，撤销单个会话 / 强制下线）
    ```js
        await pool.query(`
          UPDATE user_sessions
          SET is_active = false, updated_at = NOW(), revoked_at = NOW()
          WHERE id = $1 AND user_id = $2
        `, [sessionId, userId]);
    ```
  - `src/server/src/routes/sessions.js:109-114`（`DELETE /api/sessions`，撤销全部会话 / 全端登出）
  - `src/server/src/routes/aiTools.js:4459`（AI 工具的会话撤销）
    ```js
              'UPDATE user_sessions SET is_active = FALSE, updated_at = NOW(), revoked_at = NOW() WHERE id = $1 AND user_id = $2',
    ```
  挂载确认：`index.js:443` `app.use('/api/sessions', authenticateToken, sessionRoutes);`。

- **失败场景**：用户发现账号在陌生设备上登录（`GET /api/sessions` 能列出来），点「强制下线」→ `DELETE /api/sessions/<sessionId>` → `sessions.js:78` 的 UPDATE 抛 `column "updated_at" of relation "user_sessions" does not exist` → `:93-96` catch → **500 `{"error":"Failed to revoke session"}`**。连锁后果（全在 `:78` 之后、因此全部没执行）：
  1. `is_active` 仍是 `true` → `middleware/auth.js:69` 的 `if (decoded.jti && row.session_active === false)` 判定不成立 → **被盗 token 继续通过认证**；
  2. `revoked_at` 未写入 → 会话列表里那条记录看起来依然「活跃」，用户以为没点成功、反复重试，每次都是 500；
  3. `:84` 的 `await blacklistJti(sessionId, ttl)` **永不执行** → Redis jti 黑名单没写 → `middleware/auth.js:34-38` 的第一道闸也放行。
  同理 `DELETE /api/sessions`（改密码后「登出所有设备」）也 500，**用户改完密码无法踢掉任何旧会话**——这正是凭证泄漏后最关键的一步。
  测试为什么没发现：`middleware/auth.js:8-20` 在 `NODE_ENV === 'test'` 下直接注入固定测试用户并 `return next()`，`tests/` 里没有任何用例真正调用 `DELETE /api/sessions/:id` 并断言 DB 状态。

- **影响**：**安全（会话吊销 / 强制下线 / 全端登出三个控制全废，账户被盗后无自救手段）+ 可用性（用户可见的 500）**。

- **修法**：二选一，建议同时做——①新增迁移 `ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`；②把三处 SQL 里的 `updated_at = NOW(),` 删掉（`revoked_at` 已经承担了时间戳语义，`updated_at` 在这张表上没有消费方——`grep -rn "user_sessions" | grep updated_at` 只有这 3 处写入、0 处读取）。修完补一条真库集成测试：登录 → `DELETE /api/sessions/:id` → 断言 200 + `is_active=false` + 用旧 token 再请求得到 401。

---

### [S2-1] `to_tsquery('simple', <用户输入>)` 未做 tsquery 语法转义 → `?search=a(b)` 直接 500

- **证据**：`src/server/src/routes/clipboard.js:96-108`
  ```js
        if (cleanSearch.length >= 3) {
          whereClause += ` AND (ci.search_vector @@ to_tsquery('simple', $${paramIndex}) OR ci.content_preview ILIKE $${paramIndex + 1} OR ci.ocr_text ILIKE $${paramIndex + 2})`;
          const tsQuery = cleanSearch
            .split(/\s+/)
            .filter(w => w.length > 0)
            .map(w => w + ':*')
            .join(' & ');
  ```
  同样的构造在 `routes/clipboard.js:236-241`（`GET /api/clipboard/search`）重复一次。`cleanSearch` 来自 `validateSearch()`（`validation/validator.js:219-224`），它只做 `sanitizeString`（转义 `& < > " ' /`）+ 截断，**不处理 tsquery 的保留字符** `! | ( ) : \ *`。

- **失败场景**：`GET /api/clipboard?search=report(final)` → `tsQuery = 'report(final):*'` → PG 报 `syntax error in tsquery` → `clipboard.js:202-205` catch → `500 {"error":"Failed to get clipboard list"}`。搜索框里输入任何含括号、竖线、感叹号的文本（代码片段、正则、`a|b`、`C++`…）都是 500 而不是空结果。用户可自发触发、影响所有租户。

- **影响**：**可用性（列表接口 500）+ 体验（搜索对常见字符不可用）**。

- **修法**：改用 `websearch_to_tsquery('simple', $n)`（PG 11+，接受任意用户文本、内部安全解析，原生支持 `"短语"` / `or` / `-排除`），或 `plainto_tsquery`；前缀匹配需求可在安全解析后逐词追加 `:*`。

---

### [S2-2] `sanitizeString` 的 HTML 实体转义被用在**搜索词与标签**上 → 搜索/筛选静默返回空结果

- **证据**：`src/server/src/validation/validator.js:219-224`
  ```js
  export function validateSearch(search, maxLength = 100) {
    if (typeof search !== 'string') return '';
    return sanitizeString(search.trim()).substring(0, maxLength);
  }
  ```
  `sanitizeString`（`:82-94`）把 `& < > " ' /` 全部替换成 HTML 实体。消费方是**查询条件**而非 HTML 输出：
  - `routes/clipboard.js:93` `const cleanSearch = validateSearch(search);` → 用于 `ILIKE '%...%'` 与 tsquery
  - `routes/clipboard.js:148` `const cleanTag = sanitizeString(String(tag).trim());` → 用于 `metadata->'tags' @> $n::jsonb`
  - `routes/clipboard.js:222` `const cleanSearch = sanitizeString(q.trim());`
  - `routes/auth.js:172` `const cleanPhone = sanitizeString(phone);`（手机号无特殊字符，恰好无害）

- **失败场景**：用户搜 `https://example.com/a` → `cleanSearch` 变成 `https:&#x2F;&#x2F;example.com&#x2F;a` → `content_preview ILIKE '%https:&#x2F;&#x2F;...%'` **永远匹配不到任何真实存储的 URL**（链接类剪贴板是高频内容）。搜 `a&b` → 变 `a&amp;b`。按标签筛选任何含 `/`、`'`、`&`、`<` 的标签同理失效。返回的是「200 + 空列表」，用户以为数据丢了，运维看不到任何错误。

- **影响**：**数据可见性（核心搜索/筛选功能静默失效）**。这是**输出转义被误用为输入净化**——本项目客户端全是 SPA/Tauri/Flutter，服务端根本不做 HTML 渲染（`views/` 下只有静态法务页）。

- **修法**：`validateSearch` 只做 `trim()` + 长度截断 + 控制字符剥离，**不做 HTML 转义**；`tag` 同理；把 `sanitizeString`/`escapeHtmlContext` 从「输入校验」语义里彻底摘出去。`tests/validator.test.js:130-143` 只用纯 ASCII 测过 `validateSearch`，补一条含 `/` 与 `&` 的用例即可捕获此缺陷。

---

### [S2-3] 非法 UUID / 超长枚举 / 非整数数值一律落到 500 而不是 400（多个写接口）

- **证据与失败场景**（逐条可复现）：
  1. `src/server/src/routes/templates.js:71-74` 与 `:92-93`
     ```js
        `UPDATE clipboard_templates
         SET ${fields.join(', ')}
         WHERE user_id = $${idx} AND id = $${idx + 1}::uuid`      // :71-74
     ...
        `DELETE FROM clipboard_templates
         WHERE user_id = $1 AND id = $2::uuid`,                    // :92-93
     ```
     这两个路由**完全没有 `isValidUUID(id)` 前置校验**（同项目 `routes/clipboard.js:790`、`routes/aiConversations.js:305` 都有）。
     `PUT /api/templates/not-a-uuid` body `{"name":"x"}` → PG `invalid input syntax for type uuid: "not-a-uuid"` → `:81-84` catch → **500** `{"error":"Failed to update template"}`。`DELETE /api/templates/not-a-uuid` 同样 500。
  2. `src/server/src/routes/surveys.js:16-33`：`type` 只校验「非空」，未做白名单也未限长，而 `db/migrations/013_surveys.sql:5` 是 `type VARCHAR(20) NOT NULL DEFAULT 'nps'`。
     `POST /api/surveys` body `{"type":"01234567890123456789012","score":5}` → `value too long for type character varying(20)` → `:36-39` catch → **500** `{"error":"Failed to submit survey"}`。
  3. 同一路由的 `score`，`:23`
     ```js
        if (typeof score !== 'number' || score < 0 || score > 10) {
          return res.status(400).json({ error: 'Score must be a number between 0 and 10' });
        }
     ```
     **不判整数、不判 NaN**。`{"type":"nps","score":5.5}` → PG `invalid input syntax for type integer: "5.5"` → **500**；`score` 为 `NaN` 时（`typeof NaN === 'number'` 且两个比较都为 false）→ 放行 → PG 收到 `"NaN"` → **500**。
  4. 正面对照：`routes/clipboard.js:128-145` 的 `dateFrom`/`dateTo` 用 `new Date(x)` + `isNaN` 校验并返回 400，`:118-122` 的 `deviceId` 用 `isValidUUID` 返回 400——**说明团队知道正确写法，只是没有推广**。

- **影响**：**API 契约（客户端无法区分「我传错了」与「服务端坏了」）+ 可观测性**：真实的 4xx 被计入 5xx，`middleware/metrics.js:37-40` 的 `errors.total` 与 `getPrometheusMetrics()` 的 `clipsync_errors_total` 被污染，基于错误率的告警失真。

- **修法**：所有 `:id` 路由参数统一加 `isValidUUID` 前置校验（`validation/validator.js:38` 已有，直接用）；`surveys.js` 的 `type` 加白名单 `['nps','csat']` + 长度 ≤20，`score` 加 `Number.isInteger(score)`；在全局错误处理器（`index.js:568-589`）里把 PG 错误码 `22P02`（invalid_text_representation）/`22001`（string_data_right_truncation）/`23514`（check_violation）统一映射为 400 作为兜底网。

---

### [S2-4] `GET /api/surveys/stats` 无归属过滤、无管理员校验 → 任意登录用户读取全量 NPS/满意度业务数据

- **证据**：`src/server/src/routes/surveys.js:41-64`
  ```js
  /**
   * GET /api/surveys/stats
   * Get survey statistics (admin or aggregated)
   */
  router.get('/stats', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           type,
           COUNT(*) as total,
           ROUND(AVG(score)::numeric, 1) as avg_score,
  ...
         FROM surveys
         GROUP BY type`
      );
      res.json(result.rows);
  ```
  没有 `WHERE user_id = $1`，没有 `requireRole(...)`，没有 `requirePerm(...)`。注释写了「(admin or aggregated)」但 admin 分支从未实现。挂载点 `index.js:472` 也只有 `apiLimiter, authenticateToken`。
  对照：`routes/admin/*` 全部走 `requirePerm(...)`（如 `routes/admin/plans.js:155` `router.patch('/:id', requirePerm('admin.plans.manage'), ...)`），管理面是有权限体系的——这个端点只是漏在了体系之外。

- **失败场景**：任意注册用户（Free 套餐也可）`GET /api/surveys/stats` 带自己的 Bearer token → 拿到全平台每种 survey 类型的 `total / avg_score / promoters / passives / detractors`。这是产品核心健康度指标（NPS），属不应向终端用户披露的运营数据；竞品或恶意用户可据此判断产品口碑与用户规模。此外该查询是 `surveys` 全表聚合、无 LIMIT，随表增长线性变慢（`idx_surveys_type` 对「全表 COUNT + GROUP BY」帮助有限）。

- **影响**：**安全（越权读取全量业务数据）**。因是聚合值不含 PII，定级 S2 而非 S1。

- **修法**：移到 `/api/admin/surveys/stats` 并挂 `requirePerm('admin.surveys.view')`（同时把该权限键登记进 `routes/admin/roles.js` 的 `PERM_CATALOG`，否则会被 `index.js:643-654` 的启动自检报为孤儿键）；或保留在用户面但加 `WHERE user_id = $1`。顺带给 `POST /api/surveys` 加每用户频率限制（当前一个用户可无限刷 survey 把统计打歪）。

---

### [S2-5] 日志：92 处 `logger.error('msg', err)` 把 Error 当 meta 传入 → `message` 与 `stack` 被静默丢弃

- **证据**：`src/server/src/utils/logger.js:167-175`
  ```js
  function normalizeArgs(args) {
    const [first, ...rest] = args
    // 只有单个参数，或第二个参数是纯对象、而剩余参数为空：按结构化 meta 处理
    if (rest.length <= 1 && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
      return { message: first, meta: rest[0] }
    }
  ```
  `:95-105` 的 `formatLog` 做 `JSON.stringify({ timestamp, level, message, ...meta })`。`Error` 是 object，所以走 meta 分支；而 `message`/`stack` 是**不可枚举自有属性**，展开后消失。已实测确认：
  ```
  $ node -e "const e=new Error('boom'); e.code='X'; console.log(JSON.stringify({...e}))"
  {"code":"X"}
  ```
  命中该模式的调用点共 **92 处**，包括 `middleware/subscriptionCheck.js:114`、`:145`、`:189`、`:225`（套餐配额全链路）、`middleware/csrf.js:80`、`:109`、`middleware/idempotency.js:85`、`:177`、`:187`、`:238`、`:249`、`middleware/planFeature.js:141`、`routes/aiConversations.js:374`、`routes/surveys.js:37`、`utils/encryption.js:109`、`:144`。

- **失败场景**：生产环境订阅校验突然对所有用户 500，运维去查日志，只看到
  `{"timestamp":"...","level":"error","message":"Subscription check error:"}`
  ——没有错误文本、没有堆栈、没有 SQL、没有列名。本次审计发现的 S1-1 / S1-2 / S1-3 三条（PG `column ... does not exist`）**在生产日志里都会以这种空壳形式出现**，排障只能靠猜或加临时打印重启（而按 AGENTS.md 的分工，后端重启是 agent 的事，但诊断信息已经丢了）。

- **影响**：**可观测性（生产故障不可诊断）**，间接放大所有其他缺陷的 MTTR。

- **修法**：`normalizeArgs` 增加 `if (rest[0] instanceof Error) return { message: first, meta: { error: rest[0].message, stack: rest[0].stack, code: rest[0].code } }`；`formatLog` 里对 meta 做一次深度遍历，遇到 Error 实例同样展开。加一条静态检查禁止把 Error 直接作为第二参传入 `logger.*`。

---

### [S2-6] 日志脱敏只对**文件**输出生效、且是浅层白名单；控制台输出完全不脱敏；`requestLogger` 被注释掉

- **证据**：
  - `src/server/src/utils/logger.js:133-158`
    ```js
    function writeLog(level, message, meta = {}) {
      const formatted = formatLog(level, message, meta);
      // 控制台输出
      switch (level) { case 'debug': console.debug(formatted); break; ... }
      // 文件输出（生产环境，跨天自动滚动）
      if (logStream) {
        rotateLogIfNeeded();
        const sanitized = sanitizeLog(JSON.parse(formatted));
        logStream.write(JSON.stringify(sanitized) + '\n');
      }
    }
    ```
    控制台走的是**未脱敏**的 `formatted`。`sanitizeLog`（`:110-128`）只处理**顶层** 6 个键 `['password','token','secret','authorization','phone','email']`，不递归；白名单里没有 `content` / `contentPreview` / `contentEncrypted` / `apiKey` / `refreshToken` / `code` / `otp` / `twoFactorSecret` / `wrappedDek*`。
  - `src/server/src/index.js:228` `// app.use(requestLogger);` —— HTTP 访问日志中间件被注释掉，生产环境**没有任何逐请求日志**（`middleware/metrics.js` 只累计计数，不记 URL/状态码/耗时明细）。
  - `src/server/src/utils/logger.js:291-298` `securityLogger.loginSuccess(phone, userId)` / `loginFailed(phone, reason)` 把**明文手机号**作为顶层 `phone` 键传入——文件输出会被脱敏成 `138****5678`，但**控制台输出（Docker 的主日志通道、也是任何日志采集器的入口）是完整明文**。
  - 正面部分：生产日志文件在 `logger.js:31` `LOG_DIR = join(__dirname, '../../logs')`，按天滚动 + 保留 14 天（`:32`、`:45-60`、`:72-80`），这部分设计是对的、也真的实现了。
  - 仓库根的 1.1GB `clipsync_events.log`：内容首行是 `container exec_create: redis-cli -a <dev redis 口令> ping ...`，即 **Docker Desktop 的 `docker events` 抓包**，不是应用日志；`git check-ignore -v` 确认被 `.gitignore:30` 的 `*.log` 忽略、未被 git 跟踪。问题是①它把 dev Redis 口令以明文留在了工作区一个 1.1GB 文件里，②没有任何轮转/清理机制，③它会让所有 `grep -r` 类工具超时（本次审计中已实测触发一次命令超时并被移到后台）。

- **失败场景**：`docker compose logs api` 或任何日志采集（Loki/ELK）抓到的都是**未脱敏**的控制台流。一次登录成功即在集中式日志里留下完整手机号；任何把剪贴板 `contentPreview` 或 AI `apiKey` 放进 meta 的 `logger.debug/info` 同样原样入库。合规视角：手机号是《个人信息保护法》下的个人信息，剪贴板内容是产品承诺 E2E 保护的用户隐私，进入日志即构成个人信息处理行为，需要单独的告知同意与最小化论证。

- **影响**：**合规 + 安全（PII/凭据进入日志采集链路）+ 可观测性（无访问日志）**。

- **修法**：`writeLog` 里先 `sanitizeLog` 再分别输出到控制台与文件（两路同源）；`sanitizeLog` 改为**递归** + 键名正则匹配（可直接复用 `utils/audit.js:95` 已经写好的 `SENSITIVE_KEY_RE`，它比 logger 的白名单完整得多，含 `api[_-]?key|credential|content|text|body|plain`），并补 `content*` / `preview` / `wrappedDek*` / `refreshToken` / `otp`；恢复 `app.use(requestLogger)` 或在 `metricsMiddleware` 里补结构化访问日志（含 `req.requestId`）；删除工作区里的 `clipsync_events.log` 并确认没有脚本再生成它。

---

### [S2-7] `requestId` 未贯穿：`req.logger` 零使用，全局 logger 不带 requestId

- **证据**：`src/server/src/middleware/request-id.js:24-31` 精心构造了绑定 requestId 的 `req.logger`：
  ```js
      req.logger = {
        debug: (msg, meta = {}) => logger.debug(msg, { ...meta, requestId }),
        info: (msg, meta = {}) => logger.info(msg, { ...meta, requestId }),
        warn: (msg, meta = {}) => logger.warn(msg, { ...meta, requestId }),
        error: (msg, meta = {}) => logger.error(msg, { ...meta, requestId }),
      };
  ```
  `grep -rn "req.logger" src/server/src/` → **除定义处外零使用**。全部日志调用走的都是 `utils/logger.js` 的全局 `logger`，而 `logger` 没有 AsyncLocalStorage / CLS 上下文，输出的 JSON 里**没有 requestId 字段**。`X-Request-ID` 响应头是设了的（`:22`），但客户端拿着这个 ID 去日志里搜什么都搜不到。
  另外 `:37-42` 的 `generateRequestId()` 用 `Date.now().toString(36)` + `Math.random().toString(36).substring(2, 8)` —— `Math.random` 非加密随机，6 位 base36 ≈ 31 bit，高并发下同毫秒内可碰撞（不是安全问题，是追踪可靠性问题）。

- **失败场景**：客户端报「某次同步失败，X-Request-ID: req_m1abc_x7k2p9」，运维在日志里 grep 这个 ID → **零命中**，因为没有任何一行日志带它。多实例部署下（`docker-compose.multi.yml` 两个 api）连定位是哪个容器处理的都做不到。

- **影响**：**可观测性（分布式追踪断链）**。

- **修法**：用 `AsyncLocalStorage` 在 `requestId()` 里建上下文，`utils/logger.js` 的 `writeLog` 自动附加 `requestId`；`generateRequestId` 改用 `crypto.randomUUID()`；删除 `req.logger`（死代码）或让全仓统一改用它。

---

### [S2-8] 响应体格式 5 套并存；admin 内部错误码 16 种且同一语义多个值

- **证据**（全仓计数，`grep -rn ... | wc -l`）：

  | 约定 | 出现次数 | 代表位置 |
  |---|---|---|
  | `{ error: '...' }` | 620（routes）+ 17（middleware）+ 7（index.js） | `routes/clipboard.js:204`、`routes/templates.js:21` |
  | `{ code: 0, data: ... }` | 39 | `routes/admin/plans.js:142`、`routes/app.js:253` |
  | `{ message: '...' }` | 31 | `routes/favorites.js:131` |
  | `{ ok: true, ... }` | 20 | `routes/aiConversations.js:286` |
  | `{ success: true, data }` | 7 | `routes/metrics.js:22`（死代码） |
  | **裸对象 / 裸数组** | 多处 | `routes/templates.js:40`（`res.status(201).json(rows[0])`）、`routes/surveys.js:62`（`res.json(result.rows)` 裸数组）、`routes/surveys.js:37`、`routes/app.js:35`（`{flags, updatedAt}`）、`routes/app.js:219`（`{announcements}`）、`routes/app.js:306`（Tauri updater 契约） |

  同一个文件内部都不统一：`routes/templates.js:18` 列表用 `{ data: rows }`，`:40` 创建用**裸行对象**，`:80` 更新用裸行对象，`:99` 删除用 `204`。`routes/app.js:253` 用 `{code:0}`，同文件 `:35`、`:219`、`:306` 用三种不同的裸形状。
  admin 错误码（`grep -rhoE "code: [0-9]{3,5}" routes/admin/*.js | sort | uniq -c`）：
  ```
  69 code: 5000   54 code: 4000   32 code: 40404   26 code: 40002
   8 code: 4090    4 code: 40301    3 code: 40008    2 code: 40903
   2 code: 4040    2 code: 40009    2 code: 40007    2 code: 40003
   1 code: 5030    1 code: 40303    1 code: 40302    1 code: 40005
  ```
  `4000` 与 `40002`/`40003`/`40005`/`40007`/`40008`/`40009` 都表示 400，`40404` 与 `4040` 都表示 404，`4090` 与 `40903` 都表示 409，`40301/40302/40303` 三种 403。没有集中枚举、没有文档。HTTP 状态码本身用得是规范的（`routes/admin/*` 里 `status(400)` 82 次、`status(500)` 69 次、`status(404)` 33 次、`status(409)` 7 次、`status(403)` 5 次，与语义基本对应），问题只在业务码。

- **失败场景**：管理台前端要处理 400 必须同时判 `code === 4000 || code === 40002 || code === 40003 || ...`；漏判一个就退化成「显示 undefined」或吞掉错误。客户端（Tauri/Vue/Flutter 三套）对 `{error}` 与 `{code,data,message}` 需要两套解包逻辑，任何新端点选错约定就是一次前端 bug。`routes/templates.js` 的裸行对象让「统一响应拦截器」根本无法实现。

- **影响**：**API 契约（客户端脆弱、维护成本高）+ 一致性**。

- **修法**：定一份响应契约（建议 `{ code: 0, data, message }` 成功 / `{ code: <业务码>, message, requestId }` 失败），用两个工具函数 `ok(res, data)` / `fail(res, httpStatus, code, message)` 收口，业务码写成集中枚举并落文档；分批迁移，先冻结新代码不许再引入新形状。

---

### [S2-9] 幂等键命名空间未按用户隔离 → 跨用户重放他人缓存响应（当前客户端用高熵键，暂未可利用）

- **证据**：`src/server/src/middleware/idempotency.js:95-113`
  ```js
  function generateIdempotencyKey(req) {
    // 1. 优先使用请求头中的 Idempotency-Key
    const headerKey = req.headers['idempotency-key'];
    if (headerKey) {
      return `header-${headerKey}`;
    }
    // 2. 使用请求体中的唯一标识（如 orderNo, transactionId）
    const bodyKey = req.body?.orderNo || req.body?.transactionId || req.body?.id;
    if (bodyKey) { return `body-${bodyKey}`; }
  ```
  **键里不含 `req.userId`**。落库位置 `src/server/src/utils/redis-client.js:196-198` 是 `` const redisKey = `idempotency:${key}` ``，同样是全局命名空间。命中后 `:141-152` 直接原样重放缓存的 status/headers/body：
  ```js
            if (sendCachedResponse && cached.response) {
              res.status(cached.response.status);
              for (const [header, value] of Object.entries(cached.response.headers || {})) { res.setHeader(header, value); }
              return res.send(cached.response.body);
  ```
  应用点：`routes/clipboard.js:19`+`:528`（`POST /api/clipboard`）、`routes/media.js:31`+`:141`（`POST /api/media/image`）+`:323`（`POST /api/media/file`）——三者**共用同一个 `header-` 命名空间**。被缓存的响应体含 `contentPreview`（`routes/clipboard.js:773-781`），即用户剪贴板明文预览。

- **失败场景**：用户 A 发 `POST /api/clipboard` 带 `Idempotency-Key: 1`，响应（含 A 的剪贴板预览明文 + 条目 id）被写进 Redis `idempotency:header-1`，TTL 24h（`redis-client.js:198` 的 `setEx(redisKey, 24*60*60, ...)`）。用户 B 发同一端点带 `Idempotency-Key: 1` → `:141` 命中 → **B 收到 A 的剪贴板内容与条目 id**。跨端点变体：客户端对 `POST /api/clipboard` 和 `POST /api/media/image` 复用同一把键 → 第二次请求拿到第一次的错误形状响应。
  **当前可利用性评估（已核对两端客户端）**：`src/desktop/src/api/client.ts:28-38` 用 `crypto.randomUUID()`（含 `Math.random` 兜底），`src/mobile/lib/services/clipboard_capture.dart:494-498` 用 `mobile-<微秒时间戳>-<30bit>-<30bit>`。两者熵都足够高，**碰撞不可实际构造**，故定级 S2 而非 S0/S1。但服务端契约本身是错的：任何第三方客户端、脚本、未来的 SDK、或某端改用重试计数器做键，都会立刻变成跨租户明文泄漏。

- **影响**：**安全（跨租户数据泄漏，条件性）+ 正确性（跨端点键串味）**。

- **修法**：`generateIdempotencyKey` 一律前缀用户身份——`` `u:${req.userId || 'anon'}:header-${headerKey}` ``，并把端点纳入键（`req.baseUrl + req.route.path`）；`webhookIdempotencyMiddleware`（`:190-247`）保持全局命名空间是对的（渠道回调无用户上下文），但 `:196-199` 的 `req.body?.id` 兜底应加渠道前缀避免 alipay/stripe 事件 ID 撞车。另：`:167-176` 的 `saveProcessed(...).catch(...)` 不 await，两个并发同键请求都会 miss 缓存，幂等保证在并发下不成立（可用 Redis `SET NX` 占位修复）。

---

### [S2-10] `clearLoginFailed` 的 Redis 键与实际写入键不一致 → 生产环境登录失败计数永不清零

- **证据**：写入侧 `src/server/src/middleware/rateLimiter.js:70`
  ```js
    const redisKey = `ratelimit:${storeName}:${key}`;
  ```
  配合 `loginFailedLimiter` 的 keyGenerator（`:280-283`）`` return phone ? `loginFailed:${phone}` : 'loginFailed:unknown' ``，实际写入的键是
  `ratelimit:loginFailed:loginFailed:<phone>`（前缀重复了一次）。
  清除侧 `:290-299`
  ```js
  export function clearLoginFailed(phone) {
    getSharedRedisClient().then(client => {
      if (client) {
        const redisKey = `ratelimit:loginFailed:${phone}`;
        client.del(redisKey).catch(() => {});
      } else {
        // Redis 不可用，清除内存存储
        const key = `loginFailed:${phone}`;
        memoryStores.loginFailed.delete(key);
  ```
  → 删的是 `ratelimit:loginFailed:<phone>`，**少一层前缀，永远删不到**，且 `.catch(() => {})` 连日志都没有。内存降级分支（`:296-299`）用的是 `` memoryStores.loginFailed.delete(`loginFailed:${phone}`) ``，与 `:142` 的 store key 一致，**是对的**。
  调用点：`routes/auth.js:313` `clearLoginFailed(cleanPhone);`（登录成功后清计数）。
  同一文件的 `getRateLimitStatus`（`:423`）也是 `` const redisKey = `ratelimit:${key}` `` —— 同样漏了 `storeName`，调试接口读的键与写的键不同；`:443` 还有 `resetTime: timestamps[0] + 60000` 的字符串拼接 bug（`timestamps[0]` 是字符串，结果是 `"170000000000060000"` 这种垃圾值）。

- **失败场景**：仅在生产（`useRedis` 为真，`:188` `process.env.NODE_ENV === 'production' && process.env.REDIS_HOST`）触发。用户输错 4 次密码后第 5 次输对、登录成功，`clearLoginFailed` 静默 no-op；计数器留在 Redis 里等 15 分钟窗口自然过期。此后再输错 1 次即触发 `429 Too many login attempts, please try again in 15 minutes`。用户在「我明明刚登录成功」的状态下被锁 15 分钟。dev/test 走内存分支表现正常，所以本地测不出来——与 `:94-101` 注释里记录的 2026-09-15 生产 429 事故是同一类「只在生产暴露」的 Redis/内存双实现漂移。

- **影响**：**可用性（合法用户被误锁）+ 安全运维（应急时无法解除锁定）**。

- **修法**：抽一个 `buildRedisKey(storeName, key)` 供写入、清除、查询三处共用；把 keyGenerator 里已有的 `loginFailed:`/`sendCode:` 前缀去掉（`storeName` 已承担该职责，现在是双重前缀）；`:443` 改 `parseInt(timestamps[0],10) + 60000`。补一条走 Redis 分支的集成测试：5 次失败 → 成功登录 → 断言计数已清零。

---

### [S2-11] `sync.js` 冲突分支用 `SELECT *` 把 DEK 包装密钥与保护盐返回给客户端

- **证据**：`src/server/src/routes/sync.js:96-104`
  ```js
            if (clientTime < serverTime) {
              // Conflict: server version is newer
              const serverData = await client.query(
                'SELECT * FROM clipboard_items WHERE id = $1 AND user_id = $2', [id, req.userId]
              );
              results.push({
                clientId: id,
                status: 'conflict',
                serverData: serverData.rows[0],
              });
  ```
  `clipboard_items` 的列（由 `db/migrations/036_sync_scripts_migrations.sql:46-53` 补齐）包含
  `wrapped_dek_password`、`wrapped_dek_recovery`、`recovery_key_hash`、`protection_salt`、`protection_iv`、`content_encrypted`（最大 10MB）、`search_vector`。
  `serverData.rows[0]` 是**未经映射的原始 DB 行**，直接进响应体。全仓 `SELECT * FROM clipboard_items` 只有这一处（其余列表/详情接口都显式列举列，如 `routes/clipboard.js:166-170`）。

- **失败场景**：用户 A 的设备与服务端发生同步冲突（离线期间另一端改过同一条）→ `POST /api/sync/push` 的响应里 `results[i].serverData` 带上该条目的 `wrapped_dek_password`（用用户密码 PBKDF2 包装的 DEK）、`wrapped_dek_recovery`、`recovery_key_hash`、`protection_salt`。这些值随后进入客户端 HTTP 日志、崩溃上报、代理日志、移动端本地缓存。`recovery_key_hash` + `protection_salt` 构成离线暴破恢复密钥的完整验证器（可无限次尝试而不触发任何服务端计数）。同时响应字段是 `content_type`/`created_at` 这种 snake_case 裸列，与同项目其余接口的 camelCase DTO 不一致，客户端还得单独写一套解析；`content_encrypted` 最大 10MB 也会被整块带出。

- **影响**：**安全（高级保护密钥材料外泄，恢复密钥可离线暴破）+ API 契约不一致 + 性能**。

- **修法**：显式列举冲突响应需要的列（`id, content_type, content_preview, content_size, metadata, is_favorite, expires_at, created_at, updated_at`）并映射成与其他接口一致的 camelCase DTO；`wrapped_dek_*` / `recovery_key_hash` / `protection_salt` / `protection_iv` 只允许经 `routes/protection.js` 的专用端点下发。加一条静态检查/测试禁止对含密文列的表使用 `SELECT *`。

---

### [S2-12] 中间件顺序：body parser（10MB）在限流之前 → 未过闸的大 payload 已进内存

- **证据**：`src/server/src/index.js:174-175`
  ```js
  app.use(express.json({ limit: config.jsonBodyLimit, verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false, limit: config.jsonBodyLimit, verify: captureRawBody }));
  ```
  `config.jsonBodyLimit` 默认 `'10mb'`（`config.js:109-111`，可用 `JSON_BODY_LIMIT` 覆盖）。
  限流挂载点全部在其后：`:402`（`/api/devices` pairing）、`:405`（`/api/ws`）、`:411`（`/api/clipboard`）、`:465`（`/api/webhooks`）、`:554`（`/api/admin`）。全局层面没有任何 pre-body 的限流。
  其余顺序是**正确的**：安全头（`:80-98`）→ requestId（`:103`）→ CORS（`:133`）→ body parser（`:174`）→ 超时（`:186`）→ metrics（`:229`）→ compression（`:239`）→ static（`:265-266`）→ 健康检查（`:272`/`:281`）→ metrics 端点（`:377`/`:381`）→ 业务路由（`:393-554`）→ **404 处理器（`:559-562`）→ errorLogger（`:567`）→ 全局错误处理器（`:568-589`）**。404 在错误处理器之前、错误处理器是 4 参数签名，位置都对。

- **失败场景**：未认证攻击者对 `POST /api/clipboard` 并发发 10MB JSON（500 并发）→ Express 先把 500 × 10MB = **5GB 解析进 V8 堆**，之后 `apiLimiter` 才回 429。Node 默认堆上限约 2-4GB → `Reached heap limit` → 容器 OOMKill。限流器本应在字节进入之前拒绝，现在它保护的是「已经付完成本之后」的请求。`X-Forwarded-For` 伪造（S1-5）还能让这 500 个请求各自落在新桶里，连 429 都拿不到。
  另注：`index.js:168-172` 的 `captureRawBody` 对 `/webhooks/` 路径还会**额外**保留一份原始报文字符串（`req.rawBody = buf.toString('utf8')`），即 webhook 路径上 10MB 会被存两份（这个设计本身是必需的，见 `:154-167` 记录的真实事故，但 webhook 应挂更小的 limit）。

- **影响**：**可用性（内存耗尽 → 实例崩溃）**。

- **修法**：在 body parser **之前**挂一个廉价的 IP 级闸（只看 `req.ip` + `Content-Length`，内存 store 即可），并对 `Content-Length > 阈值` 的请求在解析前直接 413；webhook 路径单独挂更小的 limit（渠道报文通常 <64KB）；把 `JSON_BODY_LIMIT` 写进 `.env.example` 并按实际需要下调。

---

### [S2-13] `users.phone` 明文列与 `phone_encrypted` / `phone_hash` 三副本并存；`HASH_SALT` 取自 `ENCRYPTION_KEY` 前 16 字符且在两个文件重复定义

- **证据**：
  - `scripts/init-db.sql:13` / `src/server/src/db/migrate.js:10`：`phone VARCHAR(20) UNIQUE NOT NULL,` —— 明文列，且 NOT NULL。同表 `:18-21` 又有 `phone_encrypted TEXT`、`phone_hash VARCHAR(128)`。
  - `src/server/src/routes/auth.js:28-38`
    ```js
    // 哈希盐（固定值，用于 phone_hash / email_hash 计算）
    // 修改此值后需重新计算所有用户的哈希值
    const HASH_SALT = process.env.ENCRYPTION_KEY?.substring(0, 16) || 'CLIPSYNC_SALT_2026';

    function computeFieldHash(value) {
      if (!value) return null;
      return crypto.createHash('sha256').update(value + HASH_SALT).digest('hex');
    }
    ```
  - `src/server/src/routes/aiTools.js:50-56` **逐字符复制**了同一段（注释写着「哈希盐与 auth.js 保持一致」）。
  - 登录主路径仍走明文列：`routes/auth.js:315-317` `SELECT ... FROM users WHERE phone = $1`，哈希只是回退（`:320-326`）。

- **失败场景**：
  1. **加密形同虚设**：即使 `phone_encrypted` 用了强密钥，`phone` 明文列就在同一行同一张表里，任何 SQL 读取权限（含 AI 工具面的 `SELECT u.phone`，`routes/aiTools.js:3177`）直接拿到明文。`utils/encryption.js` 与 `db/migrations/009_encrypted_fields.sql` 建立的整套字段加密体系被这一列抵消。
  2. **密钥轮换即登录退化**：`HASH_SALT` 派生自 `ENCRYPTION_KEY` 前 16 字符。运维轮换 `ENCRYPTION_KEY` → 所有用户的 `phone_hash` 瞬间失效 → `auth.js:320` 的哈希查询全部落空 → 退到 `:329-345` 的兜底，而该兜底的 `WHERE` 是 `phone_encrypted IS NOT NULL AND phone_hash IS NULL`，**旧用户的 hash 非空只是不匹配，兜底捞不到他们** → 只能靠 `:315` 的明文列登录。`idx_users_phone_hash` 全部变成垃圾，且没有任何迁移会重算。
  3. **盐与主密钥耦合**：泄漏 `HASH_SALT`（=主密钥前 16 字符）等于泄漏主密钥的一半；反之，用主密钥做哈希盐把密钥的使用面从「加解密」扩大到「可离线暴破的哈希」，违反密钥用途分离。
  4. **双份定义漂移**：`aiTools.js` 的 `create_user`（`:3250`）与 `auth.js` 的注册（`:392`）各算各的 hash。任何人改了其中一处的盐表达式，AI 建的用户就无法用手机号登录。
  5. **哈希强度不足**：中国大陆手机号空间约 10^9（`1[3-9]\d{9}`，见 `validation/validator.js:18`），加盐 SHA-256 单卡每秒可试 10^10 次 → **拿到 `phone_hash` 列即可在分钟内还原全部手机号**。这不是假名化，只是编码。

- **影响**：**合规（个人信息明文存储）+ 安全（哈希可暴破、盐与主密钥耦合）+ 可用性（密钥轮换导致登录退化）**。

- **修法**：①`HASH_SALT` 独立成 `FIELD_HASH_KEY` 环境变量（不与 `ENCRYPTION_KEY` 派生），抽成 `utils/fieldHash.js` 单一实现供两处 import，改用 `crypto.createHmac('sha256', FIELD_HASH_KEY)`；②制定 `users.phone` 明文列的废弃计划（双写 → 登录主路径切到 `phone_hash` → `DROP COLUMN phone`，唯一约束迁到 `phone_hash`）；③写一条可重入、分批的 hash 重算迁移，并把「轮换 ENCRYPTION_KEY 不影响登录」写成显式不变量。

---

### [S2-14] 索引缺口：`clipboard_items.expires_at` 无索引 → 每小时清理全表扫且会被 `statement_timeout` 掐死；列表查询缺 `(user_id, created_at DESC)` 与 pinned 表达式索引

- **证据**：`clipboard_items` 现有全部索引（`grep -rhoE "CREATE (UNIQUE )?INDEX ... ON clipboard_items" db/migrations/*.sql db/migrate.js`）：
  ```
  idx_clipboard_items_user_id            (user_id)
  idx_clipboard_items_created_at         (created_at DESC)           ← 全局，不含 user_id
  idx_clipboard_items_content_type       (content_type)              ← 5 个枚举值，选择性极低
  idx_clipboard_items_favorites          (is_favorite) WHERE is_favorite = TRUE
  idx_clipboard_items_archived           (archived, created_at DESC) ← 不含 user_id
  idx_clipboard_items_protection         (protection_level)          ← 3 个枚举值
  idx_clipboard_items_migration_status   (protection_migration_status)
  idx_clipboard_items_usage              (user_id, usage_count DESC, last_used_at DESC)
  idx_clipboard_search                   GIN(search_vector)
  idx_clipboard_user_content_hash        (user_id, content_hash) WHERE content_type <> 'file'
  idx_clipboard_user_image_hash          (user_id, image_hash) WHERE ...  ← 从未创建，见 S1-1
  ```
  `grep -rn expires_at db/migrations/*.sql db/migrate.js | grep -i index` → **零命中**。
  消费方 1（清理）`src/server/src/db/cleanup.js:26-31`：
  ```js
      const result = await pool.query(
        `DELETE FROM clipboard_items
         WHERE expires_at IS NOT NULL AND expires_at < NOW()
         RETURNING id`
      );
  ```
  由 `index.js:679` `startCleanupScheduler()` 每小时触发（`cleanup.js:8` `CLEANUP_INTERVAL = 60 * 60 * 1000`），且在**每个 worker / 每个实例**上都跑（见 S1-7）。
  消费方 2（最热列表）`src/server/src/routes/clipboard.js:62-92`、`:164-176`：
  ```sql
  WHERE ci.user_id = $1 AND ci.archived = FALSE
    AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
  ORDER BY (COALESCE(ci.metadata->>'pinned', 'false'))::boolean DESC, ci.created_at DESC
  LIMIT $n OFFSET $m
  ```

- **失败场景（数据量级）**：`clipboard_items` 是全库最大的表（跨设备自动捕获；重度用户 10 万+ 条/年，1 万用户即 10^8~10^9 行量级）。
  - **清理**：无 `expires_at` 索引 → 每小时一次**全表顺序扫描**；`db/pool.js:33` 的 `SET SESSION statement_timeout = 30000` 会在 30 秒时把它 cancel 掉 → `cleanup.js:83-87` catch 记一条 error 后返回。**结果是过期条目永远删不掉**：存储无限增长；用户设了「1 小时后过期」的敏感剪贴板（密码、验证码）在过期后仍留在库里——`routes/clipboard.js:88-90` 只是查询时过滤掉、并未真正删除，这与产品对「过期即销毁」的承诺不符，是合规问题。同时每小时白烧 30 秒 CPU + 全表 I/O，× 实例数 × worker 数。
  - **列表**：无 `(user_id, created_at DESC)` 复合索引 → 规划器只能用 `idx_clipboard_items_user_id` 取出该用户**全部**行，回表过滤 `archived`/`expires_at`，再对 `((metadata->>'pinned')::boolean, created_at)` 做显式排序，最后丢弃 OFFSET 之前的行。10 万条/用户 × 每设备每次拉列表 = 每次 10 万行回表 + 排序。多设备（Free 2 台、Pro 10 台、Enterprise 100 台，见 `db/migrate.js:199-202` 与 `011a` 的种子）同时轮询即放大 100 倍。
  - **`COUNT(*)`**（`:158-161`）用同一个 `whereClause` 再扫一遍，**每翻一页都重算总数**。

- **影响**：**可用性/性能（热路径随数据量线性退化）+ 合规（过期数据未真正删除）+ 成本**。

- **修法**：见下方「索引缺口清单」。清理 DELETE 改分批（`... AND id IN (SELECT id FROM clipboard_items WHERE expires_at < NOW() LIMIT 5000 FOR UPDATE SKIP LOCKED)` 循环）避免撞 30s 超时；列表分页改 keyset（`WHERE (pinned, created_at) < ($lastPinned, $lastCreatedAt)`）替代 OFFSET；`total` 改为首屏算一次后缓存或改返回 `hasMore`；删除低选择性索引 `idx_clipboard_items_content_type`、`idx_clipboard_items_protection`、`idx_clipboard_items_migration_status`（纯写放大）。

---

### [S2-15] `POST /api/sync/push` 的 create 分支绕过 `POST /api/clipboard` 的全部校验 → 一条脏数据让整批 50 条离线变更回滚

- **证据**：`src/server/src/routes/sync.js:57-75`
  ```js
          if (action === 'create') {
            // Insert new item
            const result = await client.query(
              `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ...`,
              [ req.userId, deviceId,
                data.contentType || 'text',
                data.contentEncrypted || '',
                data.contentPreview || '',
                data.contentSize || 0,
                JSON.stringify(data.metadata || {}),
                data.expiresAt || null ]
            );
  ```
  与 `routes/clipboard.js:528-722` 的同语义端点相比，缺失的校验：`isValidContentType`（`clipboard.js:561-564`）、10MB 大小上限（`:556-558`）、E2E 信封结构校验（`:576-604`）、`content_hash` 去重 + `pg_advisory_xact_lock`（`:606-673`）、`image_hash` 计算（`:614-624`）、审计日志（`:707-720`）、工作流规则引擎与 OCR 副作用（`:744-770`）。
  `data.contentType` 完全未校验，而 `db/migrate.js:58` 是 `content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('text','image','file','link','code'))`；`data.expiresAt` 未做日期校验；`data.contentSize` 未做数值/非负校验；`data.contentPreview` 未做长度截断（对比 `clipboard.js:568` 的 `.substring(0, 5000)`）。
  外层批量约束只有 `changes.length > 50` → 400（`:34-36`）。

- **失败场景**：移动端离线队列 flush
  ```json
  POST /api/sync/push
  {"deviceId":"<合法UUID>","changes":[
    {"action":"create","data":{"contentType":"text","contentEncrypted":"..."}},
    "...48 条正常...",
    {"action":"create","data":{"contentType":"richtext","contentEncrypted":"..."}}
  ]}
  ```
  第 50 条的 `contentType='richtext'` 违反 CHECK → 内层 catch（`:152-158`）记为 `{status:'error'}` 并 `continue`，但事务已进入 aborted 状态 → 前 49 条的正常写入**全部作废** → `:162` COMMIT 失败 → 外层 `:163-166` ROLLBACK + rethrow → `500 {"error":"Sync push failed"}`。用户离线攒了 3 天的 49 条剪贴板一条都没同步上去，客户端只看到一个笼统的 500。
  即使不含非法类型，`data.expiresAt` 传 `"tomorrow"`、`data.contentSize` 传 `"abc"`、`data.contentPreview` 传 10MB 字符串，都会以同样方式炸掉整批。

- **影响**：**数据（离线队列整批丢失）+ 可用性 + 一致性**（同一份数据两个写入口、校验强度不同 → 经 sync 写入的条目没有 `content_hash` 逃过去重、没有审计、没有 `image_hash` 使图片查重与 AI 重复感知失效、`content_preview` 可能超长）。

- **修法**：把 `POST /api/clipboard` 的校验 + 去重 + 审计逻辑抽成 `services/clipboardWrite.js` 的单一函数，两个路由都调它（`sync/push` 传 `client` 以复用同一事务）；`sync/push` 的每条 change 用 `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` 包裹，让单条失败不污染整批；入参先整体 schema 校验，任一条非法直接 400 并指出下标。

---

### [S2-16] `migrate.js` 的迁移目录用 CWD 相对路径解析，且目录不存在时静默跳过全部 70 个迁移

- **证据**：`src/server/src/db/migrate.js:237-242`
  ```js
      const migrationsDir = path.resolve('./src/db/migrations');

      if (fs.existsSync(migrationsDir)) {
        const files = fs.readdirSync(migrationsDir)
          .filter(f => f.endsWith('.sql'))
          .sort(); // 按文件名排序（004, 005, 006...）
  ```
  `if` 没有 `else`——目录不存在时**一行日志都不打**，直接跳到 `:274` 的 postMigrations，然后 `:280` 打印 `logger.info('All migrations completed successfully.')`。
  当前 Docker 路径是对的（`Dockerfile:36` `WORKDIR /app` + `CMD ["node","src/index.js"]` → `/app/src/db/migrations` 存在，由 `Dockerfile:44` `COPY --from=builder /app/src ./src` 落地），所以生产暂时不炸。

- **失败场景**：任何改变工作目录的启动方式都会静默退化——`cd / && node /app/src/index.js`、systemd 单元没写 `WorkingDirectory`、k8s Deployment 的 `workingDir` 与实际布局不符（仓库里就有 `k8s/` 目录）、CI 从仓库根跑 `node src/server/src/index.js`。此时服务**正常启动、健康检查 200、日志显示「migrations completed successfully」**，但只有 `migrate.js` 内嵌的 8 张 baseline 表存在：`clipboard_templates`、`template_variables`、`surveys`、`shared_links`、`search_history`、`ai_*`（9 张）、`workflow_rules`、`roles`/`permissions`/`role_permissions`、`system_configs`、`feature_flags`、`admin_*`（6 张）、`app_releases`、`refund_requests`、`clipboard_deletions`、`email_channels`、`client_policies`、`runtime_configs` 等**全部不存在**。后果：`middleware/auth.js:52-60` 的 `LEFT JOIN roles r` 让每个请求都进 `:76-79` 的 fail-open 分支（见 S2-17）、`middleware/maintenance.js:41-46` 读 `system_configs` 失败按 off 处理、`utils/featureFlags.js` 读不到开关、所有管理台端点 500。而启动日志一片祥和。

- **影响**：**可用性（静默的 schema 半初始化）+ 可运维性（故障无信号）**。

- **修法**：`migrationsDir` 改为基于模块 URL 解析——`path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')`（`migrate.js` 本身就在 `src/db/` 下）；`fs.existsSync` 为假时 `logger.error` + `process.exit(1)`；迁移结束后核对 `schema_migrations` 行数与目录内 `.sql` 文件数是否一致，不一致即 fail-fast。

---

### [S2-17] `authenticateToken` 的 DB 校验失败时 fail-open：账户停用与会话吊销都不再执行，且 token 自述的角色被保留

- **证据**：`src/server/src/middleware/auth.js:51-86`
  ```js
      try {
        const userCheck = await pool.query(
          `SELECT u.is_active AS user_active, s.is_active AS session_active,
                  r.role_key, r.level AS role_level, u.is_admin
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
           LEFT JOIN user_sessions s ON s.id = $2
           WHERE u.id = $1`,
          [decoded.userId, decoded.jti || null]
        );
        ...
        if (!row.user_active) { return res.status(401).json({ error: 'Account deactivated' }); }
        if (decoded.jti && row.session_active === false) { return res.status(401).json({ error: 'Session revoked' }); }
        ...
      } catch (err) {
        // DB 查询失败：记录告警，但放行（避免误杀正常请求）
        console.warn('[auth] user/session active check failed:', err.message);
      }

      // 角色信息兜底：若上述查询未附加（异常路径），降级为普通用户
      if (!req.user.roleKey) {
        req.user.roleKey = 'user';
  ```
  四处问题：
  1. `catch` 里**直接放行**，`is_active`（账户注销/封禁）与 `session_active`（管理台「强制下线」）两道闸同时失效。注释里的「避免误杀」把可用性置于安全之上，且用的是 `console.warn` 而不是 `logger`（绕过 `utils/logger.js` 的级别控制与文件落盘，生产日志里可能完全看不到）。
  2. `:41` 是 `req.user = decoded`，所以异常路径下 `req.user.roleKey` / `roleLevel` / `isAdmin` **保留 token 里的自述值**；`:82` 的兜底只在 `!req.user.roleKey` 时才降级。当前 `jwt.sign` 的 payload（`routes/auth.js:60-63`、`auth-verify.js:34-37`、`auth-password.js:30`、`auth-refresh.js:57`）确实不含角色字段，所以现在不可利用；但这是一条**依赖签发方自律的隐式契约**——任何一处在 payload 里加上 `roleKey` 就立刻变成「DB 抖动期间 token 自述角色生效」的提权路径。
  3. `optionalAuth`（`:99-119`）更直接，`:114`
     ```js
         req.user.isAdmin = Boolean(req.user.isAdmin) || req.user.roleKey === 'super_admin';
     ```
     **完全信任 token 自述**，且不查库、不查黑名单（`:108` 只 `jwt.verify`，没有 `isJtiBlacklisted`）。消费方 `routes/app.js:45`（`/api/app/policies`）、`:167`（`/api/app/announcements`）目前只用 `req.user?.userId`，所以尚未造成越权；但 `optionalAuth` 是一个已上膛的枪。
  4. 性能：这条三表 JOIN 在**每一个认证请求**上执行、无缓存（`utils/cache.js` 的 `getCacheWithLock` 明明是为此写的却从未接线，见 S3-2）。

- **失败场景**：DB 短暂不可达（PG 主备切换、连接池耗尽见 S1-8、`statement_timeout` 命中）期间，管理台刚「强制下线」的被盗 token 继续有效、刚注销的账户继续有效——正是最需要它们失效的窗口。日志里只有一条 `console.warn`，没有 requestId、没有 userId，事后无法审计这段时间谁访问了什么。

- **影响**：**安全（吊销失效窗口）+ 可审计性 + 性能（每请求一次三表 JOIN）**。

- **修法**：把 fail-open 收窄——DB 查询失败时对**写操作**（非 GET/HEAD/OPTIONS）一律 503，对读操作允许降级但必须在 `req` 上打 `authDegraded=true` 并写结构化审计；`:82` 的兜底改为无条件覆盖（异常路径直接赋 `'user'`/`10`/`false`），并在 `jwt.sign` 处加注释禁止把角色写进 payload；`optionalAuth` 补 `isJtiBlacklisted` 检查、删除 `:114` 对 `req.user.isAdmin` 的自述信任；`console.warn` 改 `logger.warn`；把活性/角色查询接进 `utils/cache.js`（TTL 30-60s + 管理台改权限时主动失效）。

---

### [S2-18] 根目录 `.env.*.example` 有 4 个变量代码从不读取；`METRICS_TOKEN` 未出现在生产模板里

- **证据**（`grep -rn "process.env.<VAR>" src/server/src/` 计数）：

  | `.env.production.example` / `.env.development.example` 里的变量 | 代码读取次数 | 代码实际读的变量 |
  |---|---|---|
  | `API_PORT` | **0** | `PORT`（`config.js:37`、`config/production.js:6`） |
  | `ALLOWED_ORIGINS` | **0** | `CORS_ORIGINS`（`config.js:67-69`、`config/production.js:34`） |
  | `CSRF_SECRET` | **0** | 无此机制（`middleware/csrf.js` 用 Redis/内存存随机 token，不做 HMAC） |
  | `MAX_FILE_SIZE` | **0** | 无（上限硬编码在 `routes/media.js:77`/`:95`、`routes/chunked-upload.js:164`） |

  同时 `src/server/.env.example`（另一份、更完整的模板）里的 `PROMETHEUS_ENABLED`、`METRICS_PORT`、`SENTRY_DSN` 也是**代码读取 0 次**；`ENCRYPTION_ALGORITHM` 虽被 `config.js:77-79` 读进 `config.encryption.algorithm`，但 `utils/encryption.js:57` 是 `const ALGORITHM = 'aes-256-gcm'` 硬编码，**该配置项同样是死的**。
  反向缺口：`index.js:350-359` 的 `METRICS_TOKEN` 是生产必需项（缺失即 `/api/metrics` 返回 503 fail-closed，这个设计本身是对的），它出现在 `src/server/.env.example` 里但**不在 `.env.production.example` 里**。同样缺席生产模板的还有 `DB_POOL_MAX`、`JSON_BODY_LIMIT`、`REQUEST_TIMEOUT`、`CLUSTER_WORKERS`、`STORAGE_TYPE`/`S3_*`、`NODE_ENV`、`DB_SSL`、`NOTIFICATION_RETENTION_DAYS`、`TOMBSTONE_RETENTION_DAYS`、`RELEASE_DOWNLOAD_BASE_URL`、`ENABLE_QUERY_MONITORING`。
  另：`.gitignore:13` 已有 `.env.*`，`:171` 又单独写了一条 `.env.production`（重复规则）。

- **失败场景**：运维照仓库根的 `.env.production.example` 配置生产：
  - 写了 `ALLOWED_ORIGINS=https://clipsync.example.com` → 代码读的是 `CORS_ORIGINS`，未设置 → `config/production.js:34` 给出 `''` → `index.js:117-125` 的 `allowedOrigins` 为空数组 → **所有带 `Origin` 头的浏览器跨域请求被 `callback(new Error('CORS not allowed'))` 拒绝**（`:570-572` 映射为 403）。Web 端完全不可用，而运维看着自己「已经配好的白名单」毫无头绪。这个方向是 fail-closed 所以不算安全漏洞，但是一次完整的上线事故。
  - 写了 `API_PORT=3000` → 无效（幸好 compose 显式设了 `PORT`）。
  - 写了 `MAX_FILE_SIZE=10485760` 以为限了 10MB → 实际 `routes/media.js:95` 允许 1GB（见 S1-9）。
  - **没写** `METRICS_TOKEN` → `index.js:353-356` `logger.error` 后 `/api/metrics` 恒 503 → Prometheus 抓取全部失败，监控面板空白（而 `docker-compose.monitoring.yml` 存在，说明监控是预期要用的）。

- **影响**：**可运维性（文档化的安全/容量控制静默失效）+ 上线风险**。

- **修法**：删除根目录 `.env.development.example` / `.env.production.example`，只保留 `src/server/.env.example` 一份（在 README 里指路）；或让两份保持同步并由 CI 校验「模板里的每个键都在代码中被读取、代码读取的每个键都在模板中列出」。启动时对所有已识别但未使用的 env 键打一条 warn。删掉 `.gitignore:171` 的重复规则。`ENCRYPTION_ALGORITHM` 要么接进 `utils/encryption.js`，要么从配置与模板里删除。

---

### [S2-19] 写接口输入校验缺口：模板内容/条数无上限、模板变量条数无上限、模板列表接口无分页

- **证据**：
  - `src/server/src/routes/templates.js:28-38`
    ```js
        const { name, content } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) {
          return res.status(400).json({ error: 'Template name is required' });
        }
        const safeName = name.trim().slice(0, 200);
        const safeContent = typeof content === 'string' ? content : '';
    ```
    `name` 截断到 200，`content` **完全不截断**（`clipboard_templates.content` 是 `TEXT NOT NULL DEFAULT ''`，见 `db/migrations/017_templates.sql:14`），仅受 `index.js:174` 的 10MB body 上限约束。`:60-63` 的 PUT 同样 `params.push(content)` 无长度校验。**没有每用户模板条数上限**——`index.js:486-490` 的注释明确写「模板库路由（免费功能，不挂 subscriptionCheck）」。
  - `:11-18` 的 `GET /` 无分页、无 LIMIT，且 SELECT 列表含完整 `content`：
    ```js
        const { rows } = await pool.query(
          `SELECT id, name, content, created_at, updated_at
           FROM clipboard_templates
           WHERE user_id = $1
           ORDER BY created_at DESC`,
          [req.userId]
        );
    ```
  - `src/server/src/routes/templateVariables.js:11-12` 有 `MAX_NAME = 60` / `MAX_VALUE = 10000` 且**都用上了**（`:39-40`），这部分做得对；缺的是**每用户变量条数上限**——每次 PUT 一个新 name 就新增一行（`:43-49` 的 upsert 只在 name 重复时更新）。
  - `:36-38` `NAME_RE.test(name)` 的正则 `/^[a-zA-Z_][a-zA-Z0-9_]*$/` **无长度约束**，通过后才 `name.slice(0, MAX_NAME)` 截断 → 两个前 60 字符相同的超长变量名会互相覆盖（`:45` 的 `ON CONFLICT (user_id, name)`），用户看到的是「保存成功但值串了」。
  - 正面对照：`routes/clipboard.js:556-558`（10MB 上限）、`:568`（preview 截断 5000）、`routes/media.js:378-386`（`paths` 数组 ≤50 项、每项 ≤1024 字符）都做了边界防护。

- **失败场景**：Free 用户脚本化调用 `POST /api/templates {"name":"t<i>","content":"<10MB 随机串>"}` 两万次。`apiLimiter` 是 300 次/分钟（`rateLimiter.js:242`），一小时即可写入 1.8 万条 × 10MB ≈ **180GB** 到 `clipboard_templates`（无任何套餐配额拦截）。之后该用户自己的 `GET /api/templates` 会把这 180GB 全量拉进 Node 堆（无 LIMIT）→ 立即 OOM（同 S1-6 的机制）；`scripts/backup-db.sh` 的 `pg_dump` 时长与体积同步爆炸。模板变量同理（每条 ≤10KB，需要更多条但同样无上限）。

- **影响**：**可用性（存储滥用 + 列表接口 OOM）+ 成本 + 数据正确性（变量名截断导致覆盖）**。

- **修法**：`templates.js` 给 `content` 加长度上限（建议 ≤64KB，与「文本模板」语义匹配）、给每用户模板数加套餐化上限（挂 `subscriptionCheck` 或复用 `utils/planLimits.js`）、`GET /` 加分页（复用 `validatePagination`，去掉 `all`）；`templateVariables.js` 加每用户变量数上限（如 200）、把 `NAME_RE` 改成带长度约束的 `/^[a-zA-Z_][a-zA-Z0-9_]{0,59}$/` 从而去掉截断歧义。

---

### [S2-20] 审计归档一次性把全部超期行读进内存；管理台列表 `COUNT(*)` + 深 OFFSET 无防护

- **证据**：
  - `src/server/src/db/cleanup.js:157-166`
    ```js
      const { rows } = await pool.query(
        `SELECT id, created_at, user_id, action, resource_type, resource_id, status,
                ip_address::text AS ip_address, user_agent, error_message, details
         FROM audit_logs
         WHERE created_at < NOW() - make_interval(days => $1)
         ORDER BY created_at ASC`,
        [retentionDays]
      );
    ```
    无 LIMIT、无分批。`:169-186` 把全部行 `.map()` 成巨型字符串数组，`:188` `lines.join('\n')` 再拼成一个字符串，`:196` 一次 `fs.appendFile`；`:206` `` DELETE FROM audit_logs WHERE id = ANY($1) `` 把全部 id 作为单个数组参数。
  - 保留天数可被管理台在线调低：`:133-146` `readAuditRetentionDays()` 读 `system_configs.audit_log_retention_days`（默认 365）。
  - 管理台列表的 `COUNT(*)` + 深 OFFSET：`routes/admin/users.js:336`、`routes/admin/audit.js:331`、`routes/admin/orders.js:209`、`routes/admin/devices.js:201`、`routes/admin/subscriptions.js:113` 全部是 `${...whereSql} ORDER BY ... LIMIT $n OFFSET $m` 配一条独立的 `SELECT COUNT(*)`；`routes/admin/users.js:48-78` 的 `USER_SELECT` 每行还带 **5 个相关子查询**（`device_count` / `last_active_at` / `last_active_platform` / `order_count` / `total_spent`）。
  - `utils/audit.js:169` `let query = 'SELECT * FROM audit_logs WHERE 1=1'` —— `getAuditLogs` 用 `SELECT *`（含 `details` JSONB），且 `:210` `params.push(limit, offset)` 的 `limit` **未做任何上限校验**；唯一调用方是 `routes/aiTools.js:14` 导入的 AI 工具面（LLM 可控参数）。

- **失败场景**：
  - **归档 OOM**：管理员在管理台把 `audit_log_retention_days` 从 365 调到 7（合规要求缩短留存是常见操作）。下一轮小时级清理（`cleanup.js:8`）要把 358 天的全部审计行一次性读进 Node 堆——按每天 10 万条审计（每次剪贴板增删本应各一条，见 S1-4）× 358 天 × 每行含 JSONB `details` 约 1KB ≈ **35GB** → 立即 OOM，容器崩溃；即使侥幸不崩，`ANY($1)` 收到一个 3500 万元素的数组，PG 侧参数解析即失败。
  - **深分页**：管理台用户列表翻到第 900 页（`validatePagination` 允许 page ≤1000，`validation/validator.js:207`）→ `OFFSET 45000`，PG 必须生成并丢弃前 45000 行，每行还要跑 5 个相关子查询 → 单次请求数十秒，撞 `statement_timeout=30000` 后 500。
  - **AI 工具面**：LLM 调审计查询工具时传 `limit=1000000` → `getAuditLogs` 无上限 → 把百万行 `SELECT *`（含全部 `details` JSONB）拉进内存并塞进 AI 上下文。

- **影响**：**可用性（清理任务 OOM 拖垮实例）+ 性能（管理台深分页超时）**。

- **修法**：归档改分批循环（每批 `LIMIT 5000 ... FOR UPDATE SKIP LOCKED`，写一批删一批直到无行），CSV 用 `createWriteStream` 流式追加而不是先 join 成大字符串；`getAuditLogs` 的 `limit` 钳到 ≤500 并把 `SELECT *` 改成显式列；管理台列表改 keyset 分页（`(created_at, id)` 游标）；`USER_SELECT` 的 5 个相关子查询改为一次性 `LEFT JOIN LATERAL`，或在列表页去掉统计列、留给详情页按需查。

---

### [S2-21] `GET /api/notifications/history` 的 `limit`/`offset` 未钳制、未判类型 → `?limit=abc` / `?offset=-1` 直接 500，`?limit=1e9` 可拉全表

- **证据**：`src/server/src/routes/notifications.js:54-63`
  ```js
  router.get('/history', authenticateToken, async (req, res) => {
    try {
      const { limit = 50, offset = 0, status } = req.query;

      const history = await notificationService.getNotificationHistory(
        req.user.userId,
        { limit: parseInt(limit), offset: parseInt(offset), status }
      );
  ```
  `src/server/src/services/notificationService.js:59-74`
  ```js
  export async function getNotificationHistory(userId, options = {}) {
    const { limit = 50, offset = 0, status } = options;

    let query = 'SELECT * FROM notification_history WHERE user_id = $1';
    ...
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
  ```
  三层都没有钳制：路由层 `parseInt` 后直接传，服务层的默认值只在 `undefined` 时生效（`parseInt('abc')` 是 `NaN` 而不是 `undefined`，默认值不触发），且 `SELECT *` 会带出 `content` 与 `metadata` JSONB。
  同一路由族还有：`PUT /api/notifications/history/:id/read`（`:73-79`）把 `req.params.id` 原样交给 `notificationService.markNotificationAsRead`（`:81-89`）的 `WHERE id = $1`，而 `notification_history.id` 是 `SERIAL`（integer，见 `005_notification_preferences.sql:35`）——传 `abc` 或 UUID 字符串即 `invalid input syntax for type integer` → 500。
  `PUT /api/notifications/preferences`（`:31-37`）的 `notificationType` 未做白名单/长度校验（列是 `VARCHAR(50)`），`enabled` 未做 `typeof === 'boolean'` 校验。
  注意挂载点 `index.js:446` `app.use('/api/notifications', authenticateToken, notificationRoutes);` —— **既没有 `apiLimiter` 也没有 `csrfProtection`**，是全部业务路由里唯一两者都缺的（`/api/sessions`（`:443`）同样缺 `apiLimiter`）。

- **失败场景**：
  - `GET /api/notifications/history?limit=abc` → `NaN` 传给 PG → `invalid input syntax for type bigint: "NaN"` → 500。
  - `GET /api/notifications/history?offset=-1` → PG `OFFSET must not be negative` → 500。
  - `GET /api/notifications/history?limit=1000000000` → 该用户全部通知历史（含 `content` 全文与 `metadata`）一次性拉进 Node 堆 → 内存尖峰；配合无 `apiLimiter`，可被单个登录用户高频重复调用放大。
  - `PUT /api/notifications/history/abc/read` → 500 而非 400。
  - `PUT /api/notifications/preferences {"notificationType":"<51字符>","enabled":{}}` → `value too long for type character varying(50)` / boolean 转换失败 → 500。

- **影响**：**API 契约（该 400 返 500）+ 可用性（无界查询）+ 缺限流**。

- **修法**：路由层改用 `validatePagination(limit, offset)` 并去掉 `all` 分支（见 S1-6）；`notificationService.getNotificationHistory` 内部再钳一次（`Math.min(Math.max(1, Number(limit)||50), 100)`、`Math.max(0, ...)`）作为纵深防御；`SELECT *` 改显式列；`/history/:id/read` 加 `Number.isInteger(+id)` 校验；`preferences` 加 `notificationType` 白名单（与 `005_notification_preferences.sql:56` 的种子清单对齐）+ `typeof enabled === 'boolean'`；`index.js:443`、`:446` 补 `apiLimiter`。

---

### [S3-1] `src/server/` 根目录的 4 个一次性修补脚本：已无法运行、且一旦能运行就是破坏性的

- **证据**：`src/server/package.json:4` 是 `"type": "module"`，而这 4 个脚本全部用 CommonJS：
  - `check-syntax.js:1` `const fs = require('fs');`
  - `fix-merged-lines.js:1` `const fs = require('fs');` + `:2` `const filePath = 'src/routes/subscriptions.js';`（硬编码目标）+ `:96` `fs.writeFileSync(filePath, newContent, 'utf8');`（**原地覆写源文件，无备份、无 dry-run**）
  - `fix-subscriptions.js:1` `const fs = require('fs');` + `:90` 写 `filePath + '.fixed'`
  - `fix-merged-lines.mjs` 是同逻辑的 ESM 版本（**唯一一个真能跑起来的，也是唯一一个会原地覆写 `src/routes/subscriptions.js` 的**）

  在 `"type":"module"` 包内 `node fix-merged-lines.js` 会直接 `ReferenceError: require is not defined`，所以三个 `.js` 当前一个都跑不起来。
  `check-syntax.js:5-45` 的实现是手写括号/反引号计数器，不理解字符串字面量、正则字面量与注释——任何含反引号的字符串或含 `{` 的注释都会让它给出错误结论；`node --check <file>` 是正确工具。
  三个脚本的 mtime 都是 `Jun 29 15:09-15:11`，与它们要修的那次「`//` 注释与代码被合并到同一行」的坏合并同期；`src/routes/subscriptions.js` 早已修复（当前 490 行、语法正常）。
  `.dockerignore` 排除了 `node_modules`/`.env`/`*.md`/`.git`，**没有排除这 4 个脚本**，所以它们会进 builder 镜像层；不过 `Dockerfile:47` 的 runtime stage 只 `COPY --from=builder /app/src ./src`（+ `views` + `public`），所以**不会进最终运行镜像**——这一点是安全的。

- **失败场景**：某位新同事看到 `fix-merged-lines.mjs`，以为它是常规工具，执行 `node fix-merged-lines.mjs` → 它按正则启发式把 `src/routes/subscriptions.js`（支付订阅核心文件）**原地重写**，把任何形如 `// 注释 await foo()` 或行尾带 `xxx =` 的正常代码拆成两行，产生一批语法正确但语义错乱的代码，且没有备份、`git status` 之外无任何痕迹。

- **影响**：**代码卫生 + 潜在的破坏性误操作**。

- **修法**：`git rm` 这 4 个文件（历史里仍可找回）；如需保留，移到 `scripts/archive/2026-06-merge-repair/` 并在文件头加 `throw new Error('one-shot script, already applied, do not run')`；`.dockerignore` 补 `fix-*.js`、`fix-*.mjs`、`check-syntax.js`、`tests/`、`logs/`、`uploads/`、`vitest.config.js`。语法检查改用 `package.json` 里加一条 `"lint:syntax": "find src -name '*.js' -print0 | xargs -0 -n1 node --check"`。

---

### [S3-2] 死代码与「双实现」残留（8 处，约 1200 行）

- **证据**（每条都已确认零有效调用方）：

  | 文件 | 状态 | 证据 |
  |---|---|---|
  | `src/server/src/routes/health.js`（89 行） | 死 | `grep -rn "routes/health" src/` 只命中 `index.js:322` 的**注释**；`index.js:272-340` 自己内联实现了 `/api/health` 与 `/api/ready` |
  | `src/server/src/routes/metrics.js`（57 行） | 死 | 唯一引用者是死掉的 `utils/route-loader.js:32`；`index.js:377-384` 自己内联实现了两个 metrics 端点 |
  | `src/server/src/utils/route-loader.js`（~120 行） | 死 | `grep -rn "route-loader" src/ tests/` 零命中；`index.js:22-72` 用显式 import 挂载全部路由 |
  | `src/server/src/db/migrate-manager.js`（~470 行） | 死且危险 | 只有自身 `:421` 的 CLI 守卫引用；**是 `content_diff` 唯一的建列处**（S1-2 的根因）；`:56-58` 还会创建与 `migrate.js:183-191` 冲突的第二个 search_vector 触发器 `clipsync_search_vector_update` |
  | `src/server/src/utils/db-retry.js` 的 `executeWithRetry`（~145 行） | 死 | `grep -rn "executeWithRetry" src/` 只命中定义处；同文件只有 `memoryMonitor`（`:147`）被 `index.js:234` 使用 |
  | `src/server/src/utils/cache.js` 的 `getCacheWithLock`/`acquireLock`/`CACHE_TTL`/`CACHE_PREFIX`/`EMPTY_RESULT` | 死 | 唯一引用方 `routes/auth-profile.js:8` 只 import `getUserCache, setUserCache, clearUserCache`；整套缓存击穿/穿透防护（`:22-50`）从未接线 |
  | `src/server/src/middleware/metrics.js:7` 的 `requests.byPath` | 死字段 | 声明后从未被写入（`:18-40` 只写 `byMethod`/`byStatus`），`getMetrics()`（`:71-97`）也不输出它 |
  | `src/server/src/utils/encryption.js:56`、`:71`、`:77-79` 的 `IV_RAW`/`IV` | 死 | `encrypt()`（`:91`）用 `crypto.randomBytes(IV_LENGTH)`，从不使用模块级 `IV`；但 `.env.example` 与文件头注释（`:13`）仍在文档化 `ENCRYPTION_IV` |

  另有 `src/server/package.json:16` `"db:seed": "node src/db/seed.js"` —— `src/db/` 下**没有 seed.js**（实际文件：`cleanup.js`、`migrate-manager.js`、`migrate.js`、`pool.js`、`reset.js`、`migrations/`），`npm run db:seed` 必然 `ERR_MODULE_NOT_FOUND`。
  `scripts/migrations/`（5 个文件）也是孤儿目录：`grep -rn "scripts/migrations" src/ scripts/ docker-compose*.yml` 零命中，其内容靠 `src/server/src/db/migrations/036_sync_scripts_migrations.sql` 手工复制过来；其中 `004_add_collections_and_tags.sql` 建的 `tags` 表**全仓代码零引用**（`grep -rn "FROM tags\|INTO tags\|clip_tags\|item_tags" src/server/src/` → 0），`010_unified_protection.sql` 还含一段 Supabase 专有的 `CREATE POLICY ... USING (user_id = auth.uid())`（`auth.uid()` 在原生 PG 不存在，直接执行会失败——`036` 的头注释确认了这一点并跳过了该段）。

- **影响**：**可维护性**。最严重的一条是 `migrate-manager.js`：它是一个**看起来能用、实际会建出与主迁移链冲突的 schema** 的并行系统，且已经造成了 S1-2。`routes/health.js` 与 `index.js` 内联版本的 Redis 检查逻辑已经漂移（前者每次探针 `Redis.createClient()` + `connect()` + `quit()`，后者复用 `getRedisClient()`），未来改错文件的风险很高。

- **修法**：`git rm` 上述死文件/死函数与 `scripts/migrations/` 整个目录（内容已内联进 036）；`package.json` 删掉 `db:seed` 或补上 `src/db/seed.js`；`metrics.js` 删掉 `byPath`；`encryption.js` 删掉 `IV_RAW`/`IV` 并从 `.env.example` 移除 `ENCRYPTION_IV`；`utils/cache.js` 要么把 `getCacheWithLock` 接到 `subscriptionCheck`/`authenticateToken`（那里每请求都在查库），要么删掉。

---

### [S3-3] `jsdiff@1.1.1`：一个约十年未更新、已被 `diff` 取代的依赖，用在处理用户内容的路径上

- **证据**：`src/server/package.json:34` `"jsdiff": "^1.1.1"`；实装版本经 `node -e "require('./node_modules/jsdiff/package.json').version"` 确认为 `1.1.1`。唯一使用点：
  `src/server/src/routes/sync.js:7` `import * as jsdiff from 'jsdiff';`
  `src/server/src/routes/sync.js:110-116`
  ```js
            let contentDiff = data.contentDiff || null;
            if (!contentDiff && data.contentPreview && data.contentPreview.length > 10240) {
              try {
                const oldPreview = serverItem.content_preview || '';
                contentDiff = jsdiff.createPatch('content', oldPreview, data.contentPreview);
  ```
  npm 上的 `jsdiff` 是 `diff` 的旧别名包，长期未维护；活跃维护的是 `diff`。其余依赖版本都相当新（`express 5.2.1`、`pg 8.22.0`、`redis 6.0.0`、`multer 2.2.0`、`sharp 0.35.2`、`stripe 22.3.0`、`uuid 14.0.1`、`@aws-sdk/client-s3 3.1130.0`、`bcryptjs 3.0.3`、`nodemailer 6.10.1`），这一个明显是异类。
  另：`devDependencies` 里的 `supertest` 确实在 `tests/admin/*.test.js`（10 个文件）中使用，**不是无用依赖**；`node_modules` **未被误提交**（`git ls-files src/server/node_modules | wc -l` → 0，`git ls-files node_modules` → 0，`.gitignore:2` 有 `node_modules/`）——这一项是干净的。

- **失败场景**：`sync.js:110` 的条件是 `data.contentPreview.length > 10240`，而 `data.contentPreview` **未做长度校验**（对比 `clipboard.js:568` 的 `.substring(0, 5000)`），因此一个 10MB 的 preview 会走进这个十年前的 diff 实现。`jsdiff@1.x` 的 diff 在最坏情况（长文本、大量重复片段）下是 O(n²) 且无输入上限 → 长时间占住一条事务连接（且该事务因 S1-2 的 `content_diff` 缺列本来就必然失败）。同时这是一个无安全维护的传递性风险面。

- **影响**：**依赖健康 + 性能**。

- **修法**：换成 `diff`（API 兼容：`import { createPatch } from 'diff'`）；给 `sync/push` 的 `data.contentPreview` 加与 `clipboard.js:568` 一致的 5000 字符截断。

---

### [S3-4] 优雅停机：`server.close()` 未 await、强制退出 setTimeout 是不可达死代码

- **证据**：`src/server/src/index.js:709-778`
  ```js
  async function gracefulShutdown(signal) {
    ...
    // 1. 停止接受新连接
    server.close(() => {
      logger.info('HTTP server closed (no longer accepting connections)');
    });
    ...
    // 4. 关闭数据库连接池
    try { await pool.end(); ... }
    ...
    logger.info('Graceful shutdown complete, exiting...');
    process.exit(0);                     // :771

    // 强制退出（10秒超时）
    setTimeout(() => {                    // :774  ← 永不执行
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  }
  ```
  `:771` 的 `process.exit(0)` 在 `:774` 的 `setTimeout` 注册**之前**执行，进程已经退出，那个「10 秒强制退出兜底」是**不可达代码**。
  `:720` 的 `server.close()` 只注册了回调、**没有 await**，所以 `:746` 的 `await pool.end()` 会在仍有在途 HTTP 请求时就执行。`pg.Pool.end()` 会关闭包括**正在使用中**的 client，因此尚未完成的请求会拿到 `Connection terminated unexpectedly`。
  `:730` 的 `await gracefulShutdownWs(10000)` 给了 WebSocket 10 秒排空窗口，这段时间**顺带**让一部分 HTTP 请求跑完了——但这是巧合而非设计。
  正确的部分（应保留）：`:725-726` 停了两个 sweep 定时器；`:736-742` 关了 wss；`:753-768` 关了 Redis 与 WS Pub/Sub；`:780-781` 注册了 SIGTERM/SIGINT；`:784-790` 的 `uncaughtException` 会走优雅停机；`:792-796` 的 `unhandledRejection` 有处理（只记录、不退出，Node 22 下是合理选择）。
  相关：`db/cleanup.js:13` 与 `middleware/idempotency.js:42` 的 `setInterval` **没有 `.unref()`**（其余 5 个定时器都正确 unref 了，见 `services/deviceOnlineSweep.js:97`、`services/orderCloseSweep.js:83`、`services/fileRetentionCleanup.js:430`、`utils/versionManager.js:396`、`middleware/metrics.js:126`），所以没有 `process.exit(0)` 进程根本退不出去——这也解释了为什么那个 `exit(0)` 是必需的、以及为什么强制退出兜底从未被需要过。

- **失败场景**：`docker compose stop`（默认 10s SIGTERM 宽限）或 k8s 滚动更新时，一个正在处理 `POST /api/clipboard`（事务已 BEGIN、已插入、尚未 COMMIT）的请求，在 `pool.end()` 时连接被强关 → 事务回滚 → 客户端收到网络错误并重试。带 `Idempotency-Key` 的写请求有保护（见 S2-9），但**未带幂等键的写请求（`sync/push`、`favorites`、`templates`、`aiConversations`）会产生重复或丢失**。

- **影响**：**可用性（滚动更新期间的在途请求丢失）**。

- **修法**：`await new Promise(r => server.close(r))` 并用 `Promise.race` 加「最长等待 N 秒」；把 `:774` 的强制退出 `setTimeout(...).unref()` **移到函数最开头**（在任何 await 之前注册）使其真正成为兜底；`db/cleanup.js:13` 与 `middleware/idempotency.js:42` 补 `.unref()`；`pool.end()` 之前先 `server.closeIdleConnections()` 并等待活跃连接归零或超时。

---

### [S3-5] `028_roles.sql` 把一个真实手机号硬编码为 super_admin

- **证据**：`src/server/src/db/migrations/028_roles.sql:1-5` 头注释
  ```sql
  -- 028: 可配置角色（临时超管方案）
  -- 范围：仅建表 + 种子默认三角色 + 种子权限目录
  --      + 把 13505110772 设为 super_admin，其余用户默认 user。
  ```
  `:65-69`
  ```sql
  UPDATE users
  SET role_id = (SELECT id FROM roles WHERE role_key = 'super_admin')
  WHERE phone = '13505110772'
    AND role_id IS DISTINCT FROM (SELECT id FROM roles WHERE role_key = 'super_admin');
  ```
  `:76-78` 还据此把 `is_admin` 置 TRUE。配套的 `037_super_admin_protection.sql` 加了触发器限制「只能有一个 super_admin」，说明这个身份是有实权的。

- **失败场景**：①这个号码是 PII，永久留在公开仓库的迁移历史里（`git log -p` 可查），且它是「平台最高权限账号」的标识——针对性 SIM swap / 短信劫持的价值极高，而登录链路正是「手机号 + 短信验证码」（`routes/auth-verify.js`），一旦该号码的短信被劫持即等于平台沦陷。②开发/测试环境若走 mock 短信（`docs/production-roadmap/external-dependencies.md` 第 13 项记载「短信服务纯 mock」），任何人都能用这个号码登录并直接成为 super_admin。③生产 bootstrap 依赖一条数据迁移而非受控流程，无法在不改迁移的情况下更换超管。

- **影响**：**安全（硬编码特权身份 + PII 入库）**。定级 S3 是因为它需要「攻击者控制该手机号」这个前置条件，且 `037` 的触发器限制了扩散面；但它是必须在 v1 前清掉的技术债。

- **修法**：把超管 bootstrap 改成环境变量驱动（`BOOTSTRAP_SUPER_ADMIN_PHONE`，仅在 `roles` 表为空时生效一次，用完即从环境中移除），迁移文件里删掉硬编码号码；用 `git filter-repo` 清理历史（或至少在文档里登记该号码已泄露并更换）；生产超管的授予改为「已有超管在管理台任命」+ 双人复核。

---

### [S3-6] `utils/audit.js` 的审计兜底分支是空操作，注释与实现不符

- **证据**：`src/server/src/utils/audit.js:70-87`
  ```js
    } catch (err) {
      logger.error('Failed to log audit event', { error: err.message, action });
      // 兜底：单条审计失败（如 resource_id 约束不兼容）不得让审计整条丢失，
      // 降级为 resource_id 置空、把原始标识并入 details 后重试一次。
      try {
        const fallbackDetails = {
          ...(details ?? {}),
          __resourceId: safeResourceId ?? undefined,
          __auditInsertError: err.message,
        };
        await insert(false);
        logger.warn('Audit event recovered with null resource_id', { action });
        void fallbackDetails;
  ```
  `insert`（`:49-66`）的 `$5` 用的是闭包里的 `details`，**不是 `fallbackDetails`**；`:82` 的 `void fallbackDetails;` 是纯粹的空语句。注释承诺的「把原始标识并入 details」从未发生。

- **失败场景**：`logAuditEvent` 因 `resource_id` 类型不兼容失败时（`045_audit_resource_id_text.sql` 已把该列改成 TEXT，所以现在很少触发），兜底重试会成功写入一条 `resource_id = NULL`、`details` 里**也没有** `__resourceId` 的审计记录 → 事后无法知道这条审计对应哪个资源，审计价值大打折扣；而 `void fallbackDetails;` 会让任何静态分析工具认为该变量「已被使用」，掩盖这个 bug。

- **影响**：**数据（审计信息丢失）+ 代码可信度（注释撒谎）**。

- **修法**：把 `insert` 改成接受 details 参数（`insert(withResourceId, detailsToUse)`），兜底调用 `insert(false, fallbackDetails)`；删掉 `void fallbackDetails;`。

---

### [S3-7] `notification_history` 被两个迁移用**不兼容的 schema** 定义，当前靠文件排序侥幸一致

- **证据**：
  - `db/migrations/005_notification_preferences.sql:34-45`
    ```sql
    CREATE TABLE IF NOT EXISTS notification_history (
      id SERIAL PRIMARY KEY,
      ...
      title VARCHAR(255) NOT NULL,
      content TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'pending')),
      sent_at TIMESTAMP,
      read_at TIMESTAMP,
      metadata JSONB,
    ```
  - `db/migrations/015_notification_retention.sql:3-11`
    ```sql
    CREATE TABLE IF NOT EXISTS notification_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ...
      title TEXT,
      body TEXT,
      data JSONB DEFAULT '{}',
      read BOOLEAN DEFAULT FALSE,
    ```
  两者列名、主键类型、约束完全不同，且都是 `IF NOT EXISTS`——**谁先跑谁定形**。`migrate.js:242` 按文件名排序，`005` < `015`，所以 005 的形状胜出。代码侧（`services/notificationService.js:101` `INSERT INTO notification_history (user_id, notification_type, title, content, status, sent_at, metadata)`、`routes/aiTools.js:4373` `SET read_at = COALESCE(read_at, NOW())`）用的正是 005 的列，**当前是一致的**。
  `015` 的头注释自称「确保 notification_history 表存在（部分环境 005 迁移可能未建表）」——说明历史上真的出现过 005 未执行的环境。

- **失败场景**：任何一个「005 未被记录为已应用」的库（手工修过 `schema_migrations`、从旧备份恢复、或 S2-16 的静默跳过路径导致部分迁移缺失），015 会先建出 `body/data/read` 版本；此后 `notificationService.js:101` 的 INSERT 报 `column "content" of relation "notification_history" does not exist` → 所有通知落库失败（`ws/server.js:492` 的注释记载过「只推 WS 不落库导致 GET /history 永远为空」的同类事故）。`aiTools.js:4373` 的 `read_at` 同样会炸。另外 `id` 在 005 是 `SERIAL`（integer），而 `aiTools.js:4373` 的 `WHERE id = $1` 若被 LLM 传入 UUID 字符串会报 `invalid input syntax for type integer`。

- **影响**：**数据/schema 一致性（潜伏，取决于迁移历史）**。

- **修法**：删掉 `015` 里的 `CREATE TABLE` 段（只保留它的 `idx_notification_history_created_at` 索引），让 005 成为唯一定义处；或反过来统一到 015 的形状并写一条数据迁移。无论选哪个，都应在 `migrate.js` 里加一条启动自检：对关键表断言「必须存在的列集合」，缺列即 fail-fast（见「建议补充的功能」#1）。

---

### [S3-8] 数据模型与注释矛盾：`favorite_collection_items` 声称多对多，实际有 UNIQUE(item_id) 限制为一对一

- **证据**：`scripts/init-db.sql:104-111`
  ```sql
  -- 收藏夹与剪贴板项的关联表（多对多）
  CREATE TABLE IF NOT EXISTS favorite_collection_items (
    collection_id UUID NOT NULL REFERENCES favorite_collections(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    added_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (collection_id, item_id)
  );
  ```
  而生效迁移 `db/migrations/036_sync_scripts_migrations.sql:40` 追加了
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fci_unique_item ON favorite_collection_items(item_id);
  ```
  即**一个剪贴板条目只能属于一个收藏夹**，与「多对多」的注释和 `PRIMARY KEY (collection_id, item_id)` 的设计意图直接矛盾。

- **失败场景**：用户把一条剪贴板加入收藏夹 A（成功），再尝试加入收藏夹 B → `duplicate key value violates unique constraint "idx_fci_unique_item"` → `routes/favorites.js` 的 catch → 500（而不是「已在其他收藏夹，是否移动？」这样的 409 + 明确文案）。`routes/clipboard.js:811` 取消收藏时的 `DELETE FROM favorite_collection_items WHERE item_id = $1`（不带 collection_id）也印证了代码是按「一条目一收藏夹」写的，但表注释与主键设计是按多对多写的——三方不一致。

- **影响**：**数据模型清晰度 + 用户体验（500 而非 409）**。

- **修法**：先明确产品语义。若确定是一对一（当前实现），把 `PRIMARY KEY` 改成 `(item_id)`、删掉多余的 `idx_fci_unique_item`、把注释改为「一个条目最多属于一个收藏夹」，并把插入冲突映射成 409 +「移动到其他收藏夹」的语义；若要支持多对多，删掉 `idx_fci_unique_item` 并修 `clipboard.js:811`（以及 `:1064`、`:1119`）的 DELETE 加上 `collection_id` 条件。

---

## Schema ↔ 代码一致性核对结果

核对方法：从 `src/server/src/db/migrate.js`（内嵌 baseline + postMigrations）、`src/server/src/db/migrations/*.sql`（70 个文件）、`scripts/init-db.sql`（**仅 dev 挂载**，见 `docker-compose.dev.yml:25`）三处提取每张表的列集合，再对代码里所有 `SELECT`/`INSERT`/`UPDATE` 的列引用做别名归一（`ci.` / `c.` / `u.` / `us.` / `po.` / `sp.` / `al.` / `d.` / `r.` / `rr.`）后逐一比对。

### 对不上的列（6 行 / 4 个独立缺陷，全部会导致 500）

| # | 表 | 代码引用的列 | 实际列名 / 状态 | 代码位置 | 后果 | 对应问题 |
|---|---|---|---|---|---|---|
| 1 | `clipboard_items` | `image_hash` | 仅由 `031_image_hash.sql` 创建，**该迁移因版本号 `031` 与 `031_ai_provider_context_window.sql` 撞车而被永久跳过**（`migrate.js:245`） | `routes/clipboard.js:688`（INSERT 列表） | 全新库上 `POST /api/clipboard` 恒 500，核心写入全挂 | **S1-1** |
| 2 | `clipboard_items` | `content_diff` | **任何生效迁移都不创建**；唯一建列处在从未被调用的 `db/migrate-manager.js:69` | `routes/sync.js:125`（UPDATE）、`:265`/`:281`（SELECT）、`:310`（响应映射） | `GET /api/sync/pull/:deviceId` 恒 500；`POST /api/sync/push` 含 update 时整批回滚丢数据 | **S1-2** |
| 3 | `clipboard_items` | `c.type` | 实际是 `content_type` | `routes/aiTools.js:2113`、`:2249` | AI 工具 `find_duplicates` / `export_data` 恒失败 | **S1-3** |
| 4 | `clipboard_items` | `c.content` | 实际是 `content_encrypted` | `routes/aiTools.js:2113`、`:2249` | 同上 | **S1-3** |
| 5 | `clipboard_items` | `c.is_archived` | 实际是 `archived`（`db/migrate.js:206`） | `routes/aiTools.js:2117`、`:2253` | 同上（修完 3/4 后仍会报此列） | **S1-3** |
| 6 | `user_sessions` | `updated_at` | **该列不存在**（表从未被 ALTER） | `routes/sessions.js:79`、`:111`、`routes/aiTools.js:4459` | 撤销会话 / 强制下线 / 全端登出全部 500，被盗 token 无法吊销 | **S1-11** |

> 说明：#3/#4/#5 是同一处笔误的三个列，按「列」计数为 3 条、按「缺陷」计数为 1 条；表格共 6 行对应 4 个独立缺陷（S1-1、S1-2、S1-3、S1-11）。

### 已核对**一致**（历史上出过事故、本次确认已修复）

- `users.name` → 全仓 `grep -rn "u\.name\b"` **零命中**；管理台与退款列表统一用 `u.nickname AS user_name`（`routes/admin/users.js:53`、`services/refundRequest.js:319`）。历史事故「admin 退款列表 JOIN 用错列名 `u.name`」**已修复**。
- `sessions` 裸表名 → 全仓 `grep -rn "FROM sessions\|JOIN sessions\|INTO sessions\|UPDATE sessions"` **零命中**，一律使用 `user_sessions`（48 处引用）。历史事故「`sessions` 表 schema 不匹配」**已修复**。
- `routes/admin/*` 的 6 个列表接口（`users.js:48-78`、`audit.js:331`、`orders.js:209`、`devices.js:201`、`subscriptions.js:113`、`roles.js:118`）的 JOIN 与列引用逐条核对，**全部与 schema 一致**（`r.role_key`、`r.level`、`us.auto_renew`、`u.registration_status`、`sp.name`、`po.order_no` 等均存在）。
- `routes/aiTools.js:3177` 的 `r.name AS role_name` / `r.role_key`：SELECT 里做了别名，`:3201-3202` 的 `u.role_name` / `u.role_key` 读的是 JS 行对象而非 SQL 列，**不是 bug**。
- `user_subscriptions.status` 取值：`048_subscription_status_check.sql:18-21` 允许 `active/trial/canceled/cancelled/past_due/expired`；代码写入的值是 `'active'`（`services/orderFulfillment.js:63`、`routes/aiTools.js:3549`/`:3622`）、`'trial'`（`routes/subscriptions.js:331`）、`'canceled'`（`services/orderFulfillment.js:202`）。`'trialing'` **只被读、从不被写**（`routes/app.js:154`、`routes/admin/announcements.js:88`/`:101`、`routes/admin/overview.js:136`、`services/announcementDelivery.js:22`），因此不违反 CHECK。一致。
- `payment_orders.order_no` 有 UNIQUE（`004_subscription_tables.sql:94`），`services/orderFulfillment.js:97` 的 `WHERE order_no = $1 FOR UPDATE` 走索引，不是顺序扫。
- `invoices.invoice_no` 有 UNIQUE（`004:110`），`orderFulfillment.js:277` 的 `ON CONFLICT (invoice_no) DO NOTHING` 合法。
- `clipboard_templates` / `template_variables` / `surveys` / `shared_links` / `search_history` / `ai_*` / `workflow_rules` / `favorite_collections` / `favorite_collection_items` / `recovery_keys` / `system_configs` / `feature_flags` / `clipboard_deletions` / `admin_announcements` / `admin_announcement_reads` / `admin_announcement_deliveries` / `refund_requests` / `roles` / `permissions` / `role_permissions` / `audit_logs` / `notification_history`（当前形态）：列引用与 schema **一致**。

### Migration 可重入性 / 顺序依赖 核查

| 检查项 | 结论 |
|---|---|
| 是否幂等（`IF NOT EXISTS` / `ON CONFLICT DO NOTHING` / `DO $$ ... EXCEPTION`） | **绝大多数是**。70 个文件里非幂等语句只有：`011a_fix_subscription_schema.sql:33-38`（`DROP TABLE ... CASCADE` + `RENAME`，但有 `col_type` 前置判定保护）、`048_subscription_status_check.sql:18-19`（`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`，同名单实例可重入、**并发不可重入**）、`036_sync_scripts_migrations.sql:41-42`（`UPDATE ... WHERE path IS NULL` + `ALTER COLUMN path SET NOT NULL`，可重入） |
| 版本号唯一性 | **不唯一**：`031` 重复（S1-1）。另存在编号空洞 `001/002/003/061/064`（无害，但说明编号是手工分配的、没有校验） |
| 版本主键设计 | **有缺陷**：`migrate.js:245` 用 `file.split('_')[0]`，天然会撞车。应改用完整文件名 |
| 顺序依赖 | 有 3 处，目前都靠文件名排序侥幸成立：①`005` 必须先于 `015`（`notification_history` 两套不兼容定义，S3-7）；②`004`/`012` 必须先于 `047`/`048`（`user_subscriptions` 的 CHECK 约束）；③`011a` 必须先于 `047`/`048`（可能 DROP 重建 `user_subscriptions`）。**没有任何机制断言这些依赖** |
| 事务包裹 | **无**。`migrate.js:231-278` 每条语句单独 `client.query()`，中途失败会留下半初始化的 schema，且 `schema_migrations` 已记录的部分不会重跑 |
| 并发保护 | **无 advisory lock**（S1-7）。`docker-compose.multi.yml` 两个实例同时启动会竞态 |
| 迁移目录解析 | `path.resolve('./src/db/migrations')` 依赖 CWD，且目录缺失时**静默跳过全部迁移**（S2-16） |
| 每次启动都跑的重活 | `migrate.js:212-215` 的全表 `UPDATE clipboard_items SET metadata = jsonb_set(...)` 在 `postMigrations` 里、**无版本号跟踪**，每次启动 × 每实例 × 每 worker 都跑一遍 |
| 「代码依赖某列但 migration 没建」 | **有 2 处**：`content_diff`（S1-2）、`user_sessions.updated_at`（S1-11）；另有 1 处「migration 有但被跳过」：`image_hash`（S1-1） |
| 两套迁移系统并存 | **是**：`db/migrate.js`（生效）与 `db/migrate-manager.js`（死代码，但持有 `content_diff` 的唯一定义、并会创建冲突的 search_vector 触发器）。这是上述漂移的根因 |
| `scripts/migrations/` 与 `src/server/src/db/migrations/` 并存 | **是**：前者 5 个文件（`003/004/005/010/011`）无任何代码引用，内容靠 `036_sync_scripts_migrations.sql` 手工复制。其中 `004` 建的 `tags` 表代码零引用；`010` 含 Supabase 专有的 `auth.uid()` RLS 策略（原生 PG 执行会失败） |

---

## 无输入校验的写接口清单

全仓共 **161 个写路由**（`grep -rhcE "router\.(post|put|patch|delete)\(" src/server/src/routes/*.js src/server/src/routes/admin/*.js`）。`src/server/src/validation/` 只有一个文件 `validator.js`（478 行、纯手写、无 joi/zod/express-validator），被 **15 / 61** 个路由文件 import（`admin/configs.js`、`aiConversations.js`、`aiTools.js`、`auth-password.js`、`auth-profile.js`、`auth-verify.js`、`auth.js`、`clipboard.js`、`device.js`、`favorites.js`、`media.js`、`protection.js`、`searchHistory.js`、`sync.js`、`versions.js`）。其余 46 个路由文件各自手写 `typeof`/`if (!x)` 判断，风格与强度参差。

**先说结论：mass assignment 一条没有。** 全仓 `grep -rn "\.\.\.req\.body\|Object.keys(req.body)\|Object.entries(req.body)\|Object.assign(.*req.body"` → **零命中**。所有动态拼 `SET` 子句的地方（`routes/admin/plans.js:170-173`、`routes/admin/releases.js:263`、`routes/admin/aiProviders.js:146-150`、`routes/admin/emailChannels.js:277-281`、`routes/auth-profile.js:60-83`、`routes/auth.js:1725-1752`、`routes/aiMemories.js:64`、`routes/favorites.js:144-160`、`routes/aiTools.js:2739-2751`/`:3716-3723`/`:3932-3979`/`:4552-4559`、`routes/templates.js:52-68`）都是**硬编码列名 + 参数化值**，且 admin 侧走 `FIELD_VALIDATORS` / `normalizePayload` 白名单。不存在「`req.body` 整体展开进 INSERT/UPDATE 从而能改 `user_id`/`role_id`/`plan_id`」的路径。用户隔离也普遍做得对（`WHERE ... AND user_id = $n`）。

以下是**确实缺校验或校验不足**的写接口：

### A. 完全无入参校验（0 条 `typeof`/`isValid*`/长度/范围判断）

| 接口 | 文件:行 | 缺什么 | 后果 |
|---|---|---|---|
| `DELETE /api/sessions/:sessionId` | `routes/sessions.js:61` | `sessionId` 未校验（此处恰好无害，因为 `:67-70` 先按 `id = $1 AND user_id = $2` 查一次；UUID 列收到非 UUID 会 500 而非 404） | 500 而非 404/400 |
| `DELETE /api/sessions` | `routes/sessions.js:103` | 无 body 校验（也不需要） | — （真正的问题是 S1-11 的缺列） |
| `PUT /api/notifications/history/:id/read` | `routes/notifications.js:73` | `id` 未校验，而列是 `SERIAL`（integer） | `PUT .../abc/read` → 500（S2-21） |
| `POST /api/webhooks/alipay`、`/stripe` | `routes/paymentWebhooks.js:39`、`:104` | 无 schema 校验（依赖渠道验签，设计上是合理的）；但 `webhookIdempotencyMiddleware` 的 `req.body?.id` 兜底键无渠道前缀 | 跨渠道事件 ID 撞车（S2-9） |
| `POST /api/auth/logout` 等 | `routes/auth-session.js` | 无 body 校验 | 低风险 |

### B. 有校验但**不足**（类型/边界/枚举缺失）

| 接口 | 文件:行 | 缺什么 | 可复现的失败请求 |
|---|---|---|---|
| `PUT /api/templates/:id`、`DELETE /api/templates/:id` | `routes/templates.js:48`、`:88` | 无 `isValidUUID(id)` | `PUT /api/templates/not-a-uuid {"name":"x"}` → **500**（应 400） |
| `POST /api/templates`、`PUT /api/templates/:id` | `routes/templates.js:26`、`:48` | `content` 无长度上限；无每用户条数上限 | `{"name":"a","content":"<10MB>"}` → 落库；重复 2 万次 → 180GB（S2-19） |
| `POST /api/surveys` | `routes/surveys.js:16` | `type` 无白名单/长度校验（列 `VARCHAR(20)`）；`score` 未判 `Number.isInteger`/`NaN`；`feedback` 无长度上限 | `{"type":"<23字符>","score":5}` → **500**；`{"type":"nps","score":5.5}` → **500** |
| `PUT /api/notifications/preferences` | `routes/notifications.js:31` | `notificationType` 无白名单/长度（列 `VARCHAR(50)`）；`enabled` 未判 `typeof === 'boolean'` | `{"notificationType":"<51字符>","enabled":true}` → **500** |
| `POST /api/sync/push` | `routes/sync.js:22` | `changes[].action` 无枚举校验（非法值静默 no-op，不进 results）；`changes[].data.contentType` 无白名单；`data.contentPreview` 无长度截断；`data.contentSize` 未判非负整数；`data.expiresAt` 未判日期可解析 | 见 S2-15 的 payload，一条脏数据让整批 50 条回滚 |
| `POST /api/ai/conversations/:id/messages` | `routes/aiConversations.js:303` | `messages` 数组**无长度上限**；`m.role` 只判非空、无枚举校验；`m.content` 无长度校验；`m.createdAt` 未判日期可解析 | 见 S0-1 |
| `PUT /api/template-variables` | `routes/templateVariables.js:32` | `NAME_RE` 无长度约束，通过后才 `slice(0,60)` 截断 → 两个前 60 字符相同的名字互相覆盖；无每用户条数上限 | `{"name":"a×80","value":"1"}` 与 `{"name":"a×79+b","value":"2"}` → 后者静默覆盖前者 |
| `PUT /api/favorites/collections/reorder` | `routes/favorites.js:96` | `orders` 数组无长度上限（每条一次 UPDATE，在伪事务里） | `{"orders":[...10000项]}` → 1 万次串行 UPDATE（S0-1 同源） |
| `POST /api/media/file` | `routes/media.js:320` | 无请求级总字节上限；`fileFilter` 只按扩展名黑名单（`.bat/.ps1/.sh/.php/...`），`.exe`/`.apk`/`.dll` 不在名单，且 `originalname` 客户端可控 | 50 × 1GB 落盘（S1-9） |
| `GET /api/notifications/history` | `routes/notifications.js:54` | `limit`/`offset` 未钳制、未判 `NaN`/负数 | `?limit=abc` / `?offset=-1` → **500**；`?limit=1e9` → 无界查询（S2-21） |
| `GET /api/clipboard`（读接口，但同属校验缺口） | `routes/clipboard.js:53` | `all=true` 完全取消 LIMIT | `?all=true` → 全量拉取 → OOM（S1-6） |
| `GET /api/clipboard?search=` / `?tag=` | `routes/clipboard.js:93`、`:148` | `sanitizeString` 把 HTML 实体注入查询条件；tsquery 保留字符未处理 | `?search=a(b)` → **500**（S2-1）；`?search=https://x/y` → 空结果（S2-2） |

### C. 校验做得**好**的正面样板（可作为推广模板）

- `routes/clipboard.js:528-604`（`POST /api/clipboard`）：必填 → `isValidUUID` → 10MB 上限 → `isValidContentType` → preview 截断 5000 → E2E 信封逐字段结构校验（`v/alg/epk/iv/keys[].w/keys[].iv` 的 base64 长度上下界都判了）。这是全仓最完整的一处。
- `routes/admin/plans.js:155-200`：`FIELD_VALIDATORS` 白名单 + 逐字段 validator + 变更集审计。
- `routes/admin/aiProviders.js:110-150`：`pickText` + 逐项长度上限 + `new URL()` 协议白名单（只允许 http/https）。
- `routes/media.js:378-386`：`paths` 数组 ≤50 项、每项 ≤1024 字符、逐项 `typeof === 'string'`。
- `routes/app.js:237-239`：公告 id 用内联 UUID 正则校验后返回 400。
- `services/refundRequest.js:271-273`、`:296-298`：`limit`/`page`/`pageSize` 三层钳制（`Math.max(1, Math.min(...))`）+ 状态值白名单。

### D. 类型混淆与嵌套字段

- **字符串 vs 数字**：`validatePagination`（`validator.js:203-204`）用 `parseInt(page) || 1`，对 `"1"` 和 `1` 都能处理，这一处是对的。但 `routes/notifications.js:59` 的 `parseInt(limit)` 无 `|| 默认值` 兜底，`NaN` 会直穿到 SQL（S2-21）。`routes/surveys.js:23` 反向过严（拒绝 `"5"`，这本身合理，但没配套拒绝 `5.5`）。
- **数组/对象嵌套**：`POST /api/sync/push` 的 `changes[].data.metadata` 直接 `JSON.stringify` 落 JSONB，**无结构/深度/大小校验**（对比 `clipboard.js:576-604` 对 `metadata.e2e` 的严格校验）；`POST /api/ai/conversations/:id/messages` 的 `m.metadata` / `m.toolCalls` / `m.toolResults` 同样无校验直接 `JSON.stringify` 落库（`aiConversations.js:342-357`）。
- **日期格式**：`clipboard.js:128-145` 的 `dateFrom`/`dateTo` 是正确样板；`sync.js` 的 `data.expiresAt`、`aiConversations.js` 的 `m.createdAt`、`routes/subscriptions.js` 的 trial 日期都缺校验。

---

## 索引缺口清单（查询 → 需要的索引 → 现状）

| # | 热点查询（文件:行） | WHERE / ORDER BY | 需要的索引 | 现状 | 严重度 |
|---|---|---|---|---|---|
| 1 | `db/cleanup.js:27-31`（每小时，× 实例 × worker） | `DELETE ... WHERE expires_at IS NOT NULL AND expires_at < NOW()` | `idx_clipboard_items_expires_at ON clipboard_items(expires_at) WHERE expires_at IS NOT NULL` | **不存在**（`grep -rn expires_at db/migrations/*.sql db/migrate.js \| grep -i index` → 0） | **高**：全表扫 + 撞 30s `statement_timeout` → 过期数据永远删不掉（S2-14） |
| 2 | `routes/clipboard.js:164-176`（最热列表接口，每设备每次拉取） | `WHERE user_id=$1 AND archived=FALSE AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY ((metadata->>'pinned')::boolean) DESC, created_at DESC LIMIT n OFFSET m` | `ON clipboard_items(user_id, created_at DESC) WHERE archived = FALSE`；理想再加表达式索引 `ON clipboard_items(user_id, ((COALESCE(metadata->>'pinned','false'))::boolean) DESC, created_at DESC) WHERE archived = FALSE` | **都不存在**。只有 `idx_clipboard_items_user_id(user_id)`（无排序）与 `idx_clipboard_items_archived(archived, created_at DESC)`（无 user_id） | **高**：每页都取该用户全部行 + 显式排序（S2-14） |
| 3 | `routes/clipboard.js:158-161` | `SELECT COUNT(*) FROM clipboard_items ci <同上 where>` | 同 #2（覆盖索引可让 COUNT 走 index-only scan） | 无；每翻一页重算一次总数 | 中 |
| 4 | `routes/clipboard.js:243-256`（`/api/clipboard/search`） | `WHERE user_id=$1 AND archived=FALSE AND (search_vector @@ ... OR content_preview ILIKE ... OR ocr_text ILIKE ...) ORDER BY ts_rank(...) DESC, created_at DESC` | `idx_clipboard_search GIN(search_vector)` 存在，但**它是全局的、不含 user_id**，且 `OR ... ILIKE` 会让规划器放弃 GIN 直接全扫该用户的行 | GIN 索引存在但被 `OR ILIKE` 废掉；`ocr_text` 无 trigram 索引（`pg_trgm` 扩展在 `init-db.sql:7` 创建了，但**没有任何 GIN trgm 索引**） | 中：搜索走全用户行扫描 + 排序 |
| 5 | `db/cleanup.js:157-166`（审计归档） | `WHERE created_at < NOW() - interval ORDER BY created_at ASC` | `idx_audit_logs_created_at (created_at DESC)` **已存在**（`008_audit_logs.sql:22`） | 有索引，但查询**无 LIMIT**（S2-20） | 中 |
| 6 | `routes/admin/audit.js:331` | `WHERE <action/user_id/ip/date 组合> ORDER BY al.created_at DESC LIMIT/OFFSET` | 单列索引 `(user_id)`、`(action)`、`(created_at DESC)`、`(ip_address)` 都存在；缺 `(resource_type)`、`(status)`；组合筛选时无复合索引 | 部分存在 | 低-中 |
| 7 | `services/orderCloseSweep.js:25-32`（每小时，× 实例） | `UPDATE payment_orders ... WHERE status='pending' AND created_at < NOW()-interval RETURNING ...` | `ON payment_orders(status, created_at) WHERE status = 'pending'`（部分索引，行少） | **不存在**，只有 `idx_payment_orders_user_id`（`004:123`） | 中：`payment_orders` 增长后每小时全表扫 + 行锁 |
| 8 | `services/deviceOnlineSweep.js`（每 60s，× 实例） | `UPDATE devices ... WHERE is_online = TRUE AND last_seen_at < NOW() - interval` | `ON devices(last_seen_at) WHERE is_online = TRUE` | 只有 `idx_devices_online(is_online) WHERE is_online = TRUE`（`migrate.js:154`），无 `last_seen_at` | 低-中：`devices` 表小，但每 60s × 实例数 |
| 9 | `middleware/subscriptionCheck.js` + `middleware/auth.js:52-60`（**每个认证请求**） | `SELECT ... FROM users u LEFT JOIN roles r ON r.id=u.role_id LEFT JOIN user_sessions s ON s.id=$2 WHERE u.id=$1` | `users(id)` PK ✓、`roles(id)` PK ✓、`user_sessions(id)` PK ✓、`idx_users_role_id`（`028:35`）✓ | 索引齐全，但**无缓存**、每请求一次三表 JOIN（S2-17） | 中：不是索引问题，是缓存缺失 |
| 10 | `middleware/subscriptionCheck.js` / `routes/app.js:148-158` | `user_subscriptions WHERE user_id=$1 AND status IN (...)` | `ON user_subscriptions(user_id, status)` 复合 | 只有分开的 `idx_user_subscriptions_user_id` 与 `idx_user_subscriptions_status`（`004`）；`status` 只有 6 个取值、选择性极低，单列索引基本无用 | 低-中 |
| 11 | `routes/admin/users.js:48-78`（`USER_SELECT`，每行 5 个相关子查询） | `devices(user_id)`、`devices(user_id, last_seen_at DESC)`、`payment_orders(user_id, status)` | `idx_devices_user_id` ✓；缺 `devices(user_id, last_seen_at DESC)`；缺 `payment_orders(user_id, status)` | 部分存在 | 中：50 行/页 × 5 子查询 = 250 次索引扫（S2-20） |
| 12 | `routes/favorites.js` / `routes/clipboard.js:811` | `favorite_collection_items WHERE item_id = $1` | `idx_fci_unique_item UNIQUE(item_id)` **存在**（`036:40`） | 有（但语义上是 S3-8 的问题） | — |
| 13 | `routes/clipboard.js` 图片去重（`:663-670`） | `WHERE user_id=$1 AND content_type='image' AND image_hash=$2 AND created_at > NOW()-interval` | `idx_clipboard_user_image_hash(user_id, image_hash) WHERE image_hash IS NOT NULL` | **迁移被跳过 → 索引不存在，列也不存在**（S1-1） | 高（随 S1-1 一起修） |
| 14 | `routes/clipboard.js:653-660` 内容去重 | `WHERE user_id=$1 AND content_type<>'file' AND content_hash=$2 AND created_at > NOW()-interval` | `idx_clipboard_user_content_hash(user_id, content_hash) WHERE content_type <> 'file'` | **存在**（`014_clipboard_dedup.sql:6-8`）✓ | — |
| 15 | `routes/clipboard.js`（`sync-deletions`） | `clipboard_deletions WHERE user_id=$1 AND deleted_at > $2` | `idx_clipboard_deletions_user_time(user_id, deleted_at)` | **存在**（`041:19-20`）✓ | — |
| 16 | `db/cleanup.js:50-56` | `DELETE FROM notification_history WHERE created_at < NOW() - interval` | `idx_notification_history_created_at` | **存在**（`015:14`）✓ | — |
| 17 | `db/cleanup.js:64-69` | `DELETE FROM clipboard_deletions WHERE deleted_at < NOW() - interval`（无 user_id） | `ON clipboard_deletions(deleted_at)` | **不存在**（只有 `(user_id, deleted_at)`，前导列不匹配 → 用不上） | 低-中：表小、每小时一次 |
| 18 | 反向：**多余索引**（纯写放大） | — | — | `idx_clipboard_items_content_type`（5 个枚举值）、`idx_clipboard_items_protection`（3 个枚举值）、`idx_clipboard_items_migration_status`（迁移完成后全表同一个值）、`idx_user_subscriptions_status`（6 个枚举值） | 低：建议删除，`clipboard_items` 是写入最频繁的表，每个多余索引都直接拖慢核心写入 |

**分页方式核查**：全仓一律 `LIMIT/OFFSET`（`routes/clipboard.js:164`、`routes/admin/*.js`、`utils/audit.js:209`、`services/notificationService.js:70`、`services/refundRequest.js:321`），**没有一处 keyset 分页**。`validatePagination` 把 `page` 钳到 ≤1000、`limit` 钳到 ≤100，所以常规路径最大 OFFSET = 100,000（可接受但不理想）；**唯一的例外是 `all=true` 直接取消 LIMIT**（S1-6）。

**`SELECT *` 核查**：全仓 `SELECT *` 共 37 处（`routes/subscriptions.js` 6、`routes/auth-verify.js` 5、`routes/aiProviders.js` 4、`utils/aiRuntimeConfig.js` 3、`services/notificationService.js` 3、`routes/auth-password.js` 3、`routes/aiConversations.js` 3、其余各 1-2）。**唯一落在含大字段/密钥列表上的是 `routes/sync.js:98`**（`SELECT * FROM clipboard_items`，S2-11）。`routes/app.js:84` 的 `SELECT * FROM app_releases` 与 `routes/admin/plans.js:140` 的 `SELECT * FROM subscription_plans` 表都很小且有 60s 进程内缓存，可接受。`utils/audit.js:169` 的 `SELECT * FROM audit_logs` 含 JSONB `details` 且 `limit` 无上限（S2-20）。

**N+1 核查**：真正的循环内查库共 6 处——
- `routes/sync.js:53-160`：单事务内每 change 1-3 次查询，最多 50 changes → **最多 150 次往返在一个事务里**（长事务持锁，且因 S1-2 必然失败）
- `routes/aiConversations.js:333-364`：每 message 一次 INSERT，**无条数上限**（S0-1）
- `routes/favorites.js:118-123` 与 `routes/aiTools.js:3797-3801`：每 order 一次 UPDATE，**无条数上限**（S0-1 同源）
- `routes/auth.js:114-152`（身份合并）：每重复用户 3-4 次查询，**不在事务里**（`grep` 确认该函数内无 `BEGIN`）→ 合并中途失败会留下「剪贴板已搬走、旧账号未标记 merged」的半合并状态
- `routes/admin/refundSettings.js:91`：每配置键一次查询（键数很少，可接受）
- `services/fileRetentionCleanup.js`：每过期文件一次 DB 查询 + 一次 unlink（后台任务，可接受但未批量化）

---

## 测试有效性评估

测试总量：`src/server/tests/` 下 38 个文件 + `tests/admin/` 10 个文件，约 **8935 行**（不含 admin 目录）。`vitest.config.js` 强制串行（`fileParallelism: false`、`minThreads/maxThreads: 1`）、`setupFiles: ['tests/setup.js']`、`env: { NODE_ENV: 'test', LOG_LEVEL: 'error' }`。

### 1. `tests/validator.test.js`（218 行）——**不覆盖任何路由的校验**

- 它是 `validation/validator.js` 的**纯单元测试**：只 import 14 个 helper 函数，逐个断言返回值。**零 HTTP 请求、零路由挂载**。
- 对任务问的「是否真覆盖了各路由的校验」：**答案是否定的，覆盖率 0%**。161 个写路由的入参校验没有任何一条被这个文件触及。
- `validator.js` 导出的 20 个函数里，**未测试的有 11 个**：`isValidEmail`、`isValidUrl`、`isValidJson`、`sanitizeHtml`、`escapeSql`、`validateNickname`、`validateDeviceName`、`validateClipboardData`、`validateDeviceData`、`validationMiddleware`、`validators.*`（4 个预置中间件）。
- 已测的 9 个里，**关键分支被跳过**：
  - `validatePagination`（`:111-128`）只测了 `(1,50)`、`(-1,0)`、`(1,200)`，**没测 `{all:true}` 分支** —— 而那条分支正是 S1-6 的 `limit: Infinity`。
  - `validateSearch`（`:130-143`）只用纯 ASCII `'hello'` 测，**没测含 `/`、`&`、`(` 的输入** —— 而那正是 S2-1（500）与 S2-2（结果错误）。
  - `sanitizeString`（`:145-165`）测的是「转义生效」，**没有任何测试断言它不该被用在查询条件上**。
- 断言质量：`expect(sanitizeString('<script>alert(1)</script>')).not.toContain('<script>')` 这类是有效的；但 `escapeJsContext` 的 `:198` `expect(result.startsWith('"')).toBe(false)` 是一个恒真的弱断言（输入 `"; alert(1); //` 转义后必然不以裸 `"` 开头，即使函数是空实现也……不，空实现会失败，所以这条还行）。整体属「能过但不锐利」。

### 2. `tests/api.test.js`（173 行）——**名不副实，不是 API 测试**

- **零 HTTP 请求**：没有 import `supertest`，没有 import `app`/`server`。7 个 `describe` 里 5 个只是 `expect(typeof X).toBe('function')` 的模块导出冒烟测试（`:132-163`：Rate Limiter / Logger / WebSocket / Cleanup Scheduler / Config Module）——**即使这些函数内部完全损坏，测试照样全绿**。
- `describe('Database Schema')`（`:27-95`）确实查了 `information_schema`，但只断言**列存在**，且只查了 4 张表的最基础列：
  ```js
  expect(colNames).toContain('content_type');
  expect(colNames).toContain('content_encrypted');
  ```
  **它没有断言 `image_hash`、`content_diff`、`archived`、`protection_level`、`favorited_at`、`ocr_text`、`content_hash`、`user_sessions.updated_at`** —— 也就是说，本次审计发现的 S1-1 / S1-2 / S1-11 三条 schema 缺陷，**这个"schema 测试"结构上不可能发现**。它测的是「migrate.js baseline 建了哪些列」，而不是「代码需要哪些列」。
- `beforeAll`（`:9-16`）在 DB 不可达时 `console.warn('Database not available, skipping API tests'); return;` —— 但**没有任何 skip 机制**，`describe('Database Schema')` 的用例照样执行并**失败**（不是跳过）。这句日志是假的。
- `afterAll`（`:18-25`）调 `await pool.end()`；`tests/setup.js:53` 的注释明确写「数据库连接池不在此关闭（由 index.js 的 gracefulShutdown 处理）」。全仓有 **10+ 个测试文件**各自调 `pool.end()`（`api.test.js:24`、`archive.test.js:45`、`expiry.test.js:42`、`subscription-api.test.js:45`、`admin-payment-surfaces.test.js:163`、`invoice-download.test.js:143`、`invoices-read.test.js:91`、`payment-refund.test.js:200`、`refund-request.test.js:192`、`refund-service.test.js:248`）。因为 vitest 默认对每个测试文件隔离模块注册表，实际不会互相污染，但这与 `setup.js` 声明的契约直接矛盾，一旦有人把 `isolate` 关掉就会全线崩。
- `setup.js:34` 的 `DELETE FROM users WHERE phone LIKE '13800%' OR phone LIKE '13900%'` 是一条**破坏性全局清理**。它靠 `config.js:41-51`（测试环境强制忽略 `DB_*` env 覆盖、锁定 `clipsync_test` 库）来保护，那个保护是**真实存在且注释详尽的**，所以当前安全；但这是一条「一旦有人改 config.js 就会删掉 dev 库真实用户」的高危语句，值得加一道显式断言（`if (config.db.name !== 'clipsync_test') throw`）。

### 3. `tests/middleware/`——**只有 1 个文件，覆盖 1 / 12 个中间件**

- 目录里只有 `runtime-limits.test.js`（211 行）。**这个文件质量很高**：用 `vi.hoisted` + `vi.mock` 干净地替换 `db/pool.js` 与 `logger`，覆盖了「键缺失回退默认 / 读库失败 fail-closed / 非法配置值回退 / 库值生效 / `disabled=true` 全放行 / 动态阈值内存路径 429 / TTL 缓存与失效 / `checkWsConnectionLimit` 总开关接入」8 个场景，还自己实现了最小 express `res` 桩。是全仓测试的正面样板。
- 但它测的是 `utils/runtimeLimits.js` + `sendCodeLimiter`。**`checkRateLimitRedis` 完全没测** —— 而那正是 `rateLimiter.js:94-101` 注释里记载的 2026-09-15 生产事故（node-redis `multi().exec()` 返回扁平数组，旧代码按 `results[2][1]` 取值导致全站恒 429）的发生地。修好了，但**没有回归测试**，同一个坑可以再踩一次。
- **12 个中间件里 11 个无专属测试**：`auth.js`、`adminAuth.js`、`idempotency.js`、`maintenance.js`、`metrics.js`、`planFeature.js`、`rateLimiter.js`（除 sendCode 外）、`request-id.js`、`subscriptionCheck.js`、`superAdminAudit.js`、`webhook-signature.js`。（`csrf.js` 有 `tests/csrf.test.js`，但它在 `tests/` 而不是 `tests/middleware/`。）

### 4. 结构性问题：**4 个安全中间件在 `NODE_ENV=test` 下被替换成直通桩**

`grep -rn "NODE_ENV === 'test'" src/` → 11 处，其中这些让测试失去意义：

| 位置 | 测试环境行为 | 后果 |
|---|---|---|
| `middleware/auth.js:8-20` | 直接注入固定用户 `{userId:'0000...0001', roleKey:'user', roleLevel:10, isAdmin:false}` 并 `return next()` | **真实 JWT 验签、jti 黑名单、`is_active`/`session_active` 校验全部不被执行**。S1-11（会话撤销失效）与 S2-17（fail-open）在测试里**不可能被发现** |
| `middleware/csrf.js:144-146` | `return next()` | CSRF 逻辑零覆盖（`tests/csrf.test.js` 只能测 `generateCsrfToken`/`validateCsrfToken` 这两个纯函数，测不到中间件） |
| `middleware/rateLimiter.js:238`、`:369`、`:387` | `apiLimiter`/`adminLimiter`/`adminStrictLimiter` 直接变成 `(req,res,next)=>next()` | S1-5（XFF 伪造绕过限流）在测试里**不可能被发现**——限流器根本不运行 |
| `middleware/rateLimiter.js:193-195` | `storeName === 'api'` 时在中间件内部再跳过一次 | 双重跳过 |
| `middleware/subscriptionCheck.js:10-12` | `return next()` | **套餐配额/设备数/剪贴板数上限全部不被执行**。S1-9（1GB×50 上传）与 S2-19（模板无配额）在测试里不可见 |
| `middleware/planFeature.js:116` | 测试旁路 | 功能门控零覆盖 |
| `index.js:363-365` | `metricsAuth` 直接 `next()` | metrics 鉴权零覆盖（`index.js:350-375` 那段 fail-closed 逻辑，即 CO-03 修复，没有测试保护） |
| `db/pool.js:32-34` | 不设 `statement_timeout` | 所有依赖 30s 超时行为的缺陷（S2-14 的清理 DELETE 被掐死）在测试里表现不同 |

**净结论**：现有测试对**业务逻辑**（退款、订阅升级、按比例折抵、发票、支付宝验签、AI RBAC）的覆盖是相当扎实的——`tests/refund-service.test.js`（580 行）、`tests/payment-refund.test.js`（527 行）、`tests/refund-request.test.js`（497 行）、`tests/subscription-upgrade.test.js`（469 行）、`tests/alipay.test.js`（471 行）、`tests/admin/*.test.js`（10 个文件，用 `vi.mock` 掉 pool 后挂载真实 router + supertest 打真实 HTTP，断言 SQL 参数位置与响应映射）都是高质量测试。
但它们对**「代码与真实数据库/真实中间件链的契合度」覆盖为零**：pool 被 mock（schema 缺陷不可见）、auth 被桩掉（越权与吊销不可见）、限流被桩掉（绕过不可见）、subscriptionCheck 被桩掉（配额不可见）。**本次审计发现的 2 个 S0 与 11 个 S1 里，有 6 条（S1-1、S1-2、S1-3、S1-11、S2-1、S2-3）属于「一条真库冒烟测试就能抓到」的类别，而这样的测试一条都没有。**

### 5. 建议补的最小测试集（按抓虫性价比排序）

1. **真库 schema 契约测试**（不 mock pool，对 `clipsync_test` 跑）：静态提取 `src/**` 里所有 SQL 字符串的表名+列名，与 `information_schema.columns` 做交叉断言。一条测试即可永久封杀 S1-1 / S1-2 / S1-3 / S1-11 这一整类缺陷。
2. **真库冒烟测试**：对 12 个核心端点各打一次「正常 payload」+ 一次「恶意 payload」，断言状态码 ∈ {200,201,400,404} 且**永远不是 500**。可抓 S2-1 / S2-3 / S2-15 / S2-21。
3. **迁移幂等/并发测试**：对空库跑两遍 `migrate()`、并用两个并发 `migrate()` 跑一遍，断言无异常。可抓 S1-1 / S1-7。
4. **限流集成测试**：设 `trust proxy` 后，同一 IP 打 N+1 次断言 429；换 `X-Forwarded-For` 再打 N+1 次**仍断言 429**。可抓 S1-5，并防 `checkRateLimitRedis` 回归。
5. **会话吊销端到端测试**：登录 → `DELETE /api/sessions/:id` → 断言 200 → 用旧 token 请求 → 断言 401。可抓 S1-11。
6. **事务原子性测试**：给 `POST /api/ai/conversations/:id/messages` 注入一个中途失败的第 N 条消息，断言原有消息**一条不少**。可抓 S0-1。

---

## 设计层面的观察

1. **两套迁移系统并存是所有 schema 漂移的根因。** `db/migrate.js`（生效）与 `db/migrate-manager.js`（死代码）各自维护一份「初始 schema」和「后续变更」，加上 `scripts/init-db.sql`（仅 dev）与 `scripts/migrations/`（孤儿，靠 `036` 手工同步），一共**四个 schema 事实来源**。`content_diff` 只存在于第 2 个、`image_hash` 因第 1 个的版本号 bug 被跳过、`tags` 表只存在于第 4 个且无人使用。这不是「几个笔误」，而是缺少单一事实来源的必然结果。建议：删掉 2 和 4，把 3 降级为「migrate.js 的可读快照，由 CI 校验二者一致」。
2. **迁移工具是自研的、且缺 3 个基本能力**：无 advisory lock（多实例竞态）、无事务包裹（半初始化）、版本号用文件名前缀（会撞车）。业界成熟方案（node-pg-migrate / dbmate / goose / Atlas）都自带这三条。考虑到已有 70 个迁移文件，切换到工具的成本可控（它们大多也是「目录 + 版本表」模型）。
3. **Express 5 已经能自动捕获 async reject**（`package.json:33` `"express": "^5.2.1"`，实装 5.2.1），所以任务清单里担心的「漏包 `asyncHandler` 导致请求永久挂起」这一类问题**在本项目不存在**——全仓没有 `asyncHandler` 包装器，也不需要。实测确认：所有 async 路由处理器都自带 `try/catch`，且即使漏了，Express 5 也会把 rejection 转给 `index.js:568-589` 的错误处理器。这是骨架里少有的、干净利落的一处。
4. **健康检查/可观测性的设计是对的，实现被死代码掩盖了。** `index.js:272-340` 正确区分了 liveness（`/api/health` 恒 200）与 readiness（`/api/ready` 真查 DB + Redis + 文件系统可写性，不 ready 返 503），`index.js:350-375` 的 `METRICS_TOKEN` 是**正确的 fail-closed 设计**（生产缺失即禁用端点，绝不回退到硬编码默认口令，注释里还记录了此前的脏状态）。问题只是：①`routes/health.js` 与 `routes/metrics.js` 两份死实现会让人改错文件（S3-2）；②`/api/ready` 的 `config.upload.dir` 恒 `undefined`，靠 `:323` 的 `|| './uploads'` 兜底（注释 CO-01 已记录）——配置项缺失而不是修配置，是本次反复出现的模式；③没有 DB 连接池饱和度、慢查询数、事务中连接数这些真正能预警 S0-1/S1-8 的指标（`utils/query-monitor.js` 有 `getPoolStatus`，但只暴露在管理台，没进 Prometheus）。
5. **`services/` 层的抽象质量明显高于 `routes/` 层。** `services/orderFulfillment.js`（事务 + `FOR UPDATE` 行锁 + 金额比对 + 幂等 + 审计在事务外 + `finally` 释放）、`services/refundRequest.js`（两段式退款 + `processing` 中间态避免跨网络持锁 + 部分唯一索引做幂等闸 + 权益快照支持驳回回滚）是**教科书级的支付代码**，注释还解释了每个设计取舍的原因。而 `routes/sync.js`、`routes/aiConversations.js`、`routes/favorites.js` 里的事务是错的（S0-1、S1-2）。同一个仓库里的水位差这么大，说明缺的不是能力而是**强制复用的机制**——建议把 `orderFulfillment.js` 的事务范式抽成 `utils/withTransaction(fn)` helper，并禁止路由层直接写 `BEGIN`。
6. **`utils/` 目录混装了两类东西**：真基础设施（`logger`、`encryption`、`audit`、`redis-client`、`cache`、`db-retry`、`query-monitor`、`circuit-breaker`、`runtimeLimits`）与**领域服务**（`alipay`、`sms`、`email`、`pdf-invoice`、`storage`、`totp`、`imageHash`、`aiOcr`、`aiProviders`、`aiContext`、`aiKnowledge`、`aiSystemPrompt`、`searchProviders`、`versionManager`、`workflowEngine` 的支撑件、`planLimits`、`featureFlags`、`clientPolicies`、`releaseArtifacts`、`refreshToken`、`protectionCrypto`、`messageConverter`、`ws-redis-pubsub`、`adminSecurity`、`aiRuntimeConfig`）。41 个文件里超过一半是领域服务。这让「哪些是横切关注点」变得不可见，也是死代码（`db-retry` 的 `executeWithRetry`、`cache` 的 `getCacheWithLock`）能长期潜伏的原因——没人能一眼看出它们本该被谁用。
7. **外部依赖类缺口按排除项处理，此处一句带过**：无 Sentry/APM（`SENTRY_DSN` 在 `.env.example` 里但代码零读取）、无 Vault（密钥全走 env + 一个已提交进 git 的 `.env.test`）、PG/Redis 单实例 SPOF（`docker-compose.prod.yml` 各一个容器）、对象存储可选（`STORAGE_TYPE=local|s3`，多实例部署必须切 s3，`.env.example` 里已正确警示）、SMS/SMTP/CAPTCHA/OAuth 缺失或纯 mock。这些需要云资源，不列入问题项。**但有一条例外必须列**：`docs/production-roadmap/external-dependencies.md:47` 记载「短信服务：已 mock，验证码固定为 888888（仅开发环境）」，而 `routes/auth.js:172-176` 与 `routes/auth-verify.js` 的实现已经改成「生产强制随机码 + 未配置短信返 503、绝不静默降级为固定码」，并有注释明确记录这是 A4 修复——**代码已经修好了，文档还在说旧行为**。这是文档漂移，会在上线评审时造成误判。

---

## 建议补充的功能（按性价比排序）

| # | 建议 | 能防住的问题 | 成本 | 性价比 |
|---|---|---|---|---|
| 1 | **Schema 契约自检**：启动时（或 CI 里）静态扫描 `src/**` 的所有 SQL 字符串，提取 `表名 → 列名` 集合，与 `information_schema.columns` 交叉断言，缺列即 fail-fast；同时校验 `schema_migrations` 的版本集合与 `db/migrations/*.sql` 的文件名集合**完全相等**（能立刻抓到 `031` 撞车与 `content_diff` 缺失） | S1-1、S1-2、S1-3、S1-11、S3-7，以及未来所有同类缺陷 | 1-2 天（写一个 AST/正则扫描器 + 一条 vitest） | ★★★★★ 本次审计 4 条 S1 都属于这一类，且**现有测试结构上不可能发现** |
| 2 | **`utils/withTransaction(fn)` helper**：内部做 `pool.connect()` / `BEGIN` / `COMMIT` / `ROLLBACK` / `finally release`，并支持 `SAVEPOINT`；配一条静态检查禁止路由层出现 `pool.query('BEGIN')` 与裸 `client.query('BEGIN')` | S0-1（3 处伪事务）、S1-2 的整批回滚、S2-15 的部分失败、`routes/auth.js:114-152` 的身份合并半提交 | 半天（范式已在 `services/orderFulfillment.js` 里写好，抽出来即可） | ★★★★★ 唯一能防住 S0 级数据销毁的手段 |
| 3 | **配置 fail-fast + 单一事实来源**：`config.js` 生产分支改为 `process.exit(1)`；把「代码读取的所有 env 键」抽成一份声明式清单（含类型、默认值、是否生产必填、是否敏感），启动时校验并打印一份**已生效配置摘要**（敏感值打码），同时报出「已设置但代码不读的键」 | S0-2、S1-10、S2-18，以及「配了但没生效」这一整类静默故障 | 1 天 | ★★★★★ 上线前必做，成本低、防的事故都是全量级的 |
| 4 | **把 `utils/cache.js` 的 `getCacheWithLock` 接到 `authenticateToken` 与 `subscriptionCheck`**：活性/角色/套餐查询走 30-60s Redis 缓存（管理台改权限/停用时主动失效），并保留已有的击穿锁与空结果缓存 | S2-17 的每请求三表 JOIN、`subscriptionCheck` 的每请求 2-3 次查询；同时把已写好但从未接线的 200 行缓存基础设施变成有效代码 | 1 天（代码已存在，只需接线 + 失效点） | ★★★★☆ 直接降低核心路径 DB 负载 50%+ |
| 5 | **统一响应/错误契约**：`utils/http.js` 提供 `ok(res, data)` / `fail(res, http, code, msg)`，业务码集中枚举；全局错误处理器按 PG 错误码（`22P02`/`22001`/`23514`/`23505`/`23503`）映射 4xx，其余生产环境一律 500 + `requestId`，不回 `err.message` | S2-3、S2-8，以及「错误信息泄漏内部细节」（`routes/sync.js:155` 直接把 `err.message` 返给客户端） | 2-3 天（分批迁移，先冻结新代码） | ★★★★☆ |
| 6 | **`AsyncLocalStorage` 请求上下文 + 结构化访问日志**：`requestId`/`userId`/`route` 自动进每一条日志；恢复 `requestLogger`；`sanitizeLog` 改递归 + 复用 `utils/audit.js:95` 的 `SENSITIVE_KEY_RE`；两路输出（控制台/文件）同源脱敏 | S2-5（92 处丢错误详情）、S2-6（PII 进日志、无访问日志）、S2-7（requestId 不贯穿） | 1-2 天 | ★★★★☆ 直接决定生产 MTTR |
| 7 | **补齐关键索引 + 清理改分批**：新增 `clipboard_items(expires_at) WHERE expires_at IS NOT NULL`、`clipboard_items(user_id, created_at DESC) WHERE archived=FALSE`、`payment_orders(status, created_at) WHERE status='pending'`、`devices(last_seen_at) WHERE is_online`、`clipboard_deletions(deleted_at)`；删除 4 个低选择性索引；清理 DELETE 改 `FOR UPDATE SKIP LOCKED` + `LIMIT` 循环；审计归档改流式分批 | S2-14、S2-20，以及 S1-7 的归档损坏（分批 + 实例标识文件名） | 1 天（`CREATE INDEX CONCURRENTLY` 不锁表） | ★★★★☆ |
| 8 | **调度器 leader 选举**：所有 `start*Scheduler`/`start*Sweep` 在 tick 内先 `SELECT pg_try_advisory_lock(<job_id>)`，抢不到即跳过；`migrate()` 整体包 advisory lock | S1-7（迁移竞态 crash loop、审计归档重复/交错、5 个定时任务 ×N 实例重复执行） | 半天 | ★★★★☆ `docker-compose.multi.yml` 已经跑两个实例，这是**当前就会发生**的问题 |
| 9 | **限流前置 + keyGenerator 收口**：body parser 之前挂一个只看 `req.ip`+`Content-Length` 的廉价闸；`app.set('trust proxy', 1)`；三个 keyGenerator 统一用 `req.ip`；nginx 改 `X-Forwarded-For $remote_addr`（覆盖）；`buildRedisKey(storeName,key)` 单一实现 | S1-5、S2-10、S2-12 | 半天 | ★★★★☆ |
| 10 | **写接口的 schema 校验层**：引入 `zod`（或 `ajv`）为 161 个写路由声明入参 schema，用一个 `validate(schema)` 中间件统一执行，替换掉现在散落各处的手写 `typeof` 判断；`validator.js` 里从未被使用的 `validationMiddleware`/`validators.*` 一并删除 | S2-3、S2-15、S2-19、S2-21，以及「无校验写接口清单」B 组的全部条目 | 3-5 天（可分批，先覆盖 12 个核心端点） | ★★★☆☆ 收益大但工作量也大，建议 v1 后立刻做、v1 前先手工补齐 B 组里标红的 6 个 |
| 11 | **`clipboard_items` 写入口收敛**：把 `POST /api/clipboard` 与 `POST /api/sync/push` 的 create/update 逻辑合并进 `services/clipboardWrite.js`（校验 + 去重 + advisory lock + image_hash + 审计 + 副作用触发一处实现） | S2-15、S1-4、S1-8，以及两条写入路径行为不一致带来的长期漂移 | 2 天 | ★★★☆☆ |
| 12 | **keyset 分页 + 去掉 `?all=true`**：列表接口改游标分页（`(pinned, created_at, id)`），`total` 改为首屏缓存或 `hasMore`；导出走异步任务 | S1-6、S2-20 的深分页 | 2-3 天（需三端客户端配合） | ★★★☆☆ v1 可先只做「删掉 `all` 分支 + limit 硬上限」，1 小时工作量即可消除 OOM 风险 |
| 13 | **审计动作常量收敛**：`AUDIT_ACTIONS` 改为 `Object.freeze` 的常量对象 + 一条单测断言「代码里引用的每个键都在对象里」（用正则扫 `AUDIT_ACTIONS\.[A-Z_]+` 对比 `Object.keys`）；`logAuditEvent` 入口对 `!action` 早退并 error | S1-4、S3-6 | 2 小时 | ★★★☆☆ 极低成本、防的是合规级缺陷 |
| 14 | **删除死代码与一次性脚本**：`routes/health.js`、`routes/metrics.js`、`utils/route-loader.js`、`db/migrate-manager.js`、`utils/db-retry.js` 的 `executeWithRetry`、`scripts/migrations/`、`src/server/{check-syntax,fix-merged-lines,fix-subscriptions}.js`+`.mjs`；`package.json` 的 `db:seed` | S3-1、S3-2，并**根除 S1-2 的成因**（`migrate-manager.js` 一删，就不会再有人以为 `content_diff` 有人建） | 半天 | ★★★☆☆ |
| 15 | **密钥治理**：`git rm --cached src/server/.env.test` + 轮换其中全部密钥 + 删 `.gitignore:15` 的 `!.env.test`；`docker-compose.dev.yml` 去掉全部 `:-默认值`；`HASH_SALT` 独立成 `FIELD_HASH_KEY` 并抽单一实现、改 HMAC；`028_roles.sql` 的硬编码超管手机号改环境变量 bootstrap | S0-2、S2-13、S3-5 | 1 天（含轮换与验证） | ★★★☆☆ 上线前必做，但属于「一次性清账」 |

---

## 附：本次审计确认为**干净**的项（避免重复排查）

- **SQL 注入**：全仓 `grep` 字符串拼接 SQL（`` `SELECT ... ${ ``、`' + `、`"WHERE " +`）共命中 18 处动态 SQL 构造，**逐处确认全部安全**——`${}` 只用于拼接 `$n` 占位符序号（`params.length + 1`）或来自固定白名单的列名（`routes/admin/plans.js:190-192`、`routes/admin/aiProviders.js:146-148`、`routes/admin/emailChannels.js:277-279`、`routes/templates.js:57-72`、`routes/aiTools.js:2739-2751`/`:3716-3723`/`:3932-3979`/`:4552-4559`、`routes/auth-profile.js:65-83`、`routes/auth.js:1728-1752`、`routes/aiMemories.js:64`、`utils/audit.js:175-209`、`services/notificationService.js:70`）。**没有任何一处把用户输入拼进 SQL 文本。**
- **`ORDER BY` / 表名 / 列名位置的用户输入**：`grep -rn "ORDER BY" | grep '\${'` → 18 处，**全部是硬编码的排序列**（`al.created_at DESC`、`po.created_at DESC`、`u.created_at DESC`、`d.last_seen_at DESC NULLS LAST`、`r.level DESC, r.role_key`、`us.created_at DESC`、`c.created_at DESC`）。`grep -rn "sortBy|sort_by|orderBy|order_by|sortOrder"` → 只有 `sortOrder` 作为**数值参数**出现（`routes/favorites.js:144-160`、`routes/aiTools.js:3716-3723`/`:3785-3801`），走 `$n` 参数化，**不进 SQL 文本**。这是参数化防不住的高发点，本项目**没有踩**。
- **`INTERVAL '1 ${cycle}'`**（`services/orderFulfillment.js:49`/`:50`/`:63`/`:64`）：`cycle` 来自 `billingCycle === 'yearly' ? 'year' : 'month'`（`:35-36`），是**二元硬编码白名单**，不可注入。`routes/subscriptions.js:331-333` 的 `INTERVAL '${TRIAL_DAYS} days'` 中 `TRIAL_DAYS` 是模块常量，同样安全。
- **连接泄漏**：11 个文件用 `pool.connect()`，逐文件核对 `connect` 与 `.release()` 计数全部 1:1，且每处 `release()` 都在 `finally` 块内（含抛异常路径）。**没有连接泄漏。**
- **mass assignment**：`grep -rn "\.\.\.req\.body|Object.keys(req.body)|Object.entries(req.body)|Object.assign(.*req.body"` → **零命中**。不存在把 `req.body` 整体展开进 INSERT/UPDATE 的路径；不存在改 `user_id`/`role_id`/`plan_id`/`is_admin` 的可能。
- **async 异常导致请求挂死**：Express 5.2.1 原生转发 rejected promise 到错误处理器；且所有 async 路由处理器自带 `try/catch`。全局错误处理器（`index.js:568-589`）与 404 处理器（`:559-562`）位置正确、顺序正确。`uncaughtException`（`:784-790`）与 `unhandledRejection`（`:792-796`）都有 handler。**这一类问题不存在。**
- **CORS `*` + `credentials:true`**：生产分支（`index.js:115-126`）用白名单，`allowedOrigins` 为空时只放行无 `Origin` 的请求（非浏览器/同源），**不是 `*`**。`credentials:true` 只在 development 分支与「反射任意 Origin」组合（`:111-113`），那是 S0-2 的 `NODE_ENV` 未设置场景，不是独立缺陷。
- **`node_modules` 误提交**：`git ls-files src/server/node_modules | wc -l` → 0，`git ls-files node_modules | wc -l` → 0，`.gitignore:2` 有 `node_modules/`。**干净。**
- **webhook 原始报文处理**：`index.js:150-175` 用 body parser 自带的 `verify` 钩子留存 `req.rawBody`，而不是自建中间件读流（`:154-167` 的注释详细记录了此前那个「流被读走导致 `req.body` 恒为空、支付宝回调永远不开通订阅」的真实事故）。**这个修法是正确的。**
- **`/api/webhooks` 不挂鉴权/CSRF**：`index.js:452-465` 的注释明确解释了原因（渠道服务器没有本站 JWT，挂了必然 401），并保留了 `apiLimiter`。设计正确。
- **`/api/metrics` 鉴权**：`index.js:350-375` 是正确的 fail-closed（生产缺 `METRICS_TOKEN` 即 503 禁用，不回退硬编码默认口令），且支持 Prometheus Bearer 直通 + 管理台 `requireRole(50)` 双路径。设计正确（只是 `METRICS_TOKEN` 没写进 `.env.production.example`，见 S2-18）。
- **`services/orderFulfillment.js` 的支付履约**：事务 + `SELECT ... FOR UPDATE` 行锁 + 渠道金额比对（0.005 元容差）+ 以 `payment_orders.status` 为唯一幂等裁判 + 审计在事务外 + `finally` 释放连接。**这是全仓质量最高的一段代码**，建议作为范式推广（见「设计层面的观察」#5）。
- **`services/refundRequest.js` 的两段式退款**：`pending → processing → approved/rejected` 状态机 + CAS 抢占避免跨外部 HTTP 持锁 + 部分唯一索引 `uq_refund_requests_pending_per_order` 做资金动作幂等闸 + `entitlement_snapshot` 支持驳回回滚 + `listRefundRequestsForAdmin` 的 JOIN 用 `u.nickname AS user_name`（历史 `u.name` 事故已修）+ 三层分页钳制。设计正确。
- **`db/cleanup.js` 的墓碑/验证码/通知保留期清理**：都用了参数化的 `make_interval(days => $1)`，保留期可 env 配置，且 `runManualCleanup` 把错误收敛到返回值而不抛出。除 S2-14（缺索引）与 S2-20（归档不分批）外，结构是对的。
- **`middleware/maintenance.js`**：5s 进程内缓存 + 读库失败 fail-open（并注释解释了为什么这里 fail-open 而限流 fail-closed，方向相反是刻意的）+ 管理台写入后主动失效缓存 + 503 响应带 `maintenance:true` 机器可读标记。设计正确。
- **`tests/middleware/runtime-limits.test.js`**：mock 干净、场景完整（含 fail-closed 方向断言）、自带最小 express res 桩。**是全仓测试的正面样板**，建议作为其余中间件测试的模板。

