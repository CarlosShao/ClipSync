import { computed, ref } from 'vue'
import { listen } from '@tauri-apps/api/event'
import * as tauri from '@/lib/tauri'
import { api, apiForm, apiBlob } from '@/api/client'
import { recordUse } from '@/api/clipboard'
import { useItemPassword } from '@/composables/useItemPassword'
import { usePlanLimits } from '@/composables/usePlanLimits'
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
  loadError,
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
  pollIntervalMs,
  maxHistoryCap,
  type ClipItem,
  type ClipboardFilter,
} from './clipboardState'
import { cacheContent, clearContentCache } from './clipboardCache'
import {
  skipNextPolls,
  markContentCopiedFromClipSync,
  markImageCopiedFromClipSync,
  isClipboardChangeFromInternalCopy,
  copiedTexts,
  copiedItems,
  cleanupCopiedContent,
} from './clipboardDedup'
import { releaseRemovedObjectUrls, releaseAllObjectUrls } from './clipboardObjectUrls'
import { simpleHash, apiOrEnqueue, prepareImageForUpload, dataUrlMime, ensureDeviceId } from './clipboardUpload'
import { handleQuotaResponse, markHandledQuota } from './useUploadLimitNotice'
import { enqueueClipboardTask } from './clipboardQueue'
import {
  loadClipboardItems,
  loadMore,
  loadDevices,
  updateItemContent,
  clearAdvancedFilters,
  syncDeletions,
  trimToMaxHistory,
} from './clipboardLoad'

const { t, tf } = useI18n()

export type { ClipItem, ClipboardFilter }

// 图片按 PNG content hash 去重（不是 Rust raw-DIB hash），避免某些剪贴板源
// （WeChat 截图、部分 GPU 驱动）的 raw bytes 碰撞导致后续截图被静默丢弃。
let lastImageSize = 0
// 主去重键：JS 族哈希 simpleHash(dataUrl)，事件路径与兜底轮询都用这一把。
let lastImageHash = ''
// 副去重键：Rust 族哈希（checkClipboardImageInfo 返回的 fnv64，哈希对象不同）。
// 两把键必须同时登记 —— 只登记其中一把，另一条路径必然把自身回写当成新图。
let lastImageRustHash = ''
let lastBrowserText = ''

// 兜底轮询间隔由 pollIntervalMs 提供（B8①：消费 configStore.syncInterval）。
// 默认 10s，与改造前行为一致；设为 0 表示纯事件驱动、不再兜底轮询。
const DEFAULT_POLL_INTERVAL = 10_000
// 复制后的 skip 窗口必须 >= 兜底轮询间隔 + 余量，否则复制后下一次兜底轮询仍会落在
// 窗口外，把刚刚写回剪贴板的内容当成外部新内容重新上传。
// 这里刻意用固定值而不跟随 pollIntervalMs：窗口要挡的是 Rust monitor 的事件路径
// （700ms 级），若跟着 15 分钟轮询放大，复制一次要冻结 15 分钟采集。
const COPY_SKIP_MS = DEFAULT_POLL_INTERVAL + 3_000

/** 最近一次 copyItem 的失败原因（供上层替换掉笼统的"复制失败"提示） */
export const lastCopyError = ref<string | null>(null)

