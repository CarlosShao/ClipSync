#!/usr/bin/env node
/**
 * dist 产物完整性校验（package.json "check"）
 *  1) dist/index.html 存在
 *  2) index.html 引用的本地 js/css 等资源在 dist 中真实存在（外链与 data: 除外）
 *  3) 关键附属产物存在：favicon.svg / og-cover.png / robots.txt / sitemap.xml
 *  4) 产物中包含站点关键文案（防止构建内容被意外吞掉）
 */
import { existsSync, readFileSync } from 'node:fs';
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
for (const name of ['favicon.svg', 'og-cover.png', 'robots.txt', 'sitemap.xml']) {
  const ok = existsSync(join(distDir, name));
  console.log(`[check] ${ok ? 'OK' : 'MISSING'}: /${name}`);
  if (!ok) problems.push(`缺少附属产物: ${name}`);
}

// ── 4) 关键文案仍在产物中 ──
const keywords = ['手机复制', '电脑秒粘', '端到端加密', '¥9.9', '免费下载'];
for (const kw of keywords) {
  const ok = html.includes(kw);
  console.log(`[check] ${ok ? 'OK' : 'MISSING'}: 关键文案「${kw}」`);
  if (!ok) problems.push(`产物缺少关键文案: ${kw}`);
}

if (problems.length > 0) {
  console.error(`\n[check] FAIL（${problems.length} 项）:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n[check] PASS: dist 产物完整，全部引用可达');
