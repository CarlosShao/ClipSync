import { App as AntdApp } from 'antd';
import { BrowserRouter } from 'react-router';
import { MessageBridge } from '@/api/client';
import { AppRoutes } from '@/router';

/** 应用根：AntdApp 提供主题上下文（message/notification），Router 承载路由表 */
export default function App() {
  return (
    <AntdApp className="clipsync-admin">
      <MessageBridge />
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AntdApp>
  );
}
