import { Form, Input, InputNumber, Modal } from 'antd';
import { useEffect, useState } from 'react';
import type { CreateRolePayload } from '@/api/types';

const { TextArea } = Input;

interface CreateRoleModalProps {
  open: boolean;
  confirmLoading?: boolean;
  onCancel: () => void;
  /** 校验通过后回调；抛错则弹窗保持打开（错误提示由拦截器统一 toast） */
  onConfirm: (payload: CreateRolePayload) => void | Promise<unknown>;
}

interface CreateRoleFormValues {
  roleKey: string;
  name: string;
  level: number;
  description?: string;
}

const ROLE_KEY_RE = /^custom_[a-z0-9_]+$/;

/** 新建角色弹窗（对照草图 + 新建角色按钮）：role_key（custom_ 前缀校验）/名称/级别/描述 */
export function CreateRoleModal({ open, confirmLoading = false, onCancel, onConfirm }: CreateRoleModalProps) {
  const [form] = Form.useForm<CreateRoleFormValues>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
    }
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onConfirm({
        roleKey: values.roleKey.trim(),
        name: values.name.trim(),
        level: values.level,
        description: values.description?.trim() || undefined,
      });
    } catch {
      // 表单校验失败或提交失败：错误已由表单/拦截器提示，弹窗保持打开
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新建角色"
      okText="创建角色"
      cancelText="取消"
      okButtonProps={{ loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={() => (submitting ? undefined : onCancel())}
      maskClosable={false}
      width={440}
    >
      <Form<CreateRoleFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ level: 10 }}
      >
        <Form.Item
          name="roleKey"
          label="角色标识（role_key）"
          rules={[
            { required: true, whitespace: true, message: '请输入角色标识' },
            {
              pattern: ROLE_KEY_RE,
              message: '必须以 custom_ 开头，仅含小写字母 / 数字 / 下划线',
            },
          ]}
          extra="自定义角色标识固定 custom_ 前缀，创建后不可修改"
        >
          <Input placeholder="例如：custom_support" maxLength={40} allowClear />
        </Form.Item>
        <Form.Item
          name="name"
          label="角色名称"
          rules={[{ required: true, whitespace: true, message: '请输入角色名称' }]}
        >
          <Input placeholder="例如：客服专员" maxLength={20} allowClear />
        </Form.Item>
        <Form.Item
          name="level"
          label="级别（level）"
          rules={[{ required: true, message: '请输入级别' }]}
          extra="1–99；低级别角色不可持有「高危 / 仅超管」权限，也不可管理高级别角色"
        >
          <InputNumber style={{ width: '100%' }} min={1} max={99} precision={0} />
        </Form.Item>
        <Form.Item name="description" label="描述（可选）">
          <TextArea rows={3} maxLength={100} showCount placeholder="说明该角色的职责范围" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
