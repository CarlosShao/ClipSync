# ClipSync Desktop · Pulse 视觉重构方案

> 状态：设计稿 / 原型阶段 · 不动现有代码 · 全部产出在 `ui-prototype/minimax/`
> 作者：Mavis · 日期：2026-09-12
> 范围：仅桌面端 (Tauri + Vue 3) 的视觉与信息架构重设计

---

## 0. 一句话总结

把 ClipSync 从「带 AI 的剪贴板日志」重塑为「个人记忆的活水流」：
以**时间脉动 + 智能聚合 + 环境智能侧栏**为视觉主线，抛弃 7 套主题的"换皮式多风格"，
收敛为一套统一的 **Pulse 视觉系统**（单色板 + 用户可调强调色相），把操作重心
从「列表表格 + 抽屉」迁移到「顶部命令栏 + 时间线 + 常驻侧栏」。

---

## 1. 现状审计（基于 `src/desktop/src/` 实际代码扫描）

### 1.1 技术栈
- Tauri 2 + Vue 3.5 + Vite 5 + TypeScript
- Tailwind v4 + shadcn-vue（reka-ui）
- Lucide 图标 · 大量 defineAsyncComponent 延迟加载
- i18n 双语（zh/en）· 状态管理用 Pinia

### 1.2 信息架构（路由与组件）
- 路由：`/` (Auth) · `/home/:sub?` · `/quick-paste`
- 侧栏子项（基于 HomeView currentSub）：`clipboard` · `favorites` · `templates` · `ai` · `profile` · `devices` · `subscription` · `notifications`
- 模态家族（ModalManager 门控）：`docPreview` · `imagePreview` · `versions` · `qrPairing` · `pricing` · `billing` · `feedback` · `sessions` · `shortcuts` · `forgotPassword`
- 设置子页（SettingsDialog）：`general` · `appearance` · `privacy` · `shortcuts` · `data` · `ai` · `templateVars` · `workflowRule` · `subscription` · `about` · 7 个 sub-page

### 1.3 视觉现状问题诊断
| # | 现状 | 问题 | 设计影响 |
|---|------|------|---------|
| 1 | 7 套主题（vercel/clipsync/...）+ 暗亮 | 维护成本高、品牌不聚焦、用户选择困难 | 收敛为 1 套 + 用户调色相 |
| 2 | 左侧 240px 文字+图标大侧栏 | 屏幕占用大、视觉权重不平衡 | 60px 图标细栏 + 顶栏命令 |
| 3 | 剪贴板以表格为主 | 表格是"数据库视图"，不是"记忆视图" | 时间线 + 智能卡片 |
| 4 | AI 聊天是独立页面（AiChatPanel）抽屉 | 上下文断裂、占位重 | 常驻 280px Ambient Sidekick |
| 5 | 模态层层叠（最多 10+ 种 ModalManager） | 心智负担、键盘层级栈复杂 | 合并为 3 类：Sheet / Dialog / Popover |
| 6 | 设置：左分类 + 右内容（已不错） | 子页嵌套深（sub-page 一层） | 平铺为 2 列 + 内联详情 |
| 7 | 色彩饱和度偏高（紫调）| 长时间使用疲劳 | oklch 感知一致、低饱和 |
| 8 | 字号档位未严格统一 | 视觉节奏不稳 | 7 档字号 + 8 档间距 |
| 9 | 阴影/边框/圆角各自为政 | 视觉细节割裂 | 4 阶 token 系统 |
| 10 | QuickPaste 是独立子窗口 | 体验"跳" | 整合为 App 内 Cmd+K |

### 1.4 用户典型路径（验证痛点）
- 复制 → 几分钟后想找到上次那条 URL：当前体验 = 翻表/搜 → **痛**：表格无法"叙事"
- 手机截图 → 立刻想在 PC 粘贴：当前体验 = 自动写入系统剪贴板 + 通知 → **痛**：列表无视觉强调，容易淹没
- 想让 AI 总结今天剪过的内容：当前体验 = 切到 AI Tab → 开新对话 → **痛**：上下文没带到
- 添加常用模板：当前体验 = 切到 Templates Tab → 新建 → **痛**：和日常流程割裂

