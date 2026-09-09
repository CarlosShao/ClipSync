import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  InputNumber,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { getClientPolicies, patchPolicies, policyKeys } from '@/api/policies';
import type { ClientPolicy, ClientPolicyPatchPayload } from '@/api/types';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { PageHeader } from '@/components/PageHeader';
import { hasPerm } from '@/utils/permissions';

/**
 * 客户端策略下发页（AN-02）：
 * 分组表单渲染 GET /api/admin/policies（同步 / 隐私），编辑值与「允许用户覆盖」开关；
 * 保存走 ConfirmReasonModal 收集原因（写入审计 admin.policy.update），仅提交变更键。
 * consumer 为 null 的键打「未接入」角标（AN-09 机制——改了不生效，运营可分辨）。
 */

const GROUP_ORDER = ['sync', 'privacy'] as const;

const GROUP_META: Record<string, { label: string; description: string }> = {
  sync: { label: '同步', description: '同步频率与本地历史保留的企业管控边界' },
  privacy: { label: '隐私', description: '客户端隐私保护策略（PIN 位数等）' },
};

/** 可编辑草稿（单键）：数值 + 是否允许用户在客户端自行修改 */
interface PolicyDraft {
  value: number;
  allowUserOverride: boolean;
}

function draftOf(policies: ClientPolicy[]): Record<string, PolicyDraft> {
  return Object.fromEntries(
    policies.map((p) => [p.key, { value: p.value, allowUserOverride: p.allowUserOverride }])
  );
}

/** 与服务端快照 diff，仅收集变更键（空变更不进 PATCH body） */
function buildPatch(
  policies: ClientPolicy[],
  draft: Record<string, PolicyDraft>
): ClientPolicyPatchPayload {
  const patch: ClientPolicyPatchPayload = {};
  for (const p of policies) {
    const d = draft[p.key];
    if (!d) continue;
    if (d.value !== p.value || d.allowUserOverride !== p.allowUserOverride) {
      patch[p.key] = { value: d.value, allowUserOverride: d.allowUserOverride };
    }
  }
  return patch;
}

