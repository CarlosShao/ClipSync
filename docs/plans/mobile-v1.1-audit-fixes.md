# ClipSync 移动端 v1.1 审查修复工单（i18n 补全 + P0 缺陷 + P1 功能补齐）

> **依据**：2026-09-01 移动端全量审查（i18n 完成度 + 功能完善度），全部结论基于代码实读（文件:行号），无臆测。
> **分支**：`feature/mobile-v1.1-debug`（基于 `feature/mobile-v1` @ d41db05）
> **路线**：v1 功能已全量落地；本工单收尾三类问题——① i18n 只接线了设置页/剪贴板流，12 个 UI 文件约 210 处硬编码；② 6 个 P0 级缺陷（其中 2 个是「虚假完成」的接线）；③ 后端已就绪、移动端未接的 P1 功能。
> **并发纪律**：最多 2 个 subagent 并行；同波工单文件所有权互斥；子代理禁止 git 操作。

---

## 一、全局约束（对所有执行子代理）

1. **文件所有权**：只允许修改本工单「独占文件」清单内的文件；越界改动在交付报告中说明，由编排者处理。
2. **禁止 git 操作**：子代理不执行任何 git commit/push/checkout；只改代码、跑验证、输出交付报告。
3. **验证门禁**（每张工单自查，波次结束编排者复验）：
   - `cd src/mobile && flutter analyze` 零 error（当前基线：不高于 v1 收尾时的 61 error）
   - `flutter build apk --debug` 构建通过
4. **i18n 规则**：arb 以 `app_en.arb` 为 template（占位符声明必须写在 en 侧）；新增 key 必须双语同步，不许出现单边缺失；页面接线用 `AppLocalizations.of(context)`，无 BuildContext 场景（通知/回调）从 Provider 层传参。
5. **行为红线**：不改后端契约；移动端不引入 AI；不引入第三方 UI 包。
6. **桌面端教训**：禁止「观察者回调里再改被观察属性」的样式重算模式。

---

## 二、现状基线（审查结论摘要）

**已验证不缺**（勿重复排查）：图片缩略图+缓存、2FA+refresh token 静默续期、真实设备注册、生物识别锁、分享收发、前台服务保活、本地通知、采集五层去重、AndroidManifest 权限（全部符合 v1 要求）。

**i18n 现状**：arb 双语 122 key 一一对应；已接线：settings_screen、clipboard_screen、clipboard_search_bar、type_filter_chips、clipboard_card、item_detail_screen（93 key 已引用）；**12 个 UI 文件约 210 处硬编码**；29 个已定义未使用的 key（login 组 17、设备组 6、通用组 4）。

**P0 缺陷**：
1. 错误上报假发送（`error_report_service.dart:247-267` 只延迟清空队列）
2. WS 重连无数据补拉（`ws_provider.dart:16-19`；`syncPush/syncPull` 已封装零调用；offline_service 删后未重写）
3. WS 心跳无 pong 看门狗（`ws_service.dart:147-182`，桌面端 useWebSocket.ts 有 25s+35s 看门狗可参照）
4. 采集失败永久丢内容（`clipboard_capture.dart:38-40` 冷却不补传，无持久化队列）
5. 通知设置页是占位页且暴露入口（`notification_settings_screen.dart` 全页「开发中」；推送开关不同步服务端）
6. 剪贴板采集总开关不可达不持久化（`sync_service.dart:21-32` 内存态硬编码默认开）

**P1 缺口**（后端已就绪、移动端未接）：收藏夹管理（改名/移动/排序/标签/条目增删 8 个 API 未封装）、搜索历史+高级筛选、共享链接、通知中心（站内信）、服务端推送（无 FCM）、条目管理（置顶/过期/归档/密码保护/标签）、模板增强（变量默认值/增删改/分类）、账号资料展示。

---

## 三、Wave A — i18n 补全

