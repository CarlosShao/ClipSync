import { useI18n } from '@/composables/useI18n'

export function timeAgo(ts: number): string {
  const { t } = useI18n()
  const diff = Date.now() - ts
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return Math.floor(diff / 86400000) + t('d_ago')
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}

export function simpleHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i)
    hash |= 0
  }
  return hash.toString(36)
}

export function imgHash(b64: string): string {
  return b64.slice(0, 200)
}

export function getTypeBadge(type: string): string {
  const map: Record<string, string> = { text: 'TXT', image: 'IMG', file: 'FILE', link: 'URL' }
  return map[type] || type.toUpperCase()
}

export function checkPwdStrength(pwd: string): { score: number; label: string } {
  let score = 0
  if (pwd.length >= 8) score++
  if (pwd.length >= 12) score++
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++
  if (/\d/.test(pwd)) score++
  if (/[^a-zA-Z0-9]/.test(pwd)) score++
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong']
  return { score, label: labels[score] || '' }
}

export function isValidPhone(phone: string): boolean {
  return /^1\d{10}$/.test(phone)
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function isValidCode(code: string): boolean {
  return /^\d{6}$/.test(code)
}
