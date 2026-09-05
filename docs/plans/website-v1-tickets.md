# ClipSync 官网 v1 任务工单（Paper 极简落地）

> **依据**：`design/02-官网方案.md` + `design/04-官网开发工程方案.md`（已获用户批准，2026-09-05）
> **视觉基线**：`design/mockups/website-v2-minimal.html`（Paper 极简 · 已定稿）
> **分支**：`feature/admin-console`（与后台同分支不同目录，互不阻塞）
> **并发纪律**：最多 2 个 subagent 并行；子代理禁止 git 操作

---

## 全局约束

1. **像素基线**：以 `design/mockups/website-v2-minimal.html` 为唯一视觉标准，拆分工程化时类名保持一致，方便逐节 diff 对照
2. **技术红线**：无框架（原生 TS）、无三方运行时 JS、无三方字体/图标 CDN；动效只用 CSS + IntersectionObserver
3. **文件所有权**：只动 `src/website/**` 与 `.github/workflows/website.yml`
4. **验证门禁**：`cd src/website && npm run build` 全绿；`npm run preview` 编排者浏览器目检

---

## 工单

### T-W0 [P0] 脚手架 + 全量页面工程化还原
- **独占文件**：`src/website/**`、`.github/workflows/website.yml`
- **内容**：见 `docs/plans/admin-console-v1-tickets.md` T-W0（同内容，此处不重复）——Vite 6 多页模式、tokens/base/sections 分文件 CSS、pricing/download 数据常量、main.ts 交互脚本、SEO 全套、三档响应式
- **验收**：build 全绿；preview 渲染与草图肉眼一致；无三方运行时依赖；Lighthouse 手动跑 Performance/SEO ≥ 90（CI 化留待 T-W2）

### T-W1 [P1] SEO 与资源收尾
- **独占文件**：`src/website/**`（在 T-W0 产物上继续）
- **内容**：JSON-LD 校验（Rich Results Test 手动）；og-cover.png 实图导出（可从草图首屏截图裁切，≤100KB）；favicon.svg 替换占位；404.html；sitemap.xml + robots.txt；`<noscript>` 降级检查（关 JS 时内容仍可读，仅少动效）
- **验收**：build 产物含上述文件；结构化数据无报错；图片全部 ≤100KB 且 WebP

### T-W2 [P2] 性能与可访问性打磨
- **独占文件**：`src/website/**`
- **内容**：Lighthouse CI 接入（workflow 加 lighthouse 步骤，阈值 Performance/SEO/Best Practices ≥ 95）；对比度审查（正文 #57554e on #fbfbf9 ≈ 7:1 达标，辅助文字 #98958a 仅用于装饰性文本）；键盘焦点样式；prefers-reduced-motion 停用入场动画
- **验收**：Lighthouse 三项 ≥ 95；reduced-motion 下无动画

---

## 派发状态看板

| 工单 | 状态 | 备注 |
|------|------|------|
| T-W0 脚手架+全页还原 | ✅ 完成（2026-09-05） | build/check 全绿；DOM 与基线 67 类名零差异；浏览器目检一致；遗留：og-cover 纯色占位、下载链接未接线、域名 3 处假设值（归 T-W1） |
| T-W1 SEO 收尾 | 待派发 | T-W0 完成后，可与后台 Wave 3 并行 |
| T-W2 性能打磨 | 待派发 | 最后 |
