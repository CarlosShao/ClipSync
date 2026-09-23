# 跨端契约一致性 审计

- 审计日期：2026-09-22
- 范围：桌面端（Tauri2+Vue3，`src/desktop`）、移动端（Flutter + 原生 Kotlin 前台服务，`src/mobile`）、管理台（React，`src/admin-console`）、官网（`src/website`）↔ 后端（Express，`src/server`，38 个路由文件 + `ws/server.js`）
- 方法：后端路由全集枚举 → 四端调用点全集枚举 → 9 维度交叉比对（孤儿端点 / 幽灵调用 / 字段名 / 响应结构 / 时间戳 / 枚举 / 上限 / WS 协议 / shared 层真实性）→ 版本兼容
- 排除项：已读 `docs/audit/external-dependency-audit-2026-09-09.md` 与 `docs/production-roadmap/external-dependencies.md`。短信/邮件/OAuth/CAPTCHA/支付渠道/推送通道等外部依赖本身不计问题；「后端有能力、前端摆入口、点了没反应且无说明」按产品诚信问题单列。
- 纪律：只读审计，未改任何源码；未跑测试/构建/服务。

## 结论（≤3 句）

四端在**核心同步链路**（POST /api/clipboard、/api/media/*、WS register/ping/new_clipboard/clipboard_deleted、列表分页 `{items,pagination}`、时间戳 ISO-8601 UTC）上契约基本一致，没有发现秒/毫秒级时间戳错乱这类大面积静默数据错乱。但存在 **1 个 S0**（Android 原生远程拉取把 E2E 密文当明文写回手机系统剪贴板）、**5 个 S1 幽灵调用/断链**（`/api/app/maintenance` 双端幽灵、收藏标签创建/重命名必失败、管理台 SSO 兑换端点不存在、发行版客户端默认后端地址是 localhost），以及移动端对 `clipboard_updated`/通知类 WS 消息**无处理分支的静默丢弃**。按现状可以「桌面+移动明文模式」灰度，但 **E2E、SSO、标签管理、维护模式初始快照、移动端错误可见性** 五处必须修完才算能上 v1。

---

## 后端 API 全集

挂载关系取自 `src/server/src/index.js:393-554`；admin 子挂载取自 `src/server/src/routes/admin/index.js:117-166`。
鉴权图例：**匿名** = 无需登录；**B** = Bearer JWT（多数还挂 csrfProtection，但 Bearer 头自动放行 CSRF，见 `middleware/csrf.js:154-159`）；**A** = Bearer + requireRole(50) + requirePerm；**验签** = 支付渠道回调。
调用方图例：✓ 有调用；✗ 无调用（孤儿）；☠ 客户端有封装函数但零调用点（死封装）。

### 用户侧路由

| METHOD 路径 | 鉴权 | 定义位置 | 桌面 | 移动 | 管理台 |
|---|---|---|---|---|---|
| POST /api/auth/send-code | 匿名+限流 | routes/auth.js:158（auth-verify.js:50 同路径被遮蔽） | ✓ | ✓ | ✓ |
| POST /api/auth/send-email-code | 匿名 | routes/auth.js:210 | ✓ | ✗ | ✗ |
| POST /api/auth/verify-code | 匿名 | routes/auth.js:259 | ✓ | ✓ | ✓ |
| POST /api/auth/verify-email-code | 匿名 | routes/auth.js:498 | ✓ | ✗ | ✗ |
| POST /api/auth/accept-tos | B | routes/auth.js:712 | ✓ | ✗ | ✗ |
| POST /api/auth/forgot-password | 匿名 | routes/auth.js:748 | ✓ | ✗ | ✗ |
| POST /api/auth/reset-password | 匿名 | routes/auth.js:813 | ✓ | ✗ | ✗ |
| POST /api/auth/register | 匿名+flag | routes/auth.js:901 | ✓ | ✗ | ✗ |
| POST /api/auth/set-password | 匿名 | routes/auth.js:1044 | ✓ | ✗ | ✗ |
| POST /api/auth/login | 匿名 | routes/auth.js:1130（auth-password.js:139 被遮蔽） | ✓ | ✗(用验证码登录) | ✓ |
| GET /api/auth/me | B | routes/auth.js:1286 | ✓ | ✓ | ✗ |
| PUT /api/auth/profile | B | routes/auth.js:1338 | ✓ | ✓ | ✗ |
| DELETE /api/auth/account | B | routes/auth.js:1392 | ✓ | ✗ | ✗ |
| GET /api/auth/export-data | B+限流 | routes/auth.js:1463 | ✓ | ✗ | ✗ |
| PUT /api/auth/deactivate / reactivate / consent | B | routes/auth.js:1586/1668/1717 | ✓ | ✗ | ✗ |
| POST /api/auth/change-password | B | routes/auth.js:1783 | ✓ | ✗ | ✗ |
| POST /api/auth/logout | B | routes/auth.js:1833（auth-session.js:70 被遮蔽） | ✓ | ✓ | ✗ |
| POST /api/auth/send-reset-pin-code / send-reset-pin-email-code / reset-pin | 匿名 | routes/auth-verify.js:346/386/418（未被遮蔽） | ✓ | ✗ | ✗ |
| POST /api/auth/refresh | 匿名+限流 | routes/auth-refresh.js:16 | ✓ | ✓ | ✓(但契约错，见 S2-1) |
| GET/DELETE /api/auth/sessions[/:sessionId] | B | routes/auth-session.js:13/33 | ✓ | ✓(走 /api/sessions) | ✗ |
| GET /api/auth/2fa/status；POST 2fa/setup·enable·disable | B(+flag) | routes/two-factor.js | ✓ | ✗ | ✗ |
| POST /api/auth/2fa/verify-login | 匿名 | routes/two-factor.js | ✓ | ✓ | ✗ |
| GET /api/csrf-token | B | index.js:140 | ✓ | ✗(Bearer 免 CSRF) | ✗(发 placeholder) |
| POST /api/devices/pairing/init | B | routes/device.js:32 | ✓ | ✗ | ✗ |
| POST /api/devices/pairing/redeem | 匿名 | routes/device.js:56 | ✓ | ✗（移动端无扫码入口，见 S2-5） | ✗ |
| GET /api/devices | B | routes/device.js:159 | ✓ | ✓(Dart+采集公钥表) | ✗ |
| POST /api/devices | B+设备数限制 | routes/device.js:179 | ✓ | ✓(Dart auth_provider.dart:306) | ✗ |
| PUT /api/devices/:deviceId | B | routes/device.js:252 | ✓(公钥上报 clipboardUpload.ts:295) | ✗ | ✗ |
| DELETE /api/devices/:deviceId | B | routes/device.js:307 | ✓ | ✓ | ✗ |
| GET /api/ws/csrf-token | B | routes/ws.js:12 | ✓ | ✓ | ✗ |
| GET /api/clipboard | B | routes/clipboard.js:53 | ✓ | ✓(Dart+原生 Kotlin) | ✗ |
| GET /api/clipboard/search | B | routes/clipboard.js:213 | ✗ | ✗ | ✗（孤儿） |
| GET /api/clipboard/frequent | B | routes/clipboard.js:308 | ✓ | ✗ | ✗ |
| GET /api/clipboard/sync-deletions | B | routes/clipboard.js:341 | ✓ | ✗ | ✗ |
| GET /api/clipboard/stats | B | routes/clipboard.js:372（**401 行重复定义，第二个死**） | ✓ | ✗ | ✗ |
| GET /api/clipboard/:id | B | routes/clipboard.js:430 | ✓ | ✗ | ✗ |
| POST /api/clipboard/:id/use | B | routes/clipboard.js:476 | ✓ | ✗ | ✗ |
| GET /api/clipboard/:id/content | B | routes/clipboard.js:500 | ✓ | ✓(Dart+原生) | ✗ |
| POST /api/clipboard | B+幂等+配额 | routes/clipboard.js:528 | ✓ | ✓(Dart+原生 NativeClipboardUploader.kt:44) | ✗ |
| PUT /api/clipboard/:id/favorite·sensitive·pinned | B | routes/clipboard.js:787/833/859 | ✓ | ✓(favorite/pinned) | ✗ |
| PUT /api/clipboard/:id | B | routes/clipboard.js:890 | ✓ | ✓ | ✗ |
| DELETE /api/clipboard/:id；DELETE /api/clipboard（批量 ids） | B | routes/clipboard.js:1045/1093 | ✓ | ✓ | ✗ |
| GET /api/clipboard/sync/:deviceId | B | routes/clipboard.js:1136 | ✗ | ✗ | ✗（孤儿） |
| POST /api/media/image | B+幂等，multer 20MB | routes/media.js:141 | ✓ | ✓(Dart+原生 SyncForegroundService.kt:1379) | ✗ |
| POST /api/media/file | B+幂等，multer 1GB+套餐配额 | routes/media.js:320 | ✓ | ✓ | ✗ |
| GET /api/media/:id/download·preview·text-preview | B | routes/media.js:646/832/969 | ✓ | ✓(download/preview) | ✗ |
| DELETE /api/media/:id | B | routes/media.js:1098 | ✓ | ✗ | ✗ |
| GET /api/storage/usage | B | routes/storage.js | ✗ | ✗ | ✗（孤儿，桌面用 /subscriptions/current.storageUsedMb） |
| POST /api/sync/push；GET /api/sync/pull/:deviceId；GET /api/sync/status/:deviceId | B | routes/sync.js:22/239/334 | ✗ | ☠(api_service.dart:306/323 封装存在、零调用点) | ✗（整个离线增量同步子系统孤儿） |
| POST /api/upload/init·chunk/:uploadId/:chunkIndex·complete/:uploadId；GET status/:uploadId；DELETE cancel/:uploadId | B，chunk 12MB | routes/chunked-upload.js:171/259/401/357/612 | ✓ | ✗ | ✗ |
| POST /api/versions；GET /api/versions/:clipboardItemId；GET detail/:versionId；POST restore/:versionId；GET stats/overview；POST cleanup | B | routes/versions.js | 部分✓（仅 GET /:id + restore，VersionHistoryModal.vue:26/40；其余 4 个孤儿） | ✗ | ✗ |
| GET /api/app/feature-flags | 匿名 | routes/app.js:29 | ✓ | ✓ | ✗ |
| GET /api/app/policies | optionalAuth | routes/app.js:45 | ✓ | ✗（移动端不消费策略） | ✗ |
| GET /api/app/version | 匿名 | routes/app.js:115 | ✓ | ✗ | ✗ |
| GET /api/app/announcements；POST /api/app/announcements/:id/read | optionalAuth / B | routes/app.js:167/230 | ✓ | ✓ | ✗ |
| GET /api/app/updates/latest | 匿名 | routes/app.js:265 | ✓(Tauri updater, tauri.conf.json:53) | ✗ | ✗ |
| GET /api/app/update.json | 匿名 | routes/app.js:322 | ✗（旧客户端兼容保留） | ✗ | ✗ |
| GET/DELETE /api/sessions[/:sessionId]、DELETE /api/sessions（全部） | B | routes/sessions.js | ✓ | ✓(含全登出 api_service.dart:483) | ✗ |
| GET/PUT /api/notifications/preferences；GET /history；PUT /history/:id/read | B | routes/notifications.js:17/31/56/76 | ✓ | ✓ | ✗ |
| GET /api/subscriptions/plans | 匿名 | routes/subscriptions.js:15 | ✓ | ✓ | ✗ |
| GET /api/subscriptions/current | B | routes/subscriptions.js:~60 | ✓ | ✓ | ✗ |
| POST /api/subscriptions/subscribe | B | routes/subscriptions.js:144 | ✓ | ✗ | ✗ |
| POST /api/subscriptions/start-trial | B | routes/subscriptions.js:~301 | ✗ | ✗ | ✗（孤儿＝试用功能无入口） |
| POST /api/subscriptions/cancel·resume | B | routes/subscriptions.js | ✓ | ✓ | ✗ |
| POST /api/webhooks/alipay·stripe | 渠道验签 | routes/paymentWebhooks.js | n/a（渠道服务器调用） | — | — |
| POST /api/payments/create-order；GET order/:orderNo/status | B | routes/payments.js | ✓ | ✗ | ✗ |
| POST /api/payments/refund；GET reconciliation | B | routes/payments.js | ✗（payment.ts:70 注释明确弃用） | ✗ | ✗（孤儿） |
| POST /api/payments/refund-request；GET refundable-orders·refund-requests/mine | B | routes/payments.js | ✓ | ✗ | ✗ |
| GET /api/invoices；GET /api/invoices/:id/download | B | routes/invoices.js:62/265 | ✓ | ✓(list) | ✗ |
| GET /api/invoices/:id | B | routes/invoices.js:306 | ✗ | ✗ | ✗（孤儿） |
| POST /api/surveys | B | routes/surveys.js | ✓(SatisfactionSurvey.vue:55) | ✗ | ✗ |
| GET /api/surveys/stats·my | B | routes/surveys.js | ✗ | ✗ | ✗（孤儿＝调查只收不看） |
| /api/favorites/collections 全套 CRUD+reorder+move+items | B | routes/favorites.js:15-352 | ✓ | ✓ | ✗ |
| PUT /api/favorites/:id/tags；GET /tags；DELETE /tags/:tag；POST /migrate-hierarchy | B | routes/favorites.js:381/425/475/501 | ✓ | ✗ | ✗ |
| **POST /api/favorites/tags、PUT /api/favorites/tags/:tag** | — | **后端不存在** | 桌面在调（幽灵，见 S1-3） | — | — |
| POST /api/protection/setup·unlock·recovery·rotate-password·remove；GET status/:itemId | B | routes/protection.js | ✓ | ✓(unlock/status) | ✗ |
| /api/templates CRUD；/api/template-variables GET/PUT/DELETE | B | routes/templates.js、templateVariables.js | ✓ | ✓ | ✗ |
| /api/search-history GET/POST/DELETE(/:id) | B | routes/searchHistory.js | ✓ | ✓ | ✗ |
| /api/ai/providers·presets·context·chat(SSE)·summarize·suggest·refactor-prompt·chat/approve·chat/respond_ask_user | B+flag | routes/aiProviders.js:73-331、aiChat.js:25-881 | ✓ | ✗ | ✗ |
| POST /api/ai/similarity | B+flag | routes/aiChat.js:393 | ✗ | ✗ | ✗（孤儿） |
| /api/ai/conversations（含 search/compact/messages）、/api/ai/inline、/api/ai/memories、/api/ai/settings(含 search-test) | B+flag | routes/aiConversations.js、aiInline.js、aiMemories.js、aiSettings.js | ✓ | ✗ | ✗ |
| /api/workflow-rules CRUD+toggle | B | routes/workflowRules.js | ✓ | ✗ | ✗ |
| /api/shared-links POST/GET/DELETE、upload-file、public/:token(+/download) | B / 公开取用 | routes/sharedLinks.js | ✓ | ✓ | ✗ |
| GET /api/health、/api/ready、/api/metrics(+/prometheus) | 匿名 / METRICS_TOKEN | index.js:272/281/377/381 | ✗ | ✗ | ✗（运维探针） |
| **routes/health.js、routes/metrics.js 整文件未挂载**（index.js 内联实现替代；utils/route-loader.js 无消费方） | — | — | — | — | — |

### 管理台路由（/api/admin，全链 authenticateToken→requireRole(50)→superAdminAudit，admin/index.js:56）

管理台客户端调用与后端**逐条对齐**（`src/admin-console/src/api/*.ts` 全部路径均能在 `routes/admin/*` 找到定义），响应壳 `{code:0,data}` 与拦截器（client.ts:103-117）匹配，分页 `{list,total,page,pageSize}` 两端一致。例外与孤儿：

| METHOD 路径 | 定义位置 | 管理台调用 | 备注 |
|---|---|---|---|
| GET /whoami、GET /overview、GET /slow-queries、POST /sso/token | admin/index.js:95/117/170/193 | ✓ | /sso/token 的消费方是**桌面端** AppSidebar.vue:164 |
| /users GET·:id·status·approve·force-logout·DELETE·export | admin/users.js:320-904 | ✓ | — |
| **PATCH /users/:id/role**（users.js:618）、**POST /users/:id/reset-2fa**（users.js:768） | — | **✗ 孤儿** | 后端做完、管理台没接线（无法改用户角色/重置用户 2FA） |
| /devices、/devices/stats、/:id/keys、/:id/offline | admin/devices.js | ✓ | — |
| /orders、/:orderNo、/:orderNo/refund、/reconciliation | admin/orders.js:193-412 | ✓ | — |
| /refund-reviews、/refund-settings、/subscriptions(+stats/grant)、/plans | admin/*.js | ✓ | — |
| /audit-logs、/roles、/permissions、/configs(+smtp/sms test)、/flags、/announcements、/policies | admin/*.js | ✓ | — |
| /ops（overview/backups/actions/alerts/storage/cleanup/backups/download）、/email-channels、/sessions、/ai-providers、/releases | admin/*.js | ✓ | — |
| **POST /api/auth/sso-exchange** | **后端不存在**（仅 admin/index.js:192 注释提及） | 管理台在调（幽灵，见 S1-2） | — |

### 官网

`src/website/src` 共 ~186 行 TS：**零后端调用**（无 fetch/axios）。下载链接硬编码 `https://www.clipchain.top/downloads/...`（data/download-links.ts:25,40），mac/linux/android 为 `'#'` 占位并诚实置灰「即将开放」——与后端 `utils/releaseArtifacts.js` 的下载地址解析（app.js update.json 用）是**两套独立来源**，存在漂移风险（S3-6）。

---

## WebSocket 消息类型全集

服务端 WS：`ws/server.js`，path `/ws`，握手 `?token=&csrf_token=`。心跳双轨：服务端协议层 `ws.ping()` 每 30s、5s 无 pong terminate（ws/server.js:415-435，config/production.js:38-39）；客户端另发 JSON `{type:'ping'}`（桌面 25s、移动 30s），服务端回 `{type:'pong'}`（ws/server.js:354-355）。**两轨匹配**：浏览器/`web_socket_channel` 会自动回协议层 pong 帧，JSON ping/pong 也两端成对——心跳无失配。

### 客户端 → 服务端（服务端接受的类型）

| type | 服务端处理位置 | 桌面发送 | 移动发送 |
|---|---|---|---|
| register | ws/server.js:267（校验设备归属+5 连接上限，回 registered） | ✓ useWebSocket.ts:98 | ✓ ws_service.dart:179 |
| clipboard | ws/server.js:323（转发同用户其他设备，timestamp=**epoch ms**） | ✗ | ✗（**死分支**，无任何客户端发） |
| ping | ws/server.js:354 | ✓ :170 | ✓ :199 |
| 其他 | ws/server.js:366 default → 回 `{type:'error'}` | — | — |

### 服务端 → 客户端

| type | 服务端发出位置 | 桌面处理 | 移动处理 |
|---|---|---|---|
| registered | ws/server.js:319 | ✓ HomeView.vue:507（触发 syncDeletions+refresh 补齐断线窗口） | ✓ ws_service.dart:205（**但无墓碑补齐**，靠整表刷新兜底） |
| pong | ws/server.js:355 | ✓ | ✓ |
| error | ws/server.js:259/270/281/288/367/371 | ✓（Device not found 自愈 useWebSocket.ts:129） | ✓（仅 print） |
| new_clipboard（`item` 单数） | clipboard.js:734、media.js:218/495、chunked-upload.js:581 | ✓ HomeView.vue:464 | ✓ ws_service.dart:214 + main.dart:326 |
| new_clipboard（`items` **复数**） | sync.js:206 | ✗ 读 `data.item` → undefined（该端点无人调用，死路径，见 S3-1） | ✗ 同 |
| clipboard_updated | clipboard.js:876/1037 | ✓ HomeView.vue:501 | **✗ 无分支，静默丢弃**（S2-2） |
| clipboard_favorite | clipboard.js:821 | ✓ | ✓ ws_service.dart:227 |
| clipboard_deleted（itemId / itemIds） | clipboard.js:1082/1125、media.js:1139 | ✓（refresh） | ✓ 两种都处理 ws_service.dart:219-226 |
| device_removed | device.js:327 | **✗ 静默丢弃** | **✗ 静默丢弃**（S3-4） |
| force_logout | ws/server.js:20 | ✓ HomeView.vue:527 | ✓ ws_service.dart:242（含防重连标记） |
| notification | ws/server.js:512（sendNotification） | ✓ HomeView.vue:538 | **✗ 静默丢弃**（S2-2） |
| server_shutdown | ws/server.js:602（timestamp=epoch ms） | ✗（靠 onclose 重连兜底） | ✗（同） |
| maintenance.updated | admin/configs.js:469 | ✓ HomeView.vue:523 | ✓ ws_service.dart:237 |
| feature_flags.updated | admin/configs.js:707 | ✓ | ✓ |
| policies.updated | admin/policies.js:105 | ✓ HomeView.vue:519 | ✗（移动端根本不消费 policies） |
| announcement.new | admin/announcements.js:178 | ✓ HomeView.vue:534 | ✗（启动拉取兜底） |

重连补齐机制：桌面 `registered` → `GET /api/clipboard/sync-deletions?since=<ISO 游标>`（墓碑，5s 回拨余量，clipboardLoad.ts:71-101）+ refresh，与服务端契约匹配。移动端无墓碑机制，但列表本身是服务端整表分页拉取，删除自然收敛——**可接受，非缺陷**。

---

## 问题清单（按严重度从高到低）

### [S0] Android 原生远程拉取把 E2E 密文当明文写回手机系统剪贴板（静默数据错乱）

- 后端证据：`src/server/src/routes/clipboard.js:500-521` — `GET /:id/content` 返回 `{ contentEncrypted: result.rows[0].content_encrypted, ... }`；E2E 开启时该列存的是信封密文（clipboard.js:576-604 校验 `metadata.e2e` 后原样落库），列表响应的 `contentPreview` 为 `'[E2E]'` 占位（mobile clipboard_capture.dart:460 注释同证）。
- 客户端证据：`src/mobile/android/app/src/main/kotlin/com/clipsync/clipsync_mobile/SyncForegroundService.kt:851-866` — `"text", "link" -> { val content = fetchRemoteItemContent(baseUrl, token, itemId) ... cm?.setPrimaryClip(ClipData.newPlainText("clipsync", content)) }`；`fetchRemoteItemContent`（:885-895）直接返回 `obj.optString("contentEncrypted")`。整个 Kotlin 层 `grep -rn "e2e" *.kt` **零命中**——无 `metadata.e2e` 判定、无解密能力。
- 失败场景（**静默失败**）：用户开启端到端加密（B6/B9 特性），在 PC 复制一段文字 → 手机引擎被冻结/后台时由原生前台服务轮询拉取 → 手机系统剪贴板被写入一大段 base64 密文。用户在手机任意 App 粘贴，得到乱码，**无任何报错**；Dart WS 路径（main.dart B10 有解密）与原生路径行为分裂，时灵时不灵。
- 影响：数据（剪贴板内容错乱）+ 体验；E2E 是 v1 卖点功能，命中即核心场景崩坏。按「静默数据错乱」定 S0。
- 修法：原生远程拉取跳过 `metadata.e2e != null` 或 `contentPreview == '[E2E]'` 的条目（一行判断），文本回写只交给具备解密能力的 Dart 路径。

### [S1-1] 幽灵端点 `GET /api/app/maintenance`：桌面+移动双端调用，后端从未定义（维护模式初始快照永久失效，静默）

- 后端证据：`src/server/src/routes/app.js` 全部路由为 `/feature-flags`(29)、`/policies`(45)、`/version`(115)、`/announcements`(167)、`/announcements/:id/read`(230)、`/updates/latest`(265)、`/update.json`(322)——**无 `/maintenance`**；全仓 `grep "'/maintenance'" src/server` 零命中（维护态只在 `middleware/maintenance.js` 内部读库 + WS 广播 `maintenance.updated`，admin/configs.js:469）。
- 客户端证据：桌面 `src/desktop/src/views/HomeView.vue:452-457` — `api('GET', '/api/app/maintenance').then(res => { if (res.ok ...) setMaintenanceMode(...) }).catch(() => {})`；移动 `src/mobile/lib/providers/feature_flags_provider.dart:269-296` — 并行拉取后 `if (maintenanceResponse.statusCode == 200)` 才 applyMaintenance，404 静默跳过。
- 失败场景（**静默失败**）：管理台开启维护模式**之后**才启动/重启的客户端，启动快照永远拿不到（404 被吞），维护横幅不显示、移动端采集不暂停（feature_flags_provider.dart:289 注释声称的「CO-20 公开端点」契约不存在）；只有维护模式**切换瞬间**在线的客户端能通过 WS `maintenance.updated` 感知。用户看到的是「维护期间同步莫名失败（写链路 503）却没有维护提示」。
- 影响：可用性+体验；两端同病，双端注释都把它当已存在契约引用，属典型「文档/注释与实现脱节」。
- 修法：后端在 routes/app.js 补 `GET /maintenance` 返回 `{ maintenance: 'on'|'off' }`（readMaintenanceMode 已有现成函数）。

### [S1-2] 管理台 SSO 断链：`POST /api/auth/sso-exchange` 后端不存在，超管免密直达管理台必失败

- 后端证据：全仓 grep `sso-exchange` 仅命中注释 `src/server/src/routes/admin/index.js:192`（“管理台 /sso 页面经 POST /api/auth/sso-exchange 兑换为正式管理台会话。**设计见 routes/auth.js sso-exchange**”）——routes/auth.js 及所有 auth-*.js 中**无此路由**；签发侧 `POST /api/admin/sso/token`（admin/index.js:193）存在且把 code 写入 Redis `sso:code:{code}`（:201），但没有任何兑换端点消费它。
- 客户端证据：桌面发起 `src/desktop/src/components/layout/AppSidebar.vue:164-170`（POST /api/admin/sso/token → 拼 `/sso?code=`打开浏览器）；管理台兑换 `src/admin-console/src/api/auth.ts:76-80` — `apiPost<RealLoginResp>('/auth/sso-exchange', { code })`，消费页 `src/admin-console/src/pages/sso/index.tsx:43`。
- 失败场景（**显式报错**）：超管在桌面端点「管理控制台」→ 浏览器打开 /sso?code=… → 兑换请求 404 → axios 拦截器 toast「资源不存在」，SSO 页失败。60 秒一次性 code 白发。
- 影响：可用性；RB-SSO 整条链路（桌面签发→浏览器兑换）最后一跳缺失，功能等于未交付。
- 修法：后端在 auth 路由补 `POST /sso-exchange`（Redis GETDEL `sso:code:{code}` → 复用 createSessionAndGenerateToken 返回 `{token,user}`）。

### [S1-3] 幽灵调用：桌面收藏「新建标签 / 重命名标签」打到不存在的 `POST /api/favorites/tags`、`PUT /api/favorites/tags/:tag`

- 后端证据：`src/server/src/routes/favorites.js` 标签相关仅有 `GET /tags`(:425)、`DELETE /tags/:tag`(:475)、`PUT /:id/tags`(:381)——**无 POST /tags、无 PUT /tags/:tag**（DELETE 处理器里反而引用了 `favorite_tag_presets` 表，:492，说明预设标签后端只做了一半）。
- 客户端证据：`src/desktop/src/api/favorites.ts:77-88` — `api('POST', '/api/favorites/tags', { name, color })` 与 `api('PUT', \`/api/favorites/tags/${...}\`, data)`；调用点 `components/clipboard/FavoritesView.vue:650/666`（收藏页标签管理 UI）、`components/clipboard/FavOrganizeFlow.vue:243`（AI 整理流程建标签）。
- 失败场景：① 收藏页「新建标签预设」→ 404 → toast「创建失败」（**显式报错**，用户反复重试也不行）；② 标签重命名 → 404 → toast「重命名失败」（**显式**）；③ AI 整理流程里 `createTag` 失败被注释「已存在时创建失败不中断」**静默吞掉**（FavOrganizeFlow.vue:241-244）——标签颜色预设永远存不上，后续 `setItemTags` 仍写 metadata.tags 所以标签名能显示，但全局颜色/预设功能整体失效（**静默降级**）。
- 影响：可用性+体验；收藏页摆着完整标签管理 UI（输入框+回车绑定，FavoritesView.vue:1663-1669），点了必失败。
- 修法：后端补两个路由（落 `favorite_tag_presets` 表，该表 DELETE 处已在用），或前端下线该 UI。

### [S1-4] 发行版客户端默认后端地址 = localhost/模拟器网段，`src/shared/domains.js` 的 `api.clipchain.top` 没有接到任何客户端

- 后端/共享层证据：`src/shared/domains.js:24-33` — `DOMAINS = { api: 'api.clipchain.top', ... }`；但消费方仅服务端 2 处 EMAILS（routes/auth.js:13、utils/pdf-invoice.js:38），routes/app.js:12-14 注释明说域名 import「已无消费方，一并移除」。
- 客户端证据：桌面 `src/desktop/src-tauri/src/lib.rs:115` — `server_url: "http://localhost:3001".to_string()`（Rust 默认配置），`src/desktop/src/stores/configStore.ts:12,20` — 生产构建回落 `DEFAULT_SERVER_URL='http://localhost:3001'`；移动 `src/mobile/lib/services/server_config.dart:20-25` — 默认 `http://10.0.2.2:3001`（Android 模拟器宿主别名）/`http://localhost:3001`，无 kReleaseMode 分支；而桌面支付页已经硬编码生产域名 `https://api.clipchain.top/terms-of-service.html`（AlipayScanPay.vue:252）——证明生产域名已知却没用于默认 server_url。
- 失败场景（**显式失败但根因难懂**）：v1 用户装官网下载的 `ClipSync_0.1.1_x64-setup.exe`（website download-links.ts:40）或 APK，首启即指向 localhost:3001 → 登录/同步全部连不上；用户必须自己发现「设置→服务器地址」手填 `https://api.clipchain.top`。真机上 10.0.2.2 根本不可达。
- 影响：可用性，上线阻断级——普通用户 100% 首启失败；同时是「shared 共享层名存实亡」的最重实例（见 S3-5）。
- 修法：release 构建默认值切到 `ORIGINS.api`（桌面 Rust default + configStore，移动 ServerConfig 按 kReleaseMode 分支），shared/domains.js 作为唯一来源接进三端构建。

### [S1-5] 移动端截图/图片上传失败零提示、零离线队列：云端副本静默丢失

- 后端证据：`src/server/src/routes/media.js:346-350` — 套餐配额超限时返回结构化 413（`checkUploadQuota` fail-closed，multer limits 20MB/1GB，media.js:77/95）；`middleware/maintenance.js` 维护期 /api/media 返回 503（index.js:415）。
- 客户端证据：`src/mobile/lib/services/api_service.dart:383-387` — `if (streamedResponse.statusCode >= 400 && <500) return null;`（**丢弃响应体里的 413 错误码/文案**）；`src/mobile/lib/main.dart:233-241` — `result == null` 时仅 `debugPrint('[ScreenshotCapture] uploadImage returned null')`，**不入 PendingUploadQueue、不弹任何提示**（文本路径有离线队列 reuploadText，图片路径没有；sync_service.dart:278-330 的重放只覆盖已入队条目）。移动端全工程无 `getPlanLimits`/maxFileSize 预检（grep 零命中），桌面端有（useFileUpload.ts:37-38 超限 toast）。
- 失败场景（**静默失败**）：Free 档用户截一张超配额的大图/维护窗口期截图 → 上传被服务端正确拒绝 → 手机 UI 毫无反应，条目永远不出现在云端和其他设备；用户以为「同步时灵时不灵」。
- 影响：数据（云副本丢失）+体验；同一契约桌面端有预检+toast、移动端全静默，属跨端行为不一致。基线为 S2（错误不可见），按静默数据丢失上调 S1。
- 修法：图片上传失败解析 413 body 弹本地通知，并把文件路径入 PendingUploadQueue（队列已支持 image/file 重放，_replayMediaUpload 现成）。

### [S2-1] 管理台会话刷新契约双重错位：响应壳与字段名都不匹配，令牌过期只能强制重登

- 后端证据：`src/server/src/routes/auth-refresh.js:64` — `res.json({ token, refreshToken: nextRefreshToken })`（**裸结构，字段名 token**）。
- 客户端证据：`src/admin-console/src/api/client.ts:71-79` — `const body = resp.data as ApiResp<LoginResp>; if (body.code !== 0) return null; ... return body.data.accessToken`（期望 `{code:0,data:{accessToken}}` 壳）；且 `api/auth.ts:32` — `finalizeSession` 写死 `refreshToken: null`，store 里根本没有 refresh token 可用。
- 失败场景（**半静默**）：管理员会话过期 → 401 → 拦截器 refresh 必然失败（refreshToken null 直接短路；即便有，`body.code !== 0` 也判失败）→ toast「登录已过期，请重新登录」+ 跳转登录页。编辑到一半的表单内容丢失。
- 影响：可用性/体验（管理台每 JWT 周期强制重登一次）。
- 修法：client.ts 的 refreshAccessToken 改读裸 `{token,refreshToken}`，登录时保存真实 refreshToken。

### [S2-2] 移动端 WS 消息缺处理分支：`clipboard_updated`、`notification`、`policies.updated`、`announcement.new` 全部静默丢弃

- 后端证据：`src/server/src/routes/clipboard.js:1037` — `broadcastToUser(req.userId, { type: 'clipboard_updated', item: payload })`（编辑/归档/置顶/过期时间变更）；`ws/server.js:512-520` — `{ type:'notification', notificationType, title, body, ... }`（含 security_alert 新设备登录告警，ws/server.js:551-556）。
- 客户端证据：`src/mobile/lib/services/ws_service.dart:203-256` — `_handleMessage` 的 switch 只有 registered/pong/new_clipboard/clipboard_deleted/clipboard_favorite/feature_flags.updated/maintenance.updated/force_logout/error 九个 case，**无 default 分支**，其余类型无声落空。
- 失败场景（**静默失败**）：① PC 上置顶/归档/改标签/设过期 → 手机列表不刷新（收藏 toggle 却会刷新——同一页面两种行为，典型「时灵时不灵」）；② 账号在新设备登录 → PC 弹安全告警（HomeView.vue:538 处理 notification），手机收不到实时告警也不入通知页（只有下次手动拉 history 才可见）；③ 管理台下发公告/改策略 → 手机要等冷启动才生效。
- 影响：数据展示一致性+安全感知（security_alert 是安全类通知）。基线 S3，静默上调 S2。
- 修法：ws_service switch 补 `clipboard_updated`（触发列表刷新/单条更新）与 `notification`（本地通知+历史插入）两个 case；policies/announcement 视产品优先级排期。

### [S2-3] 仓库内 nginx 负载均衡配置两处契约错位：`client_max_body_size` 缺省 1MB + `location /ws/` 匹配不到 `/ws` 握手

- 后端/配置证据：`nginx/nginx.conf`（http 块）与 `nginx/conf.d/clipsync.conf` 全文**无 `client_max_body_size`**（grep 全仓含 k8s 零命中）→ nginx 默认 1MB；`nginx/conf.d/clipsync.conf:45` — `location /ws/ { proxy_set_header Upgrade ... }`，而客户端握手路径是 `/ws?token=...`（无尾斜杠，desktop useWebSocket.ts:80、mobile ws_service.dart:134），`location /ws/` 前缀匹配不中 → 落到 `location /`（:70）无 Upgrade 头 → WS 升级失败。对照服务端 multer：图片 20MB（media.js:77）、文件 1GB（media.js:95）、分片 12MB（chunked-upload.js:164）。
- 客户端证据：桌面分片 10MB/片（utils/chunkedUpload.ts:46），单请求也远超 1MB；桌面文本上限 9MB（clipboardUpload.ts:169）。
- 失败场景：使用 `docker-compose.multi.yml`（:155-165 挂载该配置）的多实例部署下：任何 >1MB 的上传被 nginx 413 拦截（客户端收到的是 nginx HTML 错误页，desktop client.ts:248-251 会把 HTML 塞进 `message` 显示——**显式报错但文案是原始 HTML**）；WS 完全连不上 → 实时同步整体失效，客户端只在退避重连（**表象是静默不同步**）。
- 影响：可用性；仅限启用该 nginx 层的部署形态（生产 runbook 另有服务器上的 nginx 配置，docs/deploy/production-server-runbook.md:78 声称含 /ws 升级，仓库内无法验证），故定 S2 而非 S1。
- 修法：conf.d/clipsync.conf 加 `client_max_body_size 1g;`（与 multer 1GB 对齐）并把 `location /ws/` 改为 `location /ws`（或 `location = /ws`）。

### [S2-4] 孤儿端点中的「未完成功能」类（后端做完、前端没接）

统计：后端全量 ~150 个端点中，**无任何客户端调用的 21 个**；其中属「疑似未完成功能」（有配套表结构/注释/半截实现，判断为产品缺口而非纯死代码）7 组：

| 端点 | 定义位置 | 判断依据 |
|---|---|---|
| POST /api/subscriptions/start-trial | routes/subscriptions.js:~301（写 'trial' 状态、TRIAL_DAYS、审计） | 试用整套后端就绪（app.js:154 受众判定也认 trial），三端无「开始试用」入口 |
| PATCH /api/admin/users/:id/role、POST /:id/reset-2fa | admin/users.js:618/768 | 管理台 users.ts 只接了 status/approve/force-logout/delete/export；无法改角色、无法解救 2FA 丢失用户（客服流程缺口） |
| GET /api/storage/usage | routes/storage.js（F0.3，index.js:424 专门挂了中间件链） | 桌面用 /subscriptions/current.storageUsedMb 代替，专用端点闲置 |
| GET /api/surveys/stats、/api/surveys/my | routes/surveys.js | 满意度调查只有提交口（SatisfactionSurvey.vue:55），运营侧无查看入口 |
| POST /api/versions、GET /api/versions/detail/:versionId、GET /stats/overview、POST /cleanup | routes/versions.js | 版本历史 UI（VersionHistoryModal）只接了列表+restore；详情/统计/清理未接（快照写入由 clipboard.js:988-1005 内部直调 createVersion，POST / 无消费方） |
| POST /api/devices/pairing/*（移动端侧） | routes/device.js:32/56 | 扫码配对「扫码方」按注释应是**无 token 的新设备**（index.js:400-401），桌面实现了 redeem（QrPairingModals），**移动端没有任何扫码入口**（grep pairing 零命中）——手机扫 PC 码这一主场景缺失 |
| GET /api/app/update.json | routes/app.js:322 | 旧格式更新端点，现桌面走 /updates/latest；保留兼容但无现役调用方（可接受，标注即可） |

纯死代码类（可直接删）：GET /api/clipboard/search（客户端全用 list?search=）、GET /api/clipboard/sync/:deviceId、/api/sync/push|pull|status 全组（移动 api_service.dart:306-352 封装零调用）、POST /api/ai/similarity、POST /api/payments/refund（桌面注释弃用）、GET /api/payments/reconciliation、GET /api/invoices/:id、**routes/health.js 与 routes/metrics.js 整文件未挂载**（index.js:272/377 内联实现替代）、utils/route-loader.js 未被引用。
- 失败场景：无直接用户可见失败（无人调用），风险在于「以为功能存在」——如运营以为有试用转化漏斗、客服以为能重置用户 2FA。
- 影响：产品完整度；上表 7 组建议在 v1 前逐个决策「接线 or 下线」。
- 修法：按表逐项接线或标记 deprecated 并删除死代码。

### [S2-5] 通知类型枚举三端漂移：客户端设置页暴露的 `product_update` 服务端从不发送；服务端种子 `subscription_expiring` 无客户端开关

- 后端证据：`src/server/src/db/migrations/005_notification_preferences.sql:56` — 种子类型 `['sync_complete','device_online','subscription_expiring','security_alert']`；实际发送方 grep：`sync_complete`（clipboard.js:749）、`device_online`（device.js:130）、`security_alert`（ws/server.js:552）、`subscription_cancelled`/`subscription_resumed`（subscriptions.js:399/460）——**没有任何代码发 `product_update` 或 `subscription_expiring`**。
- 客户端证据：桌面 `src/desktop/src/composables/useNotifications.ts:135-140` — `nfUpdates: 'product_update'`；移动 `src/mobile/lib/screens/notification_settings_screen.dart:42-45` — 同样列 `"product_update"`。两端都没有 subscription_expiring/cancelled/resumed 的开关。
- 失败场景（**静默失败**）：用户在设置里关掉「产品更新通知」→ PUT /preferences 成功落库一行 `product_update`（服务端不校验类型）→ 该偏好永远不会被任何通知消费，开关是装饰品；反之退订/到期类通知用户无法关闭。
- 影响：体验+产品诚信（摆着不生效的开关）。
- 修法：统一一张通知类型枚举表（建议放 shared/），客户端开关与服务端 sendNotification 调用点对齐，PUT /preferences 加白名单校验。

### [S2-6] 文本上限三处不一致：移动端 10MB 无余量 vs 服务端 express.json 10mb 整体限制（413 边界静默/报错含混）

- 后端证据：`src/server/src/config.js:109-110` — `jsonBodyLimit = '10mb'`（**整个请求体**）；`src/server/src/routes/clipboard.js:556-558` — `contentEncrypted.length > 10*1024*1024` 才 400。
- 客户端证据：桌面 `src/desktop/src/composables/clipboardUpload.ts:168-169` — `MAX_TEXT_UPLOAD_SIZE = 9MB`，注释明说「比后端 express.json 的 10MB 小 1MB 留余量，避免 413」；移动 `src/mobile/lib/services/clipboard_capture.dart:50-51,89` — `_maxContentLength = 10MB`，`trimmed.length > _maxContentLength` 才丢弃，**无余量**。
- 失败场景：手机复制 9.5-10MB 文本（含 metadata/JSON 转义膨胀后整体 >10mb）→ express 层 413（entity.too.large）→ 移动 `_postClipboard` 的 `_interpret` 抛 AppException，采集路径捕获后仅 debugPrint → 内容静默不同步。桌面同场景在 9MB 处提前拦下并 toast 提示（clipboardUpload.ts:343-346）。
- 影响：数据（边界大文本静默丢失）；发生率低但两端行为不一致。
- 修法：移动端上限对齐桌面 9MB（或读 policies 下发），并在丢弃时发本地通知。

### [S3-1] 同一 WS 事件 `new_clipboard` 存在两种 payload 契约（`item` 单数 vs `items` 复数）

- 后端证据：`src/server/src/routes/sync.js:206-211` — `broadcastToUser(..., { type:'new_clipboard', items, sourceDeviceId, timestamp })`（复数）；其余四处全是 `item: {...}` 单数（clipboard.js:734、media.js:218/495、chunked-upload.js:581）。
- 客户端证据：桌面 `HomeView.vue:471/493` 读 `data.item`；移动 `main.dart:326` 读 `msg['item']`——都不认 `items`。
- 失败场景：当前 /api/sync/push 无调用方（死路径），暂不触发；一旦有人启用 sync push，其他设备收到广播后 `data.item === undefined` → 通知/自动写入剪贴板全部跳过，仅列表刷新，**静默半失效**。
- 影响：埋雷型契约分裂。
- 修法：sync.js 广播改为逐条 `item` 或删除（随 /api/sync 死代码一并处置）。

### [S3-2] chunked-upload 完成的广播缺 `sourceDeviceId`，其他设备无法识别来源

- 后端证据：`src/server/src/routes/chunked-upload.js:581-589` — `item: { id, contentType:'file', contentPreview, contentSize, createdAt }`，**无 sourceDeviceId**（对照 media.js:225 有）。
- 客户端证据：桌面 `HomeView.vue:471-473/495` — `const srcDevice = data.item?.sourceDeviceId || ''; const isRemote = !!srcDevice && ...`，空串恒判为「非远端」→ 不弹通知、不触发 autoCopyRemoteItem。
- 失败场景（静默降级）：A 设备分片上传 >10MB 文件，B 设备列表会刷新但没有任何「来自 A 的新内容」提示。
- 修法：广播 item 补 `sourceDeviceId: session.deviceId`（init 时已收 deviceId 的话）或从条目行取 source_device_id。

### [S3-3] 桌面死封装携带错误契约（未调用，但一旦被复用即翻车）

- 证据：`src/desktop/src/api/clipboard.ts:31-33` — `uploadClip` 发 `{ content, type, preview }`，后端读 `contentEncrypted/contentType/contentPreview/sourceDeviceId`（clipboard.js:545-549）→ 必 400；同文件 :38-40 — `deleteClip` 写成 `api(\`/api/clipboard/${id}\`, 'DELETE')`，而 `api()` 签名是 `(method, path, body)`（client.ts:186-190）→ 会把路径当 method 发出去；`src/desktop/src/api/subscription.ts:3-13` — `/api/subscription`（单数）三个幽灵路径。三者 grep 全工程**零调用点**。
- 影响：死代码+陷阱。
- 修法：删除或修正后保留。

### [S3-4] `device_removed` / `server_shutdown` 两端均无处理分支

- 后端证据：device.js:327-330（删除设备后广播）、ws/server.js:602-607（优雅停机广播，含 reconnectAfter:5000）。
- 客户端证据：桌面 HomeView.vue:460-545 与移动 ws_service.dart:203-256 的分支清单里均无这两个 type（见 WS 全集表）。
- 失败场景：被删设备要等到下次 API 调用 404/重连被踢才感知；server_shutdown 的「5 秒后重连」提示被丢弃（客户端靠 onclose 指数退避，实际影响小）。静默但后果轻。
- 修法：桌面/移动补 `device_removed`（本机 id 命中则清登录态或提示）与 `server_shutdown`（按 reconnectAfter 缩短重连延迟）。

### [S3-5] `src/shared/` 共享层名不副实：只有服务端 2 处消费 EMAILS，域名/上限/枚举/地址常量各端各写一份

- 证据：`src/shared/package.json` 自称「域名单一事实源（跨端共享）」；实际 import 仅 `src/server/src/routes/auth.js:13`、`src/server/src/utils/pdf-invoice.js:38`（且只用 EMAILS，不用 DOMAINS/ORIGINS）；routes/app.js:12-14 注释记录了唯一 DOMAINS 消费方被移除。桌面（configStore.ts:12）、移动（server_config.dart:20-25）、官网（download-links.ts:25）、Tauri updater（tauri.conf.json:53）各自硬编码地址，值互不一致（见 S1-4）。重复常量清单：后端地址 ×4 处（localhost:3001 / 10.0.2.2:3001 / api.clipchain.top / updates.clipchain.top）；文本 10MB 上限 ×3 处（server config.js:110、desktop 9MB、mobile 10MB，见 S2-6）；WS 心跳参数 ×3 处（server 30s/5s、desktop 25s/35s、mobile 30s/35s，注释互相引用但无编译期约束）；contentType 枚举 ×3 处（validator.js:49、desktop clipboardState.ts:5、mobile clipboard_item.dart:211-225，桌面 TS 联合缺 'code' 仅靠运行时 cast 兜底）；通知类型枚举 ×3 处（见 S2-5）。
- 影响：架构谎言——「共享层」提供的正是各端漂移最严重的那类常量；每次改动要靠注释提醒对齐。
- 修法：v1 后把 domains/limits/enums 收敛进 shared 并让三端构建期消费（vite define / dart 代码生成 / server import）。

### [S3-6] 服务端内部重复/遮蔽路由与双份迁移 schema（对外不可见，但增加契约漂移风险）

- 证据：① `routes/clipboard.js:372` 与 `:401` **同一 `GET /stats` 定义两次**（第二个永不可达）；② `routes/auth.js` 与 auth-verify/password/profile/session.js 存在 15+ 条同路径重复定义，index.js:393-398 挂载顺序使 auth.js 全量遮蔽后四个文件的同名路由（如 POST /login：auth.js:1130 生效、auth-password.js:139 死）——两份实现一旦单边修改即产生「看代码 A 实际跑代码 B」；③ `notification_history` 表在 005 迁移（id SERIAL/content/sent_at/read_at，与 createNotification services/notificationService.js:100-104 及桌面 mapRow useNotifications.ts:32-41 匹配）与 015 迁移（id UUID/body/data/read，**完全不同的列集**）各建一次，靠 `IF NOT EXISTS` 先到先得——任何按 015 建表的环境里桌面通知页 title/body 全空（静默）；④ 官网下载地址（website download-links.ts:25）与服务端发布单下载地址解析（utils/releaseArtifacts.js，app.js:350）双源。
- 修法：删重复定义；015 迁移改为与 005 对齐或校验列集；官网下载链接改从 /api/app/updates/latest 或统一配置生成。

---

## 时间戳口径核对表

| 端 | 字段/场景 | 单位 | 格式 | 时区 | 锚点 |
|---|---|---|---|---|---|
| 后端 REST | clipboard createdAt/expiresAt/favoritedAt | — | ISO-8601 字符串（pg Date → res.json 序列化） | UTC（timestamptz 列） | routes/clipboard.js:190-196（SELECT 原样透传） |
| 后端 WS | new_clipboard item.createdAt | — | ISO 字符串 | UTC | routes/clipboard.js:740 |
| 后端 WS | pong / server_shutdown timestamp | **epoch 毫秒** | number | n/a | ws/server.js:355/606（消费端不解析或无分支，无害） |
| 后端 REST | pairing init expiresAt | **epoch 毫秒** | number | n/a | routes/device.js:36 `Date.now()+5*60*1000` |
| 桌面 | PairingInitResult.expiresAt | epoch 毫秒 | number（与后端一致 ✓） | — | api/device.ts:14 |
| 桌面 | 列表项 timestamp | epoch 毫秒（本地转换） | `new Date(i.createdAt).getTime()` | 解析 ISO→本地 ms | composables/clipboardLoad.ts:325 |
| 桌面 | 删除墓碑游标 since | — | ISO 字符串（本地时钟-5s 回拨，serverTime 校准） | UTC | clipboardLoad.ts:71-101 ↔ clipboard.js:341-364（`new Date(sinceRaw)` 双格式兼容）✓ |
| 移动 | ClipboardItem 时间字段 | 字符串→DateTime；number 按 **ms** 兜底 | `_asDateTime`：ISO parse / fromMillisecondsSinceEpoch | 本地 DateTime | models/clipboard_item.dart:306-314 ✓ |
| 移动原生 | 远程拉取游标 PREF_KEY_LAST_REMOTE_PULL_AT | epoch 毫秒（**手机本地时钟**）vs 服务端 createdAt（服务器时钟） | long vs ISO | 跨时钟比较 | SyncForegroundService.kt:810-830 —— 手机时钟快→漏拉，慢→重复拉（相册同名去重兜底）；**无 NTP/服务端时间校准**，S3 级风险 |
| 后端 | notification_history.sent_at | — | `TIMESTAMP`（**无时区列**）→ JSON ISO | 依赖 Node 容器 TZ=UTC | migrations/005:43 + services/notificationService.js:101-102；桌面 useNotifications.ts:38 直接 new Date() 解析 |
| 后端 | 订阅 currentPeriodEnd 等 | — | ISO（timestamptz） | UTC | routes/subscriptions.js:110-118 |

**确定结论**：REST/WS 主数据链路（剪贴板条目、墓碑游标、订阅到期、订单时间）四端统一为 **ISO-8601 UTC 字符串**，客户端统一 `new Date()/DateTime.parse` 转本地毫秒，**不存在秒 vs 毫秒混用**；仅有的 epoch-ms 字段（pairing expiresAt）两端类型一致。残留两个非阻断风险：移动端原生游标用本机时钟直比服务端时间（无校准），notification_history 用无时区 TIMESTAMP 列（依赖容器 TZ=UTC 的隐式约定）。

## 上限一致性核对表

| 限制项 | 后端 | 桌面 | 移动 | nginx（仓库 multi 配置） | multer | 是否一致 |
|---|---|---|---|---|---|---|
| JSON 请求体 | express.json **10mb**（config.js:110） | — | — | 默认 **1MB**（未配置） | n/a | ✗ nginx 层 |
| 文本条目内容 | contentEncrypted >10MB → 400（clipboard.js:557） | **9MB** 预检+toast（clipboardUpload.ts:169/343） | **10MB** 无余量、超限静默丢（clipboard_capture.dart:51/89） | 1MB ✗ | n/a | ✗（移动边界 413 静默，见 S2-6） |
| 图片上传 | 套餐配额 checkUploadQuota 413 | 压缩后 multipart，配额预检 useFileUpload.ts:37 | 无预检，4xx 静默 return null（api_service.dart:385） | 1MB ✗ | **20MB**（media.js:77） | ✗（移动无预检+静默，见 S1-5） |
| 文件上传（multipart 直传） | 套餐 maxFileSizeBytes + 文件数 Free3/Pro10/Ent50（media.js:313-350 注释） | ≤10MB 直传（FILE_MULTIPART_UPLOAD_LIMIT，clipboardUpload.ts:185） | 全量 multipart 直传无分片（api_service.dart:426） | 1MB ✗ | **1GB**（media.js:95） | 部分（阈值分工不同但各自与后端兼容） |
| 分片大小 | 每片 multer **12MB**（chunked-upload.js:164） | 每片 **10MB**（chunkedUpload.ts:46，注释「server limit」） | 不用分片 | 1MB ✗ | 12MB | ✓（10<12 留余量，注释口径略旧但安全） |
| 分页 limit | cap **100**（validator.js:208） | ≤100 | ≤100；原生拉取 limit=10 | n/a | n/a | ✓ |
| sync push 批量 | ≤50 changes（sync.js:34） | 不调用 | 封装未调用 | n/a | n/a | n/a（死路径） |
| 设备数 | 套餐 max_devices + checkDeviceLimit（index.js:407） | 注册报错可见 | 注册报错可见 | n/a | n/a | ✓ |
| WS 单帧 | maxPayload **1MB**（ws/server.js:87） | 仅小 JSON | 仅小 JSON | n/a | n/a | ✓ |
| contentPreview 截断 | 5000 字符（clipboard.js:566） | 5000（clipboardUpload.ts:407） | 依赖服务端截断（clipboard_capture.dart:469 注释） | n/a | n/a | ✓ |

**结论**：五处上限体系里 **nginx 是最短板且未配置**（默认 1MB，一旦启用 multi 部署所有上传全灭，见 S2-3）；移动端在文本余量与图片配额两处比后端/桌面激进且失败静默（S2-6 / S1-5）。桌面与后端其余各项一致。

## 枚举值一致性核对表

| 枚举 | 后端权威值 | 桌面 | 移动 | 管理台 | 结论 |
|---|---|---|---|---|---|
| contentType | text/image/file/link/code（validator.js:49） | TS 联合仅 text/image/file/link（clipboardState.ts:5），运行时 `(i.contentType) as ClipItem['type']` 直接透传（clipboardLoad.ts:319），展示层有 code 分支（useClipItemDisplay.ts） | 注释声明五值白名单，typeIcon default→text（clipboard_item.dart:211-225）✓ | n/a | 基本一致；桌面类型声明缺 'code' 仅编译期不严，运行时无丢弃 |
| deviceType | desktop/mobile/tablet/browser（validator.js:59） | 发 'desktop' | 发 'mobile' | 展示层 | ✓（device.js:198 错误文案漏列 browser，仅文案瑕疵） |
| platform | windows/macos/linux/ios/android/browser（validator.js:69） | guessPlatform()→windows/macos/linux（clipboardUpload.ts:255-261） | 'android'（auth_provider.dart:314） | 展示 | ✓ 无 win32/Windows/desktop 之类拼写漂移 |
| 订阅状态 | DB 写 'trial'/'active'；CHECK 同时容 'canceled'+'cancelled'（004 迁移:48） | /current 归一读取（useSubscriptionAccess.ts:167-186） | 原样字符串保存（user_subscription.dart:37） | 服务端归一 'trial'→'trialing'、'cancelled'→'canceled' 后下发（admin/subscriptions.js:56-60、admin/users.js:189-194） | ✓ 有意识的双拼写兼容，但依赖 admin 层手工归一，脆弱（S3 记录） |
| 订单状态 | CHECK pending/paid/failed/**cancelled**/refunded（004 迁移:93）；orderFulfillment.js:202 对订阅写 'canceled' | PaymentOrder 联合含 'cancelled' ✓ | 不消费 | VALID_ORDER_STATUSES 同五值（admin/orders.js:80） | ✓（订单表两 L、订阅表单 L 的分裂被 CHECK 双拼写吸收） |
| 通知类型 | 种子 4 值 + 实发 5 值（见 S2-5） | 暴露 product_update（永不发生） | 同桌面 | n/a | ✗ 漂移（S2-5） |
| 维护模式 | 'on'/'off'（middleware/maintenance.js normalizeMode） | setMaintenanceMode(data.mode) ✓ | applyMaintenance(mode=='on') ✓ | 写 'on'/'off' | ✓ |
| feature flag 键 | CLIENT_FLAG_KEYS 5 键（app.js:21-27） | useFeatureFlags 同键 | feature_flags_provider 同键 | flags 管理页 | ✓ |
| 套餐档位 | 按 DB 行下发（id+name Free/Pro/Enterprise，app.js:147-155 用 name 判 pro_plus） | 动态拉 plans | 动态拉 plans | plans 管理 | ✓（无硬编码档位 id） |

