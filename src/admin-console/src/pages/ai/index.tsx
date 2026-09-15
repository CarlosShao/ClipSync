import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Card, Input, InputNumber, Select, Switch, Table, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { aiKeys, getAiProviders, patchAiProvider } from '@/api/ai';
import type { AdminAiProvider } from '@/api/ai';
import { getConfigs, patchConfig } from '@/api/configs';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { PageHeader } from '@/components/PageHeader';
import { hasPerm } from '@/utils/permissions';

/**
 * AI 平台设置页（AN-03）：
 * 1. 全局参数卡：ai_max_tokens / ai_default_provider（system_configs 键，
 *    服务端经 utils/aiRuntimeConfig.js 5s TTL 消费——写库后 PATCH 端点自动失效缓存）；
 *    消费方说明随 configs.consumer 一并展示（AN-09 机制）。
 * 2. 供应商全局视图：ai_providers 为 BYOK（按用户自带密钥）表，本页提供
 *    全量脱敏列表（手机号打码 / 仅 has_key 布尔）+ 启停与元数据修正；
 *    禁用后用户端列表/聊天/OCR 全链路过滤（桌面端不可选）。
 * 权限：写操作 admin.ai.manage（061 迁移，仅授 super_admin，前端通配放行）；
 *   全局参数保存走 /api/admin/configs（admin.configs.manage）。
 */

/** ai_default_provider 可选供应商族（与后端 PROVIDER_PRESETS 键对齐，含 038 种子默认值 openrouter） */
const DEFAULT_PROVIDER_OPTIONS = [
  { value: 'openrouter', label: 'openrouter' },
  { value: 'openai', label: 'openai' },
  { value: 'anthropic', label: 'anthropic' },
  { value: 'deepseek', label: 'deepseek' },
  { value: 'qwen', label: 'qwen' },
  { value: 'hunyuan', label: 'hunyuan' },
  { value: 'custom', label: 'custom' },
];

/** 全局联网搜索源（与后端 utils/searchProviders.SEARCH_PROVIDERS 对齐） */
const SEARCH_PROVIDER_OPTIONS = [
  { value: 'anysearch', label: 'AnySearch（每天 2000 次免费）' },
  { value: 'bocha', label: '博查 Bocha（国产）' },
  { value: 'brave', label: 'Brave Search' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'searxng', label: '自建 SearXNG' },
];

/** 全局搜索草稿（key 输入框永不回显已存值，留空=不修改） */
interface SearchDraft {
  provider: string;
  apiKey: string;
  baseUrl: string;
}

/** 全局参数草稿 */
interface AiParamDraft {
  maxTokens: number | null;
  defaultProvider: string;
}

