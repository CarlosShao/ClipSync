<script setup lang="ts">
import { computed, ref } from 'vue'
import { Camera, Pencil, Lock } from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'
import { useUser } from '@/composables/useUser'
import { useMenuAccess } from '@/composables/useMenuAccess'
import { useConfigStore } from '@/stores/configStore'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Avatar from '@/components/ui/avatar/Avatar.vue'
import AvatarImageComp from '@/components/ui/avatar/AvatarImage.vue'
import AvatarFallbackComp from '@/components/ui/avatar/AvatarFallback.vue'
import Label from '@/components/ui/label/Label.vue'
import PlanManagementCard from './PlanManagementCard.vue'

const emit = defineEmits<{ 'open-modal': [type: string] }>()

const { t, tf } = useI18n()
const configStore = useConfigStore()
const toast = useSonner()
const { isSuperAdmin } = useUser()
const { can } = useMenuAccess()
// 套餐管理卡：flag 关闭或超管（无商业身份语义）整卡不渲染
const showPlanCard = computed(() => can('nav.subscription') && !isSuperAdmin.value)

// === Display Name (nickname) ===
const editingName = ref(false)
const nameInput = ref(configStore.user.name || '')

function startEditName() {
  nameInput.value = configStore.user.name || ''
  editingName.value = true
}

