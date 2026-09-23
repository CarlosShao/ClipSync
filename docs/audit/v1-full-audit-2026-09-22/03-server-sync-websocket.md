# 同步协议 / WebSocket / 条目生命周期 审计

- 审计日期：2026-09-22（v1 上线前全量审计 · 03 号报告）
- 范围：`src/server/src/ws/server.js`、`routes/{ws,sync,clipboard,device,versions,favorites,searchHistory,notifications}.js`、`services/{deviceOnlineSweep,notificationService,announcementDelivery,workflowEngine}.js`、`middleware/{auth,maintenance,rateLimiter}.js`、`db/`（clipboard_items / devices / device_sync_state / clipboard_deletions / file_versions）、对应测试与 `docs/plans/e2e-protocol.md`
- 排除项已核对：`docs/audit/external-dependency-audit-2026-09-09.md`、`docs/production-roadmap/external-dependencies.md`（PG/Redis 单实例 SPOF、推送通道、LB 采购等不再重复报）
- 纪律：只读审计，未修改任何源码/配置，未运行测试与服务

## 结论（≤3 句）

同步主链路（REST 写库 + WS 广播 + 墓碑删除补偿）**架构方向正确、防御性代码密度高**，但存在 1 个跨用户数据破坏级越权（版本清理端点）和 4 个 S1：重连替换竞态会让设备"在线却永远收不到推送"、`/api/sync` 增量 API 引用不存在的列全量 500、会话吊销/设备解绑对已建立 WS 完全无效（被盗设备可无限期接收实时剪贴板）。**当前状态不建议直接上 v1**：S0 一条必须修，S1 中「重连竞态」「吊销不踢线」直接命中核心产品价值与安全底线；且 WebSocket 全仓**零真实连接测试**（e2e/stress/error-recovery 全 skip），修复后必须补 WS 集成测试再上线。

## 同步语义现状还原

**写入路径（唯一真相源）**：客户端复制 → `POST /api/clipboard`（`clipboard.js:528`）在一个事务内完成「pg_advisory_xact_lock 去重（5 分钟窗口）→ INSERT clipboard_items → UPSERT device_sync_state → 审计日志」（`clipboard.js:632-722`），提交后异步做三件事：`broadcastToUser({type:'new_clipboard', item})`（本地 Map + Redis Pub/Sub 双通道，`ws/server.js:444-459`）、`sendNotification`（落库 notification_history + WS 推送）、OCR/工作流规则后台任务。WS 层还有一条 `type:'clipboard'` 的纯转发通道（`ws/server.js:323-352`，不落库、无 ack），但**桌面/移动客户端均不发送该消息类型**（全仓 grep 无调用点），属死协议面。

**游标与增量**：条目 id 是 UUID（`migrate.js:55`），无自增序，所有增量语义都基于 `created_at` 时间戳。存在三套互不一致的"增量同步"：① `GET /api/sync/pull/:deviceId?since=`（`sync.js:239`，时间戳游标 + 一个语义错误的 `device_sync_state` 反连接，见问题 #3）；② `GET /api/clipboard/sync/:deviceId`（`clipboard.js:1136`，游标=最后同步条目的 created_at 子查询，该条目被硬删即永久卡死）；③ 实际客户端在用的：桌面端 `GET /api/clipboard`（分页列表）+ `GET /api/clipboard/sync-deletions?since=`（墓碑，重连后拉取）；移动端 `syncPull/syncPush` 已定义但**零调用点**（`api_service.dart:306,323`，grep 全 lib 无 caller），离线补偿实际走客户端队列（`pending_upload_queue.dart`）重放 `POST /api/clipboard`。

**删除传播**：硬删 + `AFTER DELETE` 触发器写 `clipboard_deletions` 墓碑（`041_deletion_tombstones.sql:29-32`，保留 30 天），覆盖所有删除路径；实时靠 `clipboard_deleted` WS 广播，离线靠桌面端 `syncDeletions()`（`clipboardLoad.ts:83`，5s 时钟回拨余量 + serverTime 游标，设计合理但忽略 hasMore，见问题 #9）。

**冲突策略**：主写入路径是 append-only（每次复制新条目 + 5 分钟去重），天然无冲突；`/api/sync/push` 的 update 用 `clientTimestamp < serverTime → conflict`（`sync.js:92-106`）的 LWW，但比较的是**客户端时钟 vs 服务端 updated_at**，时钟回拨即误判（该端点现无客户端使用）。

**在线状态**：WS register 置 `is_online=TRUE`（`ws/server.js:314-317`），close 置 FALSE，`deviceOnlineSweep` 每 60s 把 `last_seen_at` 超过阈值（默认 5 分钟，读 system_configs）的在线设备置离线（`deviceOnlineSweep.js:61-83`）；`last_seen_at` 由客户端应用层 ping（桌面 25s/移动 30s）逐次 UPDATE 刷新。

**多实例**：Redis Pub/Sub（`ws-redis-pubsub.js`）转发跨实例广播，带 sourceInstanceId 防回环，设计成立；但连接数限制、在线用户表、forceDisconnectDevice 全是进程内存态（见问题 #15）。

