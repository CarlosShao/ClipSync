import { LockOutlined, SafetyCertificateOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { Button, Form, Input, App as AntdApp } from 'antd';
import { Navigate, useNavigate } from 'react-router';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { login } from '@/api/auth';
import { useAuthStore } from '@/stores/authStore';
import styles from './login.module.css';

interface LoginFormValues {
  account: string;
  password: string;
  totp: string;
}

const DEMO_ACCOUNT = 'carlos@clipstream.work';

/**
 * 登录页（对照草图 B）：
 * 左侧深紫渐变品牌区（端到端加密安全文案）+ 右侧表单（账号 / 密码 / 6 位 TOTP）。
 * 提交走 POST /api/auth/login（MSW），成功写入 authStore 并跳 /dashboard。
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { accessToken, setAuth } = useAuthStore();
  const [submitting, setSubmitting] = useState(false);

  const loginMutation = useMutation({
    mutationFn: (values: LoginFormValues) => login(values),
    onSuccess: (data) => {
      setAuth(data);
      void message.success(`欢迎回来，${data.nickname}`);
      void navigate('/dashboard', { replace: true });
    },
    // 失败提示由 client.ts 拦截器统一 toast
    onSettled: () => setSubmitting(false),
  });

  if (accessToken) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleFinish = (values: LoginFormValues) => {
    setSubmitting(true);
    loginMutation.mutate(values);
  };

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
          <div className={styles.hint}>请使用管理员账号登录，登录后将验证两步验证码</div>

          <Form<LoginFormValues>
            layout="vertical"
            requiredMark={false}
            initialValues={{ account: DEMO_ACCOUNT }}
            onFinish={handleFinish}
          >
            <Form.Item
              label={<span className={styles.fieldLabel}>账号</span>}
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
                label={<span className={styles.fieldLabel}>两步验证码（6 位动态码）</span>}
                name="totp"
                rules={[
                  { required: true, message: '请输入 6 位动态码' },
                  { pattern: /^\d{6}$/, message: '动态码为 6 位数字' },
                ]}
              >
                <Input
                  className={styles.otpInput}
                  maxLength={6}
                  inputMode="numeric"
                  placeholder="——————"
                />
              </Form.Item>
              <div className={styles.otpBtnCell}>
                <Button className={styles.otpBtn} icon={<ClockCircleOutlined />} title="剩余 24 秒" />
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

          <div className={styles.foot}>
            <span>忘记密码？</span>
            <span>登录即代表同意《运营安全规范》</span>
          </div>
        </div>
      </section>
    </div>
  );
}
