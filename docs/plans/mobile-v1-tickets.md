# ClipSync 移动端 v1 任务工单（Flutter 现代化 + Android 先行）

> **依据**：2026-08-30 移动端全量审计（Flutter 现状 + 服务端支持面），已获用户批准的 v1 范围。
> **分支**：`feature/mobile-v1`（基于 dev/cnb @ c18b680）
> **路线（用户拍板）**：保留 Flutter 现代化改造 / Android 先行 / 前台服务实现「PC 复制→手机秒到」/ v1 不含 AI / UI 全推翻重构（仅复用验证过的逻辑层）
> **并发纪律**：最多 2 个 subagent 并行；同波工单文件所有权互斥；子代理禁止 git 操作

---

## 一、全局约束（对所有执行子代理）

1. **文件所有权**：只允许修改本工单「独占文件」清单内的文件；越界改动在交付报告中说明，由编排者处理。
2. **禁止 git 操作**：子代理不执行任何 git commit/push/checkout；只改代码、跑验证、输出交付报告。
3. **验证门禁**（每张工单自查，波次结束编排者复验）：
   - `cd src/mobile && flutter analyze` 零 error
   - `flutter build apk --debug` 构建通过（Wave 0 起每波必须）
   - 涉及后端的工单：`cd src/server && node --check <file>` + 现有测试通过
4. **行为红线**：纯新增/修复不改已有后端契约；移动端不引入 AI；文案默认中文硬编码（i18n 是 Wave 4 统一启用，不逐单做）
5. **桌面端教训（必须遵守）**：禁止「观察者回调里再改被观察属性」的样式重算模式（桌面端黑屏根因）；主题/字体应用只在显式用户动作与生命周期事件时执行

## 二、现状基线（审计结论摘要）

- 可复用的真实逻辑：验证码登录、剪贴板列表分页+缓存、WS 收新增/删除/收藏（断线退避重连）、Provider 模式、订阅管理页（真 API）、离线协议设计（OfflineService 未接线）
- 已知断点：WS 生产握手缺 csrf-token；无 refresh token（24h 被登出）；复制只复制截断预览；deviceId 用 user id 冒充；无剪贴板采集/后台/通知/分享；release 无 INTERNET 权限
- 后端小修：sync.js:98 冲突分支 `userId` 未定义；移动端订阅页应改调 `/api/invoices`

---

## 三、Wave 0 — 地基排雷

### T0.1 [编排者自做] 分支创建与文档整理
- 分支 `feature/mobile-v1`；根目录三篇研究/审计文档归档 `docs/research/`；本工单文档落 `docs/plans/`

### T0.2 [P1][清理] 死代码与依赖卫生
- **独占文件**：`lib/screens/survey_screen.dart`、`feedback_screen.dart`、`billing_history_screen.dart`、`payment_result_screen.dart`、`subscription_plans_screen.dart`（Wave 4 重写时恢复）、`device-management-screen.dart`、`widgets/quick_paste_panel.dart`、`services/offline_service.dart`（暂删，Wave 3 重接线时按新架构重写）、`services/notification_api_service.dart`、`services/key_storage_service.dart`、`test/key_storage_service_test.dart`、`test/mock_plugins.dart`、`pubspec.yaml`
- **要求**：① 删除上述不可达/编译不过的死文件（subscription_plans_screen 标记 Wave 4 重写）；② pubspec 移除 cached_network_image/photo_view/skeletonizer/shimmer/uuid/diff_match_patch/intl/flutter_svg 中当前不可达引用（Wave 2/4 需要的由对应工单重新添加）；③ 显式添加 path_provider、crypto、device_info_plus、package_info_plus、shared_preferences、sqflite 到 dependencies（现为 transitive）；④ 删除引用死文件的 import 残留
- **验收**：`flutter analyze` 零 error；`flutter build apk --debug` 通过；全库 grep 无对已删文件的引用

