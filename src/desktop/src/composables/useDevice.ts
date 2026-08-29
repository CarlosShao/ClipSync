import { ref } from 'vue'
import { api } from '@/api/client'

export interface Device {
  id: string
  name: string
  type: 'desktop' | 'mobile' | 'browser'
  lastActive: string
  online: boolean
  location?: string
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
        }))
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
