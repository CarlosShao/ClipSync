// === 图片 Object URL 生命周期管理（修复内存泄漏）===
// loadImagesFromQueue 用 URL.createObjectURL(blob) 生成预览图，但浏览器不会自动回收 blob，
// 必须显式 revokeObjectURL。否则列表刷新/加载更多/删除图片时，旧 blob 持续占用 WebView 内存
// （实测空闲 ~147MB，同类应用约 60MB，差距主要来自未释放的图片对象）。
// 用 id→url 映射精确跟踪每个图片条目的 blob，替换/删除/登出时释放。
import type { ClipItem } from './clipboardState'

const imageObjectUrls = new Map<string, string>()

function isBlobUrl(s: any): s is string {
  return typeof s === 'string' && s.startsWith('blob:')
}

/** 给条目设置预览图，自动回收被替换掉的旧 blob URL */
export function setItemPreview(item: ClipItem, url: string) {
  if (item.preview && isBlobUrl(item.preview)) {
    const old = imageObjectUrls.get(item.id)
    if (old && old !== url) {
      URL.revokeObjectURL(old)
      imageObjectUrls.delete(item.id)
    }
  }
  item.preview = url
  if (isBlobUrl(url)) {
    imageObjectUrls.set(item.id, url)
  } else if (imageObjectUrls.has(item.id)) {
    // 预览被换成 data URL 或清空，解除跟踪
    imageObjectUrls.delete(item.id)
  }
}

/** 列表即将被替换/过滤前调用：释放不再被任何条目引用的 blob URL */
export function releaseRemovedObjectUrls(nextItems: ClipItem[]) {
  const liveUrls = new Set<string>()
  for (const it of nextItems) {
    if (isBlobUrl(it.preview)) liveUrls.add(it.preview)
  }
  for (const [id, url] of imageObjectUrls) {
    if (!liveUrls.has(url)) {
      URL.revokeObjectURL(url)
      imageObjectUrls.delete(id)
    }
  }
}

/** 强制释放所有图片 blob URL（切换账号 / 清空列表时调用） */
export function releaseAllObjectUrls() {
  for (const [, url] of imageObjectUrls) {
    try { URL.revokeObjectURL(url) } catch { /* 已失效则忽略 */ }
  }
  imageObjectUrls.clear()
}
