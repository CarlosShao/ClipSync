import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { App as AntdApp, Avatar, Button, Drawer, Skeleton, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  assignUserRole,
  deleteUser,
  exportUserData,
  forceLogoutUser,
  getUserDetail,
  grantUserTrial,
  notifyUser,
  rebindUserIdentity,
  resetUserPassword,
  resetUserTwoFactor,
  updateUserStatus,
} from '@/api/users';
import { grantSubscription } from '@/api/subscriptions';
import { AssignRoleModal } from '@/components/AssignRoleModal';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { NotifyUserModal, type NotifyType } from '@/components/NotifyUserModal';
import { RebindModal } from '@/components/RebindModal';
import { ResetPasswordModal } from '@/components/ResetPasswordModal';
import { TrialModal } from '@/components/TrialModal';
import { GrantSubscriptionModal } from '@/pages/subscriptions/GrantSubscriptionModal';
import { StatusTag } from '@/components/StatusTag';
import { planLabel, planTone } from '@/components/StatusTag/mappers';
import { queryKeys } from '@/queryKeys';
import { hasPerm } from '@/utils/permissions';
import { fmtDate, fmtMoney, fmtTime } from '@/utils/format';
import type { AdminSubscription } from '@/api/types';
import styles from './UserDrawer.module.css';

interface UserDrawerProps {
  open: boolean;
  userId: string | null;
  onClose: () => void;
  /** AF-13：打开抽屉后自动定位到套餐操作（直接弹出赠期/调整套餐弹窗），供列表页「改套餐」入口使用 */
  autoOpenGrant?: boolean;
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  os?: string;
  status: 'online' | 'offline';
  lastActiveAt?: string | null;
}

const DEVICE_COLUMNS: ColumnsType<DeviceRow> = [
  { title: '设备', dataIndex: 'name', render: (v: string) => <strong>{v}</strong> },
  {
    title: '平台',
    dataIndex: 'platform',
    width: 120,
    render: (v: string, record) => `${v}${record.os ? ` ${record.os.replace(/^\D+\s*/, '')}` : ''}`,
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 90,
    render: (v: DeviceRow['status']) => (
      <StatusTag tone={v === 'online' ? 'green' : 'gray'}>
        {v === 'online' ? '在线' : '离线'}
      </StatusTag>
    ),
  },
];

/**
 * 用户详情抽屉（对照草图 B）：资料 kv + 设备表 + 最近审计时间线 + 管理操作。
 * 「停用账号」走 ConfirmReasonModal（原因必填）→ PATCH /admin/users/:id/status。
 */
