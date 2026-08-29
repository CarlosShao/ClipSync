// === 剪贴板数据加载（分页拉取 / 图片异步队列 / 设备列表 / 条目更新） ===
import { api, apiBlob } from '@/api/client'
import { logger }from '@/utils/logger'
import { useSonner } from './useSonner'
import { useI18n } from '@/composables/useI18n'
import {
  items,
  loading,
  loadingMore,
  currentPage,
  pageSize,
  currentView,
  totalItems,
  mainTotalItems,
  loadError,
  hasMore,
  activeFilter,
  advancedFilters,
  searchQuery,
  maxHistoryCap,
  type ClipItem,
} from './clipboardState'
import { getCachedContent, cacheContent } from './clipboardCache'
import { setItemPreview, releaseRemovedObjectUrls } from './clipboardObjectUrls'
import { resolveDeviceName } from './useDevice'

const { tf } = useI18n()

// 设备列表（用于筛选下拉），懒加载 + 内存缓存，避免每次打开筛选面板都打 /api/devices
let devicesCache: { id: string; name: string; platform?: string }[] = []

// === 删除感知（墓碑）同步游标 ===
// 每次成功拉取列表后记录同步点；WS 重连注册成功后用 since 拉取断线窗口内的删除流水，
// 把其他设备已删除的条目从本地列表移除（新增条目靠 refresh 第一页覆盖，删除只有墓碑能感知）。
const LAST_SYNC_KEY = 'clipsync-last-sync-at'
// 5 秒回拨余量：吸收客户端与服务端时钟漂移，宁可墓碑多查不可漏
const SYNC_OVERLAP_MS = 5000

function touchLastSyncAt() {
  try {
    localStorage.setItem(LAST_SYNC_KEY, new Date(Date.now() - SYNC_OVERLAP_MS).toISOString())
  } catch {
    /* localStorage 不可用时跳过 */
  }
}

export async function syncDeletions(): Promise<{ removed: number } | null> {
  try {
    const since = localStorage.getItem(LAST_SYNC_KEY)
    if (!since) {
      // 首次（无同步点）：拉一次列表后自然建立游标，无需回溯历史删除
      touchLastSyncAt()
      return { removed: 0 }
    }
    const res = await api('GET', `/api/clipboard/sync-deletions?since=${encodeURIComponent(since)}`)
    if (!res.ok || !Array.isArray(res.data?.deletions)) return null
    const deletedIds = new Set<string>(res.data.deletions.map((d: any) => d.itemId))
    // 推进游标到服务端时间（服务端为准，避免本地时钟漂移累积）
    if (res.data?.serverTime) {
      try {
        localStorage.setItem(LAST_SYNC_KEY, new Date(new Date(res.data.serverTime).getTime() - SYNC_OVERLAP_MS).toISOString())
      } catch {
        /* ignore */
      }
    }
    if (deletedIds.size === 0) return { removed: 0 }

    const before = items.value.length
    const kept = items.value.filter((i) => !deletedIds.has(i.id))
    const removed = before - kept.length
    if (removed > 0) {
      releaseRemovedObjectUrls(kept)
      items.value = kept
      totalItems.value = Math.max(0, totalItems.value - removed)
      // 仅主视图修正侧边栏计数；归档视图的 totalItems 语义不同，不强行覆盖
      if (currentView.value !== 'archive') {
        mainTotalItems.value = Math.max(0, mainTotalItems.value - removed)
      }
    }
    return { removed }
  } catch (e: any) {
    console.warn('[Clipboard] syncDeletions failed:', e?.message || e)
    return null
  }
}

/**
 * 按「历史保留上限」设置（configStore.maxHistory）裁剪本地列表（B8②）。
 * 只裁本地持有的条目，不改写 totalItems —— 那是服务端真实总数，
 * 侧边栏计数依赖它，跟着裁会随设置跳动。
 */
export function trimToMaxHistory() {
  const cap = maxHistoryCap.value
  if (!cap || cap <= 0) return
  if (items.value.length <= cap) return
  const kept = items.value.slice(0, cap)
  // 先回收被裁掉条目的图片 blob URL，再替换数组
  releaseRemovedObjectUrls(kept)
  items.value = kept
}

