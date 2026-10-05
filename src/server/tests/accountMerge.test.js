/**
 * 账号合并服务单测（services/accountMerge.js，2026-10-05 新增）
 *
 * 这是 ⑪ 的核心。那个端点的价值全在"合并做对了"上，而合并最危险的不是"搬少了"，
 * 是**搬完还留着能登录的旧账号**。所以本文件钉的顺序是：
 *
 *   ① ★退役必须**清掉 phone_hash / email_hash / *_encrypted 并置 is_active=false**、
 *      吊销会话 —— 登录是按 `phone = $1 OR phone_hash = $2` 查的，而 `merged_into`
 *      全仓**只写不读**；不清 hash，被合并的账号**照样能登录**（旧实现只给 phone
 *      加了后缀，hash 列原样留着，等于没退役）。
 *   ② ★内容计数闸：回传条数与实际不符 ⇒ **ROLLBACK 且一个写操作都不发生**。
 *   ③ ★两边都有生效订阅 ⇒ ROLLBACK（否则被合并方那段已付费时间凭空消失）。
 *   ④ 正常路径：搬剪贴板、按需搬订阅并同步两边快照、全程一个事务（BEGIN/COMMIT）。
 *
 * 全离线：mock db/pool 的 connect()，用有状态的假 client 记录每条 SQL。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  statements: [],
  clientState: {},
}));

vi.mock('../src/db/pool.js', () => ({ pool: state.pool, default: state.pool }));

import { mergeAccountInto } from '../src/services/accountMerge.js';

const CANON = 'c0000000-0000-4000-8000-000000000001';
const DUP = 'd0000000-0000-4000-8000-000000000002';

/** 造一个假 client：按 SQL 形状回应，并把每条语句记下来供断言 */
function mockClient({
  canonical = { id: CANON, phone: '13800000001', email: 'a@x.com', nickname: '保留方', merged_into: null, is_active: true, role_level: 10 },
  duplicate = { id: DUP, phone: '13800000002', email: null, nickname: '被合并方', merged_into: null, is_active: true, role_level: 10 },
  clipCount = 3,
  dupHasActiveSub = false,
  canonicalHasActiveSub = false,
  deviceCount = 2,
  missingUser = null,
} = {}) {
  state.statements = [];
  state.clientState = {};
  const client = {
    query: vi.fn(async (sql, params) => {
      const text = String(sql).trim();
      state.statements.push({ text, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('FROM users u')) {
        const all = [canonical, duplicate].filter((u) => u && u.id !== missingUser);
        return { rows: all };
      }
      if (text.includes('FROM clipboard_items')) return { rows: [{ n: clipCount }] };
      if (text.includes('FROM devices')) return { rows: [{ n: deviceCount }] };
      if (text.includes('FROM user_subscriptions us') && text.includes('plan_name')) {
        return { rows: dupHasActiveSub ? [{ id: 'sub-dup', plan_name: 'Pro' }] : [] };
      }
      if (text.includes('FROM user_subscriptions us')) {
        return { rows: canonicalHasActiveSub ? [{ id: 'sub-canon' }] : [] };
      }
      if (text.includes('UPDATE clipboard_items')) {
        return { rows: [], rowCount: clipCount };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  state.pool.connect.mockResolvedValue(client);
  return client;
}

const sqls = () => state.statements.map((s) => s.text);
const findSql = (needle) => state.statements.find((s) => s.text.includes(needle));

beforeEach(() => {
  state.pool.query.mockReset();
  state.pool.connect.mockReset();
});

describe('账号合并 · ★退役必须做干净（否则旧账号还能登录）', () => {
  it('★清 phone_hash/email_hash/*_encrypted + is_active=false + 吊销会话', async () => {
    mockClient();

    const res = await mergeAccountInto({
      canonicalUserId: CANON,
      duplicateUserId: DUP,
      confirmMovedClips: 3,
    });

    expect(res.ok).toBe(true);
    const retire = findSql('SET merged_into');
    expect(retire).toBeTruthy();
    // ★这三列不清 ⇒ 登录按 phone_hash 仍能查到该账号（merged_into 没人读）
    expect(retire.text).toContain('phone_hash = NULL');
    expect(retire.text).toContain('email_hash = NULL');
    expect(retire.text).toContain('phone_encrypted = NULL');
    expect(retire.text).toContain('email_encrypted = NULL');
    expect(retire.text).toContain('is_active = FALSE');
    expect(retire.text).toContain('subscription_status');
    expect(retire.text).toContain('current_subscription_id = NULL');
    // 旧实现的留痕口径要保留（phone 后缀 + nickname 后缀 + email 清空）
    expect(retire.text).toContain(`phone || '_merged'`);
    expect(retire.text).toContain(`nickname || '_merged'`);
    expect(retire.text).toContain('email = NULL');

    // 吊销被合并方会话
    const revoke = findSql('UPDATE user_sessions');
    expect(revoke).toBeTruthy();
    expect(revoke.params).toEqual([DUP]);
  });

  it('不是删除：剪贴板是搬走（UPDATE user_id）而不是删', async () => {
    mockClient({ clipCount: 7 });

    const res = await mergeAccountInto({
      canonicalUserId: CANON,
      duplicateUserId: DUP,
      confirmMovedClips: 7,
    });

    expect(res.movedClips).toBe(7);
    const move = findSql('UPDATE clipboard_items');
    expect(move.text).toContain('SET user_id = $1');
    expect(move.params).toEqual([CANON, DUP]);
  });
});

describe('账号合并 · ★闸门（对不上就什么都不做）', () => {
  it('★条数对不上 → CLIP_COUNT_MISMATCH + ROLLBACK，且没有任何写操作', async () => {
    mockClient({ clipCount: 5 });

    const res = await mergeAccountInto({
      canonicalUserId: CANON,
      duplicateUserId: DUP,
      confirmMovedClips: 2,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('CLIP_COUNT_MISMATCH');
    expect(res.movedClips).toBe(5);
    expect(sqls()).toContain('ROLLBACK');
    // 关键：没有 UPDATE（除了锁与 SELECT）
    expect(sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });

  it('没回传条数（undefined）也拒 —— 不能"不确认就执行"', async () => {
    mockClient({ clipCount: 0 });

    const res = await mergeAccountInto({ canonicalUserId: CANON, duplicateUserId: DUP });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('CLIP_COUNT_MISMATCH');
    expect(sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });

  it('★两边都有生效订阅 → SUBSCRIPTION_CONFLICT + ROLLBACK（不让已付费时间消失）', async () => {
    mockClient({ dupHasActiveSub: true, canonicalHasActiveSub: true, clipCount: 1 });

    const res = await mergeAccountInto({
      canonicalUserId: CANON,
      duplicateUserId: DUP,
      confirmMovedClips: 1,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('SUBSCRIPTION_CONFLICT');
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });

  it('同一账号 / 账号不存在 / 已被合并过 → 各自拒绝且不写入', async () => {
    mockClient();
    expect((await mergeAccountInto({ canonicalUserId: CANON, duplicateUserId: CANON })).reason).toBe(
      'SAME_USER'
    );

    mockClient({ missingUser: DUP });
    expect(
      (await mergeAccountInto({ canonicalUserId: CANON, duplicateUserId: DUP, confirmMovedClips: 3 }))
        .reason
    ).toBe('USER_NOT_FOUND');

    mockClient({
      duplicate: { id: DUP, phone: '1', email: null, nickname: 'x', merged_into: CANON, is_active: false, role_level: 10 },
    });
    expect(
      (await mergeAccountInto({ canonicalUserId: CANON, duplicateUserId: DUP, confirmMovedClips: 3 }))
        .reason
    ).toBe('ALREADY_MERGED');
    expect(sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });
});

describe('账号合并 · 正常路径', () => {
  it('被合并方有订阅、保留方没有 → 搬订阅并同步两边快照', async () => {
    mockClient({ dupHasActiveSub: true, canonicalHasActiveSub: false, clipCount: 2 });

    const res = await mergeAccountInto({
      canonicalUserId: CANON,
      duplicateUserId: DUP,
      confirmMovedClips: 2,
    });

    expect(res.ok).toBe(true);
    expect(res.movedSubscription).toBe(true);
    // 订阅归属改到保留方
    const sub = state.statements.find(
      (s) => s.text.includes('UPDATE user_subscriptions SET user_id')
    );
    expect(sub.params).toEqual([CANON, 'sub-dup']);
    // 快照同步（口径与 admin grant 路由一致：subscription_status = 套餐名小写）
    const snap = state.statements.find(
      (s) => s.text.includes('subscription_status = $2') && s.text.includes('current_subscription_id = $3')
    );
    expect(snap).toBeTruthy();
    expect(snap.params).toEqual([CANON, 'pro', 'sub-dup']);
  });

  it('保留方没有订阅、被合并方也没有 → 不搬订阅', async () => {
    mockClient({ dupHasActiveSub: false, clipCount: 0 });

    const res = await mergeAccountInto({
      canonicalUserId: CANON,
      duplicateUserId: DUP,
      confirmMovedClips: 0,
    });

    expect(res.ok).toBe(true);
    expect(res.movedSubscription).toBe(false);
    expect(state.statements.some((s) => s.text.includes('UPDATE user_subscriptions SET user_id'))).toBe(
      false
    );
  });

  it('全程一个事务：BEGIN → … → COMMIT；并取两个账号的 advisory lock', async () => {
    mockClient({ clipCount: 1 });

    await mergeAccountInto({ canonicalUserId: CANON, duplicateUserId: DUP, confirmMovedClips: 1 });

    const seq = sqls();
    expect(seq[0]).toBe('BEGIN');
    expect(seq[seq.length - 1]).toBe('COMMIT');
    expect(seq.filter((s) => s.includes('pg_advisory_xact_lock')).length).toBe(2);
  });

  it('保留方设备数如实回报（设备不搬 —— UNIQUE(user_id, device_name) 会撞同名设备）', async () => {
    mockClient({ deviceCount: 4, clipCount: 0 });

    const res = await mergeAccountInto({
      canonicalUserId: CANON,
      duplicateUserId: DUP,
      confirmMovedClips: 0,
    });

    expect(res.duplicateDeviceCount).toBe(4);
    // 设备行没被动过
    expect(state.statements.some((s) => s.text.includes('UPDATE devices'))).toBe(false);
  });
});
