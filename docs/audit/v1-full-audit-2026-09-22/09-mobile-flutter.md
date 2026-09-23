# 移动端 Flutter 审计（v1 全量审计 · 2026-09-22 · 编号 09）

审计范围：`src/mobile`（Flutter 3.x，lib 90 个 Dart 文件共 36,575 行；Android 原生 Kotlin 9 个文件共 2,329 行）。
方法：纯静态阅读（未运行 flutter/adb 任何命令），对照服务端 `src/server/src/routes/*`、`src/server/src/ws/server.js`、桌面端 `e2e_crypto.rs` 与 `docs/plans/e2e-protocol.md`、`e2e-vector.json` 逐条核对。
排除项：厂商推送账号、软著/备案/企业主体、Apple 开发者账号等外部依赖（见 `docs/audit/external-dependency-audit-2026-09-09.md`）不计入问题；iOS 缺失不报。

---

## 结论（≤3 句）

移动端工程质量明显高于「 demo 级」：E2E 加密跨端一致且有真测试向量对拍、WS 有 pong 看门狗和重连补拉、原生保活链路（前台服务 specialUse + 闹钟自愈链 + 开机自启 + 无障碍采集 + 原生直传）下了重功夫，绝大多数模型解析做了防御。但**当前状态不能直接发 v1**：生产包默认后端地址是模拟器专用的 `http://10.0.2.2:3001` 且全局允许明文流量、登出不清本地数据（离线队列会把上个用户的剪贴板明文重放进下个用户账号）、后台自动采集依赖的无障碍服务没有任何应用内授权引导（且项目自己的真机注释记录该路径在 vivo 实测被拒）、JWT 过期后常驻进程的 WS 与原生直传全部静默失效。修完 3 个 S0 + 7 个 S1 后可上。

---

## 核心卖点成立性判定：「手机复制 → 电脑秒粘」四种状态

先给采集链路事实（证据链）：

1. **经典前台服务采集在 Android 10+ 后台读不到剪贴板**——项目自己写明并被代码承认：
   - `android/.../ClipboardAccessibilityService.kt:20-24`：「Android 10 起，无输入焦点的应用读取剪贴板一律返回 null……前台服务本身永远没有焦点，所以 SyncForegroundService 的经典采集链路在后台/锁屏下拿到的是空内容」。
   - `SyncForegroundService.kt:984-987`：`readClipboard` 在无障碍服务已连接时直接 return（采集让位给无障碍路径）；未连接时也只能在 App 有焦点时读到。
2. **后台自动采集的唯一通道 = 无障碍服务**（`ClipboardAccessibilityService.kt:40-209`，亮屏每 2s 轮询 → 原生直传 `POST /api/clipboard`）。
3. **但项目自己的真机记录说无障碍路径也可能不成立**：`QuickSyncActivity.kt:10-16` 注释原文——「Android 10+ 剪贴板读取只豁免『有输入焦点的应用』与默认输入法，**后台/无障碍路径在这台 ROM 上均被拒绝（AppOps 实测：READ 仅发生在 top 状态）**。本 Activity 是不切走当前应用的『借焦点』通道」。即团队在 vivo V2243A 真机上实测无障碍读剪贴板被拒，才补了「通知按钮/快捷磁贴一键同步」的手动通道。两处注释互相矛盾（a11y 服务注释声称豁免，QuickSync 注释声称实测被拒），**说明后台自动采集在真机上的成立性没有闭环验证**。
4. **无障碍服务没有任何应用内引导/入口**：权限引导页只有 4 张卡（通知/电池优化/自启动/通知使用权，`screens/onboarding/permission_guide_screen.dart:203-217`），全仓 grep 无 `ACTION_ACCESSIBILITY_SETTINGS`、MainActivity 的 MethodChannel 也没有打开无障碍设置的方法。用户必须自己去 系统设置→无障碍→ClipSync 手动开启，否则后台自动采集根本不存在。

四种状态判定：

| 状态 | 成立？ | 依据 |
|---|---|---|
| **前台**（ClipSync 自身在前台） | ✅ 成立 | 有焦点时经典采集路径可读（`SyncForegroundService.readClipboard`）；应用内复制走 `EchoAwareClipboardProvider` 回声抑制不重复上传 |
| **后台**（在微信等其它 App 复制） | ⚠️ **未证实成立** | 唯一自动通道是无障碍服务：①无引导入口，普通用户不会开；②团队自己的真机注释记录 vivo ROM 上无障碍读取被 AppOps 拒绝（`QuickSyncActivity.kt:10-16`）；未开启/被拒时只剩手动方案（通知栏「同步剪贴板」按钮 / 快捷磁贴借焦点，`QuickSyncActivity.kt`）。**上线前必须在华为/小米/OPPO/vivo/三星 + Android 12/13/14/15 逐台实测无障碍采集，并在引导页加入口，否则「后台自动同步」这个卖点默认不成立** |
| **锁屏/灭屏** | ⚠️ 部分成立 | 锁屏期间用户无法复制，问题转化为「解锁前的事件能否补上」：无障碍轮询仅亮屏运行（`ClipboardAccessibilityService.kt:100`，SCREEN_ON 立即补扫），亮屏后 2s 内可补采——前提是无障碍路径本身可用（同上存疑）。截图方向（手机截屏→PC）链路扎实：MediaStore Observer + FileObserver + 1.5s 轮询 + 原生直传不依赖 Flutter 引擎（`SyncForegroundService.kt:1118-1438`）。PC→手机方向由原生 4s/30s 轮询兜底（`pullRemoteImages`），FGS 写剪贴板有 AppOps 实测注释支撑（`SyncForegroundService.kt:853-855`），但**未做电池优化豁免的用户在 Doze 深睡下网络被挂起，轮询与 WS 都会停**（引导页有豁免入口，属可接受降级） |
| **切网（WiFi↔4G）** | ✅ 成立 | `connectivity_plus` 网络恢复 → `SyncService.onNetworkRestored` → `WsProvider.ensureConnected` 重连 + `PendingUploadQueue.replayPending` 离线补传（`sync_service.dart:241-274`）；WS 指数退避带 jitter 且有除零保护（`ws_service.dart:287-314`）。**但有一个致命旁路：token 过期后重连握手用陈旧 token，见 S1-1** |

