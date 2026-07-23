// === 条目级密码保护 (per-item password) ===
// 纯前端加密方案：密码永不上传，服务端只存密文。
// - 派生：PBKDF2(SHA-256, 100k iterations) + 随机 16B salt → AES-GCM-256 key
// - 打包格式：v1:<saltB64>:<ivB64>:<ciphertextB64>（全部 base64，逗号分隔段落用冒号分隔）
// - 解锁：用密码尝试解密；成功则把明文缓存在本次会话内存里（unlockedCache），
//   以便查看/复制时无需重复输入密码；锁定/登出时清空。
// 服务端复用现有 content_encrypted 列，无需任何 schema 迁移。
import { ref } from 'vue'

const PBKDF2_ITERATIONS = 100000
const SALT_BYTES = 16
const IV_BYTES = 12
const PREFIX = 'v1'

// 本次会话已解锁条目的明文缓存：id → plaintext。锁定时删除。
const unlockedCache = new Map<string, string>()
// 响应式集合，供 UI 区分“受保护且未解锁 / 已解锁”状态。
const unlockedIds = ref<Set<string>>(new Set())

function bufToBase64(buf: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
  return btoa(bin)
}

function base64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function useItemPassword() {
  /** 判断条目是否启用了条目级密码保护 */
  function isItemProtected(item: { isProtected?: boolean; metadata?: any }): boolean {
    if (item.isProtected === true) return true
    return !!(item.metadata && item.metadata.protected === true)
  }

  /** 条目是否已在本会话解锁（明文在内存中） */
  function isUnlocked(itemId: string): boolean {
    return unlockedIds.value.has(itemId)
  }

  /** 用密码加密明文，返回 v1:<salt>:<iv>:<ct> 打包串 */
  async function encryptContent(plaintext: string, password: string): Promise<string> {
    if (!plaintext || !password) throw new Error('plaintext and password required')
    const enc = new TextEncoder()
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const key = await deriveKey(password, salt)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
    return `${PREFIX}:${bufToBase64(salt)}:${bufToBase64(iv)}:${bufToBase64(new Uint8Array(ct))}`
  }

  /**
   * 用密码解密打包串。
   * 返回 { ok:false } 表示密码错误或格式不合法（AES-GCM 认证失败直接抛异常）。
   */
  async function decryptContent(packed: string, password: string): Promise<{ ok: boolean; plaintext?: string }> {
    try {
      if (!packed || typeof packed !== 'string') return { ok: false }
      const parts = packed.split(':')
      if (parts.length !== 4 || parts[0] !== PREFIX) return { ok: false }
      const salt = base64ToBuf(parts[1])
      const iv = base64ToBuf(parts[2])
      const ct = base64ToBuf(parts[3])
      const key = await deriveKey(password, salt)
      const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
      const plaintext = new TextDecoder().decode(ptBuf)
      return { ok: true, plaintext }
    } catch {
      // AES-GCM 认证失败 / 密码错误 / 解密异常 → 一律视为密码错误
      return { ok: false }
    }
  }

  /** 解锁并缓存明文到本次会话内存 */
  function setUnlocked(itemId: string, plaintext: string): void {
    unlockedCache.set(itemId, plaintext)
    const next = new Set(unlockedIds.value)
    next.add(itemId)
    unlockedIds.value = next
  }

  /** 取已解锁条目的明文（未解锁返回 undefined） */
  function getUnlockedPlaintext(itemId: string): string | undefined {
    return unlockedCache.get(itemId)
  }

  /** 锁定单个条目（清除其明文缓存与会话标记） */
  function lockItem(itemId: string): void {
    unlockedCache.delete(itemId)
    const next = new Set(unlockedIds.value)
    next.delete(itemId)
    unlockedIds.value = next
  }

  /** 清空所有解锁缓存（登出 / 切换账号时调用） */
  function clearUnlocked(): void {
    unlockedCache.clear()
    unlockedIds.value = new Set()
  }

  return {
    unlockedIds,
    isItemProtected,
    isUnlocked,
    encryptContent,
    decryptContent,
    setUnlocked,
    getUnlockedPlaintext,
    lockItem,
    clearUnlocked,
  }
}
