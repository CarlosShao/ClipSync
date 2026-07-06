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

export function useDevice() {
  const devices = ref<Device[]>([])

  async function loadDevices() {
    const res = await api('GET', '/api/devices')
    if (res.ok && Array.isArray(res.data?.devices)) {
      devices.value = res.data.devices.map((d: any) => ({
        id: d.id,
        name: d.name || 'Unknown Device',
        type: d.type || 'desktop',
        lastActive: d.lastActive || new Date().toISOString(),
        online: d.online ?? false,
        location: d.location,
      }))
    }
  }

  async function removeDevice(id: string) {
    const res = await api('DELETE', `/api/devices/${id}`)
    if (res.ok) {
      devices.value = devices.value.filter(d => d.id !== id)
    }
    return res
  }

  return { devices, loadDevices, removeDevice }
}
