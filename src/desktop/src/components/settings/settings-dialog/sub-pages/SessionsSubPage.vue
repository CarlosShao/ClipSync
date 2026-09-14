<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import { useConfigStore } from '@/stores/configStore'
import Button from '@/components/ui/button/Button.vue'
import { Monitor, Smartphone } from 'lucide-vue-next'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

// ===== State =====
// 与后端 GET /api/sessions 返回的行结构对齐（sessions.js）：设备名/平台/时间用驼峰字段。
interface SessionItem {
  id: string
  deviceName?: string
  platform?: string
  ipAddress?: string
  createdAt?: string | number
  lastActiveAt?: string | number
  isCurrent: boolean
}

const configStore = useConfigStore()
const sessionItems = ref<SessionItem[]>([])
const loadingSessions = ref(false)
const revokingId = ref<string | null>(null)

// 本机会话 id：从 JWT payload 解出（登录令牌携带 sessionId/jti，见服务端 routes/auth-password.js）。
// 后端 GET /api/sessions 的 isCurrent 依赖请求头/JWT 的会话标识；此处前端自解，
// 使「当前设备」判定不依赖后端版本（后端未带该标识逻辑时也能正确显示，避免误踢自己）。
function currentSessionIdFromToken(): string {
  try {
    const token = configStore.config.token
    if (!token) return ''
    const part = token.split('.')[1]
    if (!part) return ''
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    const bin = atob(b64 + pad)
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
    return json?.sessionId || json?.jti || ''
  } catch {
    return ''
  }
}

// ===== Data loading =====
async function loadSessions() {
  loadingSessions.value = true
  try {
    const res = await api('GET', '/api/sessions')
    // api() 把整个响应体作为 res.data 返回，后端 GET / 的形态是
    // { success: true, data: { sessions: [...] } }，故 sessions 在 res.data.data 下。
    // 兼容读取：优先嵌套结构，回退扁平结构（res.data.sessions）。
    const rows = res.data?.data?.sessions ?? res.data?.sessions
    if (res.ok && Array.isArray(rows)) {
      const currentDeviceId = localStorage.getItem('clipsync-device-id')
      const mySessionId = currentSessionIdFromToken()
      sessionItems.value = (rows as any[]).map((s: any) => ({
        id: s.id,
        deviceName: s.deviceName || s.device_name || '',
        platform: s.platform || '',
        ipAddress: s.ipAddress || '',
        createdAt: s.createdAt ?? s.created_at,
        lastActiveAt: s.lastActiveAt ?? s.last_active ?? s.createdAt ?? s.created_at,
        // 后端标记优先；否则用本机 JWT 解出的 sessionId 比对；最后回退设备 id 比对。
        // 用「或」而非「??」，因为未打补丁的后端会对所有行返回 isCurrent:false。
        isCurrent:
          s.isCurrent === true ||
          s.is_current === true ||
          s.current === true ||
          (!!s.id && s.id === mySessionId) ||
          (!!s.device_id && s.device_id === currentDeviceId),
      }))
    } else {
      sessionItems.value = []
    }
  } catch {
    sessionItems.value = []
  }
  loadingSessions.value = false
}

function formatSessionTime(ts: string | number | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  if (isNaN(diff)) return ''
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return Math.floor(diff / 86400000) + t('d_ago')
}

async function revokeSession(sessionId: string) {
  revokingId.value = sessionId
  try {
    const res = await api('DELETE', `/api/sessions/${sessionId}`)
    if (res.ok) {
      toast.show(t('sess_revoked'), 'success')
      sessionItems.value = sessionItems.value.filter((s) => s.id !== sessionId)
    } else {
      toast.show(res.error || 'Failed to revoke session', 'error')
    }
  } catch (e: any) {
    toast.show(t('sess_revoke_fail') + String(e), 'error')
  }
  revokingId.value = null
}

onMounted(() => {
  loadSessions()
})
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('modal_sessions') }}</h3>
    <p class="sp-desc">{{ t('sg_sessions_h') }}</p>

    <!-- Loading -->
    <div v-if="loadingSessions" class="modal-state">{{ t('sess_loading') }}</div>

    <!-- Empty -->
    <div v-else-if="sessionItems.length === 0" class="modal-state">{{ t('sess_empty') }}</div>

    <!-- Session list -->
    <div v-else class="session-list">
      <div v-for="s in sessionItems" :key="s.id" class="session-item">
        <div class="session-icon">
          <Monitor v-if="s.isCurrent" :size="20" />
          <Smartphone v-else :size="20" />
        </div>
        <div class="session-info">
          <div class="session-name">{{ s.deviceName || 'Unknown Device' }}</div>
          <div class="session-detail">
            {{ s.isCurrent ? t('sess_current') : formatSessionTime(s.lastActiveAt || s.createdAt) }}
          </div>
        </div>
        <span v-if="s.isCurrent" class="session-badge">{{ t('sess_current') }}</span>
        <Button
          v-else
          variant="ghost"
          size="sm"
          class="session-revoke-btn"
          :disabled="revokingId === s.id"
          @click="revokeSession(s.id)"
        >
          {{ revokingId === s.id ? '...' : t('sess_sign_out_btn') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sp-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}
.sp-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}
.modal-state {
  text-align: center;
  padding: 24px;
  color: var(--text-tertiary);
}
.session-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.session-item:last-child {
  border-bottom: none;
}
.session-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}
.session-info {
  flex: 1;
}
.session-name {
  font-size: 13px;
  font-weight: 500;
}
.session-detail {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
.session-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-light);
  padding: 2px 8px;
  border-radius: 8px;
}
.session-revoke-btn {
  color: var(--danger);
}
</style>
