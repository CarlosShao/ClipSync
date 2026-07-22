# 桌面端原生元素样式迁移清单

> 本文档记录了桌面端使用原生 HTML 元素（`<button>` / `<input>`）而非 shadcn-vue 组件的所有功能点，
> 供后续样式重构时参考。按功能模块分类，标注优先级和当前状况。

---

## 总览

| 类别 | 原生 `<button>` | 原生 `<input>` | `!important` 数量 | 优先级 |
|---|---|---|---|---|
| 收藏夹页 | ~30 处 | 6 处 | 27 处 | P0 |
| 侧边栏导航 | 7 处 | 0 | 4 处 | P1 |
| 剪贴板筛选栏 | 5 处 | 0 | 3 处 | P2 |
| PIN 验证弹窗 | 3 处 | 1 处 | 0 | P2 |
| 登录注册页 | 4 处 | 0 | 4 处 | P3 |
| 设置页（亮暗切换） | ~~2 处~~ 已迁移 | 0 | 1 处 | ~~P1~~ ✅ 已完成 |
| 弹窗管理器 | 2 处 | 0 | 5 处 | P3 |
| 文档抽屉 | 1 处 | 0 | 0 | P3 |
| 保护/密码对话框 | 2 处 | 4 处 | 0 | P2 |
| 快速粘贴面板 | 1 处 | 0 | 5 处 | P2 |
| ModalDialog | 1 处 | 0 | 0 | P3 |

---

## P0 — 收藏夹页（FavoritesView）

原生元素最密集的页面，几乎未使用任何 shadcn 组件，`!important` 数量最多（27处）。

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 面包屑导航 | 面包屑中的目录跳转按钮 | `<Button variant="ghost" size="sm">` |
| 集合树节点删除 | × 按钮（删除集合） | `<Button variant="ghost" size="icon-sm">` |
| 视图切换 | 网格/列表视图切换按钮 | `<Button variant="ghost" size="icon-sm">` |
| 标签过滤 Pill | "全部" + 各标签名的过滤按钮 | `<Badge variant="outline">` 或自定义 |
| 标签删除 | 标签 pill 上的 × 按钮 | `<Button variant="ghost" size="icon-sm">` |
| 标签编辑 | 标签编辑/保存/取消按钮 | `<Button variant="ghost">` / `<Button variant="default">` |
| 标签建议列表 | 候选标签选项按钮 | `<Badge variant="secondary">` |
| 颜色选择器色块 | 标签颜色预设色块 | 自定义 ColorSwatch 组件 |
| 颜色选择器操作 | 清除/保存/关闭按钮 | `<Button variant="ghost" size="sm">` |
| 集合选择下拉 | 添加到集合的下拉选项 | 迁移至 `<Popover>` + `<Button>` |
| 右键菜单 | 重命名/新建子集/移到根目录/删除 | 自定义 ContextMenu 组件 |

### 原生 `<input>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 收藏夹搜索框 | `.fav-search-input` 搜索输入 | shadcn `<Input>` + Search 图标 |
| 标签输入框 | `.fav-tag-input` 标签编辑输入 | shadcn `<Input>` |
| 颜色选择器 | `type="color"` × 4 处（网格+列表视图各2份） | 保留原生 color input（shadcn 无替代） |

---

## P1 — 侧边栏（AppSidebar）

侧边栏整体为手写实现（370+ 行 scoped CSS），未使用 shadcn Sidebar 组件。

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 主导航按钮 | 剪贴板/收藏/模板/设备 4个 | `<Button variant="ghost">` |
| 账户导航按钮 | 个人/订阅/设置 3个 | `<Button variant="ghost">` |
| 用户菜单项 | 个人资料/通知/退出 3个 | `<Button variant="ghost">`（已有 scoped CSS） |

### 可选方案

- **方案 A**：逐个替换为 shadcn Button（保守）
- **方案 B**：迁移至 shadcn Sidebar 组件（大改，但能省 370 行 CSS）

---

## P2 — 剪贴板页（ClipboardView）

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 分类筛选分段控制 | 全部/文本/图片/链接/文件 5个 | `<Button variant="ghost">` + 分段样式 |
| 加载更多按钮 | 分页加载更多 | `<Button variant="outline" size="sm">` |

