const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

const ivCss = `
/* ===== Image Viewer ===== */
.image-viewer {
  position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
  background: rgba(0,0,0,0.85); z-index: 9998;
  display: none; flex-direction: column; align-items: center; justify-content: center;
}
.image-viewer[style*="display: flex"] { display: flex !important; }
.iv-toolbar {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 16px; background: rgba(0,0,0,0.5); color: white; z-index: 1;
}
.iv-title { font-size: 13px; font-weight: 500; }
.iv-actions { display: flex; gap: 8px; }
.iv-btn {
  padding: 6px 14px; border: 1px solid rgba(255,255,255,0.3); border-radius: 6px;
  background: rgba(255,255,255,0.1); color: white; cursor: pointer; font-size: 12px;
}
.iv-btn:hover { background: rgba(255,255,255,0.2); }
.iv-image-wrap { flex: 1; display: flex; align-items: center; justify-content: center; padding: 50px; }
.iv-image { max-width: 90vw; max-height: 85vh; object-fit: contain; border-radius: 8px; }
`;

html = html.replace('</style>', ivCss + '\n</style>');
fs.writeFileSync('index.html', html);
console.log('CSS added successfully');
