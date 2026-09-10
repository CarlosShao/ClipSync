/**
 * Admin Console 系统配置 / 功能开关 / 公告下发 API 单测（Admin Console · T-A5）
 *
 * 覆盖（routes/admin/configs.js + announcements.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET   /configs        目录 5 键（含 maintenance_mode / audit_log_retention_days）+ JSONB→字符串
 *  - PATCH /configs/:key   requirePerm('admin.configs.manage')：未知键 404、value 空 40002、
 *                          maintenance_mode 缺原因 40003、JSONB 写入 + updated_by、审计 admin.config.update
 *  - GET   /flags          目录 5 开关
 *  - PATCH /flags/:key     enabled 非布尔 40002、审计 admin.flag.update
 *  - POST  /announcements  requirePerm('admin.announce.send')：title/content 必填 40002、
 *                          受众计数落表、审计 admin.announcement.send；非法枚举 400
 *  - GET   /announcements  发送历史（新记录在前）+ Announcement 契约映射
 *
 * 全离线：vi.mock db/pool + middleware/auth（与 orders.test.js 同风格）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticateToken: vi.fn((req, _res, next) => {
    if (authState.user) {
      req.user = { ...authState.user };
      req.userId = authState.user.userId;
    }
    next();
  }),
  optionalAuth: vi.fn((req, _res, next) => next()),
}));

import express from 'express';
import request from 'supertest';
import { pool } from '../../src/db/pool.js';
import { clearPermCache } from '../../src/middleware/adminAuth.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  // 默认身份：super_admin（configs.manage / announce.send 为 superAdminOnly 高危权限）
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

/** requirePerm 放行（持有指定权限点） */
function grantPerm(permKey) {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('perm_key')) return { rows: [{ perm_key: permKey }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

/** 从审计 INSERT 调用中按 action 查找（superAdminAudit 会额外写 super_admin_action，需过滤） */
function findAuditCall(action) {
  return pool.query.mock.calls.find(([sql, params]) => {
    return sql.includes('INSERT INTO audit_logs') && params[1] === action;
  });
}

// ───────────────────────── 系统配置 ─────────────────────────

describe('GET /api/admin/configs —— 系统参数列表', () => {
  it('展示目录全键按目录顺序输出（AN-14 移除死键 / AF-42 移除 menu_overrides / 055-063 运维键补录），JSONB 值转字符串', async () => {
    pool.query.mockImplementation(async (sql) => {
      // RB-06：GET 读侧也走 requirePerm('admin.configs.view')，先放行权限查询
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.configs.view' }], rowCount: 1 };
      if (sql.includes('FROM system_configs')) {
        // pg 对 jsonb 返回已解析的 JS 值：'"off"' → 'off'、'4096' → 4096
        return {
          rows: [
            { config_key: 'maintenance_mode', config_value: 'off', description: null, updated_at: new Date('2026-09-01T08:30:00Z') },
            { config_key: 'ai_max_tokens', config_value: 4096, description: 'AI 单次生成的最大 token 数', updated_at: null },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/configs');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    const configs = res.body.data;
    expect(configs.map((c) => c.key)).toEqual([
      'maintenance_mode',
      'ai_max_tokens',
      'ai_default_provider',
      'session_timeout_minutes',
      'audit_log_retention_days',
      // AN-14（第二轮死配置清理）：max_collection_depth / enable_audit_log 已从目录移除（无消费方）；
      // AF-42：menu_overrides 同步移除（客户端无读取通道）
      // 055/056/063 运维键补录：grafana_url / prometheus_url / backup_retention_days /
      // storage_cleanup_enabled / device_offline_timeout_minutes（消费方均已登记）
      'rate_limit_api_per_min',
      'rate_limit_send_code_per_hour',
      'rate_limit_login_failed_per_15min',
      'rate_limit_upload_per_min',
      'rate_limit_disabled',
      'log_level',
      'grafana_url',
      'prometheus_url',
      'backup_retention_days',
      'storage_cleanup_enabled',
      'device_offline_timeout_minutes',
      'smtp_host',
      'smtp_port',
      'smtp_user',
      'smtp_pass',
      'smtp_from',
      'smtp_secure',
      // 067（GH-01）：更新包下载地址来源，routes/app.js 经 releaseArtifacts.js 消费
      'release_download_base_url',
    ]);

    const maintenance = configs[0];
    expect(maintenance).toMatchObject({
      key: 'maintenance_mode',
      name: '维护模式',
      value: 'off', // JSONB 字符串原样
      updatedAt: '2026-09-01 08:30', // YYYY-MM-DD HH:mm
    });
    const tokens = configs[1];
    expect(tokens.value).toBe('4096'); // JSONB 数字 → 契约字符串
    expect(tokens.updatedAt).toBeUndefined(); // 空值不返回该键值
  });
});

describe('PATCH /api/admin/configs/:key —— 更新系统参数', () => {
  function mockUpdateOk(returnedRow) {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.configs.manage' }], rowCount: 1 };
      if (sql.includes('UPDATE system_configs')) return { rows: [returnedRow], rowCount: 1 };
      return { rows: [], rowCount: 0 }; // 审计 INSERT
    });
  }

  it('合法更新：JSONB 写入 + updated_by 记录修改人 + 审计 admin.config.update', async () => {
    mockUpdateOk({
      config_key: 'ai_max_tokens',
      config_value: '8192',
      description: 'AI 单次生成的最大 token 数',
      updated_at: new Date('2026-09-05T10:00:00Z'),
    });

    const res = await request(buildApp())
      .patch('/api/admin/configs/ai_max_tokens')
      .send({ value: '8192' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({
      key: 'ai_max_tokens',
      value: '8192',
      updatedAt: '2026-09-05 10:00',
    });

    // UPDATE 参数：$1 key、$2 value、$3 updated_by
    const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE system_configs'));
    expect(updateCall[1]).toEqual(['ai_max_tokens', '8192', 'u-super']);
    expect(updateCall[0]).toContain('to_jsonb($2::text)');
    expect(updateCall[0]).toContain('updated_by');

    // 审计：admin.config.update / resourceType=system_config / resourceId=key
    const auditCall = findAuditCall('admin.config.update');
    expect(auditCall).toBeTruthy();
    expect(auditCall[1][0]).toBe('u-super');
    expect(auditCall[1][2]).toBe('system_config');
    expect(auditCall[1][3]).toBe('ai_max_tokens');
    expect(JSON.parse(auditCall[1][4])).toEqual({ value: '8192' });
  });

  it('maintenance_mode 缺原因返回 400 { code: 40003 }；带原因更新成功且审计 details 含 reason', async () => {
    mockUpdateOk({
      config_key: 'maintenance_mode',
      config_value: 'on',
      description: null,
      updated_at: new Date('2026-09-05T10:00:00Z'),
    });

    const missing = await request(buildApp())
      .patch('/api/admin/configs/maintenance_mode')
      .send({ value: 'on' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe(40003);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('UPDATE system_configs'))).toBe(false);

    const ok = await request(buildApp())
      .patch('/api/admin/configs/maintenance_mode')
      .send({ value: 'on', reason: '数据库升级演练' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.value).toBe('on');

    const auditCall = findAuditCall('admin.config.update');
    expect(JSON.parse(auditCall[1][4])).toEqual({ value: 'on', reason: '数据库升级演练' });
  });

  it('未知配置键 404 { code: 40404 }；value 空返回 400 { code: 40002 }', async () => {
    grantPerm('admin.configs.manage');

    const unknown = await request(buildApp())
      .patch('/api/admin/configs/no_such_key')
      .send({ value: 'x' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe(40404);

    const empty = await request(buildApp())
      .patch('/api/admin/configs/ai_max_tokens')
      .send({ value: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe(40002);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('UPDATE system_configs'))).toBe(false);
  });

  it('未持有 admin.configs.manage 返回 403 { code: 4030 }（admin 角色无此高危权限）', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 }; // 043：admin 未授 configs.manage
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .patch('/api/admin/configs/ai_max_tokens')
      .send({ value: '8192' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.configs.manage' });
  });
});

// ───────────────────────── 功能开关 ─────────────────────────

describe('GET /api/admin/flags —— 功能开关列表', () => {
  it('功能开关目录按目录顺序输出（首个 enable_subscription，含 enable_signup；AN-12 增 force_2fa_for_admin、AN-10 增 enforced 字段）', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.configs.view' }], rowCount: 1 };
      if (sql.includes('FROM feature_flags')) {
        return {
          rows: [
            { flag_key: 'enable_subscription', enabled: true, description: '启用订阅功能' },
            { flag_key: 'enable_ai_agent', enabled: true, description: '启用 AI Agent 侧边栏能力' },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/flags');

    expect(res.status).toBe(200);
    const flags = res.body.data;
    expect(flags).toHaveLength(7);
    expect(flags.map((f) => f.key)).toEqual([
      'enable_subscription',
      'enable_ai_agent',
      'enable_public_sharing',
      'enable_2fa',
      'signup_waitlist',
      'enable_signup',
      // AN-12：管理员安全策略开关（强制管理角色绑定 2FA）
      'force_2fa_for_admin',
    ]);
    expect(flags[0]).toMatchObject({ key: 'enable_subscription', enabled: true });
    // DB 缺行的开关兜底 enabled=false，不阻塞设置页渲染
    expect(flags[2].enabled).toBe(false);
    // AN-10：enforced = 服务端是否存在强制点（ENFORCED_FLAG_KEYS 清单口径）；
    // 目录 7 键当前均已登记强制点
    expect(flags.every((f) => f.enforced === true)).toBe(true);
  });
});

describe('PATCH /api/admin/flags/:key —— 切换功能开关', () => {
  function mockFlagUpdate(returnedRow) {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.configs.manage' }], rowCount: 1 };
      if (sql.includes('UPDATE feature_flags')) return { rows: [returnedRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('切换成功：UPDATE 落库 + 审计 admin.flag.update（resourceId=开关键）', async () => {
    mockFlagUpdate({ flag_key: 'enable_ai_agent', enabled: false, description: '启用 AI Agent 侧边栏能力' });

    const res = await request(buildApp())
      .patch('/api/admin/flags/enable_ai_agent')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({ key: 'enable_ai_agent', enabled: false });

    const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE feature_flags'));
    expect(updateCall[1]).toEqual(['enable_ai_agent', false]);

    const auditCall = findAuditCall('admin.flag.update');
    expect(auditCall).toBeTruthy();
    expect(auditCall[1][2]).toBe('feature_flag');
    expect(auditCall[1][3]).toBe('enable_ai_agent');
    expect(JSON.parse(auditCall[1][4])).toEqual({ enabled: false });
  });

  it('enabled 非布尔返回 400 { code: 40002 }；未知开关 404 { code: 40404 }', async () => {
    grantPerm('admin.configs.manage');

    const bad = await request(buildApp())
      .patch('/api/admin/flags/enable_ai_agent')
      .send({ enabled: 'false' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe(40002);

    const unknown = await request(buildApp())
      .patch('/api/admin/flags/no_such_flag')
      .send({ enabled: true });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe(40404);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('UPDATE feature_flags'))).toBe(false);
  });
});

// ───────────────────────── 公告下发 ─────────────────────────

describe('POST /api/admin/announcements —— 下发公告', () => {
  /** 成功链路池 mock：perm → 受众计数 → INSERT RETURNING */
  function mockSendOk({ countSqlMatch = 'FROM users', count = 42 } = {}) {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.announce.send' }], rowCount: 1 };
      // 受众计数（all=FROM users / pro_plus=sp.name IN (...)）；perm 分支在前，此处不会误匹配权限查询
      if (sql.includes(countSqlMatch)) {
        return { rows: [{ cnt: count }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO admin_announcements')) {
        // RETURNING 行按 INSERT 参数回显（$1 title、$3 audience、$4 display_mode、$6 delivered_count）
        return {
          rows: [
            {
              id: 'aa000000-0000-4000-8000-000000000001',
              title: params[0],
              content: params[1],
              audience: params[2],
              display_mode: params[3],
              sent_by: params[4],
              delivered_count: params[5],
              click_count: 0,
              created_at: new Date('2026-09-05T18:05:00Z'),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 }; // 审计 INSERT
    });
  }

  it('title/content 空（含纯空白）返回 400 { code: 40002 }，不落表不写审计', async () => {
    grantPerm('admin.announce.send');

    const res = await request(buildApp())
      .post('/api/admin/announcements')
      .send({ title: '   ', content: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40002);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO admin_announcements'))).toBe(false);
    expect(findAuditCall('admin.announcement.send')).toBeUndefined();
  });

  it('audience / displayMode 非法枚举返回 400', async () => {
    grantPerm('admin.announce.send');

    const badAudience = await request(buildApp())
      .post('/api/admin/announcements')
      .send({ title: 'T', content: 'C', audience: 'vip' });
    expect(badAudience.status).toBe(400);

    const badMode = await request(buildApp())
      .post('/api/admin/announcements')
      .send({ title: 'T', content: 'C', displayMode: 'always' });
    expect(badMode.status).toBe(400);
  });

  it('合法下发：受众计数落 delivered_count + 审计 admin.announcement.send + Announcement 契约响应', async () => {
    mockSendOk({ count: 42 });

    const res = await request(buildApp())
      .post('/api/admin/announcements')
      .send({ title: '维护通知', content: '今晚 02:00–02:15 数据库升级', audience: 'all', displayMode: 'once' });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({
      id: 'aa000000-0000-4000-8000-000000000001',
      title: '维护通知',
      audience: 'all',
      displayMode: 'once',
      sentAt: '2026-09-05 18:05', // YYYY-MM-DD HH:mm 契约形态
      deliveredCount: 42,
      clickedCount: 0,
    });

    // INSERT 参数：$1 title、$2 content、$3 audience、$4 display_mode、$5 sent_by、$6 delivered_count
    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO admin_announcements'));
    expect(insertCall[1].slice(0, 6)).toEqual([
      '维护通知',
      '今晚 02:00–02:15 数据库升级',
      'all',
      'once',
      'u-super',
      42,
    ]);

    const auditCall = findAuditCall('admin.announcement.send');
    expect(auditCall).toBeTruthy();
    expect(auditCall[1][2]).toBe('announcement');
    const details = JSON.parse(auditCall[1][4]);
    expect(details).toMatchObject({ title: '维护通知', audience: 'all', delivered: 42 });
  });

  it('pro_plus 受众按生效中 Pro/Enterprise 订阅计数', async () => {
    mockSendOk({ countSqlMatch: "sp.name IN ('Pro', 'Enterprise')", count: 7 });

    const res = await request(buildApp())
      .post('/api/admin/announcements')
      .send({ title: 'Pro 专属', content: '感谢订阅', audience: 'pro_plus' });

    expect(res.status).toBe(201);
    expect(res.body.data.audience).toBe('pro_plus');
    expect(res.body.data.deliveredCount).toBe(7);
    const countCall = pool.query.mock.calls.find(
      ([sql]) => sql.includes("sp.name IN ('Pro', 'Enterprise')")
    );
    expect(countCall).toBeTruthy();
    expect(countCall[0]).toContain("us.status IN ('active', 'trialing', 'trial')");
  });
});

describe('GET /api/admin/announcements —— 发送历史', () => {
  it('新记录在前（ORDER BY created_at DESC），行映射符合 Announcement 契约', async () => {
    pool.query.mockImplementation(async (sql) => {
      // RB-06：GET 读侧也走 requirePerm('admin.announce.view')，先放行权限查询
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.announce.view' }], rowCount: 1 };
      if (sql.includes('FROM admin_announcements')) {
        return {
          rows: [
            {
              id: 'aa-2',
              title: '第二条',
              content: 'c2',
              audience: 'pro_plus',
              display_mode: 'persistent',
              sent_by: 'u-super',
              delivered_count: 7,
              click_count: 3,
              created_at: new Date('2026-09-05T18:05:00Z'),
            },
            {
              id: 'aa-1',
              title: '第一条',
              content: 'c1',
              audience: 'free',
              display_mode: 'once',
              sent_by: null,
              delivered_count: 88,
              click_count: null,
              created_at: new Date('2026-09-01T09:00:00Z'),
            },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/announcements');

    expect(res.status).toBe(200);
    const list = res.body.data;
    expect(list.map((a) => a.id)).toEqual(['aa-2', 'aa-1']); // mock 按 DESC 返回，原样透传
    expect(list[0]).toMatchObject({
      title: '第二条',
      audience: 'pro_plus',
      displayMode: 'persistent',
      sentAt: '2026-09-05 18:05',
      deliveredCount: 7,
      clickedCount: 3,
    });
    expect(list[1].clickedCount).toBe(0); // null → 0

    // 历史上限 100 条
    const [sql, params] = pool.query.mock.calls.find(([s]) => s.includes('FROM admin_announcements'));
    expect(sql).toContain('LIMIT $1');
    expect(params[0]).toBe(100);
  });
});
