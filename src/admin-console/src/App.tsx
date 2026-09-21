import { App as AntdApp } from 'antd';
import { BrowserRouter } from 'react-router';
import { MessageBridge } from '@/api/client';
import { UpstreamDevPanel } from '@/components/UpstreamDevPanel';
import { AppRoutes } from '@/router';

/** 应用根：AntdApp 提供主题上下文（message/notification），Router 承载路由表 */
export default function App() {
  return (
    <AntdApp className="clipsync-admin">
      <MessageBridge />
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
      {/* 判定必须写成字面量 import.meta.env.DEV（构建期静态替换成 false），Rollup 才会把
          面板连同其代码从生产 bundle 里摇掉——线上不存在「改后端地址」这个入口。 */}
      {import.meta.env.DEV ? <UpstreamDevPanel /> : null}
    </AntdApp>
  );
}
