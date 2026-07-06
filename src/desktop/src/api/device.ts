import { api } from './client'

export interface ServerDevice {
  id: string
  name: string
  type: string
  online: boolean
  lastActive: string
  location?: string
}

export interface PairingInitResult {
  token: string
  expiresAt: number
}

export interface PairingRedeemUser {
  id: string
  phone?: string
  email?: string
  nickname?: string
  avatarUrl?: string
}

export interface PairingRedeemResult {
  token: string
  user: PairingRedeemUser
}

export function fetchDevices() {
  return api<{ devices: ServerDevice[] }>('GET', '/api/devices')
}

// 注意：api(method, path, body) 顺序 —— 之前这里参数顺序写反导致请求失效，已修正
export function addDevice(deviceName: string, deviceType: string = 'desktop', platform: string = 'windows') {
  return api('POST', '/api/devices', { deviceName, deviceType, platform })
}

export function deleteDevice(id: string) {
  return api('DELETE', `/api/devices/${id}`)
}

// 二维码配对：生成一次性令牌（本机已登录设备调用）
export function initPairing() {
  return api<PairingInitResult>('POST', '/api/devices/pairing/init')
}

// 二维码配对：兑换令牌（扫码设备调用，等价于登录到令牌所属账号）
export function redeemPairing(payload: {
  token: string
  deviceName: string
  deviceType: string
  platform: string
}) {
  return api<PairingRedeemResult>('POST', '/api/devices/pairing/redeem', payload)
}
