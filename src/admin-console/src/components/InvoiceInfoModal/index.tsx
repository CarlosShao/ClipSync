import { Alert, Form, Input, Modal, Skeleton } from 'antd';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getOrderInvoice } from '@/api/orders';
import type { Order } from '@/api/types';

const { TextArea } = Input;

interface InvoiceInfoModalProps {
  open: boolean;
  order: Order | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (payload: { title?: string; taxNo?: string; reason: string }) => void | Promise<unknown>;
}

interface InvoiceFormValues {
  title?: string;
  taxNo?: string;
  reason: string;
}

/**
 * 补录开票信息（2026-10-05 补 UI）。
 *
 * 为什么必须有：`invoices.title` / `tax_no` 两列**履约链路从不写入**，而发票 PDF 在两者为空时
 * **整行不显**。可收据文案写着「如需增值税发票请联系客服提供开票信息」—— 客服被文案指引，
 * 却没有任何工具能录入，只能改库。这是合规面上的空洞，不是"锦上添花"。
 *
 * 界面口径：
 *   - 打开时读一次该订单的开票信息并**回填**（含发票号/状态），不是让运营盲填；
 *   - 无票（还没履约）→ 明确提示"先完成履约才有票"，禁用提交；
 *   - 发票已**作废**（void）→ 禁用提交并说明原因（在作废凭证上改抬头没有意义）；
 *   - 只提交**填了值**的字段（留空 = 不改该列；服务端也拒绝空抬头）；
 *   - 说明改完用户重新下载 PDF 就能看到抬头/税号（PDF 是按这两列现渲染的）。
 */
export function InvoiceInfoModal({
  open,
  order,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: InvoiceInfoModalProps) {
  const [form] = Form.useForm<InvoiceFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [groupError, setGroupError] = useState('');

  const orderNo = order?.orderNo ?? '';
  const { data, isLoading } = useQuery({
    queryKey: ['orders', 'invoice', orderNo],
    queryFn: () => getOrderInvoice(orderNo),
    enabled: open && Boolean(orderNo),
  });

  const invoice = data?.invoice ?? null;
  const hasInvoice = Boolean(data?.hasInvoice);
  const isVoid = invoice?.status === 'void';
  const blocked = !hasInvoice || isVoid;

  useEffect(() => {
    if (!open) return;
    const next: Partial<InvoiceFormValues> = { title: '', taxNo: '', reason: '' };
    form.setFieldsValue(next);
    setGroupError('');
  }, [form, open]);

  // 拿到发票后回填当前值（运营要看到"现在是什么"再改）
  useEffect(() => {
    if (!open || !invoice) return;
    form.setFieldsValue({
      title: invoice.title ?? '',
      taxNo: invoice.taxNo ?? '',
    });
  }, [form, open, invoice]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const title = values.title?.trim() ?? '';
      const taxNo = values.taxNo?.trim() ?? '';
      if (!title && !taxNo) {
        setGroupError('发票抬头与税号至少填一项（留空表示不修改该列）');
        return;
      }
      setGroupError('');
      setSubmitting(true);
      await onConfirm({
        ...(title ? { title } : {}),
        ...(taxNo ? { taxNo } : {}),
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
      title="补录开票信息"
      okText="保存"
      cancelText="取消"
      okButtonProps={{ loading: confirmLoading || submitting, disabled: blocked }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={500}
    >
      <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
        订单 <b className="mono">{orderNo || '—'}</b>
        {invoice ? (
          <>
            {' · '}发票号 <span className="mono">{invoice.invoiceNo}</span> · 状态 {invoice.status}
          </>
        ) : null}
      </p>

      {isLoading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : (
        <>
          {!hasInvoice ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="该订单还没有发票"
              description="只有履约完成（订单已支付并开通权益）后才会开票。请先处理履约，再回来补录开票信息。"
            />
          ) : isVoid ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="该发票已作废，不能修改抬头/税号"
              description="在作废凭证上修改开票信息没有意义，也容易误导。请按正常流程重新开票。"
            />
          ) : (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="填完保存后，用户重新下载发票即可看到抬头/税号"
              description={
                <>
                  发票 PDF 是按这两列<b>现渲染</b>的：此前为空所以整行不显示。
                  留空 = 不修改该列；税号请填 5–50 位字母数字（会印在税务凭证上）。
                </>
              }
            />
          )}
          <Form form={form} layout="vertical" requiredMark={false} disabled={blocked}>
            <Form.Item name="title" label="发票抬头（公司/个人名称）">
              <Input maxLength={200} placeholder="例如：某某科技有限公司" />
            </Form.Item>
            <Form.Item name="taxNo" label="纳税人识别号（税号）">
              <Input maxLength={50} placeholder="例如：91310000MA1K3XYZ12" />
            </Form.Item>
            <Form.Item
              name="reason"
              label="补录原因（必填，写入审计日志）"
              rules={[{ required: true, whitespace: true, message: '请填写补录原因（将写入审计日志）' }]}
            >
              <TextArea rows={3} maxLength={200} showCount placeholder="例如：用户索要增值税发票 · 工单 #4821" />
            </Form.Item>
          </Form>
          {groupError ? (
            <p style={{ color: 'var(--red-6, #cf1322)', fontSize: 12.5, margin: 0 }}>{groupError}</p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
