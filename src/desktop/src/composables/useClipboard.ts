import { computed } from 'vue'
import { listen } from '@tauri-apps/api/event'
import * as tauri from '@/lib/tauri'
import { api, apiForm } from '@/api/client'
import { useItemPassword } from '@/composables/useItemPassword'
import { useConfigStore } from '@/stores/configStore'
import { useI18n } from '@/composables/useI18n'
import { initOfflineSync, getQueueSize } from '@/utils/offlineQueue'
import { chunkedUpload, shouldUseChunkedUpload } from '@/utils/chunkedUpload'
import { logger } from '@/utils/logger'
import {
  items,
  filteredItems,
  searchQuery,
  activeFilter,
  batchMode,
  polling,
  loading,
  totalItems,
  mainTotalItems,
  hasMore,
  loadingMore,
  currentPage,
  pageSize,
  currentView,
  selectedCount,
  allSelected,
  toggleSelectAll,
  clearSelection,
  advancedFilters,
  skipPollUntil,
  initialLoadDone,
  setInitialLoadDone,
  persistFilter,
  recentUploadHashes,
  HASH_TTL,
  type ClipItem,
  type ClipboardFilter,
} from './clipboardState'
import { cacheContent, clearContentCache } from './clipboardCache'
import {
  skipNextPolls,
  markContentCopiedFromClipSync,
  isClipboardChangeFromInternalCopy,
  copiedTexts,
  copiedItems,
  cleanupCopiedContent,
} from './clipboardDedup'
import { releaseRemovedObjectUrls, releaseAllObjectUrls } from './clipboardObjectUrls'
import { simpleHash, apiOrEnqueue, resizeImageIfNeeded } from './clipboardUpload'
import { enqueueClipboardTask } from './clipboardQueue'
import { loadClipboardItems, loadMore, loadDevices, updateItemContent, clearAdvancedFilters } from './clipboardLoad'

const { t } = useI18n()

export type { ClipItem, ClipboardFilter }

// 图片按 PNG content hash 去重（不是 Rust raw-DIB hash），避免某些剪贴板源
// （WeChat 截图、部分 GPU 驱动）的 raw bytes 碰撞导致后续截图被静默丢弃。
let lastImageSize = 0
let lastImageHash = ''
let lastBrowserText = ''

