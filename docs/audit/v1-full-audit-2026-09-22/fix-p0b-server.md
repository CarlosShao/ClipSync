# P0-B「拆利用链」服务端修复记录

- 日期：2026-09-23
- 范围：仅 `src/server/**`（禁改文件 `routes/admin/configs.js`、`utils/sms.js` 均未触碰；本批没有任何修复需要动它们）
- 基线 commit：`00e212b`（P0-A）
- 测试基线：537 passed / 0 failed / 48 skipped（45 文件通过 | 3 跳过）

## 全量测试前后对比

| | 命令 | passed | failed | skipped | 文件 |
|---|---|---|---|---|---|
| 修复前（P0-A 基线） | `npx vitest run` | 537 | 0 | 48 | 45 通过 / 3 跳过 |
| 修复后（本批） | `npx vitest run` | **643** | **0** | 48 | 50 通过 / 3 跳过 |

+106 全部来自本批新增的 5 个测试文件，无既有用例被修改、无断言被削弱、无回归。
新增测试文件：
- `tests/ssrf-ip-guard.test.js`（修复 2）
- `tests/versions-cleanup-authz.test.js`（修复 3）
- `tests/ai-idor-and-tools.test.js`（修复 4 + 修复 8）
- `tests/shared-links-traversal.test.js`（修复 1）
- `tests/auth-session-revoke.test.js`（修复 5）

测试环境：`clipsync-db:5433` + `clipsync-redis:6380`（docker ps 确认后运行）。
迁移 `077_shared_links_file_key.sql` 已对测试库执行成功（`NODE_ENV=test node src/db/migrate.js`）。

## 修改/新增文件清单

| 文件 | 对应修复 |
|---|---|
| `src/server/src/routes/sharedLinks.js` | 修复 1（fileKey UUID 校验 + realpath 分量边界 + 删除走 file_key 重拼 + 下载边界校验 + 上传落盘名服务端生成） |
| `src/server/src/db/migrations/077_shared_links_file_key.sql` | 修复 1（新增 `shared_links.file_key` 列 + 安全回填） |
| `src/server/src/routes/aiTools.js` | 修复 8（find_duplicates/export_data 列名）、修复 6（HASH_SALT）、修复 1（delete_shared_link 复用 removeSharedLinkFiles） |
| `src/server/src/routes/media.js` | 修复 1 地毯排查（下载/text-preview/删除对 DB `content_encrypted` 补 isSafeStoredFilename 校验） |
| `src/server/src/utils/aiOcr.js` | 修复 1 地毯排查（resolveImageDataUrl 对 DB 文件名补校验） |
| `src/server/src/utils/aiProviders.js` | 修复 2（isPrivateIp 重写 + assertSafeUpstreamUrl fail-closed + safeUpstreamFetch 换 http/https + lookup 钩子） |
| `src/server/src/routes/aiProviders.js` | 修复 2（validateProviderBaseUrl 同口径：方括号剥离 + 多地址逐一校验） |
| `src/server/src/routes/versions.js` | 修复 3（cleanup 加 requireRole(50) + 参数下限校验） |
| `src/server/src/utils/versionManager.js` | 修复 3（数据访问层下限兜底，0/负数/NaN 不生效） |
| `src/server/src/routes/aiChatCore.js` | 修复 4（fetch/persistContextSummary SQL 层 user 过滤） |
| `src/server/src/routes/aiChat.js` | 修复 4（/chat 对 conversationId 归属校验，404） |
| `src/server/src/routes/auth-session.js` | 修复 5（改用共享 blacklistJti，删除手抄键名与过期 TODO 注释） |
| `src/server/src/routes/auth.js` | 修复 6（HASH_SALT 生产缺失 fail-fast） |
| `src/server/src/utils/encryption.js` | 修复 6（DEFAULT_KEYS 补 .env.test 加密密钥值） |
| `src/server/Dockerfile` | 修复 7（生产 stage 加 `ENV NODE_ENV=production`，builder stage 不加） |

