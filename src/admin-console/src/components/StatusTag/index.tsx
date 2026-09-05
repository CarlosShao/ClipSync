import type { ReactNode } from 'react';
import styles from './StatusTag.module.css';

export type StatusTone = 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'brand';

interface StatusTagProps {
  tone: StatusTone;
  /** 是否显示前置圆点（默认显示，对照草图 .tag .d） */
  dot?: boolean;
  children: ReactNode;
}

/** 状态标签：小圆点 + 软色底（对照草图 .tag.*） */
export function StatusTag({ tone, dot = true, children }: StatusTagProps) {
  return (
    <span className={`${styles.tag} ${styles[tone]}`}>
      {dot ? <i className={styles.dot} /> : null}
      {children}
    </span>
  );
}
