import { Card, Empty } from 'antd';
import { PageHeader } from '@/components/PageHeader';

/** 订单与支付（骨架占位）：Wave 3 T-A4 填充状态 Tabs / 筛选 / 退款弹窗 / 对账抽屉 */
export default function OrdersPage() {
  return (
    <>
      <PageHeader title="订单与支付" description="本月 128 笔 · 成交 ¥41,286 · 待处理退款 2 笔" />
      <Card styles={{ body: { minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' } }}>
        <Empty description="订单列表即将上线（接口契约与 MSW 已就绪）" />
      </Card>
    </>
  );
}
