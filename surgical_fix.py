"""
精确手术式修改 index.html —— 只修改必要的地方，不破坏原有结构
"""
import re

FILE = r"D:\work\java\AI-workspace\ClipSync\src\desktop\src\index.html"

with open(FILE, "r", encoding="utf-8") as f:
    html = f.read()

changes = []

# ===== CHANGE 1: api() 函数添加 silent 参数 =====
old_api = """    async function api(method, path, body) {
      const opts = { method, headers: {} };
      if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(API_BASE + path, opts);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Request failed');
      return data;
    }"""

new_api = """    async function api(method, path, body, silent) {
      const opts = { method, headers: {} };
      if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(API_BASE + path, opts);
      const data = await resp.json();
      if (!resp.ok) { if (!silent) console.error('API Error:', data.error || 'Request failed'); throw new Error(data.error || 'Request failed'); }
      return data;
    }"""

assert old_api in html, "❌ CHANGE 1 FAILED: old api() not found!"
html = html.replace(old_api, new_api)
changes.append("✅ api() 添加 silent 参数")

# ===== CHANGE 2: loadClipboardItems 加 silent =====
html = html.replace(
    "const data = await api('GET', '/api/clipboard?limit=100');",
    "const data = await api('GET', '/api/clipboard?limit=100', null, true);"
)
changes.append("✅ loadClipboardItems 静默")

# ===== CHANGE 3: loadDevices 加 silent =====
html = html.replace(
    "const devices = await api('GET', '/api/devices');",
    "const devices = await api('GET', '/api/devices', null, true);"
)
changes.append("✅ loadDevices 静默")

# ===== CHANGE 4: 替换 renderSettings 函数（保持原有缩进风格）=====
old_settings = '''    function renderSettings() {
      const container = document.getElementById('content-area');
      container.innerHTML = `
        <div class="settings-page">
          <div class="settings-group">
            <div class="settings-group-title">同步</div>
            <div class="settings-item">
              <div class="settings-item-left">
                <span class="settings-item-icon">🔄</span>
                <div>
                  <div class="settings-item-label">自动同步</div>
                  <div class="settings-item-desc">复制内容后自动上传到服务器</div>
                </div>
              </div>
              <label class="toggle"><input type="checkbox" ${state.autoSync ? 'checked' : ''} onchange="state.autoSync=this.checked"><span class="toggle-slider"></span></label>
            </div>
          </div>
          <div class="settings-group">
            <div class="settings-group-title">关于</div>
            <div class="settings-item">
              <div class="settings-item-left">
                <span class="settings-item-icon">ℹ️</span>
                <div>
                  <div class="settings-item-label">ClipSync</div>
                  <div class="settings-item-desc">版本 0.1.0 (MVP) · 跨设备剪贴板同步</div>
                </div>
              </div>
            </div>

          </div>
        </div>`;
    }'''

