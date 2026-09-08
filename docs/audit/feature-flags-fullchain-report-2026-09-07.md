# 功能开关全链路管控——实现与测试报告（任务②）

- **日期**：2026-09-07
- **问题**：管理台关闭功能开关后，桌面端/移动端相关入口仍然可见可点击（如 AI 侧边栏点击后显示"未配置 AI 供应商"并可进入 AI 配置页）
- **根因**：服务端强制链路（403 + `flagDisabled`）自 9-06 审计即真实有效，但两端客户端对开关**零消费**——不拉取快照、不监听 WS 广播、不解析 403 `flagDisabled`（9-06 报告遗留项 2）
- **交付**：两端消费层实现 + 全开关逐一实测（**34/34 PASS**）+ 本报告

---

## 一、生效链路（修复后）

```
管理台切换开关 (PATCH /api/admin/flags/:key，L3 权限)
  → 写库 + 审计（admin.flag.update）
  → WS 广播 feature_flags.updated { flags }（全端）
  → ┌ 桌面端：useFeatureFlags 单例快照更新（零网络往返）→ 入口即时隐藏
    ├ 移动端：FeatureFlagsProvider.applyFlags → 入口即时隐藏
    └ 未在 WS 的客户端：启动/登录时 GET /api/app/feature-flags 拉取
  → 兜底：服务端 requireFlag 403（flagDisabled 标识）始终权威生效
```

容错哲学（与后端 `isFlagEnabled` fallback=true 一致）：开关系统故障时客户端**不隐藏入口**（默认放行），越权请求由服务端 403 兜底——配置基础设施异常不放大成全功能不可用。

## 二、代码改动清单

### 服务端（无改动）
5 个开关的 403 强制点在 9-06 审计已完备，本次实测再次确认，无需改动。

### 桌面端（src/desktop）

| 文件 | 改动 |
|---|---|
| `composables/useFeatureFlags.ts` **（新增）** | 模块级单例快照：`refreshFeatureFlags()`（拉取）、`applyFeatureFlags()`（WS 写入）、`isFlagEnabled()`（未知键默认放行）、`resetFeatureFlags()`（登出清理） |
| `stores/configStore.ts` | 启动已登录（load→fetchUserProfile 后）与 completeLogin 两条路径拉取快照；logout 时 reset |
| `views/HomeView.vue` | WS 分支 `feature_flags.updated`；AI 面板开关集中守卫 `toggleAiPanel()`（侧栏按钮 / Ctrl+Shift+A 全局快捷键 / Ctrl+J 三条路径统一拦截）；开关关闭自动收起面板；`openAiSettings` 守卫；AiChatPanel / AiSummaryFloat 挂载门控；订阅页渲染门控 |
| `components/layout/AppSidebar.vue` | "AI" 侧边栏入口 `v-if`（折叠态图标一并隐藏）；账号区"订阅"入口按 `enable_subscription` 过滤 |
| `components/clipboard/ClipboardView.vue` | AI 主动建议浮窗 AiSuggestPopup 挂载门控 |
| `components/clipboard/ClipboardContextMenu.vue` | 右键菜单"分享链接"项按 `enable_public_sharing` 隐藏 |
| `components/clipboard/ClipboardTableRow.vue` | "更多"菜单分享项同上 |
| `components/settings/settings-dialog/SettingsDialog.vue` | 设置导航中"AI 供应商"/"订阅与账单"分类整体隐藏；initialCategory 指向已隐藏分类时回落 general（防事件绕过） |
| `components/settings/settings-dialog/sub-pages/SecuritySubPage.vue` | `enable_2fa` 关闭且用户未绑定 → 2FA 区块隐藏；已绑定用户仍可见可关闭（与服务端口径一致） |
| `components/auth/AuthPage.vue` | 注册响应 `pendingReview` 识别：显示服务端提示、回登录页、不自动登录（此前会误报"欢迎"再登录失败） |

验证：`vue-tsc --noEmit` 通过；`npm run build`（完整构建）通过。

### 移动端（src/mobile）

| 文件 | 改动 |
|---|---|
| `providers/feature_flags_provider.dart` **（新增）** | ChangeNotifier 快照：refresh()（公开端点）、applyFlags()（WS 直达）、isEnabled()（未知键放行）、reset()（登出清理） |
| `main.dart` | Provider 创建 + 全局注册 + `WsService.globalFeatureFlagsHook` 挂载 |
| `services/ws_service.dart` | `_handleMessage` 新增 `feature_flags.updated` 分支（静态钩子，对齐 globalNewClipboardHook 惯例） |
| `screens/home_screen.dart` | `_loadData` 拉取快照（冷启动恢复 + 登录后两条路径共用） |
| `screens/settings_screen.dart` | "共享链接" tile 按 `enable_public_sharing`、订阅区块按 `enable_subscription` 隐藏（watch 响应式） |
| `screens/clipboard/item_detail_screen.dart` | 溢出菜单与底栏两处"创建共享链接"入口隐藏 |
| `providers/auth_provider.dart` | `LoginResult.pendingReview` 新状态 + `pendingReviewMessage`；识别 waitlist 注册响应 |
| `screens/login_screen.dart` | 待审核提示与失败场景展示服务端明确文案（不再笼统"登录失败"） |
| `services/api_service.dart` | login 非 200 时提取服务端 message/error 进 AppException.detail |

