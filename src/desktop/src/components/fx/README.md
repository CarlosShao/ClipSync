# fx/ — 动效组件层（vendor 自 vue-bits）

来源：https://github.com/DavidHDev/vue-bits
本地库：`D:\work\AI\component library\vue-bits`（含 COMPONENT-INDEX.md 组件速查索引）
拉取时间：2026-09-25 · 上游 commit `07c0f76`
许可证：MIT + Commons Clause（应用内集成 OK，不能单独出售本库）

## 文件清单与相对上游的改动

| 文件 | 来源 | 改动 |
| --- | --- | --- |
| `Waves.vue` | `src/content/Backgrounds/Waves/Waves.vue` | ① 移除鼠标跟随圆点及其 CSS 变量写入 ② canvas 按 devicePixelRatio 缩放（≤2x），修复高分屏线条发虚 ③ 接 `useReducedMotion`：命中时只渲染静态单帧并停掉 rAF/鼠标监听，运行中切换实时生效 |
| `DecryptedText.vue` | `src/content/TextAnimations/DecryptedText/DecryptedText.vue` | 接 `useReducedMotion`：命中时直接渲染静态明文，不启动 scramble 定时器 |
| `CountUp.vue` | `src/content/TextAnimations/CountUp/CountUp.vue` | 接 `useReducedMotion`：命中时直接渲染终值文本，不启动弹簧 rAF 与 IntersectionObserver |
| `StarBorder.vue` | `src/content/Animations/StarBorder/StarBorder.vue` | ① 内层去掉上游落地页写死的暗色底/内边距/边框，slot 透传自带外观 ② 圆角参数化（`borderRadius` prop，默认 `var(--radius-md)`）③ 亮度增强：orbit 透明度 70%→95%、渐变亮核加宽（4% 实心/12% 淡出）——浏览器 1:1 复现实测上游参数在 1-2px 边缘缝里不可见。纯 CSS 动画，由全局 reduce-motion CSS 通道自动压制。光色对比度由调用方控制：`color-mix(var(--primary) 70%, white)` |
| `FxClickSpark.vue` | `src/content/Animations/ClickSpark/ClickSpark.vue` | ① 接 `useReducedMotion`：命中时不建 canvas/ResizeObserver，只透传 slot ② canvas 按 devicePixelRatio 缩放（≤2x）③ rAF 按需启停（上游挂载后永久空转，每帧 clearRect）④ 尺寸交给调用方 class，可当整页根元素用 ⑤ 色值由调用方传入（canvas 解析不了 `var()`） |
| `FxSpotlightCard.vue` | `src/content/Components/SpotlightCard/SpotlightCard.vue` | ① 去掉写死的 `rounded-3xl border p-8`，容器外观交给调用方 class ② 接 `useReducedMotion`：命中时不监听 pointermove，保留一处静态柔光 ③ 坐标/颜色走 CSS 变量 + rAF 合帧直写 DOM（零组件重渲染）④ 光斑放在 `z-index:-1` + `isolation:isolate` 的「自身背景之上、内容之下」夹层，slot 子元素保持原 flex/block 布局 |
| `FxMagnet.vue` | `src/content/Animations/Magnet/Magnet.vue` | ① 接 `useReducedMotion`：命中时不挂任何指针监听 ② pointermove 按 rAF 合帧 + rect 带 250ms 缓存（上游每个事件同步读 rect）③ transform 直写 DOM，不走 ref 响应式 ④ 滚动/缩放令 rect 缓存失效 ⑤ 上游 API 全保留 |
| `FxGlitchText.vue` | `src/content/TextAnimations/GlitchText/GlitchText.vue` | ① 去掉写死外观（text-white / font-black / clamp 字号 / cursor-pointer / `bg-[#0b0b0b]`），字号字色跟随宿主，伪元素底色由 `glitchBg` 传入 ② Tailwind 任意值类 + 全局 `animate-glitch` 关键帧换成 scoped 原生 CSS（关键帧改名 `fx-glitch-clip` 防撞）③ 偏离量与红/青阴影色参数化（上游 ±10px 只适合超大标题）④ 接 `useReducedMotion`：命中时 `is-static` 直接不生成两片伪元素 |
| `FxLatticeLoader.vue` | `src/content/Micro/LatticeLoader/LatticeLoader.vue` | ① 接 `useReducedMotion`：命中时晶格静止为「全亮」字形、且不再启动计时器 —— 不能只靠 `html.reduce-motion *` 兜底，那条会把 animation-duration 压成 0.01ms 从而停在 idle 关键帧（全暗、看不出在加载）② 关键帧与类名 `ll-*`/`lattice-*` → `fxl-*`，避免全局注入撞名 ③ 上游 `prefers-reduced-motion` 块保留 |
| `FxGradualBlur.vue` | `src/content/Animations/GradualBlur/GradualBlur.vue` | ① 接 `useReducedMotion`：命中时强制 `animated=false` 且不建立 IntersectionObserver ② 注入样式 id 改名 `fx-gradual-blur-styles` ③ 默认 `zIndex` 1000 → 12（上游 1000 是落地页全屏遮罩用，应用内会盖住抽屉/弹层） |
| `useReducedMotion.ts` | 新增（本项目） | fx 统一动效开关：`prefers-reduced-motion`（系统）∨ `html.reduce-motion`（设置页开关），任一命中即 true。模块级单例监听，随应用生命周期存活 |
| `useThemeColor.ts` | 新增（本项目） | 把主题里的 `--xxx-rgb: R G B` 解析成 canvas/着色器能吃的 `rgb()`/`rgba()` 字符串：canvas 与 GLSL 都解析不了 `var()`，所有 `<canvas>` 类动效都需要这座桥。主题切换 = `<html>` class 变化，MutationObserver 跟随 |

