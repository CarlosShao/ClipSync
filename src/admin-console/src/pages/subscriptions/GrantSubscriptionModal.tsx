import { Form, Input, InputNumber, Modal, Select } from 'antd';
import { useEffect, useState } from 'react';
import { planLabel } from '@/components/StatusTag/mappers';
import { fmtDate } from '@/utils/format';
import type { AdminSubscription, GrantSubscriptionPayload, PlanKey } from '@/api/types';
import styles from './GrantSubscriptionModal.module.css';

const { TextArea } = Input;

export type GrantPlanId = Exclude<GrantSubscriptionPayload['planId'], 'free'>;

interface GrantSubscriptionModalProps {
  open: boolean;
  subscription: AdminSubscription | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  /** 校验通过后回调；抛错则弹窗保持打开（错误提示由拦截器统一 toast） */
  onConfirm: (planId: GrantPlanId, months: number, reason: string) => void | Promise<unknown>;
}

interface GrantFormValues {
  planId: GrantPlanId;
  months: number;
  reason: string;
}

const PLAN_OPTIONS: { value: GrantPlanId; label: string }[] = [
  { value: 'pro', label: 'Pro' },
  { value: 'enterprise', label: 'Enterprise' },
];

/**
 * 赠期 / 调整套餐弹窗（T-A6）：当前订阅摘要 + 目标套餐（Pro/Enterprise）+ 延长月数 1–12 + 原因必填。
 * 提交 POST /api/admin/subscriptions/:id/grant，写审计 admin.subscriptions.grant（敏感）。
 */
export function GrantSubscriptionModal({
  open,
  subscription,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: GrantSubscriptionModalProps) {
  const [form] = Form.useForm<GrantFormValues>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && subscription) {
      form.setFieldsValue({
        planId: subscription.planKey?.toLowerCase() === 'enterprise' ? 'enterprise' : 'pro',
        months: 1,
        reason: '',
      });
    }
  }, [form, open, subscription]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onConfirm(values.planId, values.months, values.reason.trim());
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
        subscription.autoRenew ? '自动续费' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <Modal
      open={open && Boolean(subscription)}
      title="赠期 / 调整套餐"
      okText="确认赠期"
      cancelText="取消"
      okButtonProps={{ loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={460}
    >
      {subscription ? (
        <>
          <p className={styles.subLine}>
            <b>{subscription.userLabel}</b> · {summary}
          </p>
          <p className={styles.hintLine}>
            赠期后订阅转为生效中：周期止 = 现周期止（或今天，取较晚者）+ 延长月数，计费周期按月计。
          </p>
          <Form form={form} layout="vertical" requiredMark={false}>
            <Form.Item name="planId" label="目标套餐" rules={[{ required: true, message: '请选择目标套餐' }]}>
              <Select<GrantPlanId> options={PLAN_OPTIONS} placeholder="选择 Pro / Enterprise" />
            </Form.Item>
            <Form.Item
              name="months"
              label="延长月数（1–12）"
              rules={[
                { required: true, message: '请输入延长月数' },
                {
                  validator: (_, value: number | undefined) => {
                    if (value === undefined || Number.isNaN(value)) return Promise.resolve();
                    if (!Number.isInteger(value) || value < 1 || value > 12) {
                      return Promise.reject(new Error('延长月数须为 1–12 的整数'));
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <InputNumber style={{ width: '100%' }} min={1} max={12} precision={0} addonAfter="个月" />
            </Form.Item>
            <Form.Item
              name="reason"
              label="原因（必填，写入审计日志）"
              rules={[
                { required: true, whitespace: true, message: '请填写赠期原因（将写入审计日志）' },
              ]}
            >
              <TextArea rows={3} maxLength={200} showCount placeholder="例如：客服补偿 · 工单 #4821" />
            </Form.Item>
          </Form>
        </>
      ) : null}
    </Modal>
  );
}
