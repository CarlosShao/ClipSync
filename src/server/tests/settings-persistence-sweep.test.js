import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'

/**
 * 设置项持久化「地毯式」回归测试（由临时探针转正）。
 *
 * 由来：用户反馈"有些设置项不入库，刷新又回到未配置"。这条测试把设置类读写表面
 * 全部打一遍（PUT → GET → **直连查库**），用运行时证据找出存不住的项。
 * 已知并已修的产出：
 *   · AI 设置：sanitize 合并基准用错对象（改一个清一个）—— 见 ai-settings-persistence.test.js
 *   · 同意记录 user_consents：表从未建过（本文件 probe 抓出）—— 迁移 080 修复
 *   · DELETE /sessions/:sessionId：非 UUID 参数 500 → 已改 400
 * 新增设置项时，建议在这里补一条 PUT→GET→DB 断言。
 */

let app
let auth

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
})

describe('probe: 通知偏好', () => {
  it('PUT→GET→DB', async () => {
    const put = await request(app)
      .put('/api/notifications/preferences')
      .set(auth)
      .send({ notificationType: 'device_online', enabled: false })
    console.log('NOTIF PUT', put.status, JSON.stringify(put.body))
    const get = await request(app).get('/api/notifications/preferences').set(auth)
    console.log('NOTIF GET', get.status, JSON.stringify(get.body))
    const row = await pool.query(
      'SELECT enabled FROM notification_preferences WHERE user_id = $1 AND notification_type = $2',
      [TEST_USER_ID, 'device_online'],
    )
    console.log('NOTIF DB', JSON.stringify(row.rows))
    expect(put.status).toBe(200)
  })
})

describe('probe: 模板变量', () => {
  it('PUT(全量)→GET→DB', async () => {
    const put = await request(app).put('/api/template-variables').set(auth).send({ name: 'probe_var', value: 'v1' })
    console.log('TV PUT', put.status, JSON.stringify(put.body))
    const get = await request(app).get('/api/template-variables').set(auth)
    console.log('TV GET', get.status, JSON.stringify(get.body))
    const row = await pool.query('SELECT value FROM template_variables WHERE user_id = $1 AND name = $2', [
      TEST_USER_ID,
      'probe_var',
    ])
    console.log('TV DB', JSON.stringify(row.rows))
    expect(put.status).toBe(200)
  })

  it('PUT(只给 name，缺 value) 语义', async () => {
    const put = await request(app).put('/api/template-variables').set(auth).send({ name: 'probe_var2' })
    console.log('TV PARTIAL PUT', put.status, JSON.stringify(put.body))
  })
})

describe('probe: 工作流规则', () => {
  it('POST→GET→PUT 全量→PUT 局部', async () => {
    const post = await request(app)
      .post('/api/workflow-rules')
      .set(auth)
      .send({
        name: 'probe rule',
        enabled: true,
        contentType: 'link',
        matchMode: 'keyword',
        keywords: ['probe-kw'],
        actionType: 'tag',
        actionValue: 'probe-tag',
        actionApplyTags: ['probe-tag'],
        priority: 42,
      })
    console.log('WF POST', post.status, JSON.stringify(post.body))
    const id = post.body?.id
    const get1 = await request(app).get('/api/workflow-rules').set(auth)
    console.log('WF GET1', get1.status, JSON.stringify(get1.body))
    if (id) {
      const putPartial = await request(app).put(`/api/workflow-rules/${id}`).set(auth).send({ name: 'renamed only' })
      console.log('WF PUT PARTIAL', putPartial.status, JSON.stringify(putPartial.body))
      const get2 = await request(app).get('/api/workflow-rules').set(auth)
      console.log('WF GET2', get2.status, JSON.stringify(get2.body?.items?.filter((r) => r.id === id)))
      await request(app).delete(`/api/workflow-rules/${id}`).set(auth)
    }
    expect(post.status).toBe(201)
  })
})

describe('probe: 用户资料', () => {
  it('PUT nickname/email→GET /me→DB', async () => {
    const put = await request(app)
      .put('/api/auth/profile')
      .set(auth)
      .send({ nickname: 'probe_nick', email: 'probe_settings@example.com' })
    console.log('PROFILE PUT', put.status, JSON.stringify(put.body))
    const me = await request(app).get('/api/auth/me').set(auth)
    console.log('PROFILE ME', me.status, JSON.stringify(me.body))
    const row = await pool.query('SELECT nickname, email, email_hash, email_encrypted FROM users WHERE id = $1', [
      TEST_USER_ID,
    ])
    console.log('PROFILE DB', JSON.stringify(row.rows))
    expect(put.status).toBe(200)
  })
})

describe('probe: 同意记录', () => {
  it('PUT consent 走真实生效的处理器（users 表列，而非 user_consents）', async () => {
    // 注意：同路径有两个处理器，**生效的是 src/routes/auth.js 里那个**，
    // 它 UPDATE users 的 consent 列，契约是 { functional_consent / marketing_consent / … }；
    // src/routes/auth-profile.js 里那个 INSERT user_consents 的处理器被遮蔽（死代码，
    // 而且 user_consents 表从未建过）—— 本用例原来按死代码的契约发请求，于是收到 400。
    const put = await request(app)
      .put('/api/auth/consent')
      .set(auth)
      .send({ functional_consent: true })
    console.log('CONSENT PUT', put.status, JSON.stringify(put.body))
    expect(put.status, 'PUT /api/auth/consent 应 200：' + JSON.stringify(put.body)).toBe(200)

    // 直连查库确认真的落到了 users 表
    const row = await pool.query('SELECT functional_consent FROM users WHERE id = $1', [TEST_USER_ID])
    console.log('CONSENT DB', JSON.stringify(row.rows))
    expect(row.rows[0]?.functional_consent).toBe(true)
  })
})

describe('probe: 只读设置面', () => {
  it('GET sessions / 2fa status / subscriptions current', async () => {
    const s = await request(app).get('/api/sessions').set(auth)
    console.log('SESSIONS', s.status, JSON.stringify(s.body))
    const t = await request(app).get('/api/auth/2fa/status').set(auth)
    console.log('2FA', t.status, JSON.stringify(t.body))
    const c = await request(app).get('/api/subscriptions/current').set(auth)
    console.log('SUB CURRENT', c.status, JSON.stringify(c.body))
  })
})