### T0.3 [P0][修复] 崩溃级 bug 与路由体系
- **独占文件**：`lib/main.dart`、`lib/providers/settings_provider.dart`、`lib/screens/settings_screen.dart`、`lib/screens/onboarding_screen.dart`、`pubspec.yaml`（go_router）、`lib/router/`（新建）
- **要求**：① SettingsProvider 注册进 MultiProvider（修复 ProviderNotFoundException）；② theme_mode 键统一为 int 枚举存储，修复 string/int 类型冲突崩溃；③ onboarding 写键与 main 读取键统一（`onboarding_completed`），文案改为移动端语境；④ 引入 go_router：路由表 `/login`、`/onboarding`、`/home`（含 shell 子路由 `/home/clipboard`、`/home/devices`、`/home/settings`）+ 重定向守卫（无 token→/login，未 onboarding→/onboarding），替换 main.dart 的条件 home 与裸 MaterialPageRoute；⑤ 删除设置页三个桌面专属 MethodChannel 项（自启/全局快捷键/导出日志——移动端无此通道永远失败）；⑥ 增加「退出登录」入口（调 AuthProvider.logout）
- **验收**：冷启动→onboarding→登录→主页→设置 全链路无异常；改主题/语言不再崩溃；退出登录后回到登录页

### T0.4 [P0][修复] release 网络权限与构建验证
- **独占文件**：`android/app/src/main/AndroidManifest.xml`
- **要求**：主 Manifest 添加 `<uses-permission android:name="android.permission.INTERNET"/>`；验证 debug/release 两种 variant 均可构建
- **验收**：`flutter build apk --debug` 与 `flutter build apk --release` 均通过；release 包安装后可访问服务器

---

## 四、Wave 1 — 数据与认证地基

### T1.1 [P0][数据] ClipboardItem 全量内容模型
- **独占文件**：`lib/models/clipboard_item.dart`、`lib/services/api_service.dart`（列表解析部分）、`lib/providers/clipboard_provider.dart`
- **问题**：模型只有 contentPreview（截断预览），复制长文本失真
- **要求**：① 模型补 `fullContent`、`contentType`、`metadata`、`createdAt`、`sourceDeviceName` 字段，对齐后端 GET /api/clipboard 响应（桌面端 clipboardLoad.ts 为参照）；② 列表响应解析 fullContent（后端列表即含内容体，桌面端验证过）；③ 复制动作写入 fullContent
- **验收**：复制长文本（>5000 字符）到系统剪贴板完整无截断

### T1.2 [P0][安全] token 迁移 secure storage
- **独占文件**：`lib/providers/auth_provider.dart`、`pubspec.yaml`（flutter_secure_storage 转正式依赖）
- **要求**：token 读写改 flutter_secure_storage；首次启动迁移旧 SharedPreferences token；登出清除
- **验收**：登录后 token 存于 secure storage；旧版本升级场景 token 不丢

### T1.3 [P0][认证] refresh token 静默续期
- **独占文件**：`lib/services/api_service.dart`、`lib/services/auth_refresh_service.dart`（新建）
- **问题**：verify-code 响应含 refreshToken 但被丢弃（`api_service.dart:44`）；生产 24h 后被强制重新验证码登录
- **要求**：① 登录时持久化 refreshToken（secure storage）；② 401 时单飞调用 POST /api/auth/refresh（GETDEL 旋转语义）换新 token 并重放原请求；③ 刷新失败（旋转 token 已失效）→ 清凭证回登录页
- **验收**：手动把 access token 改为无效后请求自动续期成功；刷新失败正确回登录页

### T1.4 [P1][认证] 2FA 登录分支 + T1.5 [P1][设备] 真实设备注册
- **2FA**：login 响应含 `twoFactorRequired+challengeToken` 时进入 2FA 验证码输入态，POST /api/auth/2fa/verify-login 完成登录（后端 two-factor.js 已有）
- **设备注册**：登录成功后 POST /api/devices（deviceName=设备型号，deviceType=mobile，platform=android）；WS register 改用真实 deviceId（弃用 user id 冒充）；设备页支持解绑（DELETE /api/devices/:id，含当前设备保护提示）
- **验收**：开启 2FA 的账号可在移动端登录；设备页显示真实设备名并可解绑

---

## 五、Wave 2 — UI 全推翻重构（本期主体）

> 设计原则：Material 3 真正落地；中性底色 + 主题色点缀；卡片圆角 12-16；克制动效；观感对齐桌面 shadcn 风格。**全部页面推倒重写**，仅复用 Provider/Service 逻辑。

### T2.1 [P0][UI] 设计系统重做
- **独占文件**：`lib/theme/app_theme.dart`、`lib/widgets/`（新建基础组件：AppCard、SectionHeader、EmptyState、ErrorState、SkeletonList）
- **要求**：M3 ColorScheme.fromSeed 体系（保留紫 #5A4BD1 种子色）；文字阶梯/间距/圆角 token 化；亮暗双主题完整；轻量组件库（无第三方 UI 包依赖）

