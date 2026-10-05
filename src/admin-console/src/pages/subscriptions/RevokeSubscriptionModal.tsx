import { Alert, Form, Input, Modal, Radio } from 'antd';
import { useEffect, useState } from 'react';
import { planLabel } from '@/components/StatusTag/mappers';
import { fmtDate } from '@/utils/format';
import type { AdminSubscription, PlanKey } from '@/api/types';
import styles from './GrantSubscriptionModal.module.css';

const { TextArea } = Input;

export type RevokeMode = 'immediate' | 'period_end';

interface RevokeSubscriptionModalProps {
  open: boolean;
  subscription: AdminSubscription | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  /** 校验通过后回调；抛错则弹窗保持打开（错误提示由拦截器统一 toast） */
  onConfirm: (mode: RevokeMode, reason: string) => void | Promise<unknown>;
}

interface RevokeFormValues {
  mode: RevokeMode;
  reason: string;
}

/**
 * 收回订阅权益弹窗（2026-10-05 新增）。
 *
 * 为什么要有它：grant 是**单向**的（只会把 plan_id 往前挪 + period_end 往后延），
 * 误发或滥用赠期后此前**没有任何界面可收回** —— 客服只能来找 DBA 改库，
 * 而改库不写审计、也容易把 users 的订阅快照和 user_subscriptions 改得不一致。
 *
 * 与服务端的分工：**保护闸在服务端**（该订阅有真实已付订单 ⇒ 409 HAS_PAID_ORDER，
 * 必须走「退款审核」原路退款）。这个弹窗只负责把规则**先说清楚**，别让运营点下去才被拒；
 * 409 的中文说明由 api client 拦截器统一 toast（服务端 message 里已带引导语）。
 */
export function RevokeSubscriptionModal({
  open,
  subscription,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: RevokeSubscriptionModalProps) {
  const [form] = Form.useForm<RevokeFormValues>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && subscription) {
      form.setFieldsValue({ mode: 'immediate', reason: '' });
    }
  }, [form, open, subscription]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onConfirm(values.mode, values.reason.trim());
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

  const summary = subscription
    ? [
        `当前 ${planLabel[subscription.planKey?.toLowerCase() as PlanKey] ?? subscription.planName}`,
        subscription.billingCycle
          ? subscription.billingCycle === 'yearly'
            ? '年付'
            : '月付'
          : null,
        subscription.status === 'trialing'
          ? '试用中'
          : subscription.currentPeriodEnd
            ? `${fmtDate(subscription.currentPeriodEnd)} 到期`
            : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <Modal
      open={open && Boolean(subscription)}
      title="收回订阅权益"
      okText="确认收回"
      cancelText="取消"
      okButtonProps={{ danger: true, loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={480}
    >
      {subscription ? (
        <>
          <p className={styles.subLine}>
            <b>{subscription.userLabel}</b> · {summary}
          </p>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="这里只收回「人工给出去」的权益"
            description="该订阅若存在真实已付订单，服务端会直接拒绝并提示你走「退款审核」—— 用户花钱买到的权益不能在这里撤销，只能原路退款（退款会一并取消订阅）。"
          />
          <p className={styles.hintLine}>
            立即收回：订阅当场终止，用户回落免费版；期末收回：本次周期内权益不受影响，到期后不再续。
          </p>
          <Form form={form} layout="vertical" requiredMark={false}>
            <Form.Item name="mode" label="生效方式" rules={[{ required: true }]}>
              <Radio.Group>
                <Radio.Button value="immediate">立即收回</Radio.Button>
                <Radio.Button value="period_end">期末收回</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Form.Item
              name="reason"
              label="原因（必填，写入审计日志）"
              rules={[{ required: true, whitespace: true, message: '请填写收回原因（将写入审计日志）' }]}
            >
              <TextArea rows={3} maxLength={200} showCount placeholder="例如：误发赠期 · 工单 #4821" />
            </Form.Item>
          </Form>
        </>
      ) : null}
    </Modal>
  );
}
