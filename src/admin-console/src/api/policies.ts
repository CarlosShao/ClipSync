import { apiGet, apiPatch } from '@/api/client';
import type { ClientPolicy, ClientPolicyPatchPayload } from '@/api/types';

/**
 * 客户端策略域 queryKey 工厂（与 planKeys 同惯例；前缀 ['policies'] 用于写后整体失效）。
 */
export const policyKeys = {
  detail: () => ['policies'] as const,
};

/**
 * 全局客户端策略（AN-02）：GET /api/admin/policies → { scope, updatedAt, policies[] }。
 * 目录顺序输出，含 consumer / defaultValue / min / max 展示元数据。
 */
export async function getClientPolicies(): Promise<{
  scope: string;
  updatedAt: string | null;
  policies: ClientPolicy[];
}> {
  return apiGet<{ scope: string; updatedAt: string | null; policies: ClientPolicy[] }>(
    '/admin/policies'
  );
}

/**
 * 部分更新全局客户端策略（仅提交变更键；需 admin.configs.manage）。
 * 后端：值类型/边界校验 → 合并写入 → 失效缓存 + WS policies.updated 广播 → 审计 admin.policy.update。
 */
export async function patchPolicies(
  patch: ClientPolicyPatchPayload,
  reason?: string
): Promise<{ scope: string; policies: ClientPolicy[] }> {
  return apiPatch<{ scope: string; policies: ClientPolicy[] }>('/admin/policies', {
    policies: patch,
    ...(reason ? { reason } : {}),
  });
}
