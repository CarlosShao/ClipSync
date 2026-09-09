import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { PageHeader } from '@/components/PageHeader';
import {
  getConfigs,
  getAnnouncements,
  getFlags,
  patchConfig,
  patchFlag,
  sendAnnouncement,
} from '@/api/configs';
// AN-16：邮件通道管理（多 SMTP 账号 + 按用途路由 + failover，替代原「邮件 (SMTP)」参数卡）
import {
  createEmailChannel,
  deleteEmailChannel,
  getEmailChannels,
  patchEmailChannel,
  testEmailChannel,
  type EmailChannel,
  type EmailChannelPayload,
} from '@/api/emailChannels';
import { queryKeys } from '@/queryKeys';
import { hasPerm } from '@/utils/permissions';
import type { Announcement, FeatureFlag, SendAnnouncementPayload, SystemConfig } from '@/api/types';
import styles from './settings.module.css';

const AUDIENCE_OPTIONS: { value: Announcement['audience']; label: string }[] = [
  { value: 'all', label: '全部用户' },
  { value: 'pro_plus', label: '仅 Pro 及以上' },
  { value: 'free', label: '仅 Free' },
];

const AUDIENCE_LABEL: Record<Announcement['audience'], string> = {
  all: '全部用户',
  pro_plus: '仅 Pro 及以上',
  free: '仅 Free',
};

const DISPLAY_OPTIONS: { value: Announcement['displayMode']; label: string }[] = [
  { value: 'once', label: '显示 1 次' },
  { value: 'persistent', label: '常驻至关闭' },
];

const AI_PROVIDER_OPTIONS = ['openrouter', 'openai', 'anthropic', 'deepseek'].map((v) => ({
  value: v,
  label: v,
}));

const LOG_LEVEL_OPTIONS = ['debug', 'info', 'warn', 'error'].map((v) => ({ value: v, label: v }));

// AN-16：邮件通道用途（与 email_channels.purpose CHECK 约束一致）
const CHANNEL_PURPOSE_OPTIONS = [
  { value: 'transactional', label: '事务邮件（验证码 / 账户通知）' },
  { value: 'marketing', label: '营销邮件（批量，预留）' },
];

const CHANNEL_PURPOSE_LABEL: Record<EmailChannel['purpose'], string> = {
  transactional: '事务',
  marketing: '营销',
};

const MAINTENANCE_HINT =
  '开启后剪贴板/同步/媒体/上传接口返回维护提示，登录与管理台不受影响；客户端即时收到 WS 推送并显示维护横幅';

/**
 * 功能开关的生效范围与优先级说明（与后端 utils/featureFlags.js 的生效链路一一对应）。
 * 生效链路：管理台写库（持久化）→ 服务端 requireFlag 强制拦截（≤5s）→ WS 全端广播 →
 * 客户端拉取 GET /api/app/feature-flags 或收 WS 推送即时感知；未适配客户端由服务端兜底 403。
 */
const FLAG_META: Record<string, { scope: string; priority: string }> = {
  enable_subscription: {
    scope:
      '全部非管理员用户的配额与套餐权益：关闭期间一律按 Free 配额校验；已有订单与订阅记录不受影响，重新开启即恢复',
    priority: '服务端 ≤5s 强制生效（重启不丢失）；客户端在下次请求时被按 Free 校验',
  },
  enable_ai_agent: {
    scope: '全部 AI 能力接口：AI 对话、长程记忆、AI 设置、供应商代理；关闭后服务端直接拒绝（403）',
    priority:
      '服务端 ≤5s 强制生效；适配后的客户端经 WS 推送即时灰显 AI 入口，未适配客户端在下次请求时收到禁用提示',
  },
  enable_public_sharing: {
    scope: '仅限制新建：关闭后无法创建共享链接与上传分享文件；已创建的链接保持可访问（不做吊销）',
    priority: '服务端 ≤5s 强制生效，客户端创建入口在下次调用时收到禁用提示',
  },
  enable_2fa: {
    scope: '仅限制新开启：关闭后无法走两步验证绑定流程；已开启用户的登录验证、关闭操作不受影响',
    priority: '服务端 ≤5s 强制生效，客户端绑定入口在下次调用时收到禁用提示',
  },
  signup_waitlist: {
    scope:
      '仅影响新注册：开启后新用户进入待审核（登录被拦截），审批入口在「用户管理」页；存量用户不受影响',
    priority: '服务端实时强制；审批通过后用户立即可登录',
  },
  enable_signup: {
    scope:
      '注册接口总开关：关闭后新用户注册直接 403（登录不受影响），两端注册入口同步隐藏；与注册审核正交（关闭 > 审核 > 开放）',
    priority: '服务端 ≤5s 强制生效；客户端经 WS 推送 / 拉取即时感知',
  },
};

/** 设置页查询共用 staleTime：避免窗口聚焦自动重取时打断表单编辑 */
const SETTINGS_STALE_TIME = 5 * 60_000;

