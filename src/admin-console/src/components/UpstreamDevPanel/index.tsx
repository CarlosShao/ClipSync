import { Button, Input, Popover, Tooltip, message } from 'antd';
import { useState } from 'react';
import {
  clearUpstream,
  currentUpstreamView,
  devDefaultProxyTarget,
  getUpstream,
  mockInterceptsApi,
  normalizeUpstream,
  setUpstream,
} from '@/api/upstream';
import styles from './UpstreamDevPanel.module.css';

/**
 * 常用联调目标。生产域名已被 normalizeUpstream 与 vite proxy 双层拒绝（S0 修复），
 * 不再提供「生产」预设；新增非生产联调环境要同步 vite.config.ts 的运行时白名单
 *（或 VITE_PROXY_UPSTREAM_ALLOWLIST），否则 proxy 会 403。
 */
const PRESETS: { label: string; value: string }[] = [
  { label: '本地后端', value: 'http://127.0.0.1:3001' },
];

/**
 * 仅 dev 构建挂载（App.tsx 用 import.meta.env.DEV 判定）：右下角小条，改后端地址免重启免改文件。
 * 生产构建不会打包进来——线上页面没有改指向的入口。
 */
export function UpstreamDevPanel() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(getUpstream());
  // 展示的唯一真值来源：**默认目标也要显示出来**。
  // 过去这里只渲染「默认（vite proxy）」这个字面量，把真正生效的默认目标藏起来了；
  // 而默认目标来自 .env.development.local，本机就被指到了生产。于是「以为在连 dev、
  // 其实在连生产」在界面上无法被判读（2026-10-05 真实发生过）。
  const view = currentUpstreamView();
  const current = view.runtime;
  const defaultTarget = devDefaultProxyTarget();

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

  const targetLabel = view.effective
    ? view.source === 'runtime'
      ? view.effective
      : `默认（vite proxy）→ ${view.effective}`
    : '默认（vite proxy，未显式配置）';
  // 生产目标必须显式喊出来：这个面板上的每一次退款/改配置/发通知都是真实生产操作
  const prodLive = view.isProduction && !mocked;
  const modeLabel = mocked ? '假数据' : prodLive ? '直连生产' : '直连';
  const modeTip = mocked
    ? 'MSW 假数据正在拦截 /api，填了地址也不会真连后端；指定地址后自动让路'
    : prodLive
      ? `所有 /api 请求经 vite proxy 转发到**生产**后端（${view.effective}）：页面上的每次退款 / 改配置 / 发通知都是真实生产操作。`
      : `所有 /api 请求经 vite proxy 转发到这里（${view.effective || '未指定'}），改完即刻生效（会刷新）`;

  return (
    <div className={styles.panel}>
      <span className={styles.label}>联调后端</span>
      <Tooltip title={targetLabel}>
        <span
          className={`${styles.target} ${
            mocked ? styles.mock : prodLive ? styles.prod : styles.live
          }`}
        >
          {targetLabel}
        </span>
      </Tooltip>
      <Tooltip title={modeTip}>
        <span className={`${styles.mode} ${prodLive ? styles.modeProd : ''}`}>{modeLabel}</span>
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
              placeholder="http://127.0.0.1:3001（联调地址示例）"
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
              与桌面端「设置 → 服务器地址」同源：从桌面端点开管理台会自动带上，不必再填。
              留空则回到 vite proxy 默认目标
              {defaultTarget ? `（当前：${defaultTarget}）` : '（未显式配置，vite 内置 http://127.0.0.1:3001）'}。
              手输生产域名会被拒绝（本地页面不得对生产下真实指令）；要长期操作生产请用部署版管理台。
            </div>
            {prodLive && (
              <div className={styles.warn}>
                ⚠ 当前默认目标就是生产后端 {view.effective}：这个页面上的退款、改配置、发通知
                都会真实作用于线上。验收/联调请注意。
              </div>
            )}
            <div className={styles.actions}>
              <Button
                size="small"
                title={defaultTarget ? `回到 vite proxy 默认目标：${defaultTarget}` : undefined}
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