export async function loadClipboardItems(opts?: {
  page?: number
  append?: boolean
  all?: boolean
  favorite?: boolean
  view?: 'all' | 'archive'
  /** 覆盖每页条数（收藏页按 pageSize 分页，不再一次性拉 200 条） */
  limit?: number
}) {
  const page = opts?.page ?? 1
  const append = opts?.append ?? false
  const loadAll = opts?.all ?? false
  const loadFavorites = opts?.favorite ?? false
  // 视图：归档视图(view=archive)只拉 archived=TRUE 的条目；默认沿用 currentView，
  // 保证分类切换/加载更多时不丢失归档上下文。
  const view = opts?.view || currentView.value
  currentView.value = view
  if (!append) currentPage.value = page
  if (append) loadingMore.value = true
  else loading.value = true
  const limit = opts?.limit ?? (loadAll ? 500 : pageSize.value)
  const favParam = loadFavorites ? '&favorites=true' : ''
  const viewParam = view === 'archive' ? '&view=archive' : ''
  // 按当前分类筛选：后端直接过滤并返回该类型总数，避免"图片分类下显示全部总数"的 bug。
  // 注意 filter 值与后端 content_type 的映射：images -> image，links -> link，files -> file。
  const filterToContentType: Record<string, string> = { text: 'text', images: 'image', links: 'link', files: 'file' }
  const contentType = !loadAll && !loadFavorites ? filterToContentType[activeFilter.value] || '' : ''
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
  const q = searchQuery.value.trim()
  const searchParam = q ? `&search=${encodeURIComponent(q)}` : ''
  console.log(`[Clipboard] loadClipboardItems: page=${page}, append=${append}, limit=${limit}`)
  try {
    const res = await api(
      'GET',
      `/api/clipboard?page=${page}&limit=${limit}${loadAll ? '&all=true' : ''}${favParam}${typeParam}${advParamStr}${viewParam}${searchParam}`,
    )
    console.log(`[Clipboard] loadClipboardItems response: ok=${res.ok}, status=${res.status}, items count=${Array.isArray(res.data?.items) ? res.data.items.length : 'N/A'}`)
    if (res.ok && Array.isArray(res.data?.items)) {
      // 成功响应即推进删除感知同步点（含 append 空页分支，均为有效同步时刻）
      touchLastSyncAt()
      loadError.value = null
      // 后端返回空数组 = 没更多数据了。用实际条目数修正 totalItems，
      // 避免 pagination.total 虚高导致 hasMore 永远为 true、加载更多按钮卡住。
      if (res.data.items.length === 0 && append) {
        console.warn(`[Clipboard] page ${page} returned 0 items, correcting totalItems from ${totalItems.value} to ${items.value.length}`)
        totalItems.value = items.value.length
        // 收藏分支拉的是收藏子集，绝不能拿它覆盖侧边栏的剪贴板总数
        if (view !== 'archive' && !loadFavorites) mainTotalItems.value = totalItems.value
        return true
      }
      totalItems.value = res.data?.pagination?.total ?? res.data.items.length
      // 仅在主视图（all）更新侧边栏计数：归档视图不覆盖主视图总数，
      // 收藏页（favorites=true）返回的是收藏子集数量，同样不能覆盖。
      if (view !== 'archive' && !loadFavorites) {
        mainTotalItems.value = totalItems.value
      }
      const serverIds = new Set(res.data.items.map((i: any) => i.id))
      // Build set of server content previews for dedup
      const serverContentPreviews = new Set(res.data.items.map((i: any) => (i.contentPreview || '').slice(0, 100)))
      // 整表刷新时只保留本地乐观更新项（临时 ID），避免切换分类/收藏夹后旧分类的服务器条目
      // 因为不在新分类第一页而被残留到列表最前面，导致“切到全部后链接/收藏数据置顶”的错乱。
      const localWithContent = items.value.filter((i) => {
        // 仅保留本地临时 ID 的乐观项；正式服务器 ID 的条目应当完全由本次接口返回决定顺序与内容。
        const isLocal =
          i.id.startsWith('local-') ||
          i.id.startsWith('text-') ||
          i.id.startsWith('img-') ||
          i.id.startsWith('browser-')
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
        const existingImage = isImage ? items.value.find((e) => e.id === i.id && e.type === 'image') : undefined
        const existingPreview = existingImage?.preview || ''
        const cachedContent = getCachedContent(i.id)
        let content: string
        if (isImage) {
          content = cachedContent || ''
          // 图片异步加载：不在这里触发，统一放到下面的队列
        } else {
          const existing = items.value.find((e) => e.id === i.id && e.content)
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
            } catch {
              /* no metadata or not JSON */
            }
          }
          // For file items: ensure content is a displayable filename, not raw content
          // BUT preserve paths field if it was reconstructed from metadata
          const hasPaths = (() => {
            try {
              const p = JSON.parse(content)
              return p && typeof p === 'object' && Array.isArray(p.paths)
            } catch {
              return false
            }
          })()
          if ((i.contentType || i.type) === 'file' && content.length > 200 && !hasPaths) {
            // content is too long to be a filename — extract from metadata
            try {
              const rawMeta = typeof i.metadata === 'string' ? i.metadata : JSON.stringify(i.metadata || {})
              const meta = JSON.parse(rawMeta || '{}')
              if (meta.originalName) content = meta.originalName
              else if (meta.name) content = meta.name
            } catch {
              /* not JSON */
            }
            // Still too long? Use contentPreview as filename
            if (content.length > 200 && i.contentPreview) {
              content = i.contentPreview.split(/[/\\]/).pop() || i.contentPreview
            }
          }
        }
        const preview = isImage ? cachedContent || existingPreview || '' : content
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
            // metadata 可能是 JSON 字符串（兼容）或已解析对象（pg jsonb）；统一归一为对象，
            // 同步服务端 protectionLevel 标记（含富文本捕获的 metadata.html）
            let meta: any = {}
            if (typeof i.metadata === 'string') {
              try {
                meta = JSON.parse(i.metadata) || {}
              } catch {
                /* keep {} */
              }
            } else if (i.metadata && typeof i.metadata === 'object') {
              meta = { ...i.metadata }
            }
            if (i.protectionLevel === 'advanced') meta.protected = true
            else if (i.protectionLevel === 'pin') meta.sensitive = true
            return meta
          })(),
          contentSize: i.contentSize,
          // === 高级搜索 / 条目级密码 / 置顶 ===
          sourceDeviceId: i.sourceDevice?.id || i.sourceDeviceId || undefined,
          tags: i.metadata && Array.isArray(i.metadata.tags) ? i.metadata.tags : undefined,
          pinned: !!(i.metadata && i.metadata.pinned === true),
          isProtected:
            !!(i.metadata && i.metadata.protected === true) ||
            !!(i.metadata && i.metadata.sensitive === true) ||
            (i.protectionLevel && i.protectionLevel !== 'none'),
          // === 归档字段：后端 archived 标志映射到本地条目 ===
          isArchived: !!i.archived,
          expiresAt: i.expires_at ?? null,
        }
      })
      if (append) {
        // 追加模式（加载更多）：把本页服务端条目中本地还没有的追加进去，避免重复。
        const existingIds = new Set(items.value.map((i) => i.id))
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
      // 历史保留上限（B8②）：置顶项已由 resortPinned 前置，裁尾不会误删
      trimToMaxHistory()

      // 队列化加载图片：每批 3 张，间隔 200ms，避免并发过高被限流。
      // 已带有预览（blob/data URL）的条目跳过，避免重复拉取并生成新 blob。
      const imageQueue = serverItems.filter(
        (i: ClipItem) => i.type === 'image' && !i.preview && !getCachedContent(i.id) && i.id,
      )
      loadImagesFromQueue(imageQueue)
      return true
    } else {
      // 429 限流 / 网络错误等：给用户友好提示
      const { show: showToast, rateLimited } = useSonner()
      if (res.status === 429) {
        // 真实对应限流结束时间的倒计时提示
        if (res.retryAfter && res.retryAfter > 0) {
          rateLimited(res.retryAfter)
        } else {
          showToast(tf('rate_limit_warn', '操作过于频繁，请稍后再试'), 'warning', 4000)
        }
      } else if (res.status >= 500) {
        showToast(tf('clip_server_error', '服务器错误 ({status})', { status: res.status }), 'error')
      }
      // 置错误态：界面据此渲染"加载失败 + 重试"而不是空态，
      // 否则失败与"确实没有数据"无法区分，用户也没有重试入口。
      loadError.value = res.error || tf('clip_load_fail_status', '加载失败 ({status})', { status: res.status || 'network' })
      return false
    }
  } catch (e: any) {
    console.warn(`[Clipboard] loadClipboardItems error: page=${page}`, e?.message || e)
    loadError.value = e?.message || tf('load_failed_title', '加载失败')
    return false
  } finally {
    if (append) loadingMore.value = false
    else loading.value = false
  }
}