/** 限流配置键（CO-11）：独立卡片渲染，其余键留在「系统参数」卡 */
const RATE_LIMIT_KEYS = [
  'rate_limit_api_per_min',
  'rate_limit_send_code_per_hour',
  'rate_limit_login_failed_per_15min',
  'rate_limit_upload_per_min',
  'rate_limit_disabled',
] as const;

function isRateLimitKey(key: string): boolean {
  return (RATE_LIMIT_KEYS as readonly string[]).includes(key);
}

/** 数字键（InputNumber min=1）：其余键为布尔/字符串，不参与必填校验 */
function isNumericConfigKey(key: string): boolean {
  return (
    key !== 'ai_default_provider' &&
    key !== 'log_level' &&
    key !== 'menu_overrides' &&
    key !== 'rate_limit_disabled' &&
    !key.startsWith('smtp_')
  );
}

/** 按键分支校验规则：数字键必填；menu_overrides 须为合法 JSON（服务端深合并消费）；SMTP 键与 log_level 允许为空 */
function configRules(key: string) {
  if (key === 'menu_overrides') {
    return [
      {
        validator: (_rule: unknown, value: unknown) => {
          if (typeof value !== 'string' || value.trim() === '') return Promise.resolve();
          try {
            JSON.parse(value);
            return Promise.resolve();
          } catch {
            return Promise.reject(
              new Error('须为合法 JSON（如 {} 或 {"nav.ai":{"minPlan":"Pro"}}）')
            );
          }
        },
      },
    ];
  }
  return isNumericConfigKey(key) ? [{ required: true, message: '取值不能为空' }] : undefined;
}

interface AnnouncementFormValues {
  title: string;
  content: string;
  audience: Announcement['audience'];
  displayMode: Announcement['displayMode'];
}

