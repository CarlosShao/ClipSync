/* api.js — v2 API 存根层：函数签名 = 未来真实 API 形状，内部返回 mock。
   每个存根标注 HTTP 方法与路径，供后端对接时机械替换。
   v2 变更：askAI 增加页面上下文感知（dock 架构的配套服务形状）。 */

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

/* GET /api/favorites/collections —— 树形合集（对齐真实系统 ltree：path/depth/sort_order，返回已组装好的树） */
async function fetchCollections() { await delay(150); return { code: 0, data: DB.collections }; }
/* POST /api/favorites/collections { name, icon, parentId? } —— parentId 为空=根收藏夹，否则=子收藏夹 */
async function createCollection({ name, icon = 'folder', parentId = null }) {
  await delay(200);
  const node = { id: 'c' + Date.now(), name, icon, count: 0 };
  if (!parentId) { DB.collections.push(node); return { code: 0, data: node }; }
  const find = (list) => { for (const n of list) { if (n.id === parentId) return n; const f = n.children && find(n.children); if (f) return f; } return null; };
  const parent = find(DB.collections);
  if (!parent) return { code: 404, msg: '父收藏夹不存在' };
  (parent.children = parent.children || []).push(node);
  return { code: 0, data: node };
}
/* PUT /api/favorites/collections/:id { name?, icon? } —— 重命名/换图标 */
async function updateCollection(id, patch) {
  await delay(160);
  const walk = (list) => { for (const n of list) { if (n.id === id) { Object.assign(n, patch); return true; } if (n.children && walk(n.children)) return true; } return false; };
  return walk(DB.collections) ? { code: 0 } : { code: 404 };
}
/* DELETE /api/favorites/collections/:id —— 删除合集（内含条目移入"未分组"） */
async function deleteCollection(id) {
  await delay(200);
  const rm = (list) => { const i = list.findIndex(n => n.id === id); if (i > -1) { list.splice(i, 1); return true; } return list.some(n => n.children && rm(n.children)); };
  rm(DB.collections);
  DB.favItems.forEach(f => { if (f.cid === id) f.cid = 'all'; });
  return { code: 0 };
}
/* POST /api/favorites/collections/:id/move { parentId, sortOrder } —— 拖拽排序/换父级 */
async function moveCollection(id, { parentId = null, sortOrder = 0 } = {}) { await delay(200); return { code: 0 }; }

