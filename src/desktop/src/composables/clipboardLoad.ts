// === 剪贴板数据加载（分页拉取 / 图片异步队列 / 设备列表 / 条目更新） ===
import { api, apiBlob } from '@/api/client'
import { logger } from '@/utils/logger'
import {
  items, loading, loadingMore, currentPage, pageSize, currentView,
  totalItems, mainTotalItems, hasMore, activeFilter, advancedFilters,
  type ClipItem,
} from './clipboardState'
import { getCachedContent, cacheContent } from './clipboardCache'
import { setItemPreview, releaseRemovedObjectUrls } from './clipboardObjectUrls'

// 设备列表（用于筛选下拉），懒加载 + 内存缓存，避免每次打开筛选面板都打 /api/devices
let devicesCache: { id: string; name: string; platform?: string }[] = []

export async function loadClipboardItems(opts?: { page?: number; append?: boolean; all?: boolean; favorite?: boolean; view?: 'all' | 'archive' }) {
  const page = opts?.page ?? 1
  const append = opts?.append ?? false
  const loadAll = opts?.all ?? false
  const loadFavorites = opts?.favorite ?? false
  // 视图：归档视图(view=archive)只拉 archived=TRUE 的条目；默认沿用 currentView，
  // 保证分类切换/加载更多时不丢失归档上下文。
  const view = opts?.view || currentView.value
  currentView.value = view
  if (!append) currentPage.value = page
  if (append) loadingMore.value = true; else loading.value = true
  const limit = loadAll ? 500 : (loadFavorites ? 200 : pageSize.value)
  const favParam = loadFavorites ? '&favorites=true' : ''
  const viewParam = view === 'archive' ? '&view=archive' : ''
  // 按当前分类筛选：后端直接过滤并返回该类型总数，避免"图片分类下显示全部总数"的 bug。
  // 注意 filter 值与后端 content_type 的映射：images -> image，links -> link，files -> file。
  const filterToContentType: Record<string, string> = { text: 'text', images: 'image', links: 'link', files: 'file' }
  const contentType = (!loadAll && !loadFavorites) ? (filterToContentType[activeFilter.value] || '') : ''
  const typeParam = contentType ? `&contentType=${encodeURIComponent(contentType)}` : ''
  // 高级筛选参数：deviceId / dateFrom / dateTo，全部走后端精确过滤。
  // 注意：加载"全部/收藏"时仍可叠加这些筛选；但 all=true 模式用来表示"不按分类裁剪"，
  // 与高级筛选是正交的，故始终附加。
  const af = advancedFilters.value
  const advParts: string[] = []
  if (af.deviceId && af.deviceId.trim()) advParts.push(`deviceId=${encodeURIComponent(af.deviceId.trim())}`)
  if (af.dateFrom && af.dateFrom.trim()) advParts.push(`dateFrom=${encodeURIComponent(af.dateFrom.trim())}`)
  if (af.dateTo && af.dateTo.trim()) advParts.push(`dateTo=${encodeURIComponent(af.dateTo.trim())}`)
  const advParamStr = advParts.length > 0 ? `&${advParts.join('&')}` : ''
  try {
  const res = await api('GET', `/api/clipboard?page=${page}&limit=${limit}${loadAll ? '&all=true' : ''}${favParam}${typeParam}${advParamStr}${viewParam}`)
  if (res.ok && Array.isArray(res.data?.items)) {
    totalItems.value = res.data?.pagination?.total ?? res.data.items.length
    // 仅在主视图（all）更新侧边栏计数，归档视图不覆盖主视图总数
    if (view !== 'archive') {
      mainTotalItems.value = totalItems.value
    }
    const serverIds = new Set(res.data.items.map((i: any) => i.id))
    // Build set of server content previews for dedup
    const serverContentPreviews = new Set(res.data.items.map((i: any) => (i.contentPreview || '').slice(0, 100)))
    // 整表刷新时只保留本地乐观更新项（临时 ID），避免切换分类/收藏夹后旧分类的服务器条目
    // 因为不在新分类第一页而被残留到列表最前面，导致“切到全部后链接/收藏数据置顶”的错乱。
    const localWithContent = items.value.filter(i => {
      // 仅保留本地临时 ID 的乐观项；正式服务器 ID 的条目应当完全由本次接口返回决定顺序与内容。
      const isLocal = i.id.startsWith('local-') || i.id.startsWith('text-') || i.id.startsWith('img-') || i.id.startsWith('browser-')
      if (!isLocal) return false
      if (serverIds.has(i.id)) return false
      if (!i.content || !i.content.trim()) return false
      // File items with local-/file- prefix are optimistic updates — always replace with server data
      if (i.type === 'file' && (i.id.startsWith('local-') || i.id.startsWith('file-'))) return false
      // Check if this local item matches a server item by content preview
      const localPreview = i.content.slice(0, 100)
      if (serverContentPreviews.has(localPreview)) return false
      return true
    })
    const serverItems = res.data.items.map((i: any) => {
      const isImage = (i.contentType || i.type) === 'image'
      // 复用已在列表里加载好的图片预览（blob URL），避免刷新时重新拉取并生成新 blob
      // 造成内存膨胀/闪烁。仅当服务端条目与本地已加载条目 ID 一致时复用。
      const existingImage = isImage ? items.value.find(e => e.id === i.id && e.type === 'image') : undefined
      const existingPreview = existingImage?.preview || ''
      const cachedContent = getCachedContent(i.id)
      let content: string
      if (isImage) {
        content = cachedContent || ''
        // 图片异步加载：不在这里触发，统一放到下面的队列
      } else {
        const existing = items.value.find(e => e.id === i.id && e.content)
        content = existing?.content || cachedContent || i.contentPreview || i.content || ''
        // For file items: reconstruct content with paths from metadata if available
        if ((i.contentType || i.type) === 'file') {
          try {
            // metadata may be a JSON string (from API) or already-parsed object (from pg driver)
            const rawMeta = typeof i.metadata === 'string' ? i.metadata : JSON.stringify(i.metadata || {})
            const meta = JSON.parse(rawMeta || '{}')
            if (meta.paths && Array.isArray(meta.paths) && meta.paths.length > 0) {
              content = JSON.stringify({ name: meta.originalName || content, paths: meta.paths })
            }
          } catch { /* no metadata or not JSON */ }
        }
        // For file items: ensure content is a displayable filename, not raw content
        // BUT preserve paths field if it was reconstructed from metadata
        const hasPaths = (() => { try { const p = JSON.parse(content); return p && typeof p === 'object' && Array.isArray(p.paths) } catch { return false } })()
        if ((i.contentType || i.type) === 'file' && content.length > 200 && !hasPaths) {
          // content is too long to be a filename — extract from metadata
          try {
            const rawMeta = typeof i.metadata === 'string' ? i.metadata : JSON.stringify(i.metadata || {})
            const meta = JSON.parse(rawMeta || '{}')
            if (meta.originalName) content = meta.originalName
            else if (meta.name) content = meta.name
          } catch { /* not JSON */ }
          // Still too long? Use contentPreview as filename
          if (content.length > 200 && i.contentPreview) {
            content = i.contentPreview.split(/[/\\]/).pop() || i.contentPreview
          }
        }
      }
      const preview = isImage ? (cachedContent || existingPreview || '') : content
      return {
        id: i.id,
        type: (i.contentType || i.type || 'text') as ClipItem['type'],
        content,
        // 未缓存图片：preview 留空（异步队列会从服务端拉取并填充），
        // 不要用 'loading' 字符串当 src，否则会显示破图。
        preview: preview || (isImage ? '' : ''),
        source: i.sourceDevice?.name || i.deviceName || 'Server',
        timestamp: new Date(i.createdAt || Date.now()).getTime(),
        selected: false,
        isFavorite: !!i.isFavorite,
        favoritedAt: i.favoritedAt ? new Date(i.favoritedAt).getTime() : undefined,
        metadata: (() => {
          // 从服务端 protectionLevel 同步元数据标记
          const meta = i.metadata && typeof i.metadata === 'object' ? { ...i.metadata } : {}
          if (i.protectionLevel === 'advanced') meta.protected = true
          else if (i.protectionLevel === 'pin') meta.sensitive = true
          return meta
        })(),
        contentSize: i.contentSize,
        // === 高级搜索 / 条目级密码 ===
        sourceDeviceId: i.sourceDevice?.id || i.sourceDeviceId || undefined,
        tags: (i.metadata && Array.isArray(i.metadata.tags)) ? i.metadata.tags : undefined,
        isProtected: !!(i.metadata && i.metadata.protected === true) || !!(i.metadata && i.metadata.sensitive === true) || (i.protectionLevel && i.protectionLevel !== 'none'),
        // === 归档字段：后端 archived 标志映射到本地条目 ===
        isArchived: !!i.archived,
        expiresAt: i.expires_at ?? null,
      }
    })
    if (append) {
      // 追加模式（加载更多）：把本页服务端条目中本地还没有的追加进去，避免重复。
      const existingIds = new Set(items.value.map(i => i.id))
      const merged = items.value.slice()
      for (const s of serverItems) {
        if (!existingIds.has(s.id)) merged.push(s)
      }
      // 释放被移除条目的 blob URL（追加模式通常不会移除，但保持一致性）
      releaseRemovedObjectUrls(merged)
      items.value = merged
    } else {
      // 整表刷新：先释放不再出现的旧图片 blob，再替换
      releaseRemovedObjectUrls([...localWithContent, ...serverItems])
      items.value = [...localWithContent, ...serverItems]
    }

    // 队列化加载图片：每批 3 张，间隔 200ms，避免并发过高被限流。
    // 已带有预览（blob/data URL）的条目跳过，避免重复拉取并生成新 blob。
    const imageQueue = serverItems.filter((i: ClipItem) => i.type === 'image' && !i.preview && !getCachedContent(i.id) && i.id)
    loadImagesFromQueue(imageQueue)
  } else {
    return
  }
  } finally {
    if (append) loadingMore.value = false; else loading.value = false
  }
}

