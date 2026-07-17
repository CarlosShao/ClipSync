# ClipSync 系统级全面排查报告（多用户并发 / 高可用 / 高并发）

> 生成时间：2026-07-10
> 范围：`src/server/`（Express + PostgreSQL + Redis + WebSocket）、`docker-compose.*.yml`、`nginx/`
> 方法：**逐文件代码审查**（已读取 `index.js`、`ws/server.js`、`ws-redis-pubsub.js`、`middleware/auth.js`、`middleware/rateLimiter.js`、`middleware/idempotency.js`、`db/pool.js`、`routes/clipboard.js`、`routes/media.js`、`routes/auth.js`、`routes/sessions.js`、`config.js`、`Dockerfile`、`docker-compose.prod.yml`、`docker-compose.multi.yml`、`nginx/nginx.conf`、`nginx/conf.d/clipsync.conf`、`scripts/backup-db.sh`、`db/cleanup.js`、`db/migrate.js`）。
> 诚实声明：**未做线上压测 / 未起多实例实跑**，结论均来自源码静态分析 + 架构推理。每条均标注了文件:行号，可对照复核。

---

## 0. 结论速览

| 维度 | 总体评价 | 关键风险数 |
|---|---|---|
| 多用户并发 / 数据一致性 | ⚠️ 有 1 个 P0 安全漏洞 + 多个去重/幂等缺口 | P0×1, P1×3, P2×2 |
| 高可用（HA） | ⚠️ 代码层冗余就绪，但部署配置有致命错误 + Redis 是硬 SPOF | P0×2, P1×2, P2×3 |
| 高并发能力 | ⚠️ 内存/OOM 风险极高（50MB JSON + 1GB 内存上传）+ 连接池偏小 | P0×2, P1×2, P2×3 |

**最严重 4 项（建议优先修复）：**
1. `H1` nginx 配置非法 → 多实例部署直接起不来（HA 架构形同虚设）。
2. `H2` Redis 是认证可用性 + 跨实例实时同步的硬单点，宕机即全系统降级。
3. `C1` 「注销其他设备 / 全部注销」**不会真正让令牌失效**（JWT 仍可用，被盗设备不下线）。
4. `P1`/`P2` 大体积请求全量驻留 Node 进程内存（剪贴板 50MB JSON、文件上传 1GB multer 内存存储）→ 并发即 OOM。

---

## 1. 多用户并发场景分析

### C1 【P0】会话注销不生效 —— 令牌未被真正吊销
- **根因**：`revoke`/`revoke-all` 仅把 `user_sessions.is_active = false`，但 `authenticateToken` **从不读取 `user_sessions.is_active`**。它只校验两件事：`bl:${jti}` 黑名单 和 `users.is_active`（账户是否停用）。
  - `src/server/src/routes/sessions.js:57-119`（DELETE `/:sessionId` 与 DELETE `/`）只翻 `is_active`，**没有**把目标会话的 `jti` 写入 Redis 黑名单。
  - `src/server/src/middleware/auth.js:6-68`：第 29-37 行只查 `bl:${decoded.jti}`；第 48-59 行只查 `users.is_active`。**全程没有 `user_sessions` 查询**。
  - `src/server/src/routes/auth.js:1447`（「全部注销」）同理只翻 `is_active`，未黑名其他 jti。
- **并发/安全影响**：用户在 A 设备点了「注销其他设备」，B 设备的 JWT（`jti = sessionId`）**依然完全有效**，B 的 REST API 与 WS 重连全部正常。相当于「远程踢人」功能完全失效。对多设备账号 = 实质上的会话劫持漏洞。
- **修复**：
  - 在 `revoke` / `revoke-all` 时，对**每个**被吊销的 `session.id`，以 `bl:${sessionId}`（JWT 的 `jti` 就是 `sessionId`，见 `auth.js:50`）写入 Redis 黑名单，TTL = 该令牌剩余有效期。
  - 同时在 `authenticateToken` 中 `JOIN user_sessions` 检查 `is_active`（双保险），避免「只翻标志但不查」的死状态。
- **工作量**：M。

### C2 【P1】剪贴板写入 TOCTOU 竞态 + 非文件类型零去重
- **根因**：`src/server/src/routes/clipboard.js:310-339` 的去重是 **SELECT → 再 INSERT**，两步之间无原子性。
  - 文件类型：仅 5 分钟内同 `metadata.paths[0]` 的窗口检查，**两个并发相同请求会同时通过 SELECT，各自 INSERT → 出现 2 条重复**。
  - `text / link / image / code` 类型：**完全没有服务端去重**（仅前端队列修复了部分场景，服务端无任何兜底）。
  - 数据库层 `clipboard_items` **无 `content_hash` 列，无唯一约束**（见 `db/migrate.js:155-160` 仅有 `user_id/created_at/content_type/favorites/search_vector` 索引）。这正是用户早先「复制 (2) 又复制 (5) 只同步了 5」在**服务端维度的根因缺失**——前端修了，服务端仍无安全网。
