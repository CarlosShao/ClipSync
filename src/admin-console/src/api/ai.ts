import { apiGet, apiPatch } from '@/api/client';

/**
 * AN-03 AI 平台管理（后端 ai_providers 行的管理台脱敏视图）：
 * - ai_providers 为 BYOK（按用户自带密钥）表，每行绑定 user_id，无平台级供应商；
 * - api_key 永不解密不回传，仅 has_key 布尔（与 smtp_pass 脱敏同策略，CO-30）；
 * - user_label 为用户昵称或打码手机号（后端 maskPhone 同口径）；
 * - enabled=false 的行在用户端列表/聊天/OCR 全链路过滤（桌面端不可选）。
 */
export interface AdminAiProvider {
  id: string;
  user_id: string;
  user_label: string;
  /** 供应商预设键（openai / anthropic / deepseek / qwen / hunyuan / custom …） */
  provider: string;
  name: string;
  base_url: string;
  model: string;
  has_key: boolean;
  enabled: boolean;
  is_default: boolean;
  updated_at?: string;
}

/** 管理台可改字段（部分更新语义；密钥仅用户自己可设置，不在白名单内） */
export interface AdminAiProviderPatch {
  enabled?: boolean;
  name?: string;
  model?: string;
  base_url?: string;
}

/** AN-03 AI 平台域 queryKey（写操作后整体失效） */
export const aiKeys = {
  list: () => ['ai-providers'] as const,
};

/** 全量供应商列表（updated_at DESC，用户手机号打码、密钥脱敏） */
export function getAiProviders(): Promise<AdminAiProvider[]> {
  return apiGet<AdminAiProvider[]>('/admin/ai-providers');
}

/** 部分更新供应商（启停/名称/模型/base_url；写审计 admin.ai_provider.update） */
export function patchAiProvider(
  id: string,
  patch: AdminAiProviderPatch
): Promise<AdminAiProvider> {
  return apiPatch<AdminAiProvider>(`/admin/ai-providers/${id}`, patch);
}
