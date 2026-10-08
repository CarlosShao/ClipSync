import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 短信**投递状态**查询 + /sms/test 措辞（2026-10-07）
 *
 * 背景（owner 生产实测）：管理台点「发送测试短信」显示成功，但手机收不到 ——
 * `SendSms` 返回 `Code:OK` 只代表**阿里云受理**，真送达结果在运营商回执里
 * （那条实际是 `sendStatus:2 / errCode:PORT_NOT_REGISTERED`）。
 * 所以补一个 `GET /api/admin/configs/sms/delivery` 把回执搬进管理台，
 * 并把 /sms/test 的文案从"已发送"改成"已提交运营商…请查回执"。
 *
 * 全离线：mock pool + auth + sms util（不碰 SDK、不出网）。
 */

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

const smsStub = vi.hoisted(() => ({
  querySmsDelivery: vi.fn(),
  sendVerificationCodeSms: vi.fn(),
  invalidateSmsConfigCache: vi.fn(),
  generateCode: vi.fn(() => '123456'),
  isSmsConfigured: vi.fn(async () => ({ configured: true, provider: 'aliyun' })),
}));

vi.mock('../../src/utils/sms.js', () => smsStub);

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
  pool.query.mockReset();
  smsStub.querySmsDelivery.mockReset();
  smsStub.sendVerificationCodeSms.mockReset();
  // 默认 super_admin（configs.manage 为 superAdminOnly 高危权限）
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.configs.manage' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe('GET /api/admin/configs/sms/delivery —— 查运营商回执', () => {
  it('正常查询：把回执原样透出（含 sendStatus / errCode / 内容）', async () => {
    smsStub.querySmsDelivery.mockResolvedValue({
      ok: true,
      provider: 'aliyun',
      sendDate: '20261007',
      records: [
        {
          sendDate: '2026-10-07 22:41:54',
          receiveDate: '2026-10-07 22:42:31',
          sendStatus: 2,
          errCode: 'PORT_NOT_REGISTERED',
          content: '【签名】您的验证码为：789691',
          templateCode: 'SMS_338500489',
        },
      ],
    });

    const res = await request(buildApp()).get(
      '/api/admin/configs/sms/delivery?phone=13505110772'
    );

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({ phone: '13505110772', sendDate: '20261007', provider: 'aliyun' });
    expect(res.body.data.records[0]).toMatchObject({
      sendStatus: 2,
      errCode: 'PORT_NOT_REGISTERED',
      templateCode: 'SMS_338500489',
    });
    // 未传 date 时交给 util 按北京时间取今天
    expect(smsStub.querySmsDelivery).toHaveBeenCalledWith({ phone: '13505110772', sendDate: undefined });
  });

  it('显式传 date 时透传（YYYYMMDD）', async () => {
    smsStub.querySmsDelivery.mockResolvedValue({ ok: true, provider: 'aliyun', sendDate: '20261006', records: [] });

    const res = await request(buildApp()).get(
      '/api/admin/configs/sms/delivery?phone=13505110772&date=20261006'
    );

    expect(res.status).toBe(200);
    expect(smsStub.querySmsDelivery).toHaveBeenCalledWith({ phone: '13505110772', sendDate: '20261006' });
  });

  it('手机号非法 ⇒ 400，且不调用外部查询', async () => {
    const res = await request(buildApp()).get('/api/admin/configs/sms/delivery?phone=12345');
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('手机号');
    expect(smsStub.querySmsDelivery).not.toHaveBeenCalled();
  });

  it('日期格式错 ⇒ 400', async () => {
    const res = await request(buildApp()).get(
      '/api/admin/configs/sms/delivery?phone=13505110772&date=2026-10-07'
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('YYYYMMDD');
    expect(smsStub.querySmsDelivery).not.toHaveBeenCalled();
  });

  it('未配置短信 ⇒ 409 且给可执行提示', async () => {
    smsStub.querySmsDelivery.mockResolvedValue({ ok: false, reason: 'not_configured' });

    const res = await request(buildApp()).get(
      '/api/admin/configs/sms/delivery?phone=13505110772'
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(4090);
    expect(res.body.message).toContain('未配置短信服务');
  });

  it('服务商不支持（腾讯云）⇒ 409 明确说不支持，不假装能查', async () => {
    smsStub.querySmsDelivery.mockResolvedValue({ ok: false, reason: 'not_supported', provider: 'tencent' });

    const res = await request(buildApp()).get(
      '/api/admin/configs/sms/delivery?phone=13505110772'
    );

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('暂不支持查询投递状态');
  });
});

describe('POST /api/admin/configs/sms/test —— 文案不能把"受理"说成"送达"', () => {
  it('成功时提示"已提交运营商 + requestId + 去查回执"', async () => {
    smsStub.sendVerificationCodeSms.mockResolvedValue({ ok: true, provider: 'aliyun', requestId: 'REQ-ABC' });

    const res = await request(buildApp())
      .post('/api/admin/configs/sms/test')
      .send({ phone: '13505110772' });

    expect(res.status).toBe(200);
    expect(res.body.data.requestId).toBe('REQ-ABC');
    expect(res.body.message).toContain('已提交运营商');
    expect(res.body.message).toContain('REQ-ABC');
    expect(res.body.message).toContain('查询投递状态');
    // 不能出现会让人误读为"已送达"的措辞
    expect(res.body.message).not.toContain('已发送成功');
  });
});
