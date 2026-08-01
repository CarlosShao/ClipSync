/**
 * 计算 data URL 原始字节（不含前缀）的 SHA-256（十六进制小写）。
 * 失败时返回空字符串，避免阻塞上传/发送流程。
 */
export async function sha256DataUrl(dataUrl: string): Promise<string> {
  try {
    const comma = dataUrl.indexOf(',')
    if (comma === -1) return ''
    const b64 = dataUrl.slice(comma + 1)
    const binaryString = atob(b64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return ''
  }
}