**E2E 加密**：`metadata.e2e` 信封服务端透传不解析，结构校验（keys≤32 / wrapped≤256B / iv≤32B / epk≤128B）与 `e2e-protocol.md` §5 完全一致；广播携带完整信封，接收端另取 `GET /:id/content` 拿密文。这条线实现质量最高。

---

## 问题清单（按严重度从高到低）

### [S0-1] `POST /api/versions/cleanup` 无管理员鉴权，任何登录用户可清空全库所有用户的版本历史

- 证据：`src/server/src/routes/versions.js:155-167`
  ```js
  router.post('/cleanup', apiLimiter, async (req, res) => {
    const { retentionDays = 90, maxVersionsPerItem = 50 } = req.body;
    const cleanedByAge = await cleanupOldVersions(retentionDays);
    const cleanedByCount = await limitVersionsPerItem(maxVersionsPerItem);
  ```
  `versionManager.js:307-343`：两个函数的 DELETE 均**无 user_id 过滤**（全表）；挂载链 `index.js:435` 只有 `authenticateToken + apiLimiter + csrfProtection + subscriptionCheck`，无 `requireRole`。传 `maxVersionsPerItem: 0` → `WHERE rn > 0` → **全库 file_versions 一行不剩**。对比：同能力的自动清理只应在 `startVersionCleanupScheduler`（versionManager.js:378）内部跑。
- 失败场景：任意注册用户（含恶意脚本）登录 → `POST /api/versions/cleanup {"retentionDays":0,"maxVersionsPerItem":0}` → 所有用户「版本历史/回滚」数据瞬间蒸发，不可恢复；同时该 DELETE 全表扫描可长时间持锁拖垮 DB。
- 影响：跨用户数据破坏（S0 定义命中「跨用户串数据/丢数据」）+ 可用性。
- 修法：删除该公开端点或加 `requireRole(50)` + adminStrictLimiter，参数改服务端固定值。

### [S1-1] WS 重连替换竞态：旧连接 close 处理器把**新连接**从广播表删除并置 is_online=FALSE，设备"在线却永久收不到任何推送"

- 证据：`src/server/src/ws/server.js:300-307`（register 替换旧连接）
  ```js
  const oldWs = userConns.get(deviceId);
  if (oldWs && oldWs !== ws) {
    userConns.delete(deviceId);
    try { oldWs.close(4000, 'Replaced by new connection'); } catch {}
  }
  connections.get(userId).set(deviceId, ws);
  ```
  `ws/server.js:375-397`（close 处理器**无条件按 deviceId 删除**，不校验 map 里存的是不是自己）：
  ```js
  ws.on('close', async () => {
    if (deviceId) {
      removeWsConnection(userId, deviceId);
      const userDevices = connections.get(userId);
      if (userDevices) {
        userDevices.delete(deviceId);   // ← 此时 map 里已经是新连接 wsB
        ...
        await pool.query('UPDATE devices SET is_online = FALSE WHERE id = $1', [deviceId]);
  ```
- 失败场景（可复现时序）：手机在 t1 地铁断网（TCP 半开，服务端 30s ping + 5s 超时前不会判定死亡）；t2 手机切到 WiFi 重连，t3 新连接 wsB `register` 成功——服务端走替换分支 `oldWs.close(4000)`，但 wsA 的对端已不可达，close 握手要等超时/terminate 才产生 `close` 事件；t4 wsA 的 close 事件到达 → 执行 `userDevices.delete(deviceId)` 删掉的是 **wsB 的表项**，并 `UPDATE devices SET is_online=FALSE`。此后电脑复制 → `broadcastToUser` 遍历 connections 找不到该手机 → **手机永远收不到 new_clipboard / clipboard_deleted / notification / force_logout**；客户端已收到 `registered` 回执、UI 显示在线；`ping` 只刷 `last_seen_at` 不刷 `is_online`（ws/server.js:358-363），deviceOnlineSweep 也只置离线不置在线 → 状态无法自愈，直到下一次重连。「手机复制→电脑秒粘」的反向链路同理失效。
- 影响：核心同步静默不可用，恰好发生在最常见的「网络切换/断网重连」路径；需用户重启 App 恢复（S1 定义命中）。
- 修法：close 处理器改为 `if (userDevices.get(deviceId) === ws) userDevices.delete(deviceId)`，is_online 置 FALSE 同样加此守卫（或改 `WHERE NOT EXISTS 同设备其他活跃连接`）；removeWsConnection 同步修正。

### [S1-2] `/api/sync/pull` 全量 500、`/api/sync/push` 的 update 恒失败：SQL 引用不存在的列 `content_diff`；diff 库包名装错

