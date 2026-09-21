import { Button, Input, Popover, Tooltip, message } from 'antd';
import { useState } from 'react';
import {
  clearUpstream,
  getUpstream,
  mockInterceptsApi,
  normalizeUpstream,
  setUpstream,
} from '@/api/upstream';
import styles from './UpstreamDevPanel.module.css';

/** 常用联调目标。生产环境的 Origin 重写表在 vite.config.ts，新增环境要同步那张表 */
const PRESETS: { label: string; value: string }[] = [
  { label: '生产', value: 'https://api.clipchain.top' },
  { label: '本地后端', value: 'http://127.0.0.1:3001' },
];

/**
 * 仅 dev 构建挂载（App.tsx 用 import.meta.env.DEV 判定）：右下角小条，改后端地址免重启免改文件。
 * 生产构建不会打包进来——线上页面没有改指向的入口。
 */
export function UpstreamDevPanel() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(getUpstream());
  const current = getUpstream();

  function apply(next: string): void {
    try {
      const value = next ? normalizeUpstream(next) : '';
      if (value === current) {
        void message.info('地址未变化');
        return;
      }
      if (value) setUpstream(value);
      else clearUpstream();
      // 整页重载：登录态与查询缓存属于上一个后端，留着只会看到一串 401
      window.location.reload();
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '地址不合法');
    }
  }

  const mocked = mockInterceptsApi();

  return (
    <div className={styles.panel}>
      <span className={styles.label}>联调后端</span>
      <span className={`${styles.target} ${mocked ? styles.mock : styles.live}`}>
        {current || '默认（vite proxy）'}
      </span>
      <Tooltip
        title={
          mocked
            ? 'MSW 假数据正在拦截 /api，填了地址也不会真连后端；指定地址后自动让路'
            : '所有 /api 请求经 vite proxy 转发到这里，改完即刻生效（会刷新）'
        }
      >
        <span className={styles.mode}>{mocked ? '假数据' : '直连'}</span>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="topRight"
        title="后端地址（仅本地 dev 可见）"
        content={
          <div className={styles.form}>
            <Input
              size="small"
              value={draft}
              placeholder="https://api.clipchain.top"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onPressEnter={() => apply(draft)}
            />
            <div className={styles.presets}>
              {PRESETS.map((p) => (
                <Button
                  key={p.value}
                  size="small"
                  onClick={() => {
                    setDraft(p.value);
                    apply(p.value);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className={styles.hint}>
              与桌面端「设置 → 服务器地址」同源：从桌面端点开管理台会自动带上，不必再填。 留空则回到
              vite 默认目标。
            </div>
            <div className={styles.actions}>
              <Button
                size="small"
                onClick={() => {
                  setDraft('');
                  apply('');
                }}
              >
                恢复默认
              </Button>
              <Button size="small" type="primary" onClick={() => apply(draft)}>
                保存
              </Button>
            </div>
          </div>
        }
      >
        <Button size="small">设置</Button>
      </Popover>
    </div>
  );
}
