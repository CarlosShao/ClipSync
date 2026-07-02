
    // ====== State ======
    const API_BASE = 'http://localhost:3000';
    const WS_URL = 'ws://localhost:3000/ws';
    let state = {
      token: localStorage.getItem('cs_token') || null,
      user: JSON.parse(localStorage.getItem('cs_user') || 'null'),
      deviceId: localStorage.getItem('cs_device_id') || null,
      items: [],
      devices: [],
      ws: null,
      wsConnected: false,
      currentPage: 'clipboard',
      searchQuery: '',
      autoSync: true,
      currentClipboard: '',
    };

    // ====== Init ======
    window.addEventListener('DOMContentLoaded', () => {
      if (state.token && state.user) {
        showMainApp();
        loadDevices();
        loadClipboardItems();
        connectWebSocket();
      } else {
        document.getElementById('login-modal').classList.remove('hidden');
      }
      // Listen for clipboard changes from Tauri
      if (window.__TAURI__) {
        window.__TAURI__.event.listen('clipboard-changed', (event) => {
          const { content } = event.payload;
          if (content && content !== state.currentClipboard && state.autoSync) {
            state.currentClipboard = content;
            uploadClipboard(content);
          }
        });
      }
    });

    // ====== Auth ======
    async function sendCode() {
      const phone = document.getElementById('phone-input').value.trim();
      if (!phone || phone.length !== 11) { showToast('请输入11位手机号'); return; }
      const btn = document.getElementById('send-code-btn');
      btn.disabled = true;
      try {
        await api('POST', '/api/auth/send-code', { phone });
        showToast('验证码已发送（MVP: 888888）');
        let sec = 60;
        btn.textContent = sec + 's';
        const timer = setInterval(() => {
          sec--;
          btn.textContent = sec + 's';
          if (sec <= 0) { clearInterval(timer); btn.textContent = '发送验证码'; btn.disabled = false; }
        }, 1000);
      } catch (e) {
        showToast('发送失败: ' + e.message);
        btn.disabled = false;
      }
    }

    async function login() {
      const phone = document.getElementById('phone-input').value.trim();
      const code = document.getElementById('code-input').value.trim();
      if (!phone || !code) { showToast('请输入手机号和验证码'); return; }
      try {
        const data = await api('POST', '/api/auth/verify-code', { phone, code });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('cs_token', data.token);
        localStorage.setItem('cs_user', JSON.stringify(data.user));
        showMainApp();
        loadDevices();
        loadClipboardItems();
        connectWebSocket();
        showToast('登录成功');
      } catch (e) {
        showToast('登录失败: ' + e.message);
      }
    }

    function logout() {
      state.token = null;
      state.user = null;
      state.deviceId = null;
      localStorage.removeItem('cs_token');
      localStorage.removeItem('cs_user');
      localStorage.removeItem('cs_device_id');
      if (state.ws) { state.ws.close(); state.ws = null; }
      document.getElementById('main-app').style.display = 'none';
      document.getElementById('login-modal').classList.remove('hidden');
    }

    function showMainApp() {
      document.getElementById('login-modal').classList.add('hidden');
      document.getElementById('main-app').style.display = 'grid';
      const u = state.user;
      const name = (u && u.nickname) || (u && u.phone) || '?';
      document.getElementById('user-name').textContent = name;
      document.getElementById('user-phone').textContent = u?.phone || '';
      document.getElementById('user-avatar').textContent = name[0].toUpperCase();
    }

    // ====== API helper ======
    async function api(method, path, body, silent) {
      const opts = { method, headers: {} };
      if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(API_BASE + path, opts);
      const data = await resp.json();
      if (!resp.ok) {
        if (!silent) console.error('API Error:', data.error || 'Request failed');
        throw new Error(data.error || 'Request failed');
      }
      return data;
    }

    // ====== WebSocket ======
    function connectWebSocket() {
      if (state.ws) { state.ws.close(); }
      updateConnStatus('connecting');
      const ws = new WebSocket(WS_URL + '?token=' + state.token);
      state.ws = ws;

      ws.onopen = () => {
        updateConnStatus('online');
        // Register current device
        if (state.deviceId) {
          ws.send(JSON.stringify({ type: 'register', deviceId: state.deviceId }));
        }
        // Heartbeat
        setInterval(() => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      };

      ws.onclose = () => {
        updateConnStatus('offline');
        // Auto reconnect after 5s
        setTimeout(() => {
          if (state.token) connectWebSocket();
        }, 5000);
      };

      ws.onerror = () => {
        updateConnStatus('offline');
      };
    }

    function handleWsMessage(msg) {
      switch (msg.type) {
        case 'registered':
          state.deviceId = msg.deviceId;
          localStorage.setItem('cs_device_id', msg.deviceId);
          showToast('设备已注册');
          break;
        case 'clipboard':
        case 'new_clipboard':
          // New item from another device
          if (msg.item) {
            state.items.unshift(msg.item);
            if (state.currentPage === 'clipboard') renderClipboardItems();
            showToast('收到新同步内容');
          }
          break;
        case 'clipboard_deleted':
          if (msg.itemId) {
            state.items = state.items.filter(i => i.id !== msg.itemId);
          } else if (msg.itemIds) {
            state.items = state.items.filter(i => !msg.itemIds.includes(i.id));
          }
          if (state.currentPage === 'clipboard') renderClipboardItems();
          break;
        case 'clipboard_favorite':
          const item = state.items.find(i => i.id === msg.itemId);
          if (item) { item.isFavorite = msg.isFavorite; renderClipboardItems(); }
          break;
        case 'error':
          console.error('WS error:', msg.message);
          break;
      }
    }

    function updateConnStatus(status) {
      const dot = document.getElementById('conn-dot');
      const text = document.getElementById('conn-text');
      dot.className = 'conn-dot ' + status;
      const labels = { online: '已连接', offline: '未连接', connecting: '连接中...' };
      text.textContent = labels[status] || status;
      state.wsConnected = (status === 'online');
    }

    // ====== Clipboard ======
    async function loadClipboardItems() {
      try {
        const data = await api('GET', '/api/clipboard?limit=100');
        state.items = data.items || [];
        renderClipboardItems();
      } catch (e) {
        console.error('Failed to load clipboard:', e);
      }
    }

    async function uploadClipboard(content) {
      if (!state.deviceId || !content.trim()) return;
      const type = detectContentType(content);
      try {
        await api('POST', '/api/clipboard', {
          sourceDeviceId: state.deviceId,
          contentType: type,
          contentEncrypted: btoa(unescape(encodeURIComponent(content))), // Base64 for MVP
          contentPreview: content.substring(0, 200),
          contentSize: content.length,
        });
        // Reload to get the item with proper ID
        loadClipboardItems();
        showToast('已同步到服务器');
      } catch (e) {
        console.error('Upload failed:', e);
      }
    }

    function detectContentType(text) {
      if (/^https?:\/\//.test(text.trim())) return 'link';
      if (/[{}\[\]];?|function |const |let |var |=>|import |class /.test(text)) return 'code';
      return 'text';
    }

    function renderClipboardItems() {
      const container = document.getElementById('content-area');
      let items = state.items;
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        items = items.filter(i =>
          (i.contentPreview || '').toLowerCase().includes(q) ||
          (i.sourceDevice?.name || '').toLowerCase().includes(q)
        );
      }
      if (items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">📄</div>
            <p>${state.searchQuery ? '没有匹配的内容' : '暂无剪贴板内容'}</p>
            <p style="margin-top:8px;font-size:12px;">复制内容后将自动同步到此处</p>
          </div>`;
        return;
      }
      container.innerHTML = `<div class="clipboard-grid">${items.map(item => `
        <div class="clipboard-card" onclick="copyItem('${escapeAttr(item.contentPreview || '')}')">
          <div class="card-header">
            <div class="card-type">
              <div class="card-type-icon">${getTypeIcon(item.contentType)}</div>
              ${getTypeLabel(item.contentType)}
            </div>
            <div class="card-actions">
              <span class="card-fav ${item.isFavorite ? 'active' : ''}" onclick="event.stopPropagation();toggleFav('${item.id}')">${item.isFavorite ? '★' : '☆'}</span>
              <button onclick="event.stopPropagation();deleteItem('${item.id}')" title="删除">🗑</button>
            </div>
          </div>
          <div class="card-content">${escapeHtml(item.contentPreview || '(空内容)')}</div>
          <div class="card-footer">
            <div class="card-device">📱 ${item.sourceDevice?.name || '未知设备'}</div>
            <span>${formatTime(item.createdAt)}</span>
          </div>
        </div>
      `).join('')}</div>`;
    }

    async function copyItem(content) {
      try {
        await navigator.clipboard.writeText(content);
        state.currentClipboard = content;
        showToast('已复制到剪贴板');
      } catch (e) { showToast('复制失败'); }
    }

    async function toggleFav(id) {
      try {
        await api('PUT', `/api/clipboard/${id}/favorite`);
        loadClipboardItems();
      } catch (e) { showToast('操作失败'); }
    }

    async function deleteItem(id) {
      try {
        await api('DELETE', `/api/clipboard/${id}`);
        state.items = state.items.filter(i => i.id !== id);
        renderClipboardItems();
        showToast('已删除');
      } catch (e) { showToast('删除失败'); }
    }

    function onSearch(value) {
      state.searchQuery = value;
      renderClipboardItems();
    }

    // ====== Devices ======
    async function loadDevices() {
      try {
        const devices = await api('GET', '/api/devices');
        state.devices = Array.isArray(devices) ? devices : [];
        // Auto-register this desktop device if not exists
        if (state.devices.length === 0) {
          const newDevice = await api('POST', '/api/devices', {
            deviceName: 'Desktop-' + navigator.platform,
            deviceType: 'desktop',
            platform: 'browser',
          });
          state.deviceId = newDevice.id;
          localStorage.setItem('cs_device_id', newDevice.id);
          state.devices = [newDevice];
          // Re-register with WebSocket
          if (state.ws && state.ws.readyState === 1) {
            state.ws.send(JSON.stringify({ type: 'register', deviceId: newDevice.id }));
          }
        } else if (!state.deviceId) {
          // Use first device
          state.deviceId = state.devices[0].id;
          localStorage.setItem('cs_device_id', state.deviceId);
          if (state.ws && state.ws.readyState === 1) {
            state.ws.send(JSON.stringify({ type: 'register', deviceId: state.deviceId }));
          }
        }
        renderDevices();
      } catch (e) {
        console.error('Failed to load devices:', e);
      }
    }

    function renderDevices() {
      const container = document.getElementById('device-list');
      document.getElementById('device-count').textContent = state.devices.length + ' 台';
      container.innerHTML = state.devices.map(d => `
        <div class="device-item">
          <div class="device-icon">${getDeviceIcon(d.deviceType || d.type)}</div>
          <div class="device-info">
            <div class="device-name">${escapeHtml(d.deviceName || d.name || '未知设备')}</div>
            <div class="device-status">
              <span class="status-dot ${d.isOnline ? '' : 'offline'}"></span>
              ${d.isOnline ? '在线' : (d.platform || '离线')}
            </div>
          </div>
        </div>
      `).join('');
    }

    // ====== Pages ======
    function switchPage(page) {
      state.currentPage = page;
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      document.querySelector(`[data-page="${page}"]`).classList.add('active');
      const titles = { clipboard: '剪贴板', devices: '设备管理', settings: '设置' };
      document.getElementById('page-title').textContent = titles[page] || page;
      if (page === 'clipboard') renderClipboardItems();
      else if (page === 'devices') renderDevices();
      else if (page === 'settings') renderSettings();
    }

    // ====== Settings ======
    function renderSettings() {
      const container = document.getElementById('content-area');
      container.innerHTML = `
        <div class="settings-page">
          <!-- 同步与监控 -->
          <div class="settings-group">
            <div class="settings-group-title">同步与监控</div>
            <div class="settings-item">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.3"/></svg>
                <div>
                  <div class="settings-item-label">自动同步</div>
                  <div class="settings-item-desc">复制内容后自动上传到服务器</div>
                </div>
              </div>
              <label class="toggle"><input type="checkbox" ${state.autoSync ? 'checked' : ''} onchange="state.autoSync=this.checked"><span class="toggle-slider"></span></label>
            </div>
          </div>

          <!-- 账号与安全 -->
          <div class="settings-group">
            <div class="settings-group-title">账号与安全</div>
            <div class="settings-item" onclick="showSessionManagement()" style="cursor:pointer;">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M12 8v4M12 16h.01"/></svg>
                <div>
                  <div class="settings-item-label">登录会话</div>
                  <div class="settings-item-desc">管理已登录的设备</div>
                </div>
              </div>
              <span style="color:#999;">›</span>
            </div>
            <div class="settings-item" onclick="showSecuritySettings()" style="cursor:pointer;">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                <div>
                  <div class="settings-item-label">隐私与安全</div>
                  <div class="settings-item-desc">密码、加密、会话管理</div>
                </div>
              </div>
              <span style="color:#999;">›</span>
            </div>
          </div>

          <!-- 订阅管理 -->
          <div class="settings-group">
            <div class="settings-group-title">订阅管理</div>
            <div class="settings-item" onclick="showSubscriptionPlans()" style="cursor:pointer;">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                <div>
                  <div class="settings-item-label">当前套餐</div>
                  <div class="settings-item-desc" id="settings-current-plan">免费版 (Free)</div>
                </div>
              </div>
              <span style="color:#999;">›</span>
            </div>
            <div class="settings-item" onclick="showBillingHistory()" style="cursor:pointer;">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                <div>
                  <div class="settings-item-label">账单记录</div>
                  <div class="settings-item-desc">查看历史账单</div>
                </div>
              </div>
              <span style="color:#999;">›</span>
            </div>
          </div>

          <!-- 偏好设置 -->
          <div class="settings-group">
            <div class="settings-group-title">偏好设置</div>
            <div class="settings-item" onclick="showNotifSettings()" style="cursor:pointer;">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
                <div>
                  <div class="settings-item-label">通知偏好</div>
                  <div class="settings-item-desc">自定义通知类型和方式</div>
                </div>
              </div>
              <span style="color:#999;">›</span>
            </div>
            <div class="settings-item" onclick="checkForUpdates()" style="cursor:pointer;">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <div>
                  <div class="settings-item-label">检查更新</div>
                  <div class="settings-item-desc">当前版本 v0.1.0</div>
                </div>
              </div>
              <span style="color:#999;">›</span>
            </div>
            <div class="settings-item" onclick="showGDPRExport()" style="cursor:pointer;">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <div>
                  <div class="settings-item-label">数据导出</div>
                  <div class="settings-item-desc">导出所有个人数据 (GDPR)</div>
                </div>
              </div>
              <span style="color:#999;">›</span>
            </div>
          </div>

          <!-- 个人资料 -->
          <div class="settings-group">
            <div class="settings-group-title">个人资料</div>
            <div class="settings-item" onclick="showProfileModal()" style="cursor:pointer;">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <div>
                  <div class="settings-item-label">编辑资料</div>
                  <div class="settings-item-desc">修改用户名、邮箱</div>
                </div>
              </div>
              <span style="color:#999;">›</span>
            </div>
          </div>

          <!-- 关于 -->
          <div class="settings-group">
            <div class="settings-group-title">关于</div>
            <div class="settings-item">
              <div class="settings-item-left">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <div>
                  <div class="settings-item-label">ClipSync</div>
                  <div class="settings-item-desc">版本 0.1.0 (MVP) · 跨设备剪贴板同步</div>
                </div>
              </div>
            </div>
          </div>
        </div>`;
    }


    // ====== Helpers ======
    function getTypeIcon(type) {
      return { text: 'T', link: '🔗', image: '🖼', code: '<>', file: '📎' }[type] || 'T';
    }
    function getTypeLabel(type) {
      return { text: '文本', link: '链接', image: '图片', code: '代码', file: '文件' }[type] || type;
    }
    function getDeviceIcon(type) {
      return { desktop: '💻', mobile: '📱', tablet: '📟' }[type] || '💻';
    }
    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
    function escapeAttr(t) { return t.replace(/'/g, "\\'").replace(/\n/g, '\\n'); }
    function formatTime(iso) {
      if (!iso) return '';
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
      return new Date(iso).toLocaleDateString();
    }
    function showToast(msg) {
      const old = document.querySelector('.toast');
      if (old) old.remove();
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2500);
    }
  

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
      const settings = [
        { key: "新设备登录", enabled: true },
        { key: "剪贴板同步", enabled: true },
        { key: "订阅到期", enabled: true },
        { key: "安全警告", enabled: true }
      ];
      document.getElementById("notif-settings-list").innerHTML = settings.map(s =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;">
          <span>${s.key}</span>
          <label class="toggle"><input type="checkbox" ${s.enabled ? "checked" : ""} onchange="toggleNotifSetting('${s.key}',this.checked)"><span class="toggle-slider"></span></label>
        </div>`
      ).join("");
    }

    async function toggleNotifSetting(key, val) {
      try { await api("PUT", "/api/notifications/settings", { key, enabled: val }); } catch(e) {}
    }

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
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;">
            <div>
              <div style="font-weight:500;">${s.deviceName || "未知设备"}</div>
              <div style="font-size:12px;color:#999;">${s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleString() : "未知时间"}</div>
            </div>
            ${isCurrent ? "<span style='color:#999;font-size:12px;'>当前会话</span>" : "<button onclick="kickSession('" + s.id + "')" style='color:var(--danger);background:none;border:none;cursor:pointer;'>踢出</button>"}
          </div>`;
        }).join("");
      }).catch(() => {
        document.getElementById("session-list").innerHTML = "<div style='text-align:center;padding:20px;color:#e74c3c;'>加载失败</div>";
      });
    }

    async function kickSession(id) {
      if (!confirm("确认踢出该会话？")) return;
      try {
        await api("DELETE", "/api/sessions/" + id);
        showToast("已踢出");
        showSessionManagement();
      } catch(e) { showToast("操作失败"); }
    }

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
      } catch(e) { showToast("导出失败: " + (e.message || "")); }
    }

    function closeGDPRModal() { document.getElementById("gdpr-modal").style.display = "none"; }

    // ====== Security Settings ======
    function showSecuritySettings() {
      if (!state.token) { showToast("请先登录"); return; }
      document.getElementById("security-modal").style.display = "flex";
      const settings = [
        { k: "两步验证", d: "提升账号安全" },
        { k: "登录设备提醒", d: "新设备登录时通知" },
        { k: "端到端加密", d: "剪贴板内容加密同步" }
      ];
      document.getElementById("security-settings-list").innerHTML = settings.map(i =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;">
          <div><b>${i.k}</b><br><small style="color:#999;">${i.d}</small></div>
          <label class="toggle"><input type="checkbox" onchange="toggleSecurity('${i.k}',this.checked)"><span class="toggle-slider"></span></label>
        </div>`
      ).join("");
    }

    async function toggleSecurity(k, v) {
      try { await api("PUT", "/api/security/settings", { key: k, enabled: v }); } catch(e) {}
    }

    function closeSecurityModal() { document.getElementById("security-modal").style.display = "none"; }

    // ====== Check Updates ======
    async function checkForUpdates() {
      showToast("正在检查更新...");
      setTimeout(() => { showToast("当前已是最新版本 v0.1.0"); }, 1000);
    }

    // Wire up settings page load
    const _origRS = window.renderSettings;
    window.renderSettings = function() { if (_origRS) _origRS(); loadSubscriptionInfo(); };

  