# ClipSync AI 模块前端样式审计报告

- **日期**：2026-08-16
- **范围**：`src/desktop/src/components/ai/` 下 15 个带样式组件（AiThinkingOrb 无样式块），约 2800 行 scoped CSS；对照 `src/desktop/src/styles/globals.css`（726 行设计 token 与主题定义）
- **方法与局限**：静态代码级审计——token 使用率、硬编码值分布、主题完整性、动效属性、无障碍属性的逐一核验。**未运行应用截图对比**（桌面端需 server + PostgreSQL + Tauri 全链路），涉及实际渲染效果的结论均已用代码证据支撑；后续如需像素级验证可补截图环节
- **配套报告**：`2026-08-16-ai-module-audit.md`（功能与安全审计，含流式渲染性能等与样式相关的条目）

---

## 一、设计系统画像（项目 Layer 3 同步）

| 维度 | 现状 |
|------|------|
| 样式层 | Tailwind CSS 4（CSS-first 配置）+ shadcn-vue 原语（components.json） |
| 主题系统 | 自研 7 套主题（vercel / clipsync / notion / linear / apple / raycast / arc）× 明/暗模式，`html.theme-*` + `.light/.dark` 类驱动 |
| Token 体系 | `--bg-*`、`--text-*`、`--border-*`、`--accent`、`--success/--warning/--destructive`、`--shadow-dropdown`、z-index 阶梯（0/10/20/30/40/50/999/1000/9999） |
| 字体 | Inter + 系统栈 + PingFang SC（合理） |
| AI 模块用法 | `var(--xxx)` 395 处 vs 硬编码颜色约 240 处（hex ~175 + rgba/rgb ~67）——**约 1/3 颜色绕过 token** |

---

## 二、总体评价

AI 模块的样式底子不差：组件全部 scoped 隔离、主色/背景/文字大量走语义 token、微交互时长收敛在 0.12–0.25s、无 backdrop-filter 滥用、滚动条克制。**主要问题是 token 体系建了但没守住**——语义色、z-index、字号、阴影四个维度都有"明明有 token 却硬编码"的系统性漏网，外加两处真实的主题断链 bug。7 套主题 × 2 模式 = 14 种组合，任何硬编码都是潜在的适配漏洞，这正是当前样式债的来源。

---

## 三、发现（按严重度）

### 高

**S1. `--accent-rgb` 全仓库无定义，强调色光晕永远锁定靛蓝（真实主题断链 bug）**
`AiCompressProgress.vue:106-107` 使用 `rgba(var(--accent-rgb, 99 102 241), …)` 做压缩进度呼吸光晕，但 `globals.css` 及全部样式文件中 **`--accent-rgb` 定义为 0 处**——fallback `99 102 241`（靛蓝）恒生效。在 raycast/linear（accent #818cf8）下碰巧接近，在 apple/notion 等主题下则是错误颜色。
**修复**：每主题块补 `--accent-rgb: R G B;`，或改用 `color-mix(in srgb, var(--accent) 18%, transparent)`（Tailwind 4 环境无兼容负担）。

**S2. 语义色硬编码绕过已有 token（约 29 处）**
globals.css 中 `--success`/`--warning` 每主题均有定义（各 24 处），但组件直接写死：`#ef4444` 红 ×20、`#10b981` 绿 ×6、`#f59e0b` 黄 ×2、`#3b82f6` 蓝 ×1（集中在 AiMessage、AiToolTimeline、AiAgentSummary、AiSuggestPopup 的成功/失败/警告状态）。成功/错误/警告色不随主题走，深色主题下这批高饱和浅色值偏刺眼。
**顺带发现**：`--destructive` 仅 4 处定义——**多数主题没定义该 token**，用它的组件实际靠 fallback。
**修复**：全局替换为 `var(--success)` / `var(--warning)` / `var(--destructive)`，并补齐缺失主题的 destructive 定义。

### 中