---

## 2. Pulse 概念

### 2.1 隐喻
**剪贴板 = 个人记忆的脉搏**

每一次复制、收藏、模板调用、跨端同步，都是一次"心跳"。
界面把这股脉搏显性化：时间线上的脉冲点、卡片边缘的"流光"、侧栏的呼吸光晕。

### 2.2 三大视觉支柱
1. **Stream（流）** —— 时间线取代表格，自上而下滚动，每条是一个 Pulse
2. **Halo（光晕）** —— Ambient Sidekick 永远在右侧，用"光"来表征 AI 的存在感
3. **Baton（指挥棒）** —— 顶部命令栏（Cmd+K）统一调度所有动作

### 2.3 设计原则（5 条）
1. **节奏 > 装饰**：间距、字号、动画时长形成可感知的节拍
2. **上下文 > 功能**：界面不按"功能分类"组织，按"此时此景"组织
3. **环境 > 中心**：右侧常驻面板是"环境"，不是"工具"
4. **柔和 > 强烈**：长时间使用的工具，色彩要"无声"
5. **一致 > 多样**：宁可只有一种好的视觉语言，不要七种平庸的

---

## 3. 视觉令牌系统（Pulse Design Tokens）

### 3.1 色彩（oklch 感知一致）

**Surface 层（5 阶）**
```
--surface-0: oklch(99% 0 0)        /* 主背景 */
--surface-1: oklch(98% 0 0)        /* 卡片 */
--surface-2: oklch(96% 0 0)        /* 浮起 */
--surface-3: oklch(94% 0 0)        /* 选中 */
--surface-inset: oklch(95% 0 0)    /* 凹陷/输入 */
```

**Dark 模式**
```
--surface-0: oklch(16% 0.005 270)  /* 深紫灰 */
--surface-1: oklch(19% 0.008 270)
--surface-2: oklch(22% 0.010 270)
--surface-3: oklch(26% 0.012 270)
--surface-inset: oklch(14% 0.005 270)
```

**Accent（用户可调色相，默认 250° 紫蓝）**
```
--accent-hue: 250
--accent-500: oklch(58% 0.20 var(--accent-hue))
--accent-400: oklch(68% 0.18 var(--accent-hue))
--accent-600: oklch(50% 0.20 var(--accent-hue))
--accent-glow: oklch(58% 0.20 var(--accent-hue) / 0.18)
```

**文字（3 阶）**
```
--text-strong: oklch(22% 0.01 var(--accent-hue))
--text-default: oklch(38% 0.01 var(--accent-hue))
--text-muted: oklch(58% 0.01 var(--accent-hue))
--text-faint: oklch(72% 0.01 var(--accent-hue))
```

**状态色（语义固定，不随强调色相变化）**
```
--status-success: oklch(64% 0.16 150)
--status-warn:    oklch(72% 0.15 70)
--status-danger:  oklch(60% 0.20 25)
--status-info:    oklch(64% 0.14 230)
```

### 3.2 字号（7 档）
```
--type-xs:   11px / 1.45  /* 标签、时间 */
--type-sm:   12.5px / 1.5 /* 次要文本 */
--type-base: 14px / 1.55  /* 正文 */
--type-md:   15.5px / 1.5 /* 卡片标题 */
--type-lg:   18px / 1.4   /* 段落标题 */
--type-xl:   22px / 1.3   /* 区块标题 */
--type-2xl:  32px / 1.2   /* 数字统计 */
```

### 3.3 间距（8 档 4px 基线 + 2 档呼吸）
```
--space-1: 4px
--space-2: 8px
--space-3: 12px
--space-4: 16px
--space-5: 20px
--space-6: 24px
--space-8: 32px
--space-10: 40px
--space-12: 48px
--space-16: 64px
--space-breath: 96px  /* Hero 级留白 */
```