export async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  const next = currentPage.value + 1
  await loadClipboardItems({ page: next, append: true })
  currentPage.value = next
}

// === 高级搜索：设备列表（用于筛选下拉）===
export async function loadDevices(): Promise<{ id: string; name: string; platform?: string }[]> {
  if (devicesCache.length > 0) return devicesCache
  try {
    const res = await api('GET', '/api/devices')
    const list = res.data?.devices || res.data
    if (res.ok && Array.isArray(list)) {
      devicesCache = list.map((d: any) => ({
        id: d.id,
        name: d.device_name || d.deviceName || d.id,
        platform: d.platform,
      }))
    }
  } catch (e: any) {
    console.warn('[Clipboard] loadDevices failed:', e?.message || e)
  }
  return devicesCache
}

// === 条目级内容更新（标签 / 条目级密码 protection 标记 / 内容本身）===
// 后端 PUT /api/clipboard/:id 做浅合并：只接受 metadata 白名单字段
// (protected/protectedAt/tags) 与可选的 content/contentPreview/contentSize。
export async function updateItemContent(
  itemId: string,
  payload: {
    metadata?: Record<string, any>
    content?: string
    contentPreview?: string
    contentSize?: number
  },
): Promise<boolean> {
  try {
    const res = await api('PUT', `/api/clipboard/${itemId}`, payload)
    if (!res.ok) {
      console.warn('[Clipboard] updateItemContent failed:', res.status, res.error)
      return false
    }
    // 乐观更新：把返回的最新值同步到本地列表对应条目，避免整表刷新闪烁。
    const updated = res.data
    if (updated) {
      const item = items.value.find(i => i.id === itemId)
      if (item) {
        if (updated.metadata !== undefined) {
          item.metadata = updated.metadata
          const meta = updated.metadata
          item.tags = Array.isArray(meta?.tags) ? meta.tags : item.tags
          item.isProtected = !!(meta && meta.protected === true)
        }
        if (updated.contentPreview !== undefined) item.preview = updated.contentPreview
        if (updated.contentSize !== undefined) item.contentSize = updated.contentSize
        if (updated.sourceDeviceId !== undefined) item.sourceDeviceId = updated.sourceDeviceId
      }
    }
    return true
  } catch (e: any) {
    console.warn('[Clipboard] updateItemContent error:', e?.message || e)
    return false
  }
}

