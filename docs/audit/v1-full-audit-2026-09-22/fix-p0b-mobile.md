# P0-B 移动端修复记录（拆利用链 · src/mobile）

日期：2026-09-23 ｜ 范围：仅 `src/mobile/**` ｜ 依据：`09-mobile-flutter.md`（S0-1 / S1-4 / S1-5 / S1-6）
验证约束：本批禁止 `flutter run/build`、adb、`pub get`——所有涉及真机行为与 release 构建的结论均标注「未经真机/构建验证」。

---

## 1. 修复 1（S0-1）：登出/换账号不清本地数据 → 已修

### 收敛点
所有登出路径已收敛到 `AuthProvider.logout()` → `SessionCleanup.purgeAll()`（新文件 `lib/services/session_cleanup.dart`）：

| 登出路径 | 入口 | 是否收敛 |
|---|---|---|
| 设置页主动登出 | `settings_screen.dart:_confirmLogout` → `auth.logout()` | ✅（原有调用链不变） |
| 当前会话被吊销 | `sessions_section.dart:_revoke` → `auth.logout()` | ✅ |
| 管理台远程下线（force_logout） | `main.dart` 全局钩子 → `auth.logout()` | ✅ |
| 冷启动凭据彻底失效 | `auth_provider.dart:_loadToken` → 原来只 `TokenStore.clear()`，**现补** `purgeAll()` + 删设备 id | ✅ |

### 登出清理范围清单（桌面端对齐用）

**内置核心清理（SessionCleanup 直接执行，不依赖注册，冷启动早期也生效）：**
1. `PendingUploadQueue`：内存 + 当前用户命名空间持久化键 + 旧版无命名空间键（离线剪贴板明文，≤200 条）
2. `CacheService`：全部内存缓存 + 磁盘缓存目录（`documents/cache/*.cache`，含剪贴板列表 contentPreview、user_profile、device_list）+ 用户命名空间复位
3. SharedPreferences `pending_error_reports`（本地错误报告，含 userId 与堆栈）

**注册任务（main.dart 注册，内存 Provider 态与原生侧）：**
4. `WsProvider.disconnect()`——WS 通道断开（原设置页登出路径不断 WS，B 登录后可收到 A 账号推送）
5. `ClipboardProvider.clearUserData()`——列表条目、E2E 已解密明文缓存、本机 deviceId 缓存、搜索历史本地镜像、筛选态、错误态
6. `DeviceProvider.clear()`——设备列表（为此把 DeviceProvider 改为 main() 创建 + `.value` 注入，与 wsProvider 同模式）
7. `FeatureFlagsProvider.reset()`——功能开关/套餐/维护模式快照
8. `ClipboardCaptureService.resetLocalState()`——采集去重哈希环、失败冷却表、E2E 收件人公钥缓存
9. `LocalNotificationService.cancelAll()`——撤销全部本地通知（通知正文含剪贴板内容预览）
10. 原生 `clipsync_sync_config.xml` 抹除：`updateSyncConfig(token:null, deviceId:null, e2eActive:false)`——**此前登出后原生 SharedPreferences 仍残留 JWT 明文**，常驻进程可继续直传
11. 凭据（logout 原有逻辑保留）：`TokenStore.clear()`（access+refresh，secure storage）+ secure storage `auth_device_id`

**明确保留（设备级设置，确认不含用户数据）：**
- `server_url`（后端地址）、`theme_mode`/`dark_mode`、`language`、`onboarding_completed`、`permission_guide_shown`、`biometric_lock_enabled`、采集/回写/截图同步等开关（`clipboard_capture_enabled` 等）
- **E2E 设备私钥 `e2e_device_priv_v1`（secure storage）不删**：它是设备级密钥对而非用户数据；删除会导致同一用户「登出→重登」后历史 E2E 条目永久不可解密（重注册公钥变化）。跨用户角度：信封 KEK 以 deviceId 为 HKDF info，B 重新注册获得新 deviceId，无法用 A 的信封解出内容。若桌面端语义不同请以本清单为准对齐。

### 防御性隔离（userId 命名空间）
- 离线队列键：`pending_upload_queue_v1` → `pending_upload_queue_v1:u_<userId>`（未绑定用户时 `:anonymous`）；`bindUser()` 在登录收尾（`_completeLogin`）与冷启动恢复（`_loadToken` 拿到 profile）时调用。
- 缓存键：`CacheService` 全部 get/set/remove 加 scope 前缀（`u_<userId>:` / `anonymous:`），登录绑定、登出复位；切换 scope 即清空内存缓存。
- **旧数据处置：无命名空间的旧队列/旧缓存文件一律丢弃**（`_ensureLoaded` 与 `initialize` 时删除）——归属用户不可判定，保留即串号风险；用户代价仅为升级后丢失最多 200 条未上传积压与 ≤1h TTL 的缓存。

