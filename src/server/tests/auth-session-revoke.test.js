/**
 * P0-B 修复 5：DELETE /api/auth/sessions/:sessionId 吊销写错 Redis 键前缀
 *
 * 原实现手写 `blacklist:{sessionId}`，而全仓读的是 `bl:{jti}`（middleware/auth.js、
 * ws/server.js、utils/redis-client.js）。本项目 JWT 签发时 jti === sessionId
 * （auth.js createSessionAndGenerateToken / auth-refresh.js 均传 jti: sessionId），
 * 因此改用共享的 blacklistJti(sessionId) 即为吊销正确标识符。
 *
 * 验证方式：绕开 HTTP 层（NODE_ENV=test 鉴权旁路），从 router.stack 直接取
 * DELETE /sessions/:sessionId 的 handler，配真实 DB 会话行 + 真实 Redis 调用，
 * 断言 bl:{sessionId} 可读、旧键 blacklist:{sessionId} 不再写入。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import pool from '../src/db/pool.js'
import redisUtils, { isJtiBlacklisted } from '../src/utils/redis-client.js'

const authSessionRouter = (await import('../src/routes/auth-session.js')).default

function findRouteHandlers(router, routePath, method) {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route?.methods?.[method])
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${routePath} not found`)
  return layer.route.stack.map((s) => s.handle)
}

const deleteHandler = (() => {
  const hs = findRouteHandlers(authSessionRouter, '/sessions/:sessionId', 'delete')
  return hs[hs.length - 1]
})()

const stamp = Date.now().toString().slice(-6)
const createdUserIds = []
const createdSessionIds = []

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

async function createUserAndSession() {
  const n = createdUserIds.length
  const { rows } = await pool.query(
    `INSERT INTO users (phone, password_hash, nickname, created_at, updated_at)
     VALUES ($1, 'test_hash', $2, NOW(), NOW()) RETURNING id`,
    [`1392${stamp}${n}`.slice(0, 11), `p0b_sess_${stamp}_${n}`]
  )
  createdUserIds.push(rows[0].id)
  const sessionId = randomUUID()
  await pool.query(
    `INSERT INTO user_sessions (id, user_id, device_name, device_type, platform, is_active, created_at)
     VALUES ($1, $2, 'p0b-device', 'desktop', 'windows', TRUE, NOW())`,
    [sessionId, rows[0].id]
  )
  createdSessionIds.push(sessionId)
  return { userId: rows[0].id, sessionId }
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db
  if (dbName !== 'clipsync_test') {
    throw new Error(`[p0b-session] 仅允许在 clipsync_test 库运行，当前连接的是 ${dbName}`)
  }
})

afterAll(async () => {
  const client = await redisUtils.getRedisClient().catch(() => null)
  for (const sid of createdSessionIds) {
    if (client) await client.del(`bl:${sid}`).catch(() => {})
    if (client) await client.del(`blacklist:${sid}`).catch(() => {})
  }
  for (const id of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  }
})

describe('DELETE /api/auth/sessions/:sessionId 吊销生效', () => {
  it('终止会话后 bl:{sessionId}（jti 黑名单，全仓读取口径）立即可查', async () => {
    const { userId, sessionId } = await createUserAndSession()
    expect(await isJtiBlacklisted(sessionId)).toBe(false)

    const res = fakeRes()
    await deleteHandler({ user: { userId }, params: { sessionId } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body?.message).toBe('Session terminated')

    // 关键断言：middleware/auth.js 与 ws/server.js 读的是 bl:{jti}（jti === sessionId）
    expect(await isJtiBlacklisted(sessionId)).toBe(true)

    // DB 会话同步失活
    const { rows } = await pool.query('SELECT is_active FROM user_sessions WHERE id = $1', [sessionId])
    expect(rows[0].is_active).toBe(false)
  })

  it('不再写旧的手抄键 blacklist:{sessionId}（该键无人读取，是原 bug 的成因）', async () => {
    const { userId, sessionId } = await createUserAndSession()
    const res = fakeRes()
    await deleteHandler({ user: { userId }, params: { sessionId } }, res)
    expect(res.statusCode).toBe(200)

    const client = await redisUtils.getRedisClient()
    const legacy = await client.get(`blacklist:${sessionId}`)
    expect(legacy).toBeNull()
  })

  it('他人会话 → 404，不写黑名单', async () => {
    const { sessionId } = await createUserAndSession()
    const stranger = randomUUID()
    const res = fakeRes()
    await deleteHandler({ user: { userId: stranger }, params: { sessionId } }, res)
    expect(res.statusCode).toBe(404)
    expect(await isJtiBlacklisted(sessionId)).toBe(false)
  })
})
