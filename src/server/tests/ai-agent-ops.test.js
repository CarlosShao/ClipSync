/**
 * Agent-H：AI Agent 边界与安全治理 —— 后端测试与回归
 *
 * 覆盖（对应 docs/plans/ai-agent-boundary-task-assignment.md 中 Agent-H 清单）：
 *  1. 权限矩阵：user/admin/super_admin 对 L0-L3 各工具允许/拒绝（assertToolAllowed / getToolsForRole / isToolAllowedForLevel）
 *  2. 写工具真实落库 + user_id 硬隔离（write_clip / create_collection / archive_items）
 *  3. destroy_clips 确认门控（批准→物理删除 / 拒绝→REJECTED_BY_USER 且数据仍在 / cancelPendingForUser 断流清理）
 *  4. read_clip_content advanced 保护 + ephemeral 消息不落库
 *  5. 工具调用产生 audit_logs 行（成功与失败）
 *  6. （随全量回归一起跑）
 *
 * 工程约定：
 *  - 全部参数化 SQL
 *  - 被测代码(src/server/src/...)不做任何修改
 *  - 数据清理：本文件创建的用户号段 1380000000x 会被 setup.js 与自身 afterAll 清理
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { v4 as uuidv4 } from 'uuid'
import pool from '../src/db/pool.js'
import { encrypt } from '../src/utils/encryption.js'
import { getTestApp, ensureTestUser, cleanupTestData } from './test-helpers.js'
import { executeTool, approveToolRequest, cancelPendingForUser } from '../src/routes/aiTools.js'
import { assertToolAllowed, getToolsForRole, isToolAllowedForLevel } from '../src/utils/aiSystemPrompt.js'

// 测试环境 auth 中间件固定使用的用户 ID（src/middleware/auth.js）。仅用于 ephemeral 消息落库测试。
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'

// 本文件专用用户的手机号（13800 号段，setup.js beforeAll 会自动清理）
const PHONE_U1 = '13800000001'
const PHONE_U2 = '13800000002'

const tick = () => new Promise((r) => setTimeout(r, 30))

// ---- 工具函数 ---------------------------------------------------------
async function createUser(phone) {
  const { client } = await import('./test-helpers.js').then((m) => m.getTestDb())
  try {
    return await ensureTestUser(client, phone)
  } finally {
    client.release()
  }
}

// 直接插入一条剪贴板条目（content_encrypted 用真实写工具同一套加密，advanced 走明文也无妨）
async function insertClip(userId, content, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO clipboard_items
       (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, protection_level, metadata)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      userId,
      overrides.content_type || 'text',
      overrides.content_encrypted != null ? overrides.content_encrypted : encrypt(String(content)),
      String(content).slice(0, 200),
      Buffer.byteLength(String(content)),
      overrides.protection_level || 'none',
      JSON.stringify(overrides.metadata || {}),
    ]
  )
  return rows[0].id
}

let app

beforeAll(async () => {
  const { app: a } = await getTestApp()
  app = a

  // 确保 auth 中间件硬编码的测试用户存在（否则 ai_conversations FK 失败）。
  // 与 archive.test.js 相同手法；该用户不随本文件删除（后续其它测试文件复用）。
  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, created_at, updated_at)
     VALUES ($1, $2, 'agent-ops-测试用户', 'test_hash', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, '+86agent-ops-0001']
  )
}, 60000)

afterAll(async () => {
  // 清理本文件创建的业务用户及其关联数据（audit_logs / 收藏夹 / 剪贴板 / 设备 / 用户）
  const phones = [PHONE_U1, PHONE_U2]
  const ids = []
  for (const ph of phones) {
    const { rows } = await pool.query('SELECT id FROM users WHERE phone = $1', [ph])
    if (rows[0]?.id) ids.push(rows[0].id)
  }
  if (ids.length) {
    await pool.query('DELETE FROM favorite_collections WHERE user_id = ANY($1)', [ids]).catch(() => {})
    await pool.query('DELETE FROM clipboard_templates WHERE user_id = ANY($1)', [ids]).catch(() => {})
    await pool.query('DELETE FROM shared_links WHERE user_id = ANY($1)', [ids]).catch(() => {})
    await pool.query('DELETE FROM ai_memories WHERE user_id = ANY($1)', [ids]).catch(() => {})
    await pool.query('DELETE FROM audit_logs WHERE user_id = ANY($1)', [ids]).catch(() => {})
    await pool.query('DELETE FROM clipboard_items WHERE user_id = ANY($1)', [ids]).catch(() => {})
    await pool.query('DELETE FROM devices WHERE user_id = ANY($1)', [ids]).catch(() => {})
  }
  for (const ph of phones) {
    await cleanupTestData(pool, ph)
  }
  // 清理 ephemeral 消息测试用对话（级联删除 ai_messages）
  await pool.query(
    "DELETE FROM ai_conversations WHERE user_id = $1 AND title = 'agent-ops-ephemeral-test'",
    [TEST_USER_ID]
  ).catch(() => {})
})

// ======================================================================
// 1. 权限矩阵：user / admin / super_admin 对 L0-L3 各工具
// ======================================================================
describe('权限矩阵（L0-L3）', () => {
  const L0 = 'get_clipboard_stats'
  const L1 = 'write_clip'
  // RBAC 收敛后 create_collection 已降至 L1；L2 示例改用真实的管理级工具 list_all_devices。
  const L2 = 'list_all_devices'
  const L3 = 'get_security_overview'

  it('isToolAllowedForLevel 应正确判定各等级工具', () => {
    expect(isToolAllowedForLevel(L0, 'L0')).toBe(true)
    expect(isToolAllowedForLevel(L0, 'L1')).toBe(true)
    expect(isToolAllowedForLevel(L1, 'L1')).toBe(true)
    expect(isToolAllowedForLevel(L1, 'L0')).toBe(false)
    expect(isToolAllowedForLevel(L2, 'L2')).toBe(true)
    expect(isToolAllowedForLevel(L2, 'L1')).toBe(false)
    expect(isToolAllowedForLevel(L3, 'L3')).toBe(true)
    expect(isToolAllowedForLevel(L3, 'L2')).toBe(false)
  })

  it('assertToolAllowed 应匹配角色→等级映射（user=L1/admin=L2/super_admin=L3）', () => {
    // user (L1)
    expect(assertToolAllowed('user', L0).allowed).toBe(true)
    expect(assertToolAllowed('user', L1).allowed).toBe(true)
    expect(assertToolAllowed('user', L2).allowed).toBe(false)
    expect(assertToolAllowed('user', L3).allowed).toBe(false)
    // admin (L2)
    expect(assertToolAllowed('admin', L1).allowed).toBe(true)
    expect(assertToolAllowed('admin', L2).allowed).toBe(true)
    expect(assertToolAllowed('admin', L3).allowed).toBe(false)
    // super_admin (L3)
    expect(assertToolAllowed('super_admin', L2).allowed).toBe(true)
    expect(assertToolAllowed('super_admin', L3).allowed).toBe(true)
    // 未知角色降级 L1
    expect(assertToolAllowed('nobody', L1).allowed).toBe(true)
    expect(assertToolAllowed('nobody', L2).allowed).toBe(false)
  })

  it('assertToolAllowed 返回缺失维度与所需等级', () => {
    const r = assertToolAllowed('user', L3)
    expect(r).toMatchObject({ allowed: false, level: 'L3' })
    expect(r.missing).toBeInstanceOf(Array)
    // admin 访问 L3 敏感工具被拒
    expect(assertToolAllowed('admin', L3).level).toBe('L3')
  })

  it('getToolsForRole 应按角色过滤工具集并带 level 标签', () => {
    const tools = [L0, L1, L2, L3].map((name) => ({ type: 'function', function: { name } }))
    const asUser = getToolsForRole('user', tools)
    expect(asUser.map((t) => t.function.name)).toEqual(expect.arrayContaining([L0, L1]))
    expect(asUser.map((t) => t.function.name)).not.toContain(L2)
    expect(asUser.map((t) => t.function.name)).not.toContain(L3)
    expect(asUser[0].level).toBeDefined()

    const asAdmin = getToolsForRole('admin', tools)
    expect(asAdmin.map((t) => t.function.name)).toEqual(expect.arrayContaining([L0, L1, L2]))
    expect(asAdmin.map((t) => t.function.name)).not.toContain(L3)

    const asSuper = getToolsForRole('super_admin', tools)
    expect(asSuper.map((t) => t.function.name)).toEqual(expect.arrayContaining([L0, L1, L2, L3]))
  })
})

// ======================================================================
// 2. 写工具落库 + user_id 隔离
// ======================================================================
describe('写工具落库与 user_id 隔离', () => {
  let u1, u2

  beforeAll(async () => {
    u1 = await createUser(PHONE_U1)
    u2 = await createUser(PHONE_U2)
  })

  it('write_clip 应真实落库且只属于当前用户', async () => {
    const content = 'agent-写入-唯一内容-ABC'
    const r1 = await executeTool('write_clip', { content }, u1, 'user')
    const createdId1 = r1.id

    const row1 = await pool.query(
      'SELECT user_id, content_preview, content_type FROM clipboard_items WHERE id = $1',
      [createdId1]
    )
    expect(row1.rows).toHaveLength(1)
    expect(row1.rows[0].user_id).toBe(u1)
    expect(row1.rows[0].content_preview).toBe(content)
    expect(row1.rows[0].content_type).toBe('text')

    // 交换 userId 查询：u2 查不到 u1 的这条
    const cross = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [createdId1, u2]
    )
    expect(cross.rows).toHaveLength(0)
  })

  it('两个用户各写一条，互不可见', async () => {
    const a = await executeTool('write_clip', { content: 'per-user-A-content' }, u1, 'user')
    const b = await executeTool('write_clip', { content: 'per-user-B-content' }, u2, 'user')

    const aVisibleToB = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [a.id, u2]
    )
    const bVisibleToA = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [b.id, u1]
    )
    expect(aVisibleToB.rows).toHaveLength(0)
    expect(bVisibleToA.rows).toHaveLength(0)

    // 各有一条
    const aCount = await pool.query('SELECT COUNT(*)::int AS c FROM clipboard_items WHERE user_id = $1', [u1])
    const bCount = await pool.query('SELECT COUNT(*)::int AS c FROM clipboard_items WHERE user_id = $1', [u2])
    expect(aCount.rows[0].c).toBeGreaterThanOrEqual(1)
    expect(bCount.rows[0].c).toBeGreaterThanOrEqual(1)
  })

  // 源 bug 已修复（path 用 'root.'+uuid 去连字符，ltree 可解析）：
  //   create_collection 应真实落库并返回 collection 对象。
  it('create_collection 应真实落库并返回 collection（修复 ltree path）', async () => {
    const r1 = await executeTool('create_collection', { name: 'agent-collection-a' }, u1, 'admin')
    expect(r1.collection).toBeDefined()
    expect(r1.collection.id).toBeTruthy()
    expect(r1.collection.name).toBe('agent-collection-a')
    // 断言已落库
    const rows = await pool.query(
      "SELECT id, path::text AS path FROM favorite_collections WHERE user_id = $1 AND name = 'agent-collection-a'",
      [u1]
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].path).toMatch(/^root\.[a-z0-9_]+$/)
  })

  it('archive_items 应软删除当前用户的条目（archived=true）', async () => {
    const cid = await insertClip(u1, 'to-be-archived-content')

    const res = await executeTool('archive_items', { clip_ids: [cid] }, u1, 'user')
    expect(res.success).toBe(true)

    const row = await pool.query(
      'SELECT archived FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [cid, u1]
    )
    expect(row.rows[0].archived).toBe(true)

    // 授予 u2 也不应影响 u1 的数据可见性（不存在 u2 的该条）
    const other = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [cid, u2]
    )
    expect(other.rows).toHaveLength(0)
  })
})

// ======================================================================
// 3. destroy_clips 确认门控
// ======================================================================
describe('destroy_clips 确认门控', () => {
  let u1
  beforeAll(async () => {
    u1 = await createUser(PHONE_U1) // 幂等：ensureTestUser ON CONFLICT 返回同一 id
  })

  it('批准路径：确认后物理删除且返回 permanentlyDeleted', async () => {
    const cid = await insertClip(u1, 'destroy-approve-content')
    const reqId = uuidv4()
    const pending = executeTool(
      'destroy_clips',
      { clip_ids: [cid] },
      u1,
      'super_admin',
      reqId,
      { sendDelta: () => {} }
    )
    await tick()

    const approveRes = await approveToolRequest(reqId, u1, true)
    expect(approveRes.accepted).toBe(true)

    const final = await pending
    expect(final.permanentlyDeleted).toBe(1)

    const gone = await pool.query('SELECT id FROM clipboard_items WHERE id = $1', [cid])
    expect(gone.rows).toHaveLength(0)
  })

  it('拒绝路径：REJECTED_BY_USER 且数据仍在', async () => {
    const cid = await insertClip(u1, 'destroy-reject-content')
    const reqId = uuidv4()
    const pending = executeTool(
      'destroy_clips',
      { clip_ids: [cid] },
      u1,
      'super_admin',
      reqId,
      { sendDelta: () => {} }
    )
    await tick()

    const approveRes = await approveToolRequest(reqId, u1, false)
    expect(approveRes.accepted).toBe(false)

    const final = await pending
    expect(final).toEqual({ error: 'REJECTED_BY_USER' })

    const still = await pool.query('SELECT id FROM clipboard_items WHERE id = $1', [cid])
    expect(still.rows).toHaveLength(1)
  })

  it('跨用户审批禁止（userId 隔离）', async () => {
    const u2 = await createUser(PHONE_U2)
    const cid = await insertClip(u1, 'destroy-cross-user-content')
    const reqId = uuidv4()
    const pending = executeTool(
      'destroy_clips',
      { clip_ids: [cid] },
      u1,
      'super_admin',
      reqId,
      { sendDelta: () => {} }
    )
    await tick()

    // 用 u2 去审批 u1 的请求 → notFound，不执行
    const res = await approveToolRequest(reqId, u2, true)
    expect(res.accepted).toBe(false)
    expect(res.notFound).toBe(true)

    // 未被任何一方处理，撤销并结算，避免残留 pending
    cancelPendingForUser(u1)
    const final = await pending
    expect(final.error).toBe('REJECTED_BY_USER')

    const still = await pool.query('SELECT id FROM clipboard_items WHERE id = $1', [cid])
    expect(still.rows).toHaveLength(1)
  })

  it('cancelPendingForUser：断流后返回 REJECTED 且 pending 清空（不再被并发拒绝）', async () => {
    const cid = await insertClip(u1, 'destroy-cancel-content')
    const reqId = uuidv4()
    const pending = executeTool(
      'destroy_clips',
      { clip_ids: [cid] },
      u1,
      'super_admin',
      reqId,
      { sendDelta: () => {} }
    )
    await tick()

    cancelPendingForUser(u1)
    const final = await pending
    expect(final.error).toBe('REJECTED_BY_USER')

    // pending 应已清空：再次触发一个破坏性请求不应收到 CONCURRENT_CONFIRM_REQUEST
    // （若残留，第二次会返回 CONCURRENT_CONFIRM_REQUEST）
    const reqId2 = uuidv4()
    const pending2 = executeTool(
      'destroy_clips',
      { clip_ids: [cid] },
      u1,
      'super_admin',
      reqId2,
      { sendDelta: () => {} }
    )
    await tick()
    cancelPendingForUser(u1)
    const final2 = await pending2
    expect(final2.error).toBe('REJECTED_BY_USER')
    expect(final2.error).not.toBe('CONCURRENT_CONFIRM_REQUEST')

    // 数据仍在（未实际物理删除）
    const still = await pool.query('SELECT id FROM clipboard_items WHERE id = $1', [cid])
    expect(still.rows).toHaveLength(1)
  })

  it('并发破坏性请求：同一时刻仅允许一个 pending（返回 CONCURRENT_CONFIRM_REQUEST）', async () => {
    const c1 = await insertClip(u1, 'destroy-concurrent-1')
    const c2 = await insertClip(u1, 'destroy-concurrent-2')
    const reqId1 = uuidv4()
    const p1 = executeTool('destroy_clips', { clip_ids: [c1] }, u1, 'super_admin', reqId1, { sendDelta: () => {} })
    await tick()

    // 第二个破坏性请求：pending 非空 → 直接被拒
    const p2 = executeTool('destroy_clips', { clip_ids: [c2] }, u1, 'super_admin', uuidv4(), { sendDelta: () => {} })
    const final2 = await p2
    expect(final2.error).toBe('CONCURRENT_CONFIRM_REQUEST')

    // 结算第一个，避免残留
    cancelPendingForUser(u1)
    const final1 = await p1
    expect(final1.error).toBe('REJECTED_BY_USER')
  })
})

// ======================================================================
// 4. read_clip_content advanced 保护 + ephemeral 消息不落库
// ======================================================================
describe('读取隐私与 ephemeral 隔离', () => {
  let u1
  beforeAll(async () => {
    u1 = await createUser(PHONE_U1)
  })

  it('advanced 条目：即使传 password 也返回固定拒绝且不含明文', async () => {
    const SECRET = 'ADVANCED_SECRET_PLAINTEXT_99'
    const cid = await insertClip(u1, 'advanced-shown-preview', {
      protection_level: 'advanced',
      // 模拟服务端存储（内容已在 content_encrypted，前面 preview 未含明文秘密）
      content_encrypted: encrypt(`${SECRET}-stored-at-rest`),
    })

    const res = await executeTool(
      'read_clip_content',
      { clip_id: cid, password: 'any-pass' },
      u1,
      'user'
    )
    expect(res.error).toMatch(/高级密码保护/)
    expect(res.reason).toBe('advanced_protected')
    // 不返回明文
    expect(res.content).toBeUndefined()
    expect(JSON.stringify(res)).not.toContain(SECRET)
  })

  it('ephemeral 消息不落库：saveMessages 后 GET 对话不含它', async () => {
    // 为测试用户建一个对话
    const { rows } = await pool.query(
      `INSERT INTO ai_conversations (user_id, title, mode)
       VALUES ($1, 'agent-ops-ephemeral-test', 'ask') RETURNING id`,
      [TEST_USER_ID]
    )
    const convId = rows[0].id

    // 发送：一条普通 user 消息 + 一条 ephemeral 消息。
    // 携带 createdAt 模拟真实前端（useAiChat 总是随消息带回 created_at）。
    // 注：saveMessages 对未传 createdAt 的消息会把显式 NULL 写入 NOT NULL 的 created_at，
    //   属另一个源实现健壮性缺陷（见总结），与本处 ephemeral 语义无关，故此处避免触发。
    const now = new Date().toISOString()
    const save = await request(app)
      .post(`/api/ai/conversations/${convId}/messages`)
      .send({
        messages: [
          { role: 'user', content: 'PERSISTED_NORMAL_MESSAGE', createdAt: now },
          { role: 'user', content: 'EPHEMERAL_SHOULD_NOT_PERSIST', ephemeral: true, createdAt: now },
        ],
      })
    expect(save.status).toBe(201)
    expect(Array.isArray(save.body.messages)).toBe(true)
    expect(save.body.messages.length).toBe(1) // 仅普通消息被插入

    // GET 详情不含 ephemeral 消息
    const detail = await request(app).get(`/api/ai/conversations/${convId}`)
    expect(detail.status).toBe(200)
    const contents = detail.body.messages.map((m) => m.content)
    expect(contents).toContain('PERSISTED_NORMAL_MESSAGE')
    expect(contents).not.toContain('EPHEMERAL_SHOULD_NOT_PERSIST')

    // 直接查库确认不落库
    const db = await pool.query(
      'SELECT id FROM ai_messages WHERE conversation_id = $1',
      [convId]
    )
    expect(db.rows).toHaveLength(1)
  })
})

// ======================================================================
// 5. 工具调用产生 audit_logs 行
// ======================================================================
describe('工具调用审计（audit_logs）', () => {
  let u1
  beforeAll(async () => {
    u1 = await createUser(PHONE_U1)
  })

  it('成功工具调用写入 action=ai_tool_call & status=success', async () => {
    await executeTool('write_clip', { content: 'audit-success-content' }, u1, 'user')
    const rows = await pool.query(
      `SELECT details, status FROM audit_logs
       WHERE user_id = $1 AND action = 'ai_tool_call' AND details->>'tool' = $2`,
      [u1, 'write_clip']
    )
    expect(rows.rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.rows[0].status).toBe('success')
  })

  it('失败工具调用写入 action=ai_tool_call & status=failure', async () => {
    // write_clip 缺 content → 触发 { error } 失败路径
    const res = await executeTool('write_clip', { content: '' }, u1, 'user')
    expect(res.error).toBeDefined()

    const rows = await pool.query(
      `SELECT details, status FROM audit_logs
       WHERE user_id = $1 AND action = 'ai_tool_call' AND details->>'tool' = $2 AND status = 'failure'`,
      [u1, 'write_clip']
    )
    expect(rows.rows.length).toBeGreaterThanOrEqual(1)
  })

  it('敏感参数在审计中脱敏（password/content 不打全文）', async () => {
    const cid = await insertClip(u1, 'audit-sensitive', { protection_level: 'advanced' })
    await executeTool(
      'read_clip_content',
      { clip_id: cid, password: 'super-secret-123456' },
      u1,
      'user'
    )
    const rows = await pool.query(
      `SELECT details->>'args' AS args FROM audit_logs
       WHERE user_id = $1 AND action = 'ai_tool_call' AND details->>'tool' = $2`,
      [u1, 'read_clip_content']
    )
    expect(rows.rows.length).toBeGreaterThanOrEqual(1)
    // 脱敏后的 args 不应泄露原文密码
    expect(JSON.stringify(rows.rows[0].args)).not.toContain('super-secret-123456')
  })
})