- **并发影响**：多设备/弱网重试/快速连续复制 → 数据库出现重复条目，用户看到双份。
- **修复**：
  - 新增 `content_hash` 列（写时由 `contentEncrypted`/预览计算），对 `(user_id, content_hash)` 建**部分唯一索引**（`WHERE content_type <> 'file'`），INSERT 用 `ON CONFLICT DO NOTHING` 返回已有行。
  - 文件类型用内容哈希（而非仅 `paths[0]`）做去重，并把「查重 + 插入」包进一个 `BEGIN/COMMIT` 或用 `pg_advisory_xact_lock` 防止并发插入。
- **工作量**：M-L（需迁移脚本 + 路由改造）。

### C3 【P1】变更类接口缺幂等性 → 重试即重复
- **根因**：`idempotency` 中间件（`middleware/idempotency.js`）**只在 Webhook（支付）上启用**。`index.js:335-356` 的 `/api/clipboard`、`/api/media` 等只挂了 `apiLimiter + authenticateToken + csrfProtection + subscriptionCheck`，**没有幂等中间件**。前端网络超时重试（429 退避、WS 重连后补发）会再次 INSERT。
- **影响**：与 C2 叠加，重试放大重复数据。
- **修复**：要求客户端在每个写请求带 `Idempotency-Key` 头（客户端每次「一次上传尝试」生成 UUID），并在 `POST /api/clipboard`、`POST /api/media/*` 应用 `createIdempotencyMiddleware`（key 用该头，避免用「请求体哈希」误杀不同内容）。
- **工作量**：S-M。

### C4 【P2】多语句写入未包事务 → 部分失败留脏数据
- **根因**：`clipboard.js:334-378` 与 `media.js:159-225` 的「INSERT 条目 → upsert `device_sync_state` → broadcast → sendNotification → logAuditEvent」是 5~6 条**独立 `pool.query`**，无 `BEGIN/COMMIT`。
- **影响**：若条目插入成功但 `device_sync_state` upsert 失败，该设备的「最后同步点」未更新 → 下次增量同步 `sync/:deviceId`（`clipboard.js:542-562`）可能重复拉取或漏推。并发下一致性脆弱。
- **修复**：用 `const client = await pool.connect(); client.query('BEGIN') … COMMIT/ROLLBACK` 包裹整段写逻辑。
- **工作量**：M。

### C5 【P2】限流按 IP 而非按用户 → 公平性与防护双失效
- **根因**：`middleware/rateLimiter.js:206-210` `apiLimiter` key = `x-forwarded-for / IP`。认证路由是**按 IP** 限流。
- **影响**：
  - 企业 NAT 下多用户共用一个出口 IP → 共享 100 次/分钟预算，易被误限（公平性）。
  - 分布式攻击者用多 IP → 限流形同虚设（防护弱）。
- **修复**：认证路由改 `key = req.userId`（IP 限流仅保留在 `/api/auth` 登录等匿名路由）。
- **工作量**：S。

---

## 2. 高可用性（HA）验证

> 对照「要求的 HA 架构」：代码层已为多实例做准备（Redis Pub/Sub 跨实例广播、`/api/health`+`/api/ready` 探针、nginx `least_conn` 上游）。但**部署配置与依赖韧性存在致命缺口**。

### H1 【P0】nginx 配置非法 → 多实例栈起不来
- **根因**：`nginx/conf.d/clipsync.conf:14`
  ```nginx
  limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
  ```
  `limit_req_zone` **只允许出现在 `http{}` 上下文**，此处却写在 `server{}` 内 → nginx 配置校验失败、**容器启动即退出**。并且 `nginx.conf:38` 已在 `http` 里定义过同名 `api_limit` 区 → 即便挪到 http 也属重复定义。
- **影响**：`docker-compose.multi.yml` 依赖 nginx 做 LB，**整个多实例 HA 部署无法启动**。这是「HA 架构」目前最硬伤——配置即死。
- **修复**：删除 `clipsync.conf:14` 这一行（`api_limit` 区已在 `nginx.conf` 定义）；如确需不同速率，改名后在 `http` 上下文定义。
- **工作量**：S（但必须先修，否则 HA 是摆设）。

