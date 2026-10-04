import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  InputNumber,
  Modal,
  Table,
  Tabs,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState, type CSSProperties } from 'react';
import {
  approveRefundReview,
  getRefundReviews,
  getRefundSettings,
  refundReviewFailureHint,
  refundReviewKeys,
  rejectRefundReview,
  updateRefundSettings,
  type RefundReview,
  type RefundReviewStatus,
  type RefundReviewStatusFilter,
  type RefundSettings,
} from '@/api/refundReviews';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag, type StatusTone } from '@/components/StatusTag';
import { useTableQuery } from '@/hooks/useTableQuery';
import { queryKeys } from '@/queryKeys';
import { fmtMoney, fmtTime } from '@/utils/format';
import { hasPerm } from '@/utils/permissions';

interface ReviewFilters {
  status: RefundReviewStatusFilter | undefined;
}

/** 默认只看待审——已审的走「已通过 / 已驳回」Tab 回溯 */
const DEFAULT_FILTERS: ReviewFilters = { status: 'pending' };

const STATUS_TABS: { key: RefundReviewStatusFilter; label: string }[] = [
  { key: 'pending', label: '待审核' },
  /*
   * processing（H3）：管理员已认领、正在调渠道、结果未知的单，服务端卡住时不会自愈，
   * 只能靠操作员手动「对账并重试」收口。此前这类单混在「全部」里靠肉眼找，
   * 而它恰恰是最需要主动介入的一类（钱可能已在路上）。
   */
  { key: 'processing', label: '处理中' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已驳回' },
  { key: 'all', label: '全部' },
];

const reviewStatusTone: Record<RefundReviewStatus, StatusTone> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
  // 服务端在途态：已 CAS 认领、正在调支付宝，结果未知。
  // 卡住（认领后崩溃/重启）时只能靠「再点一次 approve」收口 —— 服务端会先查单再决定重试，
  // 故这一行**不是**「已处理、勿动」，而是需要运营介入的待办态
  processing: 'blue',
};

const reviewStatusLabel: Record<RefundReviewStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  processing: '打款中',
};

const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--text-2)', marginBottom: 4 };
const subStyle: CSSProperties = { fontSize: 11.5, color: 'var(--text-3)' };
const countStyle: CSSProperties = { marginLeft: 2, fontSize: 11, color: 'var(--text-3)' };

/** 非 CNY 不带 ¥ 前缀，避免把外币单读成人民币（契约含 currency 字段） */
function fmtAmount(amount: number, currency: string): string {
  return currency === 'CNY' ? fmtMoney(amount) : `${fmtMoney(amount, '')} ${currency}`;
}

/** 用户展示：昵称优先，缺昵称回落到打码手机号（两者都来自 LEFT JOIN，可能为空） */
function userLabelOf(review: RefundReview): string {
  return review.userName || review.userPhone || '—';
}

/**
 * 退款审核（两段式退款的第二段）：
 * 用户申请时服务端没动钱、只收回了权益，所以这里「通过」= 那一刻真调支付宝打款，
 * 「驳回」= 不打款并按申请时快照恢复权益。两条路径都不可静默——通过有二次确认，
 * 驳回必须填理由（会反馈给申请人）。页顶「退款设置」维护自助退款时限与审核承诺工作日。
 */
