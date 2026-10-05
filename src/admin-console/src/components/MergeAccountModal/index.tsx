import { Alert, Form, Input, Modal, Radio, Select, Space } from 'antd';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getUsers } from '@/api/users';
import type { AdminUser } from '@/api/types';

const { TextArea } = Input;

interface MergeAccountModalProps {
  open: boolean;
  /** 抽屉里正在看的那个用户（作为"保留/被合并"的默认候选） */
  currentUser: AdminUser | null;
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (payload: {
    canonicalUserId: string;
    duplicateUserId: string;
    confirmMovedClips?: number;
    reason: string;
  }) => Promise<unknown>;
}

interface MergeFormValues {
  keep: 'current' | 'other';
  otherUserId?: string;
  reason: string;
}

/** 服务端 409 CLIP_COUNT_MISMATCH 的判定 + 取条数 */
function readClipCountGuardError(err: unknown): number | null {
  const body = (err as { response?: { data?: Record<string, unknown> } } | null)?.response?.data;
  if (!body || typeof body !== 'object') return null;
  if (body.reason !== 'CLIP_COUNT_MISMATCH') return null;
  const n = Number(body.movedClips);
  return Number.isFinite(n) ? n : null;
}

/**
 * 合并重复账号（2026-10-05 补 UI）。
 *
 * 为什么必须有：`routes/auth.js` 里那份"登录时自动合并"由 `IDENTITY_MERGE_ENABLED`
 * **默认关闭**（匹配依据是用户可自由设置的昵称与未验证邮箱，等于把"偷数据"做成功能），
 * 而且运营也无法指定合并谁和谁。于是"同一个人注册了两个号"只能改库。
 *
 * 界面口径：
 *   - **必须显式选谁是"保留"的**（默认当前用户），避免把方向搞反 —— 合并不提供"反合并"；
 *   - 另一个账号用搜索选择（按昵称/手机号搜），服务端会**对两个账号都做越级校验**；
 *   - ★**两步确认**：第一次提交不带条数，服务端会返回 409 并告知"会搬走 N 条内容"，
 *     再点一次才真正执行（与「解绑设备」同一套路）；条数在两次之间变了服务端会再拒；
 *   - 明确写出**边界**：只搬剪贴板与生效中的订阅，**设备不搬**（旧账号会失效）；
 *     两边都有生效订阅时会被拒，要先去退款/收窄。
 */
export function MergeAccountModal({
  open,
  currentUser,
  confirmLoading = false,
  onCancel,
  onConfirm,
}: MergeAccountModalProps) {
  const [form] = Form.useForm<MergeFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [pendingClips, setPendingClips] = useState<number | null>(null);
  const [keep, setKeep] = useState<'current' | 'other'>('current');

  const searchQuery = useQuery({
    queryKey: ['users', 'merge-search', keyword],
    queryFn: () => getUsers({ q: keyword, page: 1, pageSize: 20 }),
    enabled: open && keyword.trim().length >= 2,
  });

  const options = (searchQuery.data?.list ?? [])
    // 不能把自己选成"另一个账号"
    .filter((u) => u.id !== currentUser?.id)
    .map((u) => ({ value: u.id, label: `${u.nickname || '(无昵称)'} · ${u.phone}` }));

  useEffect(() => {
    if (open) {
      const next: Partial<MergeFormValues> = { keep: 'current', reason: '' };
      form.setFieldsValue(next);
      setKeep('current');
      setPendingClips(null);
      setKeyword('');
    }
  }, [form, open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const other = values.otherUserId;
      if (!currentUser) return;
      if (values.keep === 'other' && !other) {
        // 「保留另一个」却没选账号 —— 跨字段规则，提交前自己判
        form.setFields([
          { name: 'otherUserId', errors: ['请选择要保留的另一个账号（可搜索昵称或手机号）'] },
        ]);
        return;
      }
      const canonicalUserId = values.keep === 'current' ? currentUser.id : String(other);
      const duplicateUserId = values.keep === 'current' ? String(other) : currentUser.id;

      setSubmitting(true);
      await onConfirm({
        canonicalUserId,
        duplicateUserId,
        ...(pendingClips !== null ? { confirmMovedClips: pendingClips } : {}),
        reason: values.reason.trim(),
      });
    } catch (err) {
      const clips = readClipCountGuardError(err);
      if (clips !== null) setPendingClips(clips);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    form.resetFields();
    setPendingClips(null);
    onCancel();
  };

  return (
    <Modal
      open={open}
      title="合并重复账号"
      okText={pendingClips !== null ? `确认合并（搬走 ${pendingClips} 条）` : '确认合并'}
      cancelText="取消"
      okButtonProps={{ danger: true, loading: confirmLoading || submitting }}
      onOk={() => void handleOk()}
      onCancel={handleCancel}
      maskClosable={false}
      width={540}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="合并不可逆：被合并的账号会被停用"
        description={
          <>
            只搬<b>剪贴板内容</b>与<b>生效中的订阅</b>；<b>设备不搬</b>（旧账号的设备会失效）。
            被合并账号的登录方式会被清除并停用，<b>没有反合并</b>。
            两个账号都有生效订阅时会被拒绝 —— 请先处理其中一个（退款 / 收窄到付费终点）。
          </>
        }
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="keep" label="保留哪一个账号">
          <Radio.Group onChange={(e) => setKeep(e.target.value as 'current' | 'other')}>
            <Space direction="vertical">
              <Radio value="current">
                保留当前账号：<b>{currentUser?.nickname || '(无昵称)'}</b> · {currentUser?.phone}
              </Radio>
              <Radio value="other">保留我另外选择的账号（当前账号将被合并并停用）</Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
        <Form.Item
          name="otherUserId"
          label={keep === 'current' ? '要合并掉的账号（可搜索昵称或手机号）' : '要保留的账号（可搜索昵称或手机号）'}
        >
          <Select
            showSearch
            filterOption={false}
            onSearch={setKeyword}
            loading={searchQuery.isFetching}
            options={options}
            placeholder="输入至少 2 个字符开始搜索"
            notFoundContent={keyword.trim().length < 2 ? '继续输入…' : '没有匹配的账号'}
          />
        </Form.Item>
        <Form.Item
          name="reason"
          label="合并原因（必填，写入审计日志）"
          rules={[{ required: true, whitespace: true, message: '请填写合并原因（将写入审计日志）' }]}
        >
          <TextArea rows={3} maxLength={200} showCount placeholder="例如：同一人注册了两个号 · 工单 #4821" />
        </Form.Item>
      </Form>
      {pendingClips !== null ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 4 }}
          message={`被合并账号当前有 ${pendingClips} 条内容会被搬走`}
          description="这是服务端刚数出来的准确条数。再点一次确认即会真的执行 —— 若这个数字和你预期的不一样，请取消并核对账号是否选对。"
        />
      ) : null}
    </Modal>
  );
}
