import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client';

/**
 * AN-04 版本发布管理（后端 app_releases 行的映射视图）：
 * platforms：{ "<tauri target>": { url, signature? } }，
 * target 键名与 Tauri updater 一致（windows-x86_64 / darwin-aarch64 / linux-x86_64）。
 * is_published=false 为草稿；true→false 即撤回/回滚（客户端立即不再提示更新）。
 */
export interface AppRelease {
  id: string;
  version: string;
  name: string;
  releaseDate?: string | null;
  notes: string;
  platforms: Record<string, { url: string; signature?: string }>;
  forceUpdate: boolean;
  rolloutPercent: number;
  isPublished: boolean;
  publishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** 新建载荷（version 必填；is_published=true 一步发布） */
export interface ReleaseCreatePayload {
  version: string;
  name?: string;
  release_date?: string | null;
  notes?: string;
  platforms?: Record<string, { url: string; signature?: string }>;
  force_update?: boolean;
  rollout_percent?: number;
  is_published?: boolean;
}

/** 编辑载荷（部分更新；version 建单后不可改；is_published 切换即发布/撤回） */
export type ReleasePatchPayload = Omit<ReleaseCreatePayload, 'version'>;

/** AN-04 版本发布域 queryKey（写操作后整体失效） */
export const releaseKeys = {
  list: () => ['releases'] as const,
};

/** 发布全量列表（含未发布草稿，创建时间倒序） */
export function getReleases(): Promise<AppRelease[]> {
  return apiGet<{ list: AppRelease[] }>('/admin/releases').then((r) => r.list);
}

/** 新建版本（写审计 admin.release.create） */
export function createRelease(payload: ReleaseCreatePayload): Promise<AppRelease> {
  return apiPost<AppRelease>('/admin/releases', payload);
}

/** 部分更新（编辑 / 发布 / 撤回；写审计 admin.release.update） */
export function patchRelease(
  id: string,
  patch: ReleasePatchPayload
): Promise<AppRelease> {
  return apiPatch<AppRelease>(`/admin/releases/${id}`, patch);
}

/** 删除版本（reason 必填写审计；写审计 admin.release.delete） */
export function deleteRelease(id: string, reason: string): Promise<{ id: string }> {
  return apiDelete<{ id: string }>(`/admin/releases/${id}`, { reason });
}
