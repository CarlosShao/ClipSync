import { ref } from 'vue'
import { getSearchHistory, recordSearch, clearSearchHistory } from '@/api/searchHistory'
import type { SearchHistoryItem } from '@/api/searchHistory'

/**
 * 搜索历史 composable：负责历史数据的加载、记录与清空。
 * 后端持久化、按 user_id 隔离、随账号跨设备同步。
 * UI 展示与交互逻辑交给 SearchHistoryDropdown 组件，本 composable 不碰 DOM。
 */
export function useSearchHistory() {
  const history = ref<SearchHistoryItem[]>([])
  const loaded = ref(false)

  async function load() {
    loaded.value = false
    try {
      const res = await getSearchHistory(10)
      history.value = res.ok ? (res.data?.items ?? []) : []
    } catch (e) {
      console.warn('[search-history] load error', e)
      history.value = []
    } finally {
      loaded.value = true
    }
  }

  async function record(keyword: string) {
    const res = await recordSearch(keyword)
    if (!res.ok) {
      console.warn('[search-history] record failed', res.error)
      return
    }
    // 乐观更新：把刚搜的词顶到最前，下次聚焦立刻能看到
    const idx = history.value.findIndex((h) => h.keyword === keyword)
    if (idx >= 0) history.value.splice(idx, 1)
    history.value.unshift({
      id: `local-${Date.now()}`,
      keyword,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }

  async function clear() {
    const res = await clearSearchHistory()
    if (res.ok) history.value = []
    else console.warn('[search-history] clear failed', res.error)
  }

  return { history, loaded, load, record, clear }
}
