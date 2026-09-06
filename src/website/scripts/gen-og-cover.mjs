#!/usr/bin/env node
/**
 * og-cover.png 生成脚本（T-W1 一次性产物 + 可复现再生成）
 *
 * 方案：Playwright 无头 chromium 渲染 1200×630 HTML 品牌图后截图。
 * 选型理由：系统字体栈（--font，与 tokens.css 一致）排版质量优于手写 SVG 转 PNG；
 * 纯色扁平构图使 PNG 体积远低于 100KB 上限。
 *
 * 依赖说明：playwright 是**仓库根** devDependency（未加入本包，保持「无三方运行时依赖」红线；
 * 本脚本为开发期工具，不进 build 链路）。Node 的包解析会自 scripts/ 向上命中根 node_modules。
 * 运行：cd src/website && node scripts/gen-og-cover.mjs
 *
 * 设计规范（与 design/mockups/website-v2-minimal.html「Paper 极简」一致）：
 *   底色 #fbfbf9 / 墨色 #141414 / 品牌紫 #5a4bd1（强调）/ 弱紫 #efecfc / 灰 #98958a
 */
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(pkgRoot, 'public', 'og-cover.png');
const MAX_BYTES = 100 * 1024;

/** 1200×630 品牌图：#fbfbf9 底 + 左上 logo 色块 + 居中大标题 + 副题 + 品牌紫强调 */
const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
:root{
  --bg:#fbfbf9; --ink:#141414; --ink-2:#57554e; --ink-3:#98958a;
  --accent:#5a4bd1; --accent-soft:#efecfc; --line:#e6e4dc;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,"Cascadia Mono","JetBrains Mono",Consolas,monospace;
  --serif:Georgia,"Times New Roman",serif;
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1200px;height:630px;overflow:hidden;background:var(--bg);
  font-family:var(--font);color:var(--ink);-webkit-font-smoothing:antialiased}
.stage{position:relative;width:1200px;height:630px;padding:52px 64px 46px;
  display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:12px}
.brand .mark{width:34px;height:34px;border-radius:10px;background:var(--ink);
  display:flex;align-items:center;justify-content:center;flex:none}
.brand b{font-size:19px;font-weight:700;letter-spacing:.3px}
.brand .ver{margin-left:auto;font-family:var(--mono);font-size:13px;color:var(--ink-3);letter-spacing:2px}
.center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;margin-top:-10px}
.kicker{font-family:var(--mono);font-size:14px;color:var(--accent);letter-spacing:5px;margin-bottom:26px}
h1{font-size:82px;line-height:1.24;font-weight:700;letter-spacing:3px}
h1 .hl{color:var(--accent);position:relative;display:inline-block;padding:0 10px;margin:0 -10px}
h1 .hl::after{content:'';position:absolute;left:0;right:0;bottom:6px;height:26px;
  border-radius:13px;background:var(--accent-soft);z-index:-1}
.sub{margin-top:34px;font-size:22px;color:var(--ink-2);letter-spacing:1.5px}
.foot{display:flex;justify-content:space-between;align-items:center;
  border-top:1px solid var(--line);padding-top:22px}
.foot .l{font-family:var(--mono);font-size:13px;color:var(--ink-3);letter-spacing:2.5px}
.foot .pill{font-size:14.5px;color:var(--accent);background:var(--accent-soft);
  border-radius:999px;padding:7px 18px;letter-spacing:1px;font-weight:600}
</style></head><body>
<div class="stage">
  <div class="brand">
    <span class="mark">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><path d="m9 13 2 2 4-4"/></svg>
    </span>
    <b>ClipSync</b>
    <span class="ver">V1.5</span>
  </div>
  <div class="center">
    <div class="kicker">CROSS-DEVICE CLIPBOARD</div>
    <h1>手机复制，<br>电脑<span class="hl">秒粘</span>。</h1>
    <div class="sub">端到端加密 · Windows / macOS / Linux / Android</div>
  </div>
  <div class="foot">
    <span class="l">© 2026 CLIPSYNC</span>
    <span class="pill">2 台设备免费开始</span>
  </div>
</div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(HTML, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1200, height: 630 } });
} finally {
  await browser.close();
}

const bytes = statSync(outPath).size;
console.log(`[og-cover] 已写出: ${outPath}`);
console.log(`[og-cover] 尺寸: 1200x630 · 体积: ${(bytes / 1024).toFixed(1)}KB`);
if (bytes > MAX_BYTES) {
  console.error(`[og-cover] FAIL: 超过 ${MAX_BYTES / 1024}KB 上限（工程方案 §3.4 图片预算）`);
  process.exit(1);
}
console.log('[og-cover] PASS: 体积达标（≤100KB）');