export default function PoliciesPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const policiesQuery = useQuery({
    queryKey: policyKeys.detail(),
    queryFn: getClientPolicies,
  });
  const policies = policiesQuery.data?.policies ?? [];
  const updatedAt = policiesQuery.data?.updatedAt ?? null;

  // 草稿状态：查询数据到达/失效刷新时重置（服务端值为渲染基准）
  const [draft, setDraft] = useState<Record<string, PolicyDraft>>({});
  useEffect(() => {
    if (policiesQuery.data) setDraft(draftOf(policies));
  }, [policiesQuery.data]);

  const [reasonOpen, setReasonOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const patchMutation = useMutation({
    mutationFn: (payload: { patch: ClientPolicyPatchPayload; reason: string }) =>
      patchPolicies(payload.patch, payload.reason),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: policyKeys.detail() });
      void message.success(
        `客户端策略已更新（${Object.keys(data.policies).length} 键），WS 已广播在线客户端`
      );
      setReasonOpen(false);
    },
  });

  const canManage = hasPerm('admin.configs.manage');

  // 分组渲染：目录顺序优先，未知分组兜底「其他」
  const grouped = useMemo(() => {
    const groups = new Map<string, ClientPolicy[]>();
    for (const p of policies) {
      const list = groups.get(p.group) ?? [];
      list.push(p);
      groups.set(p.group, list);
    }
    const ordered: Array<{ group: string; label: string; description: string; items: ClientPolicy[] }> = [];
    for (const g of GROUP_ORDER) {
      if (groups.has(g)) {
        ordered.push({ group: g, ...(GROUP_META[g] ?? { label: g, description: '' }), items: groups.get(g)! });
        groups.delete(g);
      }
    }
    for (const [g, items] of groups) {
      ordered.push({ group: g, label: GROUP_META[g]?.label ?? '其他', description: GROUP_META[g]?.description ?? '', items });
    }
    return ordered;
  }, [policies]);

  const pendingPatch = useMemo(() => buildPatch(policies, draft), [policies, draft]);
  const pendingCount = Object.keys(pendingPatch).length;
  const unconsumedCount = policies.filter((p) => !p.consumer).length;

  const updateDraft = (key: string, next: Partial<PolicyDraft>) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...next } }));
  };

  const handleConfirm = async (reason: string) => {
    setSaving(true);
    try {
      await patchMutation.mutateAsync({ patch: pendingPatch, reason });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="客户端策略"
        description="面向桌面端下发的全局策略（AN-02）：保存后 WS 广播在线客户端即时生效，未连接端下次启动拉取；变更写入审计日志"
      />

      {unconsumedCount > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={<Tag color="red">未接入 {unconsumedCount} 项</Tag>}
          description="存在未接入消费方的策略键（改了不生效），以条目旁「未接入」角标为准。"
        />
      )}

      {updatedAt && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          最近更新：{updatedAt.replace('T', ' ').slice(0, 19)}
        </Typography.Paragraph>
      )}

      {grouped.map(({ group, label, description, items }) => (
        <Card
          key={group}
          title={`${label}策略`}
          style={{ marginBottom: 16 }}
        >
          {description && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              {description}
            </Typography.Paragraph>
          )}
          {items.map((p) => {
            const d = draft[p.key];
            const customized = d && d.value !== p.defaultValue;
            return (
              <div
                key={p.key}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 16,
                  padding: '12px 0',
                  borderTop: '1px solid var(--border, #f0f0f0)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>{' '}
                    <Typography.Text type="secondary" code style={{ fontSize: 12 }}>
                      {p.key}
                    </Typography.Text>
                    {!p.consumer && (
                      <Tag color="red" style={{ marginLeft: 8 }}>
                        未接入
                      </Tag>
                    )}
                    {customized && (
                      <Tag color="blue" style={{ marginLeft: 8 }}>
                        已自定义（默认 {p.defaultValue}）
                      </Tag>
                    )}
                  </div>
                  <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12, marginTop: 2 }}>
                    {p.description}
                  </div>
                  {p.consumer && (
                    <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12, marginTop: 2 }}>
                      消费方：{p.consumer}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexShrink: 0 }}>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary, #999)', marginBottom: 4 }}>
                      策略值（{p.min}–{p.max}）
                    </div>
                    <InputNumber
                      value={d?.value}
                      min={p.min}
                      max={p.max}
                      precision={0}
                      disabled={!canManage}
                      onChange={(v) => updateDraft(p.key, { value: Number(v ?? p.defaultValue) })}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary, #999)', marginBottom: 4 }}>
                      允许用户覆盖
                    </div>
                    <Switch
                      checked={d?.allowUserOverride ?? true}
                      disabled={!canManage}
                      checkedChildren="可改"
                      unCheckedChildren="锁定"
                      onChange={(v) => updateDraft(p.key, { allowUserOverride: v })}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button
          type="primary"
          disabled={!canManage || pendingCount === 0}
          loading={saving}
          onClick={() => setReasonOpen(true)}
        >
          保存策略{pendingCount > 0 ? `（${pendingCount} 项变更）` : ''}
        </Button>
        {!canManage && (
          <Typography.Text type="secondary">无 admin.configs.manage 权限，只读</Typography.Text>
        )}
      </div>

      <ConfirmReasonModal
        open={reasonOpen}
        title="保存客户端策略"
        danger={false}
        confirmText="确认保存"
        confirmLoading={saving}
        description={`将下发 ${pendingCount} 项策略变更至全部客户端（WS 广播 + 审计留痕）。`}
        onCancel={() => setReasonOpen(false)}
        onConfirm={(reason) => handleConfirm(reason)}
      />
    </div>
  );
}