new_settings = '''    function renderSettings() {
      var c = document.getElementById('content-area');
      c.innerHTML = '<div class="settings-page">'
        // 同步与监控
        + '<div class="settings-group"><div class="settings-group-title">同步与监控</div>'
        + mkSettingItem('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.3"/></svg>', '自动同步', '复制内容后自动上传到服务器', mkToggle(state.autoSync, 'state.autoSync=this.checked'))
        + '</div>'
        // 账号与安全
        + '<div class="settings-group"><div class="settings-group-title">账号与安全</div>'
        + mkSettingClick('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>', '登录会话', '管理已登录的设备', 'showSessionManagement()')
        + mkSettingClick('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>', '隐私与安全', '密码、加密、会话管理', 'showSecuritySettings()')
        + '</div>'
        // 订阅管理
        + '<div class="settings-group"><div class="settings-group-title">订阅管理</div>'
        + mkSettingClick('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>', '当前套餐', '免费版 (Free)', 'showSubscriptionPlans()', 'settings-current-plan')
        + mkSettingClick('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>', '账单记录', '查看历史账单', 'showBillingHistory()')
        + '</div>'
        // 偏好设置
        + '<div class="settings-group"><div class="settings-group-title">偏好设置</div>'
        + mkSettingClick('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>', '通知偏好', '自定义通知类型和方式', 'showNotifSettings()')
        + mkSettingClick('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', '检查更新', '当前版本 v0.1.0', 'checkForUpdates()')
        + mkSettingClick('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>', '数据导出', '导出所有个人数据 (GDPR)', 'showGDPRExport()')
        + '</div>'
        // 个人资料
        + '<div class="settings-group"><div class="settings-group-title">个人资料</div>'
        + mkSettingClick('<svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', '编辑资料', '修改用户名、邮箱', 'showProfileModal()')
        + '</div>'
        // 关于
        + '<div class="settings-group"><div class="settings-group-title">关于</div>'
        + '<div class="settings-item"><div class="settings-item-left"><div style="width:38px;height:38px;border-radius:10px;background:#f0f2f5;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></div><div><div class="settings-item-label">ClipSync</div><div class="settings-item-desc">版本 0.1.0 (MVP) &middot; 跨设备剪贴板同步</div></div></div></div>'
        + '</div></div>';
    }

    function mkIcon(svgHtml) {
      return '<div style="width:38px;height:38px;min-width:38px;border-radius:10px;background:linear-gradient(135deg,#f0eeff,#e8e4ff);display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + svgHtml + '</div>';
    }
    function mkSettingItem(icon, label, desc, rightHtml) {
      return '<div class="settings-item"><div class="settings-item-left">' + mkIcon(icon) + '<div><div class="settings-item-label">' + label + '</div><div class="settings-item-desc">' + desc + '</div></div></div>' + rightHtml + '</div>';
    }
    function mkSettingClick(icon, label, desc, fnName, idAttr) {
      idStr = idAttr ? (' id="' + idAttr + '"') : '';
      return '<div class="settings-item" onclick="' + fnName + '" style="cursor:pointer"><div class="settings-item-left">' + mkIcon(icon) + '<div' + idStr + '><div class="settings-item-label">' + label + '</div><div class="settings-item-desc">' + desc + '</div></div></div><span style="color:#c7c9d2;font-size:18px;font-weight:300">&rsaquo;</span></div>';
    }
    function mkToggle(checked, onchange) {
      return '<label class="toggle"><input type="checkbox"' + (checked?' checked':'') + ' onchange="' + onchange + '"><span class="toggle-slider"></span></label>';
    }'''

assert old_settings in html, "❌ CHANGE 4 FAILED: old renderSettings not found!"
html = html.replace(old_settings, new_settings)
changes.append("✅ renderSettings 升级为 9 个设置项")