### T2.2 [P0][UI] 应用骨架
- **独占文件**：`lib/router/`、`lib/main.dart`、`lib/screens/home_screen.dart`（重构为 shell）
- **要求**：NavigationBar 4 tab（剪贴板/收藏/设备/设置）；收藏页占位（Wave 4 实现）；tab 状态保持；双击退出确认

### T2.3 [P0][UI] 首页剪贴板流重构
- **独占文件**：`lib/screens/clipboard/`（新建目录：clipboard_screen、search_bar、type_filter_chips）
- **要求**：顶部 SearchBar + 类型筛选 chips（全部/文本/链接/图片/文件）+ 下拉刷新（RefreshIndicator）+ 无限分页；搜索防抖 300ms；筛选状态与分页联动正确（切筛选重置页码）

### T2.4 [P0][UI] 剪贴板卡片重做
- **独占文件**：`lib/widgets/clipboard_card.dart`（重写）
- **要求**：类型徽章四色、来源设备、相对时间、长文本预览多行省略；点击=复制全量+轻提示；长按/右侧菜单=收藏 toggle、置顶、删除（带确认）

### T2.5 [P1][UI] 详情预览页
- **独占文件**：`lib/screens/clipboard/`（item_detail_screen）；`pubspec.yaml`（重新引入 photo_view、cached_network_image）
- **要求**：图片全屏查看（双指缩放）；文件卡片（文件名+大小+下载入口调 GET /api/media/:id/download）；文本全览+复制按钮

---

## 六、Wave 3 — 移动核心能力（秒级同步）

### T3.1 [P0][原生] 前台服务保活 WS
- **独占文件**：`android/app/src/main/`（ForegroundService Kotlin、Manifest 权限 FOREGROUND_SERVICE/FOREGROUND_SERVICE_DATA_SYNC/POST_NOTIFICATIONS）、`lib/services/`（桥接）
- **要求**：前台服务持 WS 连接（常驻低优先级通知「剪贴板同步中」，可配置隐藏为最低可见性）；App 生命周期挂钩（前台恢复重连/后台不主动断，服务持有连接）；POST_NOTIFICATIONS 运行时权限申请
- **验收**：PC 复制 → 手机通知 3 秒内出现；App 退后台 10 分钟后仍秒级；Doze 下退化可接受（文档注明引导用户加白名单）

### T3.2 [P0][原生] 系统剪贴板采集
- **独占文件**：同 T3.1 的服务文件 + `lib/services/clipboard_capture.dart`（新建）
- **要求**：Android 10+ 仅前台/服务内可读剪贴板（系统限制，在前台服务中监听）；Android 10 以下可用监听器；采集 → 与上次内容哈希去重 → 走既有上传链路（幂等键）；手机自身复制不回环（本地 echo 抑制）
- **验收**：手机复制文本 → PC 端列表秒级出现；重复复制同一内容不产生重复条目

### T3.3 [P0][修复] WS 生产握手 + 生命周期
- **独占文件**：`lib/services/ws_service.dart`
- **问题**：生产环境 WS 握手强制要求一次性 csrf_token（ws/server.js:115），移动端只带 token → 4006 拒绝
- **要求**：连接前 GET /api/ws/csrf-token（Bearer）→ 60s TTL 内完成握手；失败重取；App 生命周期断线/重连挂钩
- **验收**：模拟生产配置（nodeEnv=production）下 WS 连接成功且实时收发

### T3.4 [P1][原生] 即时通知与引导页
- **独占文件**：`lib/services/`（local_notification_service，flutter_local_notifications）、`lib/screens/onboarding/`（权限引导）
- **要求**：new_clipboard → 本地通知（点击冷启动/热启动直达首页）；设置页通知开关真实生效（不弹 vs 弹）；首次启动权限引导页（通知+电池优化豁免+自启设置跳转）
- **验收**：杀掉 App 后 PC 复制（服务存活场景）→ 通知栏出现并可点开

### T3.5 [P1][原生] 分享收发
- **独占文件**：`android/app/src/main/AndroidManifest.xml`（intent-filter）、`lib/screens/share/`（receive_intent 处理）、`pubspec.yaml`（share_plus、receive_sharing_intent）
- **要求**：系统分享面板接收文本/图片 → 直达上传确认页入库；条目长按菜单「分享」→ share_plus 文本/图片
- **验收**：相册分享一张图到 ClipSync → 列表出现该图；ClipSync 分享文本到微信正常

