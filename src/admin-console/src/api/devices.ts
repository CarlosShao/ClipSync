import { apiDelete, apiGet, apiPost } from '@/api/client';
import type {
  AdminDevice,
  DeviceKeysSummary,
  DeviceListParams,
  DeviceOfflinePayload,
  DeviceStats,
  PageData,
} from '@/api/types';

/**
 * 设备域 queryKey 工厂（本地定义：queryKeys.ts 本工单禁改，后续合并；
 * 前缀 ['devices'] 用于写操作后整体失效——同时命中列表与统计）。
 */
export const deviceKeys = {
  list: (params: DeviceListParams) => ['devices', params] as const,
  stats: () => ['devices', 'stats'] as const,
};

/** 设备列表（设备名/属主关键词 + 平台/状态筛选 + 分页） */
export function getDevices(params: DeviceListParams): Promise<PageData<AdminDevice>> {
  return apiGet<PageData<AdminDevice>>('/admin/devices', { params });
}

/** 设备页头统计：总数 / 在线数 / 平台分布 */
export function getDeviceStats(): Promise<DeviceStats> {
  return apiGet<DeviceStats>('/admin/devices/stats');
}

/** 远程下线（原因必填，写入审计 admin.device.offline；仅在线设备可下线） */
export function offlineDevice(id: string, payload: DeviceOfflinePayload): Promise<AdminDevice> {
  return apiPost<AdminDevice>(`/admin/devices/${id}/offline`, payload);
}

/** 设备公钥脱敏摘要（AF-43：仅 admin.keys.view 角色可见；服务端只回指纹，不回公钥原文/私钥） */
export function getDeviceKeys(id: string): Promise<DeviceKeysSummary> {
  return apiGet<DeviceKeysSummary>(`/admin/devices/${id}/keys`);
}

/** 解绑结果：`removedItems` = 连带删除的剪贴板条数（外键 CASCADE，不可恢复） */
export interface UnbindDeviceResult {
  id: string;
  name: string;
  removedItems: number;
  wsKicked: boolean;
}

/**
 * 2026-10-05 新增：强制解绑设备（真正移除设备行，释放 `max_devices` 名额）。
 *
 * ⚠️ **会连带删除该设备产生的全部剪贴板内容**（生产实测外键
 * `clipboard_items_source_device_id_fkey ... ON DELETE CASCADE`，不可恢复）。
 * 所以服务端有条数保护闸：该设备还有内容时，**必须把条数回传确认**
 * （`confirmItemCount`），否则返回 409 `CONTENT_WILL_BE_DELETED` 且**什么都不删**。
 * 只想让设备下线、保留内容，请用 `offlineDevice`。
 *
 * 权限 `admin.devices.manage`；原因必填；审计 `admin.device.unbind`（含被删条数）。
 */
export function unbindDevice(
  id: string,
  payload: { reason: string; confirmItemCount?: number }
): Promise<UnbindDeviceResult> {
  return apiDelete<UnbindDeviceResult>(`/admin/devices/${id}`, payload);
}
