import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { TablePaginationConfig } from 'antd';
import type { FilterValue, SorterResult } from 'antd/es/table/interface';
import type { PageData } from '@/api/types';

export interface ListParams {
  page: number;
  pageSize: number;
  q?: string;
  sort?: string;
}

interface Options<T, F extends object> {
  /** 生成 queryKey（必须走 queryKeys 工厂） */
  buildKey: (params: ListParams & F) => readonly unknown[];
  fetcher: (params: ListParams & F) => Promise<PageData<T>>;
  defaultFilters: F;
  defaultPageSize?: number;
  /** antd Table sorter 变更时写入 sort 参数的约定键名 */
  sortParam?: string;
}

/**
 * 列表页标准形态：分页 + 筛选 + 排序 + URL 同步。
 * page/pageSize/筛选值都同步到 URL search params，刷新/分享链接不丢状态。
 * 所有表格页（用户/订单/审计/设备）同构使用。
 */
export function useTableQuery<T, F extends object>(
  options: Options<T, F>,
) {
  const { buildKey, fetcher, defaultFilters, defaultPageSize = 10, sortParam = 'sort' } = options;

  const [searchParams, setSearchParams] = useSearchParams();

  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.max(
    1,
    Number(searchParams.get('pageSize') ?? String(defaultPageSize)) || defaultPageSize,
  );

  const filters = useMemo(() => {
    const result = { ...defaultFilters };
    for (const key of Object.keys(defaultFilters) as (keyof F & string)[]) {
      const value = searchParams.get(key);
      if (value) result[key] = value as F[typeof key];
    }
    return result;
    // defaultFilters 由调用方以模块级常量传入，保持稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const sort = searchParams.get(sortParam) ?? undefined;

  const params = useMemo<ListParams & F>(
    () => ({ page, pageSize, ...filters, ...(sort ? { sort } : {}) }),
    [page, pageSize, filters, sort],
  );

  const query = useQuery({
    queryKey: buildKey(params),
    queryFn: () => fetcher(params),
    placeholderData: keepPreviousData,
  });

  const writeParams = useCallback(
    (nextPage: number, nextPageSize: number, nextFilters: F, nextSort?: string) => {
      const sp = new URLSearchParams();
      sp.set('page', String(nextPage));
      sp.set('pageSize', String(nextPageSize));
      for (const [key, value] of Object.entries(nextFilters) as [string, string | undefined][]) {
        if (value) sp.set(key, value);
      }
      if (nextSort) sp.set(sortParam, nextSort);
      setSearchParams(sp, { replace: true });
    },
    [setSearchParams, sortParam],
  );

  /** 应用筛选：重置回第 1 页 */
  const setFilters = useCallback(
    (next: Partial<F>) => {
      writeParams(1, pageSize, { ...filters, ...next }, sort);
    },
    [filters, pageSize, sort, writeParams],
  );

  /** antd Table onChange（排序） */
  const onSorterChange = useCallback(
    (_pagination: unknown, _filters: Record<string, FilterValue | null>, sorter: SorterResult<T> | SorterResult<T>[]) => {
      const item = Array.isArray(sorter) ? sorter[0] : sorter;
      const field = Array.isArray(item?.field)
        ? item.field.join('.')
        : String(item?.field ?? '');
      const nextSort =
        item && item.order ? `${field}_${item.order === 'ascend' ? 'asc' : 'desc'}` : undefined;
      writeParams(page, pageSize, filters, nextSort);
    },
    [filters, page, pageSize, writeParams],
  );

  const tableProps = useMemo(
    () => ({
      rowKey: 'id' as const,
      loading: query.isFetching,
      dataSource: query.data?.list ?? [],
      pagination: {
        current: page,
        pageSize,
        total: query.data?.total ?? 0,
        showSizeChanger: true,
        showQuickJumper: true,
        showTotal: (total: number) => `共 ${total.toLocaleString('zh-CN')} 条`,
        onChange: (p: number, ps: number) => writeParams(p, ps, filters, sort),
      } satisfies TablePaginationConfig,
      onChange: onSorterChange,
    }),
    [filters, onSorterChange, page, pageSize, query.data?.list, query.data?.total, query.isFetching, sort, writeParams],
  );

  return {
    tableProps,
    filters,
    setFilters,
    isFetching: query.isFetching,
    isLoading: query.isLoading,
    data: query.data,
    refetch: query.refetch,
  };
}
