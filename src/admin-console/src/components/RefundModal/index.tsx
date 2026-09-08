import { Form, Input, InputNumber, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { channelLabel } from '@/components/StatusTag/mappers';
import { fmtMoney } from '@/utils/format';
import type { Order } from '@/api/types';
import styles from './RefundModal.module.css';

const { TextArea } = Input;

interface RefundModalProps {
  open: boolean;
  order: Order | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  /** 校验通过后回调；抛错则弹窗保持打开（错误提示由拦截器统一 toast） */
  onConfirm: (amount: number, reason: string) => void | Promise<unknown>;
}

interface RefundFormValues {
  amount: number;
  reason: string;
}

/**
 * 执行退款弹窗（对照草图）：订单信息 + 退款金额（默认全额、上限校验）+ 原因必填。
 * 原因为空时红字提示且弹窗不关闭（与 ConfirmReasonModal 同一交互约定）。
 */
export function RefundModal({
  open,
  order,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: RefundModalProps) {
  const [form] = Form.useForm<RefundFormValues>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && order) {
      form.setFieldsValue({ amount: order.amount, reason: '' });
    }
  }, [form, open, order]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onConfirm(values.amount, values.reason.trim());
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
      open={open && Boolean(order)}
      title="执行退款"
      okText="确认退款"
      cancelText="取消"
      okButtonProps={{ danger: true, loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={430}
    >
      {order ? (
        <>
          <p className={styles.orderLine}>
            订单 <b className="mono">{order.orderNo}</b> · {channelLabel[order.channel]} ·{' '}
            {fmtMoney(order.amount)}
            <br />
            {/* AF-40：当前退款为「人工标记」——系统不调用支付网关，请确认已在线下完成原渠道退款 */}
            确认前请先在线下完成原渠道退款；本操作仅将订单标记为已退款并记入审计。
          </p>
          <Form form={form} layout="vertical" requiredMark={false}>
            <Form.Item
              name="amount"
              label={`退款金额（不超过 ${fmtMoney(order.amount)}）`}
              rules={[
                { required: true, message: '请输入退款金额' },
                {
                  validator: (_, value: number | undefined) => {
                    if (value === undefined || Number.isNaN(value)) return Promise.resolve();
                    if (value <= 0) return Promise.reject(new Error('退款金额必须大于 0'));
                    if (value > order.amount) {
                      return Promise.reject(
                        new Error(`退款金额不能超过 ${fmtMoney(order.amount)}`)
                      );
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0.01}
                max={order.amount}
                precision={2}
                addonBefore="¥"
              />
            </Form.Item>
            <Form.Item
              name="reason"
              label="退款原因（必填，写入审计日志）"
              rules={[
                { required: true, whitespace: true, message: '请填写退款原因（将写入审计日志）' },
              ]}
            >
              <TextArea rows={3} maxLength={200} showCount placeholder="例如：用户重复支付" />
            </Form.Item>
          </Form>
        </>
      ) : null}
    </Modal>
  );
}
