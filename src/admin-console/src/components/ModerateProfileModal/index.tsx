import { Alert, Checkbox, Form, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';

interface ModerateProfileModalProps {
  open: boolean;
  userLabel: string;
  /** 当前昵称（列表/详情下发的值，用于展示"从什么改成什么"） */
  currentNickname?: string | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (payload: {
    nickname?: string;
    avatarUrl?: string;
    clearAvatar?: boolean;
    reason: string;
  }) => void | Promise<unknown>;
}

interface ModerateFormValues {
  nickname?: string;
  avatarUrl?: string;
  clearAvatar?: boolean;
  reason: string;
}

/**
 * 违规昵称 / 头像处置（2026-10-05 补 UI）。
 *
 * 为什么必须有：`routes/admin/` 此前没有任何 profile 写端点，运营遇到违规昵称/头像
 * 只能"停用整个账号"（与违规程度不成比例）或改库；而**改库在这里确实不够** ——
 * `GET /profile` 有 5 分钟 Redis 缓存，用户侧改资料会清缓存，改库不会，
 * 于是用户仍看到旧昵称、客服以为"改了没生效"（该端点会清缓存）。
 *
 * 界面口径：
 *   - 三项（改昵称 / 换头像 / 清空头像）**至少给一项**，服务端也拦；
 *   - 昵称不能为空：空昵称在客户端会显示成空白，比违规昵称更糟 —— 要清就用中性替代名；
 *   - 头像只收 http(s) 或 data:image（用户侧不校验协议，管理台入口更严）；
 *   - 说明会上审计 + 通知用户本人（否则最典型的追问就是"我昵称怎么变了"）。
 */
export function ModerateProfileModal({
  open,
  userLabel,
  currentNickname,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: ModerateProfileModalProps) {
  const [form] = Form.useForm<ModerateFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [groupError, setGroupError] = useState('');

  useEffect(() => {
    if (open) {
      const next: Partial<ModerateFormValues> = {
        nickname: '',
        avatarUrl: '',
        clearAvatar: false,
        reason: '',
      };
      form.setFieldsValue(next);
      setGroupError('');
    }
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const nickname = values.nickname?.trim() ?? '';
      const avatarUrl = values.avatarUrl?.trim() ?? '';
      const clearAvatar = values.clearAvatar === true;
      if (!nickname && !avatarUrl && !clearAvatar) {
        // 跨字段规则，antd 的单字段 rules 表达不了，提交前自己判
        setGroupError('「新昵称」「新头像」「清空头像」至少给一项，否则没有任何改动');
        return;
      }
      setGroupError('');
      setSubmitting(true);
      await onConfirm({
        ...(nickname ? { nickname } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(clearAvatar ? { clearAvatar: true } : {}),
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
      title="处置昵称 / 头像"
      okText="确认处置"
      cancelText="取消"
      okButtonProps={{ danger: true, loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={480}
    >
      <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
        <b>{userLabel || '该用户'}</b> 当前昵称：{currentNickname || '—'}
      </p>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="这是内容处置，不是普通改名"
        description={
          <>
            会写审计 <code>admin.user.profile_moderation</code>（含改动前后），并给该用户发一条通知。
            昵称不能留空 —— 空昵称在客户端会显示成空白，比违规昵称更糟，要清请换一个中性名（如「用户4821」）。
            头像只接受 http(s) 链接或 data:image/...;base64, 形式。
          </>
        }
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="nickname" label={`新昵称（不填则不改；≤50 字，不含 < > " ' &）`}>
          <Input maxLength={50} placeholder="例如：用户4821" />
        </Form.Item>
        <Form.Item name="avatarUrl" label="新头像（不填则不改；http(s) 或 data:image 链接）">
          <Input placeholder="https://… 或 data:image/png;base64,…" />
        </Form.Item>
        <Form.Item name="clearAvatar" valuePropName="checked">
          <Checkbox>清空头像（置为空）</Checkbox>
        </Form.Item>
        <Form.Item
          name="reason"
          label="处置原因（必填，写入审计日志）"
          rules={[{ required: true, whitespace: true, message: '请填写处置原因（将写入审计日志）' }]}
        >
          <Input.TextArea
            rows={3}
            maxLength={200}
            showCount
            placeholder="例如：昵称含违规内容 · 举报工单 #4821"
          />
        </Form.Item>
      </Form>
      {groupError ? (
        <p style={{ color: 'var(--red-6, #cf1322)', fontSize: 12.5, margin: 0 }}>{groupError}</p>
      ) : null}
    </Modal>
  );
}
