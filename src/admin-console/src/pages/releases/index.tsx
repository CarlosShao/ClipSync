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
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import {
  createRelease,
  deleteRelease,
  getReleases,
  patchRelease,
  releaseKeys,
} from '@/api/releases';
import type { AppRelease, ReleasePatchPayload } from '@/api/releases';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { fmtDate } from '@/utils/format';
import { hasPerm } from '@/utils/permissions';

/**
 * 版本发布管理页（AN-04）：
 * 表格展示全部版本（含草稿）+ 新建/编辑 Modal + 发布/撤回（is_published 切换）+
 * 删除（ConfirmReasonModal 必填原因）。
 * 写操作走 POST/PATCH/DELETE /api/admin/releases（后端白名单校验 + 写审计 admin.release.*），
 * 成功后失效 ['releases'] 前缀刷新列表。
 */

interface ReleaseFormValues {
  version: string;
  name: string;
  release_date: string | null;
  notes: string;
  platforms: string;
  force_update: boolean;
  rollout_percent: number | null;
}

/** platforms 编辑区固定提示：键名与 Tauri updater target 一致 */
const PLATFORMS_HINT =
  '键名为 Tauri updater target（如 windows-x86_64 / darwin-aarch64 / linux-x86_64），值为 { "url": "下载地址", "signature": "签名(可选)" }';

const columns: ColumnsType<AppRelease> = [
  {
    title: '版本',
    dataIndex: 'version',
    width: 110,
    render: (_: string, record) => (
      <div>
        <div style={{ fontWeight: 600 }}>v{record.version}</div>
        <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 12 }}>{record.name || '—'}</div>
      </div>
    ),
  },
  {
    title: '发布日期',
    dataIndex: 'releaseDate',
    width: 110,
    render: (value: AppRelease['releaseDate']) => (value ? fmtDate(value) : '—'),
  },
  {
    title: '平台',
    dataIndex: 'platforms',
    width: 150,
    render: (_: unknown, record) => {
      const targets = Object.keys(record.platforms ?? {});
      return targets.length ? (
        <Space size={4} wrap>
          {targets.map((t) => (
            <Tag key={t} style={{ marginInlineEnd: 0 }}>
              {t}
            </Tag>
          ))}
        </Space>
      ) : (
        '—'
      );
    },
  },
  {
    title: '强制更新',
    dataIndex: 'forceUpdate',
    width: 90,
    render: (value: AppRelease['forceUpdate']) =>
      value ? <StatusTag tone="red">强制</StatusTag> : <span style={{ fontSize: 12 }}>否</span>,
  },
  {
    title: '灰度',
    dataIndex: 'rolloutPercent',
    width: 80,
    render: (value: AppRelease['rolloutPercent']) => `${value}%`,
  },
  {
    title: '状态',
    dataIndex: 'isPublished',
    width: 90,
    render: (value: AppRelease['isPublished']) => (
      <StatusTag tone={value ? 'green' : 'gray'}>{value ? '已发布' : '草稿'}</StatusTag>
    ),
  },
  {
    title: '发布时间',
    dataIndex: 'publishedAt',
    width: 110,
    render: (value: AppRelease['publishedAt']) => (value ? fmtDate(value) : '—'),
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    width: 110,
    render: (value: AppRelease['createdAt']) => fmtDate(value),
  },
];