---

## 修复 1（S0）：分享链接 fileKey 路径穿越

### 修复内容
1. **fileKey 强制 UUID 格式校验**（上传路径本就用 `uuidv4()` 生成，正常流程不受影响）。
2. **realpath + 按路径分量边界校验**：`path.relative(baseReal, real)` 判 `..`/绝对路径，不用字符串 `startsWith`（避免 `/uploads/shared2` 被误判在 `/uploads/shared` 内）。
3. **删除路径不再用 `path.dirname(file_path)` 反推**：新增 `shared_links.file_key` 列（迁移 077，回填仅接受 UUID 形态的父目录名），删除时用已校验的 file_key 重拼 `base/<uuid>`；无 file_key 的历史行仅当 `realpath(file_path)` 恰为 `base/<uuid>/<file>` 两层时才删 `<uuid>` 目录。`fs.rm` 目标在任何分支下都不可能是 `SHARED_UPLOAD_BASE` 本身或其祖先（单层 rel、越界 rel 一律跳过）。
4. **上传落盘名服务端生成**：原 `path.join(destDir, req.file.originalname)` 中 originalname 客户端可控（`../` 可逃出 destDir），改为 `uuid + 白名单扩展名`；展示名仍走原 file_name 字段（HTML 已转义、Content-Disposition 已编码）。
5. **公开下载**对库中 `file_path` 补 realpath 边界校验（防历史投毒行对外提供任意文件）。
6. `aiTools.js` 的 `delete_shared_link` 工具存在同一 `fs.rm(path.dirname(file_path))` 模式，改为复用 `removeSharedLinkFiles()`（与路由同一防线）。
7. **SHARED_TMP_DIR**：multer 落盘名为服务端 `uuidv4().shared.tmp`，失败清理只对 `req.file.path`（multer 自己生成）unlink，无用户可控拼接 → 无需修改。

### path.join 用户可控参数排查表（src/server/src 全量）

「来源」列：req = 请求体/参数直传；DB(可投毒) = 数据库记录但写入端是客户端 API；DB(服务端) = 仅服务端生成后入库。