### 3.4 圆角（4 档 + 1 全圆）
```
--radius-sm: 6px   /* 标签、徽章 */
--radius-md: 10px  /* 按钮、输入 */
--radius-lg: 14px  /* 卡片 */
--radius-xl: 20px  /* 弹层 */
--radius-full: 9999px
```

### 3.5 阴影（4 阶，去黑化）
阴影是 oklch 调制的"紫调"灰，避免纯黑：
```
--shadow-1: 0 1px 2px oklch(20% 0.02 270 / 0.06), 0 1px 1px oklch(20% 0.02 270 / 0.04)
--shadow-2: 0 4px 12px oklch(20% 0.02 270 / 0.08), 0 1px 3px oklch(20% 0.02 270 / 0.05)
--shadow-3: 0 12px 32px oklch(20% 0.02 270 / 0.12), 0 4px 8px oklch(20% 0.02 270 / 0.06)
--shadow-glow: 0 0 0 1px oklch(58% 0.20 var(--accent-hue) / 0.3),
               0 8px 24px oklch(58% 0.20 var(--accent-hue) / 0.18)
```

### 3.6 动效
```
--ease-out: cubic-bezier(0.16, 1, 0.3, 1)   /* 缓慢收尾 */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1) /* 弹性 */
--duration-instant: 80ms
--duration-fast: 160ms
--duration-base: 240ms
--duration-slow: 380ms
```

### 3.7 图标
- 默认 1.5px 描边（当前是 1.85~2，Pulse 偏细更现代）
- 关键动作图标（保存、发送、删除）保留 1.75px
- 尺寸档位：14 / 16 / 18 / 20 / 24

---

## 4. 信息架构重构

### 4.1 导航骨架（对比）

| 当前 | Pulse |
|------|-------|
| 左侧 240px 大侧栏（图标+文字+子菜单） | 左侧 60px 图标细栏（悬停展开 tooltip） |
| 顶部 0 | 顶部 56px Baton 命令栏（Cmd+K 触发） |
| 右侧 0（模态弹层） | 右侧 280px Halo Sidekick（常驻，3 种角色） |
| 8 个侧栏项 | 6 个细栏项 + 任意动作走命令栏 |

### 4.2 路由收敛
```
/                    → AuthView（保留原样，仅做视觉刷新）
/home                → Stream（默认，原 clipboard）
/home/favorites      → Collections（卡片网格 + 拖拽）
/home/templates      → Templates（卡片网格）
/home/devices        → Devices（设备仪表盘 + QR 配对）
/home/settings       → Settings（平铺双列）
/home/library        → 新增：所有剪贴板项的"档案馆"（旧 archive/搜索结果）
```

**被收纳**：
- `ai` 不再是路由 → 永远在 Halo Sidekick
- `profile` 不再是路由 → 收纳进 Settings 顶栏头像
- `subscription` 不再是路由 → 收纳进 Settings → 账户
- `notifications` 不再是路由 → 收纳进 Halo Sidekick 顶部铃铛
- `quick-paste` 不再是独立窗口 → 顶栏 Cmd+K 的二级面板
- 所有 ModalManager 的 Dialog（10+ 种）→ 收敛为 3 种容器：Sheet / Dialog / Popover

### 4.3 Halo Sidekick 的 4 种角色
按当前页面上下文自动切换，也可手动：
1. **Companion（默认）** —— 今日概览 + 建议操作
2. **Assistant** —— AI 对话（替代独立 AI 页）
3. **Inspector** —— 选中条目的元数据/版本/分享/原文
4. **Library** —— 通知中心 + 公告

切换用顶部的 4 段 Segmented Control。

---

## 5. 核心页面设计（详见各 screens/*.html）