async function saveDisplayName() {
  const trimmed = nameInput.value.trim()
  if (!trimmed) {
    toast.show(t('val_name_required'), 'error')
    return
  }
  if (trimmed.length < 2) {
    toast.show(t('val_name_short'), 'error')
    return
  }
  if (trimmed.length > 30) {
    toast.show(t('val_name_long'), 'error')
    return
  }

  const ok = await configStore.updateUserProfile({ displayName: trimmed })
  if (ok) {
    editingName.value = false
    toast.show(t('profile_saved'), 'success')
  } else {
    // 保存失败：不改本地 state、不退出编辑态，如实报错
    toast.show(tf('profile_save_fail', '保存失败，请稍后重试'), 'error')
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
  if (!trimmed) {
    toast.show(t('val_email_required'), 'error')
    return
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(trimmed)) {
    toast.show(t('val_email_invalid'), 'error')
    return
  }

  // 走统一封装（带鉴权/CSRF/超时/401 刷新），以 res.ok 判定真实结果
  const res = await api('PUT', '/api/auth/profile', { email: trimmed })
  if (res.ok) {
    configStore.user.email = trimmed
    editingEmail.value = false
    toast.show(t('profile_saved'), 'success')
  } else {
    // 保存失败：不改本地 email、不退出编辑态，如实报错
    toast.show(tf('profile_save_fail', '保存失败，请稍后重试'), 'error')
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

  const reader = new FileReader()
  reader.onload = async () => {
    const dataUrl = reader.result as string
    avatarUrl.value = dataUrl
    localStorage.setItem('clipsync-avatar', dataUrl)
    // 通知侧栏等消费方立即更新（HomeView 监听此事件同步头像）
    window.dispatchEvent(new Event('clipsync:avatar-changed'))

    const ok = await configStore.updateUserProfile({ avatarUrl: dataUrl })
    if (!ok) {
      // 本地预览保留，但服务端未保存成功必须如实告知
      console.warn('[Profile] Avatar upload failed, using local-only')
      toast.show(tf('profile_save_fail', '保存失败，请稍后重试'), 'error')
    } else {
      toast.show(t('avatar_saved') || '头像已更新', 'success')
    }
  }
  reader.readAsDataURL(file)
  input.value = ''
}
</script>

<template>
  <div class="settings-view">
    <h2 class="sv-title">{{ t('prof_t') }}</h2>
    <div class="profile-card">
      <!-- Avatar section — shadcn Avatar -->
      <div class="avatar-wrap" :title="t('avatar_change') || '点击更换头像'" @click="triggerAvatarUpload">
        <Avatar class="avatar-shadcn">
          <AvatarImageComp v-if="avatarUrl" :src="avatarUrl" alt="Avatar" />
          <AvatarFallbackComp>{{ configStore.user.name?.slice(0, 2) || 'CS' }}</AvatarFallbackComp>
        </Avatar>
        <div class="avatar-overlay">
          <Camera :size="16" />
        </div>
        <input ref="avatarInputRef" type="file" accept="image/*" style="display: none" @change="handleAvatarUpload" />
      </div>

      <div class="profile-details">
        <!-- Display Name / Username -->
        <div class="sg-row">
          <Label class="sg-label">{{ t('pf_name') }}</Label>
          <div v-if="!editingName" class="sg-control sg-control--clickable" @click="startEditName">
            {{ configStore.user.name || t('pf_noset') }}
            <Pencil :size="12" style="margin-left: 4px; opacity: 0.5" />
          </div>
          <div v-else class="sg-edit-group">
            <Input
              v-model="nameInput"
              :placeholder="t('pf_name')"
              maxlength="30"
              class="sg-input-shadcn"
              @keyup.enter="saveDisplayName"
            />
            <Button variant="outline" size="sm" class="sg-save-btn" @click="saveDisplayName">{{
              t('save_btn')
            }}</Button>
            <Button variant="ghost" size="sm" class="sg-cancel-btn" @click="cancelEdit">{{ t('cancel_btn') }}</Button>
          </div>
        </div>

        <!-- Phone (read-only, from login) -->
        <div class="sg-row">
          <Label class="sg-label">{{ t('pf_phone') }}</Label>
          <div class="sg-control">{{ configStore.user.phone || t('pf_noset') }}</div>
        </div>

        <!-- Email -->
        <div class="sg-row">
          <Label class="sg-label">EMAIL</Label>
          <div v-if="!editingEmail" class="sg-control sg-control--clickable" @click="startEditEmail">
            {{ configStore.user.email || t('pf_noset') }}
            <Pencil :size="12" style="margin-left: 4px; opacity: 0.5" />
          </div>
          <div v-else class="sg-edit-group">
            <Input
              v-model="emailInput"
              type="email"
              placeholder="email@example.com"
              maxlength="100"
              class="sg-input-shadcn"
              @keyup.enter="saveEmail"
            />
            <Button variant="outline" size="sm" class="sg-save-btn" @click="saveEmail">{{ t('save_btn') }}</Button>
            <Button variant="ghost" size="sm" class="sg-cancel-btn" @click="cancelEditEmail">{{
              t('cancel_btn')
            }}</Button>
          </div>
        </div>

        <!-- Plan（与左下角角色一致：超级管理员显示超管而非底层套餐） -->
        <div class="sg-row">
          <Label class="sg-label">{{ t('pf_plan') }}</Label>
          <div class="sg-control">
            {{ isSuperAdmin ? t('role_super_admin') : t('role_' + (configStore.user.plan || 'Free').toLowerCase()) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 套餐管理（升级/申请退款）：订阅页砍掉后，个人资料页是套餐管理唯一场所 -->
    <PlanManagementCard v-if="showPlanCard" @open-modal="(type) => emit('open-modal', type)" />

    <!-- Password change hint -->
    <div class="profile-hint">
      <Lock :size="14" style="flex-shrink: 0" />
      <span>{{ t('pwd_change_hint') || '修改密码请前往 设置 → 隐私和安全 → 修改密码' }}</span>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  padding: 20px 28px 48px;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  box-sizing: border-box;
  overflow-y: auto;
  flex: 1;
}
.sv-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 18px;
  letter-spacing: 0.2px;
}
.profile-card {
  display: flex;
  gap: 20px;
  padding: 20px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

/* Avatar — wraps shadcn Avatar with hover overlay */
.avatar-wrap {
  position: relative;
  width: 80px;
  height: 80px;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
  transition:
    transform 0.15s,
    box-shadow 0.15s;
}
.avatar-wrap:hover {
  transform: scale(1.04);
  box-shadow: 0 0 0 3px var(--accent-light);
}
.avatar-wrap:active {
  transform: scale(0.98);
}
.avatar-shadcn {
  width: 80px !important;
  height: 80px !important;
}
.avatar-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--scrim-foreground);
  opacity: 0;
  transition: opacity 0.15s;
}
.avatar-wrap:hover .avatar-overlay {
  opacity: 1;
}

/* Details */
.profile-details {
  flex: 1;
}
.sg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: var(--radius-md);
}
.sg-row:hover {
  background: var(--bg-hover);
}
.sg-label {
  flex: 1;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
  color: var(--text-secondary);
}
.sg-control {
  font-family: var(--font-content);
  font-size: 12.5px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
}
.sg-control--clickable {
  cursor: pointer;
  transition: color 0.15s;
}
.sg-control--clickable:hover {
  color: var(--accent);
}
.sg-edit-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.sg-input-shadcn {
  width: 160px;
  height: 32px;
  padding-left: 12px !important;
  padding-right: 12px !important;
}
.sg-save-btn {
  padding-left: 14px !important;
  padding-right: 14px !important;
}
.sg-cancel-btn {
  padding-left: 10px !important;
  padding-right: 10px !important;
}

/* Hint */
.profile-hint {
  margin-top: 16px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface));
  border: 1px solid color-mix(in srgb, var(--accent) 14%, transparent);
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.profile-hint :deep(svg) {
  color: var(--accent);
}
</style>