## 幽灵调用清单（客户端 → 后端不存在）

| # | 客户端调用点 | 路径 | 后端状态 | 用户可见后果 | 严重度 |
|---|---|---|---|---|---|
| 1 | desktop HomeView.vue:453；mobile feature_flags_provider.dart:270 | GET /api/app/maintenance | 无定义 → 404 `{error:'Endpoint not found'}`（index.js:559-562） | 静默（双端 catch 吞掉）：维护横幅/采集暂停的启动快照永不生效 | S1-1 |
| 2 | admin-console api/auth.ts:77（pages/sso/index.tsx:43） | POST /api/auth/sso-exchange | 无定义 → 404 | 显式：SSO 页兑换失败 toast「资源不存在」，超管免密入口断链 | S1-2 |
| 3 | desktop api/favorites.ts:78（FavoritesView.vue:666、FavOrganizeFlow.vue:243） | POST /api/favorites/tags | 无定义 → 404 | 显式「创建失败」toast；AI 整理流程内静默吞 | S1-3 |
| 4 | desktop api/favorites.ts:86（FavoritesView.vue:650） | PUT /api/favorites/tags/:tag | 无定义 → 404 | 显式「重命名失败」toast | S1-3 |
| 5 | desktop api/subscription.ts:4/8/12（**零调用点**） | GET /api/subscription、POST /api/subscription/cancel、/change | 后端是复数 /api/subscriptions 且无 /change | 无（死封装陷阱） | S3-3 |
| 6 | desktop api/clipboard.ts:32/39（**零调用点**） | POST /api/clipboard 发 `{content,type,preview}`；`api(path,'DELETE')` 参数顺序颠倒 | 路径存在但字段/调用必失败 | 无（死封装陷阱） | S3-3 |
| 7 | desktop FeedbackModal.vue:30-33 / FeedbackSubPage.vue:29-34 | POST /api/feedback | 无定义 | **已诚实化**：不假装成功，toast「服务未接入，请直接邮件」——符合产品诚信要求，不计问题 | 备注 |