### 5.1 Stream（首页 / 主时间线）—— `screens/01-stream.html`
- 左侧 60px 图标细栏（Home / Favorites / Templates / Devices / Settings / + 主题切换）
- 顶部 56px Baton：搜索框（占中）+ 状态点（同步、Pin、亮度）+ 头像
- 中央：Stream 时间线
  - 按"会话"分组（5 分钟无活动自动分组）
  - 每组头部：相对时间 + 数量徽章
  - 每条 Pulse Card：左侧小色条（按内容类型 + 设备颜色）→ 类型图标 → 预览（前 2 行）→ 元信息（设备·时间·大小）→ hover 时浮现动作条
  - 特殊条目（密码保护、AI 建议、设备跨端）：右侧附 Pixel Chip 角标
- 右侧 280px Halo：Companion 角色
  - 顶部：今日活跃度小图（24h 折线）
  - 中部：建议操作（"清理 7 天前" / "为这条加标签"）
  - 底部：AI 输入条（半透明，聚焦后扩成 Assistant）
- 底部状态栏：设备连接 + 同步中动画 + 快捷键提示

### 5.2 Collections（收藏）—— `screens/02-collections.html`
- 主区顶部：搜索 + 视图切换（网格/列表）
- 网格视图：每个 Collection 是大卡片
  - 头部：图标 + 名称 + 条目数
  - 缩略图墙（前 4 条混合缩略图）
  - 标签云（最多 5 个）
  - 右下角"打开"按钮（进入收藏详情时间线）
- 新建按钮：右上角浮动"FAB-light"（不是全 FAB，是顶栏次按钮）
- 详情：进入 5.1 同款时间线，但左侧多了"返回到 Collections"面包屑

### 5.3 Templates（模板）—— `screens/03-templates.html`
- 类似 Collections，但卡片上多一个"立即使用"主按钮
- 模板编辑器从模态改为内联页（点模板进入编辑态，而非弹窗）
- 变量填充从模态改为侧栏滑出（240px 临时 Sheet）

### 5.4 Devices（设备）—— `screens/04-devices.html`
- 顶部：所有设备连接状态总览（横向卡片带）
- 主体：本机 vs 远端设备 对比
  - 每设备卡片：设备头像 + 名称 + 系统 + 最后在线 + 流量统计 + 三点菜单
- 配对 QR：右上角"添加设备" → 弹出 Popover（非模态）
- 历史会话折叠在卡片下方（可展开）

### 5.5 Settings（设置）—— `screens/05-settings.html`
- 不再分 7 个 sub-page，全平铺为**两列布局**
- 左列：分类（账户/外观/快捷键/数据/AI/隐私/关于），每项带一行简介
- 右列：当前分类的所有选项，竖向排列
- 顶栏：分类面包屑 + "已修改未保存"提示
- 危险操作（删除数据、撤销设备）走底部红区，不弹模态

### 5.6 Halo Assistant（AI）—— `screens/06-halo-assistant.html`
- 演示 Halo Sidekick 展开为 Assistant 角色
- 顶部：会话历史（横向 chip 滚动条）
- 中部：对话流（用户右对齐，AI 左对齐）
- 底部：输入区，支持附件/语音/模板变量插入
- 右下：用量计（迷你 Sparkline）
- 全程不脱离 Stream 上下文（左侧缩略时间线可见）

### 5.7 Command Palette（Cmd+K）—— `screens/07-command-palette.html`
- 居中浮层 640px
- 输入框 + 实时结果（命令 / 剪贴板项 / 模板 / 设备操作 / AI 提问）
- 分组：动作 / 跳到 / 搜索 / 提问
- 键盘导航 ↑↓ Tab Enter
- ESC 关闭不打断当前流

### 5.8 Onboarding（首次启动）—— `screens/08-onboarding.html`
- 全屏三步：欢迎 → 选强调色相 → 完成（带桌面快捷方式创建提示）
- 颜色相选用 12 段色环，用户点击有 spring 反馈
- 文案克制，不堆介绍

---

## 6. 组件库重设计（Pulse Components）

