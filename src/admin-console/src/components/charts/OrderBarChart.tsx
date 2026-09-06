import { BarChart, type BarSeriesOption } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type LegendComponentOption,
  type GridComponentOption,
  type TooltipComponentOption,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import type { DailyOrderStat } from '@/api/types';

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

type EChartsOption = echarts.ComposeOption<
  BarSeriesOption | GridComponentOption | TooltipComponentOption | LegendComponentOption
>;

interface OrderBarChartProps {
  data: DailyOrderStat[];
  height?: number;
}

/** 近 14 天订单金额柱状图（品牌紫主柱 + 浅紫退款叠加，对照草图 B） */
export function OrderBarChart({ data, height = 190 }: OrderBarChartProps) {
  const option = useMemo<EChartsOption>(
    () => ({
      grid: { left: 8, right: 8, top: 28, bottom: 0, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value) => `¥${Number(value ?? 0).toLocaleString('zh-CN')}`,
      },
      legend: {
        right: 0,
        top: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: '#5a5f6e', fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: data.map((d) => d.date.slice(5).replace('-', '-')),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#e6e8f0' } },
        axisLabel: { color: '#9298a8', fontSize: 10, interval: Math.max(0, data.length - 4) },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#eef0f6' } },
        axisLabel: {
          color: '#9298a8',
          fontSize: 10,
          formatter: (value: number) => (value >= 1000 ? `${value / 1000}k` : String(value)),
        },
      },
      series: [
        {
          name: '订单金额',
          type: 'bar',
          data: data.map((d) => d.amount),
          barWidth: 26,
          itemStyle: { color: '#5a4bd1', borderRadius: [3, 3, 0, 0] },
        },
        {
          name: '退款金额',
          type: 'bar',
          data: data.map((d) => d.refund),
          barWidth: 26,
          barGap: '-100%',
          itemStyle: { color: '#c3b6ff', borderRadius: [2, 2, 0, 0] },
        },
      ],
    }),
    [data],
  );

  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}