### 未动（按批次纪律）
- 同步时序/重连逻辑零改动（S1-1/S1-2 属 P1-A）。
- S2-1（logout 不调服务端注销接口）不在本批。

### 测试
`test/session_cleanup_test.dart`（7 个用例，全部通过）：核心场景「A 入队 2 条 → purgeAll → B 绑定 → replayPending=0、上传器零调用、A 持久化键已删」；旧键丢弃；命名空间兜底（即使漏清理 B 也读不到 A 的键）；CacheService scope 隔离；purgeAll 清错误报告。

---

## 2. 修复 2（S1-4 回写旁路）：E2E 密文写回系统剪贴板 → 已修（选方案 b，最小干预）

### 选择与理由
选 **(b) 原生层跳过 E2E 条目**。判断依据：E2E 私钥只存于 Dart 侧 `flutter_secure_storage`（键 `e2e_device_priv_v1`，`e2e_crypto.dart:432`），原生层不可及；方案 (a) 需原生↔Dart 跨层解密回调，而原生轮询路径的存在前提就是「引擎可能冻结」，跨层方案在冻结时同样失效，代价大且不更可靠。

### 改动（`SyncForegroundService.kt` pullRemoteImages 循环内，+7 行）
条目 `metadata.e2e` 信封存在（与 Dart `_isE2eItem` 同判定、列表接口确实下发 metadata）→ 跳过该条（不写剪贴板、不试 `/api/media/:id/download`——E2E 图片该接口必 404），打一条 `Log.i` 说明。**非 E2E 条目路径零改动，同步时序零改动。**

### 对真机同步测试的影响（未经真机验证）
- E2E 关闭（默认）：行为与改前完全一致，不影响用户即将做的同步测试。
- E2E 开启：PC→手机文本回写改由 Dart WS 路径负责（`main.dart` globalNewClipboardHook 已有解密回写，改前改后都在）；引擎冻结期间原生轮询不再回写（改前是把 base64 密文写进剪贴板——那本来就是坏的）。**残余缺口（最小干预而非完整修复）**：引擎冻结时到达的 E2E 文本条目，原生游标推进后不会再回写，用户需在 App 内查看/复制（列表点开即解密）。完整方案（原生检测到 E2E 条目时唤醒引擎或落 pending 表）留给后续批次。

### S1-4 另两处旁路
- **原生采集明文上传（已修，代价小）**：`e2eActive`（= 本地开关 ∧ 套餐特性位，Dart 侧与 `_isE2eEnabled` 同口径计算）经 `updateSyncConfig` 下发原生持久化；`NativeClipboardUploader.uploadAsync` 在 e2eActive 时不再明文直传，改经 `dartChannel` 走 `onClipboardCaptured` 交 Dart 加密管线（含去重/离线队列）；通道不可达时 fail-closed 丢弃并 `Log.w`（与协议 §3 fail-closed 哲学一致，绝不回退明文）。覆盖三条调用方：无障碍采集、QuickSync 一键同步、通知栏 OTP 接力。**E2E 关闭时（默认，含用户即将做的同步测试）此路径零变化。**
- **分享文本不加密（已修）**：`share_receive_screen._uploadText` 先走新增的 `ClipboardCaptureService.uploadTextMaybeE2e`（三态，与 `uploadImageMaybeE2e` 同构：双闸门关/无收件人公钥回退明文链路；加密或上传失败 fail-closed 不回退）。
- 已知边界：e2eActive 下发依赖 Flutter 引擎存活时 syncConfigToNative 被触发（auth/settings/featureFlags 三个监听器都会触发）；管理台中途改套餐特性位时经 WS feature_flags.updated → applyFlags → notifyListeners → 下发。极端陈旧窗口（标志已变但从未触发任何监听）内原生按旧标志执行，Dart 侧闸门仍是权威兜底。

---

## 3. 修复 3（S1-5）：release 日志泄漏 JWT/OTP → 已修（ProGuard 规则未经 release 构建验证）

### 日志脱敏排查表

