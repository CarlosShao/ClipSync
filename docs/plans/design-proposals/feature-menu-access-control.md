# 方案一：功能菜单细粒度访问控制（按用户类型差异化）

- **状态**：设计评审中（未实施）
- **日期**：2026-09-07
- **关联**：[rbac-permission-system-redesign.md](./rbac-permission-system-redesign.md)（方案二，权限系统重构）；功能开关全链路管控已上线（[报告](../../feature-flags-fullchain-report-2026-09-07.md)）
- **本文约定**：所有「现状」均经代码核实（附文件:行号）；所有「建议规则」明确标注为提案，需产品确认后进入实施

---

## 一、需求分析

### 1.1 要解决的问题

当前菜单/功能入口的可见性由三类互相独立的机制决定，没有统一模型：

| 机制 | 数据源 | 现状 |
|---|---|---|
| 功能开关（全局） | `feature_flags` 表 → `GET /api/app/feature-flags` + WS 推送 | ✅ 已全链路落地（两端 15 个门控点），是本方案直接复用的基座 |
| 订阅套餐差异 | `users.plan`（`/api/auth/me`）+ `/api/subscriptions/current` | ⚠️ 零散：桌面端仅「无限历史」一处硬编码 `plan !== 'Pro' && plan !== 'Enterprise'`（GeneralSettings.vue:56-65、L230-241），无统一封装 |
| 平台角色差异 | `roleKey/roleLevel/permissions`（`/api/auth/me` 已下发） | ⚠️ 客户端地基已建但未消费：桌面端 `useUser.ts` 封装完整（L10-57），全应用仅 AiChatPanel 角色徽标一处使用（L199、L535-539）；移动端 `AuthProvider.user` 原始 Map 里字段齐全但 UI 只读 plan（settings_screen.dart:364） |

需求：
1. 按用户类型（Free/Pro/Enterprise、user/admin/super_admin）差异化展示功能菜单；
2. 基于用户属性的菜单访问判定逻辑，一处声明、两端一致；
3. 明确的权限划分规则（哪些菜单对哪些用户类型可见/可用）；
4. 隐藏只是 UX 层：**服务端权威校验始终兜底**（与功能开关同哲学）。

### 1.2 用户类型定义（两个正交维度）

| 维度 | 取值 | 来源 | 语义 |
|---|---|---|---|
| 订阅套餐 plan | Free / Pro / Enterprise | `user_subscriptions JOIN subscription_plans`，`/api/auth/me` 的 `plan` 字段（auth.js:1264-1275，`COALESCE(sp.name,'Free')`） | 商业化能力差异 |
| 平台角色 role | user(10) / admin(50) / super_admin(100) / 自定义 | `users.role_id → roles`，`roleKey/roleLevel` | 管理能力差异，与套餐无关 |

> 明确：**plan 管功能强弱，role 管管理能力**。管理员不因角色获得付费功能（反之亦然），两维正交，不做组合爆炸。

---

## 二、现状事实（设计输入）

### 2.1 菜单全量结构

**桌面端**（AppSidebar.vue + HomeView.vue:589-620 + SettingsDialog.vue:77-89）：

| 层级 | 菜单项 | 现有门控 |
|---|---|---|
| 主导航 | clipboard / favorites / archive / templates / devices | 无（全员） |
| 主导航 | AI（面板开关） | flag `enable_ai_agent`（AppSidebar.vue:139） |
| 账号区 | profile / subscription | subscription 受 flag（AppSidebar.vue:80） |
| 用户菜单 | profile / notifications / logout | 无 |
| 设置分类 | general / appearance / shortcuts / privacy / data / subscription* / variables / ai* / about | *两项受 flag |
| 设置子页 | themes / shortcuts / security / sessions / notifications / export / feedback / pricing / billing | security 内 2FA 区块受 flag |

**移动端**（home_screen.dart:174-195 + settings_screen.dart + app_router.dart:47-64）：底部 4 tab（clipboard/favorites/devices/settings）+ 设置页 tiles（账号卡/服务器/通知/主题/语言/生物锁/缓存/模板库/共享链接*/通知中心/通知设置/剪贴板采集/订阅管理*/退出/关于），*两项受 flag。模板/订阅/共享链接/通知/个人资料为设置页二级路由（支持深链）。

