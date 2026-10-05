import { Alert, Checkbox, Form, Input, InputNumber, Modal, Space } from 'antd';
import { useEffect, useState } from 'react';
import type { LimitOverrides } from '@/api/types';

const { TextArea } = Input;

interface UserLimitsModalProps {
  open: boolean;
  userLabel: string;
  /** 当前覆盖（来自用户详情；null/undefined = 没有覆盖） */
  current?: LimitOverrides | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (
    payload: { overrides: LimitOverrides; reason: string } | { clear: true; reason: string }
  ) => void | Promise<unknown>;
}

interface LimitsFormValues {
  reason: string;
  clear?: boolean;
  // 4 个配额键 + 各自的 `<key>__unlimited` 勾选态：动态键，故用索引签名
  [key: string]: string | number | boolean | undefined;
}

/** 4 个可覆盖的配额键（与服务端 LIMIT_OVERRIDE_KEYS 一一对应，单位/上限也一致） */
const FIELDS: Array<{
  key: keyof LimitOverrides;
  label: string;
  max: number;
  integer: boolean;
}> = [
  { key: 'max_file_size_mb', label: '单文件上限（MB）', max: 10240, integer: false },
  { key: 'max_storage_mb', label: '容量上限（MB）', max: 1048576, integer: false },
  { key: 'max_files_per_clip', label: '单次文件数', max: 10000, integer: true },
  { key: 'file_retention_days', label: '文件保留天数', max: 3650, integer: true },
];

const unlimitedKey = (key: keyof LimitOverrides) => `${key}__unlimited`;

/**
 * 单用户配额覆盖（2026-10-05 补 UI，迁移 084）。
 *
 * 为什么要它：配额的唯一来源是套餐行，而改套餐行会**同时影响该套餐下所有人** ——
 * 「单独给这一个用户提配额」（客诉补偿/大客户/内部测试）此前只能改库，没有审计。
 *
 * 界面口径（每个键**三态**，与服务端语义一一对应）：
 *   - 填数字 ⇒ 覆盖为该值；
 *   - 勾「不限」⇒ 覆盖为 `null`（该项不限，与套餐行 NULL=不限 同语义）；
 *   - 都不填 ⇒ **不覆盖**，沿用套餐值（键根本不会出现在请求里）。
 * 另有「清除全部覆盖」⇒ 发 `{ clear: true }`，与服务端的互斥校验对齐。
 *
 * 注：「不限」勾选框**优先于**输入框，提交时按勾选状态取值（不做联动禁用，
 * 免得出现"填了数字又被禁用、用户不知道以哪个为准"）。
 */
export function UserLimitsModal({
  open,
  userLabel,
  current,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: UserLimitsModalProps) {
  const [form] = Form.useForm<LimitsFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [groupError, setGroupError] = useState('');

  useEffect(() => {
    if (!open) return;
    const next: LimitsFormValues = { reason: '', clear: false };
    for (const f of FIELDS) {
      const present = Boolean(current) && Object.prototype.hasOwnProperty.call(current, f.key);
      next[f.key] = present && current?.[f.key] != null ? Number(current[f.key]) : undefined;
      next[unlimitedKey(f.key)] = present && current?.[f.key] === null;
    }
    form.setFieldsValue(next);
    setGroupError('');
  }, [form, open, current]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const reason = String(values.reason ?? '').trim();
      if (values.clear === true) {
        setGroupError('');
        setSubmitting(true);
        await onConfirm({ clear: true, reason });
        return;
      }
      const overrides: LimitOverrides = {};
      for (const f of FIELDS) {
        if (values[unlimitedKey(f.key)] === true) {
          overrides[f.key] = null; // 不限
          continue;
        }
        const v = values[f.key];
        if (typeof v === 'number') overrides[f.key] = v;
      }
      if (Object.keys(overrides).length === 0) {
        setGroupError('至少覆盖一项，否则请用「清除全部覆盖」');
        return;
      }
      setGroupError('');
      setSubmitting(true);
      await onConfirm({ overrides, reason });
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

  const currentText =
    current && Object.keys(current).length > 0
      ? Object.entries(current)
          .map(([k, v]) => `${k}=${v === null ? '不限' : v}`)
          .join(' · ')
      : '未设置（沿用套餐）';

  return (
    <Modal
      open={open}
      title="单用户配额覆盖"
      okText="确认设置"
      cancelText="取消"
      okButtonProps={{ loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={520}
    >
      <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
        为 <b>{userLabel || '该用户'}</b> 单独设置上传/存储配额（<b>不影响同套餐其他用户</b>）。
        当前：{currentText}
      </p>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="每个键三态"
        description="填数字 = 覆盖为该值；勾「不限」= 该项不限（勾了以勾选为准）；都不填 = 沿用套餐值。设置后**立即生效**（配额每次上传实时计算，无需重启），并写审计 admin.user.limits_override。"
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        {FIELDS.map((f) => (
          <Form.Item key={f.key} label={f.label} style={{ marginBottom: 10 }}>
            <Space>
              <Form.Item name={f.key} noStyle>
                <InputNumber
                  min={0}
                  max={f.max}
                  precision={f.integer ? 0 : undefined}
                  placeholder="沿用套餐"
                  style={{ width: 200 }}
                />
              </Form.Item>
              <Form.Item name={unlimitedKey(f.key)} valuePropName="checked" noStyle>
                <Checkbox>不限</Checkbox>
              </Form.Item>
            </Space>
          </Form.Item>
        ))}
        <Form.Item name="clear" valuePropName="checked" style={{ marginBottom: 10 }}>
          <Checkbox>清除全部覆盖（回到套餐标准）</Checkbox>
        </Form.Item>
        <Form.Item
          name="reason"
          label="原因（必填，写入审计日志）"
          rules={[{ required: true, whitespace: true, message: '请填写原因（将写入审计日志）' }]}
        >
          <TextArea rows={3} maxLength={200} showCount placeholder="例如：客诉补偿 · 工单 #4821" />
        </Form.Item>
      </Form>
      {groupError ? (
        <p style={{ color: 'var(--red-6, #cf1322)', fontSize: 12.5, margin: 0 }}>{groupError}</p>
      ) : null}
    </Modal>
  );
}
