import { Button, Result } from 'antd';
import { useNavigate } from 'react-router';

/** 404 兜底页 */
export default function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title="404"
      subTitle="抱歉，你访问的页面不存在。"
      extra={
        <Button type="primary" onClick={() => void navigate('/dashboard', { replace: true })}>
          返回数据看板
        </Button>
      }
    />
  );
}
