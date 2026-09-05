import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  extra?: ReactNode;
}

/** 页头：标题 + 副描述（对照草图 .page-head） */
export function PageHeader({ title, description, extra }: PageHeaderProps) {
  return (
    <div className={styles.head}>
      <div>
        <h2 className={styles.title}>{title}</h2>
        {description ? <p className={styles.desc}>{description}</p> : null}
      </div>
      {extra ? <div className={styles.extra}>{extra}</div> : null}
    </div>
  );
}