**总判定：核心卖点在「前台」与「切网」成立；「后台/锁屏自动采集」建立在无障碍服务上，而无引导入口 + 团队自测记录显示至少一台真机被拒 → 当前不能宣称成立，属 S0（见 S0-3）。手动兜底（通知按钮/磁贴）可用但不是「秒粘」体验。**

---

## 与服务端契约一致性核对表

逐项对照 `src/server/src/routes/clipboard.js`、`device.js`、`sessions.js`、`ws/server.js`、`routes/ws.js`：

| 契约点 | 客户端 | 服务端 | 一致？ |
|---|---|---|---|
| POST /api/clipboard 请求体 | `sourceDeviceId/contentEncrypted/contentPreview/contentSize/metadata/contentType`（clipboard_capture.dart:449-472） | 必填 `sourceDeviceId + contentEncrypted`，10MB 上限（clipboard.js:548-558） | ✅ |
| 创建响应码语义 | 201=新建、200=去重命中（clipboard_capture.dart:487-491） | 201 新建 / 200 `duplicate:true`（clipboard.js:677,775） | ✅ |
| 列表分页参数 | `page/limit/contentType/search/favorites/deviceId/dateFrom/dateTo/tag/all/view`（api_service.dart:121-142） | 同名 query（clipboard.js:53-55） | ✅ |
| 列表响应 items 字段 | `ClipboardItem.fromJson` 全防御解析（clipboard_item.dart:69-96） | `id/contentType/contentPreview/ocrText/contentSize/metadata/isFavorite/favoritedAt/archived/expiresAt/createdAt/protectionLevel/sourceDevice{id,name,platform}`（clipboard.js:179-206） | ✅ |
| 时间戳格式 | Dart `DateTime.tryParse(ISO8601)`；原生 `parseIsoToEpochMs` 兼容 `Z` 与 `+08:00`（SyncForegroundService.kt:953-968） | PG `created_at` 经 node-pg JSON 序列化为 ISO8601 | ✅（全链路 ISO 字符串，无秒/毫秒混用） |
| GET /:id/content | 读 `contentEncrypted`（api_service.dart:194-210；原生 fetchRemoteItemContent 同） | 返回 `{contentEncrypted, metadata}`（clipboard.js:519） | ✅ |
| WS 鉴权 | query `?token=&csrf_token=`；csrf 经 GET /api/ws/csrf-token 读 `csrfToken` 字段（ws_service.dart:78-136） | 同字段同校验（ws/server.js:138,159；routes/ws.js:22） | ✅（但 token 进 URL，见 S1-5） |
| WS `new_clipboard` 广播 | main.dart:329 读 `item.sourceDeviceName` | 广播只含 `id/contentType/contentPreview/contentSize/createdAt/sourceDeviceId/metadata`（clipboard.js:736-750），**无 sourceDeviceName** | ❌ 客户端读的字段服务端从不发 → 通知里「来自 X 设备」永远不显示（静默失败） |
| WS `clipboard_deleted` | `itemId` 或 `itemIds`（ws_service.dart:219-225） | 单删 `itemId`（clipboard.js:1082-1085）、批删 `itemIds`（:1125-1128） | ✅ |
| WS `clipboard_favorite` | `itemId/isFavorite`（ws_service.dart:227-231） | 同（clipboard.js:821-825） | ✅ |
| 设备注册 | POST /api/devices camelCase + `publicKey`；201 读 `id`、409 读 `deviceId`（auth_provider.dart:304-340） | 201 返回整行含 `id`；409 `{error, deviceId}`（device.js:223-247） | ✅ |
| GET /api/devices | `Device.fromJson` 兼容 snake_case；E2E 收件人读 `d['public_key']`（clipboard_capture.dart:224-227） | 返回 snake_case 行含 `public_key`（device.js:159-171） | ✅ |
| 会话 | 读 `data.sessions`（api_service.dart:463-466） | `res.json({data:{sessions}})`（sessions.js:36-39） | ✅ |
| CSRF 中间件 | 全部请求走 Bearer | `csrfProtection` 对 Bearer 请求跳过（middleware/csrf.js:157-160） | ✅ |
| Idempotency-Key | Dart 采集键一次生成贯穿重试（clipboard_capture.dart:304-357）✅；**原生 `mobile-native-${System.nanoTime()}` 每次重试重新生成**（NativeClipboardUploader.kt:51） | idempotency 中间件按键幂等 | ⚠️ 原生侧幂等键形同虚设，靠服务端 content_hash 5 分钟去重兜底；>5 分钟的响应丢失重试会产生重复条目 |
| /api/sync/push、/api/sync/pull | 已封装（api_service.dart:306-354） | 存在（sync.js:22,239） | ⚠️ **零调用**——移动端实际同步不走 /api/sync，三个方法是死代码 |

---

## 跨端加密参数一致性（Dart 侧实际取值）

对照 `lib/services/e2e_crypto.dart` ↔ `src/desktop/src-tauri/src/e2e_crypto.rs` ↔ 服务端信封校验（clipboard.js:573-599）：

