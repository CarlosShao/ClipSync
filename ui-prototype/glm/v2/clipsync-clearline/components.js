/* components.js — v2 共享运行时：图标注入 / 主题 / 导航激活 / AI Dock（全局感知）/ toast / 通知 / 命令面板 */

/* ---------- Lucide 内联 SVG 图标库（stroke 规格统一） ---------- */
const ICONS = {
  'clipboard-list':'<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  'star':'<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  'layout-template':'<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>',
  'laptop':'<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  'smartphone':'<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  'monitor':'<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  'sparkles':'<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  'settings-2':'<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  'bell':'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'moon':'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  'sun':'<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  'minus':'<path d="M5 12h14"/>',
  'square':'<rect width="18" height="18" x="3" y="3" rx="2"/>',
  'x':'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'search':'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'panel-top':'<rect width="18" height="18" x="3" y="3" rx="2"/><line x1="3" x2="21" y1="9" y2="9"/>',
  'pin':'<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  'copy':'<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'trash-2':'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  'check':'<path d="M20 6 9 17l-5-5"/>',
  'link-2':'<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  'image':'<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  'file-text':'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  'code-2':'<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  'file':'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  'clock':'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'refresh-cw':'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  'qrcode':'<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  'plus':'<path d="M5 12h14"/><path d="M12 5v14"/>',
  'send':'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  'brain':'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/>',
  'zap':'<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  'chevron-down':'<path d="m6 9 6 6 6-6"/>',
  'chevron-right':'<path d="m9 18 6-6-6-6"/>',
  'more-horizontal':'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'shield':'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  'info':'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'alert-triangle':'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'arrow-right':'<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'keyboard':'<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  'history':'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  'message-square':'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'folder':'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'command':'<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>',
  'loader':'<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  'pencil':'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'circle-check':'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'type':'<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  'hash':'<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  'download':'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  'eye':'<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'user':'<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'bot':'<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  'wrench':'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  'terminal':'<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  'gauge':'<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  'corner-down-left':'<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  'wifi':'<path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" x2="12.01" y1="20" y2="20"/>',
  /* 补丁：设备扫码 / 设置页新分类 / 数据管理 所需图标 */
  'scan-line':'<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  'camera':'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  'palette':'<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  'database':'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  'credit-card':'<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
  'variable':'<path d="M8 21s-4-3-4-9 4-9 4-9"/><path d="M16 3s4 3 4 9-4 9-4 9"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/>',
  'upload':'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  /* v2 补丁：收藏标签 / 归档 / 恢复（剪贴板归档视图与收藏标签体系使用） */
  'tag':'<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  'archive':'<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  'archive-restore':'<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5"/><path d="M12 11v5"/>',
};

function iconSvg(name, size = 16, stroke = 1.75) {
  const body = ICONS[name] || ICONS['info'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-ic]').forEach(el => {
    const size = el.dataset.size ? +el.dataset.size : 16;
    el.outerHTML = iconSvg(el.dataset.ic, size);
  });
}

/* ---------- 主题（localStorage cl-theme，默认浅色） ---------- */
function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
  document.documentElement.classList.toggle('dark', t !== 'light');
  localStorage.setItem('cl-theme', t);
  const ic = document.querySelector('#themeBtn svg');
  if (ic) ic.outerHTML = iconSvg(t === 'light' ? 'moon' : 'sun', 16);
}
function initTheme() { applyTheme(localStorage.getItem('cl-theme') || 'light'); }

/* ---------- 外观偏好（设置页「外观」卡持久化到 cl-appearance，全局生效） ---------- */
function initAppearance() {
  try {
    const a = JSON.parse(localStorage.getItem('cl-appearance') || '{}');
    if (a.fontScale) document.body.style.fontSize = (13 * a.fontScale) + 'px';
    if (a.density === 'compact') document.documentElement.classList.add('compact');
  } catch (e) { /* 忽略损坏的持久化数据 */ }
}

/* ---------- 模板「记住此值」存取（模板页写入，设置页管理；key: cl-tpl-vars） ---------- */
function getTplVars() {
  try { return JSON.parse(localStorage.getItem('cl-tpl-vars') || '{}'); } catch (e) { return {}; }
}
function setTplVars(obj) { localStorage.setItem('cl-tpl-vars', JSON.stringify(obj || {})); }

