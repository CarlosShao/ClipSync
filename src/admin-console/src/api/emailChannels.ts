import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client';

/**
 * AN-16 邮件通道（后端 email_channels 行的脱敏视图）：
 * password 永不回传，仅 has_password 布尔（与 smtp_pass 脱敏同策略，CO-30）。
 * purpose：transactional=事务（验证码/删除确认）；marketing=营销（预留）。
 * priority：越小越优先，主通道发送失败按序降级（最多 2 次）。
 */
export interface EmailChannel {
  id: string;
  name: string;
  purpose: 'transactional' | 'marketing';
  /** AN-16：仅 smtp 已实现；aliyun_dm / sendgrid 为后端预留枚举 */
  provider: 'smtp' | 'aliyun_dm' | 'sendgrid';
  host: string;
  port: number;
  secure: boolean;
  username: string;
  has_password: boolean;
  from_addr: string;
  enabled: boolean;
  priority: number;
  created_at?: string;
  updated_at?: string;
}

/** 新建/编辑通道载荷（编辑为部分更新：password 留空 = 保持不变） */
export interface EmailChannelPayload {
  name: string;
  purpose: EmailChannel['purpose'];
  provider?: EmailChannel['provider'];
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string;
  from_addr: string;
  enabled?: boolean;
  priority?: number;
}

/** AN-16 邮件通道域 queryKey（写操作后整体失效） */
export const emailChannelKeys = {
  list: () => ['email-channels'] as const,
};

/** 通道列表（purpose + priority 排序，password 脱敏） */
export function getEmailChannels(): Promise<EmailChannel[]> {
  return apiGet<EmailChannel[]>('/admin/email-channels');
}

/** 新建通道（password 加密落库；写审计 admin.email_channel.create） */
export function createEmailChannel(payload: EmailChannelPayload): Promise<EmailChannel> {
  return apiPost<EmailChannel>('/admin/email-channels', payload);
}

/** 部分更新通道（启停/改密/调优先级；写审计 admin.email_channel.update） */
export function patchEmailChannel(
  id: string,
  patch: Partial<EmailChannelPayload>
): Promise<EmailChannel> {
  return apiPatch<EmailChannel>(`/admin/email-channels/${id}`, patch);
}

/** 删除通道（写审计 admin.email_channel.delete；reason 由 ConfirmReasonModal 必填收集） */
export function deleteEmailChannel(id: string, reason?: string): Promise<{ id: string }> {
  return apiDelete<{ id: string }>(`/admin/email-channels/${id}`, reason ? { reason } : undefined);
}

/** 发送测试邮件（指定通道；凭据不完整返回 4090 错误壳，由 client.ts 拦截器统一 toast） */
export function testEmailChannel(
  id: string,
  to?: string
): Promise<{ to: string; messageId: string | null; channelName: string }> {
  return apiPost(`/admin/email-channels/${id}/test`, { to });
}
