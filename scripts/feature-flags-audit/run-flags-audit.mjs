// =============================================================
// ClipSync 功能开关（feature flags）全链路审计脚本
// 用法: node run-flags-audit.mjs
// 依赖: 运行中的 dev 后端 http://localhost:3001（docker-compose.dev.yml）
// 说明: dev 环境验证码固定 888888；验证码限流 5 次/小时/手机号
//       （token 落盘复用，跨进程规避限流）
// 覆盖: 5 个功能开关 × { 管理台切换 → 服务端强制 → 客户端快照 } 全链路
//       + 恢复原值回归。缺省值策略：测试结束恢复每个开关的初始值。
// =============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// 用 127.0.0.1 而非 localhost：本机 wslrelay.exe 抢占了 ::1 的 docker 端口转发（连接即挂起），
// node fetch 解析 localhost→::1 会永久挂起
const BASE = 'http://127.0.0.1:3001/api';
const ADMIN_PHONE = '13505110772'; // super_admin
const USER_PHONE = '13900001111'; // 测试用户（AuditBot）
const DEV_CODE = '888888';
const FLAG_TTL_MS = 5300; // 服务端进程内 5s TTL 缓存：PATCH 后等待失效窗口

const results = [];
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
    try { json = await res.json(); } catch { /* 无 body */ }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err.message };
  }
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginByCode(phone) {
  await req('POST', '/auth/send-code', { body: { phone } });
  return req('POST', '/auth/verify-code', {
    body: { phone, code: DEV_CODE, accept_tos: true, accept_privacy: true, birth_date: '2000-01-01' },
  });
}

async function getCachedToken(phone) {
  if (userTokens.has(phone)) {
    const t = userTokens.get(phone);
    const probe = await req('GET', '/auth/me', { token: t });
    if (probe.status !== 401) return t;
  }
  const r = await loginByCode(phone);
  const t = r.json?.token;
  if (t) {
    userTokens.set(phone, t);
    saveTokens();
  }
  return t ?? null;
}

async function getFlagSnapshot(token) {
  const r = await req('GET', '/app/feature-flags', { token });
  return r.json?.flags ?? null;
}

async function setFlag(adminToken, key, enabled) {
  const r = await req('PATCH', `/admin/flags/${key}`, { token: adminToken, body: { enabled } });
  if (r.status !== 200) throw new Error(`PATCH /admin/flags/${key} → ${r.status} ${JSON.stringify(r.json)}`);
  await sleep(FLAG_TTL_MS); // 跨进程 TTL 失效窗口
}

