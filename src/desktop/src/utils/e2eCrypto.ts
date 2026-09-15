// === 端到端加密客户端入口（工单 B6） ===
// Rust 侧原语见 src-tauri/src/e2e_crypto.rs（B5）：本文件只做三件事——
// ① 用户开关状态与持久化；② 收件人公钥收集与门禁判定；③ 信封组织（拆列：ciphertext → content_encrypted 列，
//    其余 → metadata.e2e）。协议契约见 docs/plans/e2e-protocol.md。
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { api } from '@/api/client'

export interface E2eRecipientKey {
  deviceId: string
  publicKey: string
}

/** 信封（协议 §2）。Rust e2e_encrypt 返回值附带 ciphertext 字段——入库前必须拆出，不进 metadata */
export interface E2eEnvelope {
  v: number
  alg: string
  epk: string
  iv: string
  keys: Record<string, { w: string; iv: string }>
  ciphertext?: string
}

export interface E2eUploadPayload {
  /** 密文 base64 → content_encrypted 列 */
  contentEncrypted: string
  /** 不含 ciphertext 的信封 → metadata.e2e */
  e2e: E2eEnvelope
  /** 服务端可见占位 */
  contentPreview: string
}

/** E2E 占位预览（协议 §2：content_preview 置 "[E2E]"） */
export const E2E_PREVIEW_PLACEHOLDER = '[E2E]'

// 文件走 Rust 整文件 b64 原语，超大会顶爆 IPC/内存；超过此上限回退明文并提示
export const E2E_FILE_MAX_BYTES = 64 * 1024 * 1024

// --- 用户开关（独立 localStorage 键：不依赖 configStore，接收端/设置页直接 import） ---
const E2E_ENABLED_KEY = 'clipsync-e2e-enabled'

function loadEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(E2E_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export const e2eEnabled = ref<boolean>(loadEnabled())

export function setE2eEnabled(v: boolean): void {
  e2eEnabled.value = v
  try {
    if (v) localStorage.setItem(E2E_ENABLED_KEY, '1')
    else localStorage.removeItem(E2E_ENABLED_KEY)
  } catch {
    /* ignore */
  }
}

/** 条目是否 E2E 加密（与协议 §2 / 服务端 imageHash.isE2eItem 同口径） */
export function isE2eItem(metadata: unknown): boolean {
  return !!(metadata as any)?.e2e
}

// --- Rust 原语薄封装 ---
export async function e2eStatus(): Promise<{ hasKeypair: boolean; publicKey: string | null }> {
  return invoke<{ hasKeypair: boolean; publicKey: string | null }>('e2e_status')
}

export async function e2eEnsureKeypair(): Promise<string> {
  const r = await invoke<{ publicKey: string }>('e2e_ensure_keypair')
  return r.publicKey
}

export async function e2ePublicKey(): Promise<string | null> {
  return invoke<string | null>('e2e_public_key')
}

/** 解密条目内容：返回明文字节。本设备不在 keys 映射 / 解密失败 → 抛错（调用方展示占位卡） */
export async function e2eDecryptBytes(envelope: E2eEnvelope, myDeviceId: string): Promise<Uint8Array> {
  const b64 = await invoke<string>('e2e_decrypt', { envelope, deviceId: myDeviceId })
  return b64ToBytes(b64)
}

// --- base64 工具（大数组分块，避免 String.fromCharCode.apply 栈溢出） ---
export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// --- 收件人收集 ---
// 15s TTL 缓存：批量上传（多文件逐个加密）时避免每个文件都打一次 /api/devices
let recipientsCache: { at: number; keys: E2eRecipientKey[] } | null = null
const RECIPIENTS_TTL = 15_000

/** 拉设备列表并收集带公钥的设备（含本机：重登/缓存丢失后本机也要能解自己传的历史）。 */
async function collectRecipients(): Promise<E2eRecipientKey[]> {
  if (recipientsCache && Date.now() - recipientsCache.at < RECIPIENTS_TTL) return recipientsCache.keys
  try {
    const res = await api<any>('GET', '/api/devices')
    const data = res?.data
    const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.devices) ? data.devices : []
    const keys = list
      .filter((d) => typeof d?.public_key === 'string' && d.public_key.length > 0)
      .map((d) => ({ deviceId: String(d.id), publicKey: d.public_key }))
    recipientsCache = { at: Date.now(), keys }
    return keys
  } catch {
    return []
  }
}

/**
 * 加密一段明文字节。返回 null = 按工单约定回退明文（开关关 / 无任何收件人公钥）；
 * 抛错 = Rust 原语失败（fail-closed，调用方必须中止发送而不是回退明文）。
 */
async function encryptBytes(bytes: Uint8Array): Promise<{ payload: E2eUploadPayload; ciphertext: Uint8Array } | null> {
  if (!e2eEnabled.value) return null
  const recipients = await collectRecipients()
  if (recipients.length === 0) return null
  // 服务端 metadata.e2e.keys 上限 32 项（B1 校验），多设备极端场景截断
  const limited = recipients.slice(0, 32)
  const contentB64 = bytesToB64(bytes)
  const env = await invoke<E2eEnvelope>('e2e_encrypt', { contentB64, recipients: limited })
  const { ciphertext, ...envelope } = env
  const ciphertextB64 = ciphertext || ''
  if (!ciphertextB64) throw new Error('e2e_encrypt returned empty ciphertext')
  return {
    payload: { contentEncrypted: ciphertextB64, e2e: envelope, contentPreview: E2E_PREVIEW_PLACEHOLDER },
    ciphertext: b64ToBytes(ciphertextB64),
  }
}

/** 文本/图片（dataUrl）统一入口：明文字符串 → 加密载荷。null=回退明文；抛错=fail-closed */
export async function tryEncryptText(plaintext: string): Promise<E2eUploadPayload | null> {
  const r = await encryptBytes(new TextEncoder().encode(plaintext))
  return r?.payload ?? null
}

/** 文件字节入口：密文字节给分片上传，信封给条目 metadata。null=回退明文；抛错=fail-closed */
export async function tryEncryptBytes(bytes: Uint8Array): Promise<{ e2e: E2eEnvelope; ciphertext: Uint8Array } | null> {
  const r = await encryptBytes(bytes)
  return r ? { e2e: r.payload.e2e, ciphertext: r.ciphertext } : null
}