async function readAndUpload() {
  try {
    // 策略1: 时间戳跳过（复制后 3 秒内不处理，由 copyItem 设置）
    if (Date.now() < skipPollUntil) return

    if (!initialLoadDone) {
      // 第一次轮询：只记录当前剪贴板状态，不上传，避免启动时把当前已有内容重新上传。
      setInitialLoadDone(true)
      const imgInfo = await tauri.checkClipboardImageInfo().catch(() => ({ available: false, size: 0, hash: '' }))
      if (imgInfo.available) {
        // 用 PNG 内容哈希（与事件/兜底轮询同一套算法）作为启动基线，避免不同哈希族导致
        // 启动时的剪贴板图片被误判为新图而重传。
        const initData = await tauri.getClipboardImage().catch(() => '')
        if (initData) {
          lastImageHash = simpleHash(initData)
          lastImageSize = imgInfo.size
        }
      }
      return
    }

    // 优先尝试 Tauri API
    const files = await tauri.getClipboardFiles().catch(() => [] as string[])
    if (files.length > 0) {
      logger.debug('[Clipboard] poll detected files:', files)
      // 精确匹配：如果这是刚从 ClipSync 内部复制出去的文件路径，直接跳过
      if (isClipboardChangeFromInternalCopy({ filePaths: files }, 'file')) return
      enqueueClipboardTask({ type: 'file', payload: files })
      return
    }

    // Fallback 兜底轮询：事件驱动可能丢事件或 Rust raw-hash 误判，所以每隔 10s
    // 直接拉取当前剪贴板 PNG 并用自己的 PNG content hash 去重。
    const imgInfo = await tauri.checkClipboardImageInfo().catch(() => ({ available: false, size: 0, hash: '' }))
    if (imgInfo.available) {
      const imgData = await tauri.getClipboardImage().catch((e: any) => {
        console.warn('[Clipboard] fallback poll getClipboardImage failed:', e)
        return ''
      })
      if (imgData) {
        const pngHash = simpleHash(imgData)
        if (pngHash !== lastImageHash) {
          lastImageSize = imgInfo.size
          lastImageHash = pngHash
          enqueueClipboardTask({ type: 'image', payload: { dataUrl: imgData, size: imgInfo.size, hash: pngHash } })
        } else {
          logger.debug('[Clipboard] fallback poll: PNG hash matches last image, skipping')
        }
      }
      return
    }

    const text = await tauri.getClipboardContent().catch(() => '')
    if (text && text.trim()) {
      // 精确匹配：如果这是刚从 ClipSync 内部复制出去的文本，直接跳过
      if (isClipboardChangeFromInternalCopy({ content: text }, undefined)) return
      enqueueClipboardTask({ type: 'text', payload: text })
      return
    }

    // Fallback: 浏览器 Clipboard API (非 Tauri 环境)
    if (typeof navigator !== 'undefined' && navigator.clipboard && !(window as any).__TAURI__) {
      try {
        const clipText = await navigator.clipboard.readText().catch(() => '')
        if (clipText && clipText.trim() && clipText !== lastBrowserText) {
          lastBrowserText = clipText
          enqueueClipboardTask({ type: 'text', payload: clipText })
        }
      } catch {
        /* clipboard API 权限不足 */
      }
    }

    for (const [h, t] of recentUploadHashes) {
      if (Date.now() - t > HASH_TTL * 3) recentUploadHashes.delete(h)
    }
  } catch (e) {
    console.warn('[Clipboard] Poll error:', e)
  }
}