export async function loadMore() {
  console.log(`[Clipboard] loadMore called: loadingMore=${loadingMore.value}, hasMore=${hasMore.value}, currentPage=${currentPage.value}`)
  if (loadingMore.value || !hasMore.value) {
    console.warn(`[Clipboard] loadMore blocked: loadingMore=${loadingMore.value}, hasMore=${hasMore.value}`)
    return
  }
  const next = currentPage.value + 1
  console.log(`[Clipboard] loadMore requesting page ${next}...`)
  // 只在成功时推进页码：失败推进会永久跳过这一页（重试拿到的是再下一页的数据，
  // 中间那页在本次会话里再也取不回来）。
  try {
    const ok = await loadClipboardItems({ page: next, append: true })
    if (!ok) {
      console.warn(`[Clipboard] loadMore page ${next} failed, keeping page at ${currentPage.value}`)
    } else {
      currentPage.value = next
      console.log(`[Clipboard] loadMore page ${next} succeeded, items now: ${items.value.length}/${totalItems.value}`)
    }
  } catch (e) {
    console.error(`[Clipboard] loadMore page ${next} threw exception:`, e)
  }
}

// === 高级搜索：设备列表（用于筛选下拉）===
export async function loadDevices(): Promise<{ id: string; name: string; platform?: string }[]> {
  if (devicesCache.length > 0) return devicesCache
  try {
    const res = await api('GET', '/api/devices')
    const list = Array.isArray(res.data) ? res.data : res.data?.devices
    if (res.ok && Array.isArray(list)) {
      // 设备名统一走 resolveDeviceName（与设备列表同源），避免下拉里出现裸 id
      devicesCache = list.map((d: any) => ({
        id: d.id,
        name: resolveDeviceName(d),
        platform: d.platform,
      }))
    }
  } catch (e: any) {
    console.warn('[Clipboard] loadDevices failed:', e?.message || e)
  }
  return devicesCache
}

