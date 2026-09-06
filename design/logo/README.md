# ClipSync Logo 定稿记录（2026-09-06）

**定稿方案：③ 通道 Gate**（用户从 4 案中选定；①飞掠、②回环为备选，④叠影落选）
预览对比页：`../preview.html`（16px 棋盘 / 深浅底 / 场景 mock）

## 造型语义

错位相对的两根立柱 = 两台设备（左上=一端、右下=另一端，错位即「两地」）；
圆角方块 = 用户的内容，正带着一小段速度线从两柱之间穿行而过——「手机复制，电脑秒粘」。

## 几何规范（48 网格）

| 元素 | 参数 |
|---|---|
| 瓷片 | 48×48，rx=11 |
| 左柱 | x=9.8, y=10.5, w=5, h=19, rx=2.5 |
| 右柱 | x=33.2, y=18.5, w=5, h=19, rx=2.5 |
| 方块 | x=20.9, y=19.5, w=9, h=9, rx=2.6 |
| 速度线 | (16.4,26)→(18.6,24.7)，stroke-width 3.4，圆帽，opacity .55 |

## 配色规范

- **墨色版**（官网/浅底）：瓷片 `#141414`，柱/块 `#fff`，块与速度线 `#7c6cf0`（紫点唯一色，即内容本身）
- **渐变版**（管理台/应用图标）：瓷片 `linear-gradient(135deg, #7c6cf0 0%, #5a4bd1 58%, #4f3fc0 100%)`，图形全白
- 纯图标单色版：仅图形无瓷片，随容器 CSS 底色使用

## 资产清单

- `assets/clipsync-mark-ink.svg` — 墨色瓷片版（官网 favicon）
- `assets/clipsync-mark-gradient.svg` — 渐变瓷片版（管理台 favicon、桌面图标源）
- `assets/clipsync-icon-white.svg` — 纯图标白色版（内联于 CSS 圆角块：官网导航/页脚、管理台顶栏/登录页）
- `tools/render-desktop-icons.js` — sharp 渲染 PNG(32/128/256) + 自组 PNG 直嵌 ICO，输出 `src/desktop/src-tauri/icons/`

## 已替换位置（2026-09-06）

1. `src/website/public/favicon.svg` ← 墨色版
2. `src/website/index.html` 导航 + 页脚 logo-mark（×2，紫点内联版）
3. `src/admin-console/public/favicon.svg` ← 渐变版
4. `src/admin-console/src/layouts/AdminLayout.tsx` 顶栏品牌区
5. `src/admin-console/src/pages/login/index.tsx` 登录页品牌区
6. `src/desktop/src-tauri/icons/`（32x32.png / 128x128.png / 128x128@2x.png / icon.ico）

> 注：`tools/node_modules`（sharp）仅本地构建用，不入库。