| 位置 | 拼接参数 | 来源 | 原状 | 处置 |
|---|---|---|---|---|
| routes/sharedLinks.js 创建链接 `candidateDir` | fileKey | req.body | **无校验（S0 主洞）** | UUID 校验 + realpath 分量边界（已修） |
| routes/sharedLinks.js upload-file `destPath` | req.file.originalname | req(multipart) | **无校验，可逃出 destDir** | 落盘名改服务端生成（已修） |
| routes/sharedLinks.js DELETE `fs.rm(dirname(file_path))` | file_path | DB(可投毒，经由上一条) | **递归删除任意目录（S0 主洞）** | file_key 重拼 + 边界校验（已修，迁移 077） |
| routes/sharedLinks.js 公开下载 `sendFile(file_path)` | file_path | DB(可投毒) | 无边界校验 | realpath 边界校验（已修） |
| routes/aiTools.js:4236 delete_shared_link | file_path | DB(可投毒) | 同 `fs.rm(dirname)` 模式 | 复用 removeSharedLinkFiles（已修） |
| routes/media.js:809/814 下载 legacy 分支 | item.content_encrypted | DB(可投毒：POST /api/clipboard 直传) | **无校验**（同文件多文件分支已有 F1.3 校验，legacy 分支漏了） | isSafeStoredFilename（已修） |
| routes/media.js:1038 text-preview | storedName=content_encrypted | DB(可投毒) | 无校验（fileIndex 分支已有） | isSafeStoredFilename（已修） |
| routes/media.js:1132 DELETE unlink | item.content_encrypted | DB(可投毒) | 无校验（thumbnail 已有） | isSafeStoredFilename（已修） |
| utils/aiOcr.js:131 resolveImageDataUrl | contentEncrypted | DB(可投毒) | **无校验，可穿越读任意文件喂给 OCR 模型** | isSafeStoredFilename（已修） |
| routes/media.js:685/720、1026 多文件分支 | metadata.files[].fileId | DB(可投毒) | 已有 isSafeStoredFilename（F1.3） | 无需改 |
| routes/media.js:110/168/409 | filename=`uuid+ext` | DB(服务端生成) | 安全 | 无需改 |
| routes/chunked-upload.js:240 | uploadId | 服务端 uuidv4 | 安全 | 无需改 |
| routes/chunked-upload.js:296 | uploadId | req.params | 先 loadUploadSession(uploadId) 不存在即 404，穿越串无会话到不了 join | 无需改（见下注） |
| routes/chunked-upload.js:158 multer filename `${uploadId}_${chunkIndex}` | req.params | **审计 S1-4，明确不在本批**；与本批修复不共用代码段 | 未改（按任务口径留给对应批次） |
| routes/chunked-upload.js:434/471 finalFilename/finalTarget | session.filename→extname | extname 不含路径分隔符，finalFilename=uuid+ext | 安全 | 无需改 |
| utils/storage.js:34/41/46/50/62 | uploadId、ext | 调用链均在会话校验后；ext 来自 path.extname（不含分隔符） | 安全 | 无需改 |
| utils/storage.js:81 getFilePath(filename) | filename | 调用方传服务端生成名 | 安全 | 无需改 |
| routes/storage.js | — | 无任何 fs/path 拼接（纯配额查询） | 安全 | 无需改 |
| routes/invoices.js | — | 无文件路径拼接（PDF 内存生成，仅 DB 查询用 req.params.id 参数化） | 安全 | 无需改 |
| routes/aiTools.js:4159/4201 upload_image/upload_file | filenameUuid | 服务端 uuidv4 | 安全 | 无需改 |

注：GDPR 删号不删磁盘文件（S1-6）与 chunked-upload multer 文件名穿越（S1-4）按任务口径未处理；排查确认二者与本批修复不共用代码段。

---

## 修复 2（S0）：SSRF 防护被 IPv6 字面量绕过

### 修复内容（utils/aiProviders.js + routes/aiProviders.js）
- `isPrivateIp` 全部重写：先剥方括号、剥 zone（`%eth0`），用 `net.isIP()` 分流；手写解析（未引入新依赖，`ipaddr.js` 仅为 proxy-addr 的传递依赖、未在 package.json 声明，不使用）。
  - IPv4：0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.168/16、224/4 组播、240/4 保留+广播（含 255.255.255.255）、TEST-NET 1/2/3（加固）。
  - IPv6：`::`、`::1`、fe80::/10（位掩码，不再 startsWith）、fc00::/7、ff00::/8、100::/64、2001:db8::/32、**IPv4-mapped `::ffff:a.b.c.d`（解出内嵌 IPv4 按 v4 规则判）**、IPv4-compatible `::/96` 一律拒、6to4 `2002::/16` 与 Teredo `2001::/32` 解出内嵌 IPv4 判（Teredo 客户端段按位取反后判）。
  - **fail-closed**：空值 / null / 非 IP 字面量 / 解析失败一律返回 true（旧实现对垃圾输入返回 false = 放行）。
- `assertSafeUpstreamUrl`：内网判定 throw 不再与 DNS 失败混在同一 catch（旧实现被吞后放行）；主机名解析改为 `all:true` 逐地址校验；解析失败/空结果 → 抛错拒绝（fail-closed）。
- `routes/aiProviders.js` 的 `validateProviderBaseUrl`（保存供应商时的校验）同步修复：方括号剥离、`net.isIP` 分流、多地址逐一校验。
- `safeUpstreamFetch` 从全局 fetch 改为 `node:http/https` + **`lookup` 钩子在 TCP 连接建立时对 socket 实际使用的 IP 再判一次内网**。