### H2 【P0】Redis 是认证可用性 + 跨实例同步的硬单点
- **根因**：
  1. `middleware/auth.js:29-37`：每个认证请求都 `await redis.get('bl:'+jti)`，**无 try/catch 包裹**。Redis「已配置但瞬时不可达」→ `get` 抛错 → 走外层 catch → **对所有请求返回 403**（可用性崩）。Redis「未配置」→ 直接跳过黑名单（**安全漏洞**：注销失效）。
  2. `ws/server.js:365` + `ws-redis-pubsub.js`：Redis 不可用时 `isWsRedisEnabled()` 为 false，`broadcastToUser` 只做本地广播 → **跨实例设备的实时更新全部丢失**（数据不一致）。
- **影响**：单点 Redis 故障 = 认证全挂 + 多实例实时同步断裂。HA 的多实例冗余被 Redis SPOF 抵消。
- **修复**：
  - 黑名单查询加 `try/catch`，失败时对**已认证请求 fail-open 但降级**，并回退查 `user_sessions.is_active`（见 C1）作为兜底；绝不因 Redis 抖动就让全站 403。
  - 部署层面 Redis 上 **Sentinel / Cluster** 或托管哨兵；至少 `restart:always` + 健康检查已具备。
- **工作量**：M。

### H3 【P1】数据库单实例，无副本/故障转移
- **根因**：`docker-compose.prod.yml` 与 `docker-compose.multi.yml` 均只有 1 个 `postgres` 容器，仅靠 `restart:always`。无 read replica、无 Patroni/托管 HA、无 WAL 归档。
- **影响**：PG 容器或数据卷故障 = 全站不可用，RTO 取决于人工恢复。
- **修复**：生产用托管 PG（含副本+自动故障转移）或 Patroni；至少补充定时 `pg_dump` + WAL 归档（见 H5）。
- **工作量**：L（基础设施）。

### H4 【P1】连接池「连续 10 次错误就自杀」→ 多实例协同殉职
- **根因**：`db/pool.js:25-37`：_idle client 连续 10 次错误 → `process.kill(SIGTERM)`。若一次 DB 抖动同时影响所有实例 → **全部同时自杀** → 若无编排器健康探针快速拉起，则长时间全断。
- **影响**：把「瞬时 DB 抖动」放大成「全集群雪崩」。
- **修复**：不要用自杀式恢复；改「记错误计数 + 告警 + 指数退避重连」，由编排器（k8s/Docker `restart:always` + liveness probe）负责真正重启。
- **工作量**：S。

### H5 【P2】备份脚本存在但未自动化调度
- **根因**：`scripts/backup-db.sh` + `verify-backup.sh` 功能完整（pg_dump + 校验和 + 可选 GPG + 保留期），但**接收 `[daily|weekly|manual]` 参数，没有任何 compose/cron 定时调用**。`docker-compose.*.yml` 里只有 `./backups` 挂载，无调度任务。
- **影响**：除非人工执行，否则无备份 → 与 H3 的 RTO 问题叠加，恢复能力存疑。
- **修复**：在 compose 增加 `backup` sidecar（轻量 cron 容器）每日调用 `backup-db.sh daily`；并验证 `verify-backup.sh` 真的可恢复。
- **工作量**：S。

### H6 【P2】WS 每用户连接上限形同虚设
- **根因**：`middleware/rateLimiter.js:269-291` `checkWsConnectionLimit`（每用户 5 连接）是**实例内存级**；nginx 用 `least_conn`（无 sticky）→ 用户设备分散到多实例，每实例只数自己那部分，`nginx.conf:57` 的 `limit_conn ws_limit 5` 还被注释掉。
- **影响**：恶意用户可在多实例间各开几个 WS，突破全局 5 连接上限，占用资源。
- **修复**：连接计数改用 Redis 共享；或开启 nginx `limit_conn` 配合 sticky。
- **工作量**：M。

### H7 【P2】`least_conn` 无会话粘性 —— 可接受但需记录
- WS 跨实例正确性由 Redis Pub/Sub 保证（且 `ws-redis-pubsub.js:84` 用 `sourceInstanceId` **正确地避免自收自发**，不会重复投递），所以 REST/WS 无粘性是可接受设计。仅需在文档中说明，不必改。
- **正面确认**：跨实例广播**无重复投递**（自环已屏蔽），这是做对的。

---

## 3. 高并发能力评估