| 参数 | Dart 实际值 | Rust/服务端 | 一致 |
|---|---|---|---|
| 曲线 | `ECDomainParameters('prime256v1')`（P-256），公钥 65B 未压缩点 0x04 开头，显式 on-curve 校验（e2e_crypto.dart:96,158-198） | p256 crate，同格式 | ✅ |
| 内容加密 | AES-256-GCM，随机 32B K + 12B IV，存储 `base64(ciphertext‖tag16B)`（:100-108,250-257） | 同（e2e_crypto.rs:11,336） | ✅ |
| 密钥封装 | ECDH(ephemeral, peerPub) → HKDF-SHA256(salt=`clipsync-e2e-v1` ASCII, info=deviceId UTF-8, 32B KEK) → AES-GCM 包 K 得 48B `w` + 独立 12B `iv`（:71,228-247） | `HKDF_SALT = b"clipsync-e2e-v1"`（e2e_crypto.rs:48），同结构 `{w, iv}`（:339） | ✅ |
| 信封 | `{v:1, alg:"ECDH-P256+HKDF-SHA256+A256GCM", epk, iv, keys:{deviceId:{w,iv}}, ciphertext}`；上传时 ciphertext 进 content/contentEncrypted，信封去 ciphertext 进 metadata.e2e，preview=`[E2E]`（:300-350；clipboard_capture.dart:452-462） | Rust 同（e2e_crypto.rs:50,347）；服务端校验 alg/epk/keys ≤32（clipboard.js:573-599） | ✅ |
| 测试向量 | `test/e2e_crypto_test.dart` 硬编码 `docs/plans/e2e-vector.json` 同一组向量对拍 + 反向往返 + 篡改/非法点/超上限异常路径（255 行，质量高） | Rust `#[cfg(test)]` 同向量 | ✅ |
| 私钥存储 | flutter_secure_storage（Android Keystore 加密），键 `e2e_device_priv_v1`；损坏/缺失显式抛错不静默重生成（e2e_crypto.dart:426-541） | — | ✅ |
| fail-closed | 加密原语失败中止发送不回退明文（clipboard_capture.dart:314-319,536-539）；「无收件人公钥回退明文」是协议 §5 约定的可用性降级 | — | ✅ |

**结论：加密算法层跨端逐字一致，「手机加密电脑解不开」不成立。但 E2E 开启后有三条旁路破坏承诺，见 S1-4。**

---

## 问题清单（按严重度从高到低）

### [S0-1] 登出/换账号不清本地数据：离线队列会把上个用户的剪贴板明文重放进新账号
- 证据：
  - `lib/providers/auth_provider.dart:229-246`：`logout()` 只清 TokenStore 双 token + deviceId，**不清** CacheService 磁盘缓存、PendingUploadQueue、ClipboardProvider 内存列表；
  - `lib/services/pending_upload_queue.dart:124,314-322`：队列明文存 SharedPreferences 键 `pending_upload_queue_v1`（≤200 条剪贴板原文）；
  - `lib/services/sync_service.dart:266-274`：重放门控只查 `auth.isAuthenticated`——**不区分是哪个用户**；
  - `lib/services/api_service.dart:161-184,79-94`：列表缓存键 `clipboard_list_page_N`、资料缓存键 `user_profile` 均不含用户 id，TTL 2min/5min，落盘 `documents/cache/*.cache`（cache_service.dart:87-91,304-320）。
- 失败场景：用户 A 在弱网下复制若干条内容（进离线队列）→ 登出 → 用户 B 登录 → 网络恢复事件或启动在线探测触发 `replayPending` → A 的剪贴板原文用 **B 的 token** POST /api/clipboard，进入 B 的账号并广播到 B 的电脑；另外 B 登录后 2 分钟内下拉前可能直接看到 A 的缓存列表、5 分钟内资料页显示 A 的 profile。
- 影响：跨用户数据泄露（隐私+数据），审计标准明列的 S0。
- 修法：logout 时清 PendingUploadQueue、`CacheService.instance.clear()`、`clipboardProvider.clearCache()`；缓存键加 userId 命名空间。

### [S0-2] 生产包默认后端地址 = 模拟器回环 `http://10.0.2.2:3001`，且全局 `usesCleartextTraffic=true`、无 network_security_config
- 证据：
  - `lib/services/server_config.dart:19-24`：Android 一律默认 `http://10.0.2.2:3001`（真机上不可路由），其余平台 `http://localhost:3001`；无 `kReleaseMode` 分支，全仓无任何生产域名；
  - `android/app/src/main/AndroidManifest.xml:28`：`android:usesCleartextTraffic="true"`；`res/xml/` 下只有 accessibility 配置，无 `network_security_config.xml`；
  - 唯一改地址入口：登录页第 613 行的隐藏点击 + 设置页「服务器设置」（settings_screen.dart:461-468，hint 还是 `http://localhost:3001`）。
- 失败场景：①任何新用户装 release APK → 所有请求打 10.0.2.2 → 登录都进不去，核心功能 100% 失效；②用户按引导填 `http://` 地址 → JWT、剪贴板全文、截图全部明文过网（中间人可窃取），系统不拦。
- 影响：可用性（发布即废）+ 安全（明文传输剪贴板与凭据）双 S0；这也是「生产包指向 localhost」检查项的直接命中。
- 修法：release 构建注入生产 HTTPS 域名作默认值；`usesCleartextTraffic=false` + network_security_config 仅对调试域名开豁免（或 debug manifest 单独开）。

### [S0-3] 后台自动采集唯一通道（无障碍服务）无授权引导入口，且项目自有真机记录显示该路径在 vivo 实测被拒
- 证据：
  - `screens/onboarding/permission_guide_screen.dart:203-217`：引导页 4 张卡=通知/电池/自启动/通知使用权，**无无障碍卡**；全仓无 `ACTION_ACCESSIBILITY_SETTINGS` 跳转（MainActivity.kt 通道方法清单 :53-109 里也没有）；
  - `QuickSyncActivity.kt:10-16`（原文）：「后台/无障碍路径在这台 ROM 上均被拒绝（AppOps 实测：READ 仅发生在 top 状态）」——与 `ClipboardAccessibilityService.kt:25-27`「无障碍服务属于系统信任组件，豁免剪贴板焦点限制」的声明直接矛盾；
  - `SyncForegroundService.kt:984-987`：无障碍未连接时经典路径后台读到 null（Android 10+ 焦点限制）。
- 失败场景：用户装好 App、完成全部引导（4 张卡全绿）→ 切到微信复制 → 电脑上永远等不到内容；用户不知道要去系统设置→无障碍里手动开一个没有任何应用内入口的服务。即使开了，在部分 ROM（至少团队实测的那台 vivo V2243A）上仍读不到。
- 影响：核心卖点「手机复制→电脑秒粘」在后台态默认不成立 = S0（按审计标准「核心同步在真机不成立」）。
- 修法：引导页/设置页加「无障碍采集」卡片（状态检测 `ClipboardAccessibilityService.isConnected` + 跳 `Settings.ACTION_ACCESSIBILITY_SETTINGS`），并在华为/小米/OPPO/vivo/三星 × Android 12-15 真机矩阵实测无障碍读取可行性；不可行的 ROM 明确降级为 QuickSync 手动方案并在 UI 说明。

