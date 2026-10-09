import { useEffect, useRef } from 'react';
import { fetchCaptchaConfig } from '@/api/auth';
import styles from './TurnstileWidget.module.css';

/** 人机验证状态：enabled=true 表示服务端要求 token（此时 token 为空就不能发码） */
export interface CaptchaState {
  enabled: boolean;
  token: string;
}

interface TurnstileWidgetProps {
  onChange: (state: CaptchaState) => void;
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  remove?: (widgetId: string) => void;
}

function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

/** 只注入一次脚本（显式渲染模式）；拉不到就 resolve 当未启用，绝不能把登录页卡死 */
function loadScriptOnce(): Promise<void> {
  if (document.querySelector('script[data-clipsync-turnstile]')) return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.setAttribute('data-clipsync-turnstile', '1');
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

/**
 * Cloudflare Turnstile 挂件（管理台登录页发码用）。
 *
 * 与桌面端 AuthPage.loadCaptcha() 同源同语义：
 *  `GET /api/auth/captcha-config` → `enabled` 为真才渲染 → 注入官方脚本 → `turnstile.render`
 *  → 通过 onChange 把 token 交给父组件随发码请求提交。
 * 未启用（默认）时**不渲染任何东西**，发码行为与接入前完全一致。
 */
export function TurnstileWidget({ onChange }: TurnstileWidgetProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string>('');
  // 回调放 ref：父组件每次渲染都传新函数，进依赖数组会把挂件反复卸载重建
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchCaptchaConfig();
      if (cancelled || !cfg.enabled || !cfg.siteKey) return;
      await loadScriptOnce();
      const el = boxRef.current;
      const api = turnstileApi();
      // StrictMode 下 effect 会跑两遍：widgetIdRef 就是「已渲染过」的哨兵
      if (cancelled || !el || !api || widgetIdRef.current) return;
      widgetIdRef.current = api.render(el, {
        sitekey: cfg.siteKey,
        callback: (token: string) => onChangeRef.current({ enabled: true, token }),
        'expired-callback': () => onChangeRef.current({ enabled: true, token: '' }),
        'error-callback': () => onChangeRef.current({ enabled: true, token: '' }),
      });
      // 先声明「要 token」再等用户过验证：按钮上的拦截提示靠这个状态
      onChangeRef.current({ enabled: true, token: '' });
    })();
    return () => {
      cancelled = true;
      const id = widgetIdRef.current;
      widgetIdRef.current = '';
      if (id) {
        try {
          turnstileApi()?.remove?.(id);
        } catch {
          /* 卸载失败无所谓：父组件不再读它的 token */
        }
      }
    };
  }, []);

  return <div ref={boxRef} className={styles.box} />;
}
