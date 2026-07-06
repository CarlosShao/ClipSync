import { api } from './client'

export interface ServerDevice {
  id: string
  name: string
  type: string
  online: boolean
  lastActive: string
  location?: string
}

export function fetchDevices() {
  return api<{ devices: ServerDevice[] }>('/api/devices', 'GET')
}

export function addDevice(name: string, type: string = 'desktop') {
  return api('/api/devices', 'POST', { name, type })
}

export function deleteDevice(id: string) {
  return api(`/api/devices/${id}`, 'DELETE')
}
