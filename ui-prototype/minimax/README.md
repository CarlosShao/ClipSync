# ClipSync 桌面端 · Pulse 视觉重构原型

> 状态：设计稿 / 原型阶段 · **不动实际代码** · 全部产出在本目录
> 概念：**Pulse** — 把剪贴板从"日志表格"重塑为"个人记忆的活水流"

---

## 入口

- 📄 **[DESIGN_PROPOSAL.md](./DESIGN_PROPOSAL.md)** — 完整设计提案（必读）
- 🎨 **[design-system.html](./design-system.html)** — 视觉系统展示（令牌 + 组件）
- 🖼️ **[index.html](./index.html)** — 8 屏交互式总览（点击左侧细栏切换）

## 8 张高保真独立页

| # | 文件 | 页面 | 说明 |
|---|------|------|------|
| 1 | [screens/01-stream.html](./screens/01-stream.html) | **Stream** | 默认首页，时间线 + Halo Sidekick |
| 2 | [screens/02-collections.html](./screens/02-collections.html) | **Collections** | 收藏夹卡片网格 |
| 3 | [screens/03-templates.html](./screens/03-templates.html) | **Templates** | 模板网格（带变量管理） |
| 4 | [screens/04-devices.html](./screens/04-devices.html) | **Devices** | 设备仪表盘 + QR 配对 |
| 5 | [screens/05-settings.html](./screens/05-settings.html) | **Settings** | 平铺双列（演示"外观"分类） |
| 6 | [screens/06-halo-assistant.html](./screens/06-halo-assistant.html) | **Halo Assistant** | AI 右侧常驻面板（不脱离 Stream 上下文） |
| 7 | [screens/07-command-palette.html](./screens/07-command-palette.html) | **Command Palette** | ⌘K 命令面板 |
| 8 | [screens/08-onboarding.html](./screens/08-onboarding.html) | **Onboarding** | 首次启动 · 选色相 |
| 9 | [screens/09-ai.html](./screens/09-ai.html) | **AI 全屏** | 4 列布局：会话 / 对话 / 上下文 / 工具调用 |
| 10 | [screens/10-ai-memory.html](./screens/10-ai-memory.html) | **AI 记忆管理** | 类别 / 数据源 / 单条编辑删除 |
| 11 | [screens/11-ai-onboarding.html](./screens/11-ai-onboarding.html) | **AI 引导** | 5 步走 · 模型选择 · 权限开关 |

## AI 模块专题

- **[ai/ai-quick-actions.html](./ai/ai-quick-actions.html)** — AI 快捷指令广场（12 个预定义动作 + 自定义）

## 组件交互演示

- **[playground.html](./playground.html)** — 22 个组件全部可点（Dialog / Sheet / Popover / Tooltip / Toast / ContextMenu / Tabs / Accordion / Combobox / BottomSheet / Empty / Loading / Banner / Form / 动效 / **AI 思考链 / 工具调用 / 流式输出 / 上下文选择 / 用量计费 / 错误状态 / 权限确认**）

## 共享资源

- **[pulse.css](./pulse.css)** — 单一设计令牌 + 基础组件（所有屏共享）

## 怎么试

1. 直接双击 `index.html` 用浏览器打开
2. 左侧细栏切换 8 个核心页面
3. 底部齿轮按钮切换 Light / Dark 模式
4. 浏览器 Console 试试：  
   `document.documentElement.style.setProperty('--accent-hue', 160)`  
   看强调色相如何驱动整个 UI

## 设计亮点速览

- **单一品牌** — 7 套主题 → 1 套 Pulse + 用户可调色相
- **窄细栏** — 240px 文字侧栏 → 60px 图标细栏
- **顶栏命令** — 任意动作走 ⌘K
- **时间线** — 表格 → 时间线 + 智能卡片
- **常驻侧栏** — AI/通知/详情全部收纳进 280px Halo
- **oklch 色彩** — 感知一致，暗色不再是反色
- **行间节奏** — 7 档字号 + 8 档间距，节奏一致

## 与现状对比

| 维度 | 现状 | Pulse |
|------|------|-------|
| 主题 | 7 套 | 1 套 + 可调色相 |
| 侧栏 | 240px | 60px |
| 列表 | 表格 | 时间线 + 卡片 |
| AI | 独立抽屉 | 右侧常驻 |
| 模态 | 10+ 种 | 收敛为 3 类（Sheet / Dialog / Popover） |
| 搜索 | 顶栏 | ⌘K 命令面板 |
| 色彩 | RGB | oklch 感知一致 |
| 动效 | 各自为政 | 统一 160/240ms 曲线 |

详细论证与迁移清单请看 [DESIGN_PROPOSAL.md](./DESIGN_PROPOSAL.md)。

## ✅ 已交付的交互

### 8 个主屏（screens/）
- **01-stream** · 时间流主屏 · Halo 侧栏 4 角色切换（Companion/Assistant/Inspector/Library）
- **02-collections** · 收藏夹
- **03-templates** · 模板库
- **04-devices** · 5 台设备管理 · ⋯ 菜单 popover / 移除确认 modal / 刷新配对码 / Halo tab / 添加设备 4 平台选择
- **05-settings** · 12 个设置 tab · 实时 hue ring 调色 / saturation & scale slider / 浅色/深色/跟随 切换 / 保存放弃 / 恢复默认 / 清空本地数据
- **06-halo-assistant** · Halo 助手
- **07-command-palette** · ⌘K 命令面板
- **08-onboarding** · 首次引导
- **09-ai** · AI 4 列主界面
- **10-ai-memory** · AI 长期记忆 · nav 类别/数据源过滤 / 实时搜索 / 编辑 modal / 禁用/启用 / 重新训练进度 / 导出 JSON+CSV / 清除全部
- **11-ai-onboarding** · AI 引导 5 步 · 同步策略 / 7 大能力选择（至少 3 个）/ 模型选择 / 权限开关 / 试聊 / 完成引导

### 交互演示
- **playground.html**（108KB / 23 个组件区块）
  - 思考链：折叠/展开/运行中 3 态
  - 工具调用：✓ ok / ⏳ running / ✗ error / ⚠ needs 4 状态
  - 流式输出：完整打字机 + 速度统计
  - 上下文 chip：加/减 + token 成本计算
  - 用量计费：滑块 + 5 档预设 + 95%/80% 告警
  - 模型分布：+/- 调整 + 比例自动归一
  - 错误状态：3 种 banner 按钮触发 toast
  - Switch / Checkbox / Radio / Slider 全部可点
  - Hover/Focus 状态 · Empty State · Search 实时过滤