- 证据：`src/server/src/routes/sync.js:265`（pull 增量分支）与 `:281`（全量分支）均 `SELECT ... ci.content_diff ...`；`:120-129`（push update）`UPDATE clipboard_items SET ... content_diff = $4 ...`。全仓 schema（`migrate.js:54-67` 建表 + 74 个 migration grep `content_diff`）**零命中**该列 → PostgreSQL 42703，pull 两个分支必 500「Sync pull failed」，push 的每条 update 必落 `status:'error'`。另 `sync.js:7` `import * as jsdiff from 'jsdiff'`，而 `node_modules/jsdiff/index.js:2` 是 `module.exports = diff`（无 `createPatch`；正确包名应为 `diff`）→ `sync.js:113` 调用必 TypeError（被 try/catch 吞成 warn），大文本差量能力整体死亡。
- 失败场景：移动端（或任何未来客户端）离线 3 小时后恢复网络 → 调 `GET /api/sync/pull/:deviceId?since=...` 补齐 → 500 → 离线期间电脑复制的所有条目在本机不可见且重试永远失败；离线队列 flush 中带 `action:'update'` 的改动（收藏状态、元数据）静默丢失（返回 error，客户端无重试语义）。当前移动端 `syncPull/syncPush` 恰好无调用点（api_service.dart 死代码）掩盖了此问题——即"文档承诺的服务端离线补齐通道实际是断的"。
- 影响：增量同步 API 不可用（S1）；因现网客户端未走此通道，未升级为 S0。
- 修法：migration 补 `content_diff` 列或从 SQL 中删除该列；`jsdiff` 依赖换成 `diff` 并改 import；随后为 pull 补集成测试。

### [S1-3] 会话吊销对 WS 无效：`DELETE /api/sessions/:id` 黑名单写错键（`blacklist:` vs `bl:`），且 WS 握手/存续期均不查会话活性 → 被吊销设备可**重连并持续接收实时剪贴板**

- 证据：`src/server/src/routes/auth-session.js:54-57`
  ```js
  // TODO: 将 token 加入 Redis 黑名单
  const redisClient = await getRedisClient();
  await redisClient.set(`blacklist:${sessionId}`, 'true', { EX: 86400 });
  ```
  而 WS 握手读的是 `ws/server.js:214-215` `redis.get(\`bl:${decoded.jti}\`)`（jti=sessionId，`auth.js:61`）；WS 握手只验 JWT 签名+黑名单，**不查 `user_sessions.is_active`**（对比 REST `middleware/auth.js:52-71` 有 DB 双查）。已建立的 WS 连接在任何吊销路径下都不会被断开（`forceDisconnectDevice` 仅管理台 `admin/devices.js:318` 调用；logout/吊销会话路由均不调用）。
- 失败场景：t1 用户手机丢失，在桌面「会话管理」里终止该手机会话；t2 手机上的 App WS 连接仍然活着 → 用户在电脑复制的每条内容（含密码、验证码）继续实时推送到丢失的手机；t3 即使手机 WS 断线重连，握手查 `bl:{jti}` 查不到（键写在 `blacklist:{sessionId}`）→ 重连成功，继续收。REST 会被 `session_active=false` 拦住，但实时同步通道完全失守。
- 影响：安全/数据泄露——吊销语义对核心同步通道失效，命中"被盗设备持续接收剪贴板"这一最敏感场景。
- 修法：auth-session 改用 `blacklistJti`（与 logout 一致，`auth-session.js:87` 已有正确示范）；WS 握手增加 `user_sessions.is_active` 查询；logout/吊销/登出路径调用 `forceDisconnectDevice` 踢掉存量连接。

### [S1-4] 设备解绑不踢 WS 连接：已删除设备继续实时接收该用户全部剪贴板广播

- 证据：`src/server/src/routes/device.js:307-337` `DELETE /api/devices/:deviceId` 只做 `DELETE FROM devices` + `broadcastToUser({type:'device_removed'})`，**不调用 `forceDisconnectDevice`**（该函数全仓唯一调用点在 `admin/devices.js:318`）。被删设备的 WS 仍在 `connections` Map 中（键是 userId→deviceId，删除设备不触碰它），后续 `broadcastToUser` 照常向其推送 `new_clipboard`；其 `ping` 的 `UPDATE devices SET last_seen_at` 静默 0 行，连接永不失效。
- 失败场景：用户把旧电脑挂闲鱼前在 App 里「删除设备」→ 旧电脑上运行的 ClipSync 进程 WS 不断开 → 买家开机后无需登录即可**实时看到用户新复制的每一条内容**（直到进程重启）；`device_removed` 消息客户端处理与否不影响服务端继续广播。
- 影响：安全/数据泄露（解绑=失去信任的设备，却保留最核心的数据通道）。
- 修法：删除设备时调用 `forceDisconnectDevice(userId, deviceId, 'device unbound')`，并在广播循环里跳过 devices 表已不存在的连接。

### [S2-1] 解绑设备级联删除该设备来源的全部历史条目（`ON DELETE CASCADE`），无确认、无归档

- 证据：`src/server/src/db/migrate.js:57`
  ```sql
  source_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE
  ```
  配合 `device.js:317-320` 的硬 DELETE：删设备 → 该设备复制过的所有 clipboard_items 连带删除（触发器写墓碑 → 其他设备本地列表也随之移除）。
- 失败场景：用户换手机，删除旧设备记录 → 旧手机两年间复制的全部云端历史（含收藏）瞬间消失，且经墓碑同步从所有端消失；用户预期只是"解绑"。
- 影响：数据丢失（用户操作触发、但后果与直觉严重不符）。
- 修法：解绑改软删（devices 加 deleted_at，条目保留、source 置 NULL 或保留引用），或至少在 API/客户端做二次确认并明示将删除 N 条历史。

