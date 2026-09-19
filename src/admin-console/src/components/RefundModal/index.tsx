import { Alert, Form, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { channelLabel } from '@/components/StatusTag/mappers';
import { fmtMoney } from '@/utils/format';
import type { Order } from '@/api/types';
import styles from './RefundModal.module.css';

const { TextArea } = Input;

/** 服务端拒绝部分退款的业务码（POST /admin/orders/:orderNo/refund → 400） */
const PARTIAL_REFUND_CODE = 'PARTIAL_REFUND_NOT_SUPPORTED';

interface RefundModalProps {
  open: boolean;
  order: Order | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  /**
   * 校验通过后回调；amount 恒等于订单全额（弹窗不再提供金额输入，服务端只接受全额退款）。
   * 抛错则弹窗保持打开（常规错误由拦截器统一 toast，部分退款被拒另有行内说明）。
   */
  onConfirm: (amount: number, reason: string) => void | Promise<unknown>;
}

interface RefundFormValues {
  reason: string;
}

/**
 * 400 PARTIAL_REFUND_NOT_SUPPORTED 判定。
 * 退款链路的错误壳有两种形状（admin 路由 { code:number, message }、
 * 渠道侧 { error:'...', code:'STRING' }），故把候选字段大写、非字母数字统一转下划线
 * 后再比对，避免 'Partial refund not supported' 这类同源文案漏判。
 */
function isPartialRefundRejected(err: unknown): boolean {
  const body = (err as { response?: { data?: Record<string, unknown> } } | null)?.response?.data;
  if (!body || typeof body !== 'object') return false;
  return ['code', 'error', 'errorCode', 'message'].some((field) => {
    const value = body[field];
    if (typeof value !== 'string') return false;
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    return normalized.includes(PARTIAL_REFUND_CODE);
  });
}

/**
 * 执行退款弹窗：订单信息 + **全额**退款说明 + 原因必填。
 *
 * 口径（与 routes/admin/orders.js 退款分支对齐）：真实调用支付宝 alipay.trade.refund，
 * **只支持全额**，退款成功即把该订单对应的订阅置为 canceled（权益立即收回）；
 * 旧的「记账式部分退款 / 仅标记」语义已废除，故这里不再有金额输入框。
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
  /** 服务端以 PARTIAL_REFUND_NOT_SUPPORTED 拒绝时给出行内说明（拦截器只 toast 一句原文） */
  const [partialRejected, setPartialRejected] = useState(false);

  useEffect(() => {
    if (open && order) {
      form.setFieldsValue({ reason: '' });
      setPartialRejected(false);
    }
  }, [form, open, order]);

  const handleOk = async () => {
    if (!order) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      setPartialRejected(false);
      await onConfirm(order.amount, values.reason.trim());
    } catch (err) {
      if (isPartialRefundRejected(err)) {
        setPartialRejected(true);
      }
      // 其余情况（表单校验失败 / 提交失败）：提示已由表单或拦截器给出，弹窗保持打开
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    form.resetFields();
    setPartialRejected(false);
    onCancel();
  };

  return (
    <Modal
      open={open && Boolean(order)}
      title="执行退款"
      okText="确认全额退款"
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
            退款将全额退回并立即取消该订单对应的订阅权益，操作不可撤销。
          </p>
          {partialRejected ? (
            <Alert
              className={styles.alert}
              type="warning"
              showIcon
              message="服务端拒绝按部分金额退款"
              description="本系统只支持全额退款（PARTIAL_REFUND_NOT_SUPPORTED）。页面金额可能已过期，请关闭弹窗刷新订单列表后，按最新订单金额重新发起。"
            />
          ) : null}
          <Form form={form} layout="vertical" requiredMark={false}>
            <div className={styles.amountRow}>
              <span className={styles.amountLabel}>退款金额</span>
              <span className={styles.amountValue}>{fmtMoney(order.amount)}</span>
              <span className={styles.amountTag}>全额 · 不可修改</span>
            </div>
            <p className={styles.amountNote}>
              款项按原支付渠道退回，<b>不支持部分退款</b>。
              <br />
              退款成功后该订单对应的订阅立即取消，权益当场收回，继续使用时需重新下单。
            </p>
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
