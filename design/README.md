# ClipSync 后台管理系统 & 官网 — 设计交付物（待人工审核）

> 生成日期：2026-09-05 · 全部草图均为**零依赖单文件 HTML，双击用浏览器打开即可**（建议 Chrome/Edge，窗口宽度 ≥ 1440）

## 审核入口

| # | 交付物 | 文件 | 说明 |
|---|--------|------|------|
| 0 | 调研报告 | [00-调研报告.md](./00-调研报告.md) | 代码库事实盘点（表结构/RBAC/支付/品牌色） |
| 1 | 后台管理系统方案 | [01-后台管理系统方案.md](./01-后台管理系统方案.md) | 架构/模块/API 规划/里程碑 |
| 2 | 官网方案 | [02-官网方案.md](./02-官网方案.md) | 信息架构/技术选型/三创意方向 |
| A | 后台草图 · 方案 A | [mockups/admin-v1-dark.html](./mockups/admin-v1-dark.html) | 「Obsidian」深色专业风（对应 shadcn/ui + Recharts 落地） |
| B | 后台草图 · 方案 B | [mockups/admin-v2-light.html](./mockups/admin-v2-light.html) | 「Daylight」亮色企业风（对应 Ant Design 5 + ECharts 落地） |
| W1 | 官网草图 · V1 | [mockups/website-v1-aurora.html](./mockups/website-v1-aurora.html) | 「Aurora 夜航」深色科技/光流动 |
| W2 | 官网草图 · V2 | [mockups/website-v2-minimal.html](./mockups/website-v2-minimal.html) | 「Paper 极简」亮色编辑/大字排版 |
| W3 | 官网草图 · V3 | [mockups/website-v3-bento.html](./mockups/website-v3-bento.html) | 「Prism 棱镜」Bento 活力卡片 |

## 后台草图内可交互的检查点

- 左侧导航可点击切换 7 个界面：登录页 / 数据看板 / 用户管理 / 订单与支付 / 审计日志 / 角色权限 / 系统设置
- 用户管理页：点击任意行 → 右侧详情抽屉；「停用账号」有二次确认弹窗
- 订单页：状态筛选 Tab 可切换；「退款」按钮有确认弹窗
- 审计日志：敏感操作行有红色高亮标记；筛选区可看交互占位

## 审核结论（2026-09-05）

1. ✅ 官网创意方向已定稿：**V2「Paper 极简」**（`mockups/website-v2-minimal.html`），工程方案见 [04-官网开发工程方案.md](./04-官网开发工程方案.md)
2. ✅ 后台视觉方案已定稿：**B「Daylight」亮色**（`mockups/admin-v2-light.html`）→ 技术栈随之确定为 **Ant Design 5 + ECharts**
3. 📋 后台开发工程方案已产出待审：[03-后台开发工程方案.md](./03-后台开发工程方案.md)（选型/结构/规范/工程化/联调/部署/里程碑）
4. ⏳ 后台部署形态：`admin.clipchain.top` 子域 vs 路径 `/admin/`（见 03 §8 / §10）
5. ⏳ 里程碑排序：后台 M0-M4 与官网并行开发（同分支不同目录），先后无强依赖

> **当前状态：阻塞中 —— 等待对 03/04 两份工程方案的审核，通过后才开始编码。**

## 原始待办（存档）

1. 后台视觉方案：A 深色 / B 亮色（或 A+B 混合：如亮色为主+深色模式）
2. 官网创意方向：V1 / V2 / V3（或组合，如 V1 的 Hero + V3 的 Bento）
3. 后台技术栈确认：shadcn/ui vs Ant Design 5
4. 后台部署形态：`admin.clipchain.top` 子域是否可行（涉及证书/DNS）
5. 里程碑排序：后台 M1 先行，还是官网先行