### [S2-2] WS 推送 fire-and-forget：无 ack/重传，背压时静默丢消息；「写库成功+推送丢失」无补偿协议

- 证据：`ws/server.js:60-67`
  ```js
  if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > WS_MAX_BUFFERED) {
    logger.warn('[WebSocket] backpressure: dropping message, ...');
    return false;
  ```
  `clipboard.js:734` 广播在事务 COMMIT 之后、无投递确认；`sync.js:206` 同。协议中不存在任何 ack/序号/重传消息类型（ws/server.js switch 只有 register/clipboard/ping）。
- 失败场景：t1 电脑 A 弱网（bufferedAmount>1MB），t2 手机复制 3 条 → 3 条 `new_clipboard` 全部被 safeSend 丢弃（仅 warn 日志），t3 A 恢复网络但 WS 未断 → 不会触发任何补拉 → A 的列表缺 3 条，直到用户手动刷新/重连。桌面端有列表刷新兜底（新增侧），但 `clipboard_favorite`/`clipboard_updated`/notification 类消息丢了就是永久不一致。
- 影响：边界时序下条目"不同步"（非丢库内数据，丢的是端上一致性）。
- 修法：为广播消息加自增 seq + 客户端 gap 检测（发现跳号即触发一次 pull），或至少在 WS 恢复/重连时强制列表刷新协议化。

### [S2-3] 桌面端墓碑补偿忽略 `hasMore`：单窗口 >500 条删除时游标照常推进，剩余删除**永久**同步不到

- 证据：服务端 `clipboard.js:349-363` `LIMIT 500` + `hasMore: result.rows.length === 500`；客户端 `clipboardLoad.ts:91-101` 拉一次后直接把游标推到 `serverTime - 5s`，**未检查 hasMore、未分页循环**。
- 失败场景：过期清理任务（`cleanup.js:27-31`，每小时全库删过期条目）一次删掉某用户 800 条 → 桌面重连后 syncDeletions 只拿到前 500 条墓碑，游标却已越过全部 800 条 → 剩余 300 条在本地列表成"幽灵条目"，点开取内容 404。
- 影响：端云不一致（中等概率、批量删除场景必现）。
- 修法：客户端 `while (hasMore)` 循环拉取；或服务端游标改返回 `max(deleted_at)` 由客户端续拉。

### [S2-4] nginx LB 配置：`location /ws/` 匹配不到实际路径 `/ws`，且 access_log 记录完整 query（JWT/csrf_token 入日志）

- 证据：`nginx/conf.d/clipsync.conf:45-48`（`location /ws/` + Upgrade 头）vs 服务端 `ws/server.js:86` `path: '/ws'`、桌面 `useWebSocket.ts:80` `'/ws?token=' + encodeURIComponent(...)`、移动 `ws_service.dart:134` `Uri.parse('${ServerConfig.wsUrl}/ws')` —— 请求路径是 `/ws`（无尾斜杠），前缀 `/ws/` 不匹配 → 落入 `location /`（clipsync.conf:70-74，**无 Upgrade 头**）→ WS 握手失败。`nginx/nginx.conf:18-22` `log_format main '... "$request" ...'` 含完整请求行 → `/ws?token=<24h JWT>&csrf_token=...` 全量落入 access.log。
- 失败场景：按 `docker-compose.multi.yml`/该 nginx 部署 → 所有客户端 WS 连不上，实时同步全灭（客户端只见反复重连）；任何能读日志的人拿到活跃 JWT 即可完整冒充用户（REST+WS）。
- 影响：可用性（若走此 LB）+ 凭据泄露。runbook 中生产若直连 api 或用 k8s ingress（ingress.yaml 有 websocket 注解）则前者不触发，但日志问题在任何反代记录 $request 时都在。
- 修法：location 改 `= /ws`（或 `/ws`）；客户端改用 `Sec-WebSocket-Protocol` 或握手后首帧鉴权替代 query token，短期先给 `/ws` location 关 access_log。

### [S2-5] `GET /api/clipboard?all=true` 无上限全量加载（limit=Infinity），大历史用户单请求可 OOM

- 证据：`validation/validator.js:200-202` `if (all) return { page: 1, limit: Infinity }`；`clipboard.js:60,165-177` `useLimit = pagination.limit < Infinity` → 不拼 LIMIT 子句，整表（该用户）SELECT 含最长 5000 字符 preview + metadata + OCR 文本。桌面端确实会带 `all=true`（`clipboardLoad.ts:199`）。
- 失败场景：重度用户 3 万条条目（企业版无条目上限）→ 一次"全部"视图加载拉 ~150MB+ 行数据进 Node 堆做 JSON 序列化 → 请求 30s 超时（index.js:184-205）前可能先 OOM/阻塞事件循环，影响同实例所有用户的实时同步。
- 影响：可用性/性能。
- 修法：`all=true` 也设硬上限（如 1000）+ 键集分页（created_at < cursor）。

