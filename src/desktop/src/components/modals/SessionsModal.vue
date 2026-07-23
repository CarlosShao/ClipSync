<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import { Monitor, Smartphone } from 'lucide-vue-next'
import './modal-shared.css'

const props = defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()

// ===== Sessions (real API) =====
const sessionItems = ref<any[]>([])
const loadingSessions = ref(false)
const revokingId = ref<string | null>(null)

async function loadSessions() {
  if (props.showModalType !== 'sessions') return
  loadingSessions.value = true
  try {
    const res = await api('GET', '/api/sessions')
    if (res.ok && Array.isArray(res.data?.sessions)) {
      // Mark current session
      const currentDeviceId = localStorage.getItem('clipsync-device-id')
      sessionItems.value = (res.data.sessions as any[]).map((s: any) => ({
        ...s,
        isCurrent: s.device_id === currentDeviceId || s.is_current || s.current,
      }))
    } else {
      sessionItems.value = []
    }
  } catch {
    sessionItems.value = [] // API not available → show empty
  }
  loadingSessions.value = false
}

function formatSessionTime(ts: string | number): string {
  const diff = Date.now() - new Date(ts).getTime()
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

// 打开会话弹窗时自动加载（异步 v-if 门控下 immediate watch 覆盖首次挂载）
watch(
  () => props.showModalType,
  (type) => {
    if (type === 'sessions') loadSessions()
  },
  { immediate: true },
)
</script>

<template>
  <ModalDialog
    :open="showModalType === 'sessions'"
    :title="t('modal_sessions')"
    max-width="480px"
    @close="
      () => {
        emit('close')
        loadSessions()
      }
    "
  >
    <div v-if="loadingSessions" class="modal-state">{{ t('sess_loading') }}</div>
    <div v-else-if="sessionItems.length === 0" class="modal-state">{{ t('sess_empty') }}</div>
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
          >{{ revokingId === s.id ? '...' : t('sess_sign_out_btn') }}</Button
        >
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
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
