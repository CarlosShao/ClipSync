import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCaptchaConfig } from '@/api/auth';
import styles from './TurnstileWidget.module.css';

/**
 * 人机验证状态。
 * - `enabled=true` 表示服务端要求验证（此时 `payload` 为空就不能发码）
 * - `payload` 是**原样塞进发码请求体**的字段：
 *     turnstile ⇒ { turnstileToken }
 *     self（自建滑块）⇒ { captchaToken, captchaX, captchaTrack }
 */
export interface CaptchaState {
  enabled: boolean;
  payload: Record<string, unknown>;
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

interface SliderChallenge {
  token: string;
  background: string;
  piece: string;
  y: number;
  pieceSize: number;
}

/** 取自建滑块题目。用原生 fetch + 相对路径：旁路信息不走 client 拦截器（免得弹无关 toast） */
async function fetchSliderChallenge(): Promise<SliderChallenge | null> {
  try {
    const resp = await fetch('/api/auth/captcha-challenge', { credentials: 'include' });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: SliderChallenge };
    return body.data?.token && body.data?.background ? body.data : null;
  } catch {
    return null;
  }
}

/**
 * 人机验证挂件（管理台登录页发码用）· provider 可切换。
 *
 * `GET /api/auth/captcha-config` 给出 provider：
 *  - turnstile：注入官方脚本 → turnstile.render（未配置 siteKey 则不渲染）
 *  - self     ：GET /api/auth/captcha-challenge 取「背景图 + 滑块图 + 签名 token」
 *                → 用户拖动滑块 → onChange({ enabled:true, payload:{ captchaToken, captchaX, captchaTrack } })
 * 未启用（默认）时**不渲染任何东西**，发码行为与接入前完全一致。
 */
export function TurnstileWidget({ onChange }: TurnstileWidgetProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string>('');
  // 回调放 ref：父组件每次渲染都传新函数，进依赖数组会把挂件反复卸载重建
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [challenge, setChallenge] = useState<SliderChallenge | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);
  const dragRef = useRef({ startX: 0, startOffset: 0, points: 0, startedAt: 0, max: 260 });
  const bgRef = useRef<HTMLDivElement | null>(null);

  const loadChallenge = useCallback(async () => {
    const c = await fetchSliderChallenge();
    if (!c) return;
    setChallenge(c);
    setOffsetX(0);
    setDone(false);
    const w = bgRef.current?.clientWidth ?? 300;
    dragRef.current.max = Math.max(0, w - (c.pieceSize || 44));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchCaptchaConfig();
      if (cancelled || !cfg.enabled) return;
      onChangeRef.current({ enabled: true, payload: {} });

      if (cfg.provider === 'self') {
        await loadChallenge();
        return;
      }
      if (!cfg.siteKey) return;
      await loadScriptOnce();
      const el = boxRef.current;
      const api = turnstileApi();
      // StrictMode 下 effect 会跑两遍：widgetIdRef 就是「已渲染过」的哨兵
      if (cancelled || !el || !api || widgetIdRef.current) return;
      widgetIdRef.current = api.render(el, {
        sitekey: cfg.siteKey,
        callback: (token: string) => onChangeRef.current({ enabled: true, payload: { turnstileToken: token } }),
        'expired-callback': () => onChangeRef.current({ enabled: true, payload: {} }),
        'error-callback': () => onChangeRef.current({ enabled: true, payload: {} }),
      });
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
    // loadChallenge 稳定（useCallback 无依赖）
  }, [loadChallenge]);

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!challenge || done) return;
    setDragging(true);
    dragRef.current.startX = e.clientX;
    dragRef.current.startOffset = offsetX;
    dragRef.current.points = 1;
    dragRef.current.startedAt = Date.now();
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败也能靠 move 事件拖动 */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const next = Math.min(Math.max(dragRef.current.startOffset + dx, 0), dragRef.current.max);
    setOffsetX(next);
    dragRef.current.points += 1;
  };

  const onPointerUp = () => {
    if (!dragging || !challenge) return;
    setDragging(false);
    setDone(true);
    // 立刻给"已拖动"的视觉反馈；真正判定在服务端（缺口坐标只有它有）
    onChangeRef.current({
      enabled: true,
      payload: {
        captchaToken: challenge.token,
        captchaX: Math.round(offsetX),
        captchaTrack: { points: dragRef.current.points, durationMs: Date.now() - dragRef.current.startedAt },
      },
    });
  };

  if (!challenge) {
    // Turnstile（或无验证）路径：只留官方挂件容器
    return <div ref={boxRef} className={styles.box} />;
  }

  return (
    <div className={styles.sliderWrap}>
      <div ref={bgRef} className={styles.sliderBg}>
        <img src={challenge.background} alt="拖动滑块完成验证" draggable={false} />
        {challenge.piece ? (
          <img
            className={styles.sliderPiece}
            data-done={done ? '1' : '0'}
            src={challenge.piece}
            draggable={false}
            style={{
              left: offsetX,
              top: challenge.y,
              width: challenge.pieceSize,
              height: challenge.pieceSize,
              cursor: dragging ? 'grabbing' : 'grab',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        ) : null}
      </div>
      <div className={styles.sliderBar}>
        {done ? (
          <>
            已拖动，正在提交验证
            <button
              type="button"
              className={styles.sliderReset}
              onClick={() => {
                onChangeRef.current({ enabled: true, payload: {} });
                void loadChallenge();
              }}
            >
              重来
            </button>
          </>
        ) : (
          '按住滑块拖到缺口处'
        )}
      </div>
    </div>
  );
}