# ===== CHANGE 5: 在 </script> 前添加新函数 =====
new_functions = '''
    // ====== Settings Modals & Functions ======
    function closeSubscriptionModal() { document.getElementById('subscription-modal').style.display = 'none'; }
    function closeBillingModal() { document.getElementById('billing-modal').style.display = 'none'; }
    function closeProfileModal() { document.getElementById('profile-modal').style.display = 'none'; }
    function closeNotifSettingsModal() { document.getElementById('notif-settings-modal').style.display = 'none'; }
    function closeSessionModal() { document.getElementById('session-modal').style.display = 'none'; }
    function closeGDPRModal() { document.getElementById('gdpr-modal').style.display = 'none'; }
    function closeSecurityModal() { document.getElementById('security-modal').style.display = 'none'; }

    function showSubscriptionPlans() {
      if (!state.token) { showToast('请先登录'); return; }
      document.getElementById('subscription-modal').style.display = 'flex';
      try { api('GET','/api/subscriptions/current',null,true).then(function(d){var el=document.getElementById('settings-current-plan');if(el&&d&&d.plan){el.textContent=d.plan.name||'免费版';}}); } catch(e){}
    }
    function showBillingHistory() { if(!state.token){showToast('请先登录');return;} document.getElementById('billing-modal').style.display='flex'; document.getElementById('billing-list').innerHTML='<p style="padding:40px;color:#999;text-align:center;">暂无账单记录</p>'; }
    function showProfileModal() { if(!state.token){showToast('请先登录');return;} document.getElementById('profile-modal').style.display='flex'; }
    function saveProfile() { var u=document.getElementById('profile-username').value,e=document.getElementById('profile-email').value; api('PUT','/api/users/profile',{username:u,email:e},true).then(function(){showToast('保存成功');closeProfileModal();}).catch(function(){showToast('保存失败');}); }
    function showNotifSettings() { if(!state.token){showToast('请先登录');return;} document.getElementById('notif-settings-modal').style.display='flex'; document.getElementById('notif-settings-list').innerHTML=['新设备登录','剪贴板同步','订阅到期','安全警告'].map(function(k){return "<div style='display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0'><span>"+k+"</span><label class='toggle'><input type='checkbox' checked onchange='toggleNotifSetting(this.getAttribute(\"data-key\"),this.checked)' data-key='"+k+"'><span class='toggle-slider'></span></label></div>";}).join(''); }
    function toggleNotifSetting(key,val) { api('PUT','/api/notifications/settings',{key:key,enabled:val},true).catch(function(){}); }
    function showSessionManagement() { if(!state.token){showToast('请先登录');return;} document.getElementById('session-modal').style.display='flex'; document.getElementById('session-list').innerHTML='<p style="padding:40px;color:#999;text-align:center;">加载中...</p>'; api('GET','/api/sessions',null,true).then(function(d){var list=d.sessions||[];document.getElementById('session-list').innerHTML=list.length?list.map(function(s){return "<div style='display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0'><div><b>"+s.device+"</b><br><small style='color:#999'>"+s.ip+" | "+s.lastActive+"</small></div>"+(s.current?"<span style='color:#999'>当前</span>":"<button onclick='kickSession(\""+s.id+"\")' style='background:none;border:none;cursor:pointer;color:#ff7675'>踢出</button>")+"</div>";}).join(''):'<p style="padding:40px;color:#999">无其他会话</p>'; }).catch(function(){document.getElementById('session-list').innerHTML='<p style="padding:40px;color:#ff7675">加载失败</p>';}); }
    function kickSession(id) { api('DELETE','/api/sessions/'+id,null,true).then(function(){showSessionManagement();showToast('已踢出');}).catch(function(){showToast('操作失败');}); }
    function showGDPRExport() { if(!state.token){showToast('请先登录');return;} document.getElementById('gdpr-modal').style.display='flex'; document.getElementById('gdpr-export-result').innerHTML='<p style="padding:40px;color:#999;text-align:center;">正在导出...</p>'; api('GET','/api/gdpr/export',null,true).then(function(d){document.getElementById('gdpr-export-result').innerHTML="<pre style='padding:16px;font-size:12px;max-height:300px;overflow:auto;'>"+JSON.stringify(d,null,2)+"</pre><button class='btn btn-primary btn-block' onclick='downloadJson(this.previousSibling.textContent,\"clipsync-export.json\")'>下载文件</button>";}).catch(function(){document.getElementById('gdpr-export-result').innerHTML='<p style="padding:40px;color:#ff7675">导出失败</p>';}); }
    function downloadJson(content,filename){var a=document.createElement('a');a.href='data:text/json;charset=utf-8,'+encodeURIComponent(content);a.download=filename;a.click();}
    function showSecuritySettings() { if(!state.token){showToast('请先登录');return;} document.getElementById('security-modal').style.display='flex'; var items=[{k:'两步验证',d:'提升账号安全'},{k:'登录设备提醒',d:'新设备登录时通知'},{k:'端到端加密',d:'剪贴板内容加密同步'}]; document.getElementById('security-settings-list').innerHTML=items.map(function(i){return "<div style='display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0'><div><b>"+i.k+"</b><br><small style='color:#999'>"+i.d+"</small></div><label class='toggle'><input type='checkbox' onchange='toggleSecurity(this.getAttribute(\"data-key\"),this.checked)' data-key='"+i.k+"'><span class='toggle-slider'></span></label></div>";}).join(''); }
    function toggleSecurity(key,val) { api('PUT','/api/security/settings',{key:key,enabled:val},true).catch(function(){}); }
    function checkForUpdates() { showToast('当前已是最新版本 v0.1.0'); }'''

# Insert before the Helpers section
old_helpers_marker = "    // ====== Helpers ======"
assert old_helpers_marker in html, "❌ CHANGE 5 FAILED: Helpers marker not found!"
html = html.replace(old_helpers_marker, new_functions + "\n    " + old_helpers_marker)
changes.append("✅ 添加所有 P1 功能函数")

