import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'

/**
 * POST /api/feedback —— 应用内反馈工单
 *
 * 钉住迁移 079 注释里那两条**不可让步的语义**：
 *   1. 落库为主：INSERT 成功即接口成功（用户绝不会因 SMTP 出问题而丢反馈）；
 *   2. 发信尽力而为：未真实投递一律 email_sent=false，**不在库里留"已发送"的假结论**。
 * 另覆盖校验（400 + 稳定机器码）与鉴权（401）。
 *
 * 说明：本环境通常没有可用 SMTP，因此 emailSent 期望为 false —— 这本身就是第 2 条断言的证据
 * （接口没有假装发成功）。若将来在 CI 里配了 SMTP，把这条改为"允许 true 或 false，但必须与库里
 * email_sent 一致"即可。
 */

let app
let auth

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
})

afterAll(async () => {
  await pool.query("DELETE FROM feedback_tickets WHERE user_id = $1 AND title LIKE '[test]%'", [TEST_USER_ID])
})

const post = (body) => request(app).post('/api/feedback').set(auth).send(body)
const postNoAuth = (body) => request(app).post('/api/feedback').send(body)

describe('POST /api/feedback', () => {
  it('正常提交：200 + 直连查库能看到该工单，且 emailSent 与库里 email_sent 一致', async () => {
    const body = {
      title: '[test] 反馈工单回归',
      category: 'bug',
      content: '这是一条回归测试写入的工单正文。',
      contact: 'tester@example.com',
      appVersion: '0.1.1',
      platform: 'win32',
    }
    const res = await post(body)
    expect(res.status, `应 200：${JSON.stringify(res.body)}`).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.id).toBeTruthy()

    const row = (
      await pool.query(
        'SELECT title, category, content, contact, app_version, platform, status, email_sent FROM feedback_tickets WHERE id = $1',
        [res.body.id],
      )
    ).rows[0]
    expect(row, '工单必须真的落库').toBeTruthy()
    expect(row.title).toBe(body.title)
    expect(row.category).toBe('bug')
    expect(row.content).toBe(body.content)
    expect(row.contact).toBe('tester@example.com')
    expect(row.status).toBe('open')

    // 第 2 条语义：库里 email_sent 必须与接口回的 emailSent 一致（不许"库里说发了"）
    expect(row.email_sent).toBe(res.body.emailSent)
    // 本环境无 SMTP ⇒ 应为 false（未真实投递就不能标已发送）
    expect(res.body.emailSent).toBe(false)
  })

  it('分类缺省 → other（不因缺省而 400）', async () => {
    const res = await post({ title: '[test] 无分类', content: '正文' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const row = (await pool.query('SELECT category FROM feedback_tickets WHERE id = $1', [res.body.id])).rows[0]
    expect(row.category).toBe('other')
  })

  it('缺标题 → 400 FEEDBACK_TITLE_REQUIRED', async () => {
    const res = await post({ content: '只有正文' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('FEEDBACK_TITLE_REQUIRED')
  })

  it('缺正文 → 400 FEEDBACK_CONTENT_REQUIRED', async () => {
    const res = await post({ title: '只有标题' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('FEEDBACK_CONTENT_REQUIRED')
  })

  it('未认证 → 401（且不落库）', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM feedback_tickets')).rows[0].n
    const res = await postNoAuth({ title: '[test] 未认证', content: 'x' })
    expect(res.status).toBe(401)
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM feedback_tickets')).rows[0].n
    expect(after).toBe(before)
  })
})