export default function ReleasesPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ReleaseFormValues>();
  /** null=关闭；'new'=新建；AppRelease=编辑 */
  const [editing, setEditing] = useState<AppRelease | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<AppRelease | null>(null);

  const releasesQuery = useQuery({
    queryKey: releaseKeys.list(),
    queryFn: getReleases,
  });
  const releases = releasesQuery.data ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: releaseKeys.list() });

  // 新建（POST）
  const createMutation = useMutation({
    mutationFn: createRelease,
    onSuccess: (created) => {
      void invalidate();
      void message.success(`版本 v${created.version} 已创建，变更记入审计日志`);
      setEditing(null);
    },
  });

  // 编辑 / 发布 / 撤回（PATCH）
  const patchMutation = useMutation({
    mutationFn: (payload: { id: string; patch: ReleasePatchPayload }) =>
      patchRelease(payload.id, payload.patch),
    onSuccess: (updated) => {
      void invalidate();
      void message.success(`版本 v${updated.version} 已更新，变更记入审计日志`);
      setEditing(null);
    },
  });

  // 删除（DELETE，reason 必填）
  const deleteMutation = useMutation({
    mutationFn: (payload: { id: string; reason: string }) =>
      deleteRelease(payload.id, payload.reason),
    onSuccess: () => {
      void invalidate();
      void message.success('版本已删除，原因记入审计日志');
      setDeleting(null);
    },
  });

  const canManage = hasPerm('admin.release.manage');

  const openEdit = (release: AppRelease) => {
    setEditing(release);
    form.setFieldsValue({
      version: release.version,
      name: release.name,
      release_date: release.releaseDate ?? null,
      notes: release.notes,
      platforms: JSON.stringify(release.platforms ?? {}, null, 2),
      force_update: release.forceUpdate,
      rollout_percent: release.rolloutPercent,
    });
  };

  const openNew = () => {
    setEditing('new');
    form.setFieldsValue({
      version: '',
      name: '',
      release_date: new Date().toISOString().slice(0, 10),
      notes: '',
      platforms: JSON.stringify({}, null, 2),
      force_update: false,
      rollout_percent: 100,
    });
  };

  /** 提交新建/编辑：version 仅新建可填；is_published 不在表单里，跟随原状态 */
  const handleSave = async () => {
    const values = await form.validateFields();
    let parsedPlatforms: Record<string, { url: string }>;
    try {
      parsedPlatforms = JSON.parse(values.platforms) as Record<string, { url: string }>;
      if (parsedPlatforms === null || typeof parsedPlatforms !== 'object' || Array.isArray(parsedPlatforms)) {
        throw new Error('not object');
      }
    } catch {
      void message.error('platforms 必须是合法的 JSON 对象');
      return;
    }

    setSaving(true);
    try {
      if (editing === 'new') {
        createMutation.mutate({
          version: values.version.trim(),
          name: values.name.trim(),
          release_date: values.release_date || null,
          notes: values.notes,
          platforms: parsedPlatforms,
          force_update: values.force_update,
          rollout_percent: values.rollout_percent ?? 100,
          is_published: false,
        });
      } else if (editing) {
        patchMutation.mutate({
          id: editing.id,
          patch: {
            name: values.name.trim(),
            release_date: values.release_date || null,
            notes: values.notes,
            platforms: parsedPlatforms,
            force_update: values.force_update,
            rollout_percent: values.rollout_percent ?? 100,
          },
        });
      }
    } finally {
      setSaving(false);
    }
  };

  /** 发布/撤回（回滚）：切 is_published，客户端 60s 缓存内生效 */
  const togglePublish = (release: AppRelease) => {
    patchMutation.mutate({
      id: release.id,
      patch: { is_published: !release.isPublished },
    });
  };

  return (
    <div>
      <PageHeader
        title="版本发布"
        description="管理客户端版本发布与回滚；发布/撤回经公开更新端点对客户端生效（进程缓存最长 60s）"
        extra={
          canManage ? (
            <Button type="primary" onClick={openNew}>
              新建版本
            </Button>
          ) : null
        }
      />
      <Card>
        <Table<AppRelease>
          rowKey="id"
          columns={[
            ...columns,
            {
              title: '操作',
              key: 'actions',
              width: 180,
              render: (_: unknown, record) =>
                canManage ? (
                  <Space size={0}>
                    <Button type="link" size="small" onClick={() => openEdit(record)}>
                      编辑
                    </Button>
                    <Button type="link" size="small" onClick={() => togglePublish(record)}>
                      {record.isPublished ? '撤回' : '发布'}
                    </Button>
                    <Button type="link" size="small" danger onClick={() => setDeleting(record)}>
                      删除
                    </Button>
                  </Space>
                ) : (
                  <span style={{ color: 'var(--text-tertiary, #999)', fontSize: 12 }}>只读</span>
                ),
            },
          ]}
          dataSource={releases}
          loading={releasesQuery.isLoading}
          pagination={false}
          scroll={{ x: 1100 }}
        />
      </Card>

      <Modal
        title={editing === 'new' ? '新建版本' : `编辑版本 · v${editing && editing !== 'new' ? editing.version : ''}`}
        open={editing !== null}
        onOk={() => void handleSave()}
        onCancel={() => setEditing(null)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={560}
        destroyOnHidden
      >
        <Form<ReleaseFormValues> form={form} layout="vertical">
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item
              name="version"
              label="版本号"
              style={{ flex: 1 }}
              rules={[
                { required: true, message: '版本号不能为空' },
                {
                  pattern: /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
                  message: '须为语义化版本号（如 1.2.0）',
                },
              ]}
              extra={editing !== 'new' ? '建单后版本号不可修改' : undefined}
            >
              <Input maxLength={50} disabled={editing !== 'new'} placeholder="1.2.0" />
            </Form.Item>
            <Form.Item name="name" label="版本名称" style={{ flex: 1 }}>
              <Input maxLength={100} placeholder="如：秋分更新" />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="release_date" label="发布日期" style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="rollout_percent" label="灰度比例（%）" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} max={100} precision={0} />
            </Form.Item>
          </div>
          <Form.Item name="notes" label="更新说明">
            <Input.TextArea rows={4} maxLength={10000} />
          </Form.Item>
          <Form.Item
            name="platforms"
            label="平台下载信息（JSON 对象）"
            rules={[
              {
                validator: (_rule: unknown, value: unknown) => {
                  if (typeof value !== 'string' || value.trim() === '') return Promise.resolve();
                  try {
                    const parsed = JSON.parse(value) as unknown;
                    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                      return Promise.reject(new Error('须为 JSON 对象'));
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
          <Alert type="info" showIcon message={PLATFORMS_HINT} style={{ marginBottom: 16 }} />
          <Form.Item name="force_update" label="是否强制更新" valuePropName="checked">
            <Switch checkedChildren="强制" unCheckedChildren="可选" />
          </Form.Item>
        </Form>
      </Modal>

      <ConfirmReasonModal
        open={deleting !== null}
        title={`删除版本 · v${deleting?.version ?? ''}`}
        description="删除后客户端更新端点立即不再返回该版本；正在使用的旧版本不受影响。"
        confirmText="确认删除"
        confirmLoading={deleteMutation.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={(reason) => {
          if (deleting) deleteMutation.mutate({ id: deleting.id, reason });
        }}
      />
    </div>
  );
}
