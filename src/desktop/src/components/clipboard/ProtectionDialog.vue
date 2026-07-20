<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useProtection, type ProtectionLevel } from '@/composables/useProtection'
import { useClipboard } from '@/composables/useClipboard'
import { usePrivacy } from '@/composables/usePrivacy'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import { Input } from '@/components/ui/input'
import { Lock, Unlock, Shield, Key, Eye, EyeOff, Copy, AlertTriangle } from 'lucide-vue-next'

const clip = useClipboard()
const privacy = usePrivacy()
const toast = useSonner()

// 直接硬编码中文，避免 i18n 字典查找失败导致显示原始 key
const L = {
  title: '保护级别',
  desc: '选择保护级别',
  none: '无保护',
  none_desc: '不加密，任何人可查看',
  pin: 'PIN 保护',
  pin_desc: '需要 PIN 验证，超时自动锁定',
  advanced: '高级加密',
  advanced_desc: '强加密保护，解锁后本次会话永久可见，忘记密码可通过恢复密钥恢复',
  password: '密码',
  password_ph: '输入密码（至少4位）',
  confirm_pwd: '确认密码',
  confirm_pwd_ph: '再次输入密码',
  pwd_mismatch: '两次密码不一致',
  apply: '应用',
  remove: '移除保护',
  unlock_desc: '输入密码解锁此条目',
  enter_pwd: '密码',
  pwd_ph: '输入密码',
  use_recovery: '使用恢复密钥',
  recovery_key: '恢复密钥',
  recovery_ph: '输入128位恢复密钥',
  recovery_info: '使用恢复密钥解锁。恢复密钥在设置高级加密时生成，长度为128位十六进制字符。',
  save_recovery: '保存恢复密钥',
  recovery_warn: '请将此恢复密钥保存到安全位置。忘记密码时需要用它恢复访问。',
  i_saved: '我已保存',
  applied: '保护已应用',
  applied_desc: '保护级别已更新',
  cancel: '取消',
  saving: '保存中...',
  unlocking: '解锁中...',
  unlock: '解锁',
  back: '返回',
  close: '×',
}

const protection = useProtection()

interface Props {
  open: boolean
  itemId: string
  content?: string
  currentLevel?: ProtectionLevel
  itemName?: string
  isUnlocked?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  content: '',
  currentLevel: 'none',
  itemName: 'item',
  isUnlocked: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'protected': [level: ProtectionLevel]
  'unprotected': []
  'unlocked': [content: string]
}>()

// State
const selectedLevel = ref<ProtectionLevel>(props.currentLevel)
const password = ref('')
const confirmPassword = ref('')
const showPassword = ref(false)
const showRecoveryKey = ref(false)
const recoveryKey = ref('')
const isUnlocking = ref(false)
const unlockPassword = ref('')
const step = ref<'select' | 'setup' | 'unlock' | 'recovery' | 'recovery_display' | 'success'>('select')

// Computed
const canSetup = computed(() => {
  if (selectedLevel.value === 'none') return true
  if (selectedLevel.value === 'pin') return true
  if (selectedLevel.value === 'advanced') {
    return password.value.length >= 4 && password.value === confirmPassword.value
  }
  return false
})

const hasChanges = computed(() => {
  return selectedLevel.value !== props.currentLevel
})

// Watch for dialog open
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    selectedLevel.value = props.currentLevel
    password.value = ''
    confirmPassword.value = ''
    showPassword.value = false
    showRecoveryKey.value = false
    recoveryKey.value = ''
    unlockPassword.value = ''
    // 已解锁的条目总是显示保护选项（select），允许用户修改保护级别
    step.value = (props.currentLevel === 'none' || props.isUnlocked) ? 'select' : 'unlock'
  }
})

// Methods
async function handleSetup() {
  if (!canSetup.value) return
  
  const result = await protection.setupProtection(
    props.itemId,
    selectedLevel.value as 'pin' | 'advanced',
    selectedLevel.value === 'advanced' ? password.value : undefined,
    selectedLevel.value === 'advanced' ? props.content : undefined
  )
  
  if (result) {
    if (result.recoveryKey) {
      recoveryKey.value = result.recoveryKey
      step.value = 'recovery_display'
    } else {
      // 直接关闭弹窗，不显示 success 步骤（由父组件 toast 提示）
      emit('protected', selectedLevel.value)
      emit('update:open', false)
    }
  }
}

async function handleUnlock() {
  if (!unlockPassword.value) return

  isUnlocking.value = true

  if (props.currentLevel === 'pin') {
    // PIN 保护：本地验证 PIN，不走服务端
    const ok = privacy.verifyPin(unlockPassword.value)
    isUnlocking.value = false
    if (ok) {
      privacy.startPeek(props.itemId)
      emit('unlocked', props.content)
      emit('update:open', false)
    } else {
      protection.error.value = 'PIN 错误'
    }
  } else {
    // 高级加密：走服务端解密
    const content = await protection.unlock(props.itemId, unlockPassword.value)
    isUnlocking.value = false
    if (content) {
      emit('unlocked', content)
      emit('update:open', false)
    }
  }
}

