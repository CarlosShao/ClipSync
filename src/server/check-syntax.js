const fs = require('fs');
const content = fs.readFileSync(process.argv[2] || 'src/routes/subscriptions.js', 'utf8');

// Check for unclosed backticks
let inTemplate = false;
let templateStart = -1;
for(let i = 0; i < content.length; i++) {
  if(content[i] === '`') {
    if(!inTemplate) {
      inTemplate = true;
      templateStart = i;
    } else {
      inTemplate = false;
    }
  }
}
if(inTemplate) {
  console.log('Unclosed template literal starting at position', templateStart);
  console.log('Context:', content.substring(Math.max(0,templateStart-20), templateStart+50));
} else {
  console.log('No unclosed template literals found');
}

// Check parentheses balance
let parens = 0;
let braces = 0;
let brackets = 0;
for(let i = 0; i < content.length; i++) {
  if(content[i] === '(') parens++;
  if(content[i] === ')') parens--;
  if(content[i] === '{') braces++;
  if(content[i] === '}') braces--;
  if(content[i] === '[') brackets++;
  if(content[i] === ']') brackets--;
  
  if(parens < 0) {
    console.log('Extra closing paren at position', i);
    console.log('Context:', content.substring(Math.max(0, i-30), i+30));
    break;
  }
  if(braces < 0) {
    console.log('Extra closing brace at position', i);
    console.log('Context:', content.substring(Math.max(0, i-30), i+30));
    break;
  }
  if(brackets < 0) {
    console.log('Extra closing bracket at position', i);
    console.log('Context:', content.substring(Math.max(0, i-30), i+30));
    break;
  }
}
if(parens > 0) console.log('Unclosed parens:', parens);
if(braces > 0) console.log('Unclosed braces:', braces);
if(brackets > 0) console.log('Unclosed brackets:', brackets);
if(parens === 0 && braces === 0 && brackets === 0) console.log('All balanced!');
