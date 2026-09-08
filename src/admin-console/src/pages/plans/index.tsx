import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Switch,
  Table,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { getPlans, patchPlan, planKeys } from '@/api/plans';
import type { AdminPlan, PlanPatchPayload } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { fmtDate } from '@/utils/format';
import { hasPerm } from '@/utils/permissions';

/**
 * 套餐与价格管理页（AN-01）：
 * 表格展示三档套餐 + 行内「编辑」Modal（价格 / 配额 / 文件同步限额 / features JSON）。
 * 保存走 PATCH /api/admin/plans/:id（后端白名单校验 + 写审计 admin.plans.update），
 * 成功后失效 ['plans'] 前缀刷新列表。
 */

/** features 编辑区固定提示：哪些键在服务端有强制点（AN-01 工单要求，防「配了不生效」误判） */
const FEATURES_HINT =
  '当前仅 ai_classify、team_management 在服务端有强制点，其余键暂未挂墙';

interface PlanFormValues {
  display_name: string;
  price_monthly: number | null;
  price_yearly: number | null;
  max_devices: number | null;
  max_clipboard_items: number | null;
  max_file_size_mb: number | null;
  max_storage_mb: number | null;
  max_files_per_clip: number | null;
  file_retention_days: number | null;
  is_active: boolean;
  features: string;
}

/** 只收集发生变更的字段（不含则不进 PATCH body；空变更由页面提示不提交） */
function buildPatch(
  plan: AdminPlan,
  values: PlanFormValues,
): PlanPatchPayload {
  const patch: PlanPatchPayload = {};
  if (values.display_name.trim() !== plan.displayName) {
    patch.display_name = values.display_name.trim();
  }
  if ((values.price_monthly ?? null) !== plan.priceMonthly) {
    patch.price_monthly = values.price_monthly ?? null;
  }
  if ((values.price_yearly ?? null) !== plan.priceYearly) {
    patch.price_yearly = values.price_yearly ?? null;
  }
  if ((values.max_devices ?? null) !== plan.maxDevices) {
    patch.max_devices = values.max_devices ?? 0;
  }
  if ((values.max_clipboard_items ?? null) !== plan.maxClipboardItems) {
    patch.max_clipboard_items = values.max_clipboard_items ?? 0;
  }
  if ((values.max_file_size_mb ?? null) !== plan.maxFileSizeMb) {
    patch.max_file_size_mb = values.max_file_size_mb ?? 0;
  }
  if ((values.max_storage_mb ?? null) !== plan.maxStorageMb) {
    patch.max_storage_mb = values.max_storage_mb ?? 0;
  }
  if ((values.max_files_per_clip ?? null) !== plan.maxFilesPerClip) {
    patch.max_files_per_clip = values.max_files_per_clip ?? 0;
  }
  if ((values.file_retention_days ?? null) !== plan.fileRetentionDays) {
    patch.file_retention_days = values.file_retention_days ?? 0;
  }
  if (values.is_active !== plan.isActive) {
    patch.is_active = values.is_active;
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(values.features) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (parsed !== null && JSON.stringify(parsed) !== JSON.stringify(plan.features)) {
    patch.features = parsed;
  }
  return patch;
}

/** 格式化数字单元格：NULL 显示 — */
function numCell(value: number | null): string {
  return value === null || value === undefined ? '—' : String(value);
}

const columns: ColumnsType<AdminPlan> = [
  {
    title: '套餐',
    dataIndex: 'displayName',
    width: 140,
    render: (_: string, record) => (
      <div>
        <div style={{ fontWeight: 600 }}>{record.displayName}</div>
        <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12 }}>{record.name}</div>
      </div>
    ),
  },
  {
    title: '月价（元）',
    dataIndex: 'priceMonthly',
    width: 100,
    render: (value: AdminPlan['priceMonthly']) => (value === null ? '—' : `¥${value}`),
  },
  {
    title: '年价（元）',
    dataIndex: 'priceYearly',
    width: 100,
    render: (value: AdminPlan['priceYearly']) => (value === null ? '—' : `¥${value}`),
  },
  {
    title: '设备数',
    dataIndex: 'maxDevices',
    width: 80,
    render: numCell,
  },
  {
    title: '剪贴板条数',
    dataIndex: 'maxClipboardItems',
    width: 110,
    render: numCell,
  },
  {
    title: '单文件上限 (MB)',
    dataIndex: 'maxFileSizeMb',
    width: 130,
    render: numCell,
  },
  {
    title: '总容量 (MB)',
    dataIndex: 'maxStorageMb',
    width: 110,
    render: numCell,
  },
  {
    title: '单次文件数',
    dataIndex: 'maxFilesPerClip',
    width: 100,
    render: numCell,
  },
  {
    title: '保留天数',
    dataIndex: 'fileRetentionDays',
    width: 90,
    render: numCell,
  },
  {
    title: '状态',
    dataIndex: 'isActive',
    width: 90,
    render: (value: AdminPlan['isActive']) => (
      <StatusTag tone={value ? 'green' : 'gray'}>{value ? '启用' : '停用'}</StatusTag>
    ),
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    width: 110,
    render: (value: AdminPlan['createdAt']) => fmtDate(value),
  },
];

