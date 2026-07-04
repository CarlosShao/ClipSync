const fs = require('fs');
const old = fs.readFileSync('index.old', 'utf8');
let html = fs.readFileSync('index.html', 'utf8');

// Extract function with brace matching
function extractFunc(src, funcName) {
  const prefix = 'function ' + funcName + '(';
  const idx = src.indexOf(prefix);
  if (idx < 0) return null;
  let bc = 0, end = idx, started = false;
  for (let i = idx; i < Math.min(idx + 8000, src.length); i++) {
    if (src[i] === '{') { bc++; started = true; }
    if (src[i] === '}') { bc--; if (started && bc === 0) { end = i + 1; break; } }
  }
  return end > idx ? src.substring(idx, end) : null;
}

// All critical functions to migrate
const critical = [
  'selectPlan',
  'closeSubscriptionModal',
  'closeBillingModal',
  'getTypeIcon',
  'getTypeLabel',
  'getTypeClass',
  'getDeviceIcon',
  'getDeviceClass',
  '_formatShortcut',
  '_renderShortcutBadge',
  '_startCapture',
  '_endCapture',
  '_onCaptureKeyDown',
  'escapeAttr',
  'loadSubscriptionInfo',
  '_fmtUnlimited',
];

let added = [];

critical.forEach(f => {
  if (html.includes('function ' + f + '(') || html.includes('async function ' + f + '(')) {
    console.log(`⚠️  ${f} already exists, skipping`);
    return;
  }
  const code = extractFunc(old, f);
  if (code) {
    added.push(f);
    console.log(`✅ Extracted ${f} (${code.length} chars)`);
  } else {
    console.log(`❌ ${f} NOT FOUND in index.old`);
  }
});

if (added.length === 0) {
  console.log('Nothing to add.');
  process.exit(0);
}

// Build the code block to insert
const insertCode = '\n' + added.map(f => extractFunc(old, f)).filter(Boolean).join('\n\n') + '\n';

// Insert before // ===== Init =====
const initPos = html.indexOf('// ===== Init =====');
if (initPos < 0) {
  console.log('ERROR: // ===== Init ===== not found');
  process.exit(1);
}

html = html.substring(0, initPos) + insertCode + html.substring(initPos);
fs.writeFileSync('index.html', html);
console.log(`\nDone! Inserted ${added.length} functions before Init.`);

// Quick syntax pre-check (look for obvious issues)
const jsMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (jsMatch) {
  const js = jsMatch[1];
  // Check for duplicate function names
  const allFuncs = [...js.matchAll(/function\s+(\w+)\s*\(/g)];
  const seen = {};
  allFuncs.forEach(m => {
    if (seen[m[1]]) console.log(`⚠️  Duplicate function: ${m[1]}`);
    seen[m[1]] = true;
  });
  console.log('Total functions in new file:', Object.keys(seen).length);
}