async function handleRecoveryUnlock() {
  if (!recoveryKey.value || recoveryKey.value.length !== 128) return
  
  isUnlocking.value = true
  const content = await protection.unlockWithRecovery(props.itemId, recoveryKey.value)
  isUnlocking.value = false
  
  if (content) {
    emit('unlocked', content)
    emit('update:open', false)
  }
}

async function handleRemove() {
  const content = await protection.removeProtection(
    props.itemId,
    selectedLevel.value === 'advanced' ? unlockPassword.value : undefined
  )
  
  emit('unprotected')
  emit('update:open', false)
}

async function copyRecoveryKey() {
  const ok = await clip.copyText(recoveryKey.value)
  if (ok) toast.show('恢复密钥已复制', 'success')
}

function nextStep() {
  if (step.value === 'recovery_display') {
    emit('protected', selectedLevel.value)
    emit('update:open', false)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="protection-backdrop" @click="emit('update:open', false)" />
    <div v-if="open" class="protection-dialog">
      <!-- Header -->
      <div class="protection-header">
        <Shield :size="20" class="protection-icon" />
        <h3>{{ L.title }}</h3>
        <button class="protection-close" @click="emit('update:open', false)">{{ L.close }}</button>
      </div>

      <!-- Content -->
      <div class="protection-content">
        <!-- Step: Select Protection Level -->
        <template v-if="step === 'select'">
          <p class="protection-desc">{{ L.desc }}</p>

          <div class="protection-options">
            <label class="protection-option" :class="{ active: selectedLevel === 'none' }">
              <input type="radio" v-model="selectedLevel" value="none" />
              <div class="protection-option-icon"><Unlock :size="20" /></div>
              <div class="protection-option-text">
                <span class="protection-option-title">{{ L.none }}</span>
                <span class="protection-option-desc">{{ L.none_desc }}</span>
              </div>
            </label>

            <label class="protection-option" :class="{ active: selectedLevel === 'pin' }">
              <input type="radio" v-model="selectedLevel" value="pin" />
              <div class="protection-option-icon"><Lock :size="20" /></div>
              <div class="protection-option-text">
                <span class="protection-option-title">{{ L.pin }}</span>
                <span class="protection-option-desc">{{ L.pin_desc }}</span>
              </div>
            </label>

            <label class="protection-option" :class="{ active: selectedLevel === 'advanced' }">
              <input type="radio" v-model="selectedLevel" value="advanced" />
              <div class="protection-option-icon"><Key :size="20" /></div>
              <div class="protection-option-text">
                <span class="protection-option-title">{{ L.advanced }}</span>
                <span class="protection-option-desc">{{ L.advanced_desc }}</span>
              </div>
            </label>
          </div>

          <!-- Password setup for advanced -->
          <div v-if="selectedLevel === 'advanced'" class="protection-password-section">
            <div class="protection-input-group">
              <label>{{ L.password }}</label>
              <div class="protection-input-wrapper">
                <Input v-model="password" :type="showPassword ? 'text' : 'password'" :placeholder="L.password_ph" />
                <button class="protection-input-toggle" @click="showPassword = !showPassword">
                  <Eye v-if="!showPassword" :size="16" />
                  <EyeOff v-else :size="16" />
                </button>
              </div>
            </div>
            <div class="protection-input-group">
              <label>{{ L.confirm_pwd }}</label>
              <Input v-model="confirmPassword" :type="showPassword ? 'text' : 'password'" :placeholder="L.confirm_pwd_ph" />
            </div>
            <div v-if="password && confirmPassword && password !== confirmPassword" class="protection-error">
              {{ L.pwd_mismatch }}
            </div>
          </div>

          <!-- Actions -->
          <div class="protection-actions">
            <Button variant="outline" size="default" class="min-w-[100px] rounded-md" @click="emit('update:open', false)">
              {{ L.cancel }}
            </Button>
            <Button v-if="currentLevel !== 'none'" variant="destructive" size="default" class="min-w-[100px] rounded-md"
              @click="handleRemove" :disabled="protection.loading.value">
              {{ L.remove }}
            </Button>
            <Button size="default" class="min-w-[100px] rounded-md"
              @click="handleSetup" :disabled="!canSetup || protection.loading.value">
              {{ protection.loading.value ? L.saving : L.apply }}
            </Button>
          </div>
        </template>

        <!-- Step: Unlock -->
        <template v-else-if="step === 'unlock'">
          <p class="protection-desc">{{ L.unlock_desc }}</p>
          <div class="protection-input-group">
            <label>{{ L.enter_pwd }}</label>
            <div class="protection-input-wrapper">
              <Input v-model="unlockPassword" type="password" :placeholder="L.pwd_ph" @keyup.enter="handleUnlock" />
            </div>
          </div>
          <div v-if="protection.error.value" class="protection-error">{{ protection.error.value }}</div>
          <div class="protection-actions">
            <Button v-if="props.currentLevel !== 'pin'" variant="outline" size="default" class="min-w-[100px] rounded-md" @click="step = 'recovery'">
              {{ L.use_recovery }}
            </Button>
            <Button size="default" class="min-w-[100px] rounded-md"
              @click="handleUnlock" :disabled="!unlockPassword || isUnlocking">
              {{ isUnlocking ? L.unlocking : L.unlock }}
            </Button>
          </div>
        </template>

        <!-- Step: Recovery Key Input -->
        <template v-else-if="step === 'recovery'">
          <div class="protection-recovery-info">
            <AlertTriangle :size="24" class="protection-warning-icon" />
            <p>{{ L.recovery_info }}</p>
          </div>
          <div class="protection-input-group">
            <label>{{ L.recovery_key }}</label>
            <textarea v-model="recoveryKey" class="protection-recovery-input" :placeholder="L.recovery_ph" rows="3" />
          </div>
          <div class="protection-actions">
            <Button variant="outline" size="default" class="min-w-[100px] rounded-md" @click="step = 'unlock'">
              {{ L.back }}
            </Button>
            <Button size="default" class="min-w-[100px] rounded-md"
              @click="handleRecoveryUnlock" :disabled="recoveryKey.length !== 128 || isUnlocking">
              {{ isUnlocking ? L.unlocking : L.unlock }}
            </Button>
          </div>
        </template>

        <!-- Step: Recovery Key Display (after setup) -->
        <template v-else-if="step === 'recovery_display'">
          <div class="protection-recovery-display">
            <AlertTriangle :size="24" class="protection-warning-icon" />
            <h4>{{ L.save_recovery }}</h4>
            <p>{{ L.recovery_warn }}</p>
            <div class="protection-recovery-key">
              <code>{{ recoveryKey }}</code>
              <Button variant="ghost" size="sm" @click="copyRecoveryKey"><Copy :size="14" /></Button>
            </div>
            <div class="protection-actions">
              <Button size="default" class="min-w-[100px] rounded-md" @click="nextStep">{{ L.i_saved }}</Button>
            </div>
          </div>
        </template>

        <!-- Step: Success -->
        <template v-else-if="step === 'success'">
          <div class="protection-success">
            <Shield :size="48" class="protection-success-icon" />
            <h4>{{ L.applied }}</h4>
            <p>{{ L.applied_desc }}</p>
          </div>
        </template>
      </div>

      <!-- Error -->
      <div v-if="protection.error.value && step === 'select'" class="protection-error">
        {{ protection.error.value }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.protection-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9998;
}

.protection-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 440px;
  max-width: 90vw;
  max-height: 85vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.protection-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-default);
}

