const fs = require('fs');
const filePath = 'index.html';

// Read the file
let content = fs.readFileSync(filePath, 'utf8');

// Fix 1: Update api() function to add silent parameter
content = content.replace(
  /async function api\(method, path, body\) \{/,
  'async function api(method, path, body, silent) {'
);
content = content.replace(
  /if \(!resp\.ok\) throw new Error\(data\.error \|\| 'Request failed'\);/,
  `if (!resp.ok) {\n        if (!silent) console.error('API Error:', path, data.error);\n        throw new Error(data.error || 'Request failed');\n      }`
);

// Fix 2: Fix showNotifSettings() function - nested quote issue
content = content.replace(
  /onchange='toggleNotifSetting\("" \+ k \+ ""/,
  `onchange='toggleNotifSetting("\${k}"`
);
// Actually, let's rewrite the entire function with template literals
const oldNotifFunc = `    function showNotifSettings() {
      if (!state.token) { showToast("\u8bf7\u5148\u767b\u5f55"); return; }
      document.getElementById("notif-settings-modal").style.display = "flex";
      document.getElementById("notif-settings-list").innerHTML =
        ["\u65b0\u8bbe\u5907\u767b\u5f55", "\u526a\u8d34\u677f\u540c\u6b65", "\u8ba2\u9605\u5230\u671f", "\u5b89\u5168\u8b66\u544a"].map(k =>
          "<div style='display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;'><span>" + k + "</span><label class='toggle'><input type='checkbox' checked onchange='toggleNotifSetting("" + k + "",this.checked)'><span class='toggle-slider'></span></label></div>"
        ).join("")
    }`;

const newNotifFunc = `    function showNotifSettings() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("notif-settings-modal").style.display = "flex";
      document.getElementById("notif-settings-list").innerHTML = 
        ["新设备登录", "剪贴板同步", "订阅到期", "安全警告"].map(k => 
          \`<div style='display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;'><span>\${k}</span><label class='toggle'><input type='checkbox' checked onchange='toggleNotifSetting("\${k}",this.checked)'><span class='toggle-slider'></span></label></div>\`
        ).join('');
    }`;

content = content.replace(oldNotifFunc, newNotifFunc);

// Write the fixed file
fs.writeFileSync(filePath, content, 'utf8');
console.log('✅ File fixed successfully');

// Validate syntax
const html = fs.readFileSync(filePath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  try {
    new Function(scriptMatch[1]);
    console.log('✅ JavaScript syntax is valid!');
  } catch (e) {
    console.log('❌ Syntax Error:', e.message);
  }
}