/* ---------- Toast ---------- */
function toast(msg, type = '') {
  let root = document.getElementById('toastRoot');
  if (!root) { root = document.createElement('div'); root.id = 'toastRoot'; document.body.appendChild(root); }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = iconSvg(type === 'err' ? 'alert-triangle' : type === 'ok' ? 'circle-check' : 'check', 14) + '<span></span>';
  el.querySelector('span').textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2200);
}

/* ---------- Popover 通用 ---------- */
function closePops() { document.querySelectorAll('.pop').forEach(p => p.remove()); }
function openPop(anchor, html) {
  closePops();
  const pop = document.createElement('div');
  pop.className = 'pop'; pop.innerHTML = html;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  setTimeout(() => document.addEventListener('click', function h(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', h); }
  }), 0);
  return pop;
}

/* ---------- 通知中心 ---------- */
function renderBellPop(anchor) {
  const items = DB.notifications.map(n => {
    const ic = n.kind === 'sync' ? 'refresh-cw' : n.kind === 'ai' ? 'sparkles' : 'info';
    return `<div class="pop-item" style="opacity:${n.read ? .55 : 1}">${iconSvg(ic, 14)}
      <div class="grow"><div style="font-weight:600">${n.title}</div>
      <div class="dimmer" style="font-size:11px">${n.desc}</div></div>
      <span class="dimmer mono" style="font-size:10px;white-space:nowrap">${n.time}</span></div>`;
  }).join('');
  const pop = openPop(anchor, `
    <div style="padding:8px 10px;font-weight:600;font-size:12.5px;display:flex;align-items:center">通知
      <button class="btn-ghost btn btn-sm" style="margin-left:auto;height:24px" id="markRead">全部已读</button></div>
    <div class="pop-sep"></div>${items}`);
  pop.querySelector('#markRead').onclick = async () => { await markAllRead(); document.getElementById('bellDot')?.classList.remove('on'); pop.remove(); toast('通知已全部标为已读', 'ok'); };
}

/* ============================================================
   AI Dock · 全局感知面板（所有 shell 页自动注入，页面不手写）
   ============================================================ */
const AI_STATE = { open: false, busy: false, welcomed: false };

function pageKey() { return document.body.dataset.page || 'clipboard'; }
function pageLabel() { return DB.PAGE_LABEL[pageKey()] || '剪贴板'; }

function buildAiDock() {
  if (document.getElementById('aiDock')) return;
  const mask = document.createElement('div');
  mask.className = 'ai-mask'; mask.id = 'aiMask';
  mask.onclick = () => closeAiDock();

  const dock = document.createElement('aside');
  dock.className = 'ai-dock'; dock.id = 'aiDock';
  dock.innerHTML = `
    <div class="dock-head">
      <div class="row1">
        <span class="ttl">${iconSvg('sparkles', 15)}<span>AI 助手</span></span>
        <div class="acts">
          <button class="icon-btn" id="aiHistory" title="历史会话">${iconSvg('history', 15)}</button>
          <button class="icon-btn" id="aiUsage" title="用量与记忆">${iconSvg('gauge', 15)}</button>
          <button class="icon-btn" id="aiClose" title="关闭 · Esc">${iconSvg('x', 15)}</button>
        </div>
      </div>
      <div class="ctx-chip" id="ctxChip" title="AI 始终感知你所在的页面">
        <i class="dot"></i><span>当前上下文 · <b id="ctxName">${pageLabel()}</b></span>
        <span class="x">${iconSvg('eye', 12)}</span>
      </div>
    </div>
    <div class="dock-scroll" id="dockScroll"></div>
    <div class="composer">
      <div class="box">
        <textarea id="aiInput" rows="1" placeholder="基于「${pageLabel()}」页提问…"></textarea>
        <div class="bar2">
          <button class="model-sel" id="modelSel">${iconSvg('bot', 13)}<span>GPT-5.2</span>${iconSvg('chevron-down', 12)}</button>
          <button class="send-btn" id="aiSend" title="发送 · Enter">${iconSvg('send', 14)}</button>
        </div>
      </div>
      <div class="hint">Enter 发送 · Shift+Enter 换行 · AI 会携带当前页面上下文</div>
    </div>`;
  document.body.appendChild(mask);
  document.body.appendChild(dock);

  dock.querySelector('#aiClose').onclick = closeAiDock;
  dock.querySelector('#aiHistory').onclick = e => renderAiHistory(e.currentTarget);
  dock.querySelector('#aiUsage').onclick = e => renderAiUsage(e.currentTarget);
  dock.querySelector('#modelSel').onclick = () => toast('原型演示 · 模型选择由设置页托管');
  dock.querySelector('#aiSend').onclick = sendAiMsg;
  const input = dock.querySelector('#aiInput');
  input.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMsg(); }
  };
  input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
}

