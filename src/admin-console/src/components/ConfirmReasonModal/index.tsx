import { Form, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const { TextArea } = Input;

interface ConfirmReasonModalProps {
  open: boolean;
  title: string;
  /** 弹窗正文说明（含影响范围提示） */
  description?: ReactNode;
  reasonLabel?: string;
  confirmText?: string;
  confirmLoading?: boolean;
  danger?: boolean;
  onCancel: () => void;
  /** 校验通过后回调；抛错则弹窗保持打开（错误提示由拦截器统一 toast） */
  onConfirm: (reason: string) => void | Promise<unknown>;
}

/**
 * 危险操作确认弹窗（停用/删除/退款/改角色统一入口）。
 * 原因必填，提交体带 reason，与后端审计字段对齐（03 方案 §4.4）。
 */
export function ConfirmReasonModal({
  open,
  title,
  description,
  reasonLabel = '原因（必填，写入审计日志）',
  confirmText = '确认',
  confirmLoading = false,
  danger = true,
  onCancel,
  onConfirm,
}: ConfirmReasonModalProps) {
  const [form] = Form.useForm<{ reason: string }>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) form.resetFields();
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onConfirm(values.reason.trim());
    } catch {
      // 表单校验失败或提交失败：错误已由表单/拦截器提示
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      okText={confirmText}
      cancelText="取消"
      okButtonProps={{ danger, loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
      width={430}
    >
      {description ? <div style={{ marginBottom: 13, color: 'var(--text-2)' }}>{description}</div> : null}
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="reason"
          label={reasonLabel}
          rules={[
            { required: true, whitespace: true, message: '请填写原因（将写入审计日志）' },
            { min: 2, message: '原因至少 2 个字符' },
          ]}
        >
          <TextArea
            rows={3}
            maxLength={200}
            showCount
            placeholder="例如：用户重复支付"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
