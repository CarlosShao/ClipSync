import { Alert, Form, Input, Modal, Select } from 'antd';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRoles } from '@/api/roles';

const { TextArea } = Input;

interface AssignRoleModalProps {
  open: boolean;
  /** 展示"改谁" */
  userLabel: string;
  /** 当前角色 id（用于预选；拿不到就不预选） */
  currentRoleId?: string | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (roleId: string, reason: string) => void | Promise<unknown>;
}

interface AssignRoleFormValues {
  roleId: string;
  reason: string;
}

/**
 * 分配角色弹窗（2026-10-05 补 UI）。
 *
 * 端点 `PATCH /api/admin/users/:id/role` **早就实现了**（含超管唯一性与越级两道闸 + 审计），
 * 但 `api/users.ts` 里一直没有对应函数、页面也没有入口 —— 属于"后端能用、客服却做不了"的
 * 纯缺 UI 缺口（`docs/audit/v1-full-audit-2026-09-22/13-cross-end-contract-consistency.md:252`
 * 已经记过这条）。这个弹窗只做接线，权限与两条闸仍在服务端。
 */
export function AssignRoleModal({
  open,
  userLabel,
  currentRoleId,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: AssignRoleModalProps) {
  const [form] = Form.useForm<AssignRoleFormValues>();
  const [submitting, setSubmitting] = useState(false);

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: getRoles,
    enabled: open,
  });

  // 超管角色不可授予（后端 403 40301 兜底）——前端也不给选项，别让人点下去才被拒
  const options = roles
    .filter((r) => r.roleKey !== 'super_admin' && r.level < 100)
    .map((r) => ({ value: r.id, label: `${r.name}（level ${r.level}）` }));

  useEffect(() => {
    if (open) {
      // 只预选"确实在当前可选项里"的角色，否则留空让用户自己选（不塞一个非法 id）
      const next: Partial<AssignRoleFormValues> = { reason: '' };
      if (currentRoleId && options.some((o) => o.value === currentRoleId)) {
        next.roleId = currentRoleId;
      }
      form.setFieldsValue(next);
    }
    // options 由 roles 派生，open 变化时才重置表单，避免拉取过程中把用户选择冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onConfirm(values.roleId, values.reason?.trim() ?? '');
    } catch {
      // 校验/提交失败：错误已由表单或拦截器提示，弹窗保持打开
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    form.resetFields();
    onCancel();
  };

  return (
    <Modal
      open={open}
      title="分配角色"
      okText="确认分配"
      cancelText="取消"
      okButtonProps={{ loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={460}
    >
      <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
        为 <b>{userLabel || '该用户'}</b> 指定角色。角色决定他能进管理台的哪些页面、能做哪些操作。
      </p>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="服务端另有两条闸"
        description="超级管理员角色不可授予他人；也不能授予等级不低于你自己的角色。写审计 role.assign。"
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="roleId"
          label="角色"
          rules={[{ required: true, message: '请选择角色' }]}
        >
          <Select
            loading={isLoading}
            options={options}
            placeholder={isLoading ? '加载角色中…' : '选择角色'}
          />
        </Form.Item>
        <Form.Item name="reason" label="原因（写入审计日志）">
          <TextArea rows={3} maxLength={200} showCount placeholder="例如：客服接管 · 工单 #4821" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
