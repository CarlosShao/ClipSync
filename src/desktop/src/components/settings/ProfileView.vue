<script setup lang="ts">
import FxPageHeader from '@/components/fx/FxPageHeader.vue'
import FxSpotlightCard from '@/components/fx/FxSpotlightCard.vue'
import { vFxReveal } from '@/components/fx/fxReveal'
import { vFxTilt } from '@/components/fx/fxTilt'
// 与剪贴板 / 收藏页 / 设备页统计卡同一配方（accent 13% 聚光）
const STAT_SPOT = 'color-mix(in srgb, var(--accent) 13%, transparent)'
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
    <!-- 页头：与剪贴板 / 收藏 / 设备 / 模板库统一用 FxPageHeader（破折号 → eyebrow 逐字 → 标题逐字 → 副标题） -->
    <FxPageHeader
      class="pf-head"
      eyebrow="Profile"
      :title="t('prof_t')"
      :subtitle="tf('page_sub_profile', '账号信息与套餐 · 头像、名称、邮箱可在此修改')"
    />
    <div class="pf-grid">
      <FxSpotlightCard v-fx-reveal v-fx-tilt="5" class="profile-card" :spotlight-color="STAT_SPOT">
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
    </FxSpotlightCard>

    <!-- 套餐管理（升级/申请退款）：订阅页砍掉后，个人资料页是套餐管理唯一场所 -->
      <PlanManagementCard v-if="showPlanCard" v-fx-reveal @open-modal="(type) => emit('open-modal', type)" />
    </div>

    <!-- Password change hint -->
    <div class="profile-hint" v-fx-reveal>
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

/* ---- 排版重构：两栏 + 配对收紧 + 提示条降级 ----
   诊断（对着界面量的）：
     ① .sg-row 用 justify-content: space-between，而卡片近 1000px 宽 ⇒ 「标签…值」被拉到两端，
        眼睛要跨 ~800px 才能配对，四行下来是"上下 + 左右"双重扫视；
     ② 三块内容全纵向堆在一个超宽单列里 ⇒ 套餐卡下方整块留白，页面显得散；
     ③ 提示条铺满通栏 + 灰底 ⇒ 视觉权重高于内容，像"被禁用区域"，可它只是脚注。
   做法：宽屏两栏（资料卡 1.6fr / 套餐卡 1fr），窄屏回落单列；资料行改"标签定宽 + 值左对齐"，
   视线距离从 ~800px 收到 ~120px；提示条去掉底色降为脚注。数据与交互逻辑一行未改。 */
.pf-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}
@media (max-width: 1100px) {
  .pf-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.sg-row {
  justify-content: flex-start;
  gap: 12px;
  padding: 11px 12px;
  border-radius: 0;
  /* 只在行间画线（首行不留线，末行由 :last-child 去掉） */
  border-bottom: 1px solid var(--border-subtle);
}
.sg-row:last-child {
  border-bottom: 0;
}
.sg-label {
  flex: none;
  width: 84px;
}
.sg-control {
  flex: 1;
  min-width: 0;
  text-align: left;
}
.profile-hint {
  margin-top: 12px;
  padding: 0 2px;
  background: transparent;
  border: 0;
  color: var(--text-tertiary);
  font-size: 11.5px;
}

/* ---- 排版重构 v2：单列收窄居中（取代被否掉的 1.6:1 两栏）----
   用户反馈 v1 的"一边大一边小"很丑。这类内容少的页面正确做法不是硬分栏，
   而是把内容列收窄到易读宽度、单列居中：左右边对齐、没有大小对比、也没有大片留白。
   （标签定宽 + 值左对齐的"配对收紧"保留，那条是有效的。） */
.settings-view {
  max-width: 780px;
}
.pf-grid {
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}

/* ---- 纵向节奏：页头与首张卡之间必须有间距 ----
   原来 FxPageHeader 直接放在页里，没有其它页面那层 .page-head 容器提供下边距，
   于是副标题和卡片贴在一起（用户实测"一点边距没有"）。 */
.pf-head {
  margin-bottom: 18px;
}
/* 卡片之间与脚注的间距（脚注要更靠近内容，别飘走） */
.pf-grid {
  margin-bottom: 0;
}
</style>