### [S2-6] `/api/sync/push` 绕过套餐容量、去重与 preview 截断——与主写入路径三重不一致

- 证据：`sync.js:57-72` create 分支直接 INSERT：无 `checkClipboardLimit`（对比 `clipboard.js:528` 挂载链）、无 content_hash 去重（对比 `clipboard.js:634-673`）、`data.contentPreview` 原样入库无 `substring(0,5000)`（对比 `clipboard.js:568`）、contentEncrypted 无 10MB 校验（对比 `clipboard.js:557`）；也不写 content_hash/image_hash → 离线重放与实时通道可产生重复条目。
- 失败场景：免费用户（max_clipboard_items=50）脚本走 `/api/sync/push` 每次 50 条无限循环 → 配额击穿；离线队列重放时同一条目既被 PendingUploadQueue 以 POST /api/clipboard 上传又被 push 上传 → 双份入库且无法去重。
- 影响：钱（套餐配额）+ 数据重复。
- 修法：push 的 create 分支复用主路径的校验/去重/截断逻辑（抽公共函数）。

### [S2-7] `favorites.js` reorder 用 `pool.query('BEGIN'/'COMMIT')` 伪事务——每条 SQL 走不同池连接，事务完全无效

- 证据：`src/server/src/routes/favorites.js:116-127`
  ```js
  await pool.query('BEGIN');
  try {
    for (const o of orders) { ... await pool.query('UPDATE favorite_collections SET sort_order = ...') }
    await pool.query('COMMIT');
  } catch (e) { await pool.query('ROLLBACK'); throw e; }
  ```
  node-pg 的 `pool.query` 每次取/还不同连接：BEGIN 作用在随机连接 A，各 UPDATE 分散在连接 B/C/D（autocommit），COMMIT 又落在连接 E。中途失败 ROLLBACK 无效，排序更新呈部分生效。同样模式还出现在 `aiConversations.js:323`、`aiTools.js:3795`（超出本范围，建议一并排查）。
- 失败场景：用户拖动收藏夹排序，10 条 UPDATE 第 6 条失败 → 前 5 条已提交、后 5 条丢失 → 收藏夹顺序错乱且"重试"从错误状态开始。
- 影响：数据错乱（低概率、小范围）。
- 修法：`const client = await pool.connect()` 单连接事务（同文件其他仓库正确写法可参考 `clipboard.js:531-731`）。

### [S2-8] workflowEngine 用户自定义正则在事件循环同步执行——ReDoS 可挂起整个实例

- 证据：`services/workflowEngine.js:21-27`
  ```js
  if (mode === 'regex') {
    return keywords.some((k) => {
      try { return new RegExp(k, 'i').test(text) } catch { return false }
  ```
  规则来自用户输入（workflow_rules 表），`text` 是最长 5000 字符的 preview；`runWorkflowRulesForItem` 在每次 POST /api/clipboard 后被调（`clipboard.js:766`）。灾难性回溯正则（如 `(a+)+$` 配 30 个 a + 感叹号）单次 `test` 可阻塞事件循环数十秒——**Node 单线程，全实例所有用户的 WS 心跳/推送/HTTP 一起卡死**（客户端 pong 看门狗 35s 超时 → 集体重连风暴 → 触发 S1-1 竞态）。
- 影响：可用性（单用户可拖垮整实例，无需恶意，写错正则即可）。
- 修法：正则执行放 worker_threads 或用 RE2（线性时间引擎），并加执行超时。

### [S2-9] 多实例部署下连接限制/在线统计/强制下线全是进程内存态——水平扩容即错

- 证据：`middleware/rateLimiter.js:308-312`（注释自认）
  ```js
  // WebSocket连接限流（每用户最多5个连接）
  // 注意：WebSocket连接对象无法序列化到Redis，此限流保持内存模式
  // 多实例部署时需配置Nginx会话粘性
  const wsConnections = new Map();
  ```
  `ws/server.js:16-17` `forceDisconnectDevice` 只查本实例 `connections`；`ws/server.js:574-586` `getOnlineUsers` 同。Redis Pub/Sub 只覆盖广播，不覆盖这三类状态。
- 失败场景：双实例部署，用户设备连在实例 B；管理台「远程下线」请求打到实例 A → `forceDisconnectDevice` 返回 false，管理员看到"设备不在线"，被盗设备继续同步。连接数限制同理：5 台上限变成每实例 5 台。
- 影响：安全操作不可靠 + 限流失效（属"代码依赖内存态所以水平扩容即错"的设计问题，非外部依赖）。
- 修法：设备→实例路由表落 Redis（`ws:device:{userId}:{deviceId} = instanceId`），force_disconnect 走 pub/sub 指令频道；在线统计查路由表。

### [S2-10] `POST /api/favorites/migrate-hierarchy`：任何登录用户可触发全库 DDL/数据迁移

