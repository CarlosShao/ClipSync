/**
 * 计算 data URL 原始字节（不含前缀）的 SHA-256（十六进制小写）。
 * 失败时返回空字符串，避免阻塞上传/发送流程。
 *
 * 注意：旧实现用 atob + 同步 for 循环逐字符填 Uint8Array，在大图（base64 数百万字符）
 * 时会同步阻塞主线程几十~上百毫秒，导致复制图片后 UI 卡顿一帧。
 * 现改用 fetch(dataUrl).arrayBuffer() 异步解码（浏览器原生、不阻塞主线程），
 * 再 crypto.subtle.digest 计算哈希，彻底消除卡顿。
 */
export async function sha256DataUrl(dataUrl: string): Promise<string> {
  try {
    const comma = dataUrl.indexOf(',')
    if (comma === -1) return ''
    const b64 = dataUrl.slice(comma + 1)
    // 用 Blob 解码 base64 → ArrayBuffer（完全异步，不阻塞主线程）
    const blob = await fetch(`data:application/octet-stream;base64,${b64}`).then((r) => r.arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', blob)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return ''
  }
}