export function UserDrawer({ open, userId, onClose, autoOpenGrant }: UserDrawerProps) {
  const { message, modal } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [forceLogoutOpen, setForceLogoutOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  // AN-13：数据主体数据导出（原因写入审计 admin.users.export）
  const [exportOpen, setExportOpen] = useState(false);
  // 2026-10-05：对单个用户定向通知（此前只能改库或对全体广播公告）
  const [notifyOpen, setNotifyOpen] = useState(false);
  // 2026-10-05：分配角色（端点早有、此前无 UI）
  const [assignRoleOpen, setAssignRoleOpen] = useState(false);
  // 2026-10-05：代重置密码（用户收不到验证码时的唯一救援路径）
  const [resetPasswordOpen, setResetPasswordOpen] = useState(false);
  // 2026-10-05：换绑手机号/邮箱（用户换号后自己改不了手机号）
  const [rebindOpen, setRebindOpen] = useState(false);
  // 2026-10-05：人工开通/重置试用（用户侧试用是终身一次）
  const [trialOpen, setTrialOpen] = useState(false);
  // AF-13：每次抽屉打开只自动弹出一次赠期弹窗（用户手动关掉后不反复打扰）
  const autoGrantDoneRef = useRef(false);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.user(userId ?? ''),
    queryFn: () => getUserDetail(userId as string),
    enabled: open && Boolean(userId),
  });

  const statusMutation = useMutation({
    mutationFn: (payload: { id: string; status: 'active' | 'disabled'; reason?: string }) =>
      updateUserStatus(payload.id, { status: payload.status, reason: payload.reason }),
    onSuccess: (updated, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void message.success(variables.status === 'disabled' ? '账号已停用' : '账号已启用');
      if (updated.status === 'disabled') setDeactivateOpen(false);
    },
  });

  // AF-11：强制下线（吊销全部活跃会话，原因写审计）
  const forceLogoutMutation = useMutation({
    mutationFn: (payload: { id: string; reason: string }) =>
      forceLogoutUser(payload.id, { reason: payload.reason }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void message.success(`已强制下线，吊销 ${result.revokedSessions} 个会话`);
      setForceLogoutOpen(false);
    },
  });

  // AF-12：删除账户（软删，原因写审计；列表标记「已删除」）
  const deleteMutation = useMutation({
    mutationFn: (payload: { id: string; reason: string }) =>
      deleteUser(payload.id, { reason: payload.reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void message.success('账户已删除（软删，可在列表重新启用）');
      setDeleteOpen(false);
      onClose();
    },
  });

  // AN-13：数据主体数据导出（拉取 JSON 附件并触发浏览器下载）
  const exportMutation = useMutation({
    mutationFn: (payload: { id: string; reason: string }) =>
      exportUserData(payload.id, payload.reason),
    onSuccess: (blob, variables) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clipsync-user-export-${variables.id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      void message.success('用户数据已导出');
      setExportOpen(false);
    },
  });

  /**
   * 2026-10-05：对单个用户定向通知（落 notification_history + WS 实时推给其在线设备）。
   * onlineDevices 如实回报"对方此刻在不在线" —— 落库一定成功，但不谎报已送达。
   */
  const notifyMutation = useMutation({
    mutationFn: (payload: {
      id: string;
      title: string;
      body: string;
      notificationType: NotifyType;
    }) =>
      notifyUser(payload.id, {
        title: payload.title,
        body: payload.body,
        notificationType: payload.notificationType,
      }),
    onSuccess: (result) => {
      void message.success(
        result.onlineDevices > 0
          ? `已发送（${result.onlineDevices} 台在线设备已实时收到）`
          : '已发送（对方当前不在线，下次打开客户端即可在通知中心看到）',
      );
      setNotifyOpen(false);
    },
  });

  /**
   * 2026-10-05：分配角色（端点早有、此前无 UI）。
   * 超管唯一性/越级两道闸在服务端，前端只把 403 的原话交给拦截器 toast。
   */
  const assignRoleMutation = useMutation({
    mutationFn: (payload: { id: string; roleId: string; reason: string }) =>
      assignUserRole(payload.id, { roleId: payload.roleId, reason: payload.reason }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
      void message.success(`已更新 ${updated.nickname || '该用户'} 的角色`);
      setAssignRoleOpen(false);
    },
  });

  /**
   * 2026-10-05：重置两步验证（端点早有、此前无 UI）。
   * 端点不收 reason，所以这里用一次普通确认（不可撤销 + 会削弱账号安全，值得拦一下）。
   */
  const resetTwoFactorMutation = useMutation({
    mutationFn: (id: string) => resetUserTwoFactor(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void message.success('两步验证已重置，用户需重新绑定');
    },
  });

  /**
   * 2026-10-05：代重置密码。**不在这里 toast 密码** —— 交给弹窗当场展示
   *（服务端只在响应里给一次，toast 一闪而过等于逼运营抄屏）。
   */
  const resetPasswordMutation = useMutation({
    mutationFn: (payload: { id: string; reason: string }) =>
      resetUserPassword(payload.id, { reason: payload.reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  /** 2026-10-05：人工开通/重置试用（刻意绕过用户侧的终身一次闸，服务端会留痕） */
  const trialMutation = useMutation({
    mutationFn: (payload: {
      id: string;
      reason: string;
      days: number;
      planId: string;
      billingCycle: 'monthly' | 'yearly';
    }) =>
      grantUserTrial(payload.id, {
        reason: payload.reason,
        days: payload.days,
        planId: payload.planId,
        billingCycle: payload.billingCycle,
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void message.success(`已为 ${updated.nickname || '该用户'} 开通试用`);
      setTrialOpen(false);
    },
  });

  /** 2026-10-05：换绑登录标识（服务端 COALESCE：只传一项就只改那一项） */
  const rebindMutation = useMutation({
    mutationFn: (payload: { id: string; phone?: string; email?: string; reason: string }) =>
      rebindUserIdentity(payload.id, {
        phone: payload.phone,
        email: payload.email,
        reason: payload.reason,
      }),
    onSuccess: (_updated, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      const what = variables.phone && variables.email ? '手机号与邮箱' : variables.phone ? '手机号' : '邮箱';
      void message.success(`已换绑${what}，请提醒用户用新标识登录`);
      setRebindOpen(false);
    },
  });

  // AF-10：赠期 / 调整套餐（复用订阅页 GrantSubscriptionModal；无订阅行则提示）
  const grantMutation = useMutation({
    mutationFn: (payload: {
      id: string;
      planId: 'pro' | 'enterprise';
      months: number;
      reason: string;
    }) =>
      grantSubscription(payload.id, {
        planId: payload.planId,
        months: payload.months,
        reason: payload.reason,
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void message.success(
        `已赠期：${updated.planName ?? ''} · 周期止 ${fmtDate(updated.currentPeriodEnd)}`
      );
      setGrantOpen(false);
    },
  });

  useEffect(() => {
    if (!open) {
      setDeactivateOpen(false);
      setForceLogoutOpen(false);
      setDeleteOpen(false);
      setGrantOpen(false);
      setExportOpen(false);
      autoGrantDoneRef.current = false;
    }
  }, [open]);

  const user = data?.user;
  const disabled = user?.status === 'disabled';

  // 赠期目标（需要订阅行 id；free 用户无订阅行 → 按钮提示不可赠期）
  const grantTarget: AdminSubscription | null = useMemo(() => {
    if (!user?.subscription?.id) return null;
    const planKeyLabel =
      user.subscription.plan.charAt(0).toUpperCase() + user.subscription.plan.slice(1);
    return {
      id: user.subscription.id,
      userId: user.id,
      userLabel: user.nickname || user.phone,
      planId: '',
      planKey: planKeyLabel,
      planName: planLabel[user.subscription.plan] ?? planKeyLabel,
      billingCycle: user.subscription.billingCycle,
      status: user.subscription.status,
      currentPeriodStart: null,
      currentPeriodEnd: user.subscription.currentPeriodEnd,
      autoRenew: user.subscription.autoRenew,
      createdAt: user.createdAt,
    };
  }, [user]);

  // AF-13：列表页「改套餐/转正套餐」入口 → 抽屉打开且订阅行就绪后自动弹出赠期/调整套餐弹窗
  // （free 用户无订阅行 → grantTarget 为 null，不自动弹出，抽屉内赠期按钮有 Tooltip 说明）
  // 位置说明：必须位于 grantTarget 声明之后（tsc -b 的 TDZ 检查），勿上移。
  useEffect(() => {
    if (open && autoOpenGrant && grantTarget && !autoGrantDoneRef.current) {
      setGrantOpen(true);
      autoGrantDoneRef.current = true;
    }
  }, [open, autoOpenGrant, grantTarget]);

  // RB-07：管理操作按钮按权限键裁剪（对齐 devices 页 canOffline 模式）
  const canManage = hasPerm('admin.users.manage');
  const canDelete = hasPerm('admin.users.delete');
  /**
   * 2026-10-05：定向通知用「对外触达」权限（admin.announce.send），与服务端
   * requirePerm 一致，刻意与管理类权限分开 —— 能改用户资料的运营未必该能私信用户。
   */
  const canNotify = hasPerm('admin.announce.send');
  /** 2026-10-05：分配角色用的是 roles.manage（与服务端 requirePerm 一致，比 users.manage 更高） */
  const canAssignRole = hasPerm('admin.roles.manage');
  /** 2026-10-05：开通试用服务端要求 admin.subscriptions.grant（人工给出订阅权益同一权限键） */
  const canGrantSubscription = hasPerm('admin.subscriptions.grant');

  const renderBody = () => {
    if (isLoading || !user) {
      return <Skeleton active paragraph={{ rows: 8 }} />;
    }
    return (
      <>
        <dl className={styles.kv}>
          <dt>手机号</dt>
          <dd className={styles.mono}>{user.phone}</dd>
          <dt>邮箱</dt>
          <dd>{user.email ?? '—'}</dd>
          <dt>注册时间</dt>
          <dd className={styles.num}>{fmtDate(user.createdAt)}</dd>
          <dt>最近活跃</dt>
          <dd>{user.lastActiveDesc ?? fmtTime(user.lastActiveAt)}</dd>
          <dt>订阅</dt>
          <dd>
            {user.subscription.status === 'trialing' ? (
              <StatusTag tone="amber">
                试用 · 剩 {user.subscription.trialDaysLeft ?? 0} 天
              </StatusTag>
            ) : user.subscription.plan === 'free' ? (
              <StatusTag tone="gray">Free</StatusTag>
            ) : (
              <StatusTag tone="brand">
                {planLabel[user.subscription.plan]} ·{' '}
                {user.subscription.billingCycle === 'yearly' ? '年付' : '月付'} ·{' '}
                {fmtDate(user.subscription.currentPeriodEnd)} 到期
              </StatusTag>
            )}
          </dd>
          <dt>累计消费</dt>
          <dd className={`${styles.num} ${styles.strong}`}>
            {fmtMoney(user.totalSpent)} · {user.orderCount} 笔订单
          </dd>
          <dt>风险标记</dt>
          <dd>
            {user.riskFlag ? (
              <StatusTag tone="red">{user.riskFlag}</StatusTag>
            ) : (
              <StatusTag tone="green">无</StatusTag>
            )}
          </dd>
        </dl>

        <div className={styles.sectTitle}>设备（{data?.devices.length ?? 0} 台）</div>
        <Table<DeviceRow>
          rowKey="id"
          size="small"
          columns={DEVICE_COLUMNS}
          dataSource={data?.devices ?? []}
          pagination={false}
        />

        <div className={styles.sectTitle}>最近动态</div>
        {data?.recentAuditLogs.length ? (
          <ul className={styles.timeline}>
            {data.recentAuditLogs.map((log) => (
              <li key={log.id} className={styles.timelineItem}>
                <span className={styles.timelineTime}>{fmtTime(log.createdAt)}</span>
                <span className={styles.timelineAction}>{log.action}</span>
                <span className={styles.timelineDetail}>{log.details}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.emptyText}>暂无相关审计记录</div>
        )}

        <div className={styles.sectTitle}>管理操作</div>
        <div className={styles.actions}>
          {/* AF-10：赠期 / 调整套餐（复用订阅页弹窗；无订阅行不可赠期） */}
          <Tooltip title={grantTarget ? '' : '该用户暂无订阅记录，无法赠期'}>
            <span>
              <Button disabled={!grantTarget} onClick={() => setGrantOpen(true)}>
                赠期 1 个月
              </Button>
            </span>
          </Tooltip>
          {/* 2026-10-05：定向通知（只发给这一个人，不广播；对方离线则落通知中心） */}
          <Tooltip title={canNotify ? '' : '缺少权限: admin.announce.send'}>
            <span>
              <Button disabled={!canNotify} onClick={() => setNotifyOpen(true)}>
                发站内通知
              </Button>
            </span>
          </Tooltip>
          {/* 2026-10-05：分配角色（端点早有、此前前端零调用） */}
          <Tooltip title={canAssignRole ? '' : '缺少权限: admin.roles.manage'}>
            <span>
              <Button disabled={!canAssignRole} onClick={() => setAssignRoleOpen(true)}>
                分配角色
              </Button>
            </span>
          </Tooltip>
          {/* 2026-10-05：代重置密码（用户收不到验证码时的唯一救援路径） */}
          <Tooltip title={canManage ? '' : '缺少权限'}>
            <span>
              <Button disabled={!canManage} onClick={() => setResetPasswordOpen(true)}>
                重置密码
              </Button>
            </span>
          </Tooltip>
          {/* 2026-10-05：换绑手机号/邮箱（用户换号后自己改不了手机号） */}
          <Tooltip title={canManage ? '' : '缺少权限'}>
            <span>
              <Button disabled={!canManage} onClick={() => setRebindOpen(true)}>
                换绑手机/邮箱
              </Button>
            </span>
          </Tooltip>
          {/* 2026-10-05：人工开通/重置试用（用户侧试用终身一次，这是刻意的例外通道） */}
          <Tooltip
            title={canGrantSubscription ? '用户侧试用每人只能一次，这里刻意绕过' : '缺少权限: admin.subscriptions.grant'}
          >
            <span>
              <Button disabled={!canGrantSubscription} onClick={() => setTrialOpen(true)}>
                开通试用
              </Button>
            </span>
          </Tooltip>
          {/* 2026-10-05：重置两步验证（用户换手机丢了 TOTP 时的唯一解救入口） */}
          <Tooltip title={canManage ? '' : '缺少权限'}>
            <span>
              <Button
                disabled={!canManage}
                loading={resetTwoFactorMutation.isPending}
                onClick={() => {
                  // 花括号包起来：modal.confirm 有返回值，直接箭头返回会被判
                  // "Promise-returning function to void attribute"
                  modal.confirm({
                    title: '重置两步验证？',
                    content:
                      '将清空该用户的两步验证配置，他可仅凭密码登录，需要重新绑定 TOTP。写审计 admin.user.reset_2fa。',
                    okText: '确认重置',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => {
                      resetTwoFactorMutation.mutate(user.id);
                    },
                  });
                }}
              >
                重置 2FA
              </Button>
            </span>
          </Tooltip>
          {/* AF-11：强制下线（原因必填，吊销全部活跃会话） */}
          <Tooltip title={canManage ? '' : '缺少权限'}>
            <span>
              <Button danger disabled={!canManage} onClick={() => setForceLogoutOpen(true)}>
                强制下线
              </Button>
            </span>
          </Tooltip>
          {disabled ? (
            <Tooltip title={canManage ? '' : '缺少权限'}>
              <span>
                <Button
                  type="primary"
                  disabled={!canManage}
                  loading={statusMutation.isPending}
                  onClick={() => statusMutation.mutate({ id: user.id, status: 'active' })}
                >
                  启用账号
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Tooltip title={canManage ? '' : '缺少权限'}>
              <span>
                <Button danger disabled={!canManage} onClick={() => setDeactivateOpen(true)}>
                  停用账号
                </Button>
              </span>
            </Tooltip>
          )}
          {/* AF-12：删除账户（软删，原因必填；超管由后端 403 拦截） */}
          <Tooltip title={canDelete ? '' : '缺少权限'}>
            <span>
              <Button danger disabled={!canDelete} onClick={() => setDeleteOpen(true)}>
                删除账户
              </Button>
            </span>
          </Tooltip>
          {/* AN-13：数据主体数据导出（可携权；原因写审计 admin.users.export） */}
          <Tooltip title="导出资料 / 设备 / 订阅 / 订单 / 剪贴板元数据为 JSON">
            <Button onClick={() => setExportOpen(true)}>导出数据</Button>
          </Tooltip>
          <Button type="link" onClick={() => void navigate(`/audit?userId=${user.id}`)}>
            查看审计日志
          </Button>
        </div>

        <ConfirmReasonModal
          open={deactivateOpen}
          title="停用账号"
          description={
            <>
              即将停用 <b>{user.nickname}</b>（{user.phone}）。停用后该用户全部设备将退出登录，
              剪贴板同步立即中断；订阅保留至当前周期结束。
            </>
          }
          confirmText="确认停用"
          confirmLoading={statusMutation.isPending}
          onCancel={() => setDeactivateOpen(false)}
          onConfirm={(reason) =>
            statusMutation.mutateAsync({ id: user.id, status: 'disabled', reason })
          }
        />

        <ConfirmReasonModal
          open={forceLogoutOpen}
          title="强制下线"
          description={
            <>
              即将强制下线 <b>{user.nickname || user.phone}</b> 的全部会话。
              该用户所有已登录设备（含桌面端与移动端）将立即退出登录，需重新登录才能继续同步。
            </>
          }
          confirmText="确认下线"
          confirmLoading={forceLogoutMutation.isPending}
          onCancel={() => setForceLogoutOpen(false)}
          onConfirm={(reason) => forceLogoutMutation.mutateAsync({ id: user.id, reason })}
        />

        <ConfirmReasonModal
          open={deleteOpen}
          title="删除账户"
          description={
            <>
              即将删除 <b>{user.nickname || user.phone}</b>（{user.phone}）。
              删除为软删：账号停用并标记「已删除」，其订阅与订单记录保留，可由管理员重新启用。
            </>
          }
          confirmText="确认删除"
          confirmLoading={deleteMutation.isPending}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={(reason) => deleteMutation.mutateAsync({ id: user.id, reason })}
        />

        {/* AN-13：数据主体数据导出确认（原因写入审计 admin.users.export） */}
        <ConfirmReasonModal
          open={exportOpen}
          title="导出用户数据"
          description={
            <>
              将导出 <b>{user.nickname || user.phone}</b> 的资料、设备、订阅、订单、
              剪贴板元数据与相关审计为 JSON 文件（剪贴板正文为端到端加密，不在导出范围）。
              导出行为将写入审计日志。
            </>
          }
          danger={false}
          confirmText="确认导出"
          confirmLoading={exportMutation.isPending}
          onCancel={() => setExportOpen(false)}
          onConfirm={(reason) => exportMutation.mutateAsync({ id: user.id, reason })}
        />

        <GrantSubscriptionModal
          open={grantOpen}
          subscription={grantTarget}
          confirmLoading={grantMutation.isPending}
          onCancel={() => setGrantOpen(false)}
          onConfirm={(planId, months, reason) =>
            grantMutation.mutateAsync({
              id: grantTarget?.id ?? '',
              planId: planId === 'enterprise' ? 'enterprise' : 'pro',
              months,
              reason,
            })
          }
        />

        <NotifyUserModal
          open={notifyOpen}
          userLabel={user.nickname || user.phone || ''}
          confirmLoading={notifyMutation.isPending}
          onCancel={() => setNotifyOpen(false)}
          onConfirm={(payload) => notifyMutation.mutateAsync({ id: user.id, ...payload })}
        />

        <AssignRoleModal
          open={assignRoleOpen}
          userLabel={user.nickname || user.phone || ''}
          currentRoleId={user.roleId}
          confirmLoading={assignRoleMutation.isPending}
          onCancel={() => setAssignRoleOpen(false)}
          onConfirm={(roleId, reason) =>
            assignRoleMutation.mutateAsync({ id: user.id, roleId, reason })
          }
        />

        <ResetPasswordModal
          open={resetPasswordOpen}
          userLabel={user.nickname || user.phone || ''}
          onCancel={() => setResetPasswordOpen(false)}
          onConfirm={(reason) => resetPasswordMutation.mutateAsync({ id: user.id, reason })}
        />

        <RebindModal
          open={rebindOpen}
          userLabel={user.nickname || user.phone || ''}
          currentPhone={user.phone}
          currentEmail={user.email}
          confirmLoading={rebindMutation.isPending}
          onCancel={() => setRebindOpen(false)}
          onConfirm={(payload) => rebindMutation.mutateAsync({ id: user.id, ...payload })}
        />

        <TrialModal
          open={trialOpen}
          userLabel={user.nickname || user.phone || ''}
          confirmLoading={trialMutation.isPending}
          onCancel={() => setTrialOpen(false)}
          onConfirm={(payload) => trialMutation.mutateAsync({ id: user.id, ...payload })}
        />
      </>
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={460}
      closable={false}
      styles={{ body: { padding: 18 } }}
    >
      <div className={styles.header}>
        <Avatar size={34} style={{ background: 'linear-gradient(135deg, #6e5ce8, #5a4bd1)' }}>
          {user?.nickname?.slice(0, 1) ?? '·'}
        </Avatar>
        <div className={styles.headerInfo}>
          <div className={styles.headerName}>
            {user?.nickname ?? '加载中…'}
            {user ? (
              <span className={styles.headerTag}>
                {user.subscription.status === 'trialing' ? (
                  <StatusTag tone="amber">试用</StatusTag>
                ) : (
                  <StatusTag tone={planTone[user.subscription.plan]}>
                    {planLabel[user.subscription.plan]}
                  </StatusTag>
                )}
              </span>
            ) : null}
          </div>
          <div className={`${styles.headerId} ${styles.mono}`}>{user?.id ?? ''}</div>
        </div>
        <Button size="small" type="text" onClick={onClose} aria-label="关闭">
          ✕
        </Button>
      </div>
      {renderBody()}
    </Drawer>
  );
}