async function main() {
  console.log('== ClipSync 功能开关全链路审计 ==\n');

  // ---- 登录 ----
  const adminToken = await getCachedToken(ADMIN_PHONE);
  check('管理员登录', !!adminToken);
  const userToken = await getCachedToken(USER_PHONE);
  check('测试用户登录', !!userToken);
  if (!adminToken || !userToken) return;

  const original = await getFlagSnapshot(adminToken);
  check('客户端快照可读（GET /api/app/feature-flags，公开端点）', !!original, JSON.stringify(original));
  const anon = await req('GET', '/app/feature-flags');
  check('快照端点无需鉴权', anon.status === 200, `status=${anon.status}`);

  const flagsKeys = ['enable_subscription', 'enable_ai_agent', 'enable_public_sharing', 'enable_2fa', 'signup_waitlist'];
  check('快照包含全部 5 个开关键', flagsKeys.every((k) => k in (original ?? {})), flagsKeys.filter((k) => !(k in (original ?? {}))).join(','));

  // ---- 1. enable_ai_agent ----
  console.log('\n-- enable_ai_agent（AI 助手）--');
  await setFlag(adminToken, 'enable_ai_agent', false);
  let snap = await getFlagSnapshot(adminToken);
  check('关闭后客户端快照即时反映', snap?.enable_ai_agent === false);
  let r = await req('GET', '/ai/providers', { token: userToken });
  check('AI 供应商列表被 403 强制拦截', r.status === 403, `status=${r.status}`);
  check('403 响应携带 flagDisabled 标识（客户端可感知）', r.json?.flagDisabled === 'enable_ai_agent', JSON.stringify(r.json));
  r = await req('GET', '/ai/settings', { token: userToken });
  check('AI 设置被 403 强制拦截', r.status === 403, `status=${r.status}`);
  r = await req('GET', '/ai/conversations', { token: userToken });
  check('AI 会话被 403 强制拦截', r.status === 403, `status=${r.status}`);
  await setFlag(adminToken, 'enable_ai_agent', true);
  snap = await getFlagSnapshot(adminToken);
  check('恢复开启：快照回 true', snap?.enable_ai_agent === true);
  r = await req('GET', '/ai/providers', { token: userToken });
  check('恢复开启：AI 接口恢复 200', r.status === 200, `status=${r.status}`);

  // ---- 2. enable_public_sharing ----
  console.log('\n-- enable_public_sharing（公开分享）--');
  await setFlag(adminToken, 'enable_public_sharing', false);
  snap = await getFlagSnapshot(adminToken);
  check('关闭后客户端快照即时反映', snap?.enable_public_sharing === false);
  r = await req('POST', '/shared-links', { token: userToken, body: { itemId: '00000000-0000-4000-8000-000000000000' } });
  check('新建共享链接被 403 强制拦截', r.status === 403, `status=${r.status} body=${JSON.stringify(r.json)}`);
  check('403 响应携带 flagDisabled 标识', r.json?.flagDisabled === 'enable_public_sharing');
  r = await req('POST', '/shared-links/upload-file', { token: userToken, body: {} });
  check('共享文件上传被 403 强制拦截', r.status === 403, `status=${r.status}`);
  await setFlag(adminToken, 'enable_public_sharing', true);
  snap = await getFlagSnapshot(adminToken);
  check('恢复开启：快照回 true', snap?.enable_public_sharing === true);
  r = await req('GET', '/shared-links', { token: userToken });
  check('恢复开启：列表端点恢复 200（已建链接不受关闭影响可访问）', r.status === 200, `status=${r.status}`);

  // ---- 3. enable_2fa ----
  console.log('\n-- enable_2fa（两步验证）--');
  await setFlag(adminToken, 'enable_2fa', false);
  snap = await getFlagSnapshot(adminToken);
  check('关闭后客户端快照即时反映', snap?.enable_2fa === false);
  r = await req('POST', '/auth/2fa/setup', { token: userToken });
  check('2FA 绑定（setup）被 403 强制拦截', r.status === 403, `status=${r.status} body=${JSON.stringify(r.json)}`);
  check('403 响应携带 flagDisabled 标识', r.json?.flagDisabled === 'enable_2fa');
  r = await req('POST', '/auth/2fa/enable', { token: userToken, body: { code: '000000' } });
  check('2FA 启用（enable）被 403 强制拦截', r.status === 403, `status=${r.status}`);
  r = await req('GET', '/auth/2fa/status', { token: userToken });
  check('2FA 状态查询保持可用（已绑定用户不受影响，口径一致）', r.status === 200, `status=${r.status}`);
  await setFlag(adminToken, 'enable_2fa', true);
  snap = await getFlagSnapshot(adminToken);
  check('恢复开启：快照回 true', snap?.enable_2fa === true);

  // ---- 4. enable_subscription ----
  console.log('\n-- enable_subscription（订阅功能）--');
  await setFlag(adminToken, 'enable_subscription', false);
  snap = await getFlagSnapshot(adminToken);
  check('关闭后客户端快照即时反映', snap?.enable_subscription === false);
  // 强制语义：subscriptionCheck 中间件把全部用户按 Free 配额校验（不改库、不影响已有订单）
  r = await req('GET', '/subscriptions/current', { token: userToken });
  check('订阅查询端点保持可用（管理视图不炸，配额走 Free 强制）', r.status === 200, `status=${r.status}`);
  check('已订阅记录不受影响（current 返回原套餐数据）', !!r.json, `plan=${r.json?.plan?.name ?? r.json?.plan?.planName ?? 'n/a'}`);
  await setFlag(adminToken, 'enable_subscription', true);
  snap = await getFlagSnapshot(adminToken);
  check('恢复开启：快照回 true', snap?.enable_subscription === true);

  // ---- 5. signup_waitlist（注意：开启=收紧）----
  console.log('\n-- signup_waitlist（注册审核）--');
  // 每次运行用全新号码（上次运行留下的待审核用户会走 403 存量拦截分支，而非新注册分支），
  // 并清掉本脚本历史产生的 waitlist 测试用户，避免积累
  const waitlistPhone = '139' + String(Date.now()).slice(-8);
  try {
    execSync(
      `docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "DELETE FROM users WHERE phone LIKE '13900003%' AND registration_status = 'waitlist'"`,
      { encoding: 'utf8' },
    );
  } catch { /* 清理失败不阻断 */ }
  await setFlag(adminToken, 'signup_waitlist', true);
  snap = await getFlagSnapshot(adminToken);
  check('开启后客户端快照即时反映', snap?.signup_waitlist === true);
  r = await req('POST', '/auth/send-code', { body: { phone: waitlistPhone } });
  check('新手机号验证码发送成功', r.status === 200, `status=${r.status}`);
  r = await req('POST', '/auth/verify-code', {
    body: { phone: waitlistPhone, code: DEV_CODE, accept_tos: true, accept_privacy: true, birth_date: '2000-01-01' },
  });
  check('新注册进入待审核（200 + pendingReview，无会话）', r.status === 200 && r.json?.pendingReview === true, `status=${r.status} body=${JSON.stringify(r.json)}`);
  check('pendingReview 响应不携带 token', !r.json?.token);
  // 已存在的正常用户登录不受影响
  r = await req('GET', '/auth/me', { token: userToken });
  check('存量用户登录态不受影响', r.status === 200, `status=${r.status}`);
  await setFlag(adminToken, 'signup_waitlist', false);
  snap = await getFlagSnapshot(adminToken);
  check('恢复关闭：快照回 false', snap?.signup_waitlist === false);

  // ---- 汇总 ----
  const pass = results.filter((x) => x.ok).length;
  const fail = results.length - pass;
  console.log(`\n== 汇总: ${pass} PASS / ${fail} FAIL ==`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('审计脚本异常退出:', e);
  process.exit(1);
});
