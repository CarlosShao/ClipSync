import { ref } from 'vue'
import { fetchFrequent, type FrequentItem } from '@/api/clipboard'

/**
 * 预测粘贴 / 智能建议 composable：负责拉取「使用频率衰减加权」的热门条目，
 * 作为快速粘贴窗口顶部的建议候选。数据来自后端（跨设备持久化、随账号累积）。
 * 不碰 DOM，纯数据层；展示与交互交给 QuickPasteSuggestions 组件。
 */
export function usePastePrediction() {
  const suggestions = ref<FrequentItem[]>([])
  const loaded = ref(false)

  async function load(limit = 3) {
    loaded.value = false
    try {
      const res = await fetchFrequent(limit)
      suggestions.value = res.ok ? (res.data?.items ?? []) : []
    } catch (e) {
      console.warn('[paste-prediction] load failed', e)
      suggestions.value = []
    } finally {
      loaded.value = true
    }
  }

  return { suggestions, loaded, load }
}
