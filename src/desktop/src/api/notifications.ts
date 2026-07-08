import { api } from './client'

export interface NotificationHistoryRow {
  id: number | string
  user_id?: string
  notification_type: string
  title: string
  content?: string | null
  status?: string
  sent_at?: string | null
  read_at?: string | null
  metadata?: any
  created_at?: string
}

export interface NotificationPreferenceRow {
  user_id?: string
  notification_type: string
  enabled: boolean
}

/** GET /api/notifications/history — 拉取通知历史 */
export function getNotificationHistory(limit = 100, offset = 0, status?: string) {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (status) qs.set('status', status)
  return api<NotificationHistoryRow[]>('GET', `/api/notifications/history?${qs.toString()}`)
}

/** PUT /api/notifications/history/:id/read — 标记单条已读 */
export function markNotificationRead(id: string | number) {
  return api('PUT', `/api/notifications/history/${id}/read`)
}

/** GET /api/notifications/preferences — 取通知偏好 */
export function getNotificationPreferences() {
  return api<NotificationPreferenceRow[]>('GET', '/api/notifications/preferences')
}

/** PUT /api/notifications/preferences — 改通知偏好 */
export function updateNotificationPreference(notificationType: string, enabled: boolean) {
  return api('PUT', '/api/notifications/preferences', { notificationType, enabled })
}
