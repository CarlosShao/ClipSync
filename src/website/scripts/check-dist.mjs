#!/usr/bin/env node
/**
 * dist 产物完整性校验（package.json "check"）
 *  1) dist/index.html 存在
 *  2) index.html 引用的本地 js/css 等资源在 dist 中真实存在（外链与 data: 除外）
 *  3) 关键附属产物存在：favicon.svg / og-cover.png / robots.txt / sitemap.xml / 404.html
 *  4) 产物中包含站点关键文案（防止构建内容被意外吞掉）
 *  5) JSON-LD 结构化数据可解析且为 Product + 三档 Offer（T-W1）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(pkgRoot, 'dist');
const problems = [];

console.log(`[check] dist 目录: ${distDir}`);

// ── 1) index.html ──
const indexPath = join(distDir, 'index.html');
if (!existsSync(indexPath)) {
  console.error('[check] FAIL: dist/index.html 不存在，请先执行 npm run build');
  process.exit(1);
}
const html = readFileSync(indexPath, 'utf8');
console.log('[check] OK: dist/index.html 存在');

// ── 2) 引用的本地产物真实存在 ──
const refs = new Set();
for (const [, url] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
  if (!url || url.startsWith('#')) continue;
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:')) continue;
  refs.add(url);
}
if (refs.size === 0) problems.push('index.html 未引用任何本地资源（js/css 产物丢失？）');

let jsCount = 0;
let cssCount = 0;
for (const ref of [...refs].sort()) {
  const file = join(distDir, ref.replace(/^\/+/, ''));
  const ok = existsSync(file);
  if (ref.endsWith('.js') || ref.endsWith('.mjs')) jsCount += ok ? 1 : 0;
  if (ref.endsWith('.css')) cssCount += ok ? 1 : 0;
  console.log(`[check] ${ok ? 'OK' : 'MISSING'}: ${ref}`);
  if (!ok) problems.push(`index.html 引用的产物不存在: ${ref}`);
}
if (jsCount === 0) problems.push('未找到被引用的 js 产物');
if (cssCount === 0) problems.push('未找到被引用的 css 产物');

// ── 3) 关键附属产物 ──
for (const name of ['favicon.svg', 'og-cover.png', 'robots.txt', 'sitemap.xml', '404.html']) {
  const ok = existsSync(join(distDir, name));
  console.log(`[check] ${ok ? 'OK' : 'MISSING'}: /${name}`);
  if (!ok) problems.push(`缺少附属产物: ${name}`);
}

// og-cover 体积预算（工程方案 §3.4：图片 ≤100KB）
const ogPath = join(distDir, 'og-cover.png');
if (existsSync(ogPath)) {
  const ogBytes = statSync(ogPath).size;
  const ok = ogBytes <= 100 * 1024;
  console.log(`[check] ${ok ? 'OK' : 'MISSING'}: og-cover.png 体积 ${(ogBytes / 1024).toFixed(1)}KB（≤100KB）`);
  if (!ok) problems.push(`og-cover.png 超过 100KB 预算: ${(ogBytes / 1024).toFixed(1)}KB`);
}

// ── 4) 关键文案仍在产物中 ──
const keywords = ['手机复制', '电脑秒粘', '端到端加密', '¥9.9', '免费下载'];
for (const kw of keywords) {
  const ok = html.includes(kw);
  console.log(`[check] ${ok ? 'OK' : 'MISSING'}: 关键文案「${kw}」`);
  if (!ok) problems.push(`产物缺少关键文案: ${kw}`);
}

// ── 5) JSON-LD 结构化数据（T-W1）：可解析、类型正确、价格与 pricing.ts 展示口径一致 ──
const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
if (!ldMatch) {
  problems.push('index.html 缺少 JSON-LD 结构化数据');
} else {
  try {
    const ld = JSON.parse(ldMatch[1]);
    const prices = ld.offers.map((o) => `${o.name}:${o.price}:${o.priceCurrency}`).join(', ');
    const okShape =
      ld['@type'] === 'Product' &&
      Array.isArray(ld.offers) &&
      ld.offers.length === 3 &&
      prices === 'Free:0:CNY, Pro:9.90:CNY, Enterprise:19.90:CNY';
    console.log(`[check] ${okShape ? 'OK' : 'MISSING'}: JSON-LD ${ld['@type']} → ${prices}`);
    if (!okShape) problems.push(`JSON-LD 结构/价格不符预期: ${prices}`);
  } catch (e) {
    problems.push(`JSON-LD 不是合法 JSON: ${e.message}`);
  }
}

if (problems.length > 0) {
  console.error(`\n[check] FAIL（${problems.length} 项）:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n[check] PASS: dist 产物完整，全部引用可达');
