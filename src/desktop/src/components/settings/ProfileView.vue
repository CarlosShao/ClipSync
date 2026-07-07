<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const configStore = useConfigStore()
const toast = useToast()

// === Display Name (nickname) ===
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

  const ok = await configStore.updateUserProfile({ displayName: trimmed })
  if (ok) {
    editingName.value = false
    toast.show(t('profile_saved'), 'success')
  } else {
    // API 失败时本地保存（兜底）
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

// === Email ===
const editingEmail = ref(false)
const emailInput = ref(configStore.user.email || '')

function startEditEmail() {
  emailInput.value = configStore.user.email || ''
  editingEmail.value = true
}

async function saveEmail() {
  const trimmed = emailInput.value.trim().toLowerCase()
  if (!trimmed) { toast.show(t('val_email_required'), 'error'); return }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(trimmed)) { toast.show(t('val_email_invalid'), 'error'); return }

  // Email update via profile API (if supported) or local fallback
  try {
    const res = await fetch(`${configStore.serverUrl}/api/auth/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${configStore.config.token}`,
      },
      body: JSON.stringify({ email: trimmed }),
    })
    if (res.ok) {
      configStore.user.email = trimmed
      editingEmail.value = false
      toast.show(t('profile_saved'), 'success')
    } else {
      // API may not support email update yet — save locally as fallback
      configStore.user.email = trimmed
      editingEmail.value = false
      toast.show(t('profile_saved'), 'success')
    }
  } catch {
    configStore.user.email = trimmed
    editingEmail.value = false
    toast.show(t('profile_saved'), 'success')
  }
}

function cancelEditEmail() {
  editingEmail.value = false
  emailInput.value = configStore.user.email || ''
}

// === Avatar ===
const avatarInputRef = ref<HTMLInputElement>()
const avatarUrl = ref(localStorage.getItem('clipsync-avatar') || '')

function triggerAvatarUpload() {
  avatarInputRef.value?.click()
}

async function handleAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  const file = input.files[0]
  if (!file.type.startsWith('image/')) {
    toast.show(t('avatar_img_only') || '请选择图片文件', 'error')
    return
  }
  if (file.size > 5 * 1024 * 1024) {
    toast.show(t('avatar_too_big') || '图片不能超过 5MB', 'error')
    return
  }

  // Convert to base64 data URL for storage + upload
  const reader = new FileReader()
  reader.onload = async () => {
    const dataUrl = reader.result as string
    // Save locally immediately (optimistic)
    avatarUrl.value = dataUrl
    localStorage.setItem('clipsync-avatar', dataUrl)

    // Try to upload to server
    const ok = await configStore.updateUserProfile({ avatarUrl: dataUrl })
    if (!ok) {
      console.warn('[Profile] Avatar upload failed, using local-only')
    } else {
      toast.show(t('avatar_saved') || '头像已更新', 'success')
    }
  }
  reader.readAsDataURL(file)
  input.value = '' // reset so same file can be re-selected
}
</script>

<template>
  <div class="settings-view">
    <h2 class="sv-title">{{ t('prof_t') }}</h2>
    <div class="profile-card">
      <!-- Avatar section -->
      <div class="profile-avatar-wrap" @click="triggerAvatarUpload" :title="t('avatar_change') || '点击更换头像'">
        <img v-if="avatarUrl" :src="avatarUrl" class="profile-avatar-img" alt="Avatar" />
        <div v-else class="profile-avatar">{{ configStore.user.name?.slice(0, 2) || 'CS' }}</div>
        <div class="avatar-overlay">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </div>
        <input ref="avatarInputRef" type="file" accept="image/*" style="display:none" @change="handleAvatarUpload" />
      </div>

      <div class="profile-details">
        <!-- Display Name / Username -->
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

        <!-- Phone (read-only, from login) -->
        <div class="sg-row">
          <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">{{ t('pf_phone') }}</div></div>
          <div class="sg-control">{{ configStore.user.phone || t('pf_noset') }}</div>
        </div>

        <!-- Email -->
        <div class="sg-row">
          <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">EMAIL</div></div>
          <div v-if="!editingEmail" class="sg-control sg-control--clickable" @click="startEditEmail">
            {{ configStore.user.email || t('pf_noset') }}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:4px;opacity:.5;vertical-align:middle;"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
          <div v-else class="sg-edit-group">
            <input v-model="emailInput" type="email" class="sg-input" placeholder="email@example.com" maxlength="100" @keyup.enter="saveEmail" />
            <button class="btn btn-sm btn-primary" @click="saveEmail" style="margin-left:6px;">{{ t('save_btn') }}</button>
            <button class="btn btn-sm btn-ghost" @click="cancelEditEmail">{{ t('cancel_btn') }}</button>
          </div>
        </div>

        <!-- Plan -->
        <div class="sg-row">
          <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">{{ t('pf_plan') }}</div></div>
          <div class="sg-control">{{ t(configStore.user.plan === 'Pro' ? 'role_pro' : 'pf_free') }}</div>
        </div>
      </div>
    </div>

    <!-- Password change hint (links to Settings > Privacy) -->
    <div class="profile-hint">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      <span>{{ t('pwd_change_hint') || '修改密码请前往 设置 → 隐私和安全 → 修改密码' }}</span>
    </div>
  </div>
</template>

<style scoped>
.settings-view { padding: 24px; max-width: 720px; overflow-y: auto; flex: 1; }
.sv-title { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
.profile-card { display: flex; gap: 24px; padding: 24px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); }

/* Avatar */
.profile-avatar-wrap {
  position: relative;
  width: 80px;
  height: 80px;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
  transition: transform .15s, box-shadow .15s;
}
.profile-avatar-wrap:hover {
  transform: scale(1.04);
  box-shadow: 0 0 0 3px var(--accent-light);
}
.profile-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.profile-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  font-weight: 700;
}
.avatar-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,.45);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  opacity: 0;
  transition: opacity .15s;
}
.profile-avatar-wrap:hover .avatar-overlay { opacity: 1; }

/* Details */
.profile-details { flex: 1; }
.sg-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: var(--radius-md); }
.sg-row:hover { background: var(--bg-hover); }
.sg-label { flex: 1; }
.sg-name { font-size: 14px; font-weight: 500; }
.sg-control { font-size: 13px; color: var(--text-secondary); }
.sg-control--clickable { cursor: pointer; display: flex; align-items: center; transition: color .15s; }
.sg-control--clickable:hover { color: var(--accent); }
.sg-edit-group { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.sg-input { height: 28px; padding: 0 8px; border-radius: var(--radius-sm); border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 13px; outline: none; width: 160px; }
.sg-input:focus { border-color: var(--accent); }

/* Hint */
.profile-hint {
  margin-top: 16px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  background: var(--bg-hover);
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
