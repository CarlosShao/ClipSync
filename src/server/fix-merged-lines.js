const fs = require('fs');
const filePath = 'src/routes/subscriptions.js';

let content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');
const newLines = [];

for(let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const commentIdx = line.indexOf('//');
  
  if(commentIdx >= 0) {
    const beforeComment = line.substring(0, commentIdx);
    const afterComment = line.substring(commentIdx + 2);
    const trimmedAfter = afterComment.trim();
    
    // Check if afterComment looks like code (starts with common JS patterns)
    const codeStartPatterns = [
      'await ',
      'const ',
      'let ',
      'return ',
      'if ',
      'for ',
      'while ',
      'switch ',
      'try ',
      'catch ',
      'finally ',
      'async ',
      'function ',
      'class ',
      'import ',
      'export ',
      'this.',
      'pool.',
      'logger.',
      'logAuditEvent',
      '}',
      ')',
      '];'
    ];
    
    let isCode = false;
    for(const pattern of codeStartPatterns) {
      if(trimmedAfter.startsWith(pattern)) {
        isCode = true;
        break;
      }
    }
    
    // Also check if it looks like a variable assignment or function call
    if(!isCode && /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*[=(.]/.test(trimmedAfter)) {
      isCode = true;
    }
    
    if(isCode && !line.includes('://')) {
      // This line has comment + code merged
      // Find where the comment text ends and code starts
      // The comment text is garbled, so we need to find where the code starts
      
      let codeStart = -1;
      for(const pattern of codeStartPatterns) {
        const idx = afterComment.indexOf(pattern);
        if(idx >= 0) {
          codeStart = commentIdx + 2 + idx;
          break;
        }
      }
      
      if(codeStart < 0) {
        // Try to find by regex
        const match = afterComment.match(/^\s*.+?\s+([a-zA-Z_$(]|await |const |let |return |if |for |while |switch |try |catch |finally |async |function |class |import |export |this\.|pool\.|logger\.|logAuditEvent)/);
        if(match) {
          codeStart = commentIdx + 2 + match[1].length;
        }
      }
      
      if(codeStart >= 0) {
        const commentOnly = line.substring(0, codeStart).trimEnd();
        const codeOnly = line.substring(codeStart);
        newLines.push(commentOnly);
        newLines.push(codeOnly);
        continue;
      }
    }
  }
  
  newLines.push(line);
}

const newContent = newLines.join('\n');
fs.writeFileSync(filePath, newContent, 'utf8');
console.log('File fixed successfully!');
