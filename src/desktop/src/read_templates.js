const fs = require('fs');
const path = 'D:/work/java/AI-workspace/ClipSync/src/desktop/src/index.html';
const html = fs.readFileSync(path, 'utf8');

const idx = html.indexOf('modalTemplates');
if (idx === -1) {
  console.log('modalTemplates not found');
  process.exit(1);
}

// Find the start of the object (after `= {`)
const startIdx = html.indexOf('{', idx);
if (startIdx === -1) {
  console.log('modalTemplates object start not found');
  process.exit(1);
}

// Find the matching closing brace
let braceCount = 1;
let endIdx = startIdx + 1;
for (let i = endIdx; i < html.length; i++) {
  if (html[i] === '{') braceCount++;
  if (html[i] === '}') {
    braceCount--;
    if (braceCount === 0) {
      endIdx = i;
      break;
    }
  }
}

const templates = html.substring(startIdx, endIdx + 1);
console.log('modalTemplates:');
console.log(templates);
console.log('\n---');
// Also list the template names
const names = templates.match(/^\s*(\w+):/gm);
if (names) {
  console.log('Template names:', names.map(n => n.trim().replace(':', '')).join(', '));
}