function openAiDock({ prefill = '', focus = true } = {}) {
  buildAiDock();
  const dock = document.getElementById('aiDock');
  const mask = document.getElementById('aiMask');
  /* 上下文 chip 始终刷新为当前页（dock 常驻，页面可能已切换） */
  document.getElementById('ctxName').textContent = pageLabel();
  document.getElementById('aiInput').placeholder = `基于「${pageLabel()}」页提问…`;
  if (prefill) { const ta = document.getElementById('aiInput'); ta.value = prefill; ta.dispatchEvent(new Event('input')); }
  if (!AI_STATE.open) {
    AI_STATE.open = true;
    requestAnimationFrame(() => { dock.classList.add('open'); mask.classList.add('open'); });
    document.getElementById('aiBtn')?.classList.add('open');
    if (!AI_STATE.welcomed) { AI_STATE.welcomed = true; renderWelcome(); }
  }
  if (focus) setTimeout(() => document.getElementById('aiInput')?.focus(), 120);
}
function closeAiDock() {
  const dock = document.getElementById('aiDock'); if (!dock) return;
  AI_STATE.open = false;
  dock.classList.remove('open');
  document.getElementById('aiMask')?.classList.remove('open');
  document.getElementById('aiBtn')?.classList.remove('open');
}
function toggleAiDock() { AI_STATE.open ? closeAiDock() : openAiDock(); }

function renderWelcome() {
  const sc = document.getElementById('dockScroll');
  const el = document.createElement('div');
  el.className = 'dock-welcome';
  el.innerHTML = `我是全局常驻的 AI 助手，<b>始终感知你所在的页面</b>。当前你在 <b>${pageLabel()}</b> 页——直接问「当前是什么页面」试试；切到别的页面再问我，答案会跟着变。`;
  sc.appendChild(el);
}

/* 各业务页"原位 AI"按钮：data-ai="动作名" → 打开 dock 并预填 */
function wireInlineAi(root = document) {
  root.querySelectorAll('[data-ai]').forEach(btn => {
    if (btn.dataset.aiWired) return;
    btn.dataset.aiWired = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const action = btn.dataset.ai;
      const target = btn.dataset.aiTarget || '';
      openAiDock({ prefill: target ? `${action}：${target}` : `${action}当前${pageLabel()}页的选中内容` });
    });
  });
}

async function sendAiMsg() {
  if (AI_STATE.busy) return;
  const ta = document.getElementById('aiInput');
  const text = ta.value.trim(); if (!text) return;
  AI_STATE.busy = true;
  ta.value = ''; ta.dispatchEvent(new Event('input'));
  const sc = document.getElementById('dockScroll');
  sc.querySelector('.dock-welcome')?.remove();

  /* 用户气泡 */
  const um = document.createElement('div');
  um.className = 'msg user';
  um.innerHTML = `<div class="ava">${DB.user.initials}</div><div class="bub">${esc(text)}</div>`;
  sc.appendChild(um);

  /* AI 气泡骨架 */
  const am = document.createElement('div');
  am.className = 'msg ai';
  am.innerHTML = `<div class="ava">${iconSvg('sparkles', 13)}</div><div class="bub"></div>`;
  sc.appendChild(am);
  const bub = am.querySelector('.bub');
  sc.scrollTop = sc.scrollHeight;

  /* 页面感知类问题走轻量问答流；其余一律走完整 Agent 流（thinking→工具→确认→再思考→正文→封段） */
  const isPageQuery = /当前|哪个|什么页面|这页|在哪|哪儿|这个页面/.test(text);
  if (isPageQuery) {
    const stream = document.createElement('span');
    bub.appendChild(stream);
    await askAI(text, chunk => { stream.textContent = chunk; sc.scrollTop = sc.scrollHeight; }, { pageKey: pageKey() });
    AI_STATE.busy = false;
    return;
  }
  await runAgentFlow(bub, sc, text);
  AI_STATE.busy = false;
}