### [S1-1] JWT 过期后：WS 重连握手用陈旧 token、原生直传凭据不刷新 → 常驻进程 24h/7d 后同步全线静默死亡
- 证据：
  - `lib/services/ws_service.dart:113-114,133`：`_connect()` 握手 query 用字段 `_token`（connect() 时传入后不再更新）；对比 `_fetchWsCsrf():84` 每次重新 `TokenStore.getAccessToken()`——同一次连接里 csrf 用新 token、握手用旧 token；
  - `lib/main.dart:114-129`：网络恢复钩子取 `authProvider.token`，而 `AuthProvider._token` 只在冷启动 `_loadToken`/登录时更新（auth_provider.dart:77-108,211），`TokenStore.refreshAccessToken()` 成功后**不回写** AuthProvider；
  - `lib/main.dart:85-108`：`syncConfigToNative` 只挂 authProvider/settingsProvider 监听器，静默续期不触发 → 原生 `clipsync_sync_config` 里的 token（SyncForegroundService.kt:176-185）过期后，截图直传（:1387）、无障碍文本直传（NativeClipboardUploader.kt:36,49）、PC 图片拉取（:806）全部 401 静默失败（原生无 refresh 能力）；
  - 服务端 TTL：`config/production.js:30` 默认 `24h`（.env.production 设 7d）。
- 失败场景（可复现时序）：手机保持前台服务常驻、App 不重启 → 超过 token TTL → WS pong 看门狗触发重连 → csrf 拿到（Bearer 已续期）→ 握手带过期 token → 服务端 `ws.close(4002)`（ws/server.js:147-149）→ 退避重连 10 次全 4002 → 永久放弃；同时原生直传 401 静默停摆。用户看到的状态：手机复制不再到电脑、PC 图片不再进相册，**无任何报错**，重启 App 才恢复。
- 影响：核心同步在「长期后台常驻」这一主打场景下必然周期性失效（S1，接近 S0）。
- 修法：`_connect()` 握手前重新 `TokenStore.getAccessToken()`；refresh 成功后广播事件同步 AuthProvider._token 与原生 prefs（复用 syncConfigToNative）。

### [S1-2] WS 重连 10 次（约 2.5 分钟）后永久放弃，App 回前台无重连钩子
- 证据：`ws_service.dart:19,294`：`_reconnectAttempts >= 10` 直接 return（无定时器再试）；退避序列 1/2/4/8/16/30×5≈181s。唯一复活入口是 `connectivity_plus` 网络变化事件（sync_service.dart:244-251）；`main.dart:521-535` 的 `didChangeAppLifecycleState` 只处理生物锁布防，**resumed 不做 ensureConnected**；home_screen 的 connect 只在 initState 执行一次（IndexedStack 保活不再触发）。
- 失败场景：用户在家里 WiFi（网络从未变化）→ 服务端重启/发版 5 分钟 → 手机重连 10 次耗尽后永久静默 → 用户把 App 切回前台看列表（HTTP 正常）也**不会**触发 WS 重连，实时同步死到下次网络切换或杀进程重开。剪贴板页顶部会显示「离线」（clipboard_screen.dart:484-485），但不会自愈。
- 影响：主流程（实时同步）无恢复机制，S1。
- 修法：`AppLifecycleState.resumed` 时调 `wsProvider.ensureConnected`；或放弃上限改为永久退避（封顶 5min）。

### [S1-3] 绝大多数 HTTP 请求无超时：弱网下 UI 永久转圈
- 证据：`http` 包无默认超时；带 `.timeout(` 的仅 24 处。逐文件统计（http 调用数 vs timeout 数）：api_service.dart 17:4（getClipboardItems:173、getItemContent:195、toggleFavorite、delete、devices、sessions、templates 等全部裸奔）、collections_api_service 9:0、item_actions 6:0、subscription 5:0、template_variables 5:0、search_history 5:0、notification_settings 4:0。
- 失败场景：用户在地铁/电梯弱网（TCP 能建立、响应不来）打开收藏夹/模板/订阅页 → `await` 永不返回 → 加载圈永久转，无错误态、无法重试，只能杀 App。
- 影响：可用性 S1（审计标准「无超时导致 UI 永久挂起」直接命中）。
- 修法：封装统一 HttpClient（connect/receive 15s 超时 + 401 静默续期拦截），所有 service 走同一入口。

### [S1-4] E2E 开启后三条旁路破坏端到端承诺：原生采集明文上传、原生回写把密文写进剪贴板、系统分享文本不加密
- 证据：
  - `NativeClipboardUploader.kt:53-60`：无障碍采集/QuickSync 的文本以 `contentEncrypted=原文` 明文直传，**无任何 E2E 分支**；`updateSyncConfig`（main.dart:93-99 → SyncForegroundService.kt:176-185）也从不把 `e2e_enabled` 下发给原生——原生根本不知道 E2E 开着；
  - `SyncForegroundService.kt:851-868`：原生轮询把 PC 条目的 `contentEncrypted` 不判 `metadata.e2e` 直接 `setPrimaryClip` 写入手机系统剪贴板 → E2E 条目写入的是 base64 密文（用户粘贴出一串乱码，且密文暴露给任意前台 App）；E2E 图片走 `/api/media/:id/download` 必 404（E2E 图片无媒体文件，main.dart:211 注释自证）→ 相册自动保存静默失效；
  - `screens/share/share_receive_screen.dart:139-159`：`_uploadText` 明文 POST，无 E2E 分支（对比同文件 `_uploadImage` 有 `uploadImageMaybeE2e` 三态）。
- 失败场景：用户开启「端到端加密」开关（settings_screen.dart:620-636）后：①手机经无障碍/一键同步上传的文本仍是明文入库（服务端可全文搜索、可审计）——与开关文案「服务端无法全文搜索该内容」直接矛盾；②PC 复制加密文本 → 手机剪贴板变成密文乱码；③经系统分享面板存的文本明文入库。
- 影响：安全承诺失效 + 核心功能（PC→手机回写）在 E2E 模式下损坏。E2E 默认关（协议 §5），故评 S1 而非 S0。
- 修法：E2E 开启时经 updateSyncConfig 下发标志，原生采集/回写路径禁用（或回传 Dart 处理）；分享文本走 `_encryptText` 同款三态。

