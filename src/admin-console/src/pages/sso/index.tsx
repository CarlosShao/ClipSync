import { SafetyCertificateOutlined } from '@ant-design/icons';
import { Button, Result, Spin, App as AntdApp } from 'antd';
import { useNavigate, useSearchParams } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { ssoExchange } from '@/api/auth';
import { useAuthStore } from '@/stores/authStore';
import type { LoginResp } from '@/api/types';
import styles from '@/styles/login-brand.module.css';

/**
 * SSO 凭据兑换页（RB-SSO）：桌面端超管点击「管理控制台」→ 后端签发一次性 code（60s）→
 * 浏览器打开 /sso?code=xxx → 本页调 POST /auth/sso-exchange 兑换会话 → 写入 authStore → 跳 /dashboard。
 *
 * code 为一次性凭据（Redis GETDEL 原子消费），因此本页对同一 code 只发起一次兑换：
 * - React StrictMode 下 effect 会执行两次，用 sessionStorage 记账防止第二次兑换把已消费的 code 再打一遍；
 * - 兑换失败展示原因并提供「返回登录页」，不自动重试（code 已失效，重试必然失败）。
 */
export default function SsoPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { setAuth } = useAuthStore();
  const [searchParams] = useSearchParams();
  const code = searchParams.get('code')?.trim() ?? '';

  const [state, setState] = useState<'exchanging' | 'error'>(code ? 'exchanging' : 'error');
  const [errorMsg, setErrorMsg] = useState(code ? '' : '链接缺少 SSO 凭据（code），请回桌面端重新打开管理控制台');
  const startedRef = useRef(false);

  useEffect(() => {
    if (!code || startedRef.current) return;
    // StrictMode 双执行防护：同一 code 全局只兑一次（code 一次性，重放必 403）
    const mark = `sso-exchanged:${code}`;
    if (sessionStorage.getItem(mark)) {
      setState('error');
      setErrorMsg('该 SSO 凭据已被使用或已过期，请在桌面端重新打开管理控制台');
      return;
    }
    sessionStorage.setItem(mark, '1');
    startedRef.current = true;

    void (async () => {
      try {
        const session: LoginResp = await ssoExchange(code);
        setAuth(session);
        void message.success(`欢迎回来，${session.nickname}`);
        void navigate('/dashboard', { replace: true });
      } catch (err) {
        // 失败原因 client.ts 拦截器已 toast；此处落页面态给出出路
        setState('error');
        setErrorMsg(
          err instanceof Error && err.message
            ? `${err.message}。请在桌面端重新打开管理控制台重试。`
            : 'SSO 凭据无效或已过期，请在桌面端重新打开管理控制台重试。',
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <div className={styles.wrap}>
      <section className={styles.hero}>
        <div className={styles.orbTop} />
        <div className={styles.orbBottom} />
        <div className={styles.chip}>
          <SafetyCertificateOutlined style={{ color: '#c3b6ff' }} />
          单点登录 · 凭据一次性使用
        </div>
        <h1 className={styles.heroTitle}>
          ClipSync 运营管理台
          <br />
          正在通过桌面端安全接力登录…
        </h1>
        <p className={styles.heroDesc}>
          本次登录由桌面端超管账号发起，凭据 60 秒内有效且仅可使用一次，无需再次输入账号密码。
        </p>
      </section>

      <section className={styles.panel}>
        <div className={styles.card}>
          {state === 'exchanging' ? (
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <Spin size="large" />
              <div style={{ marginTop: 20, color: 'var(--text-2)', fontSize: 13 }}>
                正在兑换登录凭据…
              </div>
            </div>
          ) : (
            <Result
              status="warning"
              title="单点登录未完成"
              subTitle={<span style={{ fontSize: 13 }}>{errorMsg}</span>}
              extra={
                <Button type="primary" onClick={() => void navigate('/login', { replace: true })}>
                  返回登录页
                </Button>
              }
            />
          )}
        </div>
      </section>
    </div>
  );
}
