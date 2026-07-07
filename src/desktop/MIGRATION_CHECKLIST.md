# shadcn-vue 合规深度审计 Checklist

**创建时间**：2026-07-07 14:04
**审计工具**：grep 全量扫描 + 人工核对（anti-shortcut-workflow）
**目标**：验证桌面端所有组件 / 图标 / 按钮 / 输入是否都已替换为 shadcn-vue 规范实现
**完成度**：见底部（修复前基线）

---

## 审计维度 & 发现

### 1. 内联 SVG 图标 → lucide（tech-stack-ui 11.3 禁止自己画 SVG）
- [x] 业务图标（Camera/Pencil/Lock/Settings 等）：已全量迁 lucide
- [x] shadcn 组件内部图标（Checkbox 勾选、Select 箭头）：已用 lucide
- [~] **AuthPage.vue 仍含 7 个内联 `<svg>` 品牌图标**（WeChat / Apple / GitHub / WeCom）
  - 判定：**合理例外**——lucide-vue-next **不含任何品牌图标**，tech-stack-ui 11.3 也允许"实在没有 → 自引 SVG"。需记录，非漏洞。

### 2. 表单输入 `<input>` → shadcn `<Input>`（tech-stack-ui 11.6 禁止自己写表单原语）
- [x] ProfileView 头像/资料输入：已用 `<Input>`
- [x] SettingsView 密码表单：已用 `<Input>`
- [ ] **AuthPage.vue：16 个 raw `<input class="form-input">` 未迁移**（登录/注册/找回密码全部字段）
- [ ] **ModalManager.vue：5 个 raw `<input>` 未迁移**（找回密码弹窗 4 个 + 手动配对 token 1 个，含巨大内联 style）
- [ ] **ClipboardView.vue：1 个搜索框 raw `<input class="search-input">` 未迁移**
- [ ] **QuickPastePanel.vue：1 个搜索框 raw `<input class="qp-search-input">` 未迁移**
- [~] 隐藏文件触发器 `<input type="file" style="display:none">`（ClipboardView/ProfileView）：保留 raw，因 shadcn Input type=file 会渲染选择器 UI，此处需隐藏触发——**合理例外**

### 3. 按钮 `<button>` → shadcn `<Button>`（适用处）
- [x] 提交/主要操作按钮（AuthPage 登录/注册提交、SettingsView 密码保存等）：已用 `<Button>`
- [ ] **AuthPage.vue：`btn-code` 发送验证码按钮（2 处）仍是 raw `<button class="btn-code">`** → 应改 `<Button>`
- [~] 以下 raw `<button>` 为**自定义设计模式，判定合理例外**（非"漏迁移"）：
  - 分段控件：SettingsView `mode-btn`(亮/暗)、ClipboardView `tab-btn`(筛选)、AuthPage `auth-tab`(登录方式)
  - 导航项：AppSidebar `sb-item`、ModalManager `payment-option`
  - 图标/文字按钮：`pwd-toggle`(密码显隐)、`link-btn`、`back-btn`、`theme-pill`、`social-btn`(品牌登录)
  - 注：如追求 100% 规范，分段控件可改 shadcn `Tabs`，导航项可改 `Button variant`，但属设计取舍非缺陷。

### 4. Checkbox / Switch → shadcn（已完成）
- [x] AuthPage `rememberMe` / `regAgree`：已用 shadcn `<Checkbox>`
- [x] SettingsView 所有开关：已用 shadcn `<Switch>`
- [x] ModalManager demo 开关：已用 shadcn `<Switch>`

### 5. 硬编码颜色（tech-stack-ui 11.4 禁止 bg-white/text-black/#hex）
- [x] 全量扫描 `bg-white|text-black|#fff|#000|bg-gray`：**0 命中** ✓
- [x] globals.css 用 CSS 变量主题 token（`--background`/`--primary` 等别名层映射到 7 套主题）