| 位置 | 原输出 | 敏感值 | 处置 |
|---|---|---|---|
| `ws_service.dart`（原 :140） | `print('[WsDebug] channel opened uri=$uri')` | **完整 JWT + csrf_token（query string）** | 改为 `_wsLog`（kDebugMode 门控），只打 scheme/host/port/path，query 一律不打 |
| `ws_service.dart` 其余 9 处 `print('[WsDebug]…')` | 连接状态/deviceId/错误对象 | deviceId（低敏）；`onError: $error` 理论上可能含 URI | 全部收敛到 `_wsLog`：release 不输出 |
| `main.dart`（原 :172） | `print('[WsDebug] force logout…')` | reason（非凭据） | 改 `debugPrint` + release 全局静默（见下） |
| `KeepAliveNotificationListener.kt:71` | `Log.i("OTP captured from $pkg: $code …")` | **短信验证码明文** | 改为只打来源包名 + 位数（`${code.length} digits`） |
| `proguard-rules.pro:62-70` | Log 剥离规则整段被注释 | — | 启用 `-assumenosideeffects`，**只剥离 v/d/i，保留 w/e**（避免误伤崩溃诊断；审计原注释块把 w/e 也剥了）。⚠️ 未经 release 构建验证 |
| Dart 全局 | 数百处 `debugPrint`（release 下照常进 logcat） | 个别含 deviceId、服务端响应摘要 | `main()` 首行：`if (kReleaseMode) debugPrint = (…) {};`——release 下 debug 级日志统一不输出（项目无既有 logger 封装，此为最小收口，不另造一套） |
| 其余 Kotlin `Log.*` | 逐条核查（grep `Log\.` 全部 75 处） | `saveSyncConfig` 只打 baseUrl/deviceId/布尔，新增 tokenPresent 布尔；`uploadScreenshotNatively` 只打 tokenPresent；NativeClipboardUploader 只打字符数/HTTP 状态码 | 无需处置（不含凭据值） |

### 改后 grep 证据（2026-09-23）
- `grep -rn "[^a-zA-Z]print(" lib --include="*.dart"`（排除 debugPrint/l10n）→ 仅剩 1 处命中为注释文本，**零直调 print**。
- `grep -rniE "print|log" × token/uri 变量插值` → 零命中。
- Kotlin `Log.*` 含 `$code` 的 3 处均为 HTTP 状态码（Int），OTP 明文日志已清除。

### 只报告、未改（同步链路，本批禁动）
- **WS token 走 query string**（`?token=&csrf_token=`）本身建议改为 `Sec-WebSocket-Protocol` 子协议或首帧鉴权——涉及服务端 `ws/server.js` 握手校验，属 P1-A/跨端契约，本批仅完成日志侧脱敏。

---

## 4. 修复 4（S1-6）：allowBackup + 明文可备份区 → manifest 层已修；存储迁移仅出方案

### 已做（低风险、立即生效）
- `AndroidManifest.xml`：显式 `android:allowBackup="false"` + `android:fullBackupContent="false"` + `android:dataExtractionRules="@xml/data_extraction_rules"`（targetSdk 跟随 Flutter stable，compileSdk 37 ⇒ ≥31，必须配 dataExtractionRules）。
- 新建 `res/xml/data_extraction_rules.xml`：cloud-backup 与 device-transfer 两个域全部 exclude（root/file/database/sharedpref/external）。覆盖审计点名的三处明文：`pending_upload_queue_v1*`（剪贴板原文）、`documents/cache/*.cache`（列表缓存）、原生 `clipsync_sync_config.xml`（JWT 明文）。
- **无掉登录态风险**：本项纯 manifest/资源改动，不触碰任何存储读写。

### 经复核不成立的部分
- 「凭据在 shared_preferences 需迁移 secure storage」——**复核不成立**：Dart 侧 access/refresh token 早已在 `flutter_secure_storage`（`token_store.dart`，且自带旧键 `auth_token` 一次性迁移逻辑），无需迁移、无掉登录态问题。

### 只出方案、未改（避免冒险动存储层）
1. **原生 `clipsync_sync_config.xml` 的 JWT 明文** → 建议迁移 `EncryptedSharedPreferences`（需新增 androidx.security 依赖；要写一次性迁移：读旧 prefs → 写加密 prefs → 删旧键；迁移窗口内前台服务读不到 token 会静默跳过直传，需灰度验证）。manifest 排除后已不可被 `adb backup` 拉走，剩余风险仅 root/取证场景。
2. 离线队列/磁盘缓存本体加密（或移入 cache 目录）→ 现被 dataExtractionRules 排除 + 登出即清 + userId 命名空间，剩余风险同上，建议与统一存储层改造（P1）合并排期。

---

## 5. 验证记录