- 证据：`favorites.js:501-545`
  ```js
  await pool.query('CREATE EXTENSION IF NOT EXISTS ltree');
  ...
  await pool.query('ALTER TABLE favorite_collections ADD COLUMN path ltree');
  const backfillResult = await pool.query(`UPDATE favorite_collections SET path = ... WHERE path IS NULL`);  // 无 user_id 过滤，全库回填
  await pool.query('ALTER TABLE favorite_collections ALTER COLUMN path SET NOT NULL');
  ```
  挂载链（index.js:475）仅 authenticateToken。schema 迁移放在普通用户 API 里，且 UPDATE/ALTER 作用于全体用户数据；`SET NOT NULL` 在并发插入 path 为空的行时会失败，`ALTER TABLE` 取 ACCESS EXCLUSIVE 锁可阻塞收藏夹全部读写。
- 影响：越权 schema 变更 + 锁表可用性风险（若 DB 账号无 superuser，CREATE EXTENSION 会失败，破坏面缩小但依然不该暴露）。
- 修法：删除端点，迁移逻辑并入 `db/migrations`。

### [S2-11] `GET /api/clipboard/sync/:deviceId`：游标条目被硬删后增量同步**永久**返回空

- 证据：`clipboard.js:1164-1168`
  ```js
  if (syncState.rows.length > 0 && syncState.rows[0].last_synced_item_id) {
    sinceClause = `AND ci.created_at > (SELECT created_at FROM clipboard_items WHERE id = $2)`;
  ```
  删除是硬删（`clipboard.js:1055`）：若最后同步的那条被删，子查询返回 NULL → `created_at > NULL` 恒 NULL → 0 行 → `result.rows.length > 0` 不成立 → 游标永不推进 → 该设备此端点永久空转（新条目也查不出来）。
- 失败场景：设备 D 同步到条目 X 后，X 在另一端被删除；此后 D 每次调此端点都得到空列表——即便又产生了 100 条新条目。当前客户端未使用此端点（桌面走 list+墓碑，移动 syncPull 死代码），故降为 S2；但它是公开 API，任何新端接入即踩雷。
- 影响：增量同步静默停摆（潜伏）。
- 修法：device_sync_state 改存 `last_synced_at` 时间戳游标（或存 deleted 后仍可解析的位点），不依赖条目行存在。

### [S3-1] WS `type:'clipboard'` 直转通道：不落库、无大小/类型校验、无客户端使用——死协议面且语义危险

- 证据：`ws/server.js:323-352`（转发 `message.content` 原文，无任何 schema 校验；对比 REST 路径有完整校验+去重+审计）。全仓客户端 grep 无发送方。
- 影响：若未来某端启用，会产生"在线设备收到、离线设备永久丢失"的隐形通道（无持久化）。
- 修法：删除该 case，或强制走 REST。

### [S3-2] `GET /api/clipboard/stats` 注册了两次（完全重复的死代码）

- 证据：`clipboard.js:372-398` 与 `clipboard.js:401-427` 逐字重复；Express 只命中第一个。
- 修法：删一份。

### [S3-3] `ws/server.js` 的 SIGINT 处理器 `process.exit(0)` 抢跑 index.js 的优雅关停

- 证据：`ws/server.js:664-667`
  ```js
  process.on('SIGINT', () => { closeWsRedisPubSub(); process.exit(0); });
  ```
  该 handler 在 import 时注册、先于 `index.js:781` 的 `gracefulShutdown('SIGINT')` 执行 → Ctrl+C/容器 SIGINT 时跳过 server_shutdown 通知、DB/Redis 优雅关闭与 is_online 清理（SIGTERM 路径不受影响，docker stop 默认 SIGTERM，故降 S3）。
- 修法：删除此 handler，关停统一由 index.js 负责。

### [S3-4] `GET /api/clipboard/:id` 与 `/:id/content` 不排除已过期条目，与列表口径不一致

- 证据：列表 `clipboard.js:89` `AND (ci.expires_at IS NULL OR ci.expires_at > NOW())`；单条 `clipboard.js:439-445`、内容 `:509-512` 仅按 id+user 过滤 → 过期条目在每小时清理（cleanup.js:27）前仍可直连读取。
- 影响：产品口径「过期即消失」被 API 细节破坏（小）。
- 修法：单条/内容查询补同样的 expires_at 条件。

### [S3-5] Redis Pub/Sub 转发绕过背压保护

- 证据：`utils/ws-redis-pubsub.js:94-98` `for (...) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }` —— 不走 `safeSend`，无 bufferedAmount 检查；多实例下慢客户端可让订阅实例内存增长。
- 修法：导出并复用 safeSend。

### [S3-6] `sendNotification` 不检查 notification_preferences——用户关闭某类通知仍会推送并落库

- 证据：`ws/server.js:493-530` 直接 createNotification + broadcastToUser；`getNotificationPreferences`（notificationService.js:13）全仓只有 GET /preferences 路由和 AI 工具读它，写路径零消费。
- 影响：偏好设置形同虚设；每次复制写一行 notification_history（重度用户 90 天保留期内数万行，靠 cleanup.js:52 兜底）。
- 修法：sendNotification 入口查偏好（带缓存），关闭的类型不落库不推送。

### [S3-7] 热点查询缺 `(user_id, created_at)` 复合索引

