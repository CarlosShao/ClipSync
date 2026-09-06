import { App as AntdApp, Button, Card, Form, Input, InputNumber, Select, Switch, Tooltip } from 'antd';
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
import { queryKeys } from '@/queryKeys';
import type { Announcement, FeatureFlag, SendAnnouncementPayload } from '@/api/types';
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

const MAINTENANCE_HINT = '开启后客户端将暂停剪贴板同步并展示维护公告，期间同步请求返回维护提示';

/**
 * 功能开关的生效范围与优先级说明（与后端 utils/featureFlags.js 的生效链路一一对应）。
 * 生效链路：管理台写库（持久化）→ 服务端 requireFlag 强制拦截（≤5s）→ WS 全端广播 →
 * 客户端拉取 GET /api/app/feature-flags 或收 WS 推送即时感知；未适配客户端由服务端兜底 403。
 */
const FLAG_META: Record<string, { scope: string; priority: string }> = {
  enable_subscription: {
    scope: '全部非管理员用户的配额与套餐权益：关闭期间一律按 Free 配额校验；已有订单与订阅记录不受影响，重新开启即恢复',
    priority: '服务端 ≤5s 强制生效（重启不丢失）；客户端在下次请求时被按 Free 校验',
  },
  enable_ai_agent: {
    scope: '全部 AI 能力接口：AI 对话、长程记忆、AI 设置、供应商代理；关闭后服务端直接拒绝（403）',
    priority: '服务端 ≤5s 强制生效；适配后的客户端经 WS 推送即时灰显 AI 入口，未适配客户端在下次请求时收到禁用提示',
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
    scope: '仅影响新注册：开启后新用户进入待审核（登录被拦截），审批入口在「用户管理」页；存量用户不受影响',
    priority: '服务端实时强制；审批通过后用户立即可登录',
  },
};

/** 设置页查询共用 staleTime：避免窗口聚焦自动重取时打断表单编辑 */
const SETTINGS_STALE_TIME = 5 * 60_000;

interface AnnouncementFormValues {
  title: string;
  content: string;
  audience: Announcement['audience'];
  displayMode: Announcement['displayMode'];
}