### A1 [P0] arb 扩容 + 高频页接线
- **独占文件**：`lib/l10n/app_zh.arb`、`lib/l10n/app_en.arb`、`lib/screens/login_screen.dart`、`lib/screens/lock_screen.dart`、`lib/screens/onboarding_screen.dart`、`lib/screens/home_screen.dart`
- **要求**：
  ① 新增约 40 个 key（登录 2、锁屏 4、onboarding 12、home 设备 tab 4、通用杂项：`sendCodeFailed`/`phoneAndCodeRequired`/`twoFactorCodeLabel`/`biometricUnlockReason`/`biometricVerifyFailed`/`lockScreenMessage`/`unlock`/`devicesLoadFailed`/`unbindCurrentDeviceConfirm`/`backAgainToExit`/`skip`/`next`/`getStarted`/onboarding 5 组 title/desc 等），en/zh 双语同步；
  ② login_screen 22 处、lock_screen 5 处、onboarding_screen 12 处、home_screen 设备 tab 10 处全部接线（17 个登录 key、6 个设备 key 已备好直接引用）；
  ③ onboarding `_pages` 是 State 字段初始化的 const 列表，需改为 build 期经 l10n 构造；
  ④ `appTitle`（splash/登录页写死 'ClipSync'）接线；`main.dart` 的 `title: 'ClipSync'` 属品牌名豁免。
- **验收**：`flutter gen-l10n` 通过；en/zh key 数一致；4 个页面零硬编码 UI 文案（注释/日志/品牌名除外）。

### A2 [P1] Wave 3/4 页面接线
- **独占文件**：`lib/screens/favorites/favorites_screen.dart`、`lib/screens/favorites/collection_items_screen.dart`、`lib/screens/devices/sessions_section.dart`、`lib/screens/subscription/subscription_management_screen.dart`、`lib/screens/templates/templates_screen.dart`、`lib/screens/onboarding/permission_guide_screen.dart`、`lib/screens/share/share_receive_screen.dart`、`lib/screens/notification_settings_screen.dart`、`lib/widgets/device_card.dart`、`lib/widgets/common/error_state.dart`、`lib/router/app_router.dart`
- **要求**：
  ① 新增约 95 个 key（收藏夹 13、收藏条目 5、会话 13、订阅 20、模板 9、权限引导 20、分享 8、设备卡 6、错误态 2 等），en/zh 双语同步；
  ② 上述 11 个文件全部接线（约 170 处）；
  ③ `error_state.dart` 的 const 默认参数无法引用 l10n → 改为调用方传入，调用点（A1/A2 各页）同步传参；本工单完成时该组件默认值兜底改为从 build 期 l10n 取；
  ④ `sessions_section.dart` 的 static 相对时间方法需改为接收 l10n 参数（`relJustNow`/`relMinutesAgo` 等 key 已有）；
  ⑤ 订阅页 29 个硬编码中 `subscriptionManagement`/`refresh` 已有 key 直接引用；
  ⑥ 相对时间/类型徽标等复用已有 key：`relDateMD`、`typeLink`、`typeText`、`placeholderEmpty`、`copied`。
- **验收**：11 个文件零硬编码 UI 文案；真机切换 en 全页面无裸中文。

### A3 [P2] 服务层文案与 model 解耦
- **独占文件**：`lib/services/local_notification_service.dart`、`lib/services/error_report_service.dart`、`lib/services/biometric_service.dart`、`lib/models/subscription_plan.dart`、`lib/models/device.dart`、`lib/models/clipboard_item.dart`、`lib/providers/clipboard_provider.dart`、`lib/services/*_api_service.dart`（错误消息部分）
- **要求**：
  ① 通知渠道名/标题/正文（`剪贴板同步`、`同步告警`、`剪贴板已更新`、`收到新的剪贴板内容` 等）→ 新增 key，创建渠道时从 Provider 层传入 l10n 文案；
  ② 错误报告对话框全套文案 → 新增 key（`errorReportTitle`/`pendingReportsCount`/`errorReportDesc`/`close`/`clearAll`/`errorQueueCleared`），ErrorReportWidget 在 build 期取 l10n；
  ③ **结构性解耦**：`subscription_plan.dart:136-142` 的 `features` 拼串（「最多 X 台设备」「/月」）改为返回结构化数据，UI 层用带占位符 key（`planMaxDevices`/`perMonth`/`perYear` 等）渲染；`clipboard_item.dart` 的 `typeLabel` 删除或标记 debug-only（UI 已重映射）；`device.dart`/`sessions_api_service.dart` 的 `'未知设备'` 默认值改 null，由 UI 用已有 `unknownDevice` 兜底；
  ④ **错误码化**：各 api_service 的 `throw Exception('未登录：缺少访问令牌')`、`'获取套餐列表失败'` 等改为错误码常量 + UI 层 `_friendlyError` 映射 l10n（`errorNoToken`/`errorFetchPlans` 等）。
- **验收**：服务层无面向用户的中文字符串（日志除外）；订阅页/错误提示在 en 下无裸中文。

---

## 四、Wave B — P0 缺陷修复

