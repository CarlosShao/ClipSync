import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import { antdTheme } from '@/theme/antd';
import '@/styles/tokens.css';
import '@/styles/global.css';

dayjs.locale('zh-cn');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

/** VITE_ENABLE_MSW 开关：dev 默认开启，生产（.env.production 显式 false）强制关闭 */
async function enableMocking(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false') return;
  const { worker } = await import('@/mocks/browser');
  await worker.start({ onUnhandledRequest: 'bypass' });
  // AF-54：MSW 模式可见化——防止假数据被误当真实后端
  const tag = document.createElement('div');
  tag.textContent = 'MOCK 数据 · 未连接真实后端';
  tag.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9999;background:#e11d48;color:#fff;' +
    'padding:2px 8px;border-radius:4px;font-size:12px;pointer-events:none;';
  document.body.appendChild(tag);
}

void enableMocking()
  .catch((error) => {
    // MSW 启动失败不阻断应用（dev 下会直连真实后端 proxy）
    console.warn('[msw] 启动失败，已回退直连模式', error);
  })
  .then(() => {
    const container = document.getElementById('root');
    if (!container) throw new Error('未找到 #root 挂载点');
    createRoot(container).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <ConfigProvider locale={zhCN} theme={antdTheme}>
            <App />
          </ConfigProvider>
        </QueryClientProvider>
      </StrictMode>
    );
  });