### DNS rebinding 防护强度与残留缺口（如实说明）
- **强度**：校验发生在 `lookup` 回调内、就在连接使用该地址之前——「校验时解析一次、连接时再解析一次」的 TOCTOU 窗口被消除（每次连接用的就是被检查的那个地址）。重定向仍逐跳重走完整校验（aiTools web_fetch 手动跟随处原有逻辑不变）。
- **残留缺口**：
  1. `lookup` 钩子在 `all:true` 时校验全部返回地址，但单地址模式下只校验实际连接的那个——这是够的；不过 HTTP 连接池（keep-alive）复用既有 socket 时不会重走 lookup，若同一 hostname 的连接在校验后被复用给下一次请求，理论上不重新判定（复用前提是该 IP 曾通过校验，风险很低）。
  2. 未实现「把解析出的 IP 固定后直连 IP + Host/servername 保原域名」的最强形态（需 undici dispatcher 或自行管理 TLS SNI，代价过大）；当前形态在单次连接粒度上等价于 pinning。
  3. 响应体自动解压不再由 fetch 提供，改为显式 `accept-encoding: identity`；若某上游无视该头强发 gzip，调用方会拿到压缩字节（行为差异，非安全缺口）。

### SSRF 测试用例清单与结果（tests/ssrf-ip-guard.test.js，85 例全过，含修复3/5文件同批）

isPrivateIp 应拦截（全部通过）：
`127.0.0.1`、`127.255.255.254`、`10.0.0.1`、`10.255.255.255`、`172.16.0.1`、`172.31.255.255`、`192.168.0.1`、`192.168.255.255`、`169.254.169.254`、`169.254.0.1`、`0.0.0.0`、`0.1.2.3`、`100.64.0.1`、`100.127.255.255`、`224.0.0.1`、`239.255.255.255`、`240.0.0.1`、`255.255.255.255`、`[::1]`、`::1`、`[::]`、`::`、`[::ffff:a9fe:a9fe]`、`::ffff:a9fe:a9fe`、`[::ffff:127.0.0.1]`、`::ffff:127.0.0.1`、`::ffff:10.0.0.1`、`::127.0.0.1`、`fe80::1`、`[fe80::1]`、`febf:ffff::1`、`fc00::1`、`fd12:3456::1`、`ff02::1`、`fe80::1%eth0`、`2002:7f00:0001::1`（6to4 内嵌 127.0.0.1）、`2001:0000:4136:e378:8000:63bf:3fff:fdd1`（Teredo）、`100::1`、`2001:db8::1`

isPrivateIp 应放行（正向用例，防把功能修死，全部通过）：
`8.8.8.8`、`1.1.1.1`、`93.184.216.34`、`172.32.0.1`、`172.15.0.1`、`100.128.0.1`、`192.169.0.1`、`11.0.0.1`、`[2606:4700:4700::1111]`、`2606:4700:4700::1111`、`2001:4860:4860::8888`、`[::ffff:8.8.8.8]`、`fec0::1`、`2002:0808:0808::1`

fail-closed：`localhost`、`not-an-ip`、`''`、`null`、`undefined`、`999.1.1.1` → 全部 true。

assertSafeUpstreamUrl 拒绝：`http://[::1]:8080/x`、`http://[::ffff:a9fe:a9fe]/latest/meta-data/`、`http://[::ffff:127.0.0.1]/`、`http://169.254.169.254/...`、`http://127.0.0.1:6379/`、`http://0.0.0.0/`、`http://100.64.0.1/`、`http://localhost:3000/`、`http://metadata.google.internal/`、`*.internal`、`*.local`、`*.svc`、`ftp://`、`file://`；
放行：`http://8.8.8.8/v1`、`https://[2606:4700:4700::1111]/v1`；
DNS 打桩：多地址含内网 → 拒；公网 → 放；解析失败 → 拒（fail-closed，旧实现此处放行）；空结果 → 拒。
safeUpstreamFetch：内网字面量建连前即拒（DNS 未被调用）；rebinding 域名（DNS 打桩返回 10.0.0.8）→ 拒。

