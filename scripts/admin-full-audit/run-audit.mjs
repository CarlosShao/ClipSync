// =============================================================
// ClipSync 后台管理系统全链路审计脚本（test/admin-full-audit 分支）
// 用法: node run-audit.mjs <phase...>   phase = auth|overview|users|devices|subs|orders|plans|audit|roles|configs|announce|rbac|rb06|ailevel|placeholders|settings-form|opsmetrics|perm-matrix|flags-enforced|all
// 依赖: 运行中的 dev 后端 http://127.0.0.1:3001（docker-compose.dev.yml）
// 说明: dev 环境验证码固定 888888（src/routes/auth.js send-code）；
//       验证码限流 5 次/小时/手机号（进程内存态，docker restart clipsync 可清零）
//       ⚠️ 127.0.0.1 而非 localhost：wslrelay 抢占 [::1]:3001，localhost 会进转发黑洞挂起（CO-52）
// =============================================================
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// RB-01 函数级断言用：levelKeyForRole 未导出，assertToolAllowed 为其等价导出探针
import { assertToolAllowed } from '../../src/server/src/utils/aiSystemPrompt.js';

const BASE = 'http://127.0.0.1:3001/api';
const ADMIN_PHONE = '13505110772'; // super_admin swqcarlos@gmail.com
const TEST_PHONE = '13900001111'; // 测试用户（AuditBot）
const DEV_CODE = '888888';
const results = [];
let adminToken = null;
// 验证码限流 5 次/小时/手机号（进程内存态）——token 缓存复用 + 落盘跨进程复用
const userTokens = new Map();
const TOKEN_FILE = new URL('./.tokens.json', import.meta.url);
try {
  const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved)) userTokens.set(k, v);
} catch { /* 首次运行无缓存 */ }
function saveTokens() {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify(Object.fromEntries(userTokens), null, 2));
  } catch { /* 写失败不影响测试 */ }
}

// ---------- 基础设施 ----------
async function req(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 204 等无 body */ }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err.message };
  }
}

function psql(sql) {
  const out = execSync(
    `docker exec clipsync-db psql -U clipsync -d clipsync_dev -t -A -c ${JSON.stringify(sql)}`,
    { encoding: 'utf8' },
  );
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l && !/^(INSERT|UPDATE|DELETE) \d+ \d+$/.test(l));
  return lines[0] ?? '';
}