### 6. 内联 `style="..."`（tech-stack-ui 11.4 禁止，动态计算值除外）
- [~] 全量 **97 处** inline style。多数合法（动态值如 `:style="{'--x':v}"`、隐藏 `display:none`）。
  - **ModalManager.vue:641 手动配对 token 输入框** 用了一长串内联 style（flex/height/padding/border/radius/color 全写死）——应抽出为 class 或用 `<Input>`。

### 7. 目录结构规范（tech-stack-ui 11.2）
- [x] shadcn 组件均在 `src/components/ui/<name>/`，可改源码 ✓
- [x] `cn()` 工具（`@/lib/utils`）已就位 ✓
- [x] 无 `import from 'shadcn'` 误用 ✓
- [x] 无重命名/挪到 lib 的违规 ✓

### 8. 组件库混用（tech-stack-ui 11.1 禁止多库混用）
- [x] 仅 reka-ui（shadcn 引擎）+ lucide-vue-next（图标），无第二套 UI 库 ✓
- [x] 已移除冗余 `@lucide/vue`（931c569）✓

---

## 修复前基线完成度

| 维度 | 状态 | 说明 |
|------|------|------|
| 图标 | ~95% | 仅 7 品牌 SVG 合理例外 |
| 输入 Input | **~30%** | AuthPage/ModalManager/Clipboard/QuickPaste 共 23 个 raw input 未迁 |
| 按钮 Button | ~85% | btn-code 未迁；分段/导航为合理例外 |
| Checkbox/Switch | 100% | 已完成 |
| 颜色 token | 100% | 0 硬编码 |
| 目录结构 | 100% | 规范 |
| 库混用 | 100% | 单一 |

**综合：约 70% 合规。最大缺口 = 表单输入未迁移（23 个 raw input）。**

---

## 本轮修复计划（Round 1）

- [x] A. AuthPage：16 个 raw input → `<Input>` + 补 Input import
- [x] B. AuthPage：`btn-code` 2 处 → `<Button>`
- [x] C. ModalManager：5 个 raw input → `<Input>` + 补 import + 清理 641 内联 style（抽 `.manual-token-input` 类）
- [x] D. ClipboardView：搜索框 → `<Input>` + 补 import
- [x] E. QuickPastePanel：搜索框 → `<Input>` + 补 import
- [x] F. 构建验证（vue-tsc 0 错误 + vite build 通过）
- [x] G. 提交

## 验证记录

### Round 1（2026-07-07 14:30）
- 修复：AuthPage 16 input + 2 btn-code、ModalManager 5 input + 清内联 style、ClipboardView 1 input、QuickPastePanel 1 input → 全部改 shadcn `<Input>`/`<Button>`
- 验证方式：`grep` 反向扫描确认 0 个 raw 非 file `<input>`；`npm run build`（vue-tsc + vite）通过
- 完成度从 ~70% → **~92%**

### 仍属合理例外（非缺陷，未改）
- AuthPage 7 个品牌 SVG（WeChat/Apple/GitHub/WeCom）：lucide 无品牌图标，允许自引
- 分段/导航/品牌自定义 `<button>`（mode-btn/tab-btn/auth-tab/sb-item/payment-option/pwd-toggle/link-btn/back-btn/theme-pill/social-btn）：设计模式取舍
- 隐藏文件触发器 `<input type="file" style="display:none">`（ClipboardView/ProfileView）：shadcn Input type=file 会渲染选择器，此处需隐藏
- 97 处 inline style 中绝大多数合法（动态值/display:none），仅 ModalManager 641 已清理，其余保留

### Round 2（如需 100%）
- 将分段控件（mode-btn/tab-btn/auth-tab）重构为 shadcn `Tabs`
- 将导航项（sb-item/payment-option）重构为 `Button` 变体
- 若坚持 0 内联 style：剩余合法 inline 改为 class（低优先级）

