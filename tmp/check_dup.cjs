const fs = require('fs');
for (const f of ['src/desktop/src/locales/en.json', 'src/desktop/src/locales/zh.json']) {
  const t = fs.readFileSync(f, 'utf8');
  const re = /^\s*"([^"]+)"\s*:/gm;
  const seen = {}; const dups = []; let m;
  while ((m = re.exec(t))) { if (seen[m[1]]) dups.push(m[1]); seen[m[1]] = 1; }
  JSON.parse(t);
  console.log(f, 'parse:OK', 'dups:', JSON.stringify(dups));
}