### 6.1 Pulse Card
- 12-16px 内边距 · 14px 圆角 · 表面 1 背景 · 1px hairline 边
- 左侧 4px 圆角色条（内容类型 + 设备色调混合）
- hover：surface-2 + 微上浮 -1px + shadow-1
- 选中：accent 1px 边 + accent-glow 阴影

### 6.2 Halo Pill（按钮）
- 主操作：accent-500 实心 + 白字 + radius-md + shadow-glow
- 次操作：surface-1 + hairline 边
- 文字按钮：无背景 hover 时下划线展开

### 6.3 Baton Input（顶栏搜索）
- 占中 480px，surface-inset 背景
- 左侧放大镜 / 右侧 ⌘K 提示
- 聚焦：白底 + accent 边 + shadow-glow
- 输入后下方出 Popover 浮层（不分页跳转）

### 6.4 Pulse Avatar
- 28/32/40/56 四档
- 默认渐变（基于用户名 hash 出色相）
- 在线状态：右下 8px 色点（绿/灰/红）

### 6.5 Pulse Tag
- 圆角 6px · 6px 内边距 · 11px 字
- 5 种语义色（设备/内容/AI/密码/共享）
- 可关闭（× 在内）

### 6.6 Halo Sidekick 容器
- 280px 宽，surface-1 背景，hairline 左边界
- 顶部 56px 同顶栏对齐
- 三段式：Header（角色切换） / Body（滚动） / Footer（输入条）
- 折叠：留 8px 把手，hover 展开

### 6.7 Time Stream Dot（时间线节点）
- 每组的首条左侧：12px 圆点（accent 渐变）+ 24px 时间竖线
- 持续脉冲：dot 边缘有 8px 弱光晕（仅本机来源时有，AI/远端设备无）

---

## 7. 与现状对比（迁移清单）

| 现状文件 | 处置 | 备注 |
|---------|------|------|
| `src/styles/globals.css`（7 主题） | 重写为 1 套 Pulse 主题 + 色相变量 | 删除 6 套 |
| `src/components/layout/AppSidebar.vue`（240px 侧栏） | 改为 60px IconRail | 新组件 IconRail |
| `src/components/clipboard/ClipboardView.vue`（表格） | 改为 TimeStream | 新组件 TimeStream |
| `src/components/ai/AiChatPanel.vue`（独立抽屉） | 收纳进 Halo Sidekick | 改 HaloAssistant |
| `src/components/QuickPastePanel.vue` | 改用 CommandPalette | Cmd+K 统一入口 |
| `src/components/modals/ModalManager.vue`（10+ 模态） | 收敛为 Sheet / Dialog / Popover 三类 | 减 70% 模态数 |
| `src/components/settings/settings-dialog/*`（sub-page 层） | 平铺 | 改 PulseSettings |
| `src/views/HomeView.vue` 巨型壳 | 拆为 Layout + Slot | 责任单一化 |
| `src/components/OnboardingView.vue` | 重新设计 | 见 5.8 |
| `src/router/index.ts` 路由 | 收敛 | 见 4.2 |

---

## 8. 实施路线（建议 3 阶段，不动实际代码的提议）

> 这部分**不是本任务范围**，仅作为后续工作参考。

- **Phase 1（2 周）**：令牌 + 主题切换 + IconRail + Halo 壳（不破坏现有功能）
- **Phase 2（3 周）**：TimeStream 替换 ClipboardView · CommandPalette 替换 QuickPaste
- **Phase 3（2 周）**：AI 收纳进 Halo · 设置平铺 · 模态收敛

总周期约 7 周，单人前端可完成；联调/回归/双远端 1 周。

---

## 9. 原型导航

- `index.html` —— 8 页交互式总览（点击左侧细栏切换）
- `design-system.html` —— 令牌与组件展示
- `screens/01-stream.html` ~ `08-onboarding.html` —— 8 张高保真独立页
- `README.md` —— 入口

---

> 备注：所有 HTML/CSS/JS 均为**原型用**，不接入任何业务逻辑；产出仅限 `ui-prototype/minimax/`。
