/**
 * P0-B 修复 3：POST /api/versions/cleanup 越权清空全库版本历史
 *
 * 验证方式（绕开 NODE_ENV=test 的鉴权旁路）：
 *  1. 直接从 router.stack 取出 /cleanup 的中间件链，断言第一层是 requireRole(50)
 *     产生的管理员门槛，并用普通用户 / 管理员两种 roleLevel 直接调用它；
 *  2. 直接调用路由 handler，断言 retentionDays=0 / 负数 / 非数值被 400 拒绝，
 *     且拒绝时根本不会触达 cleanupOldVersions / limitVersionsPerItem（vi.mock 打桩）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/utils/versionManager.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    cleanupOldVersions: vi.fn(async () => 0),
    limitVersionsPerItem: vi.fn(async () => 0),
  }
})

const versionsRouter = (await import('../src/routes/versions.js')).default
const { cleanupOldVersions, limitVersionsPerItem } = await import('../src/utils/versionManager.js')

function findRouteHandlers(router, routePath, method) {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route?.methods?.[method])
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${routePath} not found`)
  return layer.route.stack.map((s) => s.handle)
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

const handlers = findRouteHandlers(versionsRouter, '/cleanup', 'post')
const adminGate = handlers[0]
const routeHandler = handlers[handlers.length - 1]

describe('POST /api/versions/cleanup 管理员门槛', () => {
  it('挂载了 requireRole(50)（普通用户 roleLevel=10 → 403，不触达清理逻辑）', () => {
    const res = fakeRes()
    let nextCalled = false
    adminGate({ user: { roleLevel: 10, userId: 'u1' } }, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(403)
    expect(res.body?.code).toBe(4030)
    expect(cleanupOldVersions).not.toHaveBeenCalled()
  })

  it('无 req.user（未认证装配错误）→ fail-closed 403', () => {
    const res = fakeRes()
    let nextCalled = false
    adminGate({}, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(403)
  })

  it('admin roleLevel=50 → 放行', () => {
    const res = fakeRes()
    let nextCalled = false
    adminGate({ user: { roleLevel: 50 } }, res, () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })

  it('super_admin roleLevel=100 → 放行', () => {
    const res = fakeRes()
    let nextCalled = false
    adminGate({ user: { roleLevel: 100 } }, res, () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })
})

describe('POST /api/versions/cleanup 参数下限校验', () => {
  const adminReq = (body) => ({ user: { roleLevel: 100 }, userId: 'u1', body })

  it('retentionDays=0 / maxVersionsPerItem=0（原攻击载荷）→ 400 且零删除调用', async () => {
    const res = fakeRes()
    await routeHandler(adminReq({ retentionDays: 0, maxVersionsPerItem: 0 }), res)
    expect(res.statusCode).toBe(400)
    expect(cleanupOldVersions).not.toHaveBeenCalled()
    expect(limitVersionsPerItem).not.toHaveBeenCalled()
  })

  it('负数 / 非数值 → 400', async () => {
    for (const body of [
      { retentionDays: -5, maxVersionsPerItem: 10 },
      { retentionDays: 30, maxVersionsPerItem: -1 },
      { retentionDays: 'abc', maxVersionsPerItem: 10 },
      { retentionDays: 30, maxVersionsPerItem: 'x' },
    ]) {
      const res = fakeRes()
      await routeHandler(adminReq(body), res)
      expect(res.statusCode).toBe(400)
    }
    expect(cleanupOldVersions).not.toHaveBeenCalled()
  })

  it('合法参数 → 200 并按传入值调用', async () => {
    const res = fakeRes()
    await routeHandler(adminReq({ retentionDays: 30, maxVersionsPerItem: 10 }), res)
    expect(res.statusCode).toBe(200)
    expect(cleanupOldVersions).toHaveBeenCalledWith(30)
    expect(limitVersionsPerItem).toHaveBeenCalledWith(10)
  })
})
