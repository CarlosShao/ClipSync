/**
 * 设置页顶部全文搜索（DOM 级）。
 *
 * 设置页是「左锚点导航 + 右分组堆叠滚动」，所有分组同时渲染（无虚拟滚动），
 * 所以搜索直接扫描已渲染 DOM：分组标题（.set-group > .gt）与每条设置行
 * （.sg-row 内的 .sg-name / .sg-hint），无需维护一份和组件漂移的静态索引表。
 *
 * 命中行的 DOM 节点直接存进结果项，点击结果时用它做定位高亮——
 * 这些节点由子组件渲染，Vue 不追踪，只加/移除一个临时 class。
 */
import { nextTick, onMounted, onScopeDispose, ref, watch, type Ref } from 'vue'

/** 一行可被搜索的设置（从 DOM 抽取出来的纯数据） */
export interface SearchRow {
  /** 设置项名称（.sg-name），分组标题命中时即标题本身 */
  label: string
  /** 副标题（.sg-hint），可为空 */
  hint: string
  /** 所属分组 key（= section key，用于 scrollToSection） */
  sectionKey: string
  /** 所属分组显示名（下拉右侧那列） */
  sectionLabel: string
}

/** 带 DOM 节点的命中结果 */
export interface SearchHit extends SearchRow {
  el: HTMLElement | null
}

export interface UseSettingsSearchOptions {
  /** 被扫描的容器（.set-content） */
  root: Ref<HTMLElement | null>
  /** 真正的滚动容器（.settings-page），用于判断命中行是否已在视口内 */
  scroller: Ref<HTMLElement | null>
  /** 搜索框外层元素，用于「点外面关闭下拉」 */
  wrap?: Ref<HTMLElement | null>
  /** 点击结果项时的滚动定位（保持左侧锚点导航同步高亮） */
  scrollToSection: (key: string) => void
  /** 结果条数上限 */
  limit?: number
}

const GROUP_SELECTOR = '.set-group'
const ROW_SELECTOR = '.sg-row'
const HIGHLIGHT_CLASS = 'set-search-hit'
const HIGHLIGHT_MS = 1500

function norm(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim()
}

/**
 * 纯匹配逻辑（与 DOM 解耦，便于 node 环境单测）：
 * 名称 / 副标题 / 分组名任一命中即算命中，不区分大小写（也兼容中英文混排）。
 */
export function matchRows<T extends SearchRow>(rows: T[], query: string, limit = 30): T[] {
  const q = norm(query)
  if (!q) return []
  const out: T[] = []
  for (const row of rows) {
    if (norm(row.label).includes(q) || norm(row.hint).includes(q) || norm(row.sectionLabel).includes(q)) {
      out.push(row)
      if (out.length >= limit) break
    }
  }
  return out
}

/** 扫描容器内所有可搜索行：分组标题 + 组内每条 .sg-row */
export function collectRows(root: HTMLElement): SearchHit[] {
  const rows: SearchHit[] = []
  for (const group of Array.from(root.querySelectorAll<HTMLElement>(GROUP_SELECTOR))) {
    const sectionKey = (group.id || '').replace(/^sec-/, '')
    if (!sectionKey) continue
    const gt = group.querySelector<HTMLElement>(':scope > .gt')
    const sectionLabel = textOf(gt)
    // 分组标题本身也是一条结果（只滚动，不高亮整行）
    rows.push({ label: sectionLabel, hint: '', sectionKey, sectionLabel, el: gt })

    for (const row of Array.from(group.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
      // 优先取本行自己的 label，避免嵌套行结构时把子行的名字算到父行头上
      const name = textOf(row.querySelector(':scope > .sg-label > .sg-name')) || textOf(row.querySelector('.sg-name'))
      const hint = textOf(row.querySelector(':scope > .sg-label > .sg-hint')) || textOf(row.querySelector('.sg-hint'))
      if (!name && !hint) continue
      rows.push({ label: name || hint, hint: name ? hint : '', sectionKey, sectionLabel, el: row })
    }
  }
  return rows
}

export function useSettingsSearch(options: UseSettingsSearchOptions) {
  const limit = options.limit ?? 30

  const query = ref('')
  const open = ref(false)
  const hits = ref<SearchHit[]>([])
  /** 键盘上下键选中的结果下标 */
  const active = ref(0)

  const timers = new Set<ReturnType<typeof setTimeout>>()

  function rescan() {
    const root = options.root.value
    hits.value = root ? matchRows(collectRows(root), query.value, limit) : []
    active.value = 0
  }

  function clearHighlights() {
    for (const id of timers) clearTimeout(id)
    timers.clear()
    document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach((el) => el.classList.remove(HIGHLIGHT_CLASS))
  }

  function highlight(el: HTMLElement) {
    clearHighlights()
    el.classList.add(HIGHLIGHT_CLASS)
    const id = setTimeout(() => {
      el.classList.remove(HIGHLIGHT_CLASS)
      timers.delete(id)
    }, HIGHLIGHT_MS)
    timers.add(id)
  }

  /** 命中行可能在同组靠下的位置：滚动定位后若仍不在视口内，再居中一次 */
  function ensureVisible(el: HTMLElement) {
    const scroller = options.scroller.value || options.root.value
    if (!scroller) return
    const box = el.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (box.top < view.top + 8 || box.bottom > view.bottom - 8) el.scrollIntoView({ block: 'center' })
  }

  function reveal(hit: SearchHit) {
    // 先走锚点滚动（同步左侧导航高亮），再在下一帧处理行级定位与高亮
    options.scrollToSection(hit.sectionKey)
    open.value = false
    void nextTick(() => {
      const el = hit.el
      if (!el) return
      ensureVisible(el)
      highlight(el)
    })
  }

  /** 键盘 Enter：跳当前选中项（默认第一条） */
  function acceptFirst() {
    const hit = hits.value[active.value] || hits.value[0]
    if (hit) reveal(hit)
  }

  function moveActive(delta: number) {
    const total = hits.value.length
    if (!total) return
    active.value = (active.value + delta + total) % total
  }

  function openPanel() {
    open.value = true
  }

  function setActive(index: number) {
    active.value = index
  }

  function clearSearch() {
    query.value = ''
    hits.value = []
    active.value = 0
    open.value = false
    clearHighlights()
  }

  watch(query, async () => {
    await nextTick()
    rescan()
    if (query.value.trim()) open.value = true
  })

  function onDocPointerDown(ev: PointerEvent) {
    if (!open.value) return
    const wrap = options.wrap?.value
    if (wrap && !wrap.contains(ev.target as Node)) open.value = false
  }

  onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
  onScopeDispose(() => {
    document.removeEventListener('pointerdown', onDocPointerDown)
    clearHighlights()
  })

  return { query, open, hits, active, rescan, reveal, acceptFirst, moveActive, openPanel, setActive, clearSearch }
}