### P1 【P0】`POST /api/clipboard` 承载 50MB JSON 体，全量驻留内存
- **根因**：`index.js:126` `express.json({ limit: '50mb' })` 全局生效；`clipboard.js:286` 允许 `contentEncrypted` 最长 50MB 作为 JSON 字段。每个此类请求 = 50MB 字符串缓冲 + **主线程 JSON.parse**（CPU 密集）。
- **影响**：并发大剪贴板（长文本/代码/大 base64）→ Node 进程内存暴涨 + 事件循环被 parse 阻塞 → 所有请求卡顿甚至 OOM 被杀。
- **修复**：大内容走 `chunked-upload` 接口（已存在 `routes/chunked-upload.js`）；`/api/clipboard` 仅传元信息 + 引用；纯文本/代码类设置合理上限（如 10MB）并改为流式/分块。
- **工作量**：M。

### P2 【P0】`multer.memoryStorage()` 把整个上传文件读进内存（文件最大 1GB）
- **根因**：`routes/media.js:55,69` 图片/文件均用 `memoryStorage()`；文件 `limits.fileSize: 1GB`（`media.js:72`）。**上传期间整文件在 Node 堆内存**。
- **影响**：并发几个大文件上传 → 直接 OOM。这是最易触发的线上崩溃点。
- **修复**：改用 `multer.diskStorage()`（写临时文件）+ 流式传给 `sharp`/对象存储；大文件一律走 `chunked-upload`；限制单实例并发上传数。
- **工作量**：M。

### P3 【P1】DB 连接池 `max:20` 偏低 + 无事务复用
- **根因**：`db/pool.js:13` `max:20`。每个 `POST /api/clipboard` 顺序发 ~5 条 query（每条可能取不同连接），高并发下 20 连接很快耗尽 → `connectionTimeoutMillis:2000` 超时 → 503。
- **影响**：多用户同时同步时吞吐天花板低，易雪崩。
- **修复**：按 PG `max_connections` 上调 `DB_POOL_MAX` 至 50~100；用事务（见 C4）减少取放次数；读多写少场景接 read replica。
- **工作量**：S-M。

### P4 【P1】Node 单线程 —— CPU 密集工作阻塞事件循环
- **根因**：无 cluster/worker_threads。`sharp` 缩略图（`media.js:86-93,150-156` 三次独立 sharp 调用）虽在 libvips 线程，但 JSON.parse(50MB)（P1）、加密/审计串行在主线程。
- **影响**：单实例无法利用多核，CPU 峰值即全站停滞。
- **修复**：容器起多 worker（cluster 或 sidecar 多进程）；`sharp` 复用 buffer 一次出图+缩略；限制 body 大小（P1/P2）。
- **工作量**：M。

### P5 【P2】服务端→客户端广播无背压
- **根因**：`broadcastToUser`（`ws/server.js:353-370`）对每个设备 `ws.send()`，未做每用户出向队列/背压；客户端 WS 速率限制只限「入向」（`ws/server.js:168` 50/s）。
- **影响**：批量粘贴等事件洪峰时，慢设备 socket 缓冲堆积 → Node 内存增长。
- **修复**：每用户出向队列 + 背压（缓冲超阈值丢弃/延迟）。
- **工作量**：M。

### P6 【P2】通知表无保留期清理 → 无限增长
- **根因**：`sendNotification` 每次同步都写 `notification_history`（`ws/server.js:374-391`）；而 `db/cleanup.js` 只清过期 `clipboard_items` 与 `verification_codes`，**不清理通知**。
- **影响**：高写入量下 `notification_history` 膨胀 → 历史查询变慢。
- **修复**：加通知保留期（如 90 天）+ 清理定时任务 + 必要索引。
- **工作量**：S。

### P7 【P2】GIN `search_vector` 每次写入维护开销
- 可接受，记录备查；超高写入量时注意 GIN 维护成本，必要时 fastupdate。

### 死锁专项说明（用户点名）
- **数据库层死锁**：当前无跨语句事务持有锁（C4 指出的恰恰是「没包事务」），单行 UPDATE/INSERT 为行级锁、无循环等待，**预期不会出现真正 DB 死锁**。
- **实际等价「死锁/Convoy」**：P1（50MB JSON 解析）+ P2（1GB 内存上传）+ P3（连接池耗尽）在并发下会造成**事件循环饥饿 + 连接饥饿**，表现与死锁一致（请求全部挂起）。这是真实瓶颈所在，优先治 P1/P2/P3。

---

## 4. 综合问题清单与优先级（修复路线图）