/** 系统设置（对照草图 B，四卡纵排）：功能开关 / 维护模式 / 公告下发 / 系统参数 */
export default function SettingsPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [maintenanceTarget, setMaintenanceTarget] = useState<boolean | null>(null);
  const [savingConfigs, setSavingConfigs] = useState(false);
  const [announceForm] = Form.useForm<AnnouncementFormValues>();
  const [configForm] = Form.useForm<Record<string, number | string>>();

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

  // 功能开关：乐观更新 + 失败回滚
  const flagMutation = useMutation({
    mutationFn: (payload: { key: string; enabled: boolean }) => patchFlag(payload.key, payload.enabled),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.flags() });
      const previous = queryClient.getQueryData<FeatureFlag[]>(queryKeys.flags());
      queryClient.setQueryData<FeatureFlag[]>(queryKeys.flags(), (old) =>
        old?.map((f) => (f.key === payload.key ? { ...f, enabled: payload.enabled } : f)),
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

  const maintenanceConfig = configs?.find((c) => c.key === 'maintenance_mode');
  const maintenanceOn = maintenanceConfig?.value === 'on';
  const editableConfigs = (configs ?? []).filter((c) => c.key !== 'maintenance_mode');

  // 配置加载后回填表单（数字项转 number 便于 InputNumber 展示）
  useEffect(() => {
    if (!configs) return;
    const values: Record<string, number | string> = {};
    for (const config of editableConfigs) {
      values[config.key] = Number.isFinite(Number(config.value)) ? Number(config.value) : config.value;
    }
    configForm.setFieldsValue(values);
    // editableConfigs 由 configs 派生，此处依赖 configs 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configForm, configs]);

  const saveConfigs = async () => {
    const values = await configForm.validateFields();
    const changed = Object.entries(values).filter(([key, value]) => {
      const original = configs?.find((c) => c.key === key);
      return original !== undefined && String(value) !== original.value;
    });
    if (changed.length === 0) {
      void message.info('内容未变化，无需保存');
      return;
    }
    setSavingConfigs(true);
    try {
      for (const [key, value] of changed) {
        await patchConfig(key, String(value));
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.configs() });
      void message.success(`已保存 ${changed.length} 项参数，变更记入审计日志`);
    } finally {
      setSavingConfigs(false);
    }
  };

  return (
    <>
      <PageHeader title="系统设置" description="所有修改实时生效并写入审计日志" />

      <div className={styles.stack}>
        {/* 功能开关 */}
        <Card
          title="功能开关"
          extra={<span className={styles.cardSub}>影响全部客户端</span>}
        >
          <div className={styles.cardSub} style={{ marginBottom: 14, lineHeight: 1.7 }}>
            开关持久化保存于数据库并写入审计日志；服务端约 5 秒内强制生效（重启不丢失），并通过
            WebSocket 向全部在线客户端广播，客户端也可经 /api/app/feature-flags 拉取；未适配的客户端由服务端兜底拦截。
            每个开关的生效范围见条目右侧说明。
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
        <Card
          title="维护模式"
          extra={<span className={styles.cardSub}>仅超级管理员可操作</span>}
        >
          <div className={styles.maintRow}>
            <Switch
              checked={maintenanceOn}
              disabled={!maintenanceConfig || maintenanceMutation.isPending}
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
              <Button onClick={() => setMaintenanceTarget(false)}>恢复运行</Button>
            ) : (
              <Button danger onClick={() => setMaintenanceTarget(true)}>
                开启维护
              </Button>
            )}
          </div>
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
              <Button
                type="primary"
                htmlType="submit"
                style={{ marginLeft: 'auto' }}
                loading={announceMutation.isPending}
              >
                发送公告
              </Button>
            </div>
          </Form>
          <div className={styles.recentBlock}>
            <div className={styles.recentTitle}>最近发送</div>
            {(announcements ?? []).slice(0, 3).map((item) => (
              <div className={styles.recentLine} key={item.id}>
                {item.sentAt.slice(5, 10)}「{item.title}」→ {AUDIENCE_LABEL[item.audience]} · 送达{' '}
                {(item.deliveredCount ?? 0).toLocaleString('zh-CN')} · 点击{' '}
                {(item.clickedCount ?? 0).toLocaleString('zh-CN')}
              </div>
            ))}
            {(announcements ?? []).length === 0 ? (
              <div className={styles.recentLine}>暂无发送记录</div>
            ) : null}
          </div>
        </Card>

        {/* 系统参数 */}
        <Card
          title="系统参数"
          extra={
            <span className={styles.cardSub}>保存后立即生效 · 变更记入审计日志</span>
          }
        >
          <Form form={configForm} requiredMark={false} labelWrap>
            {editableConfigs.map((config) => (
              <Form.Item
                key={config.key}
                name={config.key}
                label={config.name}
                extra={config.description}
                rules={[{ required: true, message: '取值不能为空' }]}
                className={styles.paramItem}
              >
                {config.key === 'ai_default_provider' ? (
                  <Select style={{ maxWidth: 260 }} options={AI_PROVIDER_OPTIONS} />
                ) : (
                  <InputNumber style={{ width: 260 }} min={1} precision={0} />
                )}
              </Form.Item>
            ))}
            {editableConfigs.length === 0 ? (
              <div className={styles.maintHint}>配置加载中…</div>
            ) : null}
          </Form>
          <Button type="primary" loading={savingConfigs} onClick={() => void saveConfigs()}>
            保存（记入审计）
          </Button>
        </Card>
      </div>

      <ConfirmReasonModal
        open={maintenanceTarget !== null}
        title={maintenanceTarget ? '开启维护模式' : '关闭维护模式'}
        description={
          maintenanceTarget
            ? '开启后全部客户端将暂停剪贴板同步，并展示维护公告。请确认已在公告中说明预计恢复时间。'
            : '将恢复全部客户端同步并撤下维护公告。'
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
    </>
  );
}
