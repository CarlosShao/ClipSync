import { Alert, Button, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';

const { TextArea } = Input;

interface ResetPasswordModalProps {
  open: boolean;
  /** 展示"给谁重置" */
  userLabel: string;
  confirmLoading?: boolean;
  onCancel: () => void;
  /**
   * 提交重置。resolve 后弹窗切到「展示临时密码」态 —— 由本组件负责让运营**当场看到**，
   * 因为服务端只在这一次响应里给密码（不写审计、不写日志、无法再查）。
   */
  onConfirm: (reason: string) => Promise<{ temporaryPassword: string; sessionsRevoked: number }>;
}

interface ResetFormValues {
  reason: string;
}

/**
 * 代重置密码弹窗（2026-10-05 补 UI）。
 *
 * 为什么必须有这个入口：此前 `routes/admin/` 没有任何 password_hash 写路径，
 * 用户侧自助重置又都要验证码或旧密码 —— **手机+邮箱双失效 = 账号永久锁死**。
 *
 * 三个界面口径：
 *  ① 密码**只见一次**：切换成结果态后不再提供任何"再看一次"，文案写明关掉就拿不到；
 *  ② 必须**复制友好**（等宽字体 + 一键复制）—— 转达时会口头/工单传递，容易抄错；
 *  ③ 明说**旧会话已被吊销**（用户所有设备会掉线，需要重新登录），避免客服答不上"为什么我掉线了"。
 */
export function ResetPasswordModal({
  open,
  userLabel,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: ResetPasswordModalProps) {
  const [form] = Form.useForm<ResetFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ temporaryPassword: string; sessionsRevoked: number } | null>(
    null
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ reason: '' });
      setResult(null);
      setCopied(false);
    }
  }, [form, open]);

  const handleOk = async () => {
    if (result) {
      // 结果态：确认按钮 = 关闭（密码不再可查，所以按钮文案是「我已记录」）
      onCancel();
      return;
    }
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const data = await onConfirm(values.reason.trim());
      setResult(data);
    } catch {
      // 校验/提交失败：错误已由表单或拦截器提示，弹窗保持打开
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    form.resetFields();
    setResult(null);
    onCancel();
  };

  async function copyPassword() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
    } catch {
      // 剪贴板不可用（无权限/非安全上下文）：不假装成功，让运营手动复制
      setCopied(false);
    }
  }

  return (
    <Modal
      open={open}
      title={result ? '临时密码（只显示这一次）' : '重置用户密码'}
      okText={result ? '我已记录，关闭' : '确认重置'}
      cancelText="取消"
      okButtonProps={{ danger: !result, loading: confirmLoading || submitting }}
      cancelButtonProps={{ style: result ? { display: 'none' } : undefined }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={460}
    >
      {result ? (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="关掉这个弹窗后就再也看不到这个密码"
            description="服务端只在本次响应里返回它，不写审计、也不提供再查。请立刻安全转达用户，并让他登录后马上修改密码。"
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              background: 'var(--bg-2)',
              borderRadius: 6,
            }}
          >
            <Typography.Text code copyable={false} style={{ fontSize: 16, letterSpacing: 1 }}>
              {result.temporaryPassword}
            </Typography.Text>
            <Button size="small" style={{ marginLeft: 'auto' }} onClick={() => void copyPassword()}>
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
          <p style={{ marginTop: 10, marginBottom: 0, color: 'var(--text-2)', fontSize: 12.5 }}>
            该用户已登录的设备**已全部下线**（吊销 {result.sessionsRevoked} 个会话），需用新密码重新登录。
          </p>
        </>
      ) : (
        <>
          <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
            为 <b>{userLabel || '该用户'}</b> 生成一个临时密码。适用于他**收不到短信/邮件验证码**、
            自己无法重置的情况。
          </p>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="执行后会发生什么"
            description="立即换掉登录密码并吊销他所有已登录设备；写审计 admin.user.reset_password（不含密码本身）。不能对自己或等级不低于自己的账号操作。"
          />
          <Form form={form} layout="vertical" requiredMark={false}>
            <Form.Item
              name="reason"
              label="原因（必填，写入审计日志）"
              rules={[{ required: true, whitespace: true, message: '请填写重置原因（将写入审计日志）' }]}
            >
              <TextArea rows={3} maxLength={200} showCount placeholder="例如：用户手机丢失 · 工单 #4821" />
            </Form.Item>
          </Form>
        </>
      )}
    </Modal>
  );
}
