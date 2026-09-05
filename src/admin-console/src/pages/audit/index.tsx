import { Card, Empty } from 'antd';
import { PageHeader } from '@/components/PageHeader';

/** 审计日志（骨架占位）：Wave 4 T-A6 填充筛选区 / 敏感行高亮 / CSV 导出 */
export default function AuditPage() {
  return (
    <>
      <PageHeader
        title="审计日志"
        description={
          <>
            保留 1 年 · 共 2,431,088 条 · 今日 4,112 条 ·{' '}
            <b style={{ color: 'var(--red)' }}>红点为敏感操作</b>
          </>
        }
      />
      <Card styles={{ body: { minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' } }}>
        <Empty description="审计日志列表即将上线（接口契约与 MSW 已就绪）" />
      </Card>
    </>
  );
}
