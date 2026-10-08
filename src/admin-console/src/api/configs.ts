import { apiGet, apiPatch, apiPost } from '@/api/client';
import type {
  Announcement,
  FeatureFlag,
  SendAnnouncementPayload,
  SystemConfig,
} from '@/api/types';

/** 系统参数列表 */
export function getConfigs(): Promise<SystemConfig[]> {
  return apiGet<SystemConfig[]>('/admin/configs');
}

/** 更新单项系统参数（实时生效并写入审计日志；maintenance_mode 必须带 reason） */
export function patchConfig(key: string, value: string, reason?: string): Promise<SystemConfig> {
  return apiPatch<SystemConfig>(`/admin/configs/${key}`, {
    value,
    ...(reason ? { reason } : {}),
  });
}

/** 功能开关列表 */
export function getFlags(): Promise<FeatureFlag[]> {
  return apiGet<FeatureFlag[]>('/admin/flags');
}

/** 切换单个功能开关（即时生效，写入审计日志） */
export function patchFlag(key: string, enabled: boolean): Promise<FeatureFlag> {
  return apiPatch<FeatureFlag>(`/admin/flags/${key}`, { enabled });
}

/** 下发公告（经通知服务群发） */
export function sendAnnouncement(payload: SendAnnouncementPayload): Promise<Announcement> {
  return apiPost<Announcement>('/admin/announcements', payload);
}

/** 公告发送历史（新记录在前；含已撤回的记录，`withdrawnAt` 非空即已撤回） */
export function getAnnouncements(): Promise<Announcement[]> {
  return apiGet<Announcement[]>('/admin/announcements');
}

/**
 * 2026-10-05 新增：撤回公告（迁移 085，软撤回）。
 *
 * 撤回后客户端 `GET /api/app/announcements` 不再返回它，但**送达/已读/点击统计全部保留**
 *（那两张关联表是 `ON DELETE CASCADE`，所以服务端刻意只用 `withdrawn_at` 标记、绝不硬删）。
 * 权限 `admin.announce.send`（撤回是下发的逆操作）；原因必填；审计 `admin.announce.withdraw`。
 */
export function withdrawAnnouncement(id: string, payload: { reason: string }): Promise<Announcement> {
  return apiPost<Announcement>(`/admin/announcements/${id}/withdraw`, payload);
}

/** CO-30：发送 SMTP 测试邮件（未配置 SMTP 返回 4090 错误壳；to 缺省用服务端默认收件人） */
export function testSmtp(to?: string): Promise<{ messageId: string }> {
  return apiPost<{ messageId: string }>('/admin/configs/smtp/test', { to });
}

/** A4：发送短信测试验证码（未配置短信返回 4090 错误壳；phone 必填，服务端始终走真实下发） */
export function testSms(
  phone: string
): Promise<{ phone: string; provider: string | null; requestId: string | null }> {
  return apiPost<{ phone: string; provider: string | null; requestId: string | null }>(
    '/admin/configs/sms/test',
    { phone }
  );
}

/** 短信投递回执的一条记录。`sendStatus`：**1=等待回执 / 2=发送失败 / 3=发送成功** */
export interface SmsDeliveryRecord {
  sendDate: string | null;
  receiveDate: string | null;
  sendStatus: number;
  /** 运营商回执码；失败时才有（如 `PORT_NOT_REGISTERED` = 号码未注册） */
  errCode: string | null;
  content: string | null;
  templateCode: string | null;
}

export interface SmsDeliveryResult {
  phone: string;
  sendDate: string;
  provider: string;
  records: SmsDeliveryRecord[];
}

/**
 * 查询某号码某天的**投递结果**（离"到底送达没有"最近的一手证据）。
 *
 * 为什么需要它：`/sms/test` 返回成功只代表**阿里云受理**；真正的送达结果在运营商回执里。
 * 2026-10-07 实测：界面显示「发送成功」但手机收不到 —— 回执其实是
 * `sendStatus:2 / errCode:PORT_NOT_REGISTERED`。没有这个查询，运营会把"受理"当成"送达"。
 *
 * @param date YYYYMMDD，缺省 = 北京时间今天
 */
export function querySmsDelivery(phone: string, date?: string): Promise<SmsDeliveryResult> {
  const qs = new URLSearchParams({ phone });
  if (date) qs.set('date', date);
  return apiGet<SmsDeliveryResult>(`/admin/configs/sms/delivery?${qs.toString()}`);
}

/** Sentry issue 列表里的一条（服务端已裁剪成展示所需字段） */
export interface SentryIssue {
  id: string | null;
  /** 人读编号，如 CLIPSYNC-1 */
  shortId: string | null;
  title: string | null;
  /** 出错位置（文件/函数） */
  culprit: string | null;
  level: string | null;
  count: number;
  userCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Sentry 详情页链接（服务端直接透出，省得前端拼 URL） */
  permalink: string | null;
  status: string | null;
}

export interface SentryIssuesResult {
  orgId: string;
  projectId: string;
  query: string;
  records: SentryIssue[];
}

/**
 * 在后台内读 Sentry 的 issue 列表（迁移 087）。
 *
 * 需要 `sentry_api_token`：**DSN 是只写凭据**（只够上报），读列表必须用 API Token
 * （Sentry → Settings → Auth Tokens，scope `project:read` + `event:read`）。
 * 缺凭证时服务端返回 4090 + 可执行提示，这里不兜底、如实抛出。
 */
export function getSentryIssues(params?: { limit?: number; query?: string }): Promise<SentryIssuesResult> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.query) qs.set('query', params.query);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiGet<SentryIssuesResult>(`/admin/configs/sentry/issues${suffix}`);
}