---

## 修复 3（S0）：POST /api/versions/cleanup 全库清空

### 调用者排查
`grep -rn "versions/cleanup" src/desktop/src src/mobile/lib src/admin-console` → **零命中**。无任何用户侧调用者，确认这是纯运维操作。

### 选择与实现
按任务口径走「管理员鉴权」分支：路由链首加 `requireRole(50)`（与 `routes/admin/index.js:56` 同口径；挂载链 `index.js` 已含 authenticateToken，req.user.roleLevel 可用）。同时：
- 路由层参数校验：`retentionDays`/`maxVersionsPerItem` 必须为 ≥1 的数值，否则 400（`{retentionDays:0, maxVersionsPerItem:0}` 攻击载荷直接拒绝且不触达 DELETE）。
- 数据访问层兜底（versionManager.js）：`Math.max(1, Math.floor(Number(x)) || 默认值)`，0/负数/NaN 在任何调用点都不可能生效。
- 未选择「加 user_id 过滤」方案：既然无用户侧调用者，语义保持"管理员全库运维清理"，避免发明一个不存在的产品功能。

---

## 修复 4（S0）：AI 会话 conversationId 跨用户 IDOR

### 修复内容
- `fetchLatestContextSummary(conversationId, userId)` / `persistContextSummary(conversationId, summary, userId)`：**归属过滤落在 SQL 层**（JOIN / WHERE EXISTS `ai_conversations.user_id`），缺 userId 时 fail-closed 不读不写；persist 用 `INSERT ... SELECT ... WHERE EXISTS`，他人会话零行插入并返回 false。全部调用点（runChatLoop、compressConversationHistory）已传 userId，全仓无其他调用点。
- `POST /api/ai/chat` 路由层：conversationId 非 UUID 或不属于当前用户 → **404**（不返回 403，避免泄漏资源存在性），且在 SSE 头发出前返回 JSON。

### AI 模块 IDOR 归属校验排查表

| 文件/端点 | ID 参数 | 归属过滤 | 结论 |
|---|---|---|---|
| aiChatCore.js fetchLatestContextSummary | conversationId | 原无 → **已加 SQL 层 user_id JOIN** | 已修 |
| aiChatCore.js persistContextSummary | conversationId | 原无 → **已加 WHERE EXISTS user_id** | 已修 |
| aiChatCore.js manualCompactConversation | conversationId | 已有（:87-93 校验 user_id，404 语义） | OK |
| aiChat.js POST /chat | options.conversationId | 原无 → **已加路由层 404 校验** + 数据层双保险 | 已修 |
| aiChat.js /summarize /similarity /suggest /refactor-prompt | 无会话 ID（provider 经 resolveUserProvider 按 user 解析） | OK |
| aiChat.js /chat/approve、/chat/respond_ask_user | requestId | pending 项记录 userId，approveToolRequest/respondAskUserRequest 内部校验（既有） | OK |
| aiConversations.js GET / 、GET /search、GET/PUT/DELETE /:id、POST /:id/compact、POST /:id/messages | id | 全部 `user_id = $` 过滤（含 compact 先验归属、messages 先验归属） | OK |
| aiConversations.js updateConversationUsage | id+userId | `WHERE id=$10 AND user_id=$11` | OK |
| aiMemories.js GET/POST/PUT/DELETE | memoryId(:id) | PUT/DELETE 先 `SELECT id ... WHERE id=$1 AND user_id=$2`，UPDATE/DELETE 语句本身也带 user_id | OK |
| aiInline.js / aiSettings.js / aiOrchestrator.js / aiStream.js | 无按 ID 取他人资源的查询（settings 按 req.userId；orchestrator 继承 /chat 的 userId） | OK |
| aiProviders.js（routes）provider :id | providerId | 查询均带 user_id（抽查 CRUD 语句） | OK |

