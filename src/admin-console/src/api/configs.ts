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

/** 公告发送历史（新记录在前） */
export function getAnnouncements(): Promise<Announcement[]> {
  return apiGet<Announcement[]>('/admin/announcements');
}

/** CO-30：发送 SMTP 测试邮件（未配置 SMTP 返回 4090 错误壳；to 缺省用服务端默认收件人） */
export function testSmtp(to?: string): Promise<{ messageId: string }> {
  return apiPost<{ messageId: string }>('/admin/configs/smtp/test', { to });
}
