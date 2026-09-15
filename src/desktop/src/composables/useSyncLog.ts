/**
 * 同步日志（设备页「同步日志」面板数据源）：
 * - ⬆ 发送：本机剪贴板采集（clipboard-changed 事件）与上传
 * - ⬇ 收到：其它设备的 WS 广播（new_clipboard / clipboard_updated 等）
 * 仅本机内存 + localStorage 持久化最近 15 条，不上传服务端。
 * 注意：服务端 broadcastToUser 会把 new_clipboard 原样广播回发送者本人，
 * 必须过滤自回声，否则本机每次复制都会产生「↑本机 + ↓云端」成对假下行。
 */
import { ref } from 'vue'
import { ensureDeviceId } from './clipboardUpload'

export interface SyncLogEntry {
  dir: 'up' | 'down'
  kind: string
  size?: string
  source: string
  ts: number
}

// v2：换键以丢弃历史自回声脏数据
const STORAGE_KEY = 'clipsync-sync-log-v2'
const MAX = 15

function load(): SyncLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.slice(0, MAX) : []
  } catch {
    return []
  }
}

const events = ref<SyncLogEntry[]>(load())

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.value))
  } catch {
    /* storage full — log is best-effort */
  }
}

function push(entry: SyncLogEntry) {
  events.value = [entry, ...events.value].slice(0, MAX)
  persist()
}

function kindLabel(type: string | undefined): string {
  switch (type) {
    case 'text':
      return '文本'
    case 'image':
      return '图片'
    case 'file':
      return '文件'
    case 'link':
      return '链接'
    default:
      return type || '文本'
  }
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined as unknown as string
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 本机设备 ID（懒解析 + 缓存），用于识别「服务端广播回自己」的回声
let localDeviceId: string | null | undefined
function resolveLocalDeviceId(): Promise<string | null> {
  if (localDeviceId === undefined) {
    localDeviceId = null
    return ensureDeviceId()
      .then((id) => {
        localDeviceId = id
        return localDeviceId
      })
      .catch(() => {
        localDeviceId = null
        return null
      })
  }
  return Promise.resolve(localDeviceId)
}

/** 自回声兜底：N 秒内与最近一条上行「同类型 + 同大小」的下行视为回声（覆盖不带 sourceDeviceId 的分片上传广播） */
function looksLikeEcho(kind: string, size: string | undefined): boolean {
  const latest = events.value.find((e) => e.dir === 'up')
  if (!latest) return false
  if (Date.now() - latest.ts > 10_000) return false
  return latest.kind === kind && (!size || !latest.size || latest.size === size)
}

export function useSyncLog() {
  return {
    events,
    /** WS 下行：远端设备的新增/更新事件（本机自回声已过滤） */
    async pushFromWs(data: any) {
      const item = data?.item || data?.clip
      if (!item) return
      const type = item?.contentType || item?.type || 'text'
      const kind = kindLabel(type)
      const sizeBytes = Number(item?.contentSize) || (item?.content ? String(item.content).length : 0)
      const size = humanSize(sizeBytes)
      const srcDevice = item?.sourceDeviceId || data?.sourceDeviceId
      if (srcDevice) {
        const local = await resolveLocalDeviceId()
        if (local && srcDevice === local) return
      }
      if (looksLikeEcho(kind, size)) return
      push({
        dir: 'down',
        kind,
        size,
        source: item?.source || item?.deviceName || item?.sourceDevice?.name || '云端',
        ts: Date.now(),
      })
    },
    /** 本机上行：剪贴板采集/上传产生的新条目 */
    pushLocal(payload: any, source = '本机') {
      const type = payload?.contentType || payload?.type || 'text'
      const content = payload?.content || payload?.preview || ''
      const sizeBytes = Number(payload?.contentSize) || (content ? String(content).length : 0)
      push({
        dir: 'up',
        kind: kindLabel(type),
        size: humanSize(sizeBytes),
        source,
        ts: Date.now(),
      })
    },
  }
}
