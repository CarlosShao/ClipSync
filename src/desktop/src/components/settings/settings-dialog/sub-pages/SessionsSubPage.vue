<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import Button from '@/components/ui/button/Button.vue'
import { Monitor, Smartphone } from 'lucide-vue-next'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

// ===== State =====
interface SessionItem {
  id: string
  deviceName?: string
  device_type?: string
  last_active?: string
  created_at?: string
  isCurrent: boolean
}

const sessionItems = ref<SessionItem[]>([])
const loadingSessions = ref(false)
const revokingId = ref<string | null>(null)

// ===== Data loading =====
async function loadSessions() {
  loadingSessions.value = true
  try {
    const res = await api('GET', '/api/user/sessions')
    if (res.ok && Array.isArray(res.data?.sessions)) {
      const currentDeviceId = localStorage.getItem('clipsync-device-id')
      sessionItems.value = (res.data.sessions as any[]).map((s: any) => ({
        ...s,
        isCurrent: s.device_id === currentDeviceId || s.is_current || s.current,
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
    const res = await api('DELETE', `/api/user/sessions/${sessionId}`)
    if (res.ok) {
      toast.show(t('sess_revoked'), 'success')
      sessionItems.value = sessionItems.value.filter(s => s.id !== sessionId)
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
          <div class="session-name">{{ s.deviceName || s.device_type || 'Unknown Device' }}</div>
          <div class="session-detail">
            {{ s.isCurrent ? t('sess_current') : formatSessionTime(s.last_active || s.created_at) }}
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
.sp-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.sp-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
.modal-state { text-align: center; padding: 24px; color: var(--text-tertiary); }
.session-list { display: flex; flex-direction: column; gap: 8px; }
.session-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 0; border-bottom: 1px solid var(--border-subtle);
}
.session-item:last-child { border-bottom: none; }
.session-icon { flex-shrink: 0; color: var(--text-secondary); }
.session-info { flex: 1; }
.session-name { font-size: 13px; font-weight: 500; }
.session-detail { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }
.session-badge {
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  color: var(--accent); background: var(--accent-light);
  padding: 2px 8px; border-radius: 8px;
}
.session-revoke-btn { color: var(--danger); }
</style>