// === 条目级内容更新（标签 / 条目级密码 protection 标记 / 内容本身）===
// 版本快照**不在这里做**：服务端 `PUT /api/clipboard/:id` 在真正 UPDATE 之前已经
// SELECT 出旧 content_encrypted 并调 createVersion() 落版本，失败静默。
// 前端不要再补一份 —— 两者抓的都是"更新前的旧内容"，同时开会产生内容重复的两条版本。
// 服务端方案还额外覆盖移动端/网页端的内容变更，前端快照只覆盖桌面端。
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
      const item = items.value.find((i) => i.id === itemId)
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
let imageLoadPaused = false // 429 时暂停队列，避免无效重试堆积
const IMAGE_CONCURRENCY = 6 // 并发数：浏览器同域名通常 6 连接，与之一致
export async function loadImagesFromQueue(queue: ClipItem[]) {
  if (!queue.length) return
  const version = ++imageLoadVersion // 每次新加载递增，旧回调自动失效
  imageLoadPaused = false

  // 用信号量控制并发：同时最多 IMAGE_CONCURRENCY 个请求在飞，
  // 替代原来串行 800ms 间隔的方案（50 张图需 40s+，用户体验差）。
  async function loadImage(item: ClipItem): Promise<void> {
    if (version !== imageLoadVersion || imageLoadPaused) return
    try {
      const fullRes = await api('GET', `/api/clipboard/${item.id}`)
      if (version !== imageLoadVersion || imageLoadPaused) return // 竞态检查

      // 429 保护：暂停队列，等待 60 秒后重试
      if (fullRes.status === 429) {
        console.warn(`[Clipboard] 429 on image load ${item.id}, pausing queue for 60s`)
        imageLoadPaused = true
        setTimeout(() => {
          imageLoadPaused = false
        }, 60000)
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
        const current = items.value.find((x) => x.id === item.id)
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
  }

  // 并发池：分批执行，每批最多 IMAGE_CONCURRENCY 个，一批完成后再启动下一批。
  // 这样既保证并发速度（6 张同时飞），又避免一次性全发导致 429/内存暴涨。
  for (let i = 0; i < queue.length; i += IMAGE_CONCURRENCY) {
    if (version !== imageLoadVersion || imageLoadPaused) return
    const batch = queue.slice(i, i + IMAGE_CONCURRENCY)
    await Promise.all(batch.map(loadImage))
  }
}

// ============ AI 数据刷新事件监听 ============
// 当 AI Agent 执行剪贴板相关工具后，自动刷新数据实现无感更新
import { onAiDataRefresh } from './useAiDataRefresh'

if (typeof window !== 'undefined' && !(window as any).__clipboardAiRefreshInited) {
  ;(window as any).__clipboardAiRefreshInited = true
  
  onAiDataRefresh((event) => {
    if (event.type === 'clipboard') {
      // 静默刷新剪贴板数据（不带 loading 状态，实现无感刷新）
      loadClipboardItems({ page: 1, append: false }).catch(() => {})
    }
  })
}