### 原生 `<input>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 文件上传隐藏 input | `type="file" style="display:none"` | 保留（功能正确，无需改） |

### `!important` 重灾区（17处）

- 工具栏按钮 padding 强制覆盖
- 高级搜索面板高度强制对齐（CustomSelect / Input）
- 条目保护遮罩按钮 padding

---

## P2 — PIN 验证弹窗（HomeView）

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 取消按钮 | `.pin-btn-cancel` | `<Button variant="outline">` |
| 前往设置按钮 | `.pin-btn-primary` | `<Button>` |
| 验证按钮 | `.pin-btn-primary` | `<Button>` |

### 原生 `<input>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| PIN 密码输入 | `.pin-input` 数字密码框 | shadcn `<Input>` |

---

## P2 — 保护对话框（ProtectionDialog）

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 关闭按钮 | `protection-close` | `<Button variant="ghost" size="icon-sm">` |
| 密码可见性切换 | 眼睛图标按钮 | `<Button variant="ghost" size="icon-sm">` |

### 原生 `<input>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 保护级别单选 | `type="radio"` × 3 | shadcn RadioGroup（或保留原生 radio） |

---

## P2 — 条目密码对话框（ItemPasswordDialog）

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 密码可见性切换 × 2 | 眼睛图标按钮 | `<Button variant="ghost" size="icon-sm">` |

---

## P2 — 快速粘贴面板（QuickPasteStandalone）

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 类型筛选按钮 | 全部/文本/图片/文件/链接 | `<Button variant="ghost" size="sm">` |

---

## P3 — 登录注册页（AuthPage）

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 社交登录按钮 × 4 | 微信/Apple/GitHub/企业微信 | `<Button variant="outline">` |
| （登录/注册/发送验证码） | 已使用 shadcn Button | 无需修改 |

---

## P3 — 弹窗管理器（ModalManager）

### 原生 `<button>` 使用点

| 功能区域 | 原生元素说明 | 建议替代 |
|---|---|---|
| 反馈类型选择 | 建议/改进/Bug 切换按钮 | `<Button variant="ghost">` 分段控制 |
| 文档预览按钮 | 内容预览按钮 | `<Button variant="outline">` |

### `!important` 数量：5处

---

## P3 — 其他零散位置

### ModalDialog
- 关闭按钮（×）→ `<Button variant="ghost" size="icon-sm">`

### DocumentDrawer
- Excel 工作表 tab 按钮 → `<Tabs>` 组件

### 设置页 ProfileView
- 头像上传隐藏 input → 保留（`display:none` 功能正确）

---

## 已完成的迁移

### ✅ 设置页 — 亮色/暗色模式切换按钮
- 原：原生 `<button class="mode-seg-btn">` + 12 行自定义 CSS
- 现：shadcn `<Button variant="ghost" size="sm">` + scoped CSS（45 行，含 focus ring 和无障碍支持）
- 文件：`SettingsView.vue` — 类名 `mode-seg-shadcn` / `mode-seg-btn-shadcn`

---

## 迁移策略建议

### 最小风险路径

1. **先做 `globals.css` 兜底**（零破坏）：给裸 `<button>` / `<input>` 加全局基础样式
2. **逐页替换**：每个页面独立提交，不影响其他页面
3. **先 P0（收藏夹）再 P1（侧边栏）**：收藏夹问题最密集，收益最大

### globals.css 兜底样式参考

```css
/* ===== RAW ELEMENT BASE RESET =====
   兜底：确保裸 <button> / <input> 至少有合理的 padding 和 border-radius，
   防止 AI 生成代码时用原生元素导致样式坍塌。 */
button:not([class]) {
  padding: 8px 16px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
input:not([type="hidden"]):not([type="color"]):not([type="radio"]):not([type="checkbox"]) {
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}
input:not([type="hidden"]):not([type="color"]):not([type="radio"]):not([type="checkbox"]):focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--accent-light);
}
```

### 注意事项

- `!important` 的存在往往是因为 AI 生成的裸元素没有走 shadcn 组件管线，
  兜底样式能从根本上减少这类问题的产生
- `type="color"` / `type="radio"` / `type="checkbox"` / `type="file"` 等特殊 input 无需兜底
- 已有的 scoped CSS 中的 `!important` 可在对应的页面迁移后逐步清理