### B1 [P0] WS 可靠性：pong 看门狗 + 重连补拉
- **独占文件**：`lib/services/ws_service.dart`、`lib/providers/ws_provider.dart`、`lib/providers/clipboard_provider.dart`（补拉接线部分）
- **问题**：`ws_service.dart:147-149` 每 30s 发 ping，但 `_handleMessage`（152-182）无 pong 分支、无超时强制重连——半开连接下永久假在线，直接打击「PC 复制→手机秒到」核心场景；`ws_provider.dart:16-19` 的 `onConnected` 不触发列表重拉——断线期间错过的增删藏变更全部丢失。
- **要求**：
  ① pong 看门狗（参照桌面端 `useWebSocket.ts:8-11、97-101`）：记录 lastPongAt，超时（35s）未收到 pong → 强制 `reconnect()`；每次收到 pong 刷新时间戳；
  ② `onConnected` → 回调链触发 `ClipboardProvider` 全量重拉（首页首屏 + 保留分页状态），避免「下拉刷新才能补齐」；
  ③ 前台服务场景验证：App 退后台 10 分钟 → 回前台，无需下拉刷新即能看到断线期间的新增条目。
- **验收**：真机断网 5 分钟后恢复网络，30 秒内自动重连并补齐数据（无手动操作）。

### B2 [P0] 采集离线持久化队列
- **独占文件**：`lib/services/clipboard_capture.dart`、`lib/services/pending_upload_queue.dart`（新建）、`pubspec.yaml`（connectivity_plus）、`lib/services/sync_service.dart`（入口挂接）
- **问题**：`clipboard_capture.dart:38-40` 重试 3 次后进 5 分钟冷却，`:83-87、161-162` 冷却期同内容跳过且不自动补传——断网/弱网复制的内容静默丢失。
- **要求**：
  ① 新建持久化待传队列（sqflite 或 SharedPreferences JSON，含幂等键/内容哈希/时间戳/重试次数，参照 v1 已删除的 offline_service 设计）；
  ② 上传失败 → 入队；`connectivity_plus` 监听网络恢复 + WS onConnected → 队列重放（成功即删，失败指数退避，上限 N 次）；
  ③ 队列重放沿用既有幂等键与回环抑制（五层去重不动）。
- **验收**：飞行模式下复制 3 条文本 → 恢复网络 → 30 秒内自动补传成功且无重复条目。

### B3 [P0] 设置接线：通知设置真实化 + 采集总开关
- **独占文件**：`lib/screens/notification_settings_screen.dart`、`lib/screens/settings_screen.dart`、`lib/services/sync_service.dart`、`lib/providers/settings_provider.dart`
- **问题**：通知设置页整页「开发中」却暴露入口（`settings_screen.dart:425-441`）；推送总开关只写 SharedPreferences 不同步服务端（桌面端已接 toggle API）；采集总开关 `syncEnabled` 内存态硬编码默认开、无 UI 入口——用户无法关闭「系统剪贴板被采集上传」（隐私敏感）。
- **要求**：
  ① 通知设置页重写：新剪贴板通知开关（本地）、推送通知总开关（同步服务端通知偏好 API，参照桌面端）、通知渠道引导入口；
  ② `syncEnabled` 持久化（SharedPreferences）+ 设置页「剪贴板采集」开关（关闭后前台服务停止采集、仅保留接收）；
  ③ 所有开关即时生效（读开关处动态判断，不缓存 stale 值）。
- **验收**：关闭采集开关 → 手机复制内容不再上传；重启 App 开关状态保持。

### B4 [P0] 错误上报真实化
- **独占文件**：`lib/services/error_report_service.dart`
- **问题**：`error_report_service.dart:247-267` `_sendErrorReports()` 只 `Future.delayed(1s)` 后清空队列，制造「已发送」假象；所有崩溃被静默丢弃（已接线 `main.dart:99、117-128、217`）。
- **要求**：
  ① 优先方案：接后端已有日志/反馈端点（若无则走 POST /api/feedback 或新增轻量端点，由编排者确认后实施）；
  ② 兜底方案（后端无端点时）：移除假发送逻辑，改为本地滚动保留最近 N 条 + 设置页「导出错误日志」入口（share_plus 分享日志文件），并发送队列 UI 明示「仅本地保留」；
  ③ 无论哪种方案，禁止再出现「模拟发送成功」。
- **验收**：触发一次测试异常 → 后端可见（或本地导出可见）真实堆栈。

