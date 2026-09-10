// 软著源代码抽取：从后端 Node.js 源程序生成「前30页 + 后30页」（每页50行）
// 用法：node scripts/ruanzhu-extract.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('src/server/src');
const OUT_DIR = path.resolve('docs/audit/ruanzhu');
const EXCLUDE_DIRS = new Set(['node_modules', 'tests']); // db 内的 .js 保留；仅排除测试与依赖
const PER_PAGE = 50;
const NAME = 'ClipSync 剪贴板同步软件';
const VER = 'V1.0.0';

const lines = [];
function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const r = path.join(rel, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      walk(p, r);
    } else if (e.name.endsWith('.js')) {
      lines.push(`// ===== file: ${r.split(path.sep).join('/')} =====`);
      const content = fs.readFileSync(p, 'utf8');
      for (const ln of content.split(/\r?\n/)) lines.push(ln);
    }
  }
}
walk(ROOT, '');

const total = lines.length;
const totalPages = Math.ceil(total / PER_PAGE);
fs.mkdirSync(OUT_DIR, { recursive: true });

function buildFile(startPage, endPage) {
  const arr = [];
  for (let pg = startPage; pg <= endPage; pg++) {
    const start = (pg - 1) * PER_PAGE;
    const slice = lines.slice(start, start + PER_PAGE);
    arr.push(`${NAME}  ${VER}  第 ${pg} 页`);
    for (const l of slice) arr.push(l);
    for (let i = slice.length; i < PER_PAGE; i++) arr.push('');
  }
  return arr.join('\n');
}

if (totalPages <= 60) {
  fs.writeFileSync(path.join(OUT_DIR, '源代码_全部.txt'), buildFile(1, totalPages));
  console.log(`程序共 ${total} 行 / ${totalPages} 页（不足60页），已输出 源代码_全部.txt`);
} else {
  fs.writeFileSync(path.join(OUT_DIR, '源代码_前30页.txt'), buildFile(1, 30));
  fs.writeFileSync(path.join(OUT_DIR, '源代码_后30页.txt'), buildFile(totalPages - 29, totalPages));
  console.log(`程序共 ${total} 行 / ${totalPages} 页，已输出 源代码_前30页.txt + 源代码_后30页.txt`);
}
