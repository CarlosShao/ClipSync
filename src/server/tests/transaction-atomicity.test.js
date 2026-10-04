/**
 * 审计 H3（S0）回归：事务必须跑在同一条物理连接上
 *
 * 背景（修复前）：aiConversations 的「先 DELETE 再全量 INSERT」、favorites 与 aiTools 的
 * reorder 都写成 pool.query('BEGIN'/'COMMIT'/'ROLLBACK')。pool.query 每次可能取到不同
 * 物理连接，事务是假的——中途失败无法回滚（AI 对话消息被不可逆清空），且残留未结束事务
 * 的连接被放回连接池后会污染后续请求。
 *
 * 本文件钉住修复后的行为（3 个站点各一条）：
 *  1. POST /api/ai/conversations/:id/messages 中途失败 ⇒ ROLLBACK，原有消息仍在（H3 核心场景）
 *  2. PUT  /api/favorites/collections/reorder 中途失败 ⇒ ROLLBACK，先前的 UPDATE 不生效
 *  3. aiTools reorder_collections 成功路径仍正常提交（验证改动没有破坏 happy path）
 *
 * 工程约定：被测代码不做任何修改；本文件自建用户（13800 号段，setup.js 会清理）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { getTestApp, ensureTestUser, authHeaders } from './test-helpers.js';
import { executeTool } from '../src/routes/aiTools.js';

const PHONE_H3 = '13800000301';

let app;
let userId;
let auth;

async function withClient(fn) {
  const { client } = await import('./test-helpers.js').then((m) => m.getTestDb());
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

describe('H3：事务原子性（BEGIN/COMMIT/ROLLBACK 与业务语句同连接）', () => {
  beforeAll(async () => {
    ({ app } = await getTestApp());
    userId = await withClient((client) => ensureTestUser(client, PHONE_H3));
    auth = authHeaders({ userId, phone: PHONE_H3 });
  });

  afterAll(async () => {
    try {
      await pool.query(
        `DELETE FROM ai_messages WHERE conversation_id IN
           (SELECT id FROM ai_conversations WHERE user_id = $1)`,
        [userId]
      );
      await pool.query('DELETE FROM ai_conversations WHERE user_id = $1', [userId]);
      await pool.query(
        `DELETE FROM favorite_collection_items WHERE collection_id IN
           (SELECT id FROM favorite_collections WHERE user_id = $1)`,
        [userId]
      );
      await pool.query('DELETE FROM favorite_collections WHERE user_id = $1', [userId]);
    } catch (e) {
      console.warn('H3 测试数据清理跳过:', e.message);
    }
  });

  it('保存消息中途失败：DELETE 被回滚，原有消息不丢失', async () => {
    const conv = await pool.query(
      `INSERT INTO ai_conversations (user_id, title, mode)
       VALUES ($1, 'h3-tx-rollback', 'ask') RETURNING id`,
      [userId]
    );
    const convId = conv.rows[0].id;

    await pool.query(
      `INSERT INTO ai_messages (conversation_id, role, content)
       VALUES ($1, 'user', 'ORIGINAL_MESSAGE_H3')`,
      [convId]
    );

    // 第一条消息合法（会被 INSERT 进来），第二条 role 违反 ai_messages 的 CHECK 约束，
    // 在事务中途抛错 ⇒ 必须整体回滚，包括前面已经执行的 DELETE。
    const res = await request(app)
      .post(`/api/ai/conversations/${convId}/messages`)
      .set(auth)
      .send({
        messages: [
          { role: 'user', content: 'PARTIAL_INSERT_H3', createdAt: new Date().toISOString() },
          { role: 'not_a_valid_role', content: 'BOOM_H3', createdAt: new Date().toISOString() },
        ],
      });

    expect(res.status).toBe(500);

    const after = await pool.query(
      'SELECT content FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at',
      [convId]
    );
    // 原有消息还在，且半截插入的消息也不存在（真正的原子性）
    expect(after.rows.map((r) => r.content)).toEqual(['ORIGINAL_MESSAGE_H3']);
  });

  it('收藏夹排序中途失败：先前的 UPDATE 被回滚', async () => {
    const mk = async (name, order) => {
      const r = await pool.query(
        `INSERT INTO favorite_collections (user_id, name, icon, sort_order, path)
         VALUES ($1, $2, '📁', $3, $4) RETURNING id`,
        [userId, name, order, `root.h3_${name}`]
      );
      return r.rows[0].id;
    };
    const c1 = await mk('a', 1);
    const c2 = await mk('b', 2);

    // 第二条的 sortOrder 超出 INTEGER 范围 ⇒ 循环中途报错 ⇒ 第一条的更新必须被回滚。
    const res = await request(app)
      .put('/api/favorites/collections/reorder')
      .set(auth)
      .send({ orders: [{ id: c1, sortOrder: 9 }, { id: c2, sortOrder: 2147483648 }] });

    expect(res.status).toBe(500);

    const after = await pool.query(
      'SELECT id, sort_order FROM favorite_collections WHERE id = ANY($1::uuid[])',
      [[c1, c2]]
    );
    const byId = Object.fromEntries(after.rows.map((r) => [r.id, r.sort_order]));
    expect(byId[c1]).toBe(1);
    expect(byId[c2]).toBe(2);
  });

  it('aiTools reorder_collections：成功路径仍提交（happy path 未被破坏）', async () => {
    const r = await pool.query(
      `INSERT INTO favorite_collections (user_id, name, icon, sort_order, path)
       VALUES ($1, 'c', '📁', 1, 'root.h3_c') RETURNING id`,
      [userId]
    );
    const cid = r.rows[0].id;

    const res = await executeTool(
      'reorder_collections',
      { orders: [{ id: cid, sortOrder: 7 }] },
      userId,
      'user'
    );

    expect(res).toEqual({ success: true, reordered: 1 });

    const after = await pool.query('SELECT sort_order FROM favorite_collections WHERE id = $1', [cid]);
    expect(after.rows[0].sort_order).toBe(7);
  });
});
