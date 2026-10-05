import { Form, Input, Modal, Select } from 'antd';
import { useEffect, useState } from 'react';
import type { NotifyUserPayload } from '@/api/types';

const { TextArea } = Input;

export type NotifyType = NonNullable<NotifyUserPayload['notificationType']>;

/**
 * 通知类型白名单 —— 与服务端 POST /api/admin/users/:id/notify 的 NOTIFY_TYPES 一一对应。
 * 每种都刻意落在**客户端已有的**分类映射上（useNotifications 的 typeToCategory 按
 * includes 匹配、未知类型兜底 'update'），所以**不需要客户端升级**就能正确归类。
 * 不让运营自由填 type 就是为了守住这一点：填错了分类就会漂到「更新」里。
 */
const TYPE_OPTIONS: { value: NotifyType; label: string; hint: string }[] = [
  { value: 'admin_message', label: '通用告知', hint: '客户端通知中心 → 更新' },
  { value: 'subscription_notice', label: '订阅相关', hint: '客户端通知中心 → 订阅' },
  { value: 'device_notice', label: '设备相关', hint: '客户端通知中心 → 设备' },
  { value: 'security_notice', label: '安全提醒', hint: '客户端通知中心 → 安全' },
];

interface NotifyUserModalProps {
  open: boolean;
  /** 展示"发给谁"；userLabel 通常为昵称或打码手机号 */
  userLabel: string;
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (payload: {
    title: string;
    body: string;
    notificationType: NotifyType;
  }) => void | Promise<unknown>;
}

interface NotifyFormValues {
  notificationType: NotifyType;
  title: string;
  body: string;
}

/**
 * 对单个用户定向通知（2026-10-05 新增）。
 *
 * 为什么要有它：管理台此前只有「公告下发」，而公告受众只有 all / pro_plus / free
 * 三个**群体** —— 想只告知一个人（客服跟进、误发权益的说明、风控提醒）此前只能改库
 * 往 notification_history 插行，或者对全体广播。通道（WS 实时推 + 落库）本来就存在。
 *
 * 触达说明会如实展示：落库一定成功，但对方可能一台设备都不在线，
 * 那种情况下只能等对方下次打开客户端在通知中心看到 —— 不谎报"已送达"。
 */
export function NotifyUserModal({
  open,
  userLabel,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: NotifyUserModalProps) {
  const [form] = Form.useForm<NotifyFormValues>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ notificationType: 'admin_message', title: '', body: '' });
    }
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onConfirm({
        title: values.title.trim(),
        body: values.body.trim(),
        notificationType: values.notificationType,
      });
    } catch {
      // 表单校验失败或提交失败：错误已由表单/拦截器提示，弹窗保持打开
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
      title="发送站内通知"
      okText="发送"
      cancelText="取消"
      okButtonProps={{ loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={480}
    >
      <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
        仅发送给 <b>{userLabel || '该用户'}</b> 一个人（不会广播）。对方在线时实时弹出，
        离线则下次打开客户端在「通知中心」看到。
      </p>
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="notificationType" label="类型" rules={[{ required: true }]}>
          <Select
            options={TYPE_OPTIONS.map((o) => ({
              value: o.value,
              label: `${o.label}（${o.hint}）`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="title"
          label="标题"
          rules={[{ required: true, whitespace: true, message: '请填写通知标题' }]}
        >
          <Input maxLength={100} showCount placeholder="例如：你的赠期已到账" />
        </Form.Item>
        <Form.Item
          name="body"
          label="内容"
          rules={[{ required: true, whitespace: true, message: '请填写通知内容' }]}
        >
          <TextArea rows={4} maxLength={500} showCount placeholder="给用户看的中文文案，别写内部原因" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