export default function AiPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  // ---- 供应商列表 ----
  const providersQuery = useQuery({
    queryKey: aiKeys.list(),
    queryFn: getAiProviders,
  });
  const providers = providersQuery.data ?? [];

  // ---- 全局参数（复用 configs API，仅取 AI 两键）----
  const configsQuery = useQuery({
    queryKey: ['configs'],
    queryFn: getConfigs,
    staleTime: 5 * 60_000,
  });
  const aiConfigs = useMemo(
    () =>
      (configsQuery.data ?? []).filter((c) => c.key === 'ai_max_tokens' || c.key === 'ai_default_provider'),
    [configsQuery.data],
  );

  const [draft, setDraft] = useState<AiParamDraft>({ maxTokens: null, defaultProvider: '' });
  useEffect(() => {
    if (!configsQuery.data) return;
    const maxTokens = Number(
      configsQuery.data.find((c) => c.key === 'ai_max_tokens')?.value ?? '4096'
    );
    setDraft({
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null,
      defaultProvider:
        configsQuery.data.find((c) => c.key === 'ai_default_provider')?.value ?? '',
    });
  }, [configsQuery.data]);

  // ---- 全局搜索（ai_search_* 三键，用户未配时的全局兜底）----
  const searchConfigs = useMemo(
    () =>
      (configsQuery.data ?? []).filter((c) =>
        ['ai_search_provider', 'ai_search_api_key_encrypted', 'ai_search_base_url'].includes(c.key),
      ),
    [configsQuery.data],
  );
  const [searchDraft, setSearchDraft] = useState<SearchDraft>({ provider: '', apiKey: '', baseUrl: '' });
  useEffect(() => {
    if (!configsQuery.data) return;
    setSearchDraft({
      // 后端对加密 key 只回"已配置/未配置"，下拉与地址回显真实值
      provider: configsQuery.data.find((c) => c.key === 'ai_search_provider')?.value ?? '',
      apiKey: '',
      baseUrl: configsQuery.data.find((c) => c.key === 'ai_search_base_url')?.value ?? '',
    });
  }, [configsQuery.data]);
  const searchKeyConfigured =
    searchConfigs.find((c) => c.key === 'ai_search_api_key_encrypted')?.value === '已配置';
  const [searchSaving, setSearchSaving] = useState(false);
  const searchDirty =
    searchDraft.provider !== (searchConfigs.find((c) => c.key === 'ai_search_provider')?.value ?? '') ||
    searchDraft.apiKey.trim() !== '' ||
    searchDraft.baseUrl !== (searchConfigs.find((c) => c.key === 'ai_search_base_url')?.value ?? '');
  const saveSearch = async (reason: string) => {
    setSearchSaving(true);
    try {
      const curProvider = searchConfigs.find((c) => c.key === 'ai_search_provider')?.value ?? '';
      const curBaseUrl = searchConfigs.find((c) => c.key === 'ai_search_base_url')?.value ?? '';
      if (searchDraft.provider !== curProvider) {
        await patchConfig('ai_search_provider', searchDraft.provider, reason);
      }
      if (searchDraft.apiKey.trim() !== '') {
        await patchConfig('ai_search_api_key_encrypted', searchDraft.apiKey.trim(), reason);
      }
      if (searchDraft.baseUrl !== curBaseUrl) {
        await patchConfig('ai_search_base_url', searchDraft.baseUrl, reason);
      }
      setSearchDraft((prev) => ({ ...prev, apiKey: '' }));
      await queryClient.invalidateQueries({ queryKey: ['configs'] });
      void message.success('全局搜索配置已更新（用户未配搜索源时兜底生效）');
      setReasonOpen(false);
    } finally {
      setSearchSaving(false);
    }
  };

  const [reasonOpen, setReasonOpen] = useState(false);
  // 确认框归属：params=全局参数，search=全局搜索（共用一个 ConfirmReasonModal）
  const [reasonFor, setReasonFor] = useState<'params' | 'search'>('params');
  const [saving, setSaving] = useState(false);

  const canManageProviders = hasPerm('admin.ai.manage');
  const canManageConfigs = hasPerm('admin.configs.manage');

  // 全局参数保存：逐键 PATCH（写审计 admin.config.update；服务端自动失效 AI 运行时缓存）
  const saveParams = async (reason: string) => {
    setSaving(true);
    try {
      const maxTokensConfig = aiConfigs.find((c) => c.key === 'ai_max_tokens');
      const providerConfig = aiConfigs.find((c) => c.key === 'ai_default_provider');
      if (maxTokensConfig && draft.maxTokens !== null && String(draft.maxTokens) !== maxTokensConfig.value) {
        await patchConfig('ai_max_tokens', String(draft.maxTokens), reason);
      }
      if (providerConfig && draft.defaultProvider !== providerConfig.value) {
        await patchConfig('ai_default_provider', draft.defaultProvider, reason);
      }
      await queryClient.invalidateQueries({ queryKey: ['configs'] });
      void message.success('AI 全局参数已更新并写入审计（≤5s 内对 AI 链路生效）');
      setReasonOpen(false);
    } finally {
      setSaving(false);
    }
  };

  // 供应商启停/编辑：写审计 admin.ai_provider.update，禁用即时从用户端消失
  const patchProviderMutation = useMutation({
    mutationFn: (payload: { id: string; patch: { enabled?: boolean } }) =>
      patchAiProvider(payload.id, payload.patch),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.list() });
      void message.success(
        data.enabled ? `供应商「${data.name}」已启用` : `供应商「${data.name}」已禁用，桌面端不可选`
      );
    },
  });

  const paramsDirty =
    draft.maxTokens !== null &&
    String(draft.maxTokens) !== aiConfigs.find((c) => c.key === 'ai_max_tokens')?.value;

  const columns = [
    { title: '用户', dataIndex: 'user_label', key: 'user_label', width: 140 },
    {
      title: '供应商',
      dataIndex: 'provider',
      key: 'provider',
      width: 110,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    { title: '名称', dataIndex: 'name', key: 'name', width: 160, ellipsis: true },
    { title: '模型', dataIndex: 'model', key: 'model', width: 180, ellipsis: true },
    {
      title: '密钥',
      dataIndex: 'has_key',
      key: 'has_key',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>),
    },
    {
      title: 'Base URL',
      dataIndex: 'base_url',
      key: 'base_url',
      ellipsis: true,
      render: (v: string) => v || <Typography.Text type="secondary">预设默认</Typography.Text>,
    },
    {
      title: '用户默认',
      dataIndex: 'is_default',
      key: 'is_default',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="blue">默认</Tag> : '-'),
    },
    {
      title: '启停',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (v: boolean, record: AdminAiProvider) => (
        <Switch
          checked={v}
          checkedChildren="启用"
          unCheckedChildren="禁用"
          disabled={!canManageProviders}
          loading={patchProviderMutation.isPending && patchProviderMutation.variables?.id === record.id}
          onChange={(next) => patchProviderMutation.mutate({ id: record.id, patch: { enabled: next } })}
        />
      ),
    },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 130 },
  ];

  return (
    <div>
      <PageHeader
        title="AI 平台"
        description="AI 供应商全局管理与全局参数（AN-03）：禁用供应商即时对桌面端生效；全局参数 ≤5s 内对 AI 链路生效，变更写入审计日志"
      />

      <Card title="全局参数" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {aiConfigs.map((c) => (
            <div key={c.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  <span style={{ fontWeight: 600 }}>{c.name}</span>{' '}
                  <Typography.Text type="secondary" code style={{ fontSize: 12 }}>
                    {c.key}
                  </Typography.Text>
                </div>
                <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12, marginTop: 2 }}>
                  {c.description}
                </div>
                {c.consumer && (
                  <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12, marginTop: 2 }}>
                    消费方：{c.consumer}
                  </div>
                )}
              </div>
              <div style={{ flexShrink: 0 }}>
                {c.key === 'ai_max_tokens' ? (
                  <InputNumber
                    value={draft.maxTokens}
                    min={64}
                    max={1_000_000}
                    step={256}
                    precision={0}
                    disabled={!canManageConfigs}
                    onChange={(v) => setDraft((prev) => ({ ...prev, maxTokens: Number(v ?? 0) || null }))}
                  />
                ) : (
                  <Select
                    style={{ width: 200 }}
                    value={draft.defaultProvider || undefined}
                    options={DEFAULT_PROVIDER_OPTIONS}
                    placeholder="未配置（不做兜底路由）"
                    allowClear
                    showSearch
                    disabled={!canManageConfigs}
                    onChange={(v) => setDraft((prev) => ({ ...prev, defaultProvider: v ?? '' }))}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <Button
            type="primary"
            disabled={!canManageConfigs || !paramsDirty}
            loading={saving}
            onClick={() => {
              setReasonFor('params');
              setReasonOpen(true);
            }}
          >
            保存全局参数
          </Button>
          <Typography.Text type="secondary">
            保存后写审计日志并失效 AI 运行时缓存（≤5s 生效）；供应商族用于客户端未指定供应商时的兜底路由
          </Typography.Text>
        </div>
      </Card>

      <Card title="全局联网搜索（用户未配置时的兜底）" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>搜索源</div>
              <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12, marginTop: 2 }}>
                用户在桌面端 AI 设置中未配置搜索源时，使用此处配置；用户已配则优先用用户的
              </div>
            </div>
            <div style={{ flexShrink: 0 }}>
              <Select
                style={{ width: 240 }}
                value={searchDraft.provider || undefined}
                options={SEARCH_PROVIDER_OPTIONS}
                placeholder="未配置（AnySearch 匿名额度）"
                allowClear
                showSearch
                disabled={!canManageConfigs}
                onChange={(v) => setSearchDraft((prev) => ({ ...prev, provider: v ?? '' }))}
              />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                API Key {searchKeyConfigured && <Tag color="green">已配置</Tag>}
              </div>
              <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12, marginTop: 2 }}>
                加密存储，永不回显；留空表示不修改（自建 SearXNG 不需要 Key）
              </div>
            </div>
            <div style={{ flexShrink: 0 }}>
              <Input.Password
                style={{ width: 240 }}
                placeholder={searchKeyConfigured ? '已配置，留空不修改' : '输入搜索源 Key'}
                disabled={!canManageConfigs}
                value={searchDraft.apiKey}
                onChange={(e) => setSearchDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
            </div>
          </div>
          {searchDraft.provider === 'searxng' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>自建地址</div>
                <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12, marginTop: 2 }}>
                  公网地址，如 https://search.example.com（内网地址会被 SSRF 防护拒绝）
                </div>
              </div>
              <div style={{ flexShrink: 0 }}>
                <Input
                  style={{ width: 240 }}
                  placeholder="https://search.example.com"
                  disabled={!canManageConfigs}
                  value={searchDraft.baseUrl}
                  onChange={(e) => setSearchDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
                />
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <Button
            type="primary"
            disabled={!canManageConfigs || !searchDirty}
            loading={searchSaving}
            onClick={() => {
              setReasonFor('search');
              setReasonOpen(true);
            }}
          >
            保存全局搜索
          </Button>
          <Typography.Text type="secondary">保存后写入审计日志，用户未配搜索源时即时兜底生效</Typography.Text>
        </div>
      </Card>

      <Card title="供应商列表（全用户）">
        <Table
          rowKey="id"
          size="small"
          loading={providersQuery.isLoading}
          dataSource={providers}
          columns={columns}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{
            rowExpandable: () => true,
            expandedRowRender: (record: AdminAiProvider) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                用户 ID：{record.user_id}；密钥以 AES-256-GCM 加密落库，管理台不解密不回传（仅 has_key 布尔）。
                禁用后用户端供应商列表不再返回该行，聊天 / 摘要 / OCR / 兜底路由全链路按不存在处理。
              </Typography.Text>
            ),
          }}
        />
      </Card>

      <ConfirmReasonModal
        open={reasonOpen}
        title={reasonFor === 'search' ? '保存全局搜索配置' : '保存 AI 全局参数'}
        danger={false}
        confirmText="确认保存"
        confirmLoading={reasonFor === 'search' ? searchSaving : saving}
        description={
          reasonFor === 'search'
            ? '将更新全局联网搜索配置（写入审计日志，用户未配搜索源时即时兜底生效）。'
            : '将更新 AI 全局参数（写入审计日志，≤5s 内对全部 AI 调用生效）。'
        }
        onCancel={() => setReasonOpen(false)}
        onConfirm={(reason) => (reasonFor === 'search' ? saveSearch(reason) : saveParams(reason))}
      />
    </div>
  );
}