.protection-header h3 {
  flex: 1;
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.protection-icon {
  color: var(--color-primary, #6366f1);
}

.protection-close {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  line-height: 1;
}

.protection-close:hover {
  color: var(--text-primary);
}

.protection-content {
  padding: 20px;
  overflow-y: auto;
}

.protection-desc {
  margin: 0 0 16px;
  color: var(--text-secondary);
  font-size: 14px;
}

.protection-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.protection-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.protection-option:hover {
  border-color: var(--border-focus);
}

.protection-option.active {
  border-color: var(--color-primary, #6366f1);
  background: var(--accent-light);
}

.protection-option input[type="radio"] {
  display: none;
}

.protection-option-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
}

.protection-option.active .protection-option-icon {
  background: var(--color-primary, #6366f1);
  color: white;
}

.protection-option-text {
  flex: 1;
}

.protection-option-title {
  display: block;
  font-weight: 500;
  margin-bottom: 2px;
}

.protection-option-desc {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
}

.protection-password-section {
  margin-bottom: 20px;
  padding: 16px;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
}

.protection-input-group {
  margin-bottom: 12px;
}

/* Input 内边距：placeholder 文本不贴左边框 */
.protection-input-group :deep(input),
.protection-input-group :deep(textarea) {
  padding-left: 12px;
}

.protection-input-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.protection-input-wrapper {
  position: relative;
}

.protection-input-toggle {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
}

.protection-error {
  padding: 10px 12px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: var(--radius-md);
  font-size: 13px;
  margin-bottom: 12px;
}

.protection-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-default);
}

.protection-actions :deep(button) {
  min-width: 80px;
  padding: 8px 16px;
}

.protection-recovery-info {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  background: var(--warning-bg);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
}

.protection-warning-icon {
  color: var(--warning);
  flex-shrink: 0;
}

.protection-recovery-input {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  font-family: monospace;
  font-size: 12px;
  resize: vertical;
}

.protection-recovery-display {
  text-align: center;
}

.protection-recovery-display h4 {
  margin: 12px 0 8px;
}

.protection-recovery-display p {
  color: var(--text-secondary);
  font-size: 14px;
  margin-bottom: 16px;
}

.protection-recovery-key {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
}

.protection-recovery-key code {
  flex: 1;
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
}

.protection-success {
  text-align: center;
  padding: 20px 0;
}

.protection-success-icon {
  color: var(--color-primary, #6366f1);
  margin-bottom: 12px;
}

.protection-success h4 {
  margin: 0 0 8px;
  color: var(--color-primary, #6366f1);
}

.protection-success p {
  color: var(--text-secondary);
  margin: 0;
}
</style>