/* Agent 流渲染：thinking 流入 → 工具时间线 → 三级确认门控(Esc=拒绝) → 封段再思考 → 正文流入 → 过程 chips 收尾 */
async function runAgentFlow(bub, sc, text) {
  /* ① thinking 块（流入时展开，正文开始时自动折叠——工作细节让位给结果） */
  const think = document.createElement('details');
  think.className = 'think live'; think.open = true;
  think.innerHTML = `<summary>${iconSvg('brain', 12)}<span>思考过程</span><span class="live-dot"></span>${iconSvg('chevron-right', 12)}</summary><div class="tt"></div>`;
  bub.appendChild(think);
  const tt = think.querySelector('.tt');

  const toolWrap = document.createElement('div');
  toolWrap.className = 'toolwrap';
  let toolWrapMounted = false;
  const toolEls = new Map();

  await askAgent(text, {
    onThinking: (t, done) => {
      tt.textContent = t;
      if (done) { think.classList.remove('live'); think.querySelector('.live-dot')?.remove(); }
      sc.scrollTop = sc.scrollHeight;
    },
    onToolCall: (tool) => {
      if (!toolWrapMounted) { bub.appendChild(toolWrap); toolWrapMounted = true; }
      const el = document.createElement('div');
      el.className = 'toolline running';
      el.innerHTML = `${iconSvg(tool.icon, 12)}<span class="grow">${esc(tool.name)}</span><span class="st run">${iconSvg('loader', 11)} 执行中</span>`;
      toolWrap.appendChild(el);
      toolEls.set(tool.name, el);
      sc.scrollTop = sc.scrollHeight;
    },
    onToolDone: (name, ttime) => {
      const el = toolEls.get(name); if (!el) return;
      el.classList.remove('running'); el.classList.add('done');
      el.querySelector('.st').outerHTML = `<span class="st ok">${iconSvg('check', 11)} ${ttime}</span>`;
      sc.scrollTop = sc.scrollHeight;
    },
    /* ③ 破坏性工具确认门控：Promise 挂起，按钮/Esc 三级裁决 */
    onConfirmRequired: (tool) => new Promise(resolve => {
      const el = toolEls.get(tool.name);
      if (el) el.querySelector('.st').outerHTML = `<span class="st wait">${iconSvg('clock', 11)} 等待确认</span>`;
      const card = document.createElement('div');
      card.className = 'confirm-card';
      card.innerHTML = `
        <div class="ct">${iconSvg('alert-triangle', 13)}<span class="grow">待确认 · ${esc(tool.name)}</span><kbd class="esc-hint">Esc 拒绝</kbd></div>
        <div class="cd">${esc(tool.impact)}</div>
        <div class="ca">${esc(tool.args)}</div>
        <div class="cf">
          <button class="btn btn-sm" data-act="deny">拒绝</button>
          <button class="btn btn-acc btn-sm" data-act="once">仅本次允许</button>
          <button class="btn btn-acc btn-sm cf-more" data-act="menu" title="更多批准策略">${iconSvg('chevron-down', 12)}</button>
        </div>`;
      bub.appendChild(card);
      sc.scrollTop = sc.scrollHeight;
      const finish = (allow, scope) => {
        AI_STATE.pendingConfirm = null;
        const scopeTxt = scope === 'tool' ? '已允许 · 信任此工具' : scope === 'all' ? '已允许 · 全部' : '已允许 · 仅本次';
        card.querySelector('.cf').innerHTML = `<span class="badge ${allow ? 'b-ok' : 'b-gray'}">${allow ? scopeTxt : '已拒绝'}</span>`;
        if (!allow && el) {
          el.classList.remove('running'); el.classList.add('denied');
          el.querySelector('.st').outerHTML = `<span class="st deny">${iconSvg('x', 11)} 已拒绝</span>`;
        }
        resolveConfirm('cf-' + Date.now(), allow, scope);
        resolve({ allow, scope });
      };
      AI_STATE.pendingConfirm = () => finish(false, 'once');
      card.querySelector('[data-act="deny"]').onclick = () => finish(false, 'once');
      card.querySelector('[data-act="once"]').onclick = () => finish(true, 'once');
      card.querySelector('[data-act="menu"]').onclick = (e) => {
        e.stopPropagation();
        const pop = openPop(e.currentTarget, `
          <div class="pop-item" data-scope="tool">${iconSvg('wrench', 14)}<div class="grow"><div style="font-weight:500">信任此工具</div><div class="dimmer" style="font-size:10.5px">本会话内该工具不再询问</div></div></div>
          <div class="pop-item" data-scope="all">${iconSvg('shield', 14)}<div class="grow"><div style="font-weight:500">全部允许</div><div class="dimmer" style="font-size:10.5px">本会话内所有工具不再询问</div></div></div>`);
        pop.querySelectorAll('.pop-item').forEach(it => it.onclick = () => { pop.remove(); finish(true, it.dataset.scope); });
      };
    }),
    /* ④ 二次思考：追加进同一 thinking 块 */
    onThinkingAgain: (t2) => {
      think.open = true;
      tt.textContent = tt.textContent + '\n\n' + t2;
      sc.scrollTop = sc.scrollHeight;
    },
    /* ⑤ 正文流入（开始时折叠 thinking） */
    onContent: (chunk) => {
      let stream = bub.querySelector('.stream');
      if (!stream) {
        think.open = false;
        stream = document.createElement('div');
        stream.className = 'stream';
        bub.appendChild(stream);
      }
      stream.textContent = chunk;
      sc.scrollTop = sc.scrollHeight;
    },
    /* ⑥ 封段：过程 chips（时长 / 思考耗时 / 工具数 / 批准策略） */
    onDone: (stats) => {
      const chips = document.createElement('div');
      chips.className = 'proc-chips';
      const scopeTxt = !stats.approved ? '写操作已拒绝'
        : stats.scope === 'tool' ? '批准 · 信任工具'
        : stats.scope === 'all' ? '批准 · 全部' : '批准 · 仅本次';
      chips.innerHTML = `
        <span class="pc">${iconSvg('clock', 11)} ${stats.duration}</span>
        <span class="pc">${iconSvg('brain', 11)} 思考 ${(stats.thinkMs / 1000).toFixed(1)}s</span>
        <span class="pc">${iconSvg('wrench', 11)} 工具 ${stats.toolCount} 个</span>
        <span class="pc ${stats.approved ? 'ok' : 'deny'}">${iconSvg(stats.approved ? 'shield' : 'x', 11)} ${scopeTxt}</span>`;
      bub.appendChild(chips);
      sc.scrollTop = sc.scrollHeight;
    },
  }, { pageKey: pageKey() });
}