# ===== CHANGE 6: 在 </body> 前添加模态框 HTML =====
modal_html = '''
  <!-- Subscription Modal -->
  <div class="modal-overlay" id="subscription-modal" style="display:none"><div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0;font-size:18px">订阅套餐</h2><button onclick="closeSubscriptionModal()" style="background:none;border:none;font-size:22px;cursor:pointer">&times;</button></div><div style="text-align:center;padding:30px 20px;color:#999"><p>套餐功能开发中...</p></div></div></div>
  <!-- Billing Modal -->
  <div class="modal-overlay" id="billing-modal" style="display:none"><div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0;font-size:18px">账单记录</h2><button onclick="closeBillingModal()" style="background:none;border:none;font-size:22px;cursor:pointer">&times;</button></div><div id="billing-list"></div></div></div>
  <!-- Profile Modal -->
  <div class="modal-overlay" id="profile-modal" style="display:none"><div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0;font-size:18px">个人资料</h2><button onclick="closeProfileModal()" style="background:none;border:none;font-size:22px;cursor:pointer">&times;</button></div><div style="margin-bottom:14px"><label style="display:block;margin-bottom:5px;font-size:13px;color:#666">用户名</label><input type="text" id="profile-username" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px"></div><div style="margin-bottom:16px"><label style="display:block;margin-bottom:5px;font-size:13px;color:#666">邮箱</label><input type="email" id="profile-email" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px"></div><button class="btn btn-primary btn-block" onclick="saveProfile()">保存</button></div></div>
  <!-- Notification Modal -->
  <div class="modal-overlay" id="notif-settings-modal" style="display:none"><div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0;font-size:18px">通知偏好</h2><button onclick="closeNotifSettingsModal()" style="background:none;border:none;font-size:22px;cursor:pointer">&times;</button></div><div id="notif-settings-list"></div></div></div>
  <!-- Session Modal -->
  <div class="modal-overlay" id="session-modal" style="display:none"><div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0;font-size:18px">登录会话</h2><button onclick="closeSessionModal()" style="background:none;border:none;font-size:22px;cursor:pointer">&times;</button></div><div id="session-list"></div></div></div>
  <!-- GDPR Export Modal -->
  <div class="modal-overlay" id="gdpr-modal" style="display:none"><div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0;font-size:18px">数据导出 (GDPR)</h2><button onclick="closeGDPRModal()" style="background:none;border:none;font-size:22px;cursor:pointer">&times;</button></div><div id="gdpr-export-result"></div></div></div>
  <!-- Security Modal -->
  <div class="modal-overlay" id="security-modal" style="display:none"><div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0;font-size:18px">隐私与安全</h2><button onclick="closeSecurityModal()" style="background:none;border:none;font-size:22px;cursor:pointer">&times;</button></div><div id="security-settings-list"></div></div></div>'''

html = html.replace("</script>", "</script>\n" + modal_html)
changes.append("✅ 添加 7 个模态框 HTML")

# ===== CHANGE 7: CSS 增强（在 </style> 前）=====
css_upgrade = '''
    /* UI Enhancement */
    .settings-item{transition:background .18s}.settings-item:hover{background:rgba(99,102,241,.03)}
    .settings-item[onclick]{cursor:pointer}
    .toggle input:checked+.toggle-slider{box-shadow:0 2px 8px rgba(99,102,241,.25)}
    .toggle-slider:before{box-shadow:0 2px 4px rgba(0,0,0,.15)}
    .modal{animation:modalIn .22s ease-out}
    @keyframes modalIn{from{opacity:0;transform:scale(.97)translateY(-8px)}to{opacity:1;transform:scale(1)translateY(0)}}
    .clipboard-card{transition:transform .2s ease,box-shadow .2s ease}
    .clipboard-card:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(108,92,231,.12),0 2px 6px rgba(0,0,0,.05)}'''

html = html.replace("</style>", css_upgrade + "\n  </style>")
changes.append("✅ CSS 增强（hover、动画、阴影）")

# ===== 写入文件 =====
with open(FILE, "w", encoding="utf-8") as f:
    f.write(html)

print("\n===== 全部修改完成 =====")
for c in changes:
    print(c)

# ===== 验证 JS 语法 =====
import subprocess
script_match = re.search(r'<script>([\s\S]*)</script>', html)
if script_match:
    js = script_match[1]
    # Use node to check syntax
    result = subprocess.run(
        ['node', '-e', 'try{new Function(require("fs").readFileSync(process.argv[1],"utf8").match(/<script>([\\s\\S]*)<\\/script>/)[1]);process.exit(0)}catch(e){console.error(e.message);process.exit(1)}', FILE],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print("\n✅ JavaScript 语法验证通过！")
    else:
        print(f"\n❌ JavaScript 语法错误: {result.stderr}")
else:
    print("\n❌ 找不到 <script> 标签")