export function useClipboard() {
  // === Event-driven clipboard handler (from Rust clipboard_monitor.rs) ===
  let unlistenEvent: (() => void) | null = null

  async function handleClipboardEvent(payload: any) {
    try {
      if (Date.now() < skipPollUntil) return

      const contentType = payload?.contentType as string | undefined

      if (contentType === 'file') {
        // File event from Rust: content is preview text, filePaths is the array
        const filePaths = payload?.filePaths as string[] | undefined
        if (filePaths && filePaths.length > 0) {
          // If this file path was just copied from ClipSync UI, skip it
          if (isClipboardChangeFromInternalCopy(payload, 'file')) return

          logger.debug('[Clipboard] enqueue file event:', filePaths)
          enqueueClipboardTask({ type: 'file', payload: filePaths })
        }
      } else if (contentType === 'image') {
        // Image event from Rust. The monitor snapshots the PNG dataUrl AT DETECTION TIME
        // and ships it in payload.dataUrl. Use it directly — do NOT re-read the live
        // clipboard: rapid successive screenshots would all resolve to the last clipboard
        // image and only the last one would sync. Fall back to getClipboardImage() only
        // for older monitor builds that don't snapshot.
        if (Date.now() < skipPollUntil) return
        const size = (payload?.size as number | undefined) ?? 0
        const captured = (payload?.dataUrl as string | undefined) || ''
        logger.debug('[Clipboard] event: image received, size=', size, 'hasData=', !!captured)
        let imgData = captured
        if (!imgData) {
          imgData = await tauri.getClipboardImage().catch((e: any) => {
            console.error('[Clipboard] getClipboardImage failed:', e)
            return ''
          })
        }
        if (imgData) {
          // Dedup by the FULL PNG content hash (simpleHash over the entire dataUrl).
          // We deliberately do NOT use the Rust `eventHash` here: the monitor's PNG hash
          // (FNV-1a over bytes) is a different hash family than the JS simpleHash used by
          // the 10s fallback poll (readAndUpload), so mixing them would let the fallback
          // re-enqueue an already-synced image. One consistent hash across both paths is
          // what guarantees consecutive different screenshots all sync and none is re-uploaded.
          const dedupHash = simpleHash(imgData)
          if (dedupHash !== lastImageHash) {
            lastImageSize = size
            lastImageHash = dedupHash
            enqueueClipboardTask({ type: 'image', payload: { dataUrl: imgData, size, hash: dedupHash } })
          } else {
            logger.debug('[Clipboard] event: hash matches last image, skipping duplicate')
          }
        } else {
          console.warn('[Clipboard] Image data empty — capture failed')
        }
      } else if (!contentType) {
        // Text event from Rust: content is the clipboard text
        const text = payload?.content as string | undefined
        if (text && text.trim()) {
          // If this text was just copied from ClipSync UI, skip it
          if (isClipboardChangeFromInternalCopy(payload, undefined)) return
          enqueueClipboardTask({ type: 'text', payload: text })
        }
      }
    } catch (e) {
      console.warn('[Clipboard] Event handler error:', e)
    }
  }

  /** Auto-resume pending chunked uploads after page refresh */
  function resumePendingUploads() {
    try {
      const raw = localStorage.getItem('clipsync-chunked-upload')
      if (!raw) return
      const state = JSON.parse(raw)
      if (!state?.uploadId || !state?.filename) return

      // Check if session is still valid on server
      api('GET', `/api/upload/status/${state.uploadId}`)
        .then((res) => {
          if (res.ok && res.data?.missingChunks?.length > 0) {
            logger.debug(
              `[Clipboard] Resuming upload: ${state.filename} (${res.data.uploadedChunks?.length || 0}/${state.totalChunks} chunks)`,
            )
            // Find the item in the list and update its display
            const item = items.value.find((i) => i.content?.includes(state.filename))
            if (item) {
              const pct = Math.round(((res.data.uploadedChunks?.length || 0) / state.totalChunks) * 100)
              item.content = `${state.filename} (${pct}%) — resuming...`
            }
            // Note: actual resume requires the File object which is lost on refresh.
            // User needs to re-select the file to resume. Log this for now.
            logger.debug('[Clipboard] Upload session found but File object lost on refresh. Re-select file to resume.')
          } else {
            // Session expired or complete — clean up
            localStorage.removeItem('clipsync-chunked-upload')
          }
        })
        .catch(() => {
          localStorage.removeItem('clipsync-chunked-upload')
        })
    } catch {
      /* ignore */
    }
  }

  function startPolling(interval = 1500) {
    polling.value = true
    setInitialLoadDone(false)
    // Initialize offline queue: auto-flush on reconnect/focus
    initOfflineSync((count) => {
      logger.debug(`[Clipboard] Offline sync restored: ${count} actions synced`)
      loadClipboardItems() // Refresh list after offline sync
    })
    loadClipboardItems()

    // Auto-resume pending chunked uploads on page load
    resumePendingUploads()

    // --- Primary: event-driven via Rust clipboard monitor ---
    // The Rust thread polls the clipboard sequence number every 100ms and reads
    // bytes only when the OS reports a genuine change. Image PNG encoding runs in
    // a dedicated worker thread so rapid consecutive screenshots are not dropped
    // while the loop is blocked compressing the previous one.
    listen<any>('clipboard-changed', async (event) => {
      await handleClipboardEvent(event.payload)
    })
      .then((unlisten) => {
        unlistenEvent = unlisten
        logger.debug('[Clipboard] Listening for native clipboard-changed events')
      })
      .catch((err) => {
        console.warn('[Clipboard] Failed to attach event listener, falling back to polling:', err)
      })

    // --- Fallback: slow polling (every 10s) as safety net ---
    // If the Rust monitor is not running or events are missed, this ensures
    // clipboard changes are still detected. Dedup logic in readAndUpload()
    // prevents duplicate uploads when both events and poll fire.
    const fallbackId = setInterval(readAndUpload, 10000)

    return () => {
      polling.value = false
      unlistenEvent?.()
      unlistenEvent = null
      clearInterval(fallbackId)
    }
  }

  async function copyItem(item: ClipItem) {
    try {
      // === 条目级密码保护：受保护且未解锁的条目禁止复制 ===
      // 受保护且已解锁的条目：用会话内存中的明文（服务端存的是密文，不能从 /content 拉）。
      const itemPw = useItemPassword()
      if (itemPw.isItemProtected(item)) {
        if (!itemPw.isUnlocked(item.id)) {
          console.warn('[Clipboard] copy blocked: item is password protected and locked')
          return false
        }
      }

      // 精确内容去重：复制时记录会写入剪贴板的实际内容/路径，monitor 检测到相同内容时跳过
      // 窗口只开 3s：足够 monitor 下一次轮询跳过自身复制，同时不会误杀紧接着的外部复制。
      skipNextPolls(3000)
      markContentCopiedFromClipSync(item)

      if (item.type === 'file') {
        try {
          const parsed = JSON.parse(item.content)
          // 路径数组 ["D:\\path\\to\\file"] → 复制文件到剪贴板
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
            await tauri.setClipboardFiles(parsed)
            return true
          }
          // 带 paths 字段的元数据 {"name":"...","paths":["D:\\..."]} → 复制文件到剪贴板
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.paths) && parsed.paths.length > 0) {
            await tauri.setClipboardFiles(parsed.paths)
            return true
          }
          // 纯元数据对象（服务器上传的文件）→ 复制文件名
          if (parsed && typeof parsed === 'object' && parsed.name) {
            await tauri.setClipboardContent(parsed.name)
            return true
          }
          return false
        } catch {
          /* 解析失败 */
        }
        return false
      }
      if (item.type === 'image') {
        // 图片：优先用本地完整 data URL，否则从服务器获取完整内容
        let dataUrl = item.content || item.preview || ''
        if (!dataUrl || dataUrl.startsWith('[Image')) {
          try {
            const full = await api('GET', `/api/clipboard/${item.id}`)
            dataUrl = full.data?.contentEncrypted || full.data?.contentPreview || dataUrl
          } catch {
            /* ignore */
          }
        }
        if (dataUrl && !dataUrl.startsWith('[Image')) {
          // 优先写入实际图片格式
          try {
            const resp = await fetch(dataUrl)
            const blob = await resp.blob()
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          } catch {
            await tauri.setClipboardContent(dataUrl)
          }
          // 写入后记录当前剪贴板图片的哈希，避免兜底轮询把它当作新截图重新上传
          try {
            const info = await tauri.checkClipboardImageInfo()
            lastImageSize = info.size
            lastImageHash = info.hash || ''
          } catch {
            /* ignore */
          }
          return true
        }
        return false
      }

      // 文本/链接/代码：item.content 可能是服务端返回的 contentPreview（<=5000 字符）。
      // 如果已知 contentSize 且当前 content 不完整，先从服务器拉取完整内容再写入剪贴板。
      // 老数据 contentSize 可能为 0，对非空服务端条目也尝试拉取，确保不会只复制 200 字符预览。
      let textContent = item.content
      const isLocalItem = /^local-|^text-|^file-|^img-|^browser-/.test(item.id)
      const contentSize = item.contentSize || 0
      // 受保护且已解锁：服务端存的是密文，必须用会话内存里的明文，绝不向 /content 拉取。
      if (itemPw.isItemProtected(item) && itemPw.isUnlocked(item.id)) {
        textContent = itemPw.getUnlockedPlaintext(item.id) ?? item.content
      }
      const needsFetch =
        !isLocalItem &&
        !itemPw.isItemProtected(item) &&
        textContent.length > 0 &&
        (contentSize === 0 || textContent.length < contentSize)
      if (needsFetch) {
        try {
          const full = await api<{ contentEncrypted: string }>('GET', `/api/clipboard/${item.id}/content`)
          if (full.ok && full.data?.contentEncrypted) {
            textContent = full.data.contentEncrypted
            cacheContent(item.id, textContent)
          }
        } catch (e: any) {
          console.warn('[Clipboard] failed to fetch full text content for copy:', e?.message || e)
        }
      }
      // 记录实际写入剪贴板的内容，用于 monitor 去重。
      // 必须在这里重新记录，因为上面可能已经把 item.content（预览）替换成了完整内容；
      // 如果只按 item.content 去重，剪贴板里的完整文本和记录的预览不一致，会导致重复同步。
      const now = Date.now()
      copiedTexts.set(textContent, now)
      copiedItems.set(item.id, { type: item.type, content: textContent, timestamp: now })
      cleanupCopiedContent()

      await tauri.setClipboardContent(textContent)
      return true
    } catch (e: any) {
      console.warn('[Clipboard] copyItem failed:', e?.message || e)
      return false
    }
  }

  async function batchDelete(): Promise<number> {
    const selected = items.value.filter((i) => i.selected)
    const count = selected.length
    // 只删服务器上的（过滤掉所有本地临时 id）
    const serverIds = selected
      .map((i) => i.id)
      .filter(
        (id) =>
          !id.startsWith('local-') &&
          !id.startsWith('text-') &&
          !id.startsWith('img-') &&
          !id.startsWith('file-') &&
          !id.startsWith('browser-'),
      )
    let res: any = { ok: true, status: 200 }
    if (serverIds.length > 0) {
      res = await apiOrEnqueue('DELETE', '/api/clipboard', { ids: serverIds }, 'delete', { ids: serverIds })
      if (!res.ok && res.status !== 0) {
        console.error('[Clipboard] batchDelete server error:', res.status, res.error)
        throw new Error(res.error || `删除失败 (HTTP ${res.status})`)
      }
    }
    // 仅在服务端确认成功后才从本地列表移除选中项
    const selectedIds = new Set(selected.map((i) => i.id))
    const nextItems = items.value.filter((i) => !selectedIds.has(i.id))
    // 释放被删除条目占用的图片 blob URL
    releaseRemovedObjectUrls(nextItems)
    items.value = nextItems
    // 同步本地总数（后端是硬删）。不减会导致 hasMore/remaining 计算偏差，
    // 出现"加载更多"按钮卡在末尾删不掉项的情况。
    if (serverIds.length > 0 && (res.ok || res.status === 0)) {
      totalItems.value = Math.max(0, totalItems.value - serverIds.length)
      if (currentView.value !== 'archive') {
        mainTotalItems.value = Math.max(0, mainTotalItems.value - serverIds.length)
      }
    }
    // 批量删除后跳过轮询，防止系统剪贴板内容被重新上传
    skipNextPolls(3000)
    return count
  }

  async function deleteSingle(item: ClipItem) {
    const isLocal = item.id.startsWith('local-') || item.id.startsWith('text-') || item.id.startsWith('img-')
    let res: any = { ok: true, status: 200 }
    if (!isLocal) {
      res = await apiOrEnqueue('DELETE', `/api/clipboard/${item.id}`, undefined, 'delete', { id: item.id })
      if (!res.ok && res.status !== 0) {
        console.error('[Clipboard] deleteSingle server error:', res.status, res.error)
        throw new Error(res.error || `删除失败 (HTTP ${res.status})`)
      }
    }
    // 仅在服务端确认成功（或是本地临时项）后才从本地列表移除
    const nextItems = items.value.filter((i) => i.id !== item.id)
    // 释放被删除条目占用的图片 blob URL
    releaseRemovedObjectUrls(nextItems)
    items.value = nextItems
    // 同步本地总数（后端是硬删），保持 hasMore/remaining 计算正确
    if (!isLocal && res && (res.ok || res.status === 0)) {
      totalItems.value = Math.max(0, totalItems.value - 1)
      if (currentView.value !== 'archive') {
        mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
      }
    }
    // 删除后跳过轮询，防止系统剪贴板内容被重新上传
    skipNextPolls(3000)
  }

  async function toggleFavorite(item: ClipItem) {
    // 乐观更新
    const prev = (item as any).isFavorite
    const prevFavAt = (item as any).favoritedAt
    ;(item as any).isFavorite = !prev
    ;(item as any).favoritedAt = !prev ? Date.now() : undefined
    const res = await api('PUT', `/api/clipboard/${item.id}/favorite`)
    if (!res.ok) {
      // 回滚
      ;(item as any).isFavorite = prev
      ;(item as any).favoritedAt = prevFavAt
      console.warn('[Clipboard] toggleFavorite failed:', res.error)
    }
  }

  /**
   * 归档条目：调用 PUT /api/clipboard/:id { archived: true }。
   * 乐观更新本地 isArchived 并从当前列表移除（后端 view=all 默认排除 archived，
   * 移除可避免"归档后还留在主列表"的感知错位）。失败回滚。
   */
  async function archiveItem(item: ClipItem): Promise<boolean> {
    const prev = item.isArchived
    item.isArchived = true
    try {
      const res = await api('PUT', `/api/clipboard/${item.id}`, { archived: true })
      if (!res.ok) {
        item.isArchived = prev
        console.warn('[Clipboard] archiveItem failed:', res.error)
        return false
      }
      // 从当前视图移除（归档视图由 view=archive 单独拉取）
      const next = items.value.filter((i) => i.id !== item.id)
      releaseRemovedObjectUrls(next)
      items.value = next
      if (totalItems.value > 0) totalItems.value = Math.max(0, totalItems.value - 1)
      if (currentView.value !== 'archive') {
        mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
      }
      skipNextPolls(3000)
      return true
    } catch (e: any) {
      item.isArchived = prev
      console.warn('[Clipboard] archiveItem error:', e?.message || e)
      return false
    }
  }

  /**
   * 取消归档：调用 PUT /api/clipboard/:id { archived: false }。
   * 乐观更新并从当前（归档）视图移除；失败回滚。
   */
  async function unarchiveItem(item: ClipItem): Promise<boolean> {
    const prev = item.isArchived
    item.isArchived = false
    try {
      const res = await api('PUT', `/api/clipboard/${item.id}`, { archived: false })
      if (!res.ok) {
        item.isArchived = prev
        console.warn('[Clipboard] unarchiveItem failed:', res.error)
        return false
      }
      const next = items.value.filter((i) => i.id !== item.id)
      releaseRemovedObjectUrls(next)
      items.value = next
      if (totalItems.value > 0) totalItems.value = Math.max(0, totalItems.value - 1)
      mainTotalItems.value += 1
      skipNextPolls(3000)
      return true
    } catch (e: any) {
      item.isArchived = prev
      console.warn('[Clipboard] unarchiveItem error:', e?.message || e)
      return false
    }
  }

  /**
   * 设置/清除用户侧自动过期：调用 PUT /api/clipboard/:id { expiresAt }。
   * iso 为 null 表示清除过期；否则传 ISO 字符串。乐观更新本地 expiresAt，失败回滚。
   */
  async function setExpiry(item: ClipItem, iso: string | null): Promise<boolean> {
    const prev = item.expiresAt
    item.expiresAt = iso
    try {
      const res = await api('PUT', `/api/clipboard/${item.id}`, { expiresAt: iso })
      if (!res.ok) {
        item.expiresAt = prev
        console.warn('[Clipboard] setExpiry failed:', res.error)
        return false
      }
      skipNextPolls(3000)
      return true
    } catch (e: any) {
      item.expiresAt = prev
      console.warn('[Clipboard] setExpiry error:', e?.message || e)
      return false
    }
  }

  function setFilter(f: ClipboardFilter) {
    if (activeFilter.value === f) return
    activeFilter.value = f
    persistFilter(f)
    // 切换分类后必须按新分类重新从后端拉取，否则总数/剩余数都是按全部类型算的。
    loadClipboardItems({ page: 1, append: false })
  }
  function setSearch(q: string) {
    searchQuery.value = q
  }
  function toggleBatch() {
    batchMode.value = !batchMode.value
    if (!batchMode.value) clearSelection()
  }

  /** 从文件选择器上传文件到剪贴板 */
  async function uploadFileItem(file: File): Promise<void> {
    // 按套餐分级限制上传大小（2026-07-07 调整）
    // Free: 128MB, Pro: 256MB, Enterprise: 1GB
    const configStore = useConfigStore()
    const planLimits: Record<string, number> = {
      Free: 128,
      free: 128,
      免费版: 128,
      Pro: 256,
      pro: 256,
      专业版: 256,
      Enterprise: 1024,
      enterprise: 1024,
      企业版: 1024,
    }
    const userPlan = configStore.user.plan || 'Free'
    const maxMb = planLimits[userPlan] || 128 // 默认免费版 128MB
    const maxBytes = maxMb * 1024 * 1024

    if (file.size > maxBytes) {
      const sizeStr =
        file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(0)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`
      throw new Error(`${t('file_exceeds_plan', { size: sizeStr, limit: `${maxMb}MB`, plan: userPlan })}`)
    }
    const sizeStr =
      file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`
    // 上传文件不包含本地路径（文件已上传到服务器，其他设备从服务器访问）
    const displayContent = JSON.stringify({ name: file.name, size: sizeStr, type: file.type || 'unknown' })

    // 乐观更新
    const localId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    items.value.unshift({
      id: localId,
      type: 'file',
      content: displayContent,
      source: 'Desktop',
      timestamp: Date.now(),
    })

    let deviceId: string | null = localStorage.getItem('clipsync-device-id')
    if (!deviceId) {
      try {
        const devRes = await api('GET', '/api/devices')
        const devList = devRes.data?.devices || devRes.data
        if (devRes.ok && Array.isArray(devList) && devList.length > 0) {
          deviceId = devList[0].id || devList[0].device_id || null
          if (deviceId) localStorage.setItem('clipsync-device-id', deviceId)
        }
      } catch {
        /* ignore */
      }
    }
    if (!deviceId) throw new Error('No device ID')

    // 判断文件类型走不同上传路径
    if (file.type.startsWith('image/')) {
      // 图片 → 转 base64 data URL，大图压缩后上传
      const reader = new FileReader()
      const rawDataUrl: string = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsDataURL(file)
      })
      const dataUrl = await resizeImageIfNeeded(rawDataUrl)
      const res = await api('POST', '/api/clipboard', {
        contentType: 'image',
        content: dataUrl,
        contentEncrypted: dataUrl,
        sourceDeviceId: deviceId,
        mimeType: file.type,
        size: file.size,
        contentPreview: `[Image ${file.name}]`,
      })
      if (res.ok && res.data?.id) {
        const item = items.value.find((i) => i.id === localId)
        if (item) {
          item.id = res.data.id
          item.type = 'image'
          item.content = dataUrl
          item.preview = dataUrl
        }
        cacheContent(res.data.id, dataUrl)
      }
    } else if (shouldUseChunkedUpload(file)) {
      // Large file (>10MB) → 先创建条目，再分片上传，支持断点续传
      try {
        // Step 1: 在服务器创建条目（元数据）
        const createRes = await api('POST', '/api/clipboard', {
          contentType: 'file',
          content: displayContent,
          contentEncrypted: displayContent,
          sourceDeviceId: deviceId,
          mimeType: file.type,
          size: file.size,
          contentPreview: `${file.name} (${sizeStr})`,
        })
        const serverId = createRes.data?.id
        if (serverId) {
          const item = items.value.find((i) => i.id === localId)
          if (item) item.id = serverId
        }
        // Step 2: 分片上传（localStorage 保存进度，支持刷新后恢复）
        await chunkedUpload(file, (progress) => {
          const item = items.value.find((i) => i.id === (serverId || localId))
          if (item && !progress.done) {
            item.content = `${file.name} (${progress.percent}%)`
          }
        })
        // Step 3: 上传完成，更新最终内容
        const finalItem = items.value.find((i) => i.id === (serverId || localId))
        if (finalItem) finalItem.content = displayContent
      } catch (e: any) {
        console.error('[Clipboard] Chunked upload failed:', e)
        throw e
      }
    } else {
      // Small file → upload via media/file endpoint (saves to disk, enables preview)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('sourceDeviceId', deviceId)

      const res = await apiForm('/api/media/file', formData)
      if (res.ok && res.data?.id) {
        const item = items.value.find((i) => i.id === localId)
        if (item) {
          item.id = res.data.id
          // Update content with server metadata for display
          item.content = JSON.stringify({
            name: file.name,
            size: sizeStr,
            type: file.type || 'unknown',
            serverFilename: res.data.contentEncrypted,
          })
          cacheContent(res.data.id, item.content)
        }
      } else {
        throw new Error(res.error || 'Upload failed')
      }
      return // early return, already handled
    }
  }

  // 检测内容是否包含敏感信息（API key、密码、token、私钥等）
  function isSensitiveContent(text: string): boolean {
    if (!text || text.length > 5000) return false
    const t = text.trim()
    // AI/Cloud API keys with known prefixes
    if (/\b(AKIA|AIza|sk-or-v1-|sk-proj-|sk-ant-|sk-)[A-Za-z0-9]{16,}\b/.test(t)) return true
    // GitHub personal access token
    if (/\bghp_[A-Za-z0-9]{36}\b/.test(t)) return true
    // Stripe secret key
    if (/\bsk_live_[A-Za-z0-9]{24,}\b/.test(t)) return true
    // Slack token
    if (/\bxox[baprs]-[A-Za-z0-9-]+/.test(t)) return true
    // Generic Bearer / Authorization tokens
    if (/Bearer\s+[A-Za-z0-9_.-]{20,}/i.test(t)) return true
    // Private keys
    if (/-----BEGIN\s+(RSA|EC|OPENSSH|DSA|PGP)\s+PRIVATE\s+Key-----/.test(t)) return true
    // Password patterns
    if (/^(password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*.{4,}$/im.test(t)) return true
    // Long base64-looking secrets (32+ chars)
    if (/\b[A-Za-z0-9_-]{40,}\b/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t)) return true
    // Connection strings with embedded passwords
    if (/(mongodb|mysql|postgres|redis|amqp):\/\/[^:]+:([^@]+)@/.test(t)) return true
    return false
  }

  const offlineQueueSize = computed(() => getQueueSize())

  /** 清空所有图片 blob URL（登出 / 切换账号时调用，防止旧账号图片常驻内存） */
  function resetImages() {
    releaseAllObjectUrls()
  }

  // 把任意文本写入剪贴板，复用与 copyItem 文本路径相同的去重逻辑：
  // 记录内容 + 暂停 monitor 轮询 3s，避免 ClipSync 自身写入被 monitor 当成新剪贴同步。
  async function copyText(text: string): Promise<boolean> {
    try {
      if (!text) return false
      skipNextPolls(3000)
      const now = Date.now()
      copiedTexts.set(text, now)
      cleanupCopiedContent()
      await tauri.setClipboardContent(text)
      return true
    } catch (e: any) {
      console.warn('[Clipboard] copyText failed:', e?.message || e)
      return false
    }
  }

  return {
    items,
    filteredItems,
    searchQuery,
    activeFilter,
    batchMode,
    polling,
    loading,
    offlineQueueSize,
    totalItems,
    mainTotalItems,
    hasMore,
    loadingMore,
    loadMore,
    currentPage,
    pageSize,
    selectedCount,
    allSelected,
    startPolling,
    copyItem,
    copyText,
    toggleSelectAll,
    clearSelection,
    batchDelete,
    deleteSingle,
    toggleFavorite,
    archiveItem,
    unarchiveItem,
    setExpiry,
    loadClipboardItems,
    setFilter,
    setSearch,
    toggleBatch,
    uploadFileItem,
    refresh: loadClipboardItems,
    resetImages,
    clearContentCache,
    isSensitiveContent,
    // === 高级搜索 / 条目级密码 ===
    advancedFilters,
    loadDevices,
    updateItemContent,
    clearAdvancedFilters,
  }
}
