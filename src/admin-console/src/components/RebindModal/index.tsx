import { Alert, Form, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';

interface RebindModalProps {
  open: boolean;
  userLabel: string;
  /** 当前的手机号/邮箱（接口下发的**打码**值，仅用于展示"从什么改成什么"） */
  currentPhone?: string | null;
  currentEmail?: string | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (payload: {
    phone?: string;
    email?: string;
    reason: string;
  }) => void | Promise<unknown>;
}

interface RebindFormValues {
  phone?: string;
  email?: string;
  reason: string;
}

/**
 * 换绑登录标识弹窗（2026-10-05 补 UI）。
 *
 * 为什么必须有：手机号就是**登录标识**（后端按 `phone` / `phone_hash` 查用户），
 * 用户换号以后就登不上了；而用户侧只能自己改邮箱、改不了手机号。
 * 之前客服只能改库 —— 而改库要同时改 `phone` / `phone_hash` / `phone_encrypted` 三列，
 * 少一列这个人就**再也登录不进来**。
 *
 * 界面口径：
 *   - 明确显示"当前值 → 新值"，避免客服填错账号；
 *   - 只填一项就是"只换那一项"（服务端用 COALESCE，不会把另一项清空）；
 *   - 提示邮箱会被**统一转小写**（登录按小写查，不统一就会出现查不到自己）；
 *   - 提示**已登录设备不会掉线**（换绑不吊销会话），客服别答错用户的追问。
 */
export function RebindModal({
  open,
  userLabel,
  currentPhone,
  currentEmail,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: RebindModalProps) {
  const [form] = Form.useForm<RebindFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [groupError, setGroupError] = useState('');

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ phone: '', email: '', reason: '' });
      setGroupError('');
    }
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const phone = values.phone?.trim() ?? '';
      const email = values.email?.trim() ?? '';
      // 「至少给一个」是跨字段规则，antd 的单字段 rules 表达不了，提交前自己判
      if (!phone && !email) {
        setGroupError('手机号与邮箱至少填一个');
        return;
      }
      setGroupError('');
      setSubmitting(true);
      await onConfirm({
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        reason: values.reason.trim(),
      });
    } catch {
      // 校验/提交失败：错误已由表单或拦截器提示，弹窗保持打开
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    form.resetFields();
    setGroupError('');
    onCancel();
  };

  return (
    <Modal
      open={open}
      title="换绑手机号 / 邮箱"
      okText="确认换绑"
      cancelText="取消"
      okButtonProps={{ danger: true, loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={480}
    >
      <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
        <b>{userLabel || '该用户'}</b> 当前：手机号 {currentPhone || '—'} · 邮箱 {currentEmail || '—'}
      </p>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="手机号是登录标识"
        description={
          <>
            换绑后用户必须用<b>新</b>手机号 / 邮箱登录；只填一项就只换那一项（另一项保持原值）。
            邮箱会统一转小写；已登录设备不会掉线。写审计 admin.user.rebind（只记打码值）。
          </>
        }
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="phone"
          label="新手机号（不换就不填）"
          rules={[
            {
              validator: (_, v: string | undefined) =>
                !v || /^1[3-9]\d{9}$/.test(v.trim())
                  ? Promise.resolve()
                  : Promise.reject(new Error('须为 11 位大陆手机号')),
            },
          ]}
        >
          <Input maxLength={11} placeholder="13800000000" />
        </Form.Item>
        <Form.Item
          name="email"
          label="新邮箱（不换就不填）"
          rules={[
            {
              validator: (_, v: string | undefined) =>
                !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
                  ? Promise.resolve()
                  : Promise.reject(new Error('邮箱格式不合法')),
            },
          ]}
        >
          <Input placeholder="user@example.com" />
        </Form.Item>
        <Form.Item
          name="reason"
          label="原因（必填，写入审计日志）"
          rules={[{ required: true, whitespace: true, message: '请填写换绑原因（将写入审计日志）' }]}
        >
          <Input.TextArea
            rows={3}
            maxLength={200}
            showCount
            placeholder="例如：用户换号 · 工单 #4821"
          />
        </Form.Item>
      </Form>
      {groupError ? (
        <p style={{ color: 'var(--red-6, #cf1322)', fontSize: 12.5, margin: 0 }}>{groupError}</p>
      ) : null}
    </Modal>
  );
}
