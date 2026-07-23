// === 剪贴板条目展示辅助（内容格式化 / 类型检测 / 时间显示 / 敏感检测缓存）===
// 从 ClipboardView 抽出的纯展示逻辑，供表格行 / 右键菜单 / 父组件共用。
import { useI18n } from '@/composables/useI18n'
import { usePrivacy } from '@/composables/usePrivacy'
import { useItemPassword } from '@/composables/useItemPassword'
import { useConfigStore } from '@/stores/configStore'
import { isHtmlContent } from '@/utils/html'
import type { ClipItem } from './clipboardState'

export function useClipItemDisplay() {
  const { t } = useI18n()
  const privacy = usePrivacy()
  const itemPw = useItemPassword()
  const configStore = useConfigStore()

  // 条目是否对当前用户可见（受保护 → 需解锁 + PIN 超时检查）
  function isItemVisible(item: ClipItem): boolean {
    if (!itemPw.isItemProtected(item)) return true

    // 高级加密：解锁状态存在 itemPw.unlockedIds 中
    if ((item as any).metadata?.protected === true) {
      return itemPw.isUnlocked(item.id)
    }

    // PIN 保护：解锁状态在 privacy 中（30s 超时）
    if (item.metadata?.sensitive) {
      return privacy.isPinUnlocked(item.id)
    }

    return false
  }

  // 展示内容：受保护且可见时返回明文；不可见时显示掩码
  function displayContent(item: ClipItem): string {
    if (!isItemVisible(item)) return t('item_password_mask')
    if (itemPw.isItemProtected(item) && itemPw.isUnlocked(item.id)) {
      return itemPw.getUnlockedPlaintext(item.id) ?? item.content
    }
    return item.content
  }

  function formatContent(item: ClipItem): string {
    const content = displayContent(item)
    // 文件类型：始终尝试显示文件名
    if (item.type === 'file') {
      try {
        const parsed = JSON.parse(content)
        // { name, size, type } 格式
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.name) {
          return String(parsed.name)
        }
        // { name, paths } 格式
        if (parsed && typeof parsed === 'object' && parsed.paths && Array.isArray(parsed.paths) && parsed.paths[0]) {
          return parsed.paths[0].split(/[/\\]/).pop() || parsed.paths[0]
        }
        // 路径数组格式 ["D:\\path\\file"]
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
          return parsed[0].split(/[/\\]/).pop() || parsed[0]
        }
      } catch {
        /* not JSON */
      }

      // 内容可能是文件路径数组字符串（旧格式）
      const raw = content.trim()
      if (raw.startsWith('["') && raw.includes('\\')) {
        try {
          const paths = JSON.parse(raw)
          if (Array.isArray(paths) && paths[0]) return paths[0].split(/[/\\]/).pop() || paths[0]
        } catch {
          /* ignore */
        }
      }

      // 内容是文件路径（含反斜杠）
      if (raw.includes('\\') || raw.includes('/')) {
        const segments = raw.split(/[/\\]/)
        const last = segments[segments.length - 1]
        if (last && last.includes('.')) return last
      }

      // 旧逻辑会在这里截断文件名；现在预览由 CSS 控制，不再做字符截断。
      return raw || 'Unknown file'
    }

    // 非文件类型：不再硬截断字符，视觉行数由 CSS line-clamp 控制
    return content
  }

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts
    if (diff < 60000) return t('just_now')
    if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
    if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
    return Math.floor(diff / 86400000) + t('d_ago')
  }

  function getTypeLabel(type: string): string {
    const map: Record<string, string> = {
      text: 'TXT',
      image: 'IMG',
      file: 'FILE',
      link: 'URL',
    }
    return map[type] || type.toUpperCase()
  }

  // 提取 URL 域名
  function extractDomain(url: string): string {
    try {
      const u = new URL(url)
      return u.hostname
    } catch {
      return url.slice(0, 30)
    }
  }

  // 列表单元格过期短标识（exp-detail #189 补充：让过期设置可见）
  function formatExpiryShort(iso: string): string {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const diff = d.getTime() - Date.now()
    if (diff <= 0) return t('exp_expired')
    const day = 86400000
    if (diff < 3600000) return Math.ceil((diff / 3600000) * 10) / 10 + 'h'
    if (diff < day) return Math.floor(diff / 3600000) + 'h'
    if (diff < 30 * day) return Math.floor(diff / day) + 'd'
    return Math.floor(diff / day) + 'd'
  }

  /** Check if a file item has a local path (for copy/reveal buttons).
   *  Checks item.content first, then falls back to item.metadata.paths.
   *  Handles: JSON path arrays, {name,paths} objects, plain path strings, content with embedded paths */
  function hasLocalPath(item: ClipItem): boolean {
    // Strategy A: check item.content (reconstructed by useClipboard.ts or raw from server)
    const content = String(item.content || '')
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') return true
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.paths) && parsed.paths.length > 0) return true
    } catch {
      /* not JSON */
    }

    // Strategy B: plain string path
    if (/^[A-Za-z]:[\\/]/.test(content)) return true
    if (/\b[A-Za-z]:[\\/][\w\s\\/.]+\.\w{1,5}\b/.test(content)) return true

    // Strategy C: check metadata directly (useClipboard.ts may not have reconstructed content)
    try {
      const meta = JSON.parse((item as any).metadata || '{}')
      if (Array.isArray(meta.paths) && meta.paths.length > 0 && typeof meta.paths[0] === 'string') return true
    } catch {
      /* no metadata */
    }

    return false
  }

  function extractFilePath(content: string): string | null {
    try {
      const parsed = JSON.parse(content)
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.paths) && parsed.paths[0]) return parsed.paths[0]
        if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0]
      }
    } catch {
      /* not JSON */
    }
    const raw = content.trim()
    if (raw.startsWith('["') && raw.includes('\\')) {
      try {
        const paths = JSON.parse(raw)
        if (Array.isArray(paths) && paths[0]) return paths[0]
      } catch {
        /* ignore */
      }
    }
    if (raw.includes('\\') || raw.includes('/')) return raw
    return null
  }

  function base64ToBlob(base64: string, type = 'application/octet-stream'): Blob {
    const byteCharacters = atob(base64)
    const byteArrays: Uint8Array[] = []
    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
      const slice = byteCharacters.slice(offset, offset + 512)
      const byteNumbers = new Array(slice.length)
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i)
      }
      byteArrays.push(new Uint8Array(byteNumbers))
    }
    return new Blob(byteArrays, { type })
  }

  return {
    isItemVisible,
    displayContent,
    formatContent,
    timeAgo,
    getTypeLabel,
    extractDomain,
    formatExpiryShort,
    hasLocalPath,
    extractFilePath,
    base64ToBlob,
  }
}