### [S1-5] 凭据与 OTP 打进 release 日志：WS URI（含 JWT+csrf）print 到 logcat；原生把短信验证码明文写 Log.i；ProGuard 日志剥离被注释
- 证据：
  - `ws_service.dart:140`：`print('[WsDebug] channel opened uri=${uri.toString()}')`——URI 含 `?token=<JWT>&csrf_token=<64hex>`；`print()` 在 release 构建照常输出 logcat（另有 :121,164,253 等共 10 处 `[WsDebug]` print，绕过了 `avoid_print` lint）；
  - `KeepAliveNotificationListener.kt:71`：`Log.i(TAG, "OTP captured from $pkg: $code — pushing to PC")`——验证码明文进日志；
  - `android/app/proguard-rules.pro:66-75`：`-assumenosideeffects class android.util.Log {...}` 整段被注释。
- 失败场景：任何装了 release 包的手机上，`adb logcat`（或崩溃收集 SDK、厂商日志上传）即可拿到有效期 7d 的 access token → 完整接管账号；同设备的其它日志读取方能看到银行/短信验证码。
- 影响：凭据泄露 + OTP 泄露，S1。
- 修法：删 `print(uri)`（或脱敏）；OTP 日志去掉 code 值；启用 ProGuard Log 剥离；Dart 侧统一 logger 并按 kReleaseMode 关闭。

### [S1-6] `allowBackup` 未关（默认 true）+ 明文敏感数据落在可备份区：剪贴板原文队列、列表缓存、原生 JWT
- 证据：
  - `AndroidManifest.xml:23-28`：`<application>` 无 `android:allowBackup="false"`，无 `dataExtractionRules`/`fullBackupContent` → 默认允许 Android 云备份/迁移；
  - 备份范围内明文数据：`pending_upload_queue_v1`（剪贴板原文 ≤200 条，pending_upload_queue.dart:314-322）、`documents/cache/clipboard_list_page_*.cache`（含 contentPreview 的完整列表 JSON，cache_service.dart:304-320）、原生 `clipsync_sync_config.xml`（**access token 明文** + baseUrl + deviceId，SyncForegroundService.kt:176-185）。
- 失败场景：用户换机迁移/云备份 → 全部剪贴板明文与有效 JWT 进入备份通道；root 设备或取证场景直接读 XML。（flutter_secure_storage 部分因 Keystore 不可迁移，反而安全。）
- 影响：隐私 S1（审计标准「明文剪贴板可被拉走」命中；「token 明文存原生 SharedPreferences」单列也是安全问题）。
- 修法：`allowBackup=false` + `dataExtractionRules` 排除；原生 token 至少改 EncryptedSharedPreferences；队列/缓存考虑加密或改用应用 cache 目录（不参与备份）。

### [S1-7] 测试近乎为零：4 个文件 475 行 vs 36,575 行业务代码（≈1.3%），同步/采集/网络层零覆盖
- 证据：`test/` 仅 4 文件——`e2e_crypto_test.dart`（255 行，向量对拍+异常路径，质量高，是全仓唯一真测试）、`login_screen_test.dart`（105 行渲染断言）、`profile_screen_test.dart`（70 行回归）、`widget_test.dart`（45 行，**空壳**：只 pump 了一个手写的 `Text('ClipSync')`，连真实 App 都没构建）。无 integration_test 目录。
- 缺口：WsService 重连/看门狗、ClipboardCapture 五层去重、PendingUploadQueue 重放、CacheService、全部 API service、ClipboardProvider（1064 行核心状态机）、模型解析、路由守卫——全部零测试。这些恰是「用户自己还没测完」的同步链路。
- 影响：工程质量 S1（按审计标准「3.7 万行测试近乎为零」直接命中）。
- 修法：优先给 WsService（fake channel）、PendingUploadQueue（SharedPreferences mock）、ClipboardCapture 去重、ClipboardItem/Page 解析补单测；核心卖点链路补一条 integration_test。

### [S2-1] logout 不调服务端注销接口，refresh token 登出后仍有效
- 证据：`auth_provider.dart:229-246` 无任何 HTTP 调用；服务端明明有 `POST /api/auth/logout`（routes/auth-session.js:70）。
- 失败场景：手机丢失/借出后用户「退出登录」→ 攻击者若已提取 secure storage 之外的任何凭据副本（如 S1-6 的原生明文 token），或服务端会话列表里该会话仍活跃可被继续刷新。
- 影响：安全 S2。修法：logout 时 best-effort 调 /api/auth/logout 吊销当前会话。

### [S2-2] 原生 PC 内容拉取只扫第 1 页 10 条 + 亮屏 4 秒一次 HTTP 轮询
- 证据：`SyncForegroundService.kt:817`：`GET $baseUrl/api/clipboard?page=1&limit=10`；游标推进到本页最新 `createdAt`（:824-828,872-874）；间隔 4s（亮屏）/30s（灭屏）（:80-82）。
- 失败场景：PC 端一次性复制/截图 >10 条（或批量导入）→ 第 10 条以前的旧条目被游标跳过，永久不入相册/不回写；另外每台手机亮屏期间 4 秒一个请求，对服务端是持续 QPS 压力、对手机是耗电。
- 影响：数据丢失边界 + 性能/电量，S2。修法：循环翻页直到 createdAt ≤ cursor；间隔放宽或改由 WS 驱动、轮询仅作兜底（60s+）。

### [S2-3] 原生幂等键每次重试重新生成，幂等语义失效
- 证据：`NativeClipboardUploader.kt:41-51`：`Idempotency-Key: mobile-native-${System.nanoTime()}` 在 `for (attempt in 1..3)` 循环体内每次生成新值。
- 失败场景：第 1 次请求已被服务端入库但响应超时 → 第 2 次换了幂等键 → 若超出服务端 content_hash 5 分钟去重窗口则重复入库。
- 影响：数据重复 S2（Dart 侧做对了：clipboard_capture.dart:304-307 一键贯穿）。修法：键提到循环外一次生成。

