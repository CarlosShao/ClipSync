import { Alert, Form, Input, InputNumber, Modal, Select } from 'antd';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPlans, planKeys } from '@/api/plans';

const { TextArea } = Input;

interface TrialModalProps {
  open: boolean;
  userLabel: string;
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (payload: {
    reason: string;
    days: number;
    planId: string;
    billingCycle: 'monthly' | 'yearly';
  }) => void | Promise<unknown>;
}

interface TrialFormValues {
  planId: string;
  days: number;
  billingCycle: 'monthly' | 'yearly';
  reason: string;
}

/**
 * 人工开通 / 重置试用（2026-10-05 补 UI）。
 *
 * 为什么必须有：用户侧试用是**终身一次**（库里只要有任一订阅行就拒，连 cancelled/expired
 * 都算，防「取消后再试用」套取），且没有例外通道。客服想补一次试用
 *（试用期内服务故障、用户是新人但库里已有 Free 行）只能改库 ——
 * 而改库要同时写 user_subscriptions（含 trial_end）与 users 的两个快照列，必错。
 *
 * 界面口径：
 *   - 明确写出「这是刻意绕过终身一次限制」+ 审计会留痕，避免被当成普通操作；
 *   - 明说已有生效中订阅会被拒（改走「赠期」），省一次无效操作；
 *   - 天数上限 30：更长就不叫试用了（服务端也会拒），引导用赠期。
 */
export function TrialModal({
  open,
  userLabel,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: TrialModalProps) {
  const [form] = Form.useForm<TrialFormValues>();
  const [submitting, setSubmitting] = useState(false);

  const { data: plans = [], isLoading } = useQuery({
    queryKey: planKeys.list(),
    queryFn: getPlans,
    enabled: open,
  });

  // Free 没有试用一说（服务端也拒）
  const options = plans
    .filter((p) => p.isActive && p.name.toLowerCase() !== 'free')
    .map((p) => ({ value: p.name, label: `${p.displayName}（${p.name}）` }));

  useEffect(() => {
    if (open) {
      // 不预选套餐（避免默认值把免费版填进去）；天数与周期给合理默认
      const next: Partial<TrialFormValues> = { days: 7, billingCycle: 'monthly', reason: '' };
      form.setFieldsValue(next);
    }
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onConfirm({
        reason: values.reason.trim(),
        days: values.days,
        planId: values.planId,
        billingCycle: values.billingCycle,
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
    onCancel();
  };

  return (
    <Modal
      open={open}
      title="开通 / 重置试用"
      okText="确认开通"
      cancelText="取消"
      okButtonProps={{ danger: true, loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={470}
    >
      <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
        为 <b>{userLabel || '该用户'}</b> 开通一次试用。
      </p>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="这会绕过「试用终身一次」限制"
        description={
          <>
            用户侧的试用每人只能一次（含已取消/已过期），本入口<b>刻意</b>绕过该限制，
            审计里会记明 <code>bypassedLifetimeGate: true</code>。若该用户<b>已有生效中的订阅</b>
            （付费或试用进行中）会被拒绝 —— 那种情况请用「赠期」或先「收回」。
          </>
        }
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="planId" label="试用套餐" rules={[{ required: true, message: '请选择套餐' }]}>
          <Select
            loading={isLoading}
            options={options}
            placeholder={isLoading ? '加载套餐中…' : '选择套餐（免费版不提供试用）'}
          />
        </Form.Item>
        <Form.Item
          name="days"
          label="试用天数（1–30）"
          rules={[{ required: true, message: '请填写天数' }]}
        >
          <InputNumber min={1} max={30} precision={0} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="billingCycle" label="计费周期（试用结束后拟采用的周期）">
          <Select
            options={[
              { value: 'monthly', label: '按月' },
              { value: 'yearly', label: '按年' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="reason"
          label="原因（必填，写入审计日志）"
          rules={[{ required: true, whitespace: true, message: '请填写开通原因（将写入审计日志）' }]}
        >
          <TextArea rows={3} maxLength={200} showCount placeholder="例如：试用期内同步故障补偿 · 工单 #4821" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
