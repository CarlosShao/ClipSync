import { Button, Result } from 'antd';
import { useNavigate } from 'react-router';

/** 403：无后台访问权限（roleKey ∉ {admin, super_admin}） */
export function ForbiddenPage() {
  const navigate = useNavigate();
  return (
    <Result
      status="403"
      title="403"
      subTitle="抱歉，你的账号没有访问该后台的权限。"
      extra={
        <Button type="primary" onClick={() => void navigate('/dashboard', { replace: true })}>
          返回数据看板
        </Button>
      }
    />
  );
}
