/**
 * 已审核 v2 RBAC 方案 —— 新增能力测试骨架
 *
 * 聚焦（与 ai-agent-ops.test.js 不重复）：
 *  W1-A 超管保护迁移（037 触发器）：唯一超管约束（真实 DB，事务内）
 *  W1-B levels 修正与角色等级读库驱动：getToolLevel / assertToolAllowed 纯函数
 *  W2-D 17 个管理工具 schema 与等级登记（待实现占位）
 *  W2-E 确认门控核算（DESTRUCTIVE_CONFIRM_NEEDED 覆盖范围，待实现占位）
 *
 * 工程约定：
 *  1. 每条用例在 withTransaction 事务内执行，afterEach 由 helper ROLLBACK，零清理成本。
 *  2. 本文件跳过数据库迁移执行（测试环境已预置 037 触发器 / 028 角色种子），
 *     不要在测试里手动跑迁移。
 *  3. 尚未实现/尚未登记的用例一律 it.skip 占位，并注释「W2 实现后启用」。
 *
 * 当前实现状态说明（feature/ai-rbac-backend）：
 *  - 15 个后台管理工具（任务口径 17，剩余 2 个待 W2 补充）在 aiTools.js TOOLS
 *    与 aiSystemPrompt.js levels 矩阵中都尚未登记，故 W2-D/W2-E 整块为占位。
 *  - destroy_clips 现登记为 L2（v2 将提升至 L3）、创建类现登记为 L2（v2 将降为 L1）、
 *    assertToolAllowed 尚不支持 roleLevel 参数 —— 这些 W1-B 断言按规则 it.skip。
 */
import { describe, it, expect } from 'vitest'
import { withTransaction } from './test-helpers.js'
import pool from '../src/db/pool.js'
import { getToolLevel, assertToolAllowed } from '../src/utils/aiSystemPrompt.js'
import { TOOLS, DESTRUCTIVE_CONFIRM_NEEDED, executeTool } from '../src/routes/aiTools.js'

// ---- W1-A 局部辅助 -----------------------------------------------------
// 确保 super_admin 角色行存在（幂等：迁移 028 已播种则复用），返回 role_id。
async function ensureSuperRole(client) {
  await client.query(
    `INSERT INTO roles (role_key, name, level, is_system, is_assignable, description)
     VALUES ('super_admin', '超级管理员', 100, TRUE, TRUE, '产品所有者/开发者')
     ON CONFLICT (role_key) DO NOTHING`
  )
  const { rows } = await client.query(`SELECT id FROM roles WHERE role_key = 'super_admin'`)
  return rows[0].id
}