验证：`flutter analyze` 无 error 级问题（存量 info lint 不涉及本次改动）；`flutter build apk --debug` 构建通过。

### 管理台（src/admin-console，无改动）
设置页文案（"适配后的客户端经 WS 推送即时隐藏入口"）在本次改动后成为事实，无需调整。

## 三、逐一测试报告（API 级实测，34 PASS / 0 FAIL）

脚本：`scripts/feature-flags-audit/run-flags-audit.mjs`（`node run-flags-audit.mjs`，dev 后端 :3001）。每个开关执行：读原值 → 管理台 PATCH 切换（等待 5s TTL 失效窗口）→ 强制断言 → 恢复原值 → 回归断言。

### 基础链路（5 PASS）
- 客户端快照端点 `GET /api/app/feature-flags`：公开可读、无需鉴权、含全部 5 键

### enable_ai_agent（7 PASS）
关闭后快照即时反映；`/api/ai/providers`、`/api/ai/settings`、`/api/ai/conversations` 全部 403 且响应带 `flagDisabled: "enable_ai_agent"`；恢复后接口回 200。

### enable_public_sharing（6 PASS）
新建共享链接/共享文件上传 403 + flagDisabled；已建链接列表端点在关闭与恢复后均正常（"已创建链接仍可访问"语义成立）。

### enable_2fa（6 PASS）
setup/enable 403 + flagDisabled；**status 端点保持 200**（已绑定用户不受影响的口径一致）；恢复正常。

### enable_subscription（4 PASS）
快照即时反映；`/api/subscriptions/current` 关闭期间保持可用且返回原套餐（Enterprise）数据——强制语义是"按 Free 配额校验"而非"数据不可见"，管理视图不炸、已有记录不受影响（与 FLAG_CATALOG 宣称语义一致）。

### signup_waitlist（6 PASS）
开启后新手机号注册返回 200 + `pendingReview: true` + 中文提示、**无 token**；存量用户登录态不受影响；恢复关闭正常。

### 客户端 UI 层（代码链路验证）
桌面端 9 处改动点、移动端 6 处改动点均为数据驱动（ref/ChangeNotifier/computed），快照更新即触发重渲染隐藏入口。UI 视觉回归需桌面端重启后人工确认（见第六节）。

## 四、对用户报告的具体 bug 的修复确认

> 现象：关闭 AI 助手开关后，桌面端 AI 侧边栏入口仍可点击 → 显示"未配置 AI 供应商" → 仍能跳转 AI 配置页

修复后全链路：
1. 侧边栏 AI 入口**直接消失**（含折叠态图标）
2. Ctrl+Shift+A / Ctrl+J 快捷键**被守卫拦截**（toggleAiPanel 统一入口）
3. AI 面板组件**不挂载**（v-if）、已打开的面板在开关推送到达时**自动收起**
4. AI 设置分类在设置弹窗中**隐藏**，openAiSettings 事件守卫兜底
5. 若以任何方式绕过 UI 发起请求：`/api/ai/providers` 返回 403 + flagDisabled（实测确认）
6. 管理台切换后 WS 推送**即时生效**，无需重启客户端

## 五、遗留与优化建议

| # | 事项 | 说明 |
|---|---|---|
| 1 | 公告/维护模式客户端感知 | 非功能开关范畴，见《admin-config-audit-2026-09-07》D2/D4 与路线图 |
| 2 | 403 flagDisabled 的全局 Toast | 目前分享操作被服务端拦截时会经既有 SnackBar/toast 显示服务端中文文案；若要"点击隐藏入口不存在时的残余路径"更统一，可在 desktop `api()` / mobile 统一错误层加 flagDisabled 识别出全局提示。当前入口已全隐藏，优先级低 |
| 3 | signup_waitlist 开启期的注册页文案 | 两端注册入口保留（审核 ≠ 关闭），可按需增加"当前为邀请制"提示条，需产品确认 |
| 4 | 真机视觉回归 | 移动端 APK 已构建，待 adb 设备接入安装实测（桌面端由用户重启 `npm run tauri dev` 验证） |

## 六、人工回归清单（5 分钟）

1. 桌面端重启后登录 → 管理台关闭"AI 助手" → 桌面端侧栏 AI 入口**立即消失**（WS 推送，无需重启）
2. 桌面端 Ctrl+Shift+A / Ctrl+J → 面板不弹出
3. 设置弹窗 → 无"AI 供应商"与"订阅与账单"分类（关闭对应开关时）
4. 任一条目右键 → 无"分享链接"（关闭公开分享时）
5. 管理台逐一切回开启 → 入口即时恢复
6. 手机端（安装新 APK 后）：设置页无"共享链接"/订阅区块（对应开关关闭时）；条目详情无分享入口