function renderAiHistory(anchor) {
  const items = DB.convos.map(c => `
    <div class="pop-item" data-cid="${c.id}">${iconSvg('message-square', 14)}
      <div class="grow"><div style="font-weight:500">${c.title}</div>
      <div class="dimmer" style="font-size:10.5px">${c.model} · ${c.count} 条</div></div>
      <span class="dimmer mono" style="font-size:10px">${c.time}</span></div>`).join('');
  const pop = openPop(anchor, `<div style="padding:8px 10px;font-weight:600;font-size:12.5px">历史会话</div><div class="pop-sep"></div>${items}`);
  pop.querySelectorAll('.pop-item').forEach(el => el.onclick = async () => {
    pop.remove();
    const { data: msgs } = await fetchMessages(el.dataset.cid);
    const sc = document.getElementById('dockScroll');
    sc.innerHTML = '';
    msgs.forEach(m => sc.appendChild(renderMsg(m)));
    sc.scrollTop = 0;
    toast('已载入历史会话');
  });
}

function renderAiUsage(anchor) {
  const u = DB.usage;
  const pct = u.used / u.total;
  const mems = DB.memories.map(m => `
    <div class="pop-item" style="cursor:default">${iconSvg('brain', 13)}
      <div class="grow"><div style="font-weight:600;font-size:11.5px">${m.key}</div>
      <div class="dimmer" style="font-size:10.5px">${m.value}</div></div></div>`).join('');
  openPop(anchor, `
    <div style="padding:10px 12px;display:flex;align-items:center;gap:12px">
      <div class="ring" style="width:44px;height:44px">${ringSvg(pct)}</div>
      <div><div style="font-weight:600;font-size:12.5px">${u.model} · 本月用量</div>
      <div class="dimmer mono" style="font-size:10.5px">${u.used.toLocaleString()} / ${u.total.toLocaleString()} tokens · 缓存命中 ${u.cacheHit}%</div></div>
    </div>
    <div class="pop-sep"></div>
    <div style="padding:6px 10px 2px;font-weight:600;font-size:11.5px" class="dimmer">长期记忆</div>${mems}`);
}

