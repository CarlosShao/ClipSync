const fs = require('fs');
const filePath = process.argv[2] || 'src/routes/subscriptions.js';
let content = fs.readFileSync(filePath, 'utf8');

// Split content into lines
const lines = content.split('\n');
const newLines = [];

for(let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  // Check if this line has a // comment followed by code on the same line
  // Pattern: ... // comment_text    code_that_should_be_on_next_line
  // We need to find lines where after // there's text that looks like code (not just a comment)
  
  const commentIndex = line.indexOf('//');
  if(commentIndex >= 0) {
    // Get the part after //
    const afterComment = line.substring(commentIndex + 2);
    
    // Check if the part after // looks like code (starts with a letter, underscore, or common code patterns)
    // AND the line doesn't look like a URL (no :// in the comment part)
    const beforeComment = line.substring(0, commentIndex);
    const trimmedAfter = afterComment.trim();
    
    // If the line contains a URL, skip it
    if(line.includes('://')) {
      newLines.push(line);
      continue;
    }
    
    // Check if afterComment has code-like content (starts with common JS keywords/patterns)
    const codePatterns = /^(\s*)(await |const |let |var |return |if |for |while |switch |case |break |continue |throw |try |catch |finally |async |function |class |import |export |this\.|[a-zA-Z_$][a-zA-Z0-9_$]*\s*[=(.\[])/;
    
    if(trimmedAfter.length > 0 && codePatterns.test(trimmedAfter)) {
      // This line has comment + code merged
      // Split into two lines
      const indent = beforeComment.match(/^(\s*)/)[1];
      const commentText = afterComment.match(/^\s*(.+?)\s+[a-zA-Z_$]/);
      
      if(commentText) {
        // Find where the comment ends and code starts
        // This is tricky because the comment text is garbled
        // Let's find the first occurrence of common code patterns
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
          'async ',
          'function ',
          'this.',
          'pool.',
          'logger.',
          'logAuditEvent',
          /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*[=(]/
        ];
        
        let splitPos = -1;
        for(const pattern of codeStartPatterns) {
          const idx = afterComment.search(typeof pattern === 'string' ? pattern : pattern);
          if(idx >= 0) {
            splitPos = commentIndex + 2 + idx;
            break;
          }
        }
        
        if(splitPos >= 0) {
          const commentOnly = line.substring(0, splitPos).trimEnd();
          const codeOnly = line.substring(splitPos);
          newLines.push(commentOnly);
          newLines.push(codeOnly);
          continue;
        }
      }
      
      // If we can't parse precisely, just add the line as-is and we'll fix manually
      newLines.push(line);
      continue;
    }
  }
  
  newLines.push(line);
}

const newContent = newLines.join('\n');
fs.writeFileSync(filePath + '.fixed', newContent, 'utf8');
console.log('Fixed file written to', filePath + '.fixed');
console.log('Please review and replace the original file if correct.');