| 项 | 结果 |
|---|---|
| `flutter analyze` | **0 error**（4810 条 info/warning 全部为存量风格 lint，如 prefer_double_quotes、deprecated lint 规则名；新增文件无告警） |
| `flutter test` | **28/28 通过**（原 21 + 新增 7 个 session_cleanup 用例） |
| `dart format` | 新文件通过。⚠️ 存量文件不能跑当前 SDK 的 `dart format`：本机 SDK 3.13-dev 的 formatter 已切 tall-style，会把 11 个文件整体重排（实测产生 ~550 行无关噪声，已回滚并按基线风格手工对齐）。**发版前需统一 formatter 版本策略** |
| release 构建 / ProGuard 生效 | ❌ 未验证（本批禁 `flutter build`） |
| 真机行为（同步/E2E/登出） | ❌ 未验证（本批禁 adb/run），验证步骤见下 |

## 6. 用户真机验证步骤清单

**修复 1（登出串号）：**
1. 账号 A 登录 → 开飞行模式 → 复制 2 段文字（进离线队列）→ 关飞行模式前直接设置页登出。
2. 账号 B 登录 → 等网络恢复/下拉刷新 → B 的列表与 PC 端 B 账号里**不得出现** A 的那 2 段文字。
3. （可选 adb 佐证）登出后 `adb shell run-as com.clipsync.clipsync_mobile cat shared_prefs/FlutterSharedPreferences.xml`，应无 `pending_upload_queue_v1` 相关键。

**修复 2（E2E 回写/采集）：**
4. 设置页开启「端到端加密」→ 电脑复制一段文字 → 手机 App 在前台时系统剪贴板应为**明文**（Dart WS 路径解密回写），任何时刻都不得出现 base64 乱码。
5. E2E 开启 + 手机锁屏/切后台 → 在电脑上复制文字 → 手机剪贴板不出现密文（预期：引擎冻结时该条不回写，解锁打开 App 后在列表可见并可复制——这是最小干预的已知降级）。
6. E2E 开启 → 手机在微信等 App 复制文字（无障碍采集路径）→ PC 端收到的条目 preview 应为 `[E2E]`（密文入库），而非明文。
7. E2E 关闭 → 重跑一遍日常同步全流程（复制/粘贴/截图/图片入册），应与改前行为一致（默认路径零改动）。

**修复 3（日志）：**
8. 装 release 包 → `adb logcat | grep -iE "wsdebug|otp|token"` → 应无 JWT、无验证码明文、无 [WsDebug]。
9. debug 包连接 WS 时 logcat 可见 `[WsDebug] channel opened wss://host/path`（无 query）。

**修复 4（备份）：**
10. `adb backup -f test.ab com.clipsync.clipsync_mobile` → 产物应为空/仅元数据（allowBackup=false）。

## 7. 顺带发现（未改，不在本批范围）
- `proguard-rules.pro` 被注释的旧规则拼写为 `assumenosideffects`（少一个 e）——即便当年取消注释也不会生效；已按正确拼写启用。
- `settings_screen._clearCache`（S2-9 虚假清理）仍只清内存 + 无人写入的 `clipboard_cache` 键；现在 `CacheService`/队列有了公开 clear 入口，P1 修复成本已降低。
- `E2eImageOutcome` 在 201/200 但响应体不可解析时 `response=null`，调用方按失败处理（`share_receive_screen` 会提示失败但实际已入库）——存量边界，未动。
- `CHANGE_WIFI_MULTICAST_STATE` 多余权限、`requestLegacyExternalStorage`（S2-5）未动。

## 8. 改动文件清单（20 个）
新增：`lib/services/session_cleanup.dart`、`test/session_cleanup_test.dart`、`android/app/src/main/res/xml/data_extraction_rules.xml`
修改（Dart）：`lib/main.dart`、`lib/providers/auth_provider.dart`、`lib/providers/clipboard_provider.dart`、`lib/providers/device_provider.dart`、`lib/services/pending_upload_queue.dart`、`lib/services/cache_service.dart`、`lib/services/clipboard_capture.dart`、`lib/services/local_notification_service.dart`、`lib/services/ws_service.dart`、`lib/services/sync_service.dart`、`lib/screens/share/share_receive_screen.dart`
修改（Android）：`AndroidManifest.xml`、`proguard-rules.pro`、`SyncForegroundService.kt`、`MainActivity.kt`、`NativeClipboardUploader.kt`、`KeepAliveNotificationListener.kt`
**无新增依赖，无需 `flutter pub get`。**