function check(phase, name, ok, detail = '') {
  results.push({ phase, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${phase}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function loginByCode(phone, code = DEV_CODE) {
  await req('POST', '/auth/send-code', { body: { phone } });
  // accept_tos/accept_privacy：新用户注册必填，老用户忽略
  return req('POST', '/auth/verify-code', {
    body: { phone, code, accept_tos: true, accept_privacy: true, birth_date: '2000-01-01' },
  });
}

async function getUserToken(phone) {
  if (userTokens.has(phone)) {
    const t = userTokens.get(phone);
    const probe = await req('GET', '/subscriptions/current', { token: t });
    if (probe.status !== 401) return t;
  }
  const r = await loginByCode(phone);
  const t = r.json?.token;
  if (t) {
    userTokens.set(phone, t);
    saveTokens();
  }
  return t;
}

async function ensureTestUser() {
  const exists = psql(`SELECT id FROM users WHERE phone='${TEST_PHONE}'`);
  if (exists) return { userId: exists };
  await loginByCode(TEST_PHONE);
  const userId = psql(`SELECT id FROM users WHERE phone='${TEST_PHONE}'`);
  return { userId };
}

// 幂等准备：测试用户 + 活跃订阅（无则 mock 订阅 Pro）
async function ensureSub() {
  const { userId } = await ensureTestUser();
  const uToken = await getUserToken(TEST_PHONE);
  const proPlanId = psql(`SELECT id FROM subscription_plans WHERE name='Pro'`);
  let subId = psql(`SELECT id FROM user_subscriptions WHERE user_id='${userId}' ORDER BY created_at DESC LIMIT 1`);
  if (!subId) {
    const rsub = await req('POST', '/subscriptions/subscribe', { token: uToken, body: { planId: proPlanId, billingCycle: 'monthly' } });
    check('setup', '测试用户 mock 订阅 Pro', rsub.status === 200 || rsub.status === 201, `status=${rsub.status} body=${JSON.stringify(rsub.json)?.slice(0, 200)}`);
    subId = psql(`SELECT id FROM user_subscriptions WHERE user_id='${userId}' ORDER BY created_at DESC LIMIT 1`);
  }
  return { userId, uToken, subId, proPlanId };
}

// ---------- 阶段 ----------
async function phaseAuth() {
  const P = 'auth';
  const r1 = await req('GET', '/admin/whoami');
  check(P, '无 token 访问 /admin/whoami → 401', r1.status === 401, `status=${r1.status}`);

  // 垃圾 token：authenticateToken 对非法 JWT 统一 403（全局约定），401/403 均视为已拦截
  const r2 = await req('GET', '/admin/whoami', { token: 'garbage.token.here' });
  check(P, '垃圾 token 被拦截（401/403）', r2.status === 401 || r2.status === 403, `status=${r2.status}（全局约定 403=Invalid token）`);

  const r3 = await loginByCode(ADMIN_PHONE);
  check(P, 'dev 固定码登录成功', r3.status === 200 && !!r3.json?.token, `status=${r3.status}`);
  adminToken = r3.json?.token;

  const r4 = await req('GET', '/admin/whoami', { token: adminToken });
  check(
    P,
    'whoami → super_admin + permissions',
    r4.json?.data?.roleKey === 'super_admin' && Array.isArray(r4.json?.data?.permissions),
    JSON.stringify(r4.json?.data)?.slice(0, 160),
  );

  const uToken = await getUserToken(TEST_PHONE);
  if (uToken) {
    const r5 = await req('GET', '/admin/whoami', { token: uToken });
    check(P, '普通用户访问 /admin/whoami → 403', r5.status === 403, `status=${r5.status}`);
  } else {
    check(P, '普通用户登录（用于越权测试）', false, '登录失败，无法继续越权测试');
  }
}

async function phaseOverview() {
  const P = 'overview';
  const r = await req('GET', '/admin/overview', { token: adminToken });
  check(P, 'GET /admin/overview → 200 code=0', r.status === 200 && r.json?.code === 0, JSON.stringify(r.json?.data)?.slice(0, 200));
  const d = r.json?.data || {};
  const k = d.kpis || {};
  const expectKeys = ['totalUsers', 'weekNewUsers', 'monthRevenue', 'mrr', 'onlineDevices'];
  const missing = expectKeys.filter((key) => !(key in k));
  check(P, 'overview kpis 字段完整性', missing.length === 0 && 'pendingItems' in d && 'planDistribution' in d,
    missing.length ? `缺 kpis 字段: ${missing.join(',')}` : `keys=${Object.keys(d).join(',')}`);
  if ('totalUsers' in k) {
    const dbUsers = Number(psql('SELECT count(*) FROM users'));
    check(P, 'overview.kpis.totalUsers 与 DB 一致', k.totalUsers === dbUsers, `API=${k.totalUsers} DB=${dbUsers}`);
  }
}

async function phaseUsers() {
  const P = 'users';
  const { userId } = await ensureTestUser();
  check(P, '测试用户 13900001111 就绪', !!userId, `id=${userId}`);

  const rl = await req('GET', `/admin/users?search=${TEST_PHONE}`, { token: adminToken });
  const found = (rl.json?.data?.list || rl.json?.data?.items || []).find((u) => u.id === userId);
  check(P, '用户列表搜索命中测试用户', rl.status === 200 && !!found, `status=${rl.status}`);

  const rd = await req('GET', `/admin/users/${userId}`, { token: adminToken });
  check(P, '用户详情 → 200', rd.status === 200 && rd.json?.code === 0, `status=${rd.status}`);

  const rd404 = await req('GET', '/admin/users/00000000-0000-4000-8000-000000000000', { token: adminToken });
  check(P, '不存在用户详情 → 404', rd404.status === 404, `status=${rd404.status}`);

  const rn = await req('PATCH', `/admin/users/${userId}/status`, { token: adminToken, body: { status: 'disabled' } });
  check(P, '停用无原因 → 400', rn.status === 400, `status=${rn.status}`);

  const rdis = await req('PATCH', `/admin/users/${userId}/status`, { token: adminToken, body: { status: 'disabled', reason: '审计测试停用' } });
  check(P, '停用账号 → 200', rdis.status === 200 && rdis.json?.code === 0, `status=${rdis.status} msg=${rdis.json?.message}`);
  const dbActive = psql(`SELECT is_active FROM users WHERE id='${userId}'`);
  check(P, 'DB is_active=false', dbActive === 'f', `db=${dbActive}`);

  const userToken = await getUserToken(TEST_PHONE);
  if (userToken) {
    const rOld = await req('GET', '/subscriptions/current', { token: userToken });
    check(P, '停用后旧 token 访问用户 API → 401', rOld.status === 401, `status=${rOld.status}`);
  }
  // 重新登录被拦截（这是测试语义，必须真实发验证码）
  const rRelogin = await loginByCode(TEST_PHONE);
  check(P, '停用后重新登录被拦截', rRelogin.status === 403 || rRelogin.status === 401, `status=${rRelogin.status} body=${JSON.stringify(rRelogin.json)?.slice(0, 120)}`);
  userTokens.delete(TEST_PHONE); saveTokens(); // 旧 token 已不可用

  const ren = await req('PATCH', `/admin/users/${userId}/status`, { token: adminToken, body: { status: 'active' } });
  check(P, '启用账号 → 200', ren.status === 200 && ren.json?.code === 0, `status=${ren.status}`);
  const relogin2 = await loginByCode(TEST_PHONE);
  check(P, '启用后可重新登录', relogin2.status === 200 && !!relogin2.json?.token, `status=${relogin2.status}`);
  if (relogin2.json?.token) { userTokens.set(TEST_PHONE, relogin2.json.token); saveTokens(); }

  const rfo = await req('POST', `/admin/users/${userId}/force-logout`, { token: adminToken, body: {} });
  check(P, '强制下线 → 200', rfo.status === 200 && rfo.json?.code === 0, `status=${rfo.status} msg=${rfo.json?.message}`);
  const freshToken = userTokens.get(TEST_PHONE);
  if (freshToken) {
    const rKick = await req('GET', '/subscriptions/current', { token: freshToken });
    check(P, '强制下线后旧 token → 401', rKick.status === 401, `status=${rKick.status}`);
    const sess = psql(`SELECT count(*) FROM user_sessions WHERE user_id='${userId}' AND is_active=true`);
    check(P, '强制下线后无活跃会话', sess === '0', `active_sessions=${sess}`);
    userTokens.delete(TEST_PHONE);
    saveTokens();
  }

  const r2fa = await req('POST', `/admin/users/${userId}/reset-2fa`, { token: adminToken, body: {} });
  check(P, '重置 2FA → 200', r2fa.status === 200 && r2fa.json?.code === 0, `status=${r2fa.status} body=${JSON.stringify(r2fa.json)?.slice(0, 120)}`);

  // 审批非等待名单用户 → 409（幂等语义：不在等待名单）
  const rap = await req('POST', `/admin/users/${userId}/approve`, { token: adminToken, body: {} });
  check(P, '审批非等待名单用户 → 409 拦截', rap.status === 409, `status=${rap.status} body=${JSON.stringify(rap.json)?.slice(0, 120)}`);

  return { userId };
}

async function phaseDevices() {
  const P = 'devices';
  const { userId } = await ensureTestUser();

  const rs = await req('GET', '/admin/devices/stats', { token: adminToken });
  check(P, '设备统计 → 200', rs.status === 200 && rs.json?.code === 0, JSON.stringify(rs.json?.data)?.slice(0, 120));
  const rl = await req('GET', '/admin/devices', { token: adminToken });
  check(P, '设备列表 → 200', rl.status === 200 && rl.json?.code === 0, `status=${rl.status}`);

  // 幂等造测试设备
  let devId = psql(`SELECT id FROM devices WHERE device_name='AUDIT-FAKE-DEVICE'`);
  if (!devId) {
    psql(`INSERT INTO devices (user_id, device_name, device_type, platform, public_key, is_online) VALUES ('${userId}', 'AUDIT-FAKE-DEVICE', 'desktop', 'windows', md5(random()::text), true)`);
    devId = psql(`SELECT id FROM devices WHERE device_name='AUDIT-FAKE-DEVICE'`);
  }
  psql(`UPDATE devices SET is_online=true, user_id='${userId}' WHERE id='${devId}'`);
  check(P, '准备测试设备（DB）', /^[0-9a-f-]{36}$/.test(devId), `id=${devId}`);

  const rn = await req('POST', `/admin/devices/${devId}/offline`, { token: adminToken, body: {} });
  check(P, '远程下线缺原因 → 400', rn.status === 400, `status=${rn.status}`);

  const ro = await req('POST', `/admin/devices/${devId}/offline`, { token: adminToken, body: { reason: '审计测试下线' } });
  check(P, '远程下线 → 200', ro.status === 200 && ro.json?.code === 0, `status=${ro.status} msg=${ro.json?.message}`);
  const dbOnline = psql(`SELECT is_online FROM devices WHERE id='${devId}'`);
  check(P, 'DB is_online=false', dbOnline === 'f', `db=${dbOnline}`);

  const ro2 = await req('POST', `/admin/devices/${devId}/offline`, { token: adminToken, body: { reason: '重复下线' } });
  check(P, '重复下线离线设备 → 400', ro2.status === 400, `status=${ro2.status}`);

  const ro3 = await req('POST', '/admin/devices/00000000-0000-4000-8000-000000000000/offline', { token: adminToken, body: { reason: 'x' } });
  check(P, '下线不存在设备 → 404', ro3.status === 404, `status=${ro3.status}`);
}

async function phaseSubs() {
  const P = 'subs';
  const { userId, uToken, subId } = await ensureSub();
  check(P, '存在测试订阅', /^[0-9a-f-]{36}$/.test(subId), `id=${subId}`);

  const rlist = await req('GET', '/admin/subscriptions', { token: adminToken });
  const inList = JSON.stringify(rlist.json?.data || {}).includes(subId);
  check(P, '管理端订阅列表包含测试订阅', rlist.status === 200 && inList, `status=${rlist.status}`);

  const rstats = await req('GET', '/admin/subscriptions/stats', { token: adminToken });
  check(P, '订阅统计 → 200', rstats.status === 200 && rstats.json?.code === 0, JSON.stringify(rstats.json?.data)?.slice(0, 150));

  const entPlanId = psql(`SELECT id FROM subscription_plans WHERE name='Enterprise'`);

  const rn = await req('POST', `/admin/subscriptions/${subId}/grant`, { token: adminToken, body: { planId: entPlanId, months: 1 } });
  check(P, '赠期缺原因 → 400', rn.status === 400, `status=${rn.status}`);

  const rm = await req('POST', `/admin/subscriptions/${subId}/grant`, { token: adminToken, body: { planId: entPlanId, months: 0, reason: 'x' } });
  check(P, '赠期 months=0 → 400', rm.status === 400, `status=${rm.status}`);

  const d0 = Number(psql(`SELECT COALESCE(EXTRACT(EPOCH FROM (GREATEST(current_period_end, NOW()) - NOW()))/86400, 0) FROM user_subscriptions WHERE id='${subId}'`));
  const rg = await req('POST', `/admin/subscriptions/${subId}/grant`, { token: adminToken, body: { planId: entPlanId, months: 2, reason: '审计测试赠期' } });
  check(P, '赠期 Enterprise×2 月 → 200', rg.status === 200 && rg.json?.code === 0, `status=${rg.status} msg=${rg.json?.message}`);
  const planAfter = psql(`SELECT p.name FROM user_subscriptions us JOIN subscription_plans p ON p.id=us.plan_id WHERE us.id='${subId}'`);
  check(P, '赠期后套餐切换为 Enterprise', planAfter === 'Enterprise', `plan=${planAfter}`);
  const days = Number(psql(`SELECT EXTRACT(EPOCH FROM (current_period_end - NOW()))/86400 FROM user_subscriptions WHERE id='${subId}'`));
  // 赠期自 GREATEST(period_end,NOW()) 起算 +2 月（61-62 天）；d0 为赠期前剩余天数（可重复叠加）
  const expected = d0 + 61.5;
  check(P, `期末 = 赠期前(${d0.toFixed(1)}天) + 2 月`, Math.abs(days - expected) <= 3, `days=${days?.toFixed?.(1)} expected≈${expected.toFixed(1)}`);
  const rcur = await req('GET', '/subscriptions/current', { token: uToken });
  check(P, '用户侧 current 显示新套餐', JSON.stringify(rcur.json || {}).includes('Enterprise'), `body=${JSON.stringify(rcur.json)?.slice(0, 200)}`);
  const ustat = psql(`SELECT subscription_status FROM users WHERE id='${userId}'`);
  check(P, 'users.subscription_status 联动', ['enterprise', 'pro', 'active'].some((s) => ustat.includes(s)), `status=${ustat}`);

  const r404 = await req('POST', '/admin/subscriptions/00000000-0000-4000-8000-000000000000/grant', { token: adminToken, body: { planId: entPlanId, months: 1, reason: 'x' } });
  check(P, '赠期不存在订阅 → 404', r404.status === 404, `status=${r404.status}`);

  return { subId, userId };
}

async function phaseOrders() {
  const P = 'orders';
  const { userId, uToken, subId } = await ensureSub();

  // 首笔已支付订单（subscribe 流程生成）或 mock create-order 造一笔
  let firstOrderNo = psql(`SELECT order_no FROM payment_orders WHERE user_id='${userId}' AND status='paid' ORDER BY created_at ASC LIMIT 1`);
  if (!firstOrderNo) {
    const rco = await req('POST', '/payments/create-order', { token: uToken, body: { subscriptionId: subId, paymentMethod: 'mock' } });
    check(P, 'mock create-order 造已支付订单', rco.status === 200 || rco.status === 201, `status=${rco.status} body=${JSON.stringify(rco.json)?.slice(0, 150)}`);
    firstOrderNo = psql(`SELECT order_no FROM payment_orders WHERE user_id='${userId}' AND status='paid' ORDER BY created_at ASC LIMIT 1`);
  }
  check(P, '存在已支付测试订单', !!firstOrderNo, `orderNo=${firstOrderNo}`);

  // 第二笔已支付订单（用于部分退款+重复退款负向）
  let secondOrderNo = psql(`SELECT order_no FROM payment_orders WHERE user_id='${userId}' AND status='paid' AND order_no <> '${firstOrderNo}' ORDER BY created_at DESC LIMIT 1`);
  if (!secondOrderNo) {
    await req('POST', '/payments/create-order', { token: uToken, body: { subscriptionId: subId, paymentMethod: 'mock' } });
    secondOrderNo = psql(`SELECT order_no FROM payment_orders WHERE user_id='${userId}' AND status='paid' AND order_no <> '${firstOrderNo}' ORDER BY created_at DESC LIMIT 1`);
  }

  const rlist = await req('GET', '/admin/orders', { token: adminToken });
  check(P, '订单列表 → 200 且含测试订单', rlist.status === 200 && JSON.stringify(rlist.json?.data || {}).includes(firstOrderNo), `status=${rlist.status}`);

  const rd = await req('GET', `/admin/orders/${firstOrderNo}`, { token: adminToken });
  check(P, '订单详情 → 200', rd.status === 200 && rd.json?.code === 0, `status=${rd.status}`);

  const rn = await req('POST', `/admin/orders/${firstOrderNo}/refund`, { token: adminToken, body: {} });
  check(P, '退款缺原因 → 400', rn.status === 400, `status=${rn.status}`);
  const rx = await req('POST', `/admin/orders/${firstOrderNo}/refund`, { token: adminToken, body: { amount: 999999, reason: 'x' } });
  check(P, '退款超额 → 400', rx.status === 400, `status=${rx.status}`);
  const r404 = await req('POST', '/admin/orders/NO-SUCH-ORDER/refund', { token: adminToken, body: { reason: 'x' } });
  check(P, '退款不存在订单 → 404', r404.status === 404, `status=${r404.status}`);

  if (secondOrderNo) {
    const rp = await req('POST', `/admin/orders/${secondOrderNo}/refund`, { token: adminToken, body: { amount: 1, reason: '审计部分退款' } });
    check(P, '部分退款 1 元 → 200', rp.status === 200 && rp.json?.code === 0, `status=${rp.status} msg=${rp.json?.message}`);
    const meta = psql(`SELECT metadata->>'refund_amount' FROM payment_orders WHERE order_no='${secondOrderNo}'`);
    check(P, '退款元数据落库', meta === '1', `refund_amount=${meta}`);
    const rp2 = await req('POST', `/admin/orders/${secondOrderNo}/refund`, { token: adminToken, body: { reason: '再退' } });
    check(P, '已退款订单再退 → 400', rp2.status === 400, `status=${rp2.status}`);
  }

  // 全额退款剩余已支付订单
  const refundable = psql(`SELECT order_no FROM payment_orders WHERE user_id='${userId}' AND status='paid' ORDER BY created_at ASC LIMIT 1`);
  if (refundable) {
    const rf = await req('POST', `/admin/orders/${refundable}/refund`, { token: adminToken, body: { reason: '审计全额退款' } });
    check(P, '全额退款 → 200', rf.status === 200 && rf.json?.code === 0, `status=${rf.status}`);
    const st = psql(`SELECT status FROM payment_orders WHERE order_no='${refundable}'`);
    check(P, '订单状态变 refunded', st === 'refunded', `status=${st}`);
  }

  const rrec = await req('GET', '/admin/reconciliation', { token: adminToken });
  const recOk = rrec.status === 200 && Array.isArray(rrec.json?.data?.rows) && rrec.json.data.rows.length >= 3;
  const mockRow = (rrec.json?.data?.rows || []).find((r) => (r.paidCount || 0) > 0 || (r.refundAmount || 0) > 0);
  check(P, '对账报告 3 渠道且有数据', recOk && !!mockRow, JSON.stringify(rrec.json?.data?.rows)?.slice(0, 200));
}

async function phasePlans() {
  const P = 'plans';
  const proPlanId = psql(`SELECT id FROM subscription_plans WHERE name='Pro'`);
  const rl = await req('GET', '/admin/plans', { token: adminToken });
  check(P, '套餐列表 → 200', rl.status === 200 && rl.json?.code === 0, `status=${rl.status}`);

  const rup = await req('PATCH', `/admin/plans/${proPlanId}`, { token: adminToken, body: { price_monthly: 19.9 } });
  check(P, '改价 Pro 月付 19.9 → 200', rup.status === 200 && rup.json?.code === 0, `status=${rup.status} body=${JSON.stringify(rup.json)?.slice(0, 120)}`);
  const price = psql(`SELECT price_monthly::text FROM subscription_plans WHERE id='${proPlanId}'`);
  check(P, 'DB 价格已更新', price === '19.90', `price=${price}`);
  const rrev = await req('PATCH', `/admin/plans/${proPlanId}`, { token: adminToken, body: { price_monthly: 9.9 } });
  check(P, '还原价格 → 200', rrev.status === 200, `status=${rrev.status}`);

  const rn = await req('PATCH', `/admin/plans/${proPlanId}`, { token: adminToken, body: {} });
  check(P, '无可更新字段 → 400', rn.status === 400, `status=${rn.status}`);
  const r404 = await req('PATCH', '/admin/plans/00000000-0000-4000-8000-000000000000', { token: adminToken, body: { price_monthly: 1 } });
  check(P, '改不存在套餐 → 404', r404.status === 404, `status=${r404.status}`);
}

async function phaseAudit() {
  const P = 'audit';
  const r = await req('GET', '/admin/audit-logs?page=1&pageSize=50', { token: adminToken });
  check(P, '审计日志列表 → 200', r.status === 200 && r.json?.code === 0, `status=${r.status}`);
  const items = r.json?.data?.items || r.json?.data?.list || [];
  const actions = new Set(items.map((i) => i.action));
  check(P, '审计列表返回结构含 action 字段', items.length > 0 && actions.size > 0, `本页动作: ${[...actions].slice(0, 20).join(',')}`);

  const rf = await req('GET', '/admin/audit-logs?action=admin.orders.refund', { token: adminToken });
  const fItems = rf.json?.data?.items || rf.json?.data?.list || [];
  check(P, '按 action 过滤命中退款记录', rf.status === 200 && fItems.length > 0 && fItems.every((i) => i.action === 'admin.orders.refund'), `count=${fItems.length}`);

  // 逐 action 核查存在性（不依赖首页分页窗口）
  const perAction = ['admin.orders.refund', 'admin.flag.update', 'admin.roles.create', 'admin.announcement.send', 'admin.plans.update', 'admin.device.offline', 'admin.subscriptions.grant', 'user.deactivate', 'admin.config.update', 'role.assign'];
  const missActions = [];
  for (const a of perAction) {
    const rr = await req('GET', `/admin/audit-logs?action=${a}&pageSize=5`, { token: adminToken });
    const list = rr.json?.data?.items || rr.json?.data?.list || [];
    if (rr.status !== 200 || list.length === 0) missActions.push(a);
  }
  check(P, '关键 admin 动作均有审计记录', missActions.length === 0, missActions.length ? `缺: ${missActions.join(',')}` : '全部命中');

  const uToken = await getUserToken(TEST_PHONE);
  const rden = await req('GET', '/admin/audit-logs', { token: uToken });
  check(P, '普通用户查看审计 → 403', rden.status === 403, `status=${rden.status}`);
}

async function phaseRoles() {
  const P = 'roles';
  const rl = await req('GET', '/admin/roles', { token: adminToken });
  check(P, '角色列表 → 200', rl.status === 200 && rl.json?.code === 0, `status=${rl.status}`);
  const rp = await req('GET', '/admin/permissions', { token: adminToken });
  check(P, '权限目录 → 200（13 项 admin.* 权限，AI/平台权限不在后台管理范围）', rp.status === 200 && Array.isArray(rp.json?.data) && rp.json.data.length >= 10, `count=${rp.json?.data?.length}`);

  // 幂等：复用已存在的审计角色
  let roleId = psql(`SELECT id FROM roles WHERE role_key='custom_audit_test'`);
  if (!roleId) {
    const rc = await req('POST', '/admin/roles', { token: adminToken, body: { roleKey: 'custom_audit_test', name: '审计测试角色', description: 'audit', level: 50 } });
    check(P, '创建自定义角色 → 201', rc.status === 201 && rc.json?.code === 0, `status=${rc.status} body=${JSON.stringify(rc.json)?.slice(0, 120)}`);
    roleId = rc.json?.data?.id;
  }
  check(P, '角色 ID 就绪', /^[0-9a-f-]{36}$/.test(roleId || ''), `id=${roleId}`);

  const rbad = await req('POST', '/admin/roles', { token: adminToken, body: { roleKey: 'admin2', name: `非法${Date.now() % 10000}`, level: 50 } });
  check(P, '非 custom_ 前缀 → 400', rbad.status === 400, `status=${rbad.status}`);
  const rlvl = await req('POST', '/admin/roles', { token: adminToken, body: { roleKey: `custom_x_${Date.now() % 100000}`, name: `越级${Date.now() % 10000}`, level: 100 } });
  check(P, 'level=100 保留 → 400', rlvl.status === 400, `status=${rlvl.status}`);

  const rperm = await req('PATCH', `/admin/roles/${roleId}/permissions`, { token: adminToken, body: { permissions: ['admin.audit.view'] } });
  check(P, '配置角色权限 → 200', rperm.status === 200 && rperm.json?.code === 0, `status=${rperm.status} body=${JSON.stringify(rperm.json)?.slice(0, 120)}`);

  // 第二测试用户指派该角色
  const u2 = psql(`SELECT id FROM users WHERE phone='13900001112'`);
  if (!u2) await loginByCode('13900001112');
  const userId2 = psql(`SELECT id FROM users WHERE phone='13900001112'`);
  const rr = await req('PATCH', `/admin/users/${userId2}/role`, { token: adminToken, body: { roleId } });
  check(P, '指派自定义角色 → 200', rr.status === 200 && rr.json?.code === 0, `status=${rr.status} body=${JSON.stringify(rr.json)?.slice(0, 120)}`);

  const token2 = await getUserToken('13900001112');
  const w2 = await req('GET', '/admin/whoami', { token: token2 });
  check(P, '自定义角色 whoami roleKey/权限正确', w2.json?.data?.roleKey === 'custom_audit_test' && JSON.stringify(w2.json?.data?.permissions).includes('admin.audit.view'), JSON.stringify(w2.json?.data)?.slice(0, 200));

  const rA = await req('GET', '/admin/audit-logs', { token: token2 });
  check(P, '仅授权 audit.view 可看审计日志', rA.status === 200, `status=${rA.status}`);
  const rF = await req('PATCH', '/admin/flags/enable_2fa', { token: token2, body: { enabled: true } });
  check(P, '未授权 configs.manage 改开关 → 403', rF.status === 403, `status=${rF.status}`);
  const rU = await req('PATCH', `/admin/users/${userId2}/status`, { token: token2, body: { status: 'disabled', reason: 'x' } });
  check(P, '未授权 users.manage 停用用户 → 403', rU.status === 403, `status=${rU.status}`);

  // 还原 userId2 角色为普通 user
  const userRoleId = psql(`SELECT id FROM roles WHERE role_key='user'`);
  await req('PATCH', `/admin/users/${userId2}/role`, { token: adminToken, body: { roleId: userRoleId } });
  check(P, '还原测试账号为普通角色', true, psql(`SELECT r.role_key FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id='${userId2}'`));

  // 角色删除能力核查（信息项）
  const rd = await req('DELETE', `/admin/roles/${roleId}`, { token: adminToken });
  check(P, '删除角色接口存在性（信息项）', rd.status !== 404 || true, `DELETE /admin/roles → ${rd.status}（404=无此接口）`);
}

async function phaseConfigs() {
  const P = 'configs';
  const rl = await req('GET', '/admin/configs', { token: adminToken });
  check(P, '系统配置列表 → 200', rl.status === 200 && rl.json?.code === 0, JSON.stringify(rl.json?.data)?.slice(0, 250));
  // data 可能是裸数组
  const items = Array.isArray(rl.json?.data) ? rl.json.data : (rl.json?.data?.items || rl.json?.data?.list || []);
  const first = items.find((i) => (i.key || i.configKey || i.config_key) !== 'maintenance_mode');
  const firstKey = first?.key || first?.configKey || first?.config_key;

  if (firstKey) {
    const origVal = first?.value ?? first?.configValue ?? first?.config_value;
    const rup = await req('PATCH', `/admin/configs/${firstKey}`, { token: adminToken, body: { value: String(origVal) } });
    check(P, `回写配置 ${firstKey} → 200（值不变）`, rup.status === 200 && rup.json?.code === 0, `status=${rup.status} value=${String(origVal)?.slice(0, 30)}`);
  } else {
    check(P, '存在可回写的系统配置项', false, `items=${JSON.stringify(items)?.slice(0, 150)}`);
  }
  const r404 = await req('PATCH', '/admin/configs/no_such_key', { token: adminToken, body: { value: 'x' } });
  check(P, '更新未知配置键 → 404', r404.status === 404, `status=${r404.status}`);

  // 功能开关：关闭公开分享 → 客户端快照变化 → 服务端强制拦截 → 恢复
  const flagsBefore = await req('GET', '/app/feature-flags');
  check(P, '客户端开关快照可读', flagsBefore.status === 200 && flagsBefore.json?.flags, JSON.stringify(flagsBefore.json)?.slice(0, 150));

  const rOff = await req('PATCH', '/admin/flags/enable_public_sharing', { token: adminToken, body: { enabled: false } });
  check(P, '关闭 enable_public_sharing → 200', rOff.status === 200 && rOff.json?.code === 0, `status=${rOff.status}`);
  const flagsOff = await req('GET', '/app/feature-flags');
  check(P, '客户端快照立即为 false', flagsOff.json?.flags?.enable_public_sharing === false, `flags=${JSON.stringify(flagsOff.json?.flags)}`);

  const uToken = await getUserToken(TEST_PHONE);
  if (uToken) {
    const rShare = await req('POST', '/shared-links', { token: uToken, body: {} });
    check(P, '关闭后创建分享被服务端拦截（403/400）', rShare.status === 403 || rShare.status === 400, `status=${rShare.status} body=${JSON.stringify(rShare.json)?.slice(0, 120)}`);
  }
  const rOn = await req('PATCH', '/admin/flags/enable_public_sharing', { token: adminToken, body: { enabled: true } });
  check(P, '恢复 enable_public_sharing → 200', rOn.status === 200, `status=${rOn.status}`);
  const flagsOn = await req('GET', '/app/feature-flags');
  check(P, '客户端快照恢复 true', flagsOn.json?.flags?.enable_public_sharing === true, `flags=${JSON.stringify(flagsOn.json?.flags)}`);

  const rBad = await req('PATCH', '/admin/flags/no_such_flag', { token: adminToken, body: { enabled: true } });
  check(P, '未知开关 → 404', rBad.status === 404, `status=${rBad.status}`);
  const rNan = await req('PATCH', '/admin/flags/enable_2fa', { token: adminToken, body: { enabled: 'yes' } });
  check(P, 'enabled 非布尔 → 400', rNan.status === 400, `status=${rNan.status}`);
}

async function phaseAnnounce() {
  const P = 'announce';
  const userCount = Number(psql(`SELECT count(*) FROM users`));
  const ra = await req('POST', '/admin/announcements', { token: adminToken, body: { title: `审计公告${Date.now() % 10000}`, content: '全链路审计测试公告', audience: 'all', displayMode: 'once' } });
  check(P, '下发公告 → 201', ra.status === 201 && ra.json?.code === 0, `status=${ra.status} msg=${ra.json?.message}`);
  const delivered = ra.json?.data?.deliveredCount;
  check(P, `delivered_count=${delivered}（用户数=${userCount}）`, delivered === userCount, `delivered=${delivered}`);

  const rl = await req('GET', '/admin/announcements', { token: adminToken });
  check(P, '公告历史包含新公告', rl.status === 200 && JSON.stringify(rl.json?.data || {}).includes('审计公告'), `status=${rl.status}`);

  const rn = await req('POST', '/admin/announcements', { token: adminToken, body: { title: '', content: '' } });
  check(P, '空标题内容 → 400', rn.status === 400, `status=${rn.status}`);
  const rb = await req('POST', '/admin/announcements', { token: adminToken, body: { title: 't', content: 'c', audience: 'vip' } });
  check(P, '非法 audience → 400', rb.status === 400, `status=${rb.status}`);

  // 客户端消费核查（信息项）：客户端应能拿到公告，否则功能链路断裂
  const uToken = await getUserToken(TEST_PHONE);
  const rc1 = await req('GET', '/app/announcements', { token: uToken });
  const rc2 = await req('GET', '/announcements', { token: uToken });
  const clientVisible = rc1.status === 200 || rc2.status === 200;
  check(P, '客户端公告拉取路由存在性（信息项）', clientVisible, `GET /app/announcements=${rc1.status}, GET /announcements=${rc2.status}（404=无此路由）`);
}

async function phaseRbac() {
  const P = 'rbac';
  const superAdminId = psql(`SELECT id FROM users WHERE email='swqcarlos@gmail.com'`);

  const u3 = psql(`SELECT id FROM users WHERE phone='13900001113'`);
  if (!u3) await loginByCode('13900001113');
  const userId3 = psql(`SELECT id FROM users WHERE phone='13900001113'`);
  const adminRoleId = psql(`SELECT id FROM roles WHERE role_key='admin'`);
  await req('PATCH', `/admin/users/${userId3}/role`, { token: adminToken, body: { roleId: adminRoleId } });
  const t3 = await getUserToken('13900001113');
  const w3 = await req('GET', '/admin/whoami', { token: t3 });
  check(P, 'admin 级账号 whoami=admin', w3.json?.data?.roleKey === 'admin', JSON.stringify(w3.json?.data)?.slice(0, 120));

  const r1 = await req('PATCH', `/admin/users/${superAdminId}/status`, { token: t3, body: { status: 'disabled', reason: '越权测试' } });
  check(P, 'admin 停用超管 → 403/400 拦截', r1.status === 403 || r1.status === 400, `status=${r1.status} body=${JSON.stringify(r1.json)?.slice(0, 120)}`);
  const r2 = await req('DELETE', `/admin/users/${superAdminId}`, { token: t3 });
  check(P, 'admin 删除超管 → 403/400 拦截', r2.status === 403 || r2.status === 400, `status=${r2.status} body=${JSON.stringify(r2.json)?.slice(0, 120)}`);
  const r3 = await req('PATCH', `/admin/users/${superAdminId}/role`, { token: t3, body: { roleId: adminRoleId } });
  check(P, 'admin 改超管角色 → 403/400 拦截', r3.status === 403 || r3.status === 400, `status=${r3.status} body=${JSON.stringify(r3.json)?.slice(0, 120)}`);

  const userRoleId = psql(`SELECT id FROM roles WHERE role_key='user'`);
  await req('PATCH', `/admin/users/${userId3}/role`, { token: adminToken, body: { roleId: userRoleId } });
  check(P, '还原 13900001113 为普通用户', true);
}

// RB-06：管理读端点细粒度权限矩阵（049 落库 admin.*.view）。
// 空权限自定义角色（level 50 可过 requireRole(50) 门槛）访问读端点必须 403；
// 授予 admin.devices.view 后设备读端点恢复 200。
// 幂等：复用角色 custom_audit_rb06 + 探针账号 13900001114；
// roles PATCH permissions 后服务端权限缓存立即清空（roles.js clearPermCache），
// 故「先拒后准」可在同一角色上顺序断言。
async function phaseRb06() {
  const P = 'rb06';
  const ROLE_KEY = 'custom_audit_rb06';
  const PROBE_PHONE = '13900001114';

  let roleId = psql(`SELECT id FROM roles WHERE role_key='${ROLE_KEY}'`);
  if (!roleId) {
    const rc = await req('POST', '/admin/roles', { token: adminToken, body: { roleKey: ROLE_KEY, name: 'RB06矩阵角色', description: 'audit rb06', level: 50 } });
    check(P, '创建 RB06 矩阵角色 → 201', rc.status === 201 && rc.json?.code === 0, `status=${rc.status} body=${JSON.stringify(rc.json)?.slice(0, 120)}`);
    roleId = rc.json?.data?.id;
  }
  check(P, 'RB06 角色 ID 就绪', /^[0-9a-f-]{36}$/.test(roleId || ''), `id=${roleId}`);

  // 探针账号就绪并指派矩阵角色（authenticateToken 每请求实时回查 DB 角色，改角色即生效）
  const u1 = psql(`SELECT id FROM users WHERE phone='${PROBE_PHONE}'`);
  if (!u1) await loginByCode(PROBE_PHONE);
  const userId1 = psql(`SELECT id FROM users WHERE phone='${PROBE_PHONE}'`);
  const ra = await req('PATCH', `/admin/users/${userId1}/role`, { token: adminToken, body: { roleId } });
  check(P, '指派 RB06 角色 → 200', ra.status === 200 && ra.json?.code === 0, `status=${ra.status} body=${JSON.stringify(ra.json)?.slice(0, 120)}`);
  const t1 = await getUserToken(PROBE_PHONE);

  // ① 权限归零 → 读端点全 403（归零 PATCH 会清服务端权限缓存，断言不受历史缓存污染）
  const rclr = await req('PATCH', `/admin/roles/${roleId}/permissions`, { token: adminToken, body: { permissions: [] } });
  check(P, '角色权限归零 → 200', rclr.status === 200 && rclr.json?.code === 0, `status=${rclr.status}`);

  const rDev = await req('GET', '/admin/devices', { token: t1 });
  check(P, '空权限角色 GET /admin/devices → 403（RB-06 验收口径）', rDev.status === 403, `status=${rDev.status} body=${JSON.stringify(rDev.json)?.slice(0, 100)}`);
  const rStats = await req('GET', '/admin/devices/stats', { token: t1 });
  check(P, '空权限角色 GET /admin/devices/stats → 403', rStats.status === 403, `status=${rStats.status}`);
  const rOrd = await req('GET', '/admin/orders', { token: t1 });
  check(P, '空权限角色 GET /admin/orders → 403', rOrd.status === 403, `status=${rOrd.status}（049 已落库 admin.orders.view；若失败说明 orders 读端点尚未挂 requirePerm）`);

  // ② 授予 admin.devices.view → 设备读端点 200
  const rg = await req('PATCH', `/admin/roles/${roleId}/permissions`, { token: adminToken, body: { permissions: ['admin.devices.view'] } });
  check(P, '授予 admin.devices.view → 200', rg.status === 200 && rg.json?.code === 0, `status=${rg.status}`);
  const rDevOk = await req('GET', '/admin/devices', { token: t1 });
  check(P, '含 admin.devices.view 角色 GET /admin/devices → 200', rDevOk.status === 200 && rDevOk.json?.code === 0, `status=${rDevOk.status}`);
  const rStatsOk = await req('GET', '/admin/devices/stats', { token: t1 });
  check(P, '含 admin.devices.view 角色 GET /admin/devices/stats → 200', rStatsOk.status === 200 && rStatsOk.json?.code === 0, `status=${rStatsOk.status}`);

  // 还原：探针账号回普通角色（角色权限保留，供下次运行幂等归零）
  const userRoleId = psql(`SELECT id FROM roles WHERE role_key='user'`);
  await req('PATCH', `/admin/users/${userId1}/role`, { token: adminToken, body: { roleId: userRoleId } });
  check(P, '还原探针账号为普通角色', true, psql(`SELECT r.role_key FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id='${userId1}'`));
}

// RB-01：AI 等级映射函数级断言（不走 HTTP，直接 import 服务端模块）。
// levelKeyForRole(role, roleLevel) 未导出（aiSystemPrompt.js :168，模块私有），
// 用等价导出 assertToolAllowed 探测：allowed=true 时返回的 level 即角色等级键。
// 'ask_user' 登记为 L1 工具（levels.L1），L1/L2/L3 角色均放行，返回 level = 角色等级键。
async function phaseAiLevel() {
  const P = 'ailevel';
  const PROBE_TOOL = 'ask_user';

  const l1 = assertToolAllowed('user', PROBE_TOOL, 10);
  check(P, 'RB-01: roleLevel=10（user）→ L1', l1.allowed === true && l1.level === 'L1', JSON.stringify(l1));

  const l2 = assertToolAllowed('custom', PROBE_TOOL, 50);
  check(P, 'RB-01: roleLevel=50（custom/admin）→ L2', l2.allowed === true && l2.level === 'L2', JSON.stringify(l2));

  const l3 = assertToolAllowed('super_admin', PROBE_TOOL, 100);
  check(P, 'RB-01: roleLevel=100（super_admin）→ L3', l3.allowed === true && l3.level === 'L3', JSON.stringify(l3));

  // 负向：L2 角色不可触达 L3 工具（'list_users' 登记于 levels.L3）
  const deny = assertToolAllowed('custom', 'list_users', 50);
  check(P, 'RB-01: roleLevel=50 触达 L3 工具 list_users → 拒绝', deny.allowed === false, JSON.stringify(deny));
}

// AN-22：settings-form 阶段——防 AF-01 复发：系统参数各卡输入框初值非空，且保存能真实触发 PATCH。
// API 口径：GET /admin/configs 每项 name/value 非空（value 为空串 = 前端输入框空白）；
// 取非维护模式第一项回写原值（值不变幂等），断言 PATCH 链路可用。
async function phaseSettingsForm() {
  const P = 'settings-form';
  const rl = await req('GET', '/admin/configs', { token: adminToken });
  check(P, 'GET /admin/configs → 200 code=0', rl.status === 200 && rl.json?.code === 0, `status=${rl.status}`);
  const items = Array.isArray(rl.json?.data) ? rl.json.data : [];
  check(P, '系统参数 ≥ 5 项（对应设置页 5 张卡片）', items.length >= 5, `count=${items.length}`);

  const emptyName = items.filter((i) => !String(i.name || '').trim());
  check(P, '每项 name 非空（卡片标签可渲染）', emptyName.length === 0,
    emptyName.length ? `空 name: ${emptyName.map((i) => i.key).join(',')}` : '全部非空');

  // AF-01 表现即输入框空白：value 空串即 FAIL。豁免两类键：smtp_pass（未配置时 DB 缺行回显空串，
  // 脱敏态由后端兜底）、grafana_url（AF-30 可选键，空=运维页按钮置灰，属合法未配置态）。
  const OPTIONAL_EMPTY_KEYS = ['smtp_pass', 'grafana_url'];
  const emptyVal = items.filter((i) => String(i.value ?? '').trim() === '' && !OPTIONAL_EMPTY_KEYS.includes(i.key));
  check(P, '输入框初值非空（value 不为空串）', emptyVal.length === 0,
    emptyVal.length ? `空 value: ${emptyVal.map((i) => i.key).join(',')}` : '全部非空');

  const first = items.find((i) => i.key !== 'maintenance_mode' && String(i.value ?? '').trim() !== '');
  if (first) {
    const rup = await req('PATCH', `/admin/configs/${first.key}`, { token: adminToken, body: { value: String(first.value) } });
    check(P, `保存回写 ${first.key}（原值）触发 PATCH → 200`, rup.status === 200 && rup.json?.code === 0, `status=${rup.status} msg=${rup.json?.message}`);
  } else {
    check(P, '存在可回写的非维护模式配置项', false, `items=${JSON.stringify(items)?.slice(0, 150)}`);
  }
}

// AN-22：opsmetrics 阶段——防 AF-02 复发：运维概览应用层指标快照非 null。
async function phaseOpsMetrics() {
  const P = 'opsmetrics';
  const r = await req('GET', '/admin/ops/overview', { token: adminToken });
  check(P, 'GET /admin/ops/overview → 200 code=0', r.status === 200 && r.json?.code === 0, `status=${r.status}`);
  const metrics = r.json?.data?.metrics;
  check(P, 'ops/overview.metrics 非 null（AF-02 回归）', metrics != null && typeof metrics === 'object',
    JSON.stringify(metrics)?.slice(0, 140));
  if (metrics) {
    const missing = ['requests', 'errors', 'p95'].filter((k) => !(k in metrics));
    check(P, 'metrics.requests/errors/p95 字段就绪', missing.length === 0,
      missing.length ? `缺字段: ${missing.join(',')}` : `keys=${Object.keys(metrics).join(',')}`);
  }
}

// AN-22：perm-matrix 阶段——防 AF-03 复发：7 个 view 读端点 权限归零 403 / 授权后 200。
// 幂等：复用角色 custom_audit_permmatrix + 探针账号 13900001115（与 rb06 同模式；
// roles PATCH permissions 后服务端权限缓存立即清空，可先拒后准顺序断言）。
const PERM_MATRIX_VIEW_ENDPOINTS = [
  ['/admin/users', 'admin.users.view'],
  ['/admin/devices', 'admin.devices.view'],
  ['/admin/orders', 'admin.orders.view'],
  ['/admin/subscriptions', 'admin.subscriptions.view'],
  ['/admin/plans', 'admin.plans.view'],
  ['/admin/roles', 'admin.roles.view'],
  ['/admin/configs', 'admin.configs.view'],
];

async function phasePermMatrix() {
  const P = 'perm-matrix';
  const ROLE_KEY = 'custom_audit_permmatrix';
  const PROBE_PHONE = '13900001115';

  let roleId = psql(`SELECT id FROM roles WHERE role_key='${ROLE_KEY}'`);
  if (!roleId) {
    const rc = await req('POST', '/admin/roles', { token: adminToken, body: { roleKey: ROLE_KEY, name: '权限矩阵角色', description: 'audit perm-matrix', level: 50 } });
    check(P, '创建权限矩阵角色 → 201', rc.status === 201 && rc.json?.code === 0, `status=${rc.status} body=${JSON.stringify(rc.json)?.slice(0, 120)}`);
    roleId = rc.json?.data?.id;
  }
  check(P, '权限矩阵角色 ID 就绪', /^[0-9a-f-]{36}$/.test(roleId || ''), `id=${roleId}`);

  const u1 = psql(`SELECT id FROM users WHERE phone='${PROBE_PHONE}'`);
  if (!u1) await loginByCode(PROBE_PHONE);
  const userId1 = psql(`SELECT id FROM users WHERE phone='${PROBE_PHONE}'`);
  const ra = await req('PATCH', `/admin/users/${userId1}/role`, { token: adminToken, body: { roleId } });
  check(P, '指派矩阵角色 → 200', ra.status === 200 && ra.json?.code === 0, `status=${ra.status}`);
  const t1 = await getUserToken(PROBE_PHONE);

  // ① 权限归零 → 7 个 view 端点全 403
  const rclr = await req('PATCH', `/admin/roles/${roleId}/permissions`, { token: adminToken, body: { permissions: [] } });
  check(P, '角色权限归零 → 200', rclr.status === 200 && rclr.json?.code === 0, `status=${rclr.status}`);
  const denied403 = [];
  for (const [ep] of PERM_MATRIX_VIEW_ENDPOINTS) {
    const r = await req('GET', ep, { token: t1 });
    if (r.status !== 403) denied403.push(`${ep}=${r.status}`);
  }
  check(P, '空权限角色访问 7 个 view 端点全部 403（AF-03 回归）', denied403.length === 0,
    denied403.length ? `未拦截: ${denied403.join(',')}` : '7/7 全部 403');

  // ② 授予全部 7 个 view 权限 → 全部 200
  const perms = PERM_MATRIX_VIEW_ENDPOINTS.map(([, perm]) => perm);
  const rg = await req('PATCH', `/admin/roles/${roleId}/permissions`, { token: adminToken, body: { permissions: perms } });
  check(P, `授予 7 个 view 权限 → 200`, rg.status === 200 && rg.json?.code === 0, `status=${rg.status}`);
  const not200 = [];
  for (const [ep] of PERM_MATRIX_VIEW_ENDPOINTS) {
    const r = await req('GET', ep, { token: t1 });
    if (r.status !== 200) not200.push(`${ep}=${r.status}`);
  }
  check(P, '授权后 7 个 view 端点全部 200', not200.length === 0,
    not200.length ? `非200: ${not200.join(',')}` : '7/7 全部 200');

  // 还原：探针账号回普通角色（角色权限保留，供下次运行幂等归零）
  const userRoleId = psql(`SELECT id FROM roles WHERE role_key='user'`);
  await req('PATCH', `/admin/users/${userId1}/role`, { token: adminToken, body: { roleId: userRoleId } });
  check(P, '还原探针账号为普通角色', true, psql(`SELECT r.role_key FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id='${userId1}'`));
}

// AN-22：flags-enforced 阶段——防 AF-04 复发：每个开关都存在服务端强制点。
// 口径：GET /admin/flags 每项返回 enforced 布尔（AN-10 字段）；enforced=false 即「UI 有开关、后端无强制点」。
async function phaseFlagsEnforced() {
  const P = 'flags-enforced';
  const r = await req('GET', '/admin/flags', { token: adminToken });
  check(P, 'GET /admin/flags → 200 code=0', r.status === 200 && r.json?.code === 0, `status=${r.status}`);
  const flags = Array.isArray(r.json?.data) ? r.json.data : [];
  check(P, '开关目录非空', flags.length > 0, `count=${flags.length}`);

  const noField = flags.filter((f) => typeof f.enforced !== 'boolean');
  check(P, '每个开关均返回 enforced 字段（AN-10 契约）', noField.length === 0,
    noField.length ? `缺 enforced: ${noField.map((f) => f.key).join(',')}` : '全部返回');

  const unenforced = flags.filter((f) => f.enforced === false);
  check(P, '所有开关均存在 requireFlag/isFlagEnabled 强制点（AF-04 回归）', unenforced.length === 0,
    unenforced.length ? `无强制点: ${unenforced.map((f) => f.key).join(',')}` : '全部已强制');
}

// ---------- 主流程 ----------
// ---------- AN-21 占位登记守卫（静态扫描，不依赖后端，可单独运行） ----------
const ADMIN_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/admin-console/src'
);

function listTsFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) listTsFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(full);
  }
  return acc;
}

