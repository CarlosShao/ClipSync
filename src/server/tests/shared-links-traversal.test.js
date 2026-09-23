/**
 * P0-B 修复 1：分享链接 fileKey 路径穿越（任意文件公开下载 + 递归删除）
 *
 * 覆盖：
 *  1. removeSharedLinkFiles 直接单测——file_key 重拼目录、file_path 投毒行不删、
 *     单层/越界/穿越路径一律跳过（这是原「fs.rm(path.dirname(file_path))」的攻击面）；
 *  2. HTTP 集成（NODE_ENV=test 鉴权旁路身份 = 固定测试用户）：
 *     - 创建链接时非 UUID fileKey（../../../ 穿越）→ 400；
 *     - 正常上传目录 → 创建 201 → 公开下载 200 → 撤销 204 且落盘目录被删；
 *     - 库里被投毒的 file_path（指向 /etc/passwd 形态的库外路径）→ 公开下载 404。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import pool from '../src/db/pool.js'
import { removeSharedLinkFiles } from '../src/routes/sharedLinks.js'

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'
const SHARED_BASE = path.resolve('uploads/shared')

let app
const createdUserIds = []
const madeDirs = []
const madeTokens = []
const stamp = Date.now().toString().slice(-6)

async function mkdirp(p) {
  await fs.mkdir(p, { recursive: true })
  madeDirs.push(p)
  return p
}

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db
  if (dbName !== 'clipsync_test') {
    throw new Error(`[p0b-shared] 仅允许在 clipsync_test 库运行，当前连接的是 ${dbName}`)
  }
  await pool.query(
    `INSERT INTO users (id, phone, password_hash, nickname, created_at, updated_at)
     VALUES ($1, '13900999999', 'test_hash', 'test_user', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID]
  )
  await fs.mkdir(SHARED_BASE, { recursive: true })
})

afterAll(async () => {
  for (const t of madeTokens) {
    await pool.query('DELETE FROM shared_links WHERE token = $1', [t]).catch(() => {})
  }
  for (const id of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  }
  for (const d of madeDirs) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('removeSharedLinkFiles — 删除目标只可能来自已校验的 fileKey', () => {
  it('file_key 合法：删除 base/<uuid> 目录', async () => {
    const key = randomUUID()
    const dir = await mkdirp(path.join(SHARED_BASE, key))
    await fs.writeFile(path.join(dir, 'f.txt'), 'x')
    const removed = await removeSharedLinkFiles([{ file_key: key, file_path: path.join(dir, 'f.txt') }])
    expect(removed).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })

  it('file_key 非法（穿越串）：跳过，不删任何东西', async () => {
    const sentinel = await mkdirp(path.join(SHARED_BASE, `sentinel-a-${stamp}`))
    await fs.writeFile(path.join(sentinel, 'keep.txt'), 'keep')
    const removed = await removeSharedLinkFiles([
      { file_key: '../../../etc', file_path: null },
      { file_key: `../${path.basename(sentinel)}`, file_path: null },
    ])
    expect(removed).toBe(0)
    expect(existsSync(path.join(sentinel, 'keep.txt'))).toBe(true)
  })

  it('无 file_key 的历史行：file_path 必须恰为 base/<uuid>/<file> 两层才删 <uuid> 目录', async () => {
    const key = randomUUID()
    const dir = await mkdirp(path.join(SHARED_BASE, key))
    const fp = path.join(dir, 'legacy.txt')
    await fs.writeFile(fp, 'x')
    const removed = await removeSharedLinkFiles([{ file_key: null, file_path: fp }])
    expect(removed).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })

  it('被投毒的 file_path（单层文件 / 库外绝对路径 / 穿越路径）：一律跳过', async () => {
    // base 下单层文件（旧实现 path.dirname 会直接删掉整个 SHARED_BASE！）
    const victim = path.join(SHARED_BASE, `victim-${stamp}.txt`)
    await fs.writeFile(victim, 'do-not-delete')
    const outside = path.join(path.resolve('uploads'), `outside-${stamp}.txt`)
    await fs.writeFile(outside, 'do-not-delete')
    const removed = await removeSharedLinkFiles([
      { file_key: null, file_path: victim },                 // rel 只有 1 层
      { file_key: null, file_path: outside },                 // base 之外
      { file_key: null, file_path: '/etc/passwd' },           // 系统路径
      { file_key: null, file_path: path.join(SHARED_BASE, '../../../etc') }, // 穿越
      { file_key: null, file_path: null },
    ])
    expect(removed).toBe(0)
    expect(existsSync(victim)).toBe(true)
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(SHARED_BASE)).toBe(true)
    await fs.unlink(victim).catch(() => {})
    await fs.unlink(outside).catch(() => {})
  })
})

describe('POST /api/shared-links — fileKey 强制 UUID + 边界校验', () => {
  const traversalKeys = [
    '../../../etc',
    '..',
    `${randomUUID()}/../../..`,
    '....//....//etc',
    '/etc',
    'C:\\Windows',
  ]
  for (const fileKey of traversalKeys) {
    it(`穿越 fileKey 被拒绝：${JSON.stringify(fileKey)}`, async () => {
      const res = await request(app)
        .post('/api/shared-links')
        .send({ contentType: 'file', fileKey, fileName: 'x.txt', fileSize: 1 })
      expect(res.status).toBe(400)
    })
  }

  it('格式合法但不存在的 fileKey → 400', async () => {
    const res = await request(app)
      .post('/api/shared-links')
      .send({ contentType: 'file', fileKey: randomUUID(), fileName: 'x.txt', fileSize: 1 })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('uploaded file not found')
  })

  it('正常流：真实上传目录 → 201 → 公开下载 200 → 撤销 204 且目录被删', async () => {
    const key = randomUUID()
    const dir = await mkdirp(path.join(SHARED_BASE, key))
    await fs.writeFile(path.join(dir, `${randomUUID()}.txt`), 'shared-payload')

    const created = await request(app)
      .post('/api/shared-links')
      .send({ contentType: 'file', fileKey: key, fileName: 'report.txt', fileSize: 14 })
    expect(created.status).toBe(201)
    const token = created.body.token
    madeTokens.push(token)

    const dl = await request(app).get(`/api/shared-links/public/${token}/download`)
    expect(dl.status).toBe(200)
    expect(String(dl.text ?? dl.body)).toContain('shared-payload')

    const del = await request(app).delete(`/api/shared-links/${created.body.id}`)
    expect(del.status).toBe(204)
    expect(existsSync(dir)).toBe(false)
  })

  it('库里被投毒的 file_path（库外路径）→ 公开下载 404，不提供任意文件', async () => {
    const token = `p0bpoison${stamp}`
    madeTokens.push(token)
    await pool.query(
      `INSERT INTO shared_links (user_id, token, content_encrypted, content_preview, content_type, file_path, file_key)
       VALUES ($1, $2, 'x', 'x', 'file', '/etc/passwd', NULL)`,
      [TEST_USER_ID, token]
    )
    const res = await request(app).get(`/api/shared-links/public/${token}/download`)
    expect(res.status).toBe(404)
  })
})
