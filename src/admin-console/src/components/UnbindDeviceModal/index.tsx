import { Alert, Form, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';
import type { AdminDevice } from '@/api/types';

const { TextArea } = Input;

interface UnbindDeviceModalProps {
  open: boolean;
  device: AdminDevice | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  /** resolve 抛错时，本组件会检查是否是「有内容待确认」并切到第二步 */
  onConfirm: (payload: { reason: string; confirmItemCount?: number }) => Promise<unknown>;
}

interface UnbindFormValues {
  reason: string;
}

/** 服务端 409 CONTENT_WILL_BE_DELETED 的判定 + 取条数 */
function readContentGuardError(err: unknown): number | null {
  const body = (err as { response?: { data?: Record<string, unknown> } } | null)?.response?.data;
  if (!body || typeof body !== 'object') return null;
  if (body.reason !== 'CONTENT_WILL_BE_DELETED') return null;
  const n = Number(body.itemCount);
  return Number.isFinite(n) ? n : null;
}

/**
 * 强制解绑设备（2026-10-05 补 UI）。
 *
 * 与「远程下线」的区别（弹窗里必须说清，否则运营会随手点错）：
 *   - 下线：设备行保留，**仍占 max_devices 名额**，内容保留；
 *   - 解绑：**移除设备行**（释放名额），但会**连带删除该设备产生的全部剪贴板内容**
 *     —— 生产实测外键 `clipboard_items_source_device_id_fkey ON DELETE CASCADE`，不可恢复。
 *
 * 因此这里是**两步确认**：第一次提交只带 reason；服务端若发现该设备还有内容，
 * 返回 409 `CONTENT_WILL_BE_DELETED` + 条数，本弹窗据此显示红字警告，
 * 再点一次才会带上 `confirmItemCount` 真正执行。
 * 由服务端做这一判断（而不是前端先查），顺带把"计数与执行之间条数变了"的竞态也挡掉了：
 * 条数对不上服务端依然拒绝。
 */
export function UnbindDeviceModal({
  open,
  device,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: UnbindDeviceModalProps) {
  const [form] = Form.useForm<UnbindFormValues>();
  const [submitting, setSubmitting] = useState(false);
  /** 服务端告知"还有 N 条内容会被连带删除"后的第二步状态 */
  const [pendingItemCount, setPendingItemCount] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      const next: Partial<UnbindFormValues> = { reason: '' };
      form.setFieldsValue(next);
      setPendingItemCount(null);
    }
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const reason = values.reason.trim();
      setSubmitting(true);
      await onConfirm({
        reason,
        ...(pendingItemCount !== null ? { confirmItemCount: pendingItemCount } : {}),
      });
    } catch (err) {
      // 服务端说有内容待确认：切到第二步（拦截器已 toast 过原文，这里给更醒目的行内说明）
      const itemCount = readContentGuardError(err);
      if (itemCount !== null) setPendingItemCount(itemCount);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    form.resetFields();
    setPendingItemCount(null);
    onCancel();
  };

  return (
    <Modal
      open={open}
      title="强制解绑设备"
      okText={pendingItemCount !== null ? `确认删除 ${pendingItemCount} 条内容并解绑` : '确认解绑'}
      cancelText="取消"
      okButtonProps={{ danger: true, loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={500}
    >
      <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
        即将解绑设备 <b>{device?.name}</b>（{device?.os || '未知系统'} · 应用{' '}
        {device?.appVersion || '—'}，属主 {device?.ownerNickname || '—'}）。
      </p>
      <Alert
        type={pendingItemCount !== null ? 'error' : 'warning'}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          pendingItemCount !== null
            ? `该设备还有 ${pendingItemCount} 条剪贴板内容会被一并删除，且不可恢复`
            : '解绑 ≠ 下线'
        }
        description={
          pendingItemCount !== null ? (
            <>
              数据库外键是 <code>ON DELETE CASCADE</code>：删掉设备行会连带删除
              <b>该设备产生的</b>全部内容（其他设备的内容不受影响）。若只是想让它下线、
              内容保留，请取消并改用「远程下线」。再次点击确认按钮即会真的执行。
            </>
          ) : (
            <>
              「远程下线」保留设备行（但仍占设备名额）；「解绑」移除设备行、<b>释放名额</b>，
              但会连带删除该设备产生的内容。若该设备还有内容，下一步会先告诉你条数再让你确认。
            </>
          )
        }
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="reason"
          label="解绑原因（必填，写入审计日志）"
          rules={[{ required: true, whitespace: true, message: '请填写解绑原因（将写入审计日志）' }]}
        >
          <TextArea rows={3} maxLength={200} showCount placeholder="例如：设备丢失 · 工单 #4821" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
