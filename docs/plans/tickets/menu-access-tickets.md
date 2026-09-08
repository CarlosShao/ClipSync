# 工单：功能菜单细粒度访问控制（方案一落地）

- **方案**：[../design-proposals/feature-menu-access-control.md](../design-proposals/feature-menu-access-control.md)
- **前置**：功能开关全链路管控已上线（34/34 PASS）
- **状态标记**：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞
- **决策依赖**：MA-20/MA-21 需产品确认（方案一 5.2 提案矩阵、管理员入口）

---

## MA-01 桌面端 useMenuAccess 基建 ✅ P1（单测本轮补齐：vitest 17 用例覆盖三层真值表/未知键放行/modeOf/superAdmin 豁免/overrides）
- **改动**：新增 `src/desktop/src/composables/useMenuAccess.ts`：
  - `MENU_CAPABILITIES` 注册表（声明 flags / minPlan / planFeature / minRoleLevel / mode）
  - `can(key)`（三层与判定，未知键 true）、`modeOf(key)`（ok/hide/disable）
  - 数据源组合：useFeatureFlags（已上线）+ useUser（roleKey/roleLevel，已存在未消费）+ plan（configStore.user.plan）
- **验收**：单测覆盖三层组合真值表；未知键默认放行

## MA-02 桌面端现有门控点迁移收敛 ✅ P1
- **改动**：把已上线的 11 处 flag v-if 切到 menuAccess（行为不变，纯归一）：
  - AppSidebar.vue:80（subscription 入口）、:139（AI 入口）
  - SettingsDialog.vue:84/87（分类）、:145-153（initialCategory 回落）
  - HomeView.vue:64/127-133/618/626/637（aiEnabled/订阅页/AiChatPanel/AiSummaryFloat）
  - ClipboardView.vue:472（AiSuggestPopup）
  - ClipboardContextMenu.vue:164、ClipboardTableRow.vue:244（分享项）
  - SecuritySubPage.vue:24（2FA 区块）
- **依赖**：MA-01
- **验收**：`scripts/feature-flags-audit/run-flags-audit.mjs` 34 项仍全 PASS；UI 行为与迁移前一致

## MA-03 桌面端硬编码套餐判断收敛 ✅ P1
- **改动**：GeneralSettings.vue:56-65、L230-241 的 `plan !== 'Pro' && plan !== 'Enterprise'` 改为注册表 `history.unlimited`（minPlan: 'Pro', mode: 'disable'）；HomeView.vue:104-108 的 999999 哨兵保留
- **依赖**：MA-01
- **验收**：Free 选「无限」仍被拒+升级文案；Pro/Enterprise 正常

## MA-04 移动端 MenuAccess 基建与迁移 ✅ P1（深链守卫本轮补齐：/subscriptions、/shared-links redirect 回设置 tab；flags 同步读、并入 refreshListenable）
- **改动**：FeatureFlagsProvider 扩展 `can(key)/modeOf(key)`（数据源：flags + auth.user.plan/roleLevel + 订阅 features）；settings_screen.dart:284/310、item_detail_screen.dart:1193 三处现有门控切到注册表；`/subscriptions`、`/shared-links` 等二级路由加深链守卫（能力关闭时 redirect 回设置页，对齐桌面 initialCategory 回落）
- **依赖**：MA-01 的注册表键定义（Flutter 侧镜像常量）
- **验收**：开关推送后底部导航/tiles 即时显隐；深链直达被禁页面会回落

## MA-05 plan.features 消费升级（差异化功能菜单）✅ P2（2026-09-08 拍板：全部补齐。features 快照接线（来源 /api/subscriptions/current 的 plan.features，applyPlanFeatures 整体替换语义）；feature.ai_categories 两端消费落位（桌面 AIProviderSettings「AI 智能分类」卡：可用徽标/置灰+Pro 引导）；share.create planFeature 层两端生效；OCR 键名已定 feature.ocr——服务端无独立 OCR REST 端点（仅后台 OCR），挂墙待功能立项，planFeature.js 注释留痕）
- **前置决策**：方案一 5.2 提案矩阵（OCR/AI 分类/优先同步/团队共享 哪个套餐可用）+ 核对 subscription_plans.features 现有键（hasOcr/hasPrioritySync/hasAICategories/hasTeamSharing）
- **改动**：注册表新增对应菜单/能力键（读 features 布尔，禁止硬编码套餐名）；两端 UI 分叉（隐藏或置灰+升级引导，对齐 useUploadLimitNotice 的升级路径）
- **验收**：Free/Pro/Enterprise 三账号实测菜单差异与方案矩阵一致

## MA-06 管理控制台入口（桌面）✅ P2（决策追认：minRoleLevel 50 收紧为仅 super_admin（决策记录 2026-09-07，用户指定唯一超管 13505110772）；并增强 RB-SSO 单点登录——点击签发一次性 code 免密直达管理台，见 rbac 工单 RB-12）
- **前置决策**：是否在客户端加管理员外链入口（方案一 4.4：roleLevel≥50 显示「管理控制台」外链，不把管理功能做进客户端）
- **改动**：AppSidebar 账号区按 minRoleLevel: 50 渲染外链项（ADMIN_CONSOLE_URL 可配）
- **验收**：admin/super_admin 可见，普通用户不可见；点击打开管理台

## MA-07 v2 menu_overrides 运营可配 ⬜ P3（暂缓——但注意：system_configs.menu_overrides 键、管理台编辑 UI、桌面端 setOverrides 判定层均已超前落地（050 迁移 + settings JSON 编辑卡 + useMenuAccess L82-95）；**未通**：客户端自动拉取（缺公开只读端点）、WS 推送、移动端支持。出现真实运营需求时只需接通这三处）
- **触发条件**：出现真实运营需求（不停服调整菜单可见性）时启动
- **改动**：system_configs 新键 `menu_overrides` JSONB + 注册表 deep merge + WS 推送（feature-flags 同款模式）

---

## 验收总口径

- MA-01~04 为纯重构（行为不变），完成后跑 feature-flags-audit 全 PASS
- MA-05/06 需产品决策后实施，矩阵写入方案一 5.2 后作为验收依据
- 每工单涉及 UI 的部分附截图证据（gui-test-screenshots/ 惯例）
