import { useEffect, useRef, useState } from 'react';

/**
 * 侧边栏宽度拖拽（antd 5.x 的 Layout.Sider 无原生 resizable，那是 antd 6.x 能力）。
 *
 * 设计约束：
 *   - 只在「展开」态可拖拽（折叠态宽度由 Sider collapsedWidth 接管，拖拽无意义）
 *   - 宽度持久化到 localStorage，刷新后保持；读取时做范围钳制，防脏数据把布局撑坏
 *   - 拖拽期间给 body 加禁止选中 + cursor，避免拖拽时选中文字/出现 I 形光标
 *   - 用 pointer 事件（setPointerCapture）而非 mouse：触控板/触屏一并可用，
 *     且指针移出窗口也不丢事件（mouse 事件会丢，导致手柄"粘住"）
 *
 * @param options.min       最小宽度（px）
 * @param options.max       最大宽度（px）
 * @param options.defaultWidth 无持久化值时的宽度（px）
 * @param options.storageKey  localStorage 键名
 * @param options.enabled    false 时不响应拖拽（如折叠态）
 */
export function useResizableSider({
  min,
  max,
  defaultWidth,
  storageKey,
  enabled,
}: {
  min: number;
  max: number;
  defaultWidth: number;
  storageKey: string;
  enabled: boolean;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = Number(raw);
      // 无值 / 非数字 / 越界 → 回退默认（旧版本遗留的超范围值不应污染布局）
      if (!raw || !Number.isFinite(parsed)) return defaultWidth;
      return clamp(parsed);
    } catch {
      return defaultWidth;
    }
  });

  // 拖拽中标记：仅在 true 时挂全局 move/up 监听
  const draggingRef = useRef(false);
  // 拖拽起始的指针 X 与宽度（用增量算，避免 absolute 定位误差）
  const startRef = useRef({ x: 0, width: 0 });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    e.preventDefault();
    draggingRef.current = true;
    startRef.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const delta = e.clientX - startRef.current.x;
    setWidth(clamp(startRef.current.width + delta));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放（如触控取消）时忽略 */
    }
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };

  // 键盘可达性：手柄是 role="separator"，支持左右方向键微调（无障碍要求）
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const STEP = 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setWidth((w) => clamp(w - STEP));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setWidth((w) => clamp(w + STEP));
    }
  };

  // 宽度变化持久化（拖拽中高频写入 localStorage 无必要，用 effect 收敛到一次）
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      /* 隐私模式等禁用 localStorage 时静默降级为「仅本次会话有效」 */
    }
  }, [width, storageKey]);

  return { width, onPointerDown, onPointerMove, endDrag, onKeyDown };
}

/**
 * 侧边栏折叠态（持久化到 localStorage）。
 * 与宽度同源：刷新后保持用户上次的布局状态，不每次回默认展开。
 */
export function useStatePersistedCollapsed(storageKey = 'clipsync-admin-sider-collapsed') {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, collapsed ? '1' : '0');
    } catch {
      /* localStorage 不可用时静默降级 */
    }
  }, [collapsed, storageKey]);

  return [collapsed, setCollapsed] as const;
}
