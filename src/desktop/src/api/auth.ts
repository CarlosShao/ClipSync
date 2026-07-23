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

/** Send PIN reset verification code (phone) */
export async function sendPinResetCode(phone: string): Promise<boolean> {
  const res = await api('POST', '/api/auth/send-reset-pin-code', { phone })
  return res.ok
}

/** Send PIN reset verification code (email) */
export async function sendPinResetEmailCode(email: string): Promise<boolean> {
  const res = await api('POST', '/api/auth/send-reset-pin-email-code', { email })
  return res.ok
}

/** Verify code and reset PIN (backend validates identity, frontend stores new PIN) */
export async function resetPinViaCode(phoneOrEmail: string, code: string, method: 'phone' | 'email'): Promise<boolean> {
  const body: any = { code }
  if (method === 'phone') body.phone = phoneOrEmail
  else body.email = phoneOrEmail
  const res = await api('POST', '/api/auth/reset-pin', body)
  return res.ok
}