## 以后往 fx/ 加组件的硬性清单

1. **从本地库复制原文，再做最小定点修改**（不要手抄转录）。
2. 必须接 `useReducedMotion()`——上游组件一律不处理 reduce-motion，这是全站既有承诺。
   分两类接法，别搞混：
   - **纯 CSS 类**（StarBorder、FxGlitchText 的静态态）：全局 `html.reduce-motion *` 那条
     `animation-duration: 0.01ms` 只能压时长，压不出「正确终态」。要保证命中时是**有意义的静止画面**，
     不能是动画关键帧停在半路（FxLatticeLoader 就是踩过这个坑）。
   - **JS 类**（rAF / 定时器 / 指针监听）：必须真的停手（停帧、清 timer、解绑监听），
     并 watch 开关做运行中热切换，而不是只靠 CSS 兜底。
3. 颜色：优先由调用方传入。DOM/CSS 侧绑主题 token；canvas/WebGL 内解析不了 `var()` 的，用 `useThemeColor` 解析后传入。
4. 节奏对齐全站纪律：`--ease` 曲线，hover 160ms / 面板 260ms / dock 280ms；环境类动画保持慢速、低对比。
5. 卸载清理 rAF / 监听器 / WebGL context（上游大多自带，改动时别删）。
6. 在上表登记来源路径与改动点；文件头保留来源注释，保持与上游可 diff。

## 拉取新组件

- 本地（推荐，离线可用）：复制 `D:\work\AI\component library\vue-bits\src\content\<分类>\<Name>\<Name>.vue`；
  或读 `public\r\<Name>.json` 取 `files[0].content`（shadcn 兼容 registry，JSON 内含 dependencies 声明）。
- 在线：`npx shadcn@latest add https://vue-bits.dev/r/<Name>.json`
- ⚠ 严禁 `npm i vue-bits`：npm 上同名包是无关的 Vue 2 表单库。
- ⚠ 优先挑**零第三方依赖**的组件（索引里带 ⭐）。项目当前没装 `gsap`/`motion-v`/`ogl`/`three`，
  引入它们意味着新增运行时依赖 + 打包体积，收益要先论证。

## 剪切板模块的接入位置（本批）

| 位置 | 组件 | 说明 |
| --- | --- | --- |
| 剪贴板整页 | `FxClickSpark` | 点击粒子反馈；canvas `pointer-events:none`，不拦任何行/按钮事件 |
| 统计卡 × 4 | `FxSpotlightCard` | 光标聚光（`.clip-stat` 直接挂在组件根上，卡片外观不变） |
| 工具栏主 CTA「新建剪贴」 / 抽屉底部「复制」 | `StarBorder` | accent 绕边流光，与登录页同一套配方 |
| 列表滚动容器底沿 | `FxGradualBlur` | 磨砂渐隐；只在「下面还有内容」时渲染，滚到底自动撤掉 |
| 空态标题 | `DecryptedText` | 解密揭示（`useOriginalCharsOnly`：中文只在原字形间打乱） |
| 空态主 CTA | `FxMagnet` | 磁吸跟随（只在空态这种稀疏区域用，列表里一律不上） |
| 加载失败标题 | `FxGlitchText` | 故障抖动，`enableOnHover` 默认静态 |
| 首屏骨架 / 页内 AI 等待态 | `FxLatticeLoader` | 晶格加载 |