export default function RefundReviewPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [approveTarget, setApproveTarget] = useState<RefundReview | null>(null);
  const [rejectTarget, setRejectTarget] = useState<RefundReview | null>(null);
  /** 审核失败的行内说明（拦截器只 toast 一句 HTTP 状态文案，业务码含义要落到弹窗里） */
  const [failureHint, setFailureHint] = useState<string | null>(null);

  const { tableProps, filters, setFilters } = useTableQuery<RefundReview, ReviewFilters>({
    buildKey: ({ page, pageSize, status }) => refundReviewKeys.list({ page, pageSize, status }),
    fetcher: ({ page, pageSize, status }) => getRefundReviews({ page, pageSize, status }),
    defaultFilters: DEFAULT_FILTERS,
    defaultPageSize: 10,
  });

  // 各状态 Tab 计数：与列表同接口 pageSize=1 取 total（照订单页）
  const countQueries = useQueries({
    queries: STATUS_TABS.map((tab) => {
      const params = { page: 1, pageSize: 1, status: tab.key };
      return {
        queryKey: [...refundReviewKeys.list(params), 'count'],
        queryFn: () => getRefundReviews(params),
      };
    }),
  });

  /**
   * 审核后的失效面：通过 → 订单转 refunded；驳回 → 订阅/用户套餐按快照恢复。
   * 两条路径都改动订单/订阅/用户/看板/审计的缓存（与订单页退款后的清单同范围）。
   */
  const invalidateReviewScope = () => {
    for (const key of [
      ['refund-reviews'],
      ['orders'],
      ['subscriptions'],
      ['users'],
      ['audit-logs'],
      queryKeys.overview(),
    ]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveRefundReview(id),
    onSuccess: (resp) => {
      invalidateReviewScope();
      void message.success(
        `已通过：${fmtAmount(resp.request.amount, resp.request.currency)} 已原路退回，订单 ${resp.order.orderNo} 转为已退款`
      );
      setApproveTarget(null);
      setFailureHint(null);
    },
    onError: (err) => {
      // 渠道失败/状态冲突时服务端可能已改动申请单或订单（如 processing 卡住），
      // 先重拉让操作员看到真实状态，弹窗保持打开并给出行内说明
      invalidateReviewScope();
      setFailureHint(refundReviewFailureHint(err));
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (payload: { id: string; reason: string }) =>
      rejectRefundReview(payload.id, payload.reason),
    onSuccess: (resp) => {
      invalidateReviewScope();
      const user = resp.request.userName || resp.request.userPhone || '该用户';
      void message.success(
        resp.entitlementRestored === false
          ? `已驳回：${user} 等审期间已另购新套餐，旧权益未自动还原，请到订阅页人工核对`
          : `已驳回：${user} 的权益已按申请时快照恢复`
      );
      setRejectTarget(null);
      setFailureHint(null);
    },
    onError: (err) => {
      invalidateReviewScope();
      setFailureHint(refundReviewFailureHint(err));
    },
  });

  const settingsQuery = useQuery({
    queryKey: refundReviewKeys.settings(),
    queryFn: getRefundSettings,
  });
  const [settingsDraft, setSettingsDraft] = useState<RefundSettings | null>(null);
  useEffect(() => {
    if (settingsQuery.data) setSettingsDraft(settingsQuery.data);
  }, [settingsQuery.data]);

  const settingsMutation = useMutation({
    mutationFn: (payload: RefundSettings) => updateRefundSettings(payload),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: refundReviewKeys.settings() });
      setSettingsDraft(data);
      void message.success('退款设置已保存');
    },
  });

  // RB-07：通过/驳回/保存均为高危（admin.orders.refund superAdminOnly），按权限裁剪
  const canReview = hasPerm('admin.orders.refund');
  const settingsDirty =
    Boolean(settingsDraft) &&
    Boolean(settingsQuery.data) &&
    (settingsDraft?.windowDays !== settingsQuery.data?.windowDays ||
      settingsDraft?.reviewBusinessDays !== settingsQuery.data?.reviewBusinessDays);

  const openApprove = (record: RefundReview) => {
    setFailureHint(null);
    setApproveTarget(record);
  };

  const openReject = (record: RefundReview) => {
    setFailureHint(null);
    setRejectTarget(record);
  };

  const confirmApprove = () => {
    if (!approveTarget) return;
    approveMutation.mutate(approveTarget.id);
  };

  const saveSettings = () => {
    if (!settingsDraft) return;
    settingsMutation.mutate(settingsDraft);
  };

  /** 弹窗目标是否卡住的 processing 单：文案/按钮/风险提示都要换口径（不是"再退一次"） */
  const isReconciling = approveTarget?.status === 'processing';

  const columns: ColumnsType<RefundReview> = [
    {
      title: '申请时间',
      dataIndex: 'requestedAt',
      width: 150,
      render: (value: string | null, record) => (
        <div>
          <span className="mono">{fmtTime(value)}</span>
          <div style={subStyle}>申请时退款窗口 {record.windowDaysAtRequest} 天</div>
        </div>
      ),
    },
    {
      title: '用户',
      dataIndex: 'userName',
      width: 140,
      render: (_: string | null, record) => (
        <div>
          <span style={{ fontWeight: 550 }}>{userLabelOf(record)}</span>
          <div style={subStyle}>{record.userPhone ?? '—'}</div>
        </div>
      ),
    },
    {
      title: '套餐',
      dataIndex: 'planName',
      width: 120,
      render: (value: string | null) => value ?? <span style={subStyle}>—</span>,
    },
    {
      title: '订单号',
      dataIndex: 'orderNo',
      width: 175,
      render: (value: string) => (
        <span className="mono" style={{ fontWeight: 550 }}>
          {value}
        </span>
      ),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 100,
      align: 'right',
      render: (_: number, record) => (
        <span className="num" style={{ fontWeight: 550 }}>
          {fmtAmount(record.amount, record.currency)}
        </span>
      ),
    },
    {
      title: '付款时间',
      dataIndex: 'paidAt',
      width: 125,
      render: (value: string | null) => (
        <span className="mono">{value ? fmtTime(value) : '—'}</span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      // 兜底：万一出现类型里没有的状态值，原样显示状态串而不是崩成 undefined，
      // 免得管理员看不到这一条却钱已在路上
      render: (value: RefundReviewStatus) => (
        <StatusTag tone={reviewStatusTone[value] ?? 'gray'}>
          {reviewStatusLabel[value] ?? value}
        </StatusTag>
      ),
    },
    {
      title: '审核人',
      dataIndex: 'reviewedByName',
      width: 100,
      render: (value: string | null) => value ?? <span style={subStyle}>—</span>,
    },
    {
      title: '审核时间',
      dataIndex: 'reviewedAt',
      width: 125,
      render: (value: string | null) =>
        value ? <span className="mono">{fmtTime(value)}</span> : <span style={subStyle}>—</span>,
    },
    {
      title: '申请理由',
      dataIndex: 'userReason',
      ellipsis: { showTitle: false },
      render: (value: string | null) =>
        value ? (
          <Tooltip title={value} placement="topLeft">
            <span>{value}</span>
          </Tooltip>
        ) : (
          <span style={subStyle}>—</span>
        ),
    },
    {
      title: '审核备注',
      dataIndex: 'reviewNote',
      width: 180,
      ellipsis: { showTitle: false },
      render: (value: string | null) =>
        value ? (
          // 同一个字段承担两种语义，标题只能取中立名：驳回时是给申请人的理由；
          // 以 [自动对账] 开头的是 H3 收口时服务端写的渠道查单结论（不是人写的）
          <Tooltip
            title={
              value.includes('[自动对账]')
                ? `${value}（服务端查单留痕，非人工填写）`
                : `${value}（驳回理由，已反馈给申请人）`
            }
            placement="topLeft"
          >
            <span>{value}</span>
          </Tooltip>
        ) : (
          <span style={subStyle}>—</span>
        ),
    },
    {
      title: '操作',
      dataIndex: 'id',
      width: 180,
      fixed: 'right',
      render: (_: string, record) =>
        record.status === 'pending' ? (
          <Tooltip
            title={
              canReview
                ? '通过即调用支付宝原路退款（不可撤销）；驳回则恢复用户权益'
                : '缺少权限 admin.orders.refund'
            }
          >
            <span>
              <Button
                size="small"
                type="primary"
                disabled={!canReview}
                onClick={() => openApprove(record)}
              >
                通过
              </Button>
              <Button
                danger
                size="small"
                style={{ marginLeft: 6 }}
                disabled={!canReview}
                onClick={() => openReject(record)}
              >
                驳回
              </Button>
            </span>
          </Tooltip>
        ) : record.status === 'processing' ? (
          /*
           * H3 逃生口：卡在 processing 的申请单两条常规路径都被堵死（服务端的 CAS 要求
           * status='pending'，订单侧复核要求订单仍 paid），唯一收口手段就是**再调一次 approve**：
           * 距上次认领满 2 分钟 → 服务端先向支付宝查单、把结论写进审核备注并释放回 pending
           * 重走审核；不足 2 分钟 → 409 并告知还差几秒。
           * 因此这一行必须有按钮，否则后端给的能力在管理台上完全不可达。
           */
          <Tooltip
            title={
              canReview
                ? '服务端先向支付宝查单：查到已退款就收口，确认未退款才真正重试打款（out_request_no 即订单号，渠道幂等，不会退第二次）'
                : '缺少权限 admin.orders.refund'
            }
          >
            <span>
              <Button size="small" disabled={!canReview} onClick={() => openApprove(record)}>
                对账并重试
              </Button>
              <span style={{ ...subStyle, display: 'block' }}>卡住时先查单再重试</span>
            </span>
          </Tooltip>
        ) : (
          <span style={subStyle}>已处理</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="退款审核"
        description="用户申请的退款不会自动打款：通过的那一刻才调用支付宝原路退回，驳回则按申请时快照恢复权益。两个动作都写入审计日志"
      />

      <Card title="退款设置" size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={labelStyle}>自助退款时限（天）</div>
            <InputNumber
              min={1}
              max={365}
              precision={0}
              style={{ width: 110 }}
              disabled={!canReview}
              value={settingsDraft?.windowDays}
              onChange={(v) =>
                setSettingsDraft((prev) =>
                  prev ? { ...prev, windowDays: Number(v ?? prev.windowDays) } : prev
                )
              }
            />
          </div>
          <div>
            <div style={labelStyle}>审核承诺工作日（天）</div>
            <InputNumber
              min={1}
              max={30}
              precision={0}
              style={{ width: 110 }}
              disabled={!canReview}
              value={settingsDraft?.reviewBusinessDays}
              onChange={(v) =>
                setSettingsDraft((prev) =>
                  prev
                    ? { ...prev, reviewBusinessDays: Number(v ?? prev.reviewBusinessDays) }
                    : prev
                )
              }
            />
          </div>
          <Tooltip
            title={
              canReview
                ? '改动只对此后新提交的申请生效，已在途的申请按申请时存的快照处理'
                : '缺少权限 admin.orders.refund'
            }
          >
            <span>
              <Button
                type="primary"
                disabled={!canReview || !settingsDirty}
                loading={settingsMutation.isPending}
                onClick={saveSettings}
              >
                保存设置
              </Button>
            </span>
          </Tooltip>
          {settingsQuery.isError ? (
            <span style={subStyle}>退款设置读取失败，服务端可能尚未提供该端点</span>
          ) : null}
        </div>
      </Card>

      <Card styles={{ body: { padding: 0 } }}>
        <Tabs
          style={{ padding: '0 16px' }}
          tabBarStyle={{ margin: 0 }}
          activeKey={filters.status ?? 'pending'}
          onChange={(key) => setFilters({ status: key as RefundReviewStatusFilter })}
          items={STATUS_TABS.map((tab, index) => ({
            key: tab.key,
            label: (
              <span>
                {tab.label} <span style={countStyle}>{countQueries[index]?.data?.total ?? 0}</span>
              </span>
            ),
          }))}
        />

        <Table<RefundReview> size="middle" columns={columns} {...tableProps} scroll={{ x: 1700 }} />
      </Card>

      <Modal
        open={Boolean(approveTarget)}
        title={isReconciling ? '对账并重试打款' : '通过退款申请'}
        okText={isReconciling ? '对账并重试' : '确认调用支付宝退款'}
        cancelText="取消"
        okButtonProps={{ danger: true, loading: approveMutation.isPending }}
        onOk={confirmApprove}
        onCancel={() => setApproveTarget(null)}
        maskClosable={false}
        width={470}
      >
        {approveTarget ? (
          <>
            <p style={{ marginTop: 0, marginBottom: 10 }}>
              订单 <b className="mono">{approveTarget.orderNo}</b> · {userLabelOf(approveTarget)}
              {approveTarget.userName && approveTarget.userPhone
                ? `（${approveTarget.userPhone}）`
                : null}{' '}
              · {approveTarget.planName ?? '未知套餐'}
              <br />
              <span style={subStyle}>
                申请于 {fmtTime(approveTarget.requestedAt)}，当时自助退款时限{' '}
                {approveTarget.windowDaysAtRequest} 天；付款于 {fmtTime(approveTarget.paidAt)}
              </span>
            </p>
            {isReconciling ? (
              // 卡住的 processing 单：说清「先查单、再决定是否打款」，避免运营以为会退第二次钱
              <Alert
                type="warning"
                showIcon
                message="将先向支付宝查询这笔退款，再决定是否重试打款"
                description="服务端查到渠道已退款就按成功收口（退款请求号固定为订单号，渠道幂等，不会重复退款）；确认未退款才真正发起打款。查单结论会写进「审核备注」。若距上次点击不足 2 分钟，服务端会拒绝对账并返回还需等待的秒数。"
              />
            ) : (
              <Alert
                type="error"
                showIcon
                message={`将立即调用支付宝原路退款 ${fmtAmount(
                  approveTarget.amount,
                  approveTarget.currency
                )}，不可撤销`}
                description="钱从商户账户实时划出，订单随即转为「已退款」并写入审计日志。用户权益在申请提交时已收回，通过后不再恢复。渠道失败时资金不变动，可原样重试。"
              />
            )}
            {failureHint ? (
              <Alert style={{ marginTop: 12 }} type="warning" showIcon message={failureHint} />
            ) : null}
          </>
        ) : null}
      </Modal>

      <ConfirmReasonModal
        open={Boolean(rejectTarget)}
        title="驳回退款申请"
        reasonLabel="驳回理由（必填，不超过 200 字，会反馈给申请人）"
        confirmText="确认驳回"
        confirmLoading={rejectMutation.isPending}
        description={
          rejectTarget ? (
            <>
              驳回后<b>不调用退款渠道</b>，系统按申请时存的快照恢复 {userLabelOf(rejectTarget)} 的
              「{rejectTarget.planName ?? '原'}」权益；理由会展示给申请人。
              {failureHint ? (
                <Alert style={{ marginTop: 10 }} type="warning" showIcon message={failureHint} />
              ) : null}
            </>
          ) : null
        }
        onCancel={() => setRejectTarget(null)}
        onConfirm={(reason) => rejectMutation.mutate({ id: rejectTarget?.id ?? '', reason })}
      />
    </>
  );
}