// 本地乐观条目的 id 前缀（服务端还没有这些条目，任何带 id 的请求都会 404/400）。
// 清单必须覆盖所有本地前缀：漏掉 file-/browser- 会打出 DELETE /api/clipboard/file-xxx。
const LOCAL_ID_PREFIX_RE = /^(local-|text-|img-|file-|browser-)/
function isLocalItemId(id: string): boolean {
  return LOCAL_ID_PREFIX_RE.test(id)
}

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
      // Rust 族去重：copyItem 回写图片时登记过 fnv64，命中即说明剪贴板里仍是
      // 我们自己写进去的那张图（字节级相同），不是用户新截的图。
      if (imgInfo.hash && String(imgInfo.hash) === lastImageRustHash) {
        logger.debug('[Clipboard] fallback poll: rust hash matches internal copy, skipping')
        return
      }
      const imgData = await tauri.getClipboardImage().catch((e: any) => {
        console.warn('[Clipboard] fallback poll getClipboardImage failed:', e)
        return ''
      })
      if (imgData) {
        const pngHash = simpleHash(imgData)
        if (isClipboardChangeFromInternalCopy({ hash: pngHash }, 'image')) {
          logger.debug('[Clipboard] fallback poll: image matches internal copy, skipping')
          return
        }
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
  let stopped = false
  // 兜底轮询用「一次性 setTimeout 自递归」而非固定 setInterval：
  // 用户改 syncInterval 时能立刻按新间隔重排，不必等到下一个周期。
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleFallback() {
    if (fallbackTimer) clearTimeout(fallbackTimer)
    fallbackTimer = null
    const ms = pollIntervalMs.value
    // 0（实时）= 纯事件驱动，不再兜底轮询
    if (!Number.isFinite(ms) || ms <= 0) {
      logger.debug('[Clipboard] fallback polling disabled (event-driven only)')
      return
    }
    fallbackTimer = setTimeout(async () => {
      fallbackTimer = null
      if (stopped) return
      try {
        await readAndUpload()
      } finally {
        if (!stopped) scheduleFallback()
      }
    }, ms)
  }

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
          if (isClipboardChangeFromInternalCopy({ hash: dedupHash }, 'image')) {
            logger.debug('[Clipboard] event: image matches internal copy, skipping')
            return
          }
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
          // 富文本捕获：Rust monitor 读到 "HTML Format" 时在 payload.html 附带片段（旧版无此字段）
          const html = typeof payload?.html === 'string' && payload.html.trim() ? payload.html : undefined
          enqueueClipboardTask({ type: 'text', payload: text, html })
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
    stopped = false
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
    // 事件监听的 unlisten 来自异步 promise：stop 可能先于 promise resolve。
    // 用 stopped 标志兜底，保证无论是"先 resolve 后 stop"还是"先 stop 后 resolve"
    // 都能真正摘掉监听，避免切换账号后同一个事件被处理两次。
    listen<any>('clipboard-changed', async (event) => {
      await handleClipboardEvent(event.payload)
    })
      .then((unlisten) => {
        if (stopped) {
          unlisten()
          return
        }
        unlistenEvent = unlisten
        logger.debug('[Clipboard] Listening for native clipboard-changed events')
      })
      .catch((err) => {
        console.warn('[Clipboard] Failed to attach event listener, falling back to polling:', err)
      })

    // --- Fallback: slow polling (every pollIntervalMs) as safety net ---
    // If the Rust monitor is not running or events are missed, this ensures
    // clipboard changes are still detected. Dedup logic in readAndUpload()
    // prevents duplicate uploads when both events and poll fire.
    scheduleFallback()

    return () => {
      polling.value = false
      stopped = true
      unlistenEvent?.()
      unlistenEvent = null
      if (fallbackTimer) clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }

  /**
   * 兜底轮询间隔（ms）。由 HomeView 依据 configStore.syncInterval（分钟）写入。
   * 0 = 纯事件驱动。改完立即按新间隔重排下一次轮询。
   */
  function setPollInterval(ms: number) {
    const next = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0
    if (pollIntervalMs.value === next) return
    pollIntervalMs.value = next
    if (polling.value) scheduleFallback()
  }

  /** 本地历史保留上限（条）。0 / 负数 = 不裁剪。由 HomeView 依据 configStore.maxHistory 写入。 */
  function setMaxHistory(cap: number) {
    const next = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0
    if (maxHistoryCap.value === next) return
    maxHistoryCap.value = next
    trimToMaxHistory()
  }

  async function copyItem(item: ClipItem) {
    lastCopyError.value = null
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

      // 精确内容去重：复制时记录会写入剪贴板的实际内容/路径，monitor 检测到相同内容时跳过。
      // 窗口必须覆盖兜底轮询间隔（10s）+ 余量，否则 3s 的旧窗口会让下一次兜底轮询
      // 落在窗口外，把刚写回的图片/文本当成外部新内容重新上传。
      skipNextPolls(COPY_SKIP_MS)
      markContentCopiedFromClipSync(item)

      // 预测粘贴：复制成功后记录使用（仅 server item；local 临时 id 后端静默跳过）
      const isServerItem = !isLocalItemId(item.id)
      const recordUseIfServer = () => {
        if (!isServerItem) return
        recordUse(item.id).catch((e: any) =>
          console.warn('[Clipboard] record use failed:', e?.message || e),
        )
      }

      if (item.type === 'file') {
        // === 跨设备文件还原（B7 / 决策 D3；F1.4 多文件扩展）===
        // 优先级：① 本机路径真实存在 → 直接复制文件（含“在资源管理器中显示”的路径语义）
        //        ② 服务端随条目存了字节（metadata.fileEncoding === 'base64'）→ 下载还原成临时文件再复制到剪贴板
        //        ③ 都没有 → 明确告知“仅本机可用”，不再抛 “Files not found” 之类的原始错误
        // F1.4：metadata 统一在 try 外归一化一次（服务端条目可能是 jsonb 对象或 JSON 字符串），
        // 新格式（metadata.files）判定与 metadata.paths 兑底都依赖它。
        const meta: Record<string, any> = (() => {
          const m = item.metadata
          if (m && typeof m === 'object') return m as Record<string, any>
          if (typeof m === 'string') {
            try {
              return JSON.parse(m) || {}
            } catch {
              return {}
            }
          }
          return {}
        })()
        try {
          const parsed = JSON.parse(item.content)
          const paths: string[] | undefined =
            Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string'
              ? parsed
              : parsed && typeof parsed === 'object' && Array.isArray(parsed.paths) && parsed.paths.length > 0
                ? parsed.paths
                : // F1.4 新格式条目 content 不含 paths，从 metadata.paths 兑底（本机会话/乐观期有效）
                  Array.isArray(meta.paths) && meta.paths.length > 0
                  ? (meta.paths as string[])
                  : undefined
          if (paths && paths.length > 0) {
            try {
              // copy_local_files 先逐个校验存在性：全部不存在时 Fast-fail（跨设备场景），
              // 部分存在时只复制存在的那些，并跳过下面不必要的下载。
              await tauri.copyLocalFiles(paths)
              recordUseIfServer()
              return true
            } catch {
              /* 本机没有这些路径 → 走服务端字节还原 */
            }
          }
          if (meta.fileEncoding === 'base64' && isServerItem) {
            try {
              const res = await api<{ contentEncrypted?: string }>('GET', `/api/clipboard/${item.id}`)
              const b64 = res.ok ? res.data?.contentEncrypted : ''
              const name = meta.originalName || parsed?.name || 'file'
              if (b64) {
                // save_and_copy_file：base64 → 临时目录落盘 → 以 CF_HDROP 写回剪贴板
                const savedPath = await tauri.saveAndCopyFile(b64, name)
                // 登记还原出来的临时路径：否则 monitor 会把它当成"用户新复制的文件"再上传一条
                if (savedPath) {
                  markContentCopiedFromClipSync({ ...item, content: JSON.stringify([savedPath]) })
                }
                recordUseIfServer()
                return true
              }
            } catch (e: any) {
              console.warn('[Clipboard] cross-device file restore failed:', e?.message || e)
            }
          }
          // 服务端只存了明文（文本文件）：本机没有路径时退化为复制文件内容，
          // 比只复制一个文件名有用得多，且不做"假装还原成文件"的假动作。
          if (meta.fileEncoding === 'text' && meta.localOnly !== true && isServerItem) {
            try {
              const res = await api<{ contentEncrypted?: string }>('GET', `/api/clipboard/${item.id}/content`)
              const text = res.ok ? res.data?.contentEncrypted : ''
              if (text) {
                // 记录实际写入剪贴板的文本，否则 monitor 会把它当外部新内容重新上传
                copiedTexts.set(text, Date.now())
                cleanupCopiedContent()
                await tauri.setClipboardContent(text)
                recordUseIfServer()
                return true
              }
            } catch (e: any) {
              console.warn('[Clipboard] cross-device text file copy failed:', e?.message || e)
            }
          }
          // F1.4 新格式（服务端统一落盘，metadata.files）：真正的多文件条目（files>1）在
          // 无本机路径时无法还原成文件（v1 单文件下载只对应一个落盘文件，多文件无批量
          // zip 下载），退化为复制首个文件名；通过 lastCopyError 提示“仅本机”，返回 false
          // 让上层 toast 展示该提示而不是笼统的“已复制”。
          // M-1：条件必须是 length > 1 —— 单文件 chunked 条目（服务端 complete 会回填单元素
          // files 数组）不算多文件，必须落到下方 parsed.name 分支复制文件名并 return true
          //（与旧行为一致），否则会误弹“多文件仅本机可用”提示。
          if (Array.isArray(meta.files) && meta.files.length > 1) {
            const firstFile = meta.files.find(
              (f: any) => f && typeof f === 'object' && (f.name || f.fileId || f.filename),
            )
            const displayName = String(firstFile?.name || firstFile?.fileId || firstFile?.filename || '')
            if (displayName) {
              copiedTexts.set(displayName, Date.now())
              cleanupCopiedContent()
              await tauri.setClipboardContent(displayName)
              recordUseIfServer()
            }
            lastCopyError.value = t('file_multi_local_only_hint')
            return false
          }
          // 纯元数据对象（服务器上传的文件，无字节）→ 退化为复制文件名（既有行为）。
          // 单文件 chunked 条目（展示 JSON 含 name、metadata.files 为单元素数组）也走这里。
          if (parsed && typeof parsed === 'object' && parsed.name) {
            await tauri.setClipboardContent(parsed.name)
            recordUseIfServer()
            return true
          }
          // M-1 边界兜底：单文件 chunked 条目展示 JSON 无 name（畸形/旧数据）时，改用
          // metadata.files[0] 的名称复制文件名并 return true（与 parsed.name 分支同口径）。
          if (Array.isArray(meta.files) && meta.files.length === 1) {
            const f0 = meta.files[0] as Record<string, any> | undefined
            const fallbackName = String(f0?.name || f0?.fileId || f0?.filename || '')
            if (fallbackName) {
              await tauri.setClipboardContent(fallbackName)
              recordUseIfServer()
              return true
            }
          }
          // 既无本机路径也无服务端字节：给出可理解的提示，不要抛原始错误
          lastCopyError.value = t('file_local_only_hint')
          return false
        } catch {
          /* 解析失败 */
        }
        return false
      }
      if (item.type === 'image') {
        // 图片：优先用本地完整 data URL，若为 blob URL 直接读取转为 base64 data URL
        let dataUrl = item.content || item.preview || ''
        if (dataUrl.startsWith('blob:')) {
          try {
            const resp = await fetch(dataUrl)
            if (resp.ok) {
              const blob = await resp.blob()
              dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader()
                reader.onloadend = () => resolve(reader.result as string)
                reader.onerror = reject
                reader.readAsDataURL(blob)
              })
            }
          } catch {
            /* fallback to apiBlob */
          }
        }
        if (!dataUrl || dataUrl.startsWith('[Image') || !dataUrl.startsWith('data:')) {
          try {
            // 优先从 /download 下载全量原图
            const res = await apiBlob('GET', `/api/media/${item.id}/download`)
            if (res && res.ok) {
              const blob = await res.blob()
              dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader()
                reader.onloadend = () => resolve(reader.result as string)
                reader.onerror = reject
                reader.readAsDataURL(blob)
              })
            }
          } catch {
            /* ignore */
          }
        }
        if (!dataUrl || !dataUrl.startsWith('data:')) {
          try {
            const full = await api('GET', `/api/clipboard/${item.id}`)
            const enc = full.data?.contentEncrypted
            if (enc && enc.startsWith('data:')) {
              dataUrl = enc
            }
          } catch {
            /* ignore */
          }
        }
        if (dataUrl && dataUrl.startsWith('data:')) {
          // 通过 Rust 原生接口写入 Windows 剪贴板真实位图（CF_DIB + PNG），彻底杜绝 blob: 文本污染！
          try {
            await tauri.setClipboardImage(dataUrl)
          } catch (e) {
            console.error('[useClipboard] tauri.setClipboardImage error:', e)
            try {
              const resp = await fetch(dataUrl)
              const blob = await resp.blob()
              const mime = blob.type || 'image/png'
              await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })])
            } catch {
              /* 绝不向系统剪贴板写入 blob: 文本！ */
            }
          }
          // 写入后登记两族哈希，避免兜底轮询/事件路径把它当作新截图重新上传：
          //   - JS 族（simpleHash(dataUrl)）：事件与兜底轮询实际比较的键
          //   - Rust 族（checkClipboardImageInfo 的 fnv64）：另一条检测路径的键
          // 只登记其中一把，另一条路径必然漏判 → 复制图片后立即出现重复条目。
          const writtenHash = simpleHash(dataUrl)
          lastImageHash = writtenHash
          recentUploadHashes.set(writtenHash, Date.now())
          markImageCopiedFromClipSync(writtenHash)
          try {
            const info = await tauri.checkClipboardImageInfo()
            lastImageSize = info.size
            lastImageRustHash = info.hash ? String(info.hash) : ''
            if (lastImageRustHash) recentUploadHashes.set(lastImageRustHash, Date.now())
            // 读回写入结果再登记一次：这是兜底轮询真正会看到的 data URL。
            // 写回字节与读回重新编码的字节未必逐字节相等，两把都登记才稳。
            const readBack = await tauri.getClipboardImage().catch(() => '')
            if (readBack) {
              const readHash = simpleHash(readBack)
              lastImageHash = readHash
              recentUploadHashes.set(readHash, Date.now())
              markImageCopiedFromClipSync(readHash)
            }
          } catch {
            /* ignore */
          }
          recordUseIfServer()
          return true
        }
        return false
      }

      // 文本/链接/代码：item.content 可能是服务端返回的 contentPreview（<=5000 字符）。
      // 如果已知 contentSize 且当前 content 不完整，先从服务器拉取完整内容再写入剪贴板。
      // 老数据 contentSize 可能为 0，对非空服务端条目也尝试拉取，确保不会只复制 200 字符预览。
      let textContent = item.content
      const isLocalItem = isLocalItemId(item.id)
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
      recordUseIfServer()
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
    const serverIds = selected.map((i) => i.id).filter((id) => !isLocalItemId(id))
    let res: any = { ok: true, status: 200 }
    if (serverIds.length > 0) {
      res = await apiOrEnqueue('DELETE', '/api/clipboard', { ids: serverIds }, 'delete', { ids: serverIds })
      if (!res.ok && res.status !== 0) {
        console.error('[Clipboard] batchDelete server error:', res.status, res.error)
        throw new Error(res.error || tf('clip_del_http_fail', '删除失败 (HTTP {status})', { status: res.status }))
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
    // 本地前缀清单必须完整（含 file-/browser-），否则会对不存在的服务端 id 发请求
    const isLocal = isLocalItemId(item.id)
    let res: any = { ok: true, status: 200 }
    if (!isLocal) {
      res = await apiOrEnqueue('DELETE', `/api/clipboard/${item.id}`, undefined, 'delete', { id: item.id })
      if (!res.ok && res.status !== 0) {
        console.error('[Clipboard] deleteSingle server error:', res.status, res.error)
        throw new Error(res.error || tf('clip_del_http_fail', '删除失败 (HTTP {status})', { status: res.status }))
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
    // 本地乐观条目（尚未拿到服务端 id）：只改本地，不发请求。
    // 否则会对 local-xxx 这类假 id 打 PUT /api/clipboard/local-xxx/favorite → 400。
    if (isLocalItemId(item.id)) return
    const res = await api('PUT', `/api/clipboard/${item.id}/favorite`)
    if (!res.ok) {
      // 回滚
      ;(item as any).isFavorite = prev
      ;(item as any).favoritedAt = prevFavAt
      console.warn('[Clipboard] toggleFavorite failed:', res.error)
    }
  }

  // 置顶/取消置顶（跨设备：metadata.pinned，后端列表查询 pinned 优先排序）。
  // 乐观更新本地 + 前置排序，失败回滚。仅服务端条目可置顶（本地临时项无后端 id）。
  async function togglePinned(item: ClipItem): Promise<boolean> {
    const next = !item.pinned
    const prev = item.pinned ?? false
    item.pinned = next
    if (item.metadata) item.metadata.pinned = next
    resortPinned()
    try {
      const res = await api('PUT', `/api/clipboard/${item.id}/pinned`, { pinned: next })
      if (!res.ok) {
        item.pinned = prev
        if (item.metadata) item.metadata.pinned = prev
        resortPinned()
        console.warn('[Clipboard] togglePinned failed:', res.error)
        return false
      }
      return true
    } catch (e) {
      item.pinned = prev
      if (item.metadata) item.metadata.pinned = prev
      resortPinned()
      console.warn('[Clipboard] togglePinned error:', e)
      return false
    }
  }

  // 置顶条目前置（保持各自内部相对顺序）
  function resortPinned() {
    const pinnedItems = items.value.filter((i) => i.pinned)
    const rest = items.value.filter((i) => !i.pinned)
    items.value = [...pinnedItems, ...rest]
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
    // 搜索词变化时走后端全文检索（GET /api/clipboard?search=...），不再只过滤本地已加载数据。
    loadClipboardItems({ page: 1, append: false })
  }
  function clearSearch() {
    searchQuery.value = ''
    loadClipboardItems({ page: 1, append: false })
  }
  function toggleBatch() {
    batchMode.value = !batchMode.value
    if (!batchMode.value) clearSelection()
  }

  /** 从文件选择器上传文件到剪贴板 */
  async function uploadFileItem(file: File): Promise<void> {
    // 套餐上传上限由后端 /api/subscriptions/current 下发（F0.4），
    // 桌面端不再维护 Free/Pro/Enterprise 硬编码表。
    const plan = usePlanLimits()
    const maxBytes = await plan.getMaxUploadBytes()

    // L2：套餐数据来自兜底默认值（/api/subscriptions/current 拉取失败）时不做客户端预拦截
    // —— 兜底 20MB 会把 Pro 用户 20-128MB 的合法文件误判超限；放行交服务端权威校验，
    // 413 由 handleQuotaResponse 走完整提示链路。
    if (file.size > maxBytes && !plan.isPlanLimitsFallback()) {
      const maxMb = Math.round(maxBytes / 1024 / 1024)
      const sizeStr =
        file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(0)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`
      throw new Error(`${t('file_exceeds_plan', { size: sizeStr, limit: `${maxMb}MB`, plan: '' })}`)
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

    const deviceId = await ensureDeviceId()
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
      // 与剪贴板截图同一条预处理链路，同样消费「图片压缩」设置（B8③）
      const dataUrl = await prepareImageForUpload(rawDataUrl)
      const res = await api('POST', '/api/clipboard', {
        contentType: 'image',
        content: dataUrl,
        contentEncrypted: dataUrl,
        sourceDeviceId: deviceId,
        mimeType: dataUrlMime(dataUrl, file.type),
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
      // F3.1：serverId 提升到 try 外，分片 413 兜底时用它定位本地条目
      let serverId: string | undefined
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
        serverId = createRes.data?.id
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
        // F3.1：分片 init 413（套餐限制）→ 升级引导 toast（24h 节流），本地条目转
        // localOnly 占位；错误打已处理标记，useFileUpload 的 catch 不再重复 upload_fail
        if (await handleQuotaResponse(e, { fileName: file.name, sizeBytes: file.size })) {
          const item = items.value.find((i) => i.id === (serverId || localId))
          if (item) item.metadata = { ...(item.metadata || {}), localOnly: true }
          throw markHandledQuota(e)
        }
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
            // media.js 响应字段是 filename（服务端落盘名），不是 contentEncrypted
            serverFilename: res.data.filename,
          })
          cacheContent(res.data.id, item.content)
        }
      } else if (res.status === 413 && (await handleQuotaResponse(res, { fileName: file.name, fileCount: 1 }))) {
        // F3.1：413 配额拒绝 → 升级引导（24h 节流）；本地条目转 localOnly 占位并打
        // 已处理标记，useFileUpload 的 catch 不再重复 upload_fail
        const item = items.value.find((i) => i.id === localId)
        if (item) item.metadata = { ...(item.metadata || {}), localOnly: true }
        throw markHandledQuota(new Error(res.error || 'Upload failed'))
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
    loadError,
    hasMore,
    loadingMore,
    loadMore,
    currentPage,
    pageSize,
    selectedCount,
    allSelected,
    startPolling,
    setPollInterval,
    setMaxHistory,
    lastCopyError,
    copyItem,
    copyText,
    toggleSelectAll,
    clearSelection,
    batchDelete,
    deleteSingle,
    toggleFavorite,
    togglePinned,
    archiveItem,
    unarchiveItem,
    setExpiry,
    loadClipboardItems,
    setFilter,
    setSearch,
    clearSearch,
    toggleBatch,
    uploadFileItem,
    refresh: loadClipboardItems,
    syncDeletions,
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