**S3. linear / raycast 主题无明暗双模式，主题类与模式类脱节**
`globals.css:295`（linear）、`:414`（raycast）只有单一深色块，无 `.dark` 变体也无 light 变体。用户选 linear + light 时：UI 仍显示深色，但 `html` 上没有 `.dark` 类——AI 模块里仅有的两处 `.dark` 特异性样式（`AISidebar.vue:604/609` 图片重复提示条）不会生效，深色底上套浅色模式的样式，存在对比度翻车风险。这是主题系统级缺口，不止影响 AI 模块。
**修复**：补 linear/raycast 的 light 变体；或在主题元数据中声明 `darkOnly: true` 并在选择 light 模式时强制切 dark / 禁用切换。

**S4. z-index 完全脱离 token 阶梯**
组件内裸值分布：1 / 2 / 5 / 6 / 10 / 50 / 60 / 120 / 200 / 1000。项目明明定义了 z-index token（0–50、999、1000、9999）。浮层关系现状：`AiSuggestPopup`（fixed，z=120）在 `AiAgentDrawer`（fixed，z=1000）之下、普通内容（≤50）之上——数值上能工作，但 120/60/200 不在 token 体系内，新浮层加入时只能靠"碰巧不撞"。
**修复**：浮层统一挂 `--z-index-999`（弹窗）/`--z-index-1000`（抽屉），局部 stacking context 内的小值（1/2/5/6）可保留但建议注释归属。

**S5. 小字号 × 低对比度文字踩 WCAG 红线**
字号分布高度碎片化：12px×26、11px×20、10px×11，还有 **7px×1**（`AiChatInput.vue:838`，token 用量环 SVG 里的百分比标签，人眼不可辨）以及 10.5/11.5/12.5/13.5px 四档**半像素字号**（共 21 处，明显是逐处手调而非阶梯）。抽检 notion 暗色主题：`--text-tertiary #6b6b6b` 落在 `--bg-surface #282828` 上对比度约 **2.6:1**（WCAG AA 小字需 4.5:1），而 tertiary 恰恰配 10–11px 的 meta 文字用。
**修复**：定义字号阶梯（如 `--text-2xs:10px / --text-xs:11px / --text-sm:12px / --text-base:13px`），禁止半像素值；7px 改 ≥9px 或换展示形式；各主题 tertiary 色提亮到 ≥4.5:1。

### 低

**S6. 圆角谱系有离群值**：主流 999px 胶囊×14、6px×11、8px×9、50%×9（状态点/头像，合理），但混有 1/2/3/4/10/12/14px 共 13 处。建议收敛为 6（控件）/8（卡片）/999（胶囊）/50%（圆）四档。

**S7. 阴影 8 种硬编码** vs 仅 1 处用 `--shadow-dropdown`：`0 16px 48px rgba(0,0,0,.28)`、`0 12px 32px rgba(0,0,0,.18)` 等各写各的，浮层"高度感"不一致。建议补 `--shadow-sm/md/lg` token（暗色主题阴影更深可走 token 切换）。

**S8. `prefers-reduced-motion` 覆盖不全**：15 个 `@keyframes` 中仅 AiWaiting、AiThinking 两组件 + orb canvas 有 reduce 处理；`caret-pulse`、`ai-msg-locate-flash`、`spin`、`ai-tool-line-in` 等未覆盖。建议在 globals.css 加一段全局 `@media (prefers-reduced-motion: reduce) { .ai-module-root *, … { animation-duration: 0.01ms !important } }` 兜底。

**S9. 键盘焦点样式几乎缺失**：15 个组件仅 AiChatInput、AiConversationList 有 `:focus` 规则。可交互元素（工具时间线展开、建议卡片按钮、记忆面板操作）无可见 focus ring。shadcn 原语自带 focus 样式，但自绘按钮没有。

