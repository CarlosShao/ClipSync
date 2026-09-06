import { LockOutlined, SafetyCertificateOutlined, ClockCircleOutlined, MobileOutlined } from '@ant-design/icons';
import { Button, Form, Input, App as AntdApp, Segmented } from 'antd';
import { Navigate, useNavigate } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { loginByCode, loginByPassword, sendLoginCode } from '@/api/auth';
import { useAuthStore } from '@/stores/authStore';
import type { LoginResp } from '@/api/types';
import styles from './login.module.css';

type LoginMode = 'password' | 'code';

interface PasswordFormValues {
  account: string;
  password: string;
  totp?: string;
}

interface CodeFormValues {
  phone: string;
  code: string;
}

/**
 * 登录页（对照草图 B）：
 * 左侧深紫渐变品牌区（端到端加密安全文案）+ 右侧表单。
 * 双登录方式（T-A7 对齐真实后端）：
 * - 密码登录：POST /api/auth/login（账号=邮箱或手机号；TOTP 可选，2FA 强制校验由后端 two-factor 链路承担）
 * - 验证码登录：POST /api/auth/send-code + /api/auth/verify-code（dev 后端为 MVP 固定码）
 * 登录成功后调 GET /api/admin/whoami 取角色权限，写入 authStore 并跳 /dashboard。
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { accessToken, setAuth } = useAuthStore();
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<LoginMode>('code');
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const onSuccess = (data: LoginResp) => {
    setAuth(data);
    void message.success(`欢迎回来，${data.nickname}`);
    void navigate('/dashboard', { replace: true });
  };

  const passwordMutation = useMutation({
    mutationFn: (values: PasswordFormValues) => loginByPassword(values),
    onSuccess,
    // 失败提示由 client.ts 拦截器统一 toast
    onSettled: () => setSubmitting(false),
  });

  const codeMutation = useMutation({
    mutationFn: (values: CodeFormValues) => loginByCode(values.phone, values.code),
    onSuccess,
    onSettled: () => setSubmitting(false),
  });

  const sendCodeMutation = useMutation({
    mutationFn: (phone: string) => sendLoginCode(phone),
    onSuccess: () => {
      void message.success('验证码已发送');
      setCountdown(60);
      timerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1 && timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          return Math.max(0, c - 1);
        });
      }, 1000);
    },
  });

  if (accessToken) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className={styles.wrap}>
      <section className={styles.hero}>
        <div className={styles.orbTop} />
        <div className={styles.orbBottom} />
        <div className={styles.chip}>
          <SafetyCertificateOutlined style={{ color: '#c3b6ff' }} />
          端到端加密 · 管理数据同样受保护
        </div>
        <h1 className={styles.heroTitle}>
          ClipSync 运营管理台
          <br />
          用户 · 支付 · 审计 · 权限，一处尽览
        </h1>
        <p className={styles.heroDesc}>
          为 ClipSync 团队打造的统一后台：看板洞察、订单退款、账户治理与平台配置，全部操作留痕可溯。
        </p>
      </section>

      <section className={styles.panel}>
        <div className={styles.card}>
          <div className={styles.brand}>
            <div className={styles.logoMark}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <rect x="9" y="2" width="6" height="4" rx="1" />
                <path d="M9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
                <path d="m9 13 2 2 4-4" />
              </svg>
            </div>
            <b>ClipSync Admin</b>
          </div>
          <h2 className={styles.cardTitle}>欢迎回来</h2>
          <div className={styles.hint}>仅限授权运营人员访问，所有操作将被审计记录</div>

          <Segmented
            block
            value={mode}
            onChange={(v) => setMode(v as LoginMode)}
            options={[
              { label: '验证码登录', value: 'code' },
              { label: '密码登录', value: 'password' },
            ]}
            style={{ marginBottom: 18 }}
          />

          {mode === 'password' ? (
            <Form<PasswordFormValues>
              layout="vertical"
              requiredMark={false}
              onFinish={(values) => {
                setSubmitting(true);
                passwordMutation.mutate(values);
              }}
            >
              <Form.Item
                label={<span className={styles.fieldLabel}>账号（邮箱或手机号）</span>}
                name="account"
                rules={[{ required: true, message: '请输入管理员账号' }]}
              >
                <Input placeholder="carlos@clipstream.work" autoComplete="username" />
              </Form.Item>
              <Form.Item
                label={<span className={styles.fieldLabel}>密码</span>}
                name="password"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password placeholder="请输入管理员密码" autoComplete="current-password" />
              </Form.Item>
              <div className={styles.otpRow}>
                <Form.Item
                  className={styles.otpField}
                  label={<span className={styles.fieldLabel}>两步验证码（未开启 2FA 可留空）</span>}
                  name="totp"
                  rules={[{ pattern: /^\d{6}$/, message: '动态码为 6 位数字' }]}
                >
                  <Input
                    className={styles.otpInput}
                    maxLength={6}
                    inputMode="numeric"
                    placeholder="——————"
                  />
                </Form.Item>
                <div className={styles.otpBtnCell}>
                  <Button className={styles.otpBtn} icon={<ClockCircleOutlined />} title="30 秒刷新" />
                </div>
              </div>
              <Button
                className={styles.submit}
                type="primary"
                htmlType="submit"
                loading={submitting}
                icon={<LockOutlined />}
              >
                登 录
              </Button>
            </Form>
          ) : (
            <Form<CodeFormValues>
              layout="vertical"
              requiredMark={false}
              onFinish={(values) => {
                setSubmitting(true);
                codeMutation.mutate(values);
              }}
            >
              <Form.Item
                label={<span className={styles.fieldLabel}>手机号</span>}
                name="phone"
                rules={[
                  { required: true, message: '请输入手机号' },
                  { pattern: /^\d{11}$/, message: '手机号为 11 位数字' },
                ]}
              >
                <Input
                  id="login-phone-input"
                  placeholder="管理员绑定的手机号"
                  autoComplete="tel"
                  maxLength={11}
                />
              </Form.Item>
              <div className={styles.otpRow}>
                <Form.Item
                  className={styles.otpField}
                  label={<span className={styles.fieldLabel}>短信验证码</span>}
                  name="code"
                  rules={[
                    { required: true, message: '请输入验证码' },
                    { pattern: /^\d{4,8}$/, message: '验证码为 4-8 位数字' },
                  ]}
                >
                  <Input
                    className={styles.otpInput}
                    maxLength={8}
                    inputMode="numeric"
                    placeholder="——————"
                  />
                </Form.Item>
                <div className={styles.otpBtnCell}>
                  <Button
                    className={styles.otpBtn}
                    icon={<MobileOutlined />}
                    disabled={countdown > 0}
                    onClick={() => {
                      const phone = (document.getElementById('login-phone-input') as HTMLInputElement | null)?.value ?? '';
                      if (!/^\d{11}$/.test(phone)) {
                        void message.warning('请先填写 11 位手机号');
                        return;
                      }
                      sendCodeMutation.mutate(phone);
                    }}
                  >
                    {countdown > 0 ? `${countdown}s` : '发送验证码'}
                  </Button>
                </div>
              </div>
              <Button
                className={styles.submit}
                type="primary"
                htmlType="submit"
                loading={submitting}
                icon={<LockOutlined />}
              >
                登 录
              </Button>
            </Form>
          )}

          <div className={styles.foot}>
            <span>忘记密码？</span>
            <span>登录即代表同意《运营安全规范》</span>
          </div>
        </div>
      </section>
    </div>
  );
}