### 2.2 已有的差异化实现（真实存在，可直接升级）

| 能力 | 现状 | 位置 |
|---|---|---|
| 无限历史 = Pro/Enterprise | 客户端硬编码套餐名判断 + `maxHistory 999999` 哨兵值 | GeneralSettings.vue:56-65、L230-241；HomeView.vue:104-108 |
| 上传/存储限额 | `usePlanLimits`：`GET /api/subscriptions/current` 下发，5min 缓存+代数失效，admin 返回 null→∞ | usePlanLimits.ts |
| 413 升级引导 | `useUploadLimitNotice`：Free→Pro→Enterprise 硬编码升级路径 | useUploadLimitNotice.ts:92-110 |
| 套餐功能布尔 | `subscription_plans.features` JSONB：hasOcr/hasPrioritySync/hasAICategories/hasTeamSharing，移动端权益清单已消费 | subscription_management_screen.dart:277-293 |
| 管理员感知 | `useUser.ts`：roleKey/roleLevel/isAdmin/isSuperAdmin/hasPermission() | useUser.ts:10-57 |
| 条目级受限横幅 | `metadata.limitReason` → 移动端详情页横幅 + 查看套餐按钮 | item_detail_screen.dart:2254-2293 |

### 2.3 服务端现状

- `/api/auth/me` 已返回 `plan + roleKey + roleLevel + isAdmin + permissions[]`（auth.js:1255-1275）——**客户端判定所需数据已全部就绪，无需新接口**
- `/api/subscriptions/current` 返回 `plan.features` 布尔集（subscriptions.js:46-139）
- 后端无任何「菜单配置」概念（grep menu/navigation 零命中）
- 服务端各能力的权威校验现状：套餐配额在 subscriptionCheck 中间件+各路由内校验；管理能力校验在 admin 路由（见方案二）；功能开关在 requireFlag

---

## 三、设计原则

1. **三层判定，与现有一致**：菜单可见 = `功能开关开启 && 套餐满足 && 角色满足`。三层各自有独立数据源，不引入第四种机制。
2. **声明式注册表，单点真相**：每个菜单项在一张「菜单能力注册表」里声明自己的三个维度要求，两端各自实现但共享同一份规则文档。
3. **默认放行 + 兜底**：注册表未声明的菜单全员可见（兼容新增菜单）；判定数据缺失（接口失败/旧版本字段缺失）时菜单可见，操作由服务端兜底拦截——菜单可见性错误不是安全漏洞，服务端校验才是。
4. **拒绝硬编码套餐名**：现存 `plan !== 'Pro'` 式判断全部收敛到注册表；套餐能力优先读 `plan.features` 布尔/配额数值，不写死套餐名字符串。
5. **可见性与可用性分离**：菜单可「置灰+升级引导」（保留发现性，Commercially 合理）或「完全隐藏」（运营需要），注册表里用 `mode: 'hide' | 'disable'` 声明，默认付费墙菜单用 disable+升级引导。

---

## 四、技术实现路径

### 4.1 桌面端

**新增 `composables/useMenuAccess.ts`**（组合三个既有单例，无新数据源）：

