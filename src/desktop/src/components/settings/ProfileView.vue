<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import { useToast } from '@/composables/useToast'
import { api } from '@/api/client'

const { t } = useI18n()
const configStore = useConfigStore()
const toast = useToast()

const editingName = ref(false)
const nameInput = ref(configStore.user.name || '')

function startEditName() {
  nameInput.value = configStore.user.name || ''
  editingName.value = true
}

async function saveDisplayName() {
  const trimmed = nameInput.value.trim()
  if (!trimmed) { toast.show(t('val_name_required'), 'error'); return }
  if (trimmed.length < 2) { toast.show(t('val_name_short'), 'error'); return }
  if (trimmed.length > 30) { toast.show(t('val_name_long'), 'error'); return }

  try {
    // 调用 API 更新用户名（如果后端支持的话）
    const res = await api('PUT', '/api/user/profile', { displayName: trimmed })
    if (res.ok || res.status === 404) {
      // 404 表示 API 还未实现，但先本地更新
      configStore.user.name = trimmed
      editingName.value = false
      toast.show(t('profile_saved'), 'success')
      // 持久化到 localStorage
      localStorage.setItem('clipsync-display-name', trimmed)
    } else {
      toast.show(res.error || '保存失败', 'error')
    }
  } catch {
    // API 不存在时本地保存
    configStore.user.name = trimmed
    editingName.value = false
    localStorage.setItem('clipsync-display-name', trimmed)
    toast.show(t('profile_saved'), 'success')
  }
}

function cancelEdit() {
  editingName.value = false
  nameInput.value = configStore.user.name || ''
}
</script>

<template>
  <div class="settings-view">
    <h2 class="sv-title">{{ t('prof_t') }}</h2>
    <div class="profile-card">
      <div class="profile-avatar">{{ configStore.user.name?.slice(0, 2) || 'CS' }}</div>
      <div class="profile-details">
        <div class="sg-row">
          <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">{{ t('pf_name') }}</div></div>
          <div v-if="!editingName" class="sg-control sg-control--clickable" @click="startEditName">
            {{ configStore.user.name || t('pf_noset') }}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:4px;opacity:.5;vertical-align:middle;"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
          <div v-else class="sg-edit-group">
            <input v-model="nameInput" class="sg-input" :placeholder="t('pf_name')" maxlength="30" @keyup.enter="saveDisplayName" />
            <button class="btn btn-sm btn-primary" @click="saveDisplayName" style="margin-left:6px;">{{ t('save_btn') }}</button>
            <button class="btn btn-sm btn-ghost" @click="cancelEdit">{{ t('cancel_btn') }}</button>
          </div>
        </div>
        <div class="sg-row">
          <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">{{ t('pf_phone') }}</div></div>
          <div class="sg-control">{{ configStore.config.device_id || t('pf_noset') }}</div>
        </div>
        <div class="sg-row">
          <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">{{ t('pf_plan') }}</div></div>
          <div class="sg-control">{{ t(configStore.user.plan === 'Pro' ? 'role_pro' : 'pf_free') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view { padding: 24px; max-width: 720px; overflow-y: auto; flex: 1; }
.sv-title { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
.profile-card { display: flex; gap: 24px; padding: 24px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); }
.profile-avatar { width: 64px; height: 64px; border-radius: 50%; background: var(--accent); color: var(--text-inverse); display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700; flex-shrink: 0; }
.profile-details { flex: 1; }
.sg-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: var(--radius-md); }
.sg-row:hover { background: var(--bg-hover); }
.sg-label { flex: 1; }
.sg-name { font-size: 14px; font-weight: 500; }
.sg-control { font-size: 13px; color: var(--text-secondary); }
.sg-control--clickable { cursor: pointer; display: flex; align-items: center; transition: color .15s; }
.sg-control--clickable:hover { color: var(--accent); }
.sg-edit-group { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.sg-input { height: 28px; padding: 0 8px; border-radius: var(--radius-sm); border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 13px; outline: none; width: 140px; }
.sg-input:focus { border-color: var(--accent); }
</style>
