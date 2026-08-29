import { api } from './client'

export interface SearchHistoryItem {
  id: string
  keyword: string
  created_at: string
  updated_at: string
}

export function getSearchHistory(limit = 20) {
  return api<{ items: SearchHistoryItem[]; count: number }>(
    'GET',
    `/api/search-history?limit=${limit}`,
  )
}

export function recordSearch(keyword: string) {
  return api('POST', '/api/search-history', { keyword })
}

export function clearSearchHistory() {
  return api('DELETE', '/api/search-history')
}
