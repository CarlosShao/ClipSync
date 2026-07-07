# ClipSync 桌面端 UI 库改造审计（待审核）

> 生成日期：2026-07-07 ｜ 范围：`src/desktop/src/**` ｜ 状态：**仅列出，未改造**

## ✅ 前置阻塞已解除（2026-07-07 更新）

`shadcn-vue` 工具链**已安装**（commit `9cbf51b`）：`reka-ui` / `class-variance-authority` / `clsx` / `tailwind-merge` / `tw-animate-css` 已入 `package.json`，并新增 `components.json` 与 `src/lib/utils.ts`（`cn()`）。

- 之前的记录"只装了 lucide-vue-next、没装 shadcn"已过时——lucide 只是图标库，**不等于** shadcn 组件库，两者是不同层。
- 当前 globals.css 用的是**自定义 token**（`--bg-base`/`--accent`/`--text-primary`），**不是** shadcn 原生 token（`--background`/`--primary`）。迁移时需加一层 token 映射（见第 6 节），否则 shadcn 组件接不上现有 7 套主题。
- **组件尚未迁移**，仍在"先审核"阶段：等你确认 `dbx` = shadcn-vue 后，再执行 `shadcn-vue add` + 逐个替换。

---

## 1. 内联 SVG 图标（共 70 个，散落 9 个文件）

这些图标全部是手写 `<svg>`，没用 `lucide-vue-next`。应改为 `<component :is="IconName" />` 或 `<XxxIcon />`。

| 文件 | 数量 | 说明 |
|------|------|------|
| `components/auth/AuthPage.vue` | 24 | 睁/闭眼、月亮、Google、微信、对勾、发送等 |
| `components/clipboard/ClipboardView.vue` | 12 | 复制/预览/打开/删除/清空等行内操作图标 |
| `components/settings/SettingsView.vue` | 10 | 各设置组右侧 chevron 箭头 |
| `components/layout/AppSidebar.vue` | 9 | 侧边栏导航图标（剪贴板/设备/链接/资料/订阅…） |
| `components/modals/ModalManager.vue` | 7 | 设备/会话/导出/更新/图片预览等弹窗内图标 |
| `components/settings/ProfileView.vue` | 4 | 相机、编辑铅笔、锁 |
| `components/settings/SharedLinksView.vue` | 2 | 链接/复制 |
| `components/QuickPastePanel.vue` | 1 | 面板图标 |
| `components/ui/ModalDialog.vue` | 1 | 关闭 X |
| **合计** | **70** | |

> 已正确用 lucide 的文件：`ModalManager.vue`（ModalDialog 用法）、`DevicesView.vue`（lucide 图标）。

---

## 2. 原生 `<button>`（手写 class，未走 UI 库的 Button）

全项目用 `<button class="btn btn-primary/btn-ghost/btn-icon/btn-sm…">` 手写，未封装为统一 Button 组件。

| 文件 | 大约数量 | 备注 |
|------|----------|------|
| `components/modals/ModalManager.vue` | ~14 | 各类弹窗按钮 |
| `components/clipboard/ClipboardView.vue` | ~12 | 行内图标按钮 + 底部确认 |
| `components/auth/AuthPage.vue` | ~10 | 登录/注册/发送验证码/改密 |
| `components/settings/ProfileView.vue` | 4 | 保存/取消（昵称、邮箱） |
| `components/settings/SettingsView.vue` | ~5 | 改密码、检查更新 |
| `components/settings/SubscriptionView.vue` | 2 | 换套餐/取消 |
| `components/settings/DevicesView.vue` | 2 | 添加设备 |
| `components/ui/ModalDialog.vue` | 1 | 关闭 |

> 注：早前子代理报"~96 个自定义 button"，实测原始 `<button>` 标签约 **50 个**，其余是 div+@click 伪按钮。数量以本表为准。

---

## 3. 自研 UI 原语（`components/ui/` 目录）

| 文件 | 是否被使用 | 说明 |
|------|------------|------|
| `ui/ModalDialog.vue` | ✅ 用 | ModalManager 中大量 `<ModalDialog>` 调用 |
| `ui/ToastContainer.vue` | ✅ 用 | App.vue / HomeView.vue 挂载 |
| `ui/BaseButton.vue` | ❌ **死代码** | 定义了但全项目无任何 import |
| `ui/BaseInput.vue` | ❌ **死代码** | 同上 |
| `ui/BaseToggle.vue` | ❌ **死代码** | 同上 |

> 结论：`BaseButton/BaseInput/BaseToggle` 是遗留未接线的空壳。真正的按钮都是第 2 节里的裸 `<button>`。**建议：要么删除这三个死文件，要么把它们真正接进按钮体系。**

---

## 4. 原生表单控件（未用 UI 库）

- **`<select>` × 3**：`SettingsView.vue` 第 88/92/96 行，`class="styled-select"`（语言、同步间隔、历史条数）。→ 应换 `Select` 组件。
- **`<input type="checkbox">` × 5**：`AuthPage.vue`（记住我 ×2、同意条款 ×1）、`ClipboardView.vue`（批量选择 ×2）。→ 应换 `Checkbox` 组件。
- **开关 Toggle**：此前已修过"3 个假 toggle"，当前开关分散在设置项里，部分用 checkbox+`accent-color`、部分用 div+@click 模拟。**数量需再精确统计**（grep `toggle/custom-switch` 未命中，说明命名不统一）。→ 统一为 `Switch` 组件。
- **文本输入**：各处 `<input>` 用 `class="input"/"field"` 等手写样式，未封装。→ 统一为 `Input` 组件。

---

## 5. 已干净 / 已正确的文件（无需动）

- `App.vue`、`views/AuthView.vue`、`views/HomeView.vue`：无内联图标、无裸按钮。
- `components/settings/DevicesView.vue`、`components/modals/ModalManager.vue`：已正确使用 lucide 图标。

---

## 6. 建议的改造顺序（待你确认后执行）

1. **先决策装哪个 UI 库**（shadcn-vue 推荐，能与现有 Tailwind v4 + 7 套主题变量对接）。
2. 初始化库 + 配置 `components.json` / 主题 token 映射。
3. 图标：70 个内联 SVG → lucide 组件（按文件逐个替换，每替换完跑一次 `vite build`）。
4. 按钮：裸 `<button>` → 统一 Button 原语；同时**删除 3 个死代码 Base***。
5. 表单：select / checkbox / toggle / input → 对应组件。
6. 全量 `vue-tsc --noEmit` + `vite build` 回归。

---

### 本次已修复但不在上述清单内的关联问题（已提交 e232433）
- 前端 `updateUserProfile` 调错端点 `/api/user/profile` → 改为 `/api/auth/profile`（原 404）。
- 后端 `/api/auth/me` 补回 `email` 字段（此前 SELECT 漏了 email，导致个人页邮箱永远空）。