**S10. shimmer 动画动 `background-position`（逐帧重绘）**：`AiMessage.vue`、`AiThinking.vue`、`AiWaiting.vue` 三处的扫光动画均用 background-position（paint 型），而思考指示器在流式生成期间常驻。叠加代码审计 #21（流式期间全量重渲 markdown），是"长回复时风扇狂转"的样式侧贡献。可改为伪元素 + `transform: translateX()`（合成器友好）。`caret-pulse` 已是 transform/opacity，正确。

**S11. `var(--x, #fff)` 死 fallback 模式（约 12 处）**：`--bg-surface` 等 token 在全部主题均有定义，fallback 永不触发，但一旦未来某主题漏定义，将静默锁死白色。建议 lint 规则禁止带 fallback 的 var()（或仅允许在 token 定义文件内）。

**S12. 杂项**：`!important` 4 处（`AiChatInput.vue:959/960/1067` 深度选择器 hack、`AiMessage.vue:772`）；搜索高亮 `<mark>` 的样式内联在模板字符串 replace 里（`AiConversationList.vue:156`，与 XSS 修复绑定，重构时应移入 scoped class）；自定义滚动条仅 AiMessageList、AiSuggestPopup 两处（同一应用内滚动条观感不统一）。

---

## 四、与 2024–26 主流实践对照

| 维度 | 现状 | 评价 |
|------|------|------|
| 圆角 | 6/8/999 谱系为主 | 基本符合当前squircle/胶囊趋势，清理离群值即可 |
| 微交互 | 0.12–0.25s 收敛、hover/按压反馈齐 | 节奏统一，是亮点 |
| 暗色模式 | token 化为主但 1/3 硬编码拖后腿 | dark-first 时代这是必修课，见 S1/S2 |
| 间距 | 未系统审计到 8px 网格偏差（padding/gap 值较碎） | 建议随字号阶梯一并立规范 |
| 玻璃态/渐变 | 无 backdrop-filter、克制 | 无滥用，符合工具类桌面应用定位 |
| 字号密度 | 11–13px 为主的紧凑桌面风 | 定位可接受，但需阶梯化 + 对比度兜底（S5） |
| 无障碍 | reduced-motion/focus/对比度三处欠账 | 见 S5/S8/S9 |

---

## 五、建议（按优先级）

**P0（随代码审计 P0 一并做）**
1. 修 `--accent-rgb` 断链（S1）——每主题补定义或改 color-mix，半小时内可完成；
2. 语义色换 token + 补 `--destructive` 缺失主题（S2）——纯机械替换。

**P1（一周内）**
3. linear/raycast 双模式补全或声明 darkOnly（S3）；
4. 浮层 z-index 挂 token（S4）；
5. 字号阶梯 token 化，清半像素值与 7px（S5 前半）；
6. shimmer 改 transform 实现（S10），与代码审计 #21 的渲染节流同期做。

**P2（随迭代）**
7. `--shadow-sm/md/lg` token 化（S7）；圆角收敛四档（S6）；
8. 全局 `prefers-reduced-motion` 兜底（S8）；自绘按钮补 focus-visible 样式（S9）；
9. 各主题 tertiary 文字对比度校准至 ≥4.5:1（S5 后半）；
10. 加 stylelint（`declaration-property-value-disallowed-list` 禁 hex 色/裸 z-index），把 token 纪律固化成工具约束——这是防止样式债复发的关键一步。

---

## 六、做得对的地方（保持）

- 全部 scoped 样式，零全局污染；
- 395 处 var() 语义 token 使用，主链路（背景/文字/边框）主题适配基本可用；
- 微交互时长收敛、caret/spin 用 transform/opacity；
- 侧栏宽度 320–760px 可拖拽并持久化，交互完成度高；
- 无玻璃态/大阴影滥用，工具类应用的克制感是对的。

---

*本报告为静态审计，未含截图对比。建议修复 P0 后启动应用截图一轮（明/暗 × 至少 3 套主题 × 建议弹窗/抽屉/思考态三个界面），做像素级回归确认。*
