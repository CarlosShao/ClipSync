import { Card, Empty } from 'antd';
import { PageHeader } from '@/components/PageHeader';

/** 角色权限（骨架占位）：Wave 4 T-A6 填充角色列表 + 权限树 + 级别约束 */
export default function RolesPage() {
  return (
    <>
      <PageHeader title="角色与权限" description="左侧选择角色，右侧编辑其权限 · 级别约束：低级别不可管理高级别" />
      <Card styles={{ body: { minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' } }}>
        <Empty description="角色权限管理即将上线（接口契约与 MSW 已就绪）" />
      </Card>
    </>
  );
}