---

## 修复 5（S1）：会话吊销写错 Redis 键前缀

### jti 与 sessionId 的关系（结论：单改前缀语义即可，标识符本身是对的）
JWT 签发处全部为 `jti: sessionId`：`routes/auth.js`（createSessionAndGenerateToken）、`routes/auth-password.js:32`、`routes/auth-verify.js:35`、`routes/auth-refresh.js:58`（刷新复用同一 sessionId 作 jti）；`utils/redis-client.js:222` 注释亦明确 `bl:{jti} (jti === sessionId)`。因此 `auth-session.js` 里的 `sessionId` 参数（user_sessions.id）**就是**要吊销的 jti——bug 纯粹是键前缀写错（`blacklist:` vs 全仓读取的 `bl:`）+ 手写键名。

### 修复内容
- `DELETE /sessions/:sessionId` 改用共享 `blacklistJti(sessionId, parseDurationToSeconds(config.jwt.expiresIn))`（与 `routes/sessions.js` 同一封装、同一 TTL 口径），不再手写键名；删除过期 TODO 注释；移除不再使用的 `getRedisClient` 导入。
- 未触碰 `ws/server.js`（无需触碰：它读 `bl:{jti}`，修复后写入端与其对齐）。
- 同文件 `POST /logout`（死代码，被 auth.js 遮蔽）未动——P0-A 已把它的键修好，删除死代码不在本批范围。
- 测试直接调用路由 handler（绕过 NODE_ENV=test 鉴权旁路）+ 真实 Redis：吊销后 `isJtiBlacklisted(sessionId)===true`、旧键 `blacklist:{sessionId}` 不再存在、他人会话 404 且不写黑名单。

---

## 修复 6（S1）：硬编码盐兜底

### 盐的用途与影响面（结论：参与存量数据派生，不可静默变更，无需本批数据迁移）
`HASH_SALT = ENCRYPTION_KEY.substring(0,16) || 'CLIPSYNC_SALT_2026'` 用于 `computeFieldHash()` → **users.phone_hash / email_hash**（登录、找回密码的 O(1) 哈希查询）。存量影响：
1. 迁移 `006_phone_email_hash.sql` 曾按**字面量盐**回填过存量行；而运行时只要 ENCRYPTION_KEY 存在就用**派生盐**。两者本就不一致（既有问题，auth.js:396-420 有"哈希未命中→明文兜底查询→懒回填"路径自愈，不构成本批回归）。
2. 生产环境：P0-A 的 config.js fail-fast 已把 ENCRYPTION_KEY 列入安全关键清单（缺失/已知默认值拒绝启动），且 auth.js/aiTools.js 均 import config.js——生产上兜底盐实际不可达。本批再加**模块加载期双保险**：`NODE_ENV==='production'` 且 ENCRYPTION_KEY 缺失 → throw 拒绝启动；**非生产保留原兜底**，避免既有 dev/老数据的哈希静默失配。
3. 是否需要数据迁移：**不需要由本批触发**。真实迁移决策点是「生产是否曾在 ENCRYPTION_KEY 缺失下运行过」（若是，则库中存在字面量盐派生的 phone_hash，需按 006 的懒回填机制自然收敛或一次性重算）——按任务要求上报，由 owner 决定。
4. `db/migrations/006_phone_email_hash.sql` 中的字面量盐未动（SQL 迁移不可改写历史）。

### DEFAULT_KEYS 补齐
`utils/encryption.js` 的 `DEFAULT_KEYS` 补入 `.env.test` 中 ENCRYPTION_KEY 的值（该值与 P0-A 已提交在 `config.js` INSECURE_ENCRYPTION_KEYS 中的条目相同，是公开模板占位值；本报告不复制任何真实密钥）。已程序化验证：.env.test 的 ENCRYPTION_KEY 命中新黑名单、且此前不在旧黑名单中。