- 证据：`migrate.js:155-156` 只有 `idx_clipboard_items_user_id(user_id)` 与 `idx_clipboard_items_created_at(created_at DESC)` 两个单列索引；而列表/同步/统计全部是 `WHERE user_id=$1 ... ORDER BY created_at DESC`（clipboard.js:62,174-175; sync.js:271-274）。大用户量下 planner 只能 bitmap-and 或走 created_at 索引逐行过滤 user_id。
- 修法：加 `CREATE INDEX ... ON clipboard_items(user_id, created_at DESC)`（可顶替两个单列索引）。

### [S3-8] 其他小项

- WS 连接上限硬编码 5（`rateLimiter.js:331`、`ws/server.js:288`），与套餐 max_devices 无关联；企业套餐 >5 台设备会被 4007 误杀。
- 通知历史 `GET /api/notifications/history` limit 未设上限（`notificationService.js:60`，客户端可传 1e6）。
- WS 应用层 ping 每 25-30s 触发一次 `UPDATE devices`（`ws/server.js:358-363`）：1 万台在线 ≈ 350+ 写/秒，建议节流至 ≥60s 一次落库（sweep 阈值默认 5 分钟，余量充足）。
- `middleware/auth.js:8-20` NODE_ENV=test 全量鉴权旁路：若生产容器误设 NODE_ENV=test 即全站无鉴权，建议加启动期硬断言（production 域名/端口下拒绝 test 值）。
- 生产 Origin 校验仅在 `origin` 头存在时生效（`ws/server.js:127`）：原生客户端不发 Origin 属合理放行，浏览器必发 → CSWSH 在生产被拦；dev/test 环境完全不校验（可接受，但注意 dev 若暴露公网则裸奔）。

---

## 与协议文档的一致性核对（docs/plans/e2e-protocol.md vs 代码）

| 文档条款 | 代码实现 | 结论 |
|---|---|---|
| §5 信封结构校验：keys≤32、单 wrapped≤256B、iv≤32B、epk≤128B，非法 400 | `clipboard.js:574-601` 逐项一致 | ✅ |
| §5 `content_preview` E2E 固定 `[E2E]`，服务端透传 | 服务端不校验 preview 值，原样存（≤5000 截断，`clipboard.js:568`） | ✅（宽松透传，符合"不解析内部"） |
| §5 广播 `new_clipboard` 含完整 metadata（信封）+ contentPreview | `clipboard.js:734-746` 一致；但**不含 contentEncrypted**，接收端需另调 `GET /:id/content`（clipboard.js:500-524，metadata 随密文返回）| ✅（文档未写明需二次拉取，建议补充） |
| §6 OCR：`metadata.e2e` 存在即跳过 | `aiOcr.js:143-150` runOcrForClip 入口先查库判 isE2eItem | ✅ |
| §6 图片查重跳过 E2E、客户端哈希不落库 | `clipboard.js:611` `if (detectedType === 'image' && !isE2eItem(metadata))` | ✅ |
| §4 公钥注册：POST /api/devices 与 pairing redeem 请求体 `publicKey`，PUT 补交 | `device.js:20-28,113-123,205-233,271-292` | ✅ |
| §2 `content_encrypted` = base64(ct‖tag) | 服务端不解析（透传），仅 E2E 时跳过 imageHash | ✅ |
| **增量同步协议** | **无任何文档**：`file-sync-v1-plan.md`/`file-sync-v1-acceptance.md` 只覆盖文件上传/下载配额，`e2e-protocol.md` 只覆盖加密。/api/sync 的游标、冲突、离线补齐语义没有真相源，三套增量端点互不一致（见现状还原） | ❌ 文档漂移 |
| e2e-vector.json | 客户端加解密对拍向量，与服务端无涉 | —（适用性说明） |

## 测试有效性评估

**结论：WebSocket/实时同步链路的测试覆盖率为零，且多个"门面"测试套件被整体 skip。**

| 文件 | 实况 |
|---|---|
| `tests/e2e.test.js` | **L31 `describe.skip` 全套跳过**。即使打开也不起 WS（`index.js:656` `NODE_ENV==='test'` 时根本不调用 `setupWebSocket`），全程 supertest HTTP；断言宽松（`expect([201,200]).toContain`、7.1 在 test 环境不断言、7.3 收集 responses 后**零断言**）；8.1 断言 `/api/health` 有 `checks` 字段——实际该字段在 `/api/ready`（index.js:272-278），打开也会红 |
| `tests/stress.test.js` | **L18 `describe.skip` 全套跳过**；内部 2.1/3.1 再 it.skip；"压力"实为 100 并发 supertest（无 WS 连接、无广播风暴场景） |
| `tests/error-recovery.test.js` | **L24 `describe.skip` 全套跳过**；其"WebSocket 连接恢复"章节（L103）在 test 环境额外二次 skip——即断线重连/替换竞态（S1-1）**从未被任何测试触碰** |
| `tests/api.test.js` | L149-156 "WebSocket Module" 仅断言 `typeof broadcastToUser === 'function'`——**同义反复**；其余为 schema/模块导出检查 |
| `tests/webhook.test.js` | 只测验签器模块导出与工厂函数可调用，无真实回调报文 |
| `tests/integration.test.js` | PG/Redis 连通性冒烟，合理但不涉同步 |
| `tests/expiry.test.js`、`archive.test.js`、`version.test.js` | 真实 supertest + 测试库（clipsync_test 护栏好），覆盖过期/归档/版本 API 主路径——**未覆盖 versions/cleanup 的越权（S0-1）** |
| `tests/performance.test.js` | 真实压 HTTP 端点（含 /api/sync/push），并发写 it.skip；**没有 pull 用例**——这正是 S1-2 全量 500 却长期无感的原因 |

