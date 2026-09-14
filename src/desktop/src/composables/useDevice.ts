import { ref } from 'vue'
import { api } from '@/api/client'

export interface Device {
  id: string
  name: string
  type: 'desktop' | 'mobile' | 'browser'
  lastActive: string
  online: boolean
  location?: string
  /** B2/B7：设备静态 E2E 公钥（65B 未压缩点 base64）；未配对密钥的旧设备为 null */
  publicKey?: string | null
  /** B7：公钥指纹（sha256 前 16 hex，与管理台一致）；publicKey 为空时为 null */
  fingerprint?: string | null
}

/** 公钥指纹（sha256 前 16 hex 大写）——与管理台 devices 页同算法 */
export async function publicKeyFingerprint(pubB64: string): Promise<string | null> {
  try {
    const bin = atob(pubB64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  } catch {
    return null
  }
}

// 模块级单例：保证 DevicesView 与 ModalManager 共享同一份设备列表，配对成功后能即时刷新
const devices = ref<Device[]>([])
const loading = ref(false)
// 加载失败状态：与空列表区分开，界面才能渲染「加载失败 + 重试」而不是「暂无设备」
const error = ref<string | null>(null)

/**
 * 设备名取值唯一真相源。
 * 后端 devices 表是 snake_case（device_name），历史代码里散落着 d.name / d.device_name /
 * d.deviceName 三种写法，任一种取不到就退化成 'Unknown Device' 或裸 id。
 * 所有展示设备名的地方（设备列表、筛选下拉、来源列）都必须走这一个函数。
 */
export function resolveDeviceName(d: any): string {
  const raw = d?.name ?? d?.device_name ?? d?.deviceName ?? d?.id
  const name = typeof raw === 'string' ? raw.trim() : ''
  return name || String(d?.id ?? '')
}

/** /api/devices 目前直接返回数组（历史上也返回过 {devices:[...]}），两种都兼容 */
function pickDeviceList(data: any): any[] {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.devices)) return data.devices
  return []
}

/** 为列表里带公钥的设备异步补齐指纹（不阻塞 loadDevices 返回） */
async function computeFingerprints(): Promise<void> {
  for (const d of devices.value) {
    if (!d.publicKey || d.fingerprint) continue
    d.fingerprint = await publicKeyFingerprint(d.publicKey)
  }
}

export function useDevice() {
  async function loadDevices() {
    loading.value = true
    error.value = null
    try {
      const res = await api('GET', '/api/devices')
      if (res.ok) {
        const list = pickDeviceList(res.data)
        devices.value = list.map((d: any) => ({
          id: d.id,
          name: resolveDeviceName(d),
          type: (d.type || d.device_type || 'desktop') as Device['type'],
          lastActive: d.lastActive || d.last_seen_at || new Date().toISOString(),
          online: d.online ?? d.is_online ?? false,
          location: d.location,
          publicKey: typeof d.public_key === 'string' && d.public_key ? d.public_key : null,
          fingerprint: null, // 指纹异步补齐（见下方 computeFingerprints）
        }))
        // 指纹计算是异步的：先落列表（不阻塞 UI），算完回填
        void computeFingerprints()
      } else {
        error.value = res.error || 'Failed to load devices'
      }
    } catch (e: any) {
      error.value = e?.message || 'Failed to load devices'
    } finally {
      loading.value = false
    }
  }

  async function removeDevice(id: string) {
    const res = await api('DELETE', `/api/devices/${id}`)
    if (res.ok) {
      devices.value = devices.value.filter((d) => d.id !== id)
    }
    return res
  }

  return { devices, loading, error, loadDevices, removeDevice }
}
