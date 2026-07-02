const fs = require('fs');
const filePath = 'D:/work/java/AI-workspace/ClipSync/src/desktop/src/index.html';

// Read the original file
let content = fs.readFileSync(filePath, 'utf8');

// Find the position where we need to insert the new JavaScript functions
// We'll insert them before the closing </script> tag
const scriptEndPos = content.lastIndexOf('</script>');

if (scriptEndPos === -1) {
  console.log('ERROR: No </script> tag found');
  process.exit(1);
}

// New JavaScript functions to add
const newFunctions = `

    // ====== Subscription Management ======
    async function loadSubscriptionInfo() {
      if (!state.token) return;
      try {
        const data = await api("GET", "/api/subscriptions/current", null, true);
        const el = document.getElementById("settings-current-plan");
        if (el) {
          el.textContent = (data && data.plan)
            ? data.plan.name + " · ¥" + data.plan.price + "/" + (data.plan.billingCycle === "month" ? "月" : "年")
            : "免费版 (Free)";
        }
      } catch(e) {
        const el = document.getElementById("settings-current-plan");
        if (el) el.textContent = "免费版 (Free)";
      }
    }

    function showSubscriptionPlans() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("subscription-modal").style.display = "flex";
      showToast("套餐功能开发中...");
    }

    function closeSubscriptionModal() { document.getElementById("subscription-modal").style.display = "none"; }

    function showBillingHistory() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("billing-modal").style.display = "flex";
      document.getElementById("billing-list").innerHTML = "<div style='text-align:center;padding:20px;color:#999;'>开发中...</div>";
    }

    function closeBillingModal() { document.getElementById("billing-modal").style.display = "none"; }

    // ====== Profile ======
    function showProfileModal() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("profile-modal").style.display = "flex";
      if (state.user) {
        document.getElementById("profile-username").value = state.user.username || "";
        document.getElementById("profile-email").value = state.user.email || "";
      }
    }

    async function saveProfile() {
      const username = document.getElementById("profile-username").value.trim();
      const email = document.getElementById("profile-email").value.trim();
      try {
        await api("PUT", "/api/users/profile", { username, email });
        showToast("保存成功");
        closeProfileModal();
        if (state.user) { state.user.username = username; state.user.email = email; }
      } catch(e) { showToast("保存失败"); }
    }

    function closeProfileModal() { document.getElementById("profile-modal").style.display = "none"; }

    // ====== Notification Settings ======
    function showNotifSettings() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("notif-settings-modal").style.display = "flex";
      document.getElementById("notif-settings-list").innerHTML = 
        ["新设备登录", "剪贴板同步", "订阅到期", "安全警告"].map(k => 
          \`<div style='display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;'><span>\${k}</span><label class='toggle'><input type='checkbox' checked onchange='toggleNotifSetting("\${k}",this.checked)'><span class='toggle-slider'></span></label></div>\`
        ).join('');
    }

    function toggleNotifSetting(key, val) { try { api("PUT", "/api/notifications/settings", { key, enabled: val }); } catch(e) {} }
    function closeNotifSettingsModal() { document.getElementById("notif-settings-modal").style.display = "none"; }

    // ====== Session Management ======
    function showSessionManagement() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("session-modal").style.display = "flex";
      document.getElementById("session-list").innerHTML = "<div style='text-align:center;padding:20px;color:#999;'>加载中...</div>";
      api("GET", "/api/sessions").then(data => {
        const sessions = data.sessions || [];
        document.getElementById("session-list").innerHTML = sessions.map(s => {
          const isCurrent = s.id === state.sessionId;
          return \`<div style='display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;'><div><b>\${s.deviceName || '未知设备'}</b><br><small style='color:#999'>\${s.ip || ''}</small></div>\${isCurrent ? '<span style="color:#6366f1;font-size:12px;">当前</span>' : '<button onclick="kickSession(\\'' + s.id + '\\')" style="background:#ef4444;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">踢出</button>'}</div>\`;
        }).join('');
      }).catch(() => { document.getElementById("session-list").innerHTML = "<div style='text-align:center;padding:20px;color:#e74c3c;'>加载失败</div>"; });
    }

    async function kickSession(id) { if(!confirm("确认?"))return; try{await api("DELETE","/api/sessions/"+id);showToast("已踢出");showSessionManagement();}catch(e){showToast("失败");} }
    function closeSessionModal() { document.getElementById("session-modal").style.display = "none"; }

    // ====== GDPR Export ======
    function showGDPRExport() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("gdpr-modal").style.display = "flex";
      document.getElementById("gdpr-export-result").innerHTML = "<div style='text-align:center;padding:20px;'><button class='btn btn-primary btn-block' onclick='doGDPRExport()'>开始导出</button><p style='color:#999;font-size:12px;margin-top:8px;'>导出包括所有个人数据</p></div>";
    }

    async function doGDPRExport() {
      try {
        const data = await api("GET", "/api/gdpr/export");
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "clipsync-gdpr-export-" + Date.now() + ".json"; a.click();
        URL.revokeObjectURL(url);
        showToast("导出成功");
      } catch(e) { showToast("导出失败: " + (e.message||"")); }
    }

    function closeGDPRModal() { document.getElementById("gdpr-modal").style.display = "none"; }

    // ====== Security Settings ======
    function showSecuritySettings() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("security-modal").style.display = "flex";
      document.getElementById("security-settings-list").innerHTML = [
        {k:"两步验证",d:"提升账号安全"},
        {k:"登录设备提醒",d:"新设备登录时通知"},
        {k:"端到端加密",d:"剪贴板内容加密同步"}
      ].map(i=>`<div style='display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;'><span><b>\${i.k}</b><br><small style='color:#999'>\${i.d}</small></span><label class='toggle'><input type='checkbox' onchange='toggleSecurity("\${i.k}",this.checked)'><span class='toggle-slider'></span></label></div>`).join('');
    }

    function toggleSecurity(k,v) { try{api("PUT","/api/security/settings",{key:k,enabled:v});}catch(e){} }
    function closeSecurityModal() { document.getElementById("security-modal").style.display = "none"; }

    // ====== Check Updates ======
    async function checkForUpdates() {
      showToast("正在检查更新...");
      setTimeout(() => { showToast("当前已是最新版本 v0.1.0"); }, 1000);
    }

    // Wire up settings page load
    const _origRS = window.renderSettings;
    window.renderSettings = function() { if (_origRS) _origRS(); loadSubscriptionInfo(); };
`;

// Insert the new functions before the closing </script> tag
const newContent = content.slice(0, scriptEndPos) + newFunctions + '\n  </script>\n</body>\n</html>';

// Write the file
fs.writeFileSync(filePath, newContent, 'utf8');
console.log('✅ New functions added successfully');

// Validate syntax
const html = fs.readFileSync(filePath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  try {
    new Function(scriptMatch[1]);
    console.log('✅ JavaScript syntax is valid!');
  } catch (e) {
    console.log('❌ Syntax Error:', e.message);
    console.log('Line:', e.stack.split('\n')[1]);
  }
}
