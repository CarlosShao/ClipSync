// === 本地内容缓存（后端 contentPreview 为空，需要前端自己存） ===
// 设计约束：
// 1. 只缓存文本/链接内容，不缓存图片 base64（图片走 blob URL + 服务端，避免 localStorage 和内存爆炸）。
// 2. 启动时自动清理旧版遗留的大体积图片 base64。
// 3. 限制总大小，防止单条过长或累计过多撑爆 WebView 内存。
const CONTENT_CACHE_KEY = 'clipsync-content-cache-v2'
const CONTENT_CACHE_MAX = 100 // 最多缓存条数
const CONTENT_CACHE_MAX_TOTAL_SIZE = 500 * 1024 // 总大小上限 500KB
const CONTENT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7天过期

interface CacheEntry {
  v: string
  t: number
} // value + timestamp

function loadContentCache(): Map<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CONTENT_CACHE_KEY)
    if (!raw) return new Map()

    // 旧版迁移：如果缓存整体超过 1MB，说明存了大量图片 base64，直接清空重建，
    // 避免首次启动就把几十 MB 数据读进 WebView 内存。
    if (raw.length > 1024 * 1024) {
      console.warn('[Clipboard] Old content cache too large, clearing:', (raw.length / 1024 / 1024).toFixed(2), 'MB')
      localStorage.removeItem(CONTENT_CACHE_KEY)
      return new Map()
    }

    const arr: [string, CacheEntry][] = JSON.parse(raw)
    const cache = new Map(arr)
    const now = Date.now()
    let dirty = false
    for (const [k, v] of cache) {
      // 清理过期条目
      if (now - v.t > CONTENT_CACHE_TTL) {
        cache.delete(k)
        dirty = true
        continue
      }
      // 清理旧版遗留的大体积图片 base64
      if (v.v && v.v.startsWith('data:image') && v.v.length > 1024) {
        cache.delete(k)
        dirty = true
      }
    }
    if (dirty) saveContentCache(cache)
    return cache
  } catch {
    return new Map()
  }
}

function saveContentCache(cache: Map<string, CacheEntry>) {
  // 先按总大小淘汰：value 越长越先淘汰，直到总大小低于上限
  const entries = [...cache.entries()].sort((a, b) => a[1].t - b[1].t)
  let totalSize = entries.reduce((sum, [, e]) => sum + (e.v?.length || 0), 0)
  while (totalSize > CONTENT_CACHE_MAX_TOTAL_SIZE && entries.length > 0) {
    const removed = entries.shift()
    if (removed) totalSize -= removed[1].v.length
  }
  // 再按条数淘汰
  while (entries.length > CONTENT_CACHE_MAX) {
    entries.shift()
  }
  cache = new Map(entries)
  try {
    localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify([...cache]))
  } catch (e: any) {
    // localStorage 配额超限 — 淘汰最旧的半数后重试
    const reduced = entries.slice(Math.floor(entries.length / 2))
    try {
      localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(reduced))
    } catch {
      /* 彻底放弃 */
    }
  }
}

export function cacheContent(id: string, content: string) {
  if (!content || !id) return
  try {
    // 图片 base64 不再进缓存：避免单张截图 1-3MB 把 localStorage / 内存撑爆。
    // 图片显示依赖 blob URL 或按需从服务端拉取，已足够。
    if (content.startsWith('data:image')) return
    const cache = loadContentCache()
    cache.set(id, { v: content.slice(0, 5000), t: Date.now() })
    saveContentCache(cache)
  } catch {
    /* 绝不允许缓存异常影响图片渲染 */
  }
}

export function getCachedContent(id: string): string {
  const cache = loadContentCache()
  const entry = cache.get(id)
  if (!entry) return ''
  // LRU 更新：重新写入以刷新时间戳
  entry.t = Date.now()
  return entry.v
}

/** 清空本地内容缓存（调试用 / 设置页清理按钮用） */
export function clearContentCache() {
  try {
    localStorage.removeItem(CONTENT_CACHE_KEY)
  } catch {
    /* ignore */
  }
}
