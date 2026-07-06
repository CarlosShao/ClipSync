import { api } from './client'

export function login(phone: string, code: string) {
  return api('POST', '/api/auth/login', { phone, code })
}

export function sendVerificationCode(phone: string) {
  return api('POST', '/api/auth/send-code', { phone })
}

export function register(data: { phone: string; code: string; password: string; nickname?: string; email?: string }) {
  return api('POST', '/api/auth/register', data)
}

export function setPassword(data: { phone: string; code: string; password: string }) {
  return api('POST', '/api/auth/set-password', data)
}

export function forgotPassword(email: string) {
  return api('POST', '/api/auth/forgot-password', { email })
}

export function resetPassword(data: { email: string; code: string; password: string }) {
  return api('POST', '/api/auth/reset-password', data)
}
