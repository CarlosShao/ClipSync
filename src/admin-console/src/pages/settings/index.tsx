import { Card, Empty } from 'antd';
import { PageHeader } from '@/components/PageHeader';

/** 系统设置（骨架占位）：Wave 3 T-A4 填充功能开关 / 系统参数 / 公告下发 / 维护模式 */
export default function SettingsPage() {
  return (
    <>
      <PageHeader title="系统设置" description="所有修改实时生效并写入审计日志" />
      <Card styles={{ body: { minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' } }}>
        <Empty description="系统设置即将上线（接口契约与 MSW 已就绪）" />
      </Card>
    </>
  );
}