## 版本兼容

- **无 API 版本化**：全部路由裸挂 `/api/*`（index.js:393-554），无 `/api/v1` 前缀、无版本协商头。后端任何破坏性改动会同时打挂已发布的旧桌面端（0.1.1，官网已在分发）与旧 APK。现有的兼容手段是**逐点自律**：如 media.js:309-331 显式保留旧字段 `file` 并注释「换成 .array('files') 会让全部旧客户端 400」、app.js:320-377 保留旧 `/update.json` 契约——方向正确但无系统性保障（无契约测试、无弃用周期标注）。
- **桌面自动更新**：已接通。Tauri updater endpoint `https://updates.clipchain.top/api/app/updates/latest`（tauri.conf.json:53）→ 服务端 app.js:265-318 读 app_releases（管理台 releases 页可发布/灰度/强更），无发布记录时 204 降级；`force_update` 字段已下发（app.js:311），桌面端强更交互标注为「预留」。07 号桌面审计已确认更新链路真实可达。**旧桌面端可被新后端渐进升级**（前提：updates.clipchain.top DNS/反代已按 runbook 配置——仓库内无法验证）。
- **移动端**：pubspec `0.1.0+1`，**无任何应用内更新/最低版本机制**；服务端 devices 表存了 `app_version`（device.js:233-236）但没有一处消费它做版本门控或降级。APK 用户可无限期停留在旧版 → 后端契约演进的最大风险面。无强制升级/优雅降级策略。
- **版本号现状**：desktop 0.1.1（package.json 与 tauri.conf.json 一致）/ mobile 0.1.0+1 / admin-console 0.1.0 / website 0.1.0 / server 0.1.0——互不一致，也无协商机制（各自独立演进，目前靠「后端向后兼容」单边承诺）。
- **versions.js 定性**：是「**剪贴板条目版本历史**」（file_versions，PUT 内容前自动快照 clipboard.js:988-1005 + 用户手动 restore），与客户端版本管理无关；客户端版本管理在 routes/app.js（/version、/updates/latest、/update.json）+ routes/admin/releases.js。routes/health.js 未被挂载（index.js:272 内联 /api/health，响应含 timestamp/uptime，无客户端版本号信息）。