// 幂等确保至少存在一个超管用户（迁移 028 已播种 13505110772 则复用，否则补建），返回超管 id。
// 注意：不能无条件再插一个超管——037 触发器会因已存在超管而拒绝。
async function ensureSuperAdmin(client, roleId, phone) {
  const { rows } = await client.query('SELECT id FROM users WHERE role_id = $1 ORDER BY created_at LIMIT 1', [roleId])
  if (rows[0]) return rows[0].id
  const r = await client.query(
    `INSERT INTO users (phone, password_hash, nickname, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
    [phone, 'test_hash', `test_${phone}`, roleId]
  )
  return r.rows[0].id
}

// 新建指定 role 的用户（用于被触发器的 INSERT 拒绝、或被 UPDATE 升级的场景）
function insertUserWithRole(client, phone, roleId) {
  return client.query(
    `INSERT INTO users (phone, password_hash, nickname, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
    [phone, 'test_hash', `test_${phone}`, roleId]
  )
}

// 新建一个无角色（普通）用户
async function insertPlainUser(client, phone) {
  const r = await client.query(
    `INSERT INTO users (phone, password_hash, nickname, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id`,
    [phone, 'test_hash', `test_${phone}`]
  )
  return r.rows[0].id
}

// ======================================================================
// W1-A：超管保护迁移（037 触发器）—— 需真实 DB
// ======================================================================
// 需要测试环境预置 037 触发器（BEFORE INSERT OR UPDATE OF role_id OR DELETE ON users）。
// 每例在事务内运行；RAISE 会使事务进入 aborted 态，故被拒绝的语句都放在用例末尾。
describe('W1-A：超管保护迁移（037 触发器）', () => {
  it('插入第二个 super_admin 用户被 RAISE 拒绝（SUPER_ADMIN_EXISTS_ALREADY）', async () => {
    await withTransaction(async ({ client }) => {
      const superRole = await ensureSuperRole(client)
      await ensureSuperAdmin(client, superRole, '13900000101') // 已存在一个超管

      const second = insertUserWithRole(client, '13900000102', superRole)
      await expect(second).rejects.toThrow('SUPER_ADMIN_EXISTS_ALREADY')
    })
  })

  it('DELETE super_admin 用户被拒（SUPER_ADMIN_DELETE_FORBIDDEN）', async () => {
    await withTransaction(async ({ client }) => {
      const superRole = await ensureSuperRole(client)
      const superId = await ensureSuperAdmin(client, superRole, '13900000103')

      await expect(client.query('DELETE FROM users WHERE id = $1', [superId])).rejects.toThrow(
        'SUPER_ADMIN_DELETE_FORBIDDEN'
      )
    })
  })

  it('UPDATE 用户 role_id 为超管，当已存在超管时被拒', async () => {
    await withTransaction(async ({ client }) => {
      const superRole = await ensureSuperRole(client)
      await ensureSuperAdmin(client, superRole, '13900000104') // 已存在一个超管
      const normalId = await insertPlainUser(client, '13900000105')

      await expect(
        client.query('UPDATE users SET role_id = $1 WHERE id = $2', [superRole, normalId])
      ).rejects.toThrow('SUPER_ADMIN_EXISTS_ALREADY')
    })
  })

  it('删除普通用户成功（不受触发器阻碍）', async () => {
    await withTransaction(async ({ client }) => {
      const superRole = await ensureSuperRole(client)
      await ensureSuperAdmin(client, superRole, '13900000106')
      const normalId = await insertPlainUser(client, '13900000107')

      const del = await client.query('DELETE FROM users WHERE id = $1', [normalId])
      expect(del.rowCount).toBe(1)
    })
  })
})

// ======================================================================
// W1-B：levels 修正与角色等级读库驱动 —— 纯函数
// ======================================================================
describe('W1-B：levels 修正与角色等级读库驱动（纯函数）', () => {
  it('getToolLevel 未登记工具按最小权限兜底返回 L0', () => {
    expect(getToolLevel('tool_not_registered')).toBe('L0')
  })

  it('getToolLevel：v1 补登记的四个 L1 操作级写/批量工具等级正确', () => {
    // Agent-B/C 写工具面补登记（batch_* / tag / unarchive 等）
    for (const t of ['batch_favorite', 'batch_delete', 'tag_items', 'unarchive_items']) {
      expect(getToolLevel(t)).toBe('L1')
    }
  })

  it('assertToolAllowed：user 无法调用破坏性工具 destroy_clips', () => {
    // user=L1，破坏性工具最低 L2 起 → 拒绝
    expect(assertToolAllowed('user', 'destroy_clips').allowed).toBe(false)
  })

  it('assertToolAllowed：super_admin 可调用破坏性工具 destroy_clips', () => {
    // super_admin=L3 继承 ≥L2 → 放行
    expect(assertToolAllowed('super_admin', 'destroy_clips').allowed).toBe(true)
  })

  it('getToolLevel：v2 将 destroy_clips 从 L2 提升为 L3', () => {
    expect(getToolLevel('destroy_clips')).toBe('L3')
  })
  // RBACv2 已落地：levels 中 destroy_clips 位于 L3（物理删除属破坏性超管动作）

  it('getToolLevel：四个创建类工具降级为 L1', () => {
    // RBACv2 将创建类从 L2 下调至 L1 操作级
    for (const t of ['create_collection', 'create_template', 'create_shared_link', 'create_sub_collection']) {
      expect(getToolLevel(t)).toBe('L1')
    }
  })

  it('assertToolAllowed 带 roleLevel 参数：数值等级优先于 roleKey', () => {
    // 第三个参数 roleLevel（数值）优先于 roleKey 映射 —— 角色等级改为读库驱动后生效
    expect(assertToolAllowed('user', 'get_security_overview', 100).allowed).toBe(true)
    // 数值不足时仍拒绝
    expect(assertToolAllowed('super_admin', 'get_security_overview', 1).allowed).toBe(false)
  })
})

// ======================================================================
// W2-D：17 个管理工具 schema 与等级登记 —— 待实现占位
// ======================================================================
describe('W2-D：17 个管理工具 schema 与等级登记（待实现）', () => {
  // 后台管理工具面（任务口径 17 个；当前给出 15 个，剩余 2 个待 W2 补充）
  const MANAGEMENT_TOOLS = [
    'list_users', 'create_user', 'update_user_role', 'delete_user', 'reset_user_password',
    'disable_user', 'get_system_config', 'get_audit_logs', 'update_system_config', 'toggle_feature',
    'list_all_devices', 'unpair_device', 'upgrade_subscription', 'downgrade_subscription',
    'create_sub_collection',
  ]

  it('管理工具清单：当前 15 个已登记名称均为后台工具面（结构占位，不校验通过）', () => {
    // 结构骨架：仅验证清单非空且无重复，实际等级登记校验在下方 skip 用例
    expect(MANAGEMENT_TOOLS.length).toBeGreaterThanOrEqual(15)
    expect(new Set(MANAGEMENT_TOOLS).size).toBe(MANAGEMENT_TOOLS.length)
  })

  it('TOOLS 名称集合与 aiSystemPrompt levels 矩阵一致性：新工具名必须在 levels 有登记', () => {
    // 遍历 aiTools.js 全部工具名，每个都应是 TOOLS 中的合法工具；管理面工具须命中 levels（非默认 L0 兜底）。
    // 注：只读/老工具（如 search_clips / get_clip_details 等）按设计默认 L0 全开放，故此处只对管理面做非 L0 断言。
    const toolNames = [...new Set(TOOLS.map((t) => t.function.name))]
    for (const name of MANAGEMENT_TOOLS) {
      expect(toolNames).toContain(name)          // schema 已登记进 TOOLS
      expect(getToolLevel(name)).not.toBe('L0')  // levels 矩阵已登记（非 L0 兜底）
    }
  })
  // 管理工具 schema（TOOLS）与 levels 等级矩阵已同步登记（RBACv2）

  it('管理工具的 executeToolInner 可被 super_admin 调用（含运行时 RBAC 校验）', async () => {
    // RBAC 由 executeTool 的 role 参数驱动，操作者无需真是库内超管，故用普通用户 id 作 actor 即可。
    // 先造持久化 fixture（executeTool 走全局连接池，须已提交后可被看到），结束前统一清理。
    await pool.query(`DELETE FROM users WHERE phone IN ('13700000121', '13700000122')`)
    const actorRes = await pool.query(
      `INSERT INTO users (phone, password_hash, nickname, created_at, updated_at)
       VALUES ('13700000121', 'h', 'rbac-actor', NOW(), NOW()) RETURNING id`
    )
    const actorId = actorRes.rows[0].id

    try {
      // create_user（非确认）：超管可真实落库
      const cu = await executeTool('create_user', { phone: '13700000122', password: 'TestPass123', nickname: 'target' }, actorId, 'super_admin')
      expect(cu.success).toBe(true)
      const targetId = cu.user.id

      // disable_user（B7 后纳入确认集）：无 SSE 通道 → REJECTED_BY_USER，账号未被停用
      const dis = await executeTool('disable_user', { user_id: targetId, reason: 'rbac-test' }, actorId, 'super_admin')
      expect(dis.error).toBe('REJECTED_BY_USER')
      expect(dis.code ?? '').not.toBe('ROLE_FORBIDDEN')

      // upgrade_subscription（非确认）
      const ups = await executeTool('upgrade_subscription', { user_id: targetId, plan: 'Free' }, actorId, 'super_admin')
      expect(ups.success).toBe(true)

      // 只读类（非确认）：均成功返回数据
      expect((await executeTool('list_users', {}, actorId, 'super_admin')).users).toBeDefined()
      expect((await executeTool('get_system_config', {}, actorId, 'super_admin')).configs).toBeDefined()
      expect((await executeTool('get_audit_logs', {}, actorId, 'super_admin')).logs).toBeDefined()
      expect((await executeTool('list_all_devices', {}, actorId, 'super_admin')).devices).toBeDefined()

      // create_sub_collection（非确认）：需一个父收藏夹，用 create_collection 建（L1 亦对超管开放）
      const parent = await executeTool('create_collection', { name: 'rbac-parent-c' }, actorId, 'super_admin')
      expect(parent.collection && parent.collection.id).toBeTruthy()
      const sub = await executeTool('create_sub_collection', { name: 'rbac-sub-c', parent_id: parent.collection.id }, actorId, 'super_admin')
      expect(sub.collection && sub.collection.id).toBeTruthy()

      // 确认门控类（DESTRUCTIVE_CONFIRM_NEEDED 中属于管理面的 8 个，含 B7 的 disable_user）：
      // 无 SSE 通道 → REJECTED_BY_USER 而非 FORBIDDEN，
      // 证明超管已通过 RBAC 闸门（否则会返回 code=ROLE_FORBIDDEN）。
      const confirmArgs = {
        update_user_role: { user_id: targetId, role: 'admin' },
        delete_user: { user_id: targetId },
        reset_user_password: { user_id: targetId },
        disable_user: { user_id: targetId },
        update_system_config: { config_key: 'ai_max_tokens', config_value: 4096 },
        toggle_feature: { flag_key: 'enable_ai_agent', enabled: true },
        unpair_device: { device_id: '00000000-0000-0000-0000-00000000dead' },
        downgrade_subscription: { user_id: targetId, plan: 'Free' },
      }
      const confirmedMgmt = ['update_user_role', 'delete_user', 'reset_user_password', 'disable_user', 'update_system_config', 'toggle_feature', 'unpair_device', 'downgrade_subscription']
      for (const name of confirmedMgmt) {
        const r = await executeTool(name, confirmArgs[name], actorId, 'super_admin')
        expect(r.error).toBe('REJECTED_BY_USER')
        expect(r.code).not.toBe('ROLE_FORBIDDEN')
      }

      // 兜底：全部 15 个管理工具对超管 RBAC 均放行（纯函数断言）
      for (const name of MANAGEMENT_TOOLS) {
        expect(assertToolAllowed('super_admin', name).allowed).toBe(true)
      }
    } finally {
      // 清理本用例产生的持久化数据（普通用户删库不受 037 触发器阻碍）
      await pool.query(`DELETE FROM favorite_collections WHERE user_id = $1`, [actorId]).catch(() => {})
      await pool.query(`DELETE FROM devices WHERE user_id = ANY(ARRAY[$1::uuid])`, [actorId]).catch(() => {})
      await pool.query(`DELETE FROM users WHERE phone IN ('13700000121','13700000122')`).catch(() => {})
    }
  }, 15000)
  // W2 实现后启用：executeToolInner 在 RBACv2 下对超管全放行，且各工具有真实落库实现
})

// ======================================================================
// W2-E：确认门控核算 —— 待实现占位
// ======================================================================
describe('W2-E：确认门控核算（待实现）', () => {
  it('DESTRUCTIVE_CONFIRM_NEEDED 覆盖敏感工具（破坏性/跨用户）', () => {
    const EXPECTED = [
      'delete_user',
      'destroy_clips',
      'unpair_device',
      'downgrade_subscription',
      'toggle_feature',
      'update_system_config',
      'update_user_role',
      'reset_user_password',
      'disable_user',
      'delete_collection',
      'unpair_own_device',
      'terminate_session',
      'restore_version',
    ]
    expect(EXPECTED).toHaveLength(13)
    for (const name of EXPECTED) {
      expect(DESTRUCTIVE_CONFIRM_NEEDED.has(name)).toBe(true)
    }
    // 精确对齐：确认集合不应含集合外多余工具（防漏登记/多登记）
    expect(DESTRUCTIVE_CONFIRM_NEEDED.size).toBe(13)
  })
})