/** 系统设置（对照草图 B，五卡纵排）：功能开关 / 维护模式 / 限流配置 / 公告下发 / 系统参数 */
export default function SettingsPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [maintenanceTarget, setMaintenanceTarget] = useState<boolean | null>(null);
  const [savingGroup, setSavingGroup] = useState<string | null>(null);
  const [savingRateLimits, setSavingRateLimits] = useState(false);
  const [announceForm] = Form.useForm<AnnouncementFormValues>();
  const [configForm] = Form.useForm<Record<string, number | string | boolean>>();
  const [rateLimitForm] = Form.useForm<Record<string, number | string | boolean>>();
  // AN-16：邮件通道管理状态（新增/编辑弹窗、测试邮件弹窗、删除确认）
  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<EmailChannel | null>(null);
  const [testChannel, setTestChannel] = useState<EmailChannel | null>(null);
  const [deleteChannelTarget, setDeleteChannelTarget] = useState<EmailChannel | null>(null);
  const [channelForm] = Form.useForm<EmailChannelPayload>();
  const [testEmailForm] = Form.useForm<{ to?: string }>();

  // RB-07：设置页对 admin.configs.view 只读可见，写操作按 admin.configs.manage 裁剪
  const canManageConfigs = hasPerm('admin.configs.manage');
  const canSendAnnouncement = hasPerm('admin.announce.send');
  // AN-16：邮件通道卡按 admin.email_channels.manage 裁剪（059 迁移仅授 super_admin）
  const canManageChannels = hasPerm('admin.email_channels.manage');

  const { data: flags } = useQuery({
    queryKey: queryKeys.flags(),
    queryFn: getFlags,
    staleTime: SETTINGS_STALE_TIME,
  });
  const { data: configs } = useQuery({
    queryKey: queryKeys.configs(),
    queryFn: getConfigs,
    staleTime: SETTINGS_STALE_TIME,
  });
  const { data: announcements } = useQuery({
    queryKey: queryKeys.announcements(),
    queryFn: getAnnouncements,
    staleTime: SETTINGS_STALE_TIME,
  });
  // AN-16：邮件通道列表
  const { data: channels } = useQuery({
    queryKey: emailChannelKeys.list(),
    queryFn: getEmailChannels,
    staleTime: SETTINGS_STALE_TIME,
  });

  // 功能开关：乐观更新 + 失败回滚
  const flagMutation = useMutation({
    mutationFn: (payload: { key: string; enabled: boolean }) =>
      patchFlag(payload.key, payload.enabled),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.flags() });
      const previous = queryClient.getQueryData<FeatureFlag[]>(queryKeys.flags());
      queryClient.setQueryData<FeatureFlag[]>(queryKeys.flags(), (old) =>
        old?.map((f) => (f.key === payload.key ? { ...f, enabled: payload.enabled } : f))
      );
      return { previous };
    },
    onError: (_error, _payload, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.flags(), context.previous);
      void message.error('开关切换失败，已回滚');
    },
    onSuccess: () => {
      void message.success('开关已切换并写入审计日志');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.flags() });
    },
  });

  // 维护模式：走 ConfirmReasonModal（原因必填）→ PATCH /admin/configs/maintenance_mode
  const maintenanceMutation = useMutation({
    mutationFn: (payload: { value: 'on' | 'off'; reason: string }) =>
      patchConfig('maintenance_mode', payload.value, payload.reason),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.configs() });
      void message.success(variables.value === 'on' ? '维护模式已开启' : '已恢复正常运行');
      setMaintenanceTarget(null);
    },
  });

  // 公告下发
  const announceMutation = useMutation({
    mutationFn: (payload: SendAnnouncementPayload) => sendAnnouncement(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.announcements() });
      void message.success('公告已下发');
      announceForm.resetFields();
    },
  });

  // ── AN-16：邮件通道 mutations ──
  // 错误提示（4090 凭据不完整 / 发送失败 / 权限）由 client.ts 拦截器统一 toast，此处只管成功侧
  const invalidateChannels = () => {
    void queryClient.invalidateQueries({ queryKey: emailChannelKeys.list() });
  };

  // 新建 / 编辑（编辑为部分更新；password 留空 = 保持不变，与 smtp_pass 交互口径一致）
  const saveChannelMutation = useMutation({
    mutationFn: ({ id, ...patch }: EmailChannelPayload & { id?: string }) =>
      id ? patchEmailChannel(id, patch) : createEmailChannel(patch),
    onSuccess: (_data, variables) => {
      invalidateChannels();
      void message.success(variables.id ? '邮件通道已更新' : '邮件通道已创建');
      setChannelModalOpen(false);
    },
  });

  // 启停
  const toggleChannelMutation = useMutation({
    mutationFn: (payload: { channel: EmailChannel; enabled: boolean }) =>
      patchEmailChannel(payload.channel.id, { enabled: payload.enabled }),
    onSuccess: () => {
      invalidateChannels();
      void message.success('通道状态已更新');
    },
  });

  // 设为默认：priority 调至当前所有通道最小值之前（purpose 路由时最先选中）
  const setDefaultChannelMutation = useMutation({
    mutationFn: (channel: EmailChannel) => {
      const samePurpose = (channels ?? []).filter((c) => c.purpose === channel.purpose);
      const min = samePurpose.length ? Math.min(...samePurpose.map((c) => c.priority)) : 0;
      const nextPriority = Math.max(0, min - 1);
      if (nextPriority === channel.priority) {
        return Promise.resolve(channel);
      }
      return patchEmailChannel(channel.id, { priority: nextPriority });
    },
    onSuccess: (channel) => {
      invalidateChannels();
      void message.success(
        `「${channel.name}」已是「${CHANNEL_PURPOSE_LABEL[channel.purpose]}」用途的默认通道`
      );
    },
  });

  // 删除（ConfirmReasonModal，原因写入审计）
  const deleteChannelMutation = useMutation({
    mutationFn: (payload: { channel: EmailChannel; reason: string }) =>
      deleteEmailChannel(payload.channel.id, payload.reason),
    onSuccess: () => {
      invalidateChannels();
      void message.success('邮件通道已删除');
      setDeleteChannelTarget(null);
    },
  });

  // 通道测试邮件（指定通道，不路由不降级）
  const channelTestMutation = useMutation({
    mutationFn: (payload: { id: string; to?: string }) => testEmailChannel(payload.id, payload.to),
    onSuccess: () => {
      void message.success('测试邮件已发送');
      setTestChannel(null);
    },
  });

  /** 打开新增通道弹窗（Form initialValues 生效） */
  const openChannelModal = () => {
    setEditingChannel(null);
    channelForm.resetFields();
    setChannelModalOpen(true);
  };

  /** 打开编辑通道弹窗：回填现有值（password 恒为空起填，留空 = 保持不变） */
  const openEditChannelModal = (channel: EmailChannel) => {
    setEditingChannel(channel);
    channelForm.setFieldsValue({
      name: channel.name,
      purpose: channel.purpose,
      provider: channel.provider,
      host: channel.host,
      port: channel.port,
      secure: channel.secure,
      username: channel.username,
      password: '',
      from_addr: channel.from_addr,
      enabled: channel.enabled,
      priority: channel.priority,
    });
    setChannelModalOpen(true);
  };

  /** 打开通道测试邮件弹窗：收件邮箱默认取通道 username（可改） */
  const openChannelTestModal = (channel: EmailChannel) => {
    testEmailForm.setFieldsValue({ to: channel.username || '' });
    setTestChannel(channel);
  };

  const maintenanceConfig = configs?.find((c) => c.key === 'maintenance_mode');
  const maintenanceOn = maintenanceConfig?.value === 'on';
  // AN-16：smtp_* 键已迁移为「邮件通道」卡管理（原键仅只读兼容，不再出现在系统参数表单）
  const editableConfigs = (configs ?? []).filter(
    (c) => c.key !== 'maintenance_mode' && !c.key.startsWith('smtp_')
  );
  const rateLimitConfigs = RATE_LIMIT_KEYS.map((key) =>
    editableConfigs.find((c) => c.key === key)
  ).filter((c): c is SystemConfig => Boolean(c));
  const systemConfigs = editableConfigs.filter((c) => !isRateLimitKey(c.key));

  // 系统参数分组（UI 归组；服务端 CONFIG_CATALOG 为键的事实来源，未归组键走「其它」兜底）
  // AN-16：原「邮件 (SMTP)」组已迁出——改由上方独立的「邮件通道」卡管理
  const PARAM_GROUPS: { title: string; keys: string[] }[] = [
    { title: 'AI 能力', keys: ['ai_max_tokens', 'ai_default_provider'] },
    { title: '安全与会话', keys: ['session_timeout_minutes', 'audit_log_retention_days'] },
    { title: '日志', keys: ['log_level'] },
    { title: '运维', keys: ['grafana_url'] },
  ];

  // 配置加载后回填表单（数字项转 number 便于 InputNumber 展示；布尔/脱敏键按契约适配）
  useEffect(() => {
    if (!configs) return;
    const systemValues: Record<string, number | string | boolean> = {};
    const rateLimitValues: Record<string, number | string | boolean> = {};
    for (const config of editableConfigs) {
      const target = isRateLimitKey(config.key) ? rateLimitValues : systemValues;
      if (config.key === 'smtp_pass') {
        // 服务端脱敏回显（已配置/未配置）不回填输入框：留空 = 保持不变，避免把脱敏串当新密码提交
        target[config.key] = '';
        continue;
      }
      if (config.key === 'rate_limit_disabled') {
        target[config.key] = config.value === 'true';
        continue;
      }
      const raw = config.value;
      target[config.key] = raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    }
    configForm.setFieldsValue(systemValues);
    rateLimitForm.setFieldsValue(rateLimitValues);
    // editableConfigs 由 configs 派生，此处依赖 configs 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configForm, rateLimitForm, configs]);

  /** 计算发生变化的键：空字符串不提交（服务端拒绝空值；smtp_pass 留空 = 保持不变，避免误清空） */
  const diffChanged = (values: Record<string, number | string | boolean>) =>
    Object.entries(values).filter(([key, value]) => {
      const original = configs?.find((c) => c.key === key);
      if (original === undefined) return false;
      if (typeof value === 'string' && value.trim() === '') return false;
      return String(value) !== original.value;
    });

  /**
   * 保存一组配置。keys 缺省 = 全部字段；传入 keys 时仅校验/提交该组字段
   * （每卡独立保存按钮，与限流配置卡的交互口径一致）。
   */
  const saveConfigGroup = async (
    form: typeof configForm,
    setSaving: (saving: boolean) => void,
    keys?: string[]
  ) => {
    const values = keys ? await form.validateFields(keys) : await form.validateFields();
    const changed = diffChanged(values).filter(([key]) => !keys || keys.includes(key));
    if (changed.length === 0) {
      void message.info('内容未变化，无需保存');
      return;
    }
    setSaving(true);
    try {
      for (const [key, value] of changed) {
        await patchConfig(key, String(value));
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.configs() });
      void message.success(`已保存 ${changed.length} 项参数，变更记入审计日志`);
    } finally {
      setSaving(false);
    }
  };

  /** 按键分支渲染控件（参照 ai_default_provider 的 Select 分支模式） */
  const renderConfigControl = (key: string) => {
    if (key === 'ai_default_provider') {
      return <Select style={{ maxWidth: 260 }} options={AI_PROVIDER_OPTIONS} />;
    }
    if (key === 'log_level') {
      return <Select style={{ maxWidth: 260 }} options={LOG_LEVEL_OPTIONS} />;
    }
    if (key === 'menu_overrides') {
      return <Input.TextArea rows={2} style={{ maxWidth: 420 }} />;
    }
    if (key === 'rate_limit_disabled') {
      return <Switch checkedChildren="开启" unCheckedChildren="关闭" />;
    }
    if (key.startsWith('smtp_')) {
      if (key === 'smtp_pass') {
        // 密码脱敏：输入框恒为空起填，留空提交时跳过该键（服务端写空会被 400 拒绝）
        return (
          <Input.Password
            style={{ maxWidth: 260 }}
            placeholder="留空保持不变"
            autoComplete="new-password"
          />
        );
      }
      return <Input style={{ maxWidth: 260 }} />;
    }
    return <InputNumber style={{ width: 260 }} min={1} precision={0} />;
  };

  // AN-09：暂未接入的配置项（consumer 为空 = 改了不生效），用于「未接入」角标与顶部汇总
  const unconsumedCount = editableConfigs.filter((c) => !c.consumer).length;

  const renderConfigItem = (config: SystemConfig) => (
    <Form.Item
      key={config.key}
      name={config.key}
      label={
        <span>
          {config.name}
          {config.consumer ? (
            // AN-09：有消费方的键，鼠标悬停可看消费方文件
            <Tooltip title={`消费方：${config.consumer}`}>
              <QuestionCircleOutlined
                style={{ marginLeft: 4, color: 'var(--text-3)', fontSize: 12 }}
              />
            </Tooltip>
          ) : (
            // AN-09：无消费方的键打「未接入」角标——改了不生效，运营可分辨
            <Tag color="red" style={{ marginLeft: 6, marginInlineEnd: 0 }}>
              未接入
            </Tag>
          )}
        </span>
      }
      extra={
        config.key === 'smtp_pass'
          ? `${config.description ?? ''}（当前：${config.value}）`
          : config.description
      }
      rules={configRules(config.key)}
      valuePropName={config.key === 'rate_limit_disabled' ? 'checked' : undefined}
      className={styles.paramItem}
    >
      {renderConfigControl(config.key)}
    </Form.Item>
  );

  return (
    <>
      <PageHeader title="系统设置" description="所有修改实时生效并写入审计日志" />

      <div className={styles.stack}>
        {/* 功能开关 */}
        <Card title="功能开关" extra={<span className={styles.cardSub}>影响全部客户端</span>}>
          <div className={styles.cardSub} style={{ marginBottom: 14, lineHeight: 1.7 }}>
            开关持久化保存于数据库并写入审计日志；服务端约 5 秒内强制生效（重启不丢失），并通过
            WebSocket 向全部在线客户端广播，客户端也可经 /api/app/feature-flags
            拉取；未适配的客户端由服务端兜底拦截。 每个开关的生效范围见条目右侧说明。
          </div>
          {(flags ?? []).map((flag) => {
            const meta = FLAG_META[flag.key];
            return (
              <div className={styles.flagRow} key={flag.key}>
                <div className={styles.flagInfo}>
                  <b className={styles.flagName}>
                    {flag.name}
                    {meta ? (
                      <Tooltip
                        title={
                          <div style={{ lineHeight: 1.7 }}>
                            <div>
                              <b>生效范围：</b>
                              {meta.scope}
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <b>生效方式：</b>
                              {meta.priority}
                            </div>
                          </div>
                        }
                      >
                        <QuestionCircleOutlined
                          style={{ marginLeft: 6, color: 'var(--text-3)', fontSize: 12 }}
                        />
                      </Tooltip>
                    ) : null}
                  </b>
                  <span className={styles.flagDesc}>{flag.description}</span>
                </div>
                <Switch
                  checked={flag.enabled}
                  loading={flagMutation.isPending && flagMutation.variables?.key === flag.key}
                  onChange={(enabled) => flagMutation.mutate({ key: flag.key, enabled })}
                />
              </div>
            );
          })}
        </Card>

        {/* 维护模式 */}
        <Card title="维护模式" extra={<span className={styles.cardSub}>仅超级管理员可操作</span>}>
          <div className={styles.maintRow}>
            <Switch
              checked={maintenanceOn}
              disabled={!maintenanceConfig || maintenanceMutation.isPending || !canManageConfigs}
              onChange={() => setMaintenanceTarget(!maintenanceOn)}
            />
            <div className={styles.maintInfo}>
              <b className={styles.maintState}>
                当前：
                <span style={{ color: maintenanceOn ? 'var(--red)' : 'var(--green)' }}>
                  {maintenanceOn ? '维护中' : '正常运行'}
                </span>
              </b>
              <div className={styles.maintHint}>{MAINTENANCE_HINT}</div>
            </div>
            {maintenanceOn ? (
              <Button disabled={!canManageConfigs} onClick={() => setMaintenanceTarget(false)}>
                恢复运行
              </Button>
            ) : (
              <Button
                danger
                disabled={!canManageConfigs}
                onClick={() => setMaintenanceTarget(true)}
              >
                开启维护
              </Button>
            )}
          </div>
        </Card>

        {/* 限流配置（CO-11） */}
        <Card
          title="限流配置"
          extra={
            <span className={styles.cardSub}>
              运行时可调 · 约 5 秒内生效 · 关闭限流仅限开发环境
            </span>
          }
        >
          <Form form={rateLimitForm} requiredMark={false} labelWrap>
            {rateLimitConfigs.map(renderConfigItem)}
            {rateLimitConfigs.length === 0 ? (
              <div className={styles.maintHint}>配置加载中…</div>
            ) : null}
          </Form>
          <Tooltip title={canManageConfigs ? '' : '缺少权限'}>
            <span>
              <Button
                type="primary"
                loading={savingRateLimits}
                disabled={!canManageConfigs || rateLimitConfigs.length === 0}
                onClick={() => void saveConfigGroup(rateLimitForm, setSavingRateLimits)}
              >
                保存（记入审计）
              </Button>
            </span>
          </Tooltip>
        </Card>

        {/* 公告下发 */}
        <Card
          title="公告下发"
          extra={<span className={styles.cardSub}>经通知服务推送 · 支持按套餐定向</span>}
        >
          <Form
            form={announceForm}
            layout="vertical"
            requiredMark={false}
            initialValues={{ audience: 'all', displayMode: 'once' }}
            onFinish={(values) => announceMutation.mutate(values)}
          >
            <Form.Item
              name="title"
              label="公告标题"
              rules={[{ required: true, whitespace: true, message: '请输入公告标题' }]}
            >
              <Input maxLength={50} showCount placeholder="公告标题，例如：ClipSync v1.5 已发布" />
            </Form.Item>
            <Form.Item
              name="content"
              label="公告内容"
              rules={[{ required: true, whitespace: true, message: '请输入公告内容' }]}
            >
              <Input.TextArea rows={3} maxLength={500} showCount placeholder="公告内容…" />
            </Form.Item>
            <div className={styles.announceRow}>
              <Form.Item name="audience" style={{ marginBottom: 0 }}>
                <Select style={{ width: 170 }} options={AUDIENCE_OPTIONS} />
              </Form.Item>
              <Form.Item name="displayMode" style={{ marginBottom: 0 }}>
                <Select style={{ width: 150 }} options={DISPLAY_OPTIONS} />
              </Form.Item>
              <Tooltip title={canSendAnnouncement ? '' : '缺少权限'}>
                <span>
                  <Button
                    type="primary"
                    htmlType="submit"
                    style={{ marginLeft: 'auto' }}
                    loading={announceMutation.isPending}
                    disabled={!canSendAnnouncement}
                  >
                    发送公告
                  </Button>
                </span>
              </Tooltip>
            </div>
          </Form>
          <div className={styles.recentBlock}>
            <div className={styles.recentTitle}>最近发送</div>
            {(announcements ?? []).slice(0, 3).map((item) => (
              <div className={styles.recentLine} key={item.id}>
                {item.sentAt.slice(5, 10)}「{item.title}」→ {AUDIENCE_LABEL[item.audience]} · 受众{' '}
                {(item.deliveredCount ?? 0).toLocaleString('zh-CN')} · 触达{' '}
                {(item.reachedCount ?? 0).toLocaleString('zh-CN')} · 已读{' '}
                {(item.readCount ?? 0).toLocaleString('zh-CN')} · 点击{' '}
                {(item.clickedCount ?? 0).toLocaleString('zh-CN')}
              </div>
            ))}
            {(announcements ?? []).length === 0 ? (
              <div className={styles.recentLine}>暂无发送记录</div>
            ) : null}
          </div>
        </Card>

        {/* AN-16：邮件通道管理（多 SMTP 账号 + 按用途路由 + priority failover，
            替代原「邮件 (SMTP)」系统参数卡；独立于 configForm，不影响 AF-01 修复的参数卡结构） */}
        <Card
          title="邮件通道"
          extra={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={styles.cardSub}>按用途路由 · 优先级 failover</span>
              <Tooltip title={canManageChannels ? '' : '缺少权限'}>
                <span>
                  <Button
                    type="primary"
                    size="small"
                    disabled={!canManageChannels}
                    onClick={openChannelModal}
                  >
                    新增通道
                  </Button>
                </span>
              </Tooltip>
            </div>
          }
        >
          <div className={styles.cardSub} style={{ marginBottom: 14, lineHeight: 1.7 }}>
            发送时按用途选择启用通道中 priority 最小者，失败自动按 priority 顺延降级（最多 2
            次）；事务与营销通道互不混用发件人，避免信誉互相拖累。原「邮件
            (SMTP)」系统参数已自动导入为默认事务通道，smtp_* 键仅作只读兼容。
          </div>
          {(channels ?? []).map((channel) => (
            <div className={styles.flagRow} key={channel.id}>
              <div className={styles.flagInfo}>
                <b className={styles.flagName}>
                  {channel.name}
                  <Tag
                    color={channel.purpose === 'transactional' ? 'blue' : 'purple'}
                    style={{ marginLeft: 8, marginInlineEnd: 0 }}
                  >
                    {CHANNEL_PURPOSE_LABEL[channel.purpose]}
                  </Tag>
                  {channel.secure ? (
                    <Tag style={{ marginInlineEnd: 0 }}>SSL</Tag>
                  ) : null}
                  {!channel.has_password ? (
                    <Tooltip title="缺少密码/授权码，发送将走控制台兜底（测试接口返回 4090）">
                      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                        凭据不全
                      </Tag>
                    </Tooltip>
                  ) : null}
                </b>
                <span className={styles.flagDesc}>
                  {channel.host}:{channel.port} · {channel.username || '未配置用户名'} · 发件人{' '}
                  {channel.from_addr || '未配置'} · 优先级 {channel.priority}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Switch
                  checked={channel.enabled}
                  loading={
                    toggleChannelMutation.isPending &&
                    toggleChannelMutation.variables?.channel.id === channel.id
                  }
                  disabled={!canManageChannels}
                  onChange={(enabled) => toggleChannelMutation.mutate({ channel, enabled })}
                />
                <Tooltip title="设为该用途默认通道（priority 调至最小，路由时最先选中）">
                  <Button
                    size="small"
                    disabled={!canManageChannels}
                    loading={
                      setDefaultChannelMutation.isPending &&
                      setDefaultChannelMutation.variables?.id === channel.id
                    }
                    onClick={() => setDefaultChannelMutation.mutate(channel)}
                  >
                    设为默认
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  disabled={!canManageChannels}
                  onClick={() => openEditChannelModal(channel)}
                >
                  编辑
                </Button>
                <Button
                  size="small"
                  disabled={!canManageChannels}
                  onClick={() => openChannelTestModal(channel)}
                >
                  发送测试
                </Button>
                <Button
                  size="small"
                  danger
                  disabled={!canManageChannels}
                  onClick={() => setDeleteChannelTarget(channel)}
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
          {(channels ?? []).length === 0 ? (
            <div className={styles.maintHint}>
              暂无邮件通道（发送将走控制台兜底）——请新增，或确认后端已执行 059 迁移以导入原 SMTP
              配置
            </div>
          ) : null}
        </Card>

        {/* 系统参数（按用途分组为多卡，每卡独立保存，与限流配置卡交互口径一致）
            ⚠️ AF-01：所有参数卡必须包在同一个 <Form form={configForm}> 内——
            Form.Item 脱离 FormContext 会导致回填失效、validateFields 取不到值、
            保存恒提示「内容未变化」。新增参数卡时不要把这个 Form 拆开。 */}
        <Form form={configForm} requiredMark={false} labelWrap className={styles.paramForm}>
          {/* AN-09：未接入配置项汇总（consumer 为空的键改了不生效，以条目旁角标为准） */}
          {unconsumedCount > 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 12, lineHeight: 1.8 }}>
              <Tag color="red">未接入 {unconsumedCount} 项</Tag>
              {unconsumedCount} 项配置暂未接入（改了不生效），以未接入角标为准
            </div>
          ) : null}
          {PARAM_GROUPS.map((group) => {
            const items = group.keys
              .map((key) => systemConfigs.find((c) => c.key === key))
              .filter((c): c is SystemConfig => Boolean(c));
            if (items.length === 0) return null;
            return (
              <Card
                key={group.title}
                title={group.title}
                extra={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* CO-30：仅 SMTP 卡提供测试邮件入口（未配置/失败提示由拦截器统一 toast） */}
                    {group.keys.includes('smtp_host') ? (
                      <Tooltip title={canManageConfigs ? '' : '缺少权限'}>
                        <span>
                          <Button
                            size="small"
                            disabled={!canManageConfigs}
                            onClick={openTestEmailModal}
                          >
                            发送测试邮件
                          </Button>
                        </span>
                      </Tooltip>
                    ) : null}
                    <Tooltip title={canManageConfigs ? '' : '缺少权限'}>
                      <span>
                        <Button
                          type="primary"
                          size="small"
                          loading={savingGroup === group.title}
                          disabled={!canManageConfigs}
                          onClick={() =>
                            void saveConfigGroup(
                              configForm,
                              (s) => setSavingGroup(s ? group.title : null),
                              group.keys
                            )
                          }
                        >
                          保存（记入审计）
                        </Button>
                      </span>
                    </Tooltip>
                  </div>
                }
              >
                {items.map(renderConfigItem)}
              </Card>
            );
          })}
          {/* 第三方登录预留口（用户要求防遗忘）：仅占位声明，不做任何配置项——
              OAuth 功能立项前配置不会生效，避免出现"填了没反应"的空头支票。
              功能立项后本卡替换为 GitHub/微信/Apple 的 client_id/密钥/回调域配置。 */}
          {/* AN-16：smtp_* 已移出表单，改用原始 configs 判断（保持该占位卡原样显示） */}
          {configs?.some((c) => c.key === 'smtp_host') ? (
            <Card title="第三方登录" extra={<Tag>规划中 · 未实现</Tag>}>
              <div style={{ color: 'var(--text-3)', fontSize: 12, lineHeight: 1.9 }}>
                预留位：GitHub / 微信 / Apple 等第三方 OAuth 登录的接入配置（client_id / 密钥 /
                回调域） 将在功能立项实现后在此处提供。
                <br />
                当前尚未对接任何第三方登录——登录页对应按钮为「敬请期待」占位，此卡仅作功能备忘。
              </div>
            </Card>
          ) : null}
          {/* 未归组键兜底（目录新增键忘记归类时不至于消失） */}
          {(() => {
            const grouped = new Set(PARAM_GROUPS.flatMap((g) => g.keys));
            const rest = systemConfigs.filter((c) => !grouped.has(c.key));
            if (rest.length === 0) return null;
            return <Card title="其它">{rest.map(renderConfigItem)}</Card>;
          })()}
        </Form>
      </div>

      <ConfirmReasonModal
        open={maintenanceTarget !== null}
        title={maintenanceTarget ? '开启维护模式' : '关闭维护模式'}
        description={
          maintenanceTarget
            ? '开启后剪贴板 / 同步 / 媒体 / 上传接口将返回维护提示（登录与管理台不受影响），客户端即时收到 WS 推送并显示维护横幅。请确认已在公告中说明预计恢复时间。'
            : '将恢复全部客户端同步并撤下维护横幅。'
        }
        reasonLabel="操作原因（必填，写入审计日志）"
        confirmText={maintenanceTarget ? '确认开启' : '确认恢复'}
        confirmLoading={maintenanceMutation.isPending}
        onCancel={() => setMaintenanceTarget(null)}
        onConfirm={(reason) =>
          maintenanceMutation.mutateAsync({
            value: maintenanceTarget ? 'on' : 'off',
            reason,
          })
        }
      />

      {/* AN-16：新增/编辑邮件通道（password 编辑时留空 = 保持不变，与 smtp_pass 交互口径一致） */}
      <Modal
        title={editingChannel ? `编辑通道：${editingChannel.name}` : '新增邮件通道'}
        open={channelModalOpen}
        okText={editingChannel ? '保存' : '创建'}
        cancelText="取消"
        confirmLoading={saveChannelMutation.isPending}
        onCancel={() => setChannelModalOpen(false)}
        onOk={() => channelForm.submit()}
      >
        <Form
          form={channelForm}
          layout="vertical"
          requiredMark={false}
          initialValues={{
            purpose: 'transactional',
            provider: 'smtp',
            host: '',
            port: 587,
            secure: false,
            username: '',
            password: '',
            from_addr: '',
            enabled: true,
            priority: 10,
          }}
          onFinish={(values) => saveChannelMutation.mutate({ ...values, id: editingChannel?.id })}
        >
          <Form.Item
            name="name"
            label="通道名称"
            rules={[{ required: true, whitespace: true, message: '请输入通道名称' }]}
          >
            <Input maxLength={100} placeholder="如：QQ 事务通道 / 阿里云营销通道" />
          </Form.Item>
          <Form.Item
            name="purpose"
            label="用途"
            rules={[{ required: true, message: '请选择用途' }]}
          >
            <Select options={CHANNEL_PURPOSE_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="provider"
            label="服务商"
            tooltip="本期仅实现 SMTP；aliyun_dm / sendgrid 为预留枚举"
            rules={[{ required: true, message: '请选择服务商' }]}
          >
            <Select options={[{ value: 'smtp', label: 'SMTP' }]} />
          </Form.Item>
          <Form.Item
            name="host"
            label="SMTP 服务器地址"
            rules={[{ required: true, whitespace: true, message: '请输入服务器地址' }]}
          >
            <Input placeholder="如 smtp.qq.com" />
          </Form.Item>
          <Form.Item name="port" label="端口" rules={[{ required: true, message: '请输入端口' }]}>
            <InputNumber min={1} max={65535} precision={0} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="secure" label="SSL 直连" valuePropName="checked">
            <Switch checkedChildren="SSL(465)" unCheckedChildren="STARTTLS(587)" />
          </Form.Item>
          <Form.Item name="username" label="用户名">
            <Input placeholder="邮箱账号或 API 用户" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码 / 授权码"
            extra={
              editingChannel
                ? '加密存储，仅显示是否已配置；留空 = 保持不变'
                : '加密存储，任何界面不回传明文'
            }
          >
            <Input.Password
              placeholder={editingChannel ? '留空保持不变' : '授权码 / 密码'}
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item
            name="from_addr"
            label="发件人地址"
            rules={[{ type: 'email', message: '请输入合法的邮箱地址' }]}
          >
            <Input placeholder="如 no-reply@example.com（缺省用 username）" />
          </Form.Item>
          <Form.Item name="priority" label="优先级" tooltip="数值越小越优先；发送失败按优先级顺延降级（最多 2 次）">
            <InputNumber min={0} precision={0} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>

      {/* AN-16：通道测试邮件（真实发送一封；指定通道，不按用途路由不降级，复用 CO-30 弹窗交互） */}
      <Modal
        title={testChannel ? `发送测试邮件（${testChannel.name}）` : '发送测试邮件'}
        open={testChannel !== null}
        okText="发送"
        cancelText="取消"
        confirmLoading={channelTestMutation.isPending}
        onCancel={() => setTestChannel(null)}
        onOk={() => testEmailForm.submit()}
      >
        <Form
          form={testEmailForm}
          layout="vertical"
          onFinish={(values) => {
            if (testChannel) {
              channelTestMutation.mutate({ id: testChannel.id, to: values.to?.trim() || undefined });
            }
          }}
        >
          <Form.Item
            name="to"
            label="收件邮箱"
            rules={[{ type: 'email', message: '请输入合法的邮箱地址' }]}
          >
            <Input placeholder="留空则使用通道用户名" autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>

      {/* AN-16：删除通道确认（原因必填，写入审计日志；与维护模式同一交互口径） */}
      <ConfirmReasonModal
        open={deleteChannelTarget !== null}
        title={`删除邮件通道：${deleteChannelTarget?.name ?? ''}`}
        description="删除后该用途的发送自动顺延到剩余通道；若该用途已无可用通道，将回退原 SMTP 配置或控制台兜底。操作写入审计日志。"
        reasonLabel="操作原因（必填，写入审计日志）"
        confirmText="确认删除"
        confirmLoading={deleteChannelMutation.isPending}
        onCancel={() => setDeleteChannelTarget(null)}
        onConfirm={(reason) => {
          if (deleteChannelTarget) {
            deleteChannelMutation.mutate({ channel: deleteChannelTarget, reason });
          }
        }}
      />
    </>
  );
}