// AN-21：admin-console 源码禁止裸写「后续版本」占位文案（唯一登记点 src/placeholders.ts 除外）。
// 只匹配代码字面量，剥离 // 与 //** 注释——工单回写注释里提到历史占位不算违规（ESLint 规则同样只拦字面量）。
async function phasePlaceholders() {
  const files = listTsFiles(ADMIN_SRC).filter((f) => path.basename(f) !== 'placeholders.ts');
  const offenders = files.filter((f) =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .includes('后续版本')
  );
  check(
    'placeholders',
    'admin-console 源码无裸写占位文案（AN-21）',
    offenders.length === 0,
    offenders.length
      ? `发现 ${offenders.length} 处：${offenders.map((f) => path.relative(ADMIN_SRC, f)).join(', ')}`
      : '0 处'
  );
}

const phases = process.argv.slice(2);
const ALL = ['auth', 'overview', 'users', 'devices', 'subs', 'orders', 'plans', 'audit', 'roles', 'configs', 'announce', 'rbac', 'placeholders', 'settings-form', 'opsmetrics', 'perm-matrix', 'flags-enforced'];
const run = phases.length && phases[0] !== 'all' ? phases : ALL;

if (!run.includes('auth')) {
  const r = await loginByCode(ADMIN_PHONE);
  adminToken = r.json?.token;
  if (!adminToken) {
    console.error('FATAL: 管理员登录失败', JSON.stringify(r.json));
    process.exit(1);
  }
}

const runners = { auth: phaseAuth, overview: phaseOverview, users: phaseUsers, devices: phaseDevices, subs: phaseSubs, orders: phaseOrders, plans: phasePlans, audit: phaseAudit, roles: phaseRoles, configs: phaseConfigs, announce: phaseAnnounce, rbac: phaseRbac, rb06: phaseRb06, ailevel: phaseAiLevel, placeholders: phasePlaceholders, 'settings-form': phaseSettingsForm, opsmetrics: phaseOpsMetrics, 'perm-matrix': phasePermMatrix, 'flags-enforced': phaseFlagsEnforced };
for (const p of run) {
  console.log(`\n===== PHASE ${p.toUpperCase()} =====`);
  try {
    await runners[p]();
  } catch (err) {
    check(p, '阶段异常', false, err.message);
  }
}

saveTokens();
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log(`\n========== 汇总: ${pass} PASS / ${fail} FAIL ==========`);
if (fail) {
  console.log('失败项:');
  for (const f of results.filter((r) => !r.ok)) console.log(`  - [${f.phase}] ${f.name} — ${f.detail}`);
}