// ===== 模块级检测缓存（跨组件共享，避免长列表渲染时反复正则扫描）=====
const contentTypeCache = new Map<string, 'code' | 'url' | 'text'>()
const MAX_CONTENT_TYPE_CACHE = 2000

export function detectContentType(content: string): 'code' | 'url' | 'text' {
  if (!content) return 'text'
  const cached = contentTypeCache.get(content)
  if (cached !== undefined) return cached
  const trimmed = content.trim()
  // URL 检测
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    if (contentTypeCache.size > MAX_CONTENT_TYPE_CACHE) {
      const firstKey = contentTypeCache.keys().next().value
      if (firstKey !== undefined) contentTypeCache.delete(firstKey)
    }
    contentTypeCache.set(content, 'url')
    return 'url'
  }
  // HTML 在主列表当作 plain text，详情弹窗才渲染；避免 HTML 被误判为 code 导致列表显示源码样式
  if (isHtmlContent(trimmed)) {
    if (contentTypeCache.size > MAX_CONTENT_TYPE_CACHE) {
      const firstKey = contentTypeCache.keys().next().value
      if (firstKey !== undefined) contentTypeCache.delete(firstKey)
    }
    contentTypeCache.set(content, 'text')
    return 'text'
  }
  // 代码检测：常见代码模式（HTML 已提前排除）
  if (
    /[{}[\]];?\s*$/.test(trimmed) ||
    /\b(function|const|let|var|class|import|export|return|if|for|while|async|await)\s/.test(trimmed) ||
    /^\s*(def |class |import |from |public |private |protected )/.test(trimmed) ||
    /=>\s*[{(]/.test(trimmed) ||
    /^\s*<\?xml\b/i.test(trimmed) ||
    /:\s*(string|number|boolean|void|any|null|undefined)\s/.test(trimmed)
  ) {
    if (contentTypeCache.size > MAX_CONTENT_TYPE_CACHE) {
      const firstKey = contentTypeCache.keys().next().value
      if (firstKey !== undefined) contentTypeCache.delete(firstKey)
    }
    contentTypeCache.set(content, 'code')
    return 'code'
  }
  if (contentTypeCache.size > MAX_CONTENT_TYPE_CACHE) {
    const firstKey = contentTypeCache.keys().next().value
    if (firstKey !== undefined) contentTypeCache.delete(firstKey)
  }
  contentTypeCache.set(content, 'text')
  return 'text'
}