| ID | 维度 | 严重度 | 文件:行 | 根因 | 修复要点 | 工作量 |
|---|---|---|---|---|---|---|
| H1 | HA | **P0** | `nginx/conf.d/clipsync.conf:14` | `limit_req_zone` 写在 `server{}`（非法）+ 与 `nginx.conf:38` 重复 | 删除该行，区已在 http 定义 | S |
| C1 | 并发 | **P0** | `sessions.js:57-119`, `auth.js:1447`, `middleware/auth.js:6-68` | 注销仅翻 `is_active`，auth 从不查 `is_active`/黑名其他 jti | 吊销时黑名目标 jti + auth 查 `user_sessions.is_active` | M |
| H2 | HA | **P0** | `middleware/auth.js:29-37`, `ws/server.js:365` | 每请求强依赖 Redis 且非韧；Redis 宕→全站 403 / 跨实例同步断 | 黑名单 try/catch 降级 + 兜底查 is_active；Redis 上 Sentinel/Cluster | M |
| P1 | 并发 | **P0** | `index.js:126`, `clipboard.js:286` | 50MB JSON 体全量内存 + 主线程 parse | 大内容走 chunked-upload；设文本上限 | M |
| P2 | 并发 | **P0** | `media.js:55,69,72` | `multer.memoryStorage()` + 文件 1GB 驻内存 | 改 diskStorage + 流式 + 走分块上传 | M |
| C2 | 并发 | **P1** | `clipboard.js:310-339`, `migrate.js:155-160` | SELECT→INSERT 非原子 + 非文件零去重 + 无 content_hash | 加 content_hash + 部分唯一索引 + ON CONFLICT | M-L |
| C3 | 并发 | **P1** | `index.js:335-356`, `idempotency.js` | 写接口无幂等，重试即重复 | 客户端 `Idempotency-Key` + 中间件 | S-M |
| H3 | HA | **P1** | `docker-compose.*.yml` | PG 单实例无副本/故障转移 | 托管 PG/Patroni + WAL 归档 | L |
| H4 | HA | **P1** | `db/pool.js:25-37` | 连续错误即自杀 → 多实例协同殉职 | 去自杀，交编排器健康探针 | S |
| P3 | 并发 | **P1** | `db/pool.js:13` | 连接池 max:20 偏小 | 上调 + 事务复用 + 读副本 | S-M |
| P4 | 并发 | **P1** | 全局（无 cluster） | 单线程 CPU 密集阻塞 | 多 worker + 复用 sharp | M |
| C4 | 并发 | **P2** | `clipboard.js:334-378`, `media.js:159-225` | 多语句写无事务 | `BEGIN/COMMIT` 包裹 | M |
| C5 | 并发 | **P2** | `rateLimiter.js:206-210` | 限流按 IP 非用户 | 认证路由 key=userId | S |
| H5 | HA | **P2** | `scripts/backup-db.sh`（未调度） | 备份脚本未自动跑 | 加 backup sidecar 定时 | S |
| H6 | HA | **P2** | `rateLimiter.js:269-291`, `nginx.conf:57` | WS 连接上限实例级且被关 | Redis 共享计数 / 开 limit_conn | M |
| P5 | 并发 | **P2** | `ws/server.js:353-370` | 服务端广播无背压 | 出向队列 + 背压 | M |
| P6 | 并发 | **P2** | `ws/server.js:374-391`, `cleanup.js` | 通知表无保留期 | 加保留期 + 清理 + 索引 | S |

**建议执行顺序**：H1（先让 HA 能起）→ C1、H2（安全/可用性致命）→ P1、P2（OOM 崩服）→ C2、C3（数据正确性）→ P3、P4（吞吐）→ 其余 P2。

---

## 5. 已验证「做对了」的部分（诚实记录，避免误改）
- 跨实例 WS 广播**无重复投递**：`ws-redis-pubsub.js:84` 用 `sourceInstanceId` 屏蔽自环。✅
- 限流器用 Redis ZSET 流水线实现**真正滑动窗口**（`rateLimiter.js:68-83`），原子、无临界问题。✅
- 每次写操作都**校验 device 归属 `user_id`**（`clipboard.js:300-307` 等），无跨用户数据越权。✅
- 安全头 / CSP / HSTS（生产）/ WS origin+CSRF+token 黑名单校验齐备。✅
- 优雅关闭：通知客户端重连 + 等待 + 关池关 Redis（`index.js:450-504`, `ws/server.js:479-538`）。✅
- 备份脚本功能完整（校验和 + 可选加密 + 保留期 + 恢复校验），只是没调度。✅