---

## 七、Wave 4 — 功能补齐

- **T4.1 收藏夹页** [P1]：collections API 对接（分组列表/组内条目/移动）；独占 `lib/screens/favorites/`
- **T4.2 模板页** [P1]：GET /api/templates 列表 + 一键复制渲染结果；独占 `lib/screens/templates/`
- **T4.3 设备与会话管理** [P2]：会话列表+吊销（GET/DELETE /api/sessions）；独占 `lib/screens/devices/`
- **T4.4 订阅页去 mock** [P2]：改调 GET /api/invoices（弃 404 的 payments/history）；恢复重写 subscription_plans（真实 plans API，购买按钮标注「请在桌面端完成支付」）；独占 `lib/screens/subscription/`
- **T4.5 i18n 启用** [P2]：启用 flutter_localizations + arb 生成；全量文案迁移
- **T4.6 生物识别锁** [P2]：local_auth，启动/回到前台时校验；设置开关

**Server 小修（S1，编排者自做或单 agent）**：sync.js:98 `userId` → `req.userId`；跑 sync 相关测试回归

---

## 八、编排与验收

| 波次 | 并发 | 验收门禁 | 里程碑 |
|---|---|---|---|
| Wave 0 | 2 | analyze 0 + debug/release 构建通过 | 基线干净 |
| Wave 1 | 2 | 同上 + 续期/2FA 手测 | 认证生产可用 |
| Wave 2 | 2 | 同上 + **打 debug APK 用户真机验收新 UI** | 🏁 新 UI 全貌 |
| Wave 3 | 2 | 同上 + **真机验收「PC 复制→手机秒到」** | 🏁 核心场景成立 |
| Wave 4 | 2 | 同上 + 最终 APK | 功能补齐 |

- 提交规范：每工单 1 提交 `feat(mobile): T2.3 描述`；波次结束编排者合并验证
- 冲突裁定：pubspec.yaml 由 Wave 内第一个工单主责，其余工单报告依赖需求由编排者追加

## 九、进度跟踪

| 工单 | 状态 | 执行者 | 提交 |
|---|---|---|---|
| T0.1 | ✅ | 编排者 | d232aa7 / 0928da0 |
| T0.2 | ✅（12 死文件删除，error 134→98，零残留引用） | subagent | 077c5e0 |
| T0.3 | ✅（4 崩溃点修复 + go_router 路由表，独占文件 0 error） | subagent | 89853d7 |
| T0.4 | ✅（INTERNET 权限 + 应用名 ClipSync；debug/release 双构建通过） | 编排者 | 077c5e0 |
| T1.1 | ✅（全量内容模型 + /content 取全量策略；error 92→66，独占 4 文件 0 error） | subagent | a1534b4 |
| T1.2-T1.5 | ✅（TokenStore/静默续期/2FA/真实设备注册；独占 5 文件 0 error） | subagent | 951d9a6 |
| T2.1 | ✅（M3 主题重做 + 5 基础组件，main.dart 零适配；独占文件 0 error） | subagent | 28b1427 |
| T2.2 | ✅（NavigationBar 4 tab shell + StatefulShellRoute 保活 + 双击退出；0 error） | subagent | 5e48cd0 |
| T2.3 | ✅（搜索 300ms 防抖 + 类型 chips + 下拉刷新 + 无限分页 + 三态 + 新内容浮条；0 error） | subagent | 5e48cd0 |
| T2.4 | ✅（新卡片 + 临时 tile 切换 + 删除孤儿 coach_mark；0 error） | subagent | 23cf088 |
| T2.5 | ✅（详情页：PhotoView 鉴权缩放/文件下载/文本全览 + 复制收藏操作栏；0 error） | subagent | 28b1427 |
| T3.1–T3.5 | ☐ | — | — |
| T4.1–T4.6 | ☐ | — | — |
| S1 | ✅（sync.js:98 冲突分支 req.userId 修复，167 测试全绿） | 编排者 | dffb5d5 |

**备注**：T1.1 修正了工单假设——列表接口不返回完整内容（仅预览，服务端截断 5000 字符），
取全量走 GET /api/clipboard/:id/content（与桌面端同策略），验收标准（复制 >5000 字符无截断）仍达成。