### [S2-4] 通知栏明文展示剪贴板内容，锁屏可见，无隐藏开关
- 证据：`local_notification_service.dart:207,244-249`：body=内容预览（80 字符），长文本走 BigTextStyle 全文进通知；无「通知隐藏内容」设置。
- 失败场景：PC 复制密码/验证码 → 手机锁屏通知直接显示明文，旁人可见。
- 影响：隐私 S2。修法：加设置项（默认或提供「仅显示来源设备」模式），敏感类型（E2E 条目已做占位）扩展到通知层。

### [S2-5] 权限清单含未使用项 + 敏感项需商店申报
- 证据：`AndroidManifest.xml:19`：`CHANGE_WIFI_MULTICAST_STATE`——全仓无 `createMulticastLock`（只用了 WifiLock，SyncForegroundService.kt:369，那只需要 `ACCESS_WIFI_STATE`）→ **多余权限**，国内商店/Play 审核会被质询；`:15` `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 属 Google Play 受限权限（需提交核心功能申报，剪贴板同步可豁免但要填表）；`:27` `requestLegacyExternalStorage="true"` 仅对 targetSdk≤29 有意义，属遗留。无障碍服务本身在 Play 政策下需申报用途（描述文案已写明不读屏幕内容，`canRetrieveWindowContent=false` 是加分项）。
- 影响：上架合规 S2。修法：删 multicast 权限与 legacy 标志；准备 Play/国内商店的权限用途说明。

### [S2-6] 签名配置静默回退 debug：key.properties 缺失时 release 用 debug 签名且无任何警告
- 证据：`android/app/build.gradle.kts:8,55-60`：`signingConfig = if (hasReleaseKeystore) release else debug`。（签名卫生本身合格：`key.properties` 与 `*.jks` 均已 gitignore——`android/.gitignore:12,15-17`，git 历史无泄露记录，密码未硬编码进 gradle。）
- 失败场景：CI/新机器上没有 key.properties → 打出 debug 签名的「release」包被误发布 → 用户后续无法用正式签名覆盖升级，且 debug 包可被任意重签。
- 影响：发布工程 S2。修法：release 构建缺 keystore 时直接 fail（或 `--stacktrace` 级警告 + CI 校验签名指纹）。

### [S2-7] i18n 半吊子：原生层与多个 Dart 页面硬编码中文，英文用户大面积看到中文
- 证据：
  - 原生：常驻通知「ClipSync 同步运行中/正在保持剪贴板同步」（SyncForegroundService.kt:692-693）、QuickSync Toast「剪贴板已同步/暂无新内容」（QuickSyncActivity.kt:57-61）、磁贴 label「同步剪贴板」（AndroidManifest.xml:123）、无障碍名称/描述（res/values/strings.xml:3-4）——全部只有中文，无 values-en；
  - Dart：`item_detail_screen.dart:444,1300,1408-1443,1980-2161,2230` 约 20 处 `isZh ? '中文' : 'English'` 三元硬编码；`shared_links_screen.dart:671-683` 纯中文（'剩余 X 分钟'）；`settings_screen.dart:625-636` E2E 开关标题/副标题纯中文（注释自认「硬编码中文兜底」）；`local_notification_service.dart:210,225`（'[图片]'、'来自 $sourceDevice'）；`main.dart:334`（'🔒 端到端加密内容'）。
- 影响：i18n S2（en 是 arb 模板语言，英文用户占比未知但商店国际化受阻）。修法：原生文案进 strings.xml + values-en；Dart 硬编码收编进 arb。

### [S2-8] 「1Password Knox 级加密保护」文案：冒用第三方商标 + 夸大保护级别
- 证据：`item_detail_screen.dart:1300`：「此条目已启用 1Password Knox 级加密保护」；:1408 'Knox 安全揭示模式'。实际机制=服务端密码解锁（/api/protection/unlock）+ 本地 60 秒自动重锁（:278-293），与 1Password/Knox 无任何关系；受保护条目的内容本身并不额外加密存储。
- 影响：产品诚信/法务（商标）S2。修法：改为中性文案「密码保护条目」。

### [S2-9] 「清理缓存」按钮清不掉真正的磁盘缓存（虚假完成）
- 证据：`settings_screen.dart:130-152`：只调 `provider.clearCache()`（内存）+ 删除 SharedPreferences 键 `clipboard_cache`——**该键全仓无写入方**（真实缓存在 `documents/cache/*.cache`，由 CacheService 管理，从未被此处清理）。
- 失败场景：用户想清掉本地剪贴板痕迹 → 点「清理缓存」→ 提示成功 → 磁盘上的列表缓存/离线队列原样保留。
- 影响：产品诚信 + 隐私 S2。修法：调用 `CacheService.instance.clear()` 并清 PendingUploadQueue。

### [S2-10] 通知里「来自 X 设备」字段服务端从未下发（契约静默失败）
- 证据：`main.dart:329` 读 `item?['sourceDeviceName']`；服务端广播（clipboard.js:736-750）只含 `sourceDeviceId`。`local_notification_service.dart:225,233,241,248` 的 `sourceDevice != null ? '来自 $sourceDevice' : ...` 永远走 fallback。
- 影响：功能静默缺失 S2（多设备用户无法从通知分辨来源）。修法：服务端广播补 `sourceDeviceName`（列表接口已有 JOIN），或客户端用 DeviceProvider 本地映射 id→name。

### [S2-11] 发布工程：versionName 0.1.0(+1)、Dart SDK 约束钉死 dev 通道、compileSdk 37 前沿绑定
- 证据：`pubspec.yaml:4`：`version: 0.1.0+1`（versionCode=1，v1 上线应 1.x）；:7 `sdk: ^3.13.0-167.0.dev`（要求 dev 通道 SDK 才能构建，`pubspec.lock:1094` 同证）；`build.gradle.kts:19` `compileSdk = 37`，注释自证是 receive_sharing_intent 的 AAR 要求。
- 影响：dev SDK + 前沿 compileSdk 构建生产包，工具链回归风险高；versionCode 管理缺失影响后续覆盖升级。S2。修法：切 stable 通道、锁 LTS 化依赖、版本管理进 CI。

### [S3-1] 死代码 ≈1,100+ 行
- `utils/lazy_load.dart`（468 行）与 `utils/animations.dart`（293 行）全仓零引用；`ApiService.syncPush/syncPull/getSyncStatus`（api_service.dart:306-354）零调用；`SettingsProvider.wifiOnly/autoSync/darkMode`（settings_provider.dart:11-14,127-138）无消费方（setWifiOnly/setAutoSync 无 UI 调用）；`home_screen.dart:62-67` `_tabTitleKeys` 定义未用；`DeviceProvider.registerDevice` 的 `publicKey` 参数「预留未接线」（device_provider.dart:44-45 自注）。

### [S3-2] 资源未释放 / 小泄漏
- `item_detail_screen.dart:326`：`_showUnlockDialog` 创建的 `TextEditingController` 从未 dispose（每次解锁弹窗泄漏一个 controller）；`share_intent_listener.dart:84-87` 的 `dispose()` 全仓无人调用（单例可接受，但 stream subscription 生命周期与进程同长，属设计取舍）。

### [S3-3] 超长文件 Top10（行数）
2810 `l10n/app_localizations.dart`（生成物）｜2443 `item_detail_screen.dart`｜1493/1435 l10n en/zh（生成物）｜1478 `SyncForegroundService.kt`｜1158 `collection_items_screen.dart`｜1064 `clipboard_provider.dart`｜897 `subscription_management_screen.dart`｜844 `templates_screen.dart`｜837 `settings_screen.dart`｜820 `clipboard_card.dart`/`login_screen.dart`。手写代码中 item_detail_screen 与 SyncForegroundService.kt 急需拆分。

### [S3-4] 回声抑制用截断 preview 登记，长文本可重复入库
- `clipboard_capture.dart:616-626`：`EchoAwareClipboardProvider.handleNewItem` 登记的是 `contentPreview`（服务端截断 5000 字符）；>5000 字符的条目用户再复制全文时哈希对不上，且服务端 content_hash 去重仅 5 分钟窗口 → 重复条目。（服务端去重兜底大部分场景，边缘。）

### [S3-5] friendlyError 兜底把原始异常文本直出给用户
- `app_exception.dart:298-306`：非 AppException 的 `Exception` 直接 `toString()` 去前缀后上屏——可能出现「SocketException: Connection refused (OS Error...)」类技术英文；登录页则把服务端 message 直出（api_service.dart:63-72，服务端文案本身是中文，可接受）。

---

## Android 打包与上架合规核对

| 项 | 现状 | 判定 |
|---|---|---|
| 权限清单必要性 | INTERNET✅ USE_BIOMETRIC✅ FOREGROUND_SERVICE(+DATA_SYNC/+SPECIAL_USE)✅ RECEIVE_BOOT_COMPLETED✅（BootCompletedReceiver 实现存在） POST_NOTIFICATIONS✅ REQUEST_IGNORE_BATTERY_OPTIMIZATIONS✅（需 Play 申报） WAKE_LOCK✅ ACCESS_WIFI_STATE✅（WifiLock） **CHANGE_WIFI_MULTICAST_STATE❌未使用** READ_EXTERNAL_STORAGE(≤32)✅ WRITE_EXTERNAL_STORAGE(≤28)✅ READ_MEDIA_IMAGES✅（截图检测） | 1 项多余（S2-5） |
| targetSdk/minSdk | `targetSdk = flutter.targetSdkVersion`、`minSdk = flutter.minSdkVersion`（build.gradle.kts:34-35，跟随 Flutter stable 默认，compileSdk 37）；满足 Google Play 当前 target API 要求与国内商店（≥33）要求 | ✅（随 SDK 漂移，发版前需核对具体值） |
| 版本号 | versionName 0.1.0 / versionCode 1（pubspec.yaml:4） | ⚠️ S2-11 |
| 签名卫生 | keystore 密码在 `android/key.properties`（未入库，`.gitignore:12` 忽略；`*.jks` 亦忽略；`git log --all` 无历史泄露；gradle 无硬编码密码，从文件读取 build.gradle.kts:40-47） | ✅ 合格；但缺省回退 debug 签名为 S2-6 |
| 混淆/压缩 | `isMinifyEnabled=true` + `isShrinkResources=true` + proguard-rules.pro（build.gradle.kts:52-54）；Log 剥离段被注释（S1-5）；Flutter 侧未用 `--obfuscate`（Dart 符号未混淆，可选） | ✅ 基本合格 |
| cleartext | `usesCleartextTraffic="true"` 全局放开（AndroidManifest.xml:28），无 network_security_config | ❌ S0-2 |
| allowBackup | 未显式声明 → 默认 true；无 dataExtractionRules/fullBackupContent | ❌ S1-6 |
| ABI 分包 | splits arm64/armeabi-v7a/x86_64 + universal；bundle 全 split（build.gradle.kts:64-85）；注意 splits 下各 ABI 包 versionCode 相同，国内商店多包上传需自查 | ⚠️ 提示 |
| 前台服务合规 | API34+ 用 specialUse + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 用途声明（AndroidManifest.xml:66-74；SyncForegroundService.kt:648-668）；dataSync 类型兼容 29-33 | ✅ 设计正确（Play 审核仍需用途说明） |

---

## 健壮性清单（空断言 / async gap / 未捕获 Future / 空 catch）

总体评价：空安全纪律好于平均——`analysis_options.yaml` 开了 strict-casts/strict-inference/strict-raw-types + flutter_lints（含 use_build_context_synchronously、unawaited_futures），模型层全防御解析，89 处 `!` 断言抽查绝大多数有前置守卫（如 cache_service 的 `_cacheDir!` 均在 null 检查后）。剩余风险点：

**空断言（抽样，均有守卫或低风险）**
- `providers/auth_provider.dart:85,91,219` `_token!`——前置 `_isAuthenticated`/`is! String` 检查，安全；
- `services/ws_service.dart:79` `_token!.isEmpty`——同行前置 null 判断，安全；
- `screens/notifications/notifications_screen.dart:399` `item.content!`、`screens/favorites/collection_items_screen.dart:999` `entry.deviceName!`——需 UI 分支守卫，未逐一验证，建议复查；
- `screens/clipboard/clipboard_search_bar.dart:172` `_historyOverlay!`——insert 前构造，低风险。

**async gap 后使用 context**：抽查 login/home/settings/item_detail/sessions_section 主要路径均有 `if (!mounted) return` 或提前捕获 `ScaffoldMessengerState`/`AuthProvider` 引用（如 home_screen.dart:479-481、sessions_section.dart:276-284），未发现裸奔；lint 已启用兜底。

**空 catch（吞错）**
- `services/api_service.dart:71`（登录错误 detail 解析失败吞掉——可接受）；
- `services/sync_service.dart:179`（finishScreenshotProcessing 吞错——可接受，注释合理）；
- `services/clipboard_capture.dart:569`（E2E 图片响应体解析失败吞掉——response 置 null 会导致调用方误判 aborted，建议记日志）；
- `screens/login_screen.dart:266`（保存 server_url 失败静默——用户以为切了服务器，建议提示）；
- `services/ws_service.dart:102,261,277`（网络重试/sink 关闭——有意为之，有注释）。

**未捕获/悬空 Future**：`unawaited(...)` 使用规范（lint 强制）；`main.dart:341,386` 的 `Future(() async {...})` 内部自带 try/catch，安全。真正的「静默失败」集中在原生 HTTP 路径（NativeClipboardUploader/uploadScreenshotNatively 失败仅 Log.w，无用户可见反馈、无入队补偿——截图直传失败 3 次后该截图永久丢失，`SyncForegroundService.kt:1373-1435` 无失败落盘重试队列）。

**JSON 解析**：无 `int.parse`/`double.parse` 裸用（0 处）；`jsonDecode(...) as` 强转仅 4 处，其中 `api_service.dart:257`（devices 响应必须为数组，服务端契约稳定）与 cache/error_report 的本地文件解析（失败走 catch 重建），可接受。

---

## 测试现状

- 文件数：4；总行数：475；业务代码 36,575 行 → **测试占比 ≈1.3%**。
- 覆盖：`e2e_crypto_test.dart`（255 行）是唯一实质性测试——跨端向量对拍、多接收方、篡改检测、非法公钥、上限校验，质量高；`login_screen_test.dart`/`profile_screen_test.dart` 为渲染/回归冒烟；`widget_test.dart` 是**空壳**（pump 的不是真实 App）。
- 缺口（全部为零）：WsService（重连/看门狗/epoch 竞态）、ClipboardCaptureService（五层去重/E2E 三态）、PendingUploadQueue（重放/幂等/容量淘汰）、CacheService、ClipboardProvider（1064 行核心状态机）、全部 API service、模型解析、路由守卫/生物锁门控、原生 Kotlin（2,329 行，无 androidTest）。无 integration_test。
- 结论：S1-7。用户「真机没测完」的风险恰恰集中在零测试的同步链路上。

---

## 设计层面的观察

1. **架构与状态管理统一**：provider + ChangeNotifier 单一方案，无混用；单例服务（SyncService/ClipboardCaptureService/PendingUploadQueue/E2eCrypto）经 main.dart 显式接线，依赖流向清晰。全局钩子（`WsService.globalNewClipboardHook` 等静态回调）是把双刃剑：绕开了 Provider 层级但也让 main.dart 膨胀成 596 行的「上帝初始化」，WS 业务逻辑（图片自动入相册、回写、E2E 解密）散在 main.dart 闭包里，难测试（这正是零测试的结构性原因）。
2. **双通道同步设计（Dart WS + 原生轮询）是清醒的**：团队明确认识到 Flutter 引擎在锁屏/冻结下不可靠，把截图直传、PC 内容拉取下沉原生——方向正确。代价是逻辑重复两份（回声抑制、去重、E2E 判断只在 Dart 侧完整），S1-4 正是这种「原生侧没有跟上 Dart 侧演进」的典型裂缝。建议给原生路径立「契约清单」并让 E2E 等开关经 updateSyncConfig 全量下发。
3. **保活策略激进但自知边界**：闹钟自愈链（2min）、NotificationListener 锚点、onTaskRemoved 重启、开机自启都做了，且注释诚实标注「force-stop 无法代码绕过」。风险在 Google Play 政策（specialUse FGS + 通知监听 + 无障碍 + 开机自启组合会被重点审查），国内商店无碍。
4. **无障碍采集的合规叙述做得不错**（canRetrieveWindowContent=false、描述声明不读屏幕），但缺引导入口让这套机制形同虚设（S0-3）。
5. **注释质量极高**：几乎每个非平凡决策都有「为什么」+ 真机踩坑记录（双通道互踢、boundary 前导 = 被 busboy 吞、RELATIVE_PATH 尾斜杠等）。这是审计中少见的好习惯——也正因如此，QuickSyncActivity 与 ClipboardAccessibilityService 两处矛盾注释才格外值得当真。
6. **缓存策略偏激进**：列表/资料 2-5 分钟磁盘缓存对「实时同步」产品是反模式（用户下拉前看到旧数据 + 制造了 S0-1 的跨用户残留面）。建议列表缓存降为纯内存。

---

## 建议补充的功能（按性价比排序）

1. **无障碍采集引导卡 + 状态自检页**（S0-3 配套）：引导页加卡片、设置页显示「后台采集：已连接/未授权/被系统拒绝」实时状态——没有它，客服会被「为什么不同步」淹没。
2. **同步诊断页**：一键检测 WS 连接、token 有效期、前台服务、无障碍、电池豁免、服务器可达性，输出可复制的诊断码。真机排障成本极高，这个页面能省掉大量远程支持。
3. **App 回前台 ensureConnected + token 续期广播**（S1-1/S1-2 的功能化形态）。
4. **通知内容隐私开关**（隐藏内容/仅来源设备），配合锁屏场景。
5. **统一 HTTP 客户端**（超时 + 401 刷新拦截 + 重试策略一处收敛），顺手消灭 S1-3 与 S2-14 类问题。
6. **原生截图直传失败落盘补偿队列**：3 次失败后写入本地队列，网络恢复重放（Dart 侧 PendingUploadQueue 已有同款，可复用契约）。
7. **release 构建变体的服务器地址固化**（build flavor / --dart-define 注入生产域名），消灭隐藏入口依赖。
8. 拆分 `item_detail_screen.dart`（2443 行）与 `SyncForegroundService.kt`（1478 行）；删除 1,100 行死代码。