---

## 五、Wave C — P1 功能补齐（后端已就绪、移动端未接）

### C1 [P1] 收藏夹管理补齐
- **独占文件**：`lib/services/collections_api_service.dart`、`lib/screens/favorites/favorites_screen.dart`、`lib/screens/favorites/collection_items_screen.dart`、`lib/providers/`（collection provider 若需新建）
- **要求**：对接后端 `routes/favorites.js` 已有 API——改名/图标 `PUT /collections/:id`(:95)、层级移动 `PUT /collections/:id/move`(:168)、排序 `PUT /collections/reorder`(:242)、加入条目 `POST /collections/:id/items`(:289)、移出条目 `DELETE /collections/:collectionId/items/:itemId`(:329)；UI：分组长按菜单（重命名/删除）、组内条目「加入分组/移出分组」、拖拽排序（ReorderableListView）、条目多选移动。
- **验收**：手机端可完成「新建→重命名→把剪贴板条目加入→拖拽排序→移出→删除」全流程，桌面端可见。

### C2 [P1] 搜索增强：历史 + 高级筛选
- **独占文件**：`lib/screens/clipboard/clipboard_search_bar.dart`、`lib/screens/clipboard/type_filter_chips.dart`、`lib/providers/clipboard_provider.dart`、`lib/services/api_service.dart`（search history 部分）、`lib/services/search_history_api_service.dart`（新建）
- **要求**：① 搜索历史（后端 `routes/searchHistory.js` 已就绪，参照桌面端 searchHistory.ts）：聚焦时下拉展示最近 N 条、点击回填、可清空单条/全部；② 高级筛选面板：时间范围（dateFrom/dateTo）、设备来源（deviceId）、收藏状态——API 参数已支持（`api_service.dart:93-129`），补 UI 与 provider 传参联动（筛选变更重置分页）。
- **验收**：搜索历史跨端一致；按时间+设备组合筛选结果正确。

### C3 [P1] 条目管理能力
- **独占文件**：`lib/widgets/clipboard_card.dart`、`lib/screens/clipboard/item_detail_screen.dart`、`lib/providers/clipboard_provider.dart`、`lib/services/api_service.dart`
- **要求**：① 置顶（替换 `clipboard_card.dart:298-311` 的「即将上线」禁用占位与 `:343-344` 空实现，对接后端 pin API，列表置顶排序——模型已解析 `isPinned`）；② 过期时间展示+设置（模型已解析 `expiresAt`，参照桌面端 ExpiryPicker）；③ 归档动作+筛选（`isArchived` 已解析）；④ per-item 标签展示与编辑（`tags` 已解析）；⑤ 受保护条目解锁（`protectionLevel` 已解析，补密码输入流程，后端 `routes/protection.js` 已就绪，参照桌面端 useItemPassword.ts + ItemPasswordDialog.vue）。
- **验收**：置顶条目列表首位；设过期后到期自动消失；受保护条目在手机端输密码可解锁。

### C4 [P1] 模板增强
- **独占文件**：`lib/screens/templates/templates_screen.dart`、`lib/services/api_service.dart`（templates 部分）、`lib/models/`（template 模型）
- **要求**：① 变量默认值记忆（后端 `routes/templateVariables.js` 已就绪，参照桌面端 `templateVariableStore.ts` 的 name→value 回退链：默认值→上次输入→空）；② 模板增删改（对接后端 CRUD，移动端不再只读——空态文案「到桌面端创建」需更新）；③ 分类字段展示（后端支持时）。
- **验收**：变量填写一次后再次使用自动回填；手机端可新建/编辑/删除模板并跨端同步。

### C5 [P1] 共享链接 + 通知中心
- **独占文件**：`lib/screens/shared/`（新建目录）、`lib/screens/notifications/`（新建目录）、`lib/services/shared_links_api_service.dart`（新建）、`lib/services/notifications_api_service.dart`（新建）、`lib/router/app_router.dart`、`lib/screens/settings_screen.dart`（入口）
- **要求**：① 共享链接：列表/创建/撤销（后端 `routes/sharedLinks.js` + 桌面端 sharedLinks.ts 参照）；② 通知中心：站内信列表/已读标记/回复查看（后端 `routes/notifications.js` 已就绪）；③ 均从设置页进路由。
- **验收**：桌面端创建的共享链接与站内信在手机端可见可操作。