// === 清空高级筛选并重新拉取 ===
export function clearAdvancedFilters() {
  advancedFilters.value = { deviceId: '', dateFrom: '', dateTo: '' }
  loadClipboardItems({ page: 1, append: false })
}

// 图片异步加载队列（防并发 + 防竞态 + 429 保护）
let imageLoadVersion = 0
let imageLoadPaused = false  // 429 时暂停队列，避免无效重试堆积
export async function loadImagesFromQueue(queue: ClipItem[]) {
  const version = ++imageLoadVersion  // 每次新加载递增，旧回调自动失效
  imageLoadPaused = false
  const DELAY = 800  // 每个请求间隔 800ms，避免触发 429
  for (let idx = 0; idx < queue.length; idx++) {
    // 版本检查：如果又有新的 loadClipboardItems 调用，放弃旧队列
    if (version !== imageLoadVersion || imageLoadPaused) return
    const item = queue[idx]
    try {
      const fullRes = await api('GET', `/api/clipboard/${item.id}`)
      if (version !== imageLoadVersion || imageLoadPaused) return  // 竞态检查

      // 429 保护：暂停队列，等待 60 秒后重试
      if (fullRes.status === 429) {
        console.warn(`[Clipboard] 429 on image load ${item.id}, pausing queue for 60s`)
        imageLoadPaused = true
        setTimeout(() => { imageLoadPaused = false }, 60000)
        return
      }

      if (fullRes.ok && fullRes.data?.contentEncrypted) {
        const raw = fullRes.data.contentEncrypted
        const isDataUrl = raw.startsWith('data:')
        let renderSrc: string
        if (isDataUrl) {
          renderSrc = raw
        } else {
          try {
            const imgRes = await apiBlob('GET', `/api/media/${item.id}/preview`)
            if (imgRes && imgRes.ok) {
              const blob = await imgRes.blob()
              renderSrc = URL.createObjectURL(blob)
            } else {
              renderSrc = ''
            }
          } catch {
            renderSrc = ''
          }
        }
        // 先更新预览图/内容——这是用户能看到图片的关键步骤，
        // 绝不能因为后面的缓存写入失败而被跳过（之前 quota 异常就跳过了这一步）。
        const current = items.value.find(x => x.id === item.id)
        if (current) {
          current.content = isDataUrl ? raw : ''
          // 用 setItemPreview 自动回收被替换的旧 blob URL，避免内存泄漏
          setItemPreview(current, renderSrc)
        }
        // 缓存放到最后，且 cacheContent 内部已 try/catch，绝不会回滚上面的显示。
        if (isDataUrl) cacheContent(item.id, raw)
      } else {
        console.warn(`[Clipboard] Failed to load image ${item.id}:`, fullRes.status, fullRes.error)
      }
    } catch (e) {
      console.warn(`[Clipboard] Image fetch error ${item.id}:`, e)
    }
    if (version !== imageLoadVersion || imageLoadPaused) return
    if (idx < queue.length - 1) {
      await new Promise(r => setTimeout(r, DELAY))
    }
  }
}
