import { ref, computed } from 'vue'

export interface ClipItem {
  id: string
  type: 'text' | 'image' | 'file' | 'link'
  content: string
  preview?: string
  source?: string
  deviceName?: string
  timestamp: number
  selected?: boolean
  isFavorite?: boolean
  favoritedAt?: number
  contentSize?: number
  metadata?: any
  // === 高级搜索 / 条目级密码 字段 ===
  sourceDeviceId?: string
  tags?: string[]
  isProtected?: boolean
  // === 归档字段 ===
  isArchived?: boolean
  // === 用户侧自动过期字段 ===
  expiresAt?: string | null
}

// === SINGLETON STATE - module-level refs shared across all callers ===
export type ClipboardFilter = 'all' | 'text' | 'images' | 'links' | 'files' | 'favorites'
const VALID_FILTERS: ClipboardFilter[] = ['all', 'text', 'images', 'links', 'files', 'favorites']
const CLIPBOARD_FILTER_KEY = 'clipsync-clipboard-filter'

function loadSavedFilter(): ClipboardFilter {
  try {
    const saved = localStorage.getItem(CLIPBOARD_FILTER_KEY)
    if (saved && VALID_FILTERS.includes(saved as ClipboardFilter)) return saved as ClipboardFilter
  } catch { /* ignore */ }
  return 'all'
}

export function persistFilter(f: ClipboardFilter) {
  try { localStorage.setItem(CLIPBOARD_FILTER_KEY, f) } catch { /* ignore */ }
}

export const items = ref<ClipItem[]>([])
export const searchQuery = ref('')
export const activeFilter = ref<ClipboardFilter>(loadSavedFilter())
export const batchMode = ref(false)
export const polling = ref(false)
export const loading = ref(false)
// 分页状态 — 解决"删除后刷新总是固定 50 条"的感知问题。
// 后端是硬删（已验证），但前端每次只拉 page1(limit50)，删除可见项后旧条目滚入 page1，
// 让人以为删除没生效。改为：展示服务器总数 + "加载更多"按钮拉取后续分页。
export const currentPage = ref(1)
export const pageSize = ref(50)
// 当前视图：'all' = 主列表（默认隐藏已归档），'archive' = 仅归档视图。
// 用 module-level ref 让 setFilter/loadMore/clearAdvancedFilters 自动沿用当前视图，
// 避免切到归档视图后切换分类竟把非归档数据拉进来。
export const currentView = ref<'all' | 'archive'>('all')
export const totalItems = ref(0)
// 主剪贴板视图（非归档）的总数，用于侧边栏计数稳定显示：
// 归档视图拉取时只更新 totalItems，不覆盖 mainTotalItems，避免侧边栏「剪贴板」数字跳到归档数量。
export const mainTotalItems = ref(0)
export const loadingMore = ref(false)
export const hasMore = computed(() => totalItems.value > 0 && items.value.length < totalItems.value)

// === 高级搜索筛选（device / date range）===
// 与 activeFilter/searchQuery 同理，使用 module-level ref 让筛选面板双向绑定，
// 并由 loadClipboardItems 读取它们拼接到后端查询参数。
export const advancedFilters = ref<{
  deviceId: string
  dateFrom: string
  dateTo: string
}>({
  deviceId: '',
  dateFrom: '',
  dateTo: '',
})

export const recentUploadHashes = new Map<string, number>()
export const HASH_TTL = 30000 // 30s dedup window — covers monitor event + fallback poll + any retries

// === ClipSync 内部复制去重（精确内容匹配） ===
// 用户铁律：从 ClipSync UI 复制任何条目，都不应再次产生重复记录。
// 策略1: 时间戳跳过（复制后短时间内不处理剪贴板变化）
// 策略2: 精确内容匹配（复制时记录会写入剪贴板的内容/文件路径，monitor 检测到匹配内容时跳过）
// ESM 不允许给导入的 let 赋值，故读取侧直接 import skipPollUntil（live binding），
// 写入侧统一走 setter。
export let skipPollUntil = 0
export function setSkipPollUntil(v: number) { skipPollUntil = v }
// 初始加载后跳过轮询，防止系统剪贴板内容被重新上传
export let initialLoadDone = false
export function setInitialLoadDone(v: boolean) { initialLoadDone = v }

export const filteredItems = computed(() => {
  let result = items.value
  if (activeFilter.value !== 'all') {
    result = result.filter(i => {
      if (activeFilter.value === 'text') return i.type === 'text'
      if (activeFilter.value === 'images') return i.type === 'image'
      if (activeFilter.value === 'links') return i.type === 'link'
      if (activeFilter.value === 'files') return i.type === 'file'
      return true
    })
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(i => i.content.toLowerCase().includes(q) || (i.source || '').toLowerCase().includes(q))
  }
  return result
})

export const selectedCount = computed(() => items.value.filter(i => i.selected).length)
export const allSelected = computed(() => filteredItems.value.length > 0 && filteredItems.value.every(i => i.selected))

export function toggleSelectAll() {
  const shouldSelect = !allSelected.value
  // 不可变更新：替换整个 items 数组中 filteredItems 对应项的引用，
  // 确保 Vue 3 检测到变化并触发所有依赖它的 computed/子组件重渲染。
  // （直接修改 i.selected 属性在边界情况下可能不触发 Checkbox 重渲染）
  const selectedIds = new Set(filteredItems.value.map(i => i.id))
  items.value = items.value.map(item =>
    selectedIds.has(item.id) ? { ...item, selected: shouldSelect } : item
  )
}

export function clearSelection() {
  items.value.forEach(i => { i.selected = false })
}