/* 渲染一条消息（历史会话载入用；含 think/tool/confirm） */
function renderMsg(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  const ava = m.role === 'user' ? `<div class="ava">${DB.user.initials}</div>` : `<div class="ava">${iconSvg('sparkles', 13)}</div>`;
  let inner = '';
  if (m.quote) inner += `<div class="quote">${esc(m.quote)}</div>`;
  if (m.think) inner += `<details class="think"><summary>${iconSvg('brain', 12)}<span>思考过程</span>${iconSvg('chevron-right', 12)}</summary><div class="tt">${esc(m.think)}</div></details>`;
  if (m.tools) inner += m.tools.map(t => `<div class="toolline">${iconSvg(t.icon, 12)}<span>${t.name}</span><span class="st ${t.state}">${t.state === 'done' ? iconSvg('check', 11) + ' ' + t.tt : t.tt}</span></div>`).join('');
  if (m.confirm) inner += `
    <div class="confirm-card" data-cf="${m.confirm.id}">
      <div class="ct">${iconSvg('alert-triangle', 13)}<span>待确认 · ${m.confirm.tool}</span></div>
      <div class="cd">${esc(m.confirm.impact)}</div>
      <div class="ca">${esc(m.confirm.args)}</div>
      <div class="cf"><button class="btn btn-acc btn-sm" data-allow="1">允许执行</button><button class="btn btn-sm" data-allow="0">拒绝</button></div>
    </div>`;
  inner += m.html || (m.text ? esc(m.text) : '');
  el.innerHTML = ava + `<div class="bub">${inner}</div>`;
  el.querySelectorAll('.confirm-card [data-allow]').forEach(b => b.onclick = async () => {
    const card = b.closest('.confirm-card');
    await resolveConfirm(card.dataset.cf, b.dataset.allow === '1');
    card.querySelector('.cf').innerHTML = `<span class="badge ${b.dataset.allow === '1' ? 'b-ok' : 'b-gray'}">${b.dataset.allow === '1' ? '已允许' : '已拒绝'}</span>`;
    toast(b.dataset.allow === '1' ? '已批准执行' : '已拒绝该操作', b.dataset.allow === '1' ? 'ok' : '');
  });
  return el;
}