**缺失的关键场景清单**（修复后必须补）：WS 握手鉴权（无 token/过期 token/错 Origin/CSRF 重放）、register 替换竞态（同 deviceId 双连接）、断线期间 new_clipboard/clipboard_deleted 丢失与墓碑 hasMore 分页、背压丢弃、多实例 Redis Pub/Sub 转发、`/api/sync/pull` 真实响应、吊销会话后 WS 行为、广播风暴（5 设备 × 高频复制）。

## 设计层面的观察

1. **三套增量同步并存、真相源缺失**：`/api/sync/pull`（时间戳游标+坏的 device_sync_state 反连接）、`/api/clipboard/sync/:deviceId`（created_at 子查询游标，会永久卡死）、桌面实际用的「list + sync-deletions 墓碑」。sync.js 的 `LEFT JOIN device_sync_state ... WHERE dss.device_id IS NULL`（sync.js:270-272）语义上只排除"恰好等于 last_synced_item_id 的那一条"，是伪去重。建议冻结一套：墓碑（删除）+ 单调位点（新增，`created_at` 需处理同毫秒并列，建议 `(created_at, id)` 复合游标）+ 客户端 seq/ack。
2. **时间戳游标的固有竞态**：`created_at > since` 且 `since` 取上次响应的 `lastSyncAt`（查询之后生成，sync.js:323）——PG 的 `NOW()` 是事务开始时间，一个先开始、后提交的插入事务 created_at 早于 lastSyncAt 但对上次查询不可见 → 该条目被游标永久跳过。现客户端（列表刷新+墓碑）绕开了它，但任何回到 pull 模式的实现都会踩中。修法：游标查询用 `statement_timestamp()` 之前的安全水位（如 since - 5s 重叠窗，桌面墓碑已经这么做）。
3. **写库与推送不在一个一致性边界**：COMMIT 后广播，广播失败仅日志（这是正确取舍），但缺"客户端拉取兜底协议"（重连后强制 refresh 只有桌面端事实性做了）。建议把「重连 → registered → 拉列表第一页 + sync-deletions」写成协议文档并对移动端补齐（移动端目前重连后**不做**任何补偿拉取，离线期间新增/删除都感知不到，只靠进列表页手动刷新）。
4. **心跳双轨**：WS 协议层 ping/pong（服务端 30s/5s 超时 terminate）+ 应用层 `{type:'ping'}`（客户端 25/30s）+ `last_seen_at` DB 写 + 60s sweep。四层叠加能工作，但 `is_online` 的置位/复位路径分散在 register/close/sweep 三处且互相不知晓（S1-1 的根因即"close 不知道自己可能已被替换"）。建议把在线状态收敛为「connections 表派生」的单一事实。
5. **CSRF-token-in-query 的一次性设计**（routes/ws.js，60s TTL、用后即焚）是亮点，配合生产强制校验，CSWSH 防护到位；但 token 也走 query（S2-4 日志泄露），两者应一起迁出 URL。
6. **通知即广播副作用**：每次复制触发 1 行 notification_history + 2 类 WS 消息（new_clipboard + notification），高频复制用户写放大明显，且偏好开关不生效（S3-6）。

## 建议补充的功能（按性价比排序）

1. **WS 消息 seq + 客户端 gap 补拉**（改 S2-2/S2-3 类问题为自愈）：广播带每用户单调 seq，客户端发现空洞即触发一次增量拉取。成本低，一次性解决"丢推送"整类问题。
2. **重连补偿协议化**：`registered` 消息里带 `serverTime`，客户端统一执行「刷列表第一页 + sync-deletions(since=本地游标) + 处理 hasMore」；移动端补齐（当前完全没有）。
3. **吊销→踢线联动**：logout / DELETE session / 删除设备 / 改密 统一调用 forceDisconnectDevice，多实例经 Redis 指令频道（与 S2-9 一并做）。
4. **统一增量同步端点**：废弃 `/api/clipboard/sync/:deviceId`，修复 `/api/sync/pull`（补列/删列 + `(created_at,id)` 复合游标 + 重叠窗），写协议文档并让移动端离线队列真正接上。
5. **WS 集成测试基建**：test 环境允许 `setupWebSocket`（用随机端口），补 register/替换/断线/广播/限流用例——这是防止 S1-1 类竞态回归的唯一手段。
6. **`(user_id, created_at DESC)` 复合索引** + `all=true` 上限（S2-5/S3-7），一次 migration 解决。
7. **正则规则沙箱**（RE2 或 worker + 超时），消除单用户挂全实例的隐患。
