<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import './modal-shared.css'

const props = defineProps<{ showModalType: string; versionItemId?: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()

// ===== Version History =====
const versionItems = ref<any[]>([])
const loadingVersions = ref(false)
const restoringId = ref<string | null>(null)
const latestVersionNum = ref(0)

async function loadVersions(clipboardItemId: string) {
  loadingVersions.value = true
  versionItems.value = []
  try {
    const res = await api('GET', `/api/versions/${clipboardItemId}`)
    if (res.ok && Array.isArray(res.data?.versions)) {
      versionItems.value = res.data.versions
      latestVersionNum.value = res.data.versions[0]?.versionNumber || 0
    }
  } catch {
    /* ignore */
  }
  loadingVersions.value = false
}

async function restoreVersion(versionId: string) {
  restoringId.value = versionId
  try {
    const res = await api('POST', `/api/versions/restore/${versionId}`)
    if (res.ok) {
      toast.show(t('ver_restored'), 'success')
      // Reload to reflect the new version
      if (props.versionItemId) await loadVersions(props.versionItemId)
    } else {
      toast.show(res.error || 'Failed to restore', 'error')
    }
  } catch (e: any) {
    toast.show(String(e), 'error')
  }
  restoringId.value = null
}

function formatVersionTime(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return d.toLocaleDateString()
}

// 打开版本历史弹窗时按条目加载（当前 versionItemId 未从上层接线，弹窗为空态，
// 与原行为一致；后续接入 version-history 事件后此处自动生效）
watch(
  () => props.showModalType,
  (type) => {
    if (type === 'versions' && props.versionItemId) loadVersions(props.versionItemId)
  },
  { immediate: true },
)
</script>

<template>
  <ModalDialog
    :open="showModalType === 'versions'"
    :title="t('modal_versions')"
    max-width="520px"
    @close="emit('close')"
  >
    <div v-if="loadingVersions" class="modal-state">{{ t('ver_loading') }}</div>
    <div v-else-if="versionItems.length === 0" class="modal-state">{{ t('ver_empty') }}</div>
    <div v-else class="version-list">
      <div v-for="(v, vi) in versionItems" :key="v.id" class="version-item">
        <div class="version-head" style="cursor: pointer" @click="v._expanded = !v._expanded">
          <span class="version-num">v{{ v.versionNumber }}</span>
          <span class="version-time">{{ formatVersionTime(v.createdAt) }}</span>
        </div>
        <!-- Collapsed: short preview -->
        <div v-if="!v._expanded" class="version-preview">{{ v.contentPreview || '(empty)' }}</div>
        <!-- Expanded: full content for diff comparison -->
        <div v-else class="version-full">
          <div class="version-full-label">{{ t('ver_current_content') }}</div>
          <pre class="version-code">{{ v.contentPreview || '(empty)' }}</pre>
          <div v-if="vi < versionItems.length - 1" class="version-diff-hint">
            {{ t('ver_diff_hint') }}: v{{ v.versionNumber }} → v{{ versionItems[vi + 1].versionNumber }}
          </div>
        </div>
        <div class="version-foot">
          <span class="version-device">{{ v.sourceDevice?.name || '' }}</span>
          <Button
            v-if="v.versionNumber !== latestVersionNum"
            variant="ghost"
            size="sm"
            class="version-restore-btn"
            :disabled="restoringId === v.id"
            @click="restoreVersion(v.id)"
          >
            {{ restoringId === v.id ? '...' : t('ver_restore') }}
          </Button>
          <span v-else class="version-current">{{ t('ver_current') }}</span>
        </div>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
.version-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
}
.version-item {
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
}
.version-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.version-num {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
}
.version-time {
  font-size: 11px;
  color: var(--text-tertiary);
}
.version-preview {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  max-height: 3em;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-all;
}
.version-full {
  margin-top: 6px;
}
.version-full-label {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}
.version-code {
  font-size: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
  font-family: 'SF Mono', monospace;
  color: var(--text-secondary);
  margin: 0;
}
.version-diff-hint {
  font-size: 11px;
  color: var(--accent);
  margin-top: 6px;
}
.version-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.version-device {
  font-size: 11px;
  color: var(--text-tertiary);
}
.version-restore-btn {
  font-size: 12px;
  color: var(--accent);
}
.version-current {
  font-size: 11px;
  color: var(--text-tertiary);
  font-weight: 500;
}
</style>