```ts
// 菜单项能力声明（注册表，代码内单点真相）
interface MenuCapability {
  flags?: FeatureFlagKey[]              // 全局开关：全部开启才可见
  minPlan?: 'Pro' | 'Enterprise'        // 套餐门槛（或 features 键，二选一声明）
  planFeature?: string                  // plan.features 中的布尔键（如 hasOcr）
  minRoleLevel?: number                 // 角色门槛（50=admin 及以上）
  mode?: 'hide' | 'disable'             // 不满足时的表现，默认 'hide'
}

export const MENU_CAPABILITIES: Record<string, MenuCapability> = {
  'nav.ai':            { flags: ['enable_ai_agent'] },
  'nav.subscription':  { flags: ['enable_subscription'] },
  'settings.ai':       { flags: ['enable_ai_agent'] },
  'settings.subscription': { flags: ['enable_subscription'] },
  'settings.security.2fa': { flags: ['enable_2fa'] },
  'share.create':      { flags: ['enable_public_sharing'] },
  'history.unlimited': { minPlan: 'Pro', mode: 'disable' },   // 收敛现有硬编码
  // 管理员示例（新增入口，见 4.4）
  'nav.admin':         { minRoleLevel: 50 },
}

export function useMenuAccess() {
  const can = (key: string): boolean => { /* 三层与判定，未知键 true */ }
  const modeOf = (key: string): 'ok' | 'hide' | 'disable' => { /* ... */ }
  return { can, modeOf }
}
```

**改造点**（全部是把现有 v-if 换成 `menuAccess.can(...)` 或补声明，不改变现有 flags 行为）：
- `AppSidebar.vue` mainNavItems/accountNavItems 过滤（现有 flag 过滤并入注册表）
- `SettingsDialog.vue` navItems / subPageRegistry / initialCategory 回落逻辑
- `HomeView.vue` 视图渲染 v-if（防 URL 绕过）
- `GeneralSettings.vue` 无限历史改读注册表判定（替换 `plan !== 'Pro'` 硬编码，HomeView 的 999999 哨兵保留）
- 管理员入口（可选，见 4.4）

### 4.2 移动端

**扩展 `FeatureFlagsProvider` → 新增 `MenuAccessProvider`（或在其内加方法）**：`menuAccess.can(key)`，数据源 = feature flags + `auth.user`（plan/roleLevel 原始 Map 里已有）+ 订阅 features（`SubscriptionApiService` 现有接口）。

改造点：底部导航（home_screen.dart NavigationBar 的分支裁剪）、settings_screen tiles（现有两处 flag 门控并入注册表）、item_detail 分享入口、路由深链守卫（`/subscriptions` 等二级路由在对应能力关闭时 redirect 回设置页——与桌面 initialCategory 回落同款防护）。

### 4.3 服务端（无新增表/接口，v1 零后端改动）

判定所需三类信号接口均已存在（feature-flags / auth/me / subscriptions/current）。服务端权威校验现状已覆盖：配额（subscriptionCheck）、开关（requireFlag）、管理（admin RBAC）。**v1 唯一要补的服务端点**：若产品确认「某菜单功能仅限付费用户」，需在对应 API 加套餐校验（如 maxHistory 无限档在服务端按 maxClipboardItems 配额校验——已存在，客户端只是预检）。

### 4.4 管理员客户端入口（提案，需产品确认）

现状：管理员在桌面/移动端**没有任何管理入口**（管理走独立管理台 web）。提案：`roleLevel >= 50` 时侧栏账号区显示「管理控制台」外链入口（打开 `ADMIN_CONSOLE_URL`），仅此而已——**不把管理台功能做进客户端**（安全边界同方案二结论）。

---

## 五、权限划分规则（目标矩阵）

### 5.1 现状矩阵（真实行为，非提案）

| 菜单/功能 | 全局开关 | 套餐 | 角色 | 现状依据 |
|---|---|---|---|---|
| 剪贴板/收藏/归档/设备/个人资料/通知 | — | — | 全员 | 无门控 |
| 模板库/模板变量 | — | — | 全员 | 无门控（数量限额走套餐配额） |
| AI 入口与面板 | enable_ai_agent | — | 全员（AI 工具按角色分级，见方案二） | AppSidebar.vue:139 |
| 订阅入口/页 | enable_subscription | — | 全员 | AppSidebar.vue:80 |
| 公开分享入口 | enable_public_sharing | — | 全员 | ClipboardContextMenu.vue:164 |
| 2FA 绑定 | enable_2fa | — | 全员 | SecuritySubPage.vue:24 |
| 无限历史设置 | — | Pro/Enterprise（硬编码） | — | GeneralSettings.vue:56-65 |
| 上传/存储大小 | — | 按套餐配额（服务端权威） | — | usePlanLimits |
| 管理能力 | — | — | 仅管理台（客户端无入口） | — |

