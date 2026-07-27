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

// ============================================
// 两步验证（2FA / TOTP）
// ============================================

/** 查询 2FA 是否已开启 */
export function get2FAStatus() {
  return api('GET', '/api/auth/2fa/status')
}

/** 开启设置：生成待确认密钥，返回 secret + otpauthUri 供扫码 */
export function setup2FA() {
  return api('POST', '/api/auth/2fa/setup')
}

/** 确认开启：校验动态码，落盘密钥 + 返回 10 个备份码 */
export function enable2FA(code: string) {
  return api('POST', '/api/auth/2fa/enable', { code })
}

/** 关闭 2FA：需提供动态码或备份码 */
export function disable2FA(code: string) {
  return api('POST', '/api/auth/2fa/disable', { code })
}

/** 登录挑战：消费 challengeToken，校验动态码后返回正式会话 token */
export function verify2FALogin(challengeToken: string, code: string) {
  return api('POST', '/api/auth/2fa/verify-login', { challengeToken, code })
}