/* ---------- 命令面板（Ctrl+K）—— 注意：导航只有 5 项，AI 是 dock 不是页 ---------- */
const CMDS = [
  { icon: 'clipboard-list', label: '前往 · 剪贴板', href: 'index.html' },
  { icon: 'star', label: '前往 · 收藏', href: 'favorites.html' },
  { icon: 'layout-template', label: '前往 · 模板', href: 'templates.html' },
  { icon: 'laptop', label: '前往 · 设备', href: 'devices.html' },
  { icon: 'settings-2', label: '前往 · 设置', href: 'settings.html' },
  { icon: 'sparkles', label: '呼出 · AI 助手面板（感知当前页）', act: () => openAiDock() },
  { icon: 'panel-top', label: '预览 · 快速粘贴面板', href: 'quickpaste.html', blank: true },
  { icon: 'moon', label: '切换 · 明暗主题', act: () => { const t = localStorage.getItem('cl-theme') === 'light' ? 'dark' : 'light'; applyTheme(t); } },
];
function openCmdk() {
  if (document.getElementById('cmdkMask')) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask'; mask.id = 'cmdkMask';
  mask.innerHTML = `<div class="modal" style="width:min(520px,92vw);padding:0;overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--border-sub)">
      ${iconSvg('command', 15)}<input id="cmdkInput" placeholder="输入命令或搜索…" style="flex:1;border:none;background:none;font-size:13.5px;color:var(--text-1);outline:none">
      <kbd>Esc</kbd></div>
    <div id="cmdkList" style="max-height:320px;overflow-y:auto;padding:6px"></div></div>`;
  document.body.appendChild(mask);
  const input = mask.querySelector('#cmdkInput'), list = mask.querySelector('#cmdkList');
  const render = q => {
    const hits = CMDS.filter(c => !q || c.label.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = hits.map((c, i) => `<div class="pop-item" data-i="${CMDS.indexOf(c)}">${iconSvg(c.icon, 15)}<span class="grow">${c.label}</span>${i === 0 ? '<kbd>↵</kbd>' : ''}</div>`).join('')
      || '<div style="padding:16px;text-align:center" class="dimmer">无匹配命令</div>';
    list.querySelectorAll('.pop-item').forEach(el => el.onclick = () => run(CMDS[+el.dataset.i]));
  };
  const run = c => { mask.remove(); if (c.act) c.act(); else if (c.blank) window.open(c.href, '_blank'); else location.href = c.href; };
  input.oninput = () => render(input.value.trim());
  input.onkeydown = e => { if (e.key === 'Enter') { const q = input.value.trim(); const hit = CMDS.find(c => !q || c.label.toLowerCase().includes(q.toLowerCase())); if (hit) run(hit); } };
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  render(''); input.focus();
}

/* ---------- 共享启动 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initAppearance();
  hydrateIcons();

  /* 导航激活（body[data-page] → .nav-item.active） */
  const page = document.body.dataset.page;
  if (page) document.querySelectorAll(`.nav-item[data-nav="${page}"]`).forEach(a => a.classList.add('active'));

  /* 标题栏 */
  document.getElementById('themeBtn')?.addEventListener('click', () => {
    const next = localStorage.getItem('cl-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next); toast(next === 'light' ? '已切换 · 浅色（澄明白）' : '已切换 · 深色（柔黑）');
  });
  document.getElementById('bellBtn')?.addEventListener('click', e => {
    const btn = e.currentTarget;
    if (document.querySelector('.pop')) { closePops(); return; }
    renderBellPop(btn);
  });
  if (DB.notifications?.some(n => !n.read)) document.getElementById('bellDot')?.classList.add('on');
  document.getElementById('qpBtn')?.addEventListener('click', () => window.open('quickpaste.html', '_blank'));
  document.getElementById('cmdkBtn')?.addEventListener('click', openCmdk);
  document.getElementById('aiBtn')?.addEventListener('click', toggleAiDock);
  document.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => toast('原型演示 · 窗口控制由 Tauri 托管')));

  /* AI Dock：所有 shell 页注入骨架（quickpaste 等独立窗无 body[data-page] 时跳过） */
  if (page) buildAiDock();
  wireInlineAi();

  /* 全局快捷键 */
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); toggleAiDock(); }
    if (e.key === 'Escape') {
      /* 确认门控挂起时：Esc = 拒绝该工具（优先于关面板） */
      if (AI_STATE.pendingConfirm) { AI_STATE.pendingConfirm(); return; }
      closePops(); document.getElementById('cmdkMask')?.remove(); if (AI_STATE.open) closeAiDock();
    }
  });
});

/* ---------- 小工具 ---------- */
function ringSvg(pct) {
  const r = 22, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 52 52"><circle class="trk" cx="26" cy="26" r="${r}"/><circle class="val" cx="26" cy="26" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/></svg><span class="pct">${Math.round(pct * 100)}%</span>`;
}
const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