### 5.2 提案规则（需产品确认后实施）

| 菜单/能力 | Free | Pro | Enterprise | 依据建议 |
|---|---|---|---|---|
| 历史条数上限 | 500 | 无限 | 无限 | 维持现状（配额已由套餐表权威定义） |
| OCR / AI 分类 | ❌ | ✅ | ✅ | plan.features.hasOcr/hasAICategories 已存在，客户端未消费——升级为菜单/功能判定 |
| 优先同步 | ❌ | ✅ | ✅ | plan.features.hasPrioritySync |
| 团队共享 | ❌ | ❌ | ✅ | plan.features.hasTeamSharing |
| 管理控制台入口 | — | — | — | roleLevel ≥ 50 显示外链（4.4） |
| 新增付费功能菜单 | — | — | — | 一律在 `subscription_plans.features` 加布尔键 + 注册表声明，禁止硬编码套餐名 |

---

## 六、数据模型设计

**v1：零新表。** 三类信号全部来自既有表/接口：

```
feature_flags(flag_key, enabled)                    → 全局开关（已落地）
subscription_plans.features JSONB                   → 套餐能力布尔（已存在，扩充键即可）
roles(level) + users.role_id                        → 角色门槛（已存在）
users ← user_subscriptions → subscription_plans     → plan 名称（已存在）
```

新增的只有**代码内注册表**（MENU_CAPABILITIES / Flutter 常量 Map），两端各自维护、文档对齐。理由：菜单项与 UI 结构强耦合，放数据库会让每次改菜单都要动表，而菜单变更本来就是代码变更；管理台可配菜单的需求目前不存在。

**v2（预留，暂不实施）**：若运营需要「不停服调整某菜单对某套餐的可见性」，在 `system_configs` 加 `menu_overrides` JSONB 键（`{ "nav.ai": { "minPlan": "Pro" } }`），注册表读时做 deep merge——接口与 feature-flags 同模式（5s 缓存 + WS 推送），架构已预留不阻塞。

---

## 七、兼容性考虑

| 场景 | 行为 |
|---|---|
| 注册表未声明的新菜单 | 默认全员可见（等价现状），不会因接入本机制意外消失 |
| `/api/subscriptions/current` 拉取失败 | usePlanLimits 已有兜底；features 未知时按「不满足」仅影响付费墙菜单的置灰态，不影响基础菜单 |
| 旧版客户端（无注册表） | 零影响：判定纯客户端，服务端无契约变化 |
| plan 字段缺失（历史 bug 兜底） | 按 Free 处理：付费墙菜单置灰/隐藏 + 升级引导，不会误放 |
| 自定义角色（level 任意值） | minRoleLevel 用数值比较（≥50），与方案二「AI 闸门改用 roleLevel」口径一致 |
| flag 关闭 + 套餐满足 | flags 判定先行（运营开关可覆盖一切可见性），与已上线的全链路管控行为一致 |
| 深链/URL 直达被隐藏页面 | 桌面沿用 initialCategory 回落模式（SettingsDialog.vue:145-153）、移动端路由守卫 redirect |

---

## 八、实施路线图

| 阶段 | 内容 | 量级 |
|---|---|---|
| P1 | 桌面端 `useMenuAccess` + 注册表 + 现有 11 处 flag 门控点迁移收敛（行为不变，纯归一）+ GeneralSettings 硬编码替换 | 小 |
| P1 | 移动端 MenuAccessProvider + 3 处现有门控迁移 | 小 |
| P2 | plan.features 消费升级：OCR/AI 分类/优先同步差异化 UI（需产品确认 5.2 矩阵 + 订阅表 features 键核对） | 中 |
| P2 | 管理员「管理控制台」外链入口（4.4） | 小 |
| P3 | v2 menu_overrides 运营可配（仅在真实运营需求出现时启动） | 中 |

每阶段验收：注册表声明的菜单在三类信号变化（切套餐/开关推送/换角色）时即时重渲染；服务端兜底断言复用功能开关测试脚本模式。
