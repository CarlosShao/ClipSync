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
  /** 弹窗模式：true 才渲染遮罩弹窗；不传（undefined）= 行内模式（向后兼容） */
  open?: boolean;
  /** 用户关闭弹窗（未完成验证） */
  onClose?: () => void;
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

/** 取自建滑块题目。原生 fetch + 相对路径：旁路信息不走 client 拦截器（免得弹无关 toast） */
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
 * 人机验证挂件（管理台登录页发码用）· provider 可切换 + **弹窗模式**。
 *
 * 弹窗模式（`:open` 传值，推荐）：点「发送验证码」→ 父组件把 open 置 true → 这里显示遮罩弹窗
 *   → 用户拖滑块/过 Turnstile → onChange 带上 payload → 父组件关弹窗并**自动发码**。
 * 行内模式（不传 open）：为兼容保留，行为同以前。
 *
 * 未启用（provider=off / 凭据不齐）时什么都不渲染，发码行为与接入前完全一致。
 */
export function TurnstileWidget({ onChange, open, onClose }: TurnstileWidgetProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string>('');
  const providerRef = useRef<string>('off');
  const siteKeyRef = useRef<string>('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [challenge, setChallenge] = useState<SliderChallenge | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);
  const [loadingChallenge, setLoadingChallenge] = useState(false);
  const dragRef = useRef({ startX: 0, startOffset: 0, points: 0, startedAt: 0, max: 260 });
  const bgRef = useRef<HTMLDivElement | null>(null);

  const loadChallenge = useCallback(async () => {
    setLoadingChallenge(true);
    const c = await fetchSliderChallenge();
    setLoadingChallenge(false);
    if (!c) return;
    setChallenge(c);
    setOffsetX(0);
    setDone(false);
    const w = bgRef.current?.clientWidth ?? 300;
    dragRef.current.max = Math.max(120, w - (c.pieceSize || 44));
  }, []);

  // ① 挂载时只取「要不要验证 + 哪个 provider」（弹窗模式不在此时渲染）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchCaptchaConfig();
      if (cancelled || !cfg.enabled) return;
      providerRef.current = cfg.provider || (cfg.siteKey ? 'turnstile' : 'off');
      siteKeyRef.current = cfg.siteKey || '';
      onChangeRef.current({ enabled: true, payload: {} });
      if (open === undefined) {
        // 行内模式：立刻渲染
        if (providerRef.current === 'self') await loadChallenge();
        else await renderTurnstile();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderTurnstile = useCallback(async () => {
    if (providerRef.current !== 'turnstile' || !siteKeyRef.current) return;
    await loadScriptOnce();
    const el = boxRef.current;
    const api = turnstileApi();
    if (!el || !api || widgetIdRef.current) return;
    widgetIdRef.current = api.render(el, {
      sitekey: siteKeyRef.current,
      callback: (token: string) => onChangeRef.current({ enabled: true, payload: { turnstileToken: token } }),
      'expired-callback': () => onChangeRef.current({ enabled: true, payload: {} }),
      'error-callback': () => onChangeRef.current({ enabled: true, payload: {} }),
    });
  }, []);

  // ② 弹窗打开时才去取题/渲染
  useEffect(() => {
    if (open !== true) return;
    if (providerRef.current === 'self') void loadChallenge();
    else void renderTurnstile();
  }, [open, loadChallenge, renderTurnstile]);

  useEffect(() => {
    return () => {
      const id = widgetIdRef.current;
      widgetIdRef.current = '';
      if (id) {
        try {
          turnstileApi()?.remove?.(id);
        } catch {
          /* 卸载失败无所谓 */
        }
      }
    };
  }, []);

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
      /* 捕获失败也能靠 move 拖动 */
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    setOffsetX(Math.min(Math.max(dragRef.current.startOffset + dx, 0), dragRef.current.max));
    dragRef.current.points += 1;
  };
  const onPointerUp = () => {
    if (!dragging || !challenge) return;
    setDragging(false);
    setDone(true);
    // 松手即交卷：父组件收到 payload 后关弹窗并真正发码（服务端做最终判定）
    onChangeRef.current({
      enabled: true,
      payload: {
        captchaToken: challenge.token,
        captchaX: Math.round(offsetX),
        captchaTrack: { points: dragRef.current.points, durationMs: Date.now() - dragRef.current.startedAt },
      },
    });
  };
  const redo = () => {
    onChangeRef.current({ enabled: true, payload: {} });
    void loadChallenge();
  };

  const body = (
    <>
      <div ref={boxRef} />
      {challenge ? (
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
                已交卷，正在发送短信
                <button type="button" className={styles.sliderReset} onClick={redo}>
                  重来
                </button>
              </>
            ) : (
              '按住滑块，拖到图上缺口处'
            )}
          </div>
        </div>
      ) : providerRef.current === 'self' && loadingChallenge ? (
        <p className={styles.sliderBar}>正在加载验证题…</p>
      ) : null}
    </>
  );

  // 行内模式
  if (open === undefined) {
    return <div className={styles.box}>{body}</div>;
  }

  // 弹窗模式：未打开时不渲染
  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onCloseRef.current?.()}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>请完成人机验证</span>
          <button type="button" className={styles.cardClose} onClick={() => onCloseRef.current?.()}>
            ✕
          </button>
        </div>
        <p className={styles.cardTip}>验证通过后会自动发送短信验证码</p>
        {body}
      </div>
    </div>
  );
}
