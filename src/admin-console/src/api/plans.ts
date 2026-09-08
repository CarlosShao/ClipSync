import { apiGet, apiPatch } from '@/api/client';
import type { AdminPlan, PlanPatchPayload } from '@/api/types';

/**
 * 套餐域 queryKey 工厂（本地定义：与 subscriptionKeys 同惯例；
 * 前缀 ['plans'] 用于写操作后整体失效）。
 */
export const planKeys = {
  list: () => ['plans'] as const,
};

/**
 * 套餐全量列表（含 is_active=false 停用套餐；数量有限不做分页）。
 * 后端返回壳为 { code: 0, data: { list: Plan[] } }，此处解包为扁平数组。
 */
export async function getPlans(): Promise<AdminPlan[]> {
  const data = await apiGet<{ list: AdminPlan[] }>('/admin/plans');
  return data.list;
}

/** 编辑套餐（白名单字段部分更新，写审计 admin.plans.update；需 admin.plans.manage） */
export function patchPlan(id: string, patch: PlanPatchPayload): Promise<AdminPlan> {
  return apiPatch<AdminPlan>(`/admin/plans/${id}`, patch);
}
