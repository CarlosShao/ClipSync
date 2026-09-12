/* api.js — API 存根层：函数签名 = 未来真实 API 形状，内部返回 mock。
   每个存根标注 HTTP 方法与路径，供后端对接时机械替换。 */

const delay = (ms = 350) => new Promise(r => setTimeout(r, ms));

/* GET /api/clips?type=&q= */
async function fetchClips({ type = 'all', q = '' } = {}) {
  await delay(220);
  let list = DB.clips.slice();
  if (type !== 'all') list = list.filter(c => c.type === type);
  if (q) list = list.filter(c => c.content.toLowerCase().includes(q.toLowerCase()));
  return { code: 0, data: list, total: list.length };
}
/* POST /api/clips/:id/copy —— 真实环境写系统剪贴板并回冲目标窗口 */
async function copyItem(id) { await delay(120); return { code: 0 }; }
/* POST /api/clips/:id/pin {pinned} */
async function togglePin(id) {
  await delay(80);
  const c = DB.clips.find(x => x.id === id); if (c) c.pinned = !c.pinned;
  return { code: 0, pinned: c?.pinned };
}
/* POST /api/clips/:id/favorite {fav} */
async function toggleFav(id) {
  await delay(80);
  const c = DB.clips.find(x => x.id === id); if (c) c.fav = !c.fav;
  return { code: 0, fav: c?.fav };
}
/* DELETE /api/clips/:id */
async function removeClip(id) {
  await delay(150);
  const i = DB.clips.findIndex(x => x.id === id); if (i > -1) DB.clips.splice(i, 1);
  return { code: 0 };
}

/* GET /api/collections */
async function fetchCollections() { await delay(150); return { code: 0, data: DB.collections }; }
/* GET /api/favorites?cid=&q= */
async function fetchFavItems(cid = 'all', q = '') {
  await delay(200);
  let list = DB.favItems.slice();
  if (cid !== 'all') list = list.filter(f => f.cid === cid);
  if (q) list = list.filter(f => f.content.toLowerCase().includes(q.toLowerCase()));
  return { code: 0, data: list };
}
/* DELETE /api/favorites/:id */
async function removeFav(id) {
  await delay(120);
  const i = DB.favItems.findIndex(x => x.id === id); if (i > -1) DB.favItems.splice(i, 1);
  return { code: 0 };
}

/* GET /api/templates */
async function fetchTemplates() { await delay(180); return { code: 0, data: DB.templates }; }
/* PUT /api/templates/:id ｜ POST /api/templates */
async function saveTemplate(t) {
  await delay(260);
  if (t.id) { const i = DB.templates.findIndex(x => x.id === t.id); if (i > -1) DB.templates[i] = { ...DB.templates[i], ...t }; }
  else DB.templates.unshift({ id: 't' + Date.now(), usage: 0, updated: '刚刚', ...t });
  return { code: 0 };
}
/* POST /api/templates/:id/use —— 返回渲染后文本并 +1 用量 */
async function useTemplate(id, vars = {}) {
  await delay(150);
  const t = DB.templates.find(x => x.id === id);
  if (!t) return { code: 404 };
  t.usage++;
  const text = t.body.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m).replace(/\\n/g, '\n');
  return { code: 0, text };
}

/* GET /api/devices */
async function fetchDevices() { await delay(200); return { code: 0, data: DB.devices }; }
/* POST /api/devices/pair —— 返回配对码/二维码载荷，真实环境走局域网握手 */
async function pairDevice() { await delay(900); return { code: 0, pairCode: 'CS-8842-XY', expires: 120 }; }
/* POST /api/devices/:id/:action (pause|resume|remove) */
async function toggleDevice(id, action) {
  await delay(240);
  const d = DB.devices.find(x => x.id === id); if (!d) return { code: 404 };
  if (action === 'remove') DB.devices.splice(DB.devices.indexOf(d), 1);
  if (action === 'pause') d.status = 'paused';
  if (action === 'resume') d.status = 'online';
  return { code: 0 };
}
/* GET /api/sync/log */
async function fetchSyncLog() { await delay(180); return { code: 0, data: DB.syncLog }; }

/* GET /api/ai/convos */
async function fetchConvos() { await delay(150); return { code: 0, data: DB.convos }; }
/* GET /api/ai/convos/:id/messages */
async function fetchMessages(cid) { await delay(200); return { code: 0, data: DB.messages[cid] || [] }; }
/* POST /api/ai/chat —— SSE 流式；原型用分段 delay 模拟 */
async function askAI(text, onChunk) {
  const reply = '收到。这是针对「' + text.slice(0, 24) + (text.length > 24 ? '…' : '') + '」的演示回复：原型环境不连接真实模型，正式环境这里将消费 SSE 流（thinking / content / tool_call 事件）。';
  for (let i = 0; i < reply.length; i += 6) {
    await delay(28);
    onChunk && onChunk(reply.slice(0, i + 6));
  }
  await delay(150);
  return { code: 0, done: true };
}
/* POST /api/ai/chat/approve { requestId, allow } */
async function resolveConfirm(requestId, allow) { await delay(300); return { code: 0, requestId, allow }; }

/* GET /api/ai/usage */
async function fetchUsage() { await delay(120); return { code: 0, data: DB.usage }; }
/* GET /api/notifications */
async function fetchNotifications() { await delay(100); return { code: 0, data: DB.notifications }; }
/* POST /api/notifications/read-all */
async function markAllRead() {
  await delay(100);
  DB.notifications.forEach(n => n.read = true);
  return { code: 0 };
}
