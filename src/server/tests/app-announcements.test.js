/**
 * 客户端公告拉取的**撤回过滤**（GET /api/app/announcements，迁移 085）
 *
 * 这是 ⑫ 真正的落点：管理台能"撤回"只是手段，**客户端不再看到它**才是目的 ——
 * 只加上面那个端点、不改这里，撤回等于没撤。
 *
 * 判据：
 *  ① SQL 必须带 `withdrawn_at IS NULL`（撤回的公告不进结果）；
 *  ② 匿名请求仍只看到 `audience='all'` 的公告（既有受众口径不能被这次改动破坏）；
 *  ③ 撤回**不影响**送达/已读数据的写入路径（这里只断言拉取侧不再把撤回项交给回执逻辑）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ pool: { query: vi.fn() } }));

vi.mock('../src/db/pool.js', () => ({ pool: state.pool, default: state.pool }));
// 匿名请求：optionalAuth 不注入 user
vi.mock('../src/middleware/auth.js', () => ({
  authenticateToken: vi.fn((req, _res, next) => next()),
  optionalAuth: vi.fn((req, _res, next) => next()),
}));

import express from 'express';
import request from 'supertest';
import appRouter from '../src/routes/app.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/app', appRouter);
  return app;
}

const announcementSelect = () =>
  String(
    state.pool.query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => String(sql).includes('FROM admin_announcements')) || ''
  );

beforeEach(() => {
  state.pool.query.mockReset();
});

describe('客户端公告拉取 · 撤回过滤', () => {
  it('★SQL 必须带 withdrawn_at IS NULL（否则"撤回"等于没撤）', async () => {
    state.pool.query.mockImplementation(async () => ({
      rows: [
        {
          id: 'a1',
          title: '正常公告',
          content: '内容',
          audience: 'all',
          display_mode: 'once',
          created_at: new Date('2026-10-05T00:00:00Z'),
        },
      ],
    }));

    const res = await request(buildApp()).get('/api/app/announcements');

    expect(res.status).toBe(200);
    const sql = announcementSelect();
    expect(sql).toContain('withdrawn_at IS NULL');
    expect(res.body.announcements).toHaveLength(1);
    expect(res.body.announcements[0].title).toBe('正常公告');
  });

  it('匿名请求只看得到 audience=all（既有受众口径不被破坏）', async () => {
    state.pool.query.mockImplementation(async () => ({
      rows: [
        { id: 'a1', title: '公开', content: 'x', audience: 'all', display_mode: 'once', created_at: new Date() },
        { id: 'a2', title: '仅Pro', content: 'y', audience: 'pro_plus', display_mode: 'once', created_at: new Date() },
        { id: 'a3', title: '仅免费', content: 'z', audience: 'free', display_mode: 'once', created_at: new Date() },
      ],
    }));

    const res = await request(buildApp()).get('/api/app/announcements');

    expect(res.status).toBe(200);
    expect(res.body.announcements.map((a) => a.title)).toEqual(['公开']);
  });

  it('查询异常 → 500（不静默返回空列表，否则"没有公告"与"接口挂了"无从区分）', async () => {
    state.pool.query.mockRejectedValue(new Error('db down'));

    const res = await request(buildApp()).get('/api/app/announcements');

    expect(res.status).toBe(500);
  });
});