## 附：字段名/响应结构抽查结论（维度 3/4 未见更多问题的说明）

抽查过的高频契约均一致，未发现额外 snake/camel 静默丢字段：POST /api/clipboard 请求体（桌面 clipboardUpload.ts:400-408 与移动 clipboard_capture.dart:455-471 均发 sourceDeviceId/contentType/contentEncrypted/contentPreview/contentSize/metadata，服务端 :545 全读；桌面/移动冗余多发一个 `content` 字段被服务端忽略——无害，S3 备注）；列表响应 `{items,pagination:{page,limit,total,totalPages}}`（桌面 clipboardLoad.ts:207-225、移动 ClipboardPage.fromJson 双端匹配）；`GET /:id/content` 的 `{contentEncrypted,metadata}`（三端一致）；收藏夹 collections 的 **snake_case 裸行**（sort_order/item_count/created_at）桌面 collectionStore.ts:29-30 与移动 CollectionsApiService 注释均按 snake_case 解析 ✓；设备列表裸数组（device.js:171）桌面 pickDeviceList 双格式兼容（useDevice.ts:51-56）、移动 Device.fromJson 双命名兼容（device.dart:62-69）✓；错误壳：用户侧 `{error}`、管理台 `{code,message}`，桌面 client.ts:267/276 读 `json?.error || json?.message`、移动 `_errorDetail` 同、管理台拦截器 `message ?? error`——**三端都不会显示 undefined** ✓；shared-links 201/204 状态码两端匹配 ✓；admin 分页 `{list,total,page,pageSize}` 与 PageData 类型匹配 ✓。