---

## 修复 7（S1）：Dockerfile 未设 NODE_ENV

- 生产 stage（第二个 `FROM node:22-alpine`）加 `ENV NODE_ENV=production`；**builder stage 不加**（docker-compose.dev.yml 直接跑 builder 目标，设成 production 会破坏 dev）。
- 该镜像为多阶段构建，确认后仅改 runtime stage。
- `k8s/`（只读检查，未改）：`k8s/base/configmap.yaml:10` 与 `namespace-config-pvc.yaml:19` 设了 `NODE_ENV: "production"`；`overlays/production/kustomization.yaml:116` 也设了。**注意**：`overlays/staging/kustomization.yaml:156` 设的是 `NODE_ENV=staging`——不在 config.js 的 envConfigs 映射内，会落到 development 配置，且所有 `=== 'production'` 安全判定（含验证码固定码 888888）在 staging 全部按非生产放行。k8s 目录疑似废弃（审计 S3），未改，上报供决策。

---

## 修复 8（S1）：aiTools find_duplicates / export_data 引用不存在的列

### 真实 schema 核对（migrate.js 建表 + 014/031/036/075 迁移）
`clipboard_items` 实有列：id, user_id, source_device_id, **content_type**, **content_encrypted**, content_preview, content_size, metadata, is_favorite, expires_at, created_at, updated_at, content_hash(014), image_hash(031), protection_level(036), content_diff(075)。**无 `type`、无 `content`、无 `is_archived`**（全库也无归档列，归档语义在 favorites/archive 侧）。

### 选择：修列名 + 摘掉不存在的谓词（不摘工具）
- `c.type` → `c.content_type AS type`、`c.content` → `c.content_encrypted AS content`（别名保持下游代码不动）；
- `c.is_archived = FALSE` 谓词**直接删除**——表里没有归档概念，按任务口径不硬凑列；两个工具的核心语义（查重/导出）与归档无关，故不摘工具本身；
- `protection_level` 过滤保留（列真实存在，且高级保护条目本就禁止 AI 通道读取明文）；
- 解密兜底：`content_encrypted` 解密失败时按原文使用（审计 E1：E2E 关闭时该字段实为明文；导出/查重仅涉及**本人**数据，`user_id=$1` 过滤在，无跨用户泄漏面；advanced 保护条目已被 protection_level 谓词排除，不会把受保护内容带出去）。

### 测试
`tests/ai-idor-and-tools.test.js` B 组：真实 DB 建用户/设备/条目（密文形态 + 明文形态各若干），`executeTool('find_duplicates')` 与 `executeTool('export_data', json/csv)` 均跑通、无 SQL 错误、查重分组与导出内容断言通过（此前两工具零覆盖、每次调用必报 `column c.type does not exist`）。

---

## 顺带发现但未改（不在本批范围）

1. `k8s/overlays/staging` 的 `NODE_ENV=staging` 使 staging 环境按 development 配置运行（详见修复 7）。
2. `db/migrations` 存在 `031` 双前缀（P0-A 已按完整文件名幂等，运行仅告警，两文件都会执行）。
3. `chunked-upload.js:158` multer filename `${uploadId}_${chunkIndex}`（审计 S1-4，独立代码段，未与本批共用）。
4. `auth-session.js` 的 `POST /logout` 为死代码（被 auth.js:1879 遮蔽），建议后续批次删除。
5. `shared_links.file_path` 历史投毒行：迁移 077 只回填可解析出 UUID 父目录的行；解析不出的行 file_key 为 NULL，代码对其"跳过文件删除 + 下载 404"，数据本身保留（未做物理清理，避免误删）。
6. 安全 keep-alive 连接复用时不重走 lookup 校验（低风险，详见修复 2 残留缺口）。