### C6 [P1] 账号资料区块
- **独占文件**：`lib/screens/settings_screen.dart`、`lib/services/api_service.dart`（profile 部分）
- **要求**：设置页顶部账号信息区块（头像/昵称/手机号/套餐徽标），数据源 `auth_provider.dart:50` 已拉取的 user；点击进资料编辑（昵称修改，后端 `routes/auth-profile.js` 已就绪，参照桌面端 ProfileView.vue）。
- **验收**：改昵称后跨端可见。

### C7 [P2·需服务端配合] 服务端推送（FCM/厂商通道）
- **暂缓开工**：需服务端新增推送注册端点 + Firebase/厂商配置，涉及国内 Android 发布合规（参照 docs/product/domestic-android-publish-guide.md）。列为 backlog，待用户拍板推送方案（FCM vs 极光 vs 厂商聚合）后另开工单。当前通知能力依赖前台服务存活（v1 工单承诺范围）。

---

## 六、Backlog（P2 锦上添花，本工单不开工单）

| 项 | 依据 |
|---|---|
| 富内容预览（Markdown/代码高亮/表格/HTML/文档，桌面端 7 种） | 移动端详情页仅文本/图片/文件三态 |
| OCR 字段消费（模型已解析 `ocrText`，卡片显示占位文案） | `clipboard_item.dart:23-24`、`clipboard_card.dart:427-438` |
| WS 连接状态 UI 指示（离线横幅/重连中提示） | `wsProvider.isConnected` 唯一消费点 `home_screen.dart:93` |
| 批量操作（多选删除/收藏/移动） | 桌面端批量删除已实现 |
| 用户侧「去重清理」入口 | 桌面端 clipboardDedup.ts |
| 扫码配对入口 | 桌面端 QrPairingModals.vue |
| 保存的搜索 | 桌面端也未实现，两端一起规划 |
| AI 功能 | v1 明确排除，列入后续路线 |

---

## 七、编排与验收

| 波次 | 并发 | 验收门禁 | 里程碑 |
|---|---|---|---|
| Wave A（i18n） | 2（A1+A2 并行，A3 串行收尾） | analyze 0 error + debug 构建 + en 切换真机抽查 | 🏁 全应用双语完整 |
| Wave B（P0 修复） | 2（B1+B2 并行，B3+B4 并行） | 同上 + 真机验收断线补拉/离线补传 | 🏁 核心场景可靠性 |
| Wave C（P1 功能） | 2（同波文件所有权互斥） | 同上 + 对应功能真机验收 | 🏁 功能对齐桌面端 |

- 提交规范：每工单 1 提交 `fix(mobile): B1 描述` / `feat(mobile): C1 描述` / `i18n(mobile): A2 描述`
- 最终验收：`flutter analyze` 零 error；en/zh 全量无裸中文；B1/B2/B3 真机场景验收通过

## 八、进度跟踪

| 工单 | 状态 | 执行者 | 提交 |
|---|---|---|---|
| A1 arb 扩容+高频页 | ✅ | hy4 | c6dc89c |
| A2 Wave3/4 页面接线 | ✅ | hy4 | 3b71455 |
| A3 服务层解耦 | ✅ | hy4 | fa1e99e |
| B1 WS 看门狗+补拉 | ✅ | hy4 | a77f508 |
| B2 采集离线队列 | ✅ | hy4 | 6fcb14a |
| B3 设置接线 | ✅ | hy4 | 81da6de |
| B4 错误上报真实化 | ✅ | hy4 | 276047a |
| C1 收藏夹管理 | ⚠️ 主干属实（缺条目多选移动；trailing 菜单替代长按） | hy4/复核 ZCode | 8df81a7 |
| C2 搜索增强 | ⚠️ 部分属实（历史仅清空全部无单条删除；时间筛选仅预设档未接 dateTo 自定义） | hy4/复核 ZCode | 41d7933 |
| C3 条目管理 | ⚠️ 4/5 子项（标签只编辑无展示；过期条目不自动消失——服务端列表无 expires_at 过滤，两端共同缺口） | hy4/复核 ZCode | 6b5eb54 |
| C4 模板增强 | ✅（轻微：未封装变量 DELETE /:name） | hy4/复核 ZCode | c4a09c0 |
| C5 共享链接+通知中心 | ✅ | hy4/复核 ZCode | 36ebc61 |
| C6 账号资料 | ⚠️ 主干属实（套餐徽标缺失） | hy4/复核 ZCode | 9cfd95d |
| C7 服务端推送 | ⏸ 暂缓（需用户拍板推送方案） | | |
