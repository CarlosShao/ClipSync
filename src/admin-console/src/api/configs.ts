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

/** 更新系统参数（实时生效并写入审计日志） */
export function patchConfig(key: string, value: string): Promise<SystemConfig> {
  return apiPatch<SystemConfig>('/admin/configs', { key, value });
}

/** 功能开关列表 */
export function getFlags(): Promise<FeatureFlag[]> {
  return apiGet<FeatureFlag[]>('/admin/flags');
}

/** 切换功能开关（即时生效，写入审计日志） */
export function patchFlag(key: string, enabled: boolean): Promise<FeatureFlag> {
  return apiPatch<FeatureFlag>('/admin/flags', { key, enabled });
}

/** 下发公告（经通知服务群发） */
export function sendAnnouncement(payload: SendAnnouncementPayload): Promise<Announcement> {
  return apiPost<Announcement>('/admin/announcements', payload);
}

/** 公告发送历史 */
export function getAnnouncements(): Promise<Announcement[]> {
  return apiGet<Announcement[]>('/admin/announcements');
}