export default function PlansPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<PlanFormValues>();
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  const [saving, setSaving] = useState(false);

  const plansQuery = useQuery({
    queryKey: planKeys.list(),
    queryFn: getPlans,
  });
  const plans = plansQuery.data ?? [];

  const patchMutation = useMutation({
    mutationFn: (payload: { id: string; patch: PlanPatchPayload }) =>
      patchPlan(payload.id, payload.patch),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: planKeys.list() });
      void message.success(`「${updated.displayName}」已更新，变更记入审计日志`);
      setEditing(null);
    },
  });

  const canManage = hasPerm('admin.plans.manage');

  const openEdit = (plan: AdminPlan) => {
    setEditing(plan);
    form.setFieldsValue({
      display_name: plan.displayName,
      price_monthly: plan.priceMonthly,
      price_yearly: plan.priceYearly,
      max_devices: plan.maxDevices,
      max_clipboard_items: plan.maxClipboardItems,
      max_file_size_mb: plan.maxFileSizeMb,
      max_storage_mb: plan.maxStorageMb,
      max_files_per_clip: plan.maxFilesPerClip,
      file_retention_days: plan.fileRetentionDays,
      is_active: plan.isActive,
      features: JSON.stringify(plan.features ?? {}, null, 2),
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    const values = await form.validateFields();
    const patch = buildPatch(editing, values);
    if (Object.keys(patch).length === 0) {
      void message.info('内容未变化，无需保存');
      return;
    }
    setSaving(true);
    try {
      patchMutation.mutate({ id: editing.id, patch });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="套餐与价格"
        description="管理套餐档位、价格与文件同步限额；保存即时生效并写入审计日志"
      />
      <Card>
        <Table<AdminPlan>
          rowKey="id"
          columns={[
            ...columns,
            {
              title: '操作',
              key: 'actions',
              width: 90,
              render: (_: unknown, record) =>
                canManage ? (
                  <Button type="link" size="small" onClick={() => openEdit(record)}>
                    编辑
                  </Button>
                ) : (
                  <span style={{ color: 'var(--text-tertiary, #999)', fontSize: 12 }}>只读</span>
                ),
            },
          ]}
          dataSource={plans}
          loading={plansQuery.isLoading}
          pagination={false}
          scroll={{ x: 1100 }}
        />
      </Card>

      <Modal
        title={editing ? `编辑套餐 · ${editing.displayName}` : '编辑套餐'}
        open={editing !== null}
        onOk={() => void handleSave()}
        onCancel={() => setEditing(null)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={560}
        destroyOnHidden
      >
        <Form<PlanFormValues> form={form} layout="vertical">
          <Form.Item
            name="display_name"
            label="套餐显示名"
            rules={[{ required: true, message: '套餐显示名不能为空' }]}
          >
            <Input maxLength={100} />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="price_monthly" label="月价（元）" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} max={999999.99} step={0.1} />
            </Form.Item>
            <Form.Item name="price_yearly" label="年价（元）" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} max={999999.99} step={0.1} />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="max_devices" label="设备数上限" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={0} />
            </Form.Item>
            <Form.Item name="max_clipboard_items" label="剪贴板条数上限" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={0} />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="max_file_size_mb" label="单文件上限 (MB)" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={0} />
            </Form.Item>
            <Form.Item name="max_storage_mb" label="总容量 (MB)" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={0} />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="max_files_per_clip" label="单次文件数上限" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={0} />
            </Form.Item>
            <Form.Item name="file_retention_days" label="文件保留天数" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={0} />
            </Form.Item>
          </div>
          <Form.Item
            name="features"
            label="features（JSON 对象）"
            rules={[
              {
                validator: (_rule: unknown, value: unknown) => {
                  if (typeof value !== 'string' || value.trim() === '') return Promise.resolve();
                  try {
                    const parsed = JSON.parse(value) as unknown;
                    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                      return Promise.reject(new Error('须为 JSON 对象（如 {"ai_classify":true}）'));
                    }
                    return Promise.resolve();
                  } catch {
                    return Promise.reject(new Error('须为合法 JSON 对象'));
                  }
                },
              },
            ]}
          >
            <Input.TextArea rows={5} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Alert type="warning" showIcon message={FEATURES_HINT} style={{ marginBottom: 16 }} />
          <Form.Item name="is_active" label="是否启用" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
