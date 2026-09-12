/* components.js — 共享运行时：图标注入 / 主题 / 导航激活 / toast / 通知 / 命令面板 */

/* ---------- Lucide 内联 SVG 图标库（stroke 规格统一） ---------- */
const ICONS = {
  'scissors':'<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
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
  'check-check':'<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  'link-2':'<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  'image':'<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  'file-text':'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  'code-2':'<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  'file':'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  'clock':'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'refresh-cw':'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  'wifi':'<path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" x2="12.01" y1="20" y2="20"/>',
  'qrcode':'<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  'plus':'<path d="M5 12h14"/><path d="M12 5v14"/>',
  'send':'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  'paperclip':'<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  'brain':'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/>',
  'zap':'<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  'chevron-down':'<path d="m6 9 6 6 6-6"/>',
  'chevron-right':'<path d="m9 18 6-6-6-6"/>',
  'more-horizontal':'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'shield':'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  'shield-alert':'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  'database':'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  'info':'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'alert-triangle':'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'arrow-right':'<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'corner-down-left':'<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  'keyboard':'<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  'palette':'<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  'history':'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  'message-square':'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'folder':'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'filter':'<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  'command':'<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>',
  'loader':'<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  'pencil':'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'circle-check':'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'globe':'<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  'type':'<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  'hash':'<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  'download':'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  'gauge':'<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  'cpu':'<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  'archive':'<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  'tag':'<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
  'user':'<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'play':'<polygon points="6 3 20 12 6 21 6 3"/>',
  'bot':'<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  'wrench':'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  'terminal':'<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  'layers':'<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  'eye':'<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'hard-drive':'<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  'maximize-2':'<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
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

/* ---------- 主题（localStorage ib-theme） ---------- */
function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
  document.documentElement.classList.toggle('dark', t !== 'light');
  localStorage.setItem('ib-theme', t);
}
function initTheme() {
  applyTheme(localStorage.getItem('ib-theme') || 'dark');
}

/* ---------- Toast ---------- */
function toast(msg, type = '') {
  let root = document.getElementById('toastRoot');
  if (!root) { root = document.createElement('div'); root.id = 'toastRoot'; document.body.appendChild(root); }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = iconSvg(type === 'err' ? 'alert-triangle' : type === 'ok' ? 'circle-check' : 'check', 14) + '<span></span>';
  el.querySelector('span').textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 2200);
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
    <div style="padding:10px 12px;font-weight:600;font-size:12.5px;display:flex;align-items:center">通知
      <button class="btn-ghost btn btn-sm" style="margin-left:auto;height:24px" id="markRead">全部已读</button></div>
    <div class="pop-sep"></div>${items}`);
  pop.querySelector('#markRead').onclick = async () => { await markAllRead(); document.getElementById('bellDot')?.classList.remove('on'); pop.remove(); toast('通知已全部标为已读', 'ok'); };
}

/* ---------- 命令面板（Ctrl+K） ---------- */
const CMDS = [
  { icon: 'clipboard-list', label: '前往 · 剪贴板', href: 'index.html' },
  { icon: 'star', label: '前往 · 收藏', href: 'favorites.html' },
  { icon: 'layout-template', label: '前往 · 模板', href: 'templates.html' },
  { icon: 'laptop', label: '前往 · 设备', href: 'devices.html' },
  { icon: 'sparkles', label: '前往 · AI 助手', href: 'ai.html' },
  { icon: 'settings-2', label: '前往 · 设置', href: 'settings.html' },
  { icon: 'panel-top', label: '预览 · 快速粘贴面板', href: 'quickpaste.html', blank: true },
  { icon: 'moon', label: '切换 · 明暗主题', act: () => { const t = localStorage.getItem('ib-theme') === 'light' ? 'dark' : 'light'; applyTheme(t); } },
];
function openCmdk() {
  if (document.getElementById('cmdkMask')) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask'; mask.id = 'cmdkMask';
  mask.innerHTML = `<div class="modal" style="width:min(520px,92vw);padding:0;overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border-sub)">
      ${iconSvg('command', 15)}<input id="cmdkInput" placeholder="输入命令或搜索…" style="flex:1;border:none;background:none;font-size:14px;color:var(--text-1);outline:none">
      <kbd>Esc</kbd></div>
    <div id="cmdkList" style="max-height:320px;overflow-y:auto;padding:6px"></div></div>`;
  document.body.appendChild(mask);
  const input = mask.querySelector('#cmdkInput'), list = mask.querySelector('#cmdkList');
  const render = q => {
    const hits = CMDS.filter(c => !q || c.label.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = hits.map((c, i) => `<div class="pop-item" data-i="${CMDS.indexOf(c)}" style="border-radius:var(--r-sm)">${iconSvg(c.icon, 15)}<span class="grow">${c.label}</span>${i === 0 ? '<kbd>↵</kbd>' : ''}</div>`).join('')
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
  hydrateIcons();

  // 导航激活（body[data-page] → .nav-item.active）
  const page = document.body.dataset.page;
  if (page) document.querySelectorAll(`.nav-item[data-nav="${page}"]`).forEach(a => a.classList.add('active'));

  // 标题栏
  document.getElementById('themeBtn')?.addEventListener('click', () => {
    const next = localStorage.getItem('ib-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next); toast(next === 'light' ? '已切换 · 纸墨（浅色）' : '已切换 · 墨色（深色）');
  });
  document.getElementById('bellBtn')?.addEventListener('click', e => {
    const btn = e.currentTarget;
    if (document.querySelector('.pop')) { closePops(); return; }
    renderBellPop(btn);
  });
  if (DB.notifications?.some(n => !n.read)) document.getElementById('bellDot')?.classList.add('on');
  document.getElementById('qpBtn')?.addEventListener('click', () => window.open('quickpaste.html', '_blank'));
  document.getElementById('cmdkBtn')?.addEventListener('click', openCmdk);
  document.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => toast('原型演示 · 窗口控制由 Tauri 托管')));

  // 全局快捷键
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); }
    if (e.key === 'Escape') { closePops(); document.getElementById('cmdkMask')?.remove(); }
  });
});

/* ---------- 小工具 ---------- */
function ringSvg(pct, size = 52) {
  const r = 22, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 52 52"><circle class="trk" cx="26" cy="26" r="${r}"/><circle class="val" cx="26" cy="26" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/></svg><span class="pct">${Math.round(pct * 100)}%</span>`;
}
const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