/* GET /api/favorites/items?cid=&q=&tag= */
async function fetchFavItems(cid = 'all', q = '', tag = '') {
  await delay(200);
  let list = DB.favItems.slice();
  if (cid !== 'all') list = list.filter(f => f.cid === cid);
  if (q) list = list.filter(f => f.content.toLowerCase().includes(q.toLowerCase()));
  if (tag) list = list.filter(f => (f.tags || []).includes(tag));
  return { code: 0, data: list };
}
/* POST /api/favorites/items { cid, content, type } —— 收藏条目入库（剪贴板页"收藏"动作的最终落地） */
async function addFavItem({ cid, content, type = 'text' }) {
  await delay(180);
  const it = { id: 'f' + Date.now(), cid, type, content, time: '刚刚', source: '本机', tags: [], sensitive: false };
  DB.favItems.unshift(it);
  return { code: 0, data: it };
}
/* DELETE /api/favorites/items/:id */
async function removeFav(id) {
  await delay(120);
  const i = DB.favItems.findIndex(x => x.id === id); if (i > -1) DB.favItems.splice(i, 1);
  return { code: 0 };
}
/* PUT /api/favorites/items/:id/tags { tags, tagColors } —— 对齐真实系统 setItemTags：tagColors 同步维护全局标签色 */
async function setItemTags(id, tags, tagColors = {}) {
  await delay(150);
  const f = DB.favItems.find(x => x.id === id); if (!f) return { code: 404 };
  f.tags = tags;
  tags.forEach(name => {
    if (!DB.favTags.some(t => t.name === name)) DB.favTags.push({ name, color: tagColors[name] || '#6E93FF' });
  });
  return { code: 0 };
}
/* GET /api/favorites/tags */
async function fetchFavTags() { await delay(100); return { code: 0, data: DB.favTags }; }
/* POST /api/favorites/tags { name, color } */
async function createFavTag({ name, color = '#6E93FF' }) {
  await delay(120);
  if (!DB.favTags.some(t => t.name === name)) DB.favTags.push({ name, color });
  return { code: 0 };
}
/* PUT /api/favorites/tags/:name { color } */
async function updateFavTag(name, { color }) {
  await delay(120);
  const t = DB.favTags.find(x => x.name === name); if (t) t.color = color;
  return { code: 0 };
}
/* DELETE /api/favorites/tags/:name —— 删除全局标签并从所有条目上摘除 */
async function deleteFavTag(name) {
  await delay(140);
  const i = DB.favTags.findIndex(t => t.name === name); if (i > -1) DB.favTags.splice(i, 1);
  DB.favItems.forEach(f => { f.tags = (f.tags || []).filter(t => t !== name); });
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
/* POST /api/templates/:id/use —— 返回渲染后文本并 +1 用量。
   变量语法对齐真实系统 templateStore：支持中文变量名、{{ name:default }} 默认值；未提供的变量回退默认值，无默认值则保留原样。 */
async function useTemplate(id, vars = {}) {
  await delay(150);
  const t = DB.templates.find(x => x.id === id);
  if (!t) return { code: 404 };
  t.usage++;
  const text = t.body
    .replace(/\{\{\s*([^{}:]+?)\s*(?::\s*([^{}]*?))?\s*\}\}/g, (m, k, d) => vars[k.trim()] ?? (d !== undefined ? d : m))
    .replace(/\\n/g, '\n');
  return { code: 0, text };
}
/* DELETE /api/templates/:id */
async function deleteTemplate(id) {
  await delay(150);
  const i = DB.templates.findIndex(x => x.id === id); if (i > -1) DB.templates.splice(i, 1);
  return { code: 0 };
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

/* POST /api/ai/chat —— SSE 流式；原型用分段 delay 模拟。
   v2 新增：请求体携带 pageKey（dock 当前所在页面），服务端把它拼进 system prompt。
   mock 感知分支：问"当前/哪个/什么页面/这页"→ 回答页面名 + 功能简介。 */
async function askAI(text, onChunk, { pageKey } = {}) {
  const label = DB.PAGE_LABEL[pageKey] || '剪贴板';
  const desc = DB.PAGE_DESC[pageKey] || '';
  const isPageQuery = /当前|哪个|什么页面|这页|在哪|哪儿|这个页面/.test(text);
  let reply;
  if (isPageQuery) {
    reply = `当前页面是「${label}」。在这里你可以${desc}。我会一直感知你所在的页面——切到别的页面再问我，答案会跟着变。`;
  } else {
    reply = '收到。这是针对「' + text.slice(0, 24) + (text.length > 24 ? '…' : '') + `」的演示回复（上下文：${label}页）。原型环境不连接真实模型，正式环境这里将消费 SSE 流（thinking / content / tool_call 事件），且 system prompt 会携带 pageKey=${pageKey || 'clipboard'}。`;
  }
  for (let i = 0; i < reply.length; i += 6) {
    await delay(24);
    onChunk && onChunk(reply.slice(0, i + 6));
  }
  await delay(120);
  return { code: 0, done: true };
}
/* POST /api/ai/chat/approve { requestId, allow, scope } —— scope: once|tool|all（三级批准策略，对齐真实系统 approve()） */
async function resolveConfirm(requestId, allow, scope = 'once') { await delay(300); return { code: 0, requestId, allow, scope }; }

/* POST /api/ai/agent —— Agent 流（SSE 事件序，对齐真实系统 useAiChat）：
   thinking(分段流入) → tool_call ×N → 破坏性工具挂起等确认 → thinking(再推理) → content(正文流入) → done。
   handlers: { onThinking(text,done), onToolCall(tool), onToolDone(name,tt), onConfirmRequired(tool)->Promise<{allow,scope}>, onThinkingAgain(text), onContent(chunk), onDone(stats) }
   原型用 DB.agentDemo 脚本 + delay 模拟时序；真实环境消费 SSE。 */
async function askAgent(text, handlers = {}, { pageKey } = {}) {
  const d = DB.agentDemo;
  const H = handlers;
  /* ① thinking 第一段：逐段流入 */
  let acc = '';
  for (let i = 0; i < d.thinking1.length; i += 8) {
    await delay(30);
    acc = d.thinking1.slice(0, i + 8);
    H.onThinking && H.onThinking(acc, false);
  }
  H.onThinking && H.onThinking(d.thinking1, true);
  /* ② 工具时间线：非破坏性工具直接执行 */
  for (const t of d.tools) {
    if (!t.confirm) {
      H.onToolCall && H.onToolCall(t);
      await delay(500);
      H.onToolDone && H.onToolDone(t.name, t.tt);
    }
  }
  /* ③ 破坏性工具：挂起，发确认门控，等用户三级裁决 */
  const risky = d.tools.find(t => t.confirm);
  let approved = { allow: true, scope: 'once' };
  if (risky) {
    H.onToolCall && H.onToolCall(risky);
    H.onConfirmRequired && (approved = await H.onConfirmRequired(risky));
    if (approved.allow) {
      await delay(400);
      H.onToolDone && H.onToolDone(risky.name, risky.tt);
    }
  }
  /* ④ 二次思考（封段再推理） */
  await delay(260);
  H.onThinkingAgain && H.onThinkingAgain(approved.allow ? d.thinking2 : '用户拒绝了写操作。调整方案：只输出分析与建议，不落盘，把结果直接呈现在回复里。');
  /* ⑤ 正文流入 */
  const answer = approved.allow ? d.answer : '好的，已跳过写文件。分析结论：这条内容属于「工作纪要」类，建议归档到收藏夹「工作片段 / 会议纪要」并打「会议」标签——需要我直接帮你收藏吗？';
  for (let i = 0; i < answer.length; i += 6) {
    await delay(22);
    H.onContent && H.onContent(answer.slice(0, i + 6));
  }
  await delay(120);
  /* ⑥ done：过程统计（时长/思考耗时/工具数），供封段 chips 展示 */
  H.onDone && H.onDone({ duration: '8.2s', thinkMs: 2400, toolCount: d.tools.length, approved: approved.allow, scope: approved.scope });
  return { code: 0, done: true };
}

/* GET /api/ai/usage */
async function fetchUsage() { await delay(120); return { code: 0, data: DB.usage }; }
/* GET /api/ai/memories */
async function fetchMemories() { await delay(120); return { code: 0, data: DB.memories }; }

/* GET /api/notifications */
async function fetchNotifications() { await delay(100); return { code: 0, data: DB.notifications }; }
/* POST /api/notifications/read-all */
async function markAllRead() {
  await delay(100);
  DB.notifications.forEach(n => n.read = true);
  return { code: 0 };
}
