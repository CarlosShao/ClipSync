<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useItemPassword } from '@/composables/useItemPassword'
import { getClipboardItemContent } from '@/api/client'
import { Button } from '@/components/ui/button'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import { Lock, Unlock, ShieldCheck, ShieldOff, Eye, EyeOff, Loader2 } from 'lucide-vue-next'

const { t } = useI18n()
const { updateItemContent } = useClipboard()
const pw = useItemPassword()

const props = withDefaults(defineProps<{
  open: boolean
  item: ClipItem | null
}>(), { item: null })

const emit = defineEmits<{
  'update:open': [value: boolean]
  updated: [item: ClipItem]
}>()

const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const busy = ref(false)
const showPassword = ref(false)

// 模式：set=未保护要设密码；unlock=已保护未解锁；managed=已保护已解锁
const mode = computed<'set' | 'unlock' | 'managed' | ''>(() => {
  const it = props.item
  if (!it) return ''
  if (!pw.isItemProtected(it)) return 'set'
  return pw.isUnlocked(it.id) ? 'managed' : 'unlock'
})

const title = computed(() => {
  if (mode.value === 'unlock') return t('item_password_unlock_title', '解锁条目')
  if (mode.value === 'managed') return t('item_password_managed_title', '条目密码保护')
  return t('item_password_set_title', '设置条目密码')
})

// 打开时重置表单
watch(() => props.open, (v) => {
  if (v) {
    password.value = ''
    confirmPassword.value = ''
    error.value = ''
    busy.value = false
    showPassword.value = false
  }
})

function close() {
  emit('update:open', false)
}

async function getPlaintextForProtect(it: ClipItem): Promise<string | null> {
  // 本地乐观项（local-/text-/img-/browser-）直接在内存里持有明文
  if (/^(local-|text-|img-|browser-)/.test(it.id)) return it.content || ''
  try {
    const fetched = await getClipboardItemContent(it.id)
    if (fetched) return fetched
  } catch (e: any) {
    console.warn('[ItemPassword] fetch plaintext for protect failed:', e?.message || e)
  }
  return it.content || ''
}

async function submitSet() {
  const it = props.item
  if (!it) return
  error.value = ''
  if (password.value.length < 4) {
    error.value = t('item_password_too_short', '密码至少 4 位')
    return
  }
  if (password.value !== confirmPassword.value) {
    error.value = t('item_password_mismatch', '两次输入的密码不一致')
    return
  }
  busy.value = true
  try {
    const plaintext = await getPlaintextForProtect(it)
    if (plaintext == null || plaintext === '') {
      error.value = t('item_password_no_content', '无法获取条目明文内容')
      busy.value = false
      return
    }
    const packed = await pw.encryptContent(plaintext, password.value)
    const ok = await updateItemContent(it.id, {
      content: packed,
      contentPreview: t('item_password_mask', '[受密码保护]'),
      contentSize: packed.length,
      metadata: { protected: true, protectedAt: new Date().toISOString() },
    })
    if (!ok) {
      error.value = t('item_password_set_failed', '设置密码失败，请重试')
      busy.value = false
      return
    }
    // 设置成功后立即解锁，方便本次会话查看/复制
    pw.setUnlocked(it.id, plaintext)
    emit('updated', it)
    close()
  } catch (e: any) {
    console.warn('[ItemPassword] set password error:', e?.message || e)
    error.value = t('item_password_set_error', '加密失败：') + (e?.message || e)
  } finally {
    busy.value = false
  }
}

async function submitUnlock() {
  const it = props.item
  if (!it) return
  error.value = ''
  if (!password.value) {
    error.value = t('item_password_required', '请输入密码')
    return
  }
  busy.value = true
  try {
    const packed = await getClipboardItemContent(it.id)
    if (!packed) {
      error.value = t('item_password_load_failed', '无法加载加密内容')
      busy.value = false
      return
    }
    const result = await pw.decryptContent(packed, password.value)
    if (!result.ok || result.plaintext == null) {
      error.value = t('item_password_wrong', '密码错误')
      busy.value = false
      return
    }
    pw.setUnlocked(it.id, result.plaintext)
    emit('updated', it)
    close()
  } catch (e: any) {
    console.warn('[ItemPassword] unlock error:', e?.message || e)
    error.value = t('item_password_unlock_error', '解密失败：') + (e?.message || e)
  } finally {
    busy.value = false
  }
}

async function removeProtection() {
  const it = props.item
  if (!it) return
  error.value = ''
  busy.value = true
  try {
    const plaintext = pw.getUnlockedPlaintext(it.id)
    if (plaintext == null) {
      error.value = t('item_password_unlock_first', '请先解锁再移除保护')
      busy.value = false
      return
    }
    const ok = await updateItemContent(it.id, {
      content: plaintext,
      contentPreview: plaintext.slice(0, 5000),
      contentSize: plaintext.length,
      metadata: { protected: false, protectedAt: null },
    })
    if (!ok) {
      error.value = t('item_password_remove_failed', '移除保护失败，请重试')
      busy.value = false
      return
    }
    pw.lockItem(it.id)
    emit('updated', it)
    close()
  } catch (e: any) {
    console.warn('[ItemPassword] remove protection error:', e?.message || e)
    error.value = t('item_password_remove_error', '移除失败：') + (e?.message || e)
  } finally {
    busy.value = false
  }
}

function lockNow() {
  const it = props.item
  if (!it) return
  pw.lockItem(it.id)
  emit('updated', it)
  close()
}

function onSubmit() {
  if (mode.value === 'set') submitSet()
  else if (mode.value === 'unlock') submitUnlock()
}
</script>

<template>
  <ModalDialog :open="open" :title="title" @close="close">
    <div v-if="item" class="ipd">
      <!-- set 模式 -->
      <template v-if="mode === 'set'">
        <p class="ipd-desc">{{ t('item_password_set_desc', '为该条目设置独立密码。加密在本地完成，密码不会上传服务器。') }}</p>
        <label class="ipd-label">{{ t('item_password_new', '密码') }}</label>
        <div class="ipd-input-wrap">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="ipd-input"
            :placeholder="t('item_password_new_ph', '输入密码（至少 4 位）')"
            @keyup.enter="onSubmit"
          />
          <button type="button" class="ipd-eye" @click="showPassword = !showPassword">
            <Eye v-if="!showPassword" :size="16" />
            <EyeOff v-else :size="16" />
          </button>
        </div>
        <label class="ipd-label">{{ t('item_password_confirm', '确认密码') }}</label>
        <div class="ipd-input-wrap">
          <input
            v-model="confirmPassword"
            :type="showPassword ? 'text' : 'password'"
            class="ipd-input"
            :placeholder="t('item_password_confirm_ph', '再次输入密码')"
            @keyup.enter="onSubmit"
          />
        </div>
      </template>

      <!-- unlock 模式 -->
      <template v-else-if="mode === 'unlock'">
        <p class="ipd-desc">{{ t('item_password_unlock_desc', '该条目已加密。输入密码以在当前会话查看与复制。') }}</p>
        <label class="ipd-label">{{ t('item_password_enter', '密码') }}</label>
        <div class="ipd-input-wrap">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="ipd-input"
            :placeholder="t('item_password_enter_ph', '输入条目密码')"
            @keyup.enter="onSubmit"
          />
          <button type="button" class="ipd-eye" @click="showPassword = !showPassword">
            <Eye v-if="!showPassword" :size="16" />
            <EyeOff v-else :size="16" />
          </button>
        </div>
      </template>

      <!-- managed 模式 -->
      <template v-else-if="mode === 'managed'">
        <div class="ipd-managed">
          <ShieldCheck :size="18" />
          <span>{{ t('item_password_unlocked', '已解锁，当前会话可查看与复制') }}</span>
        </div>
      </template>

      <p v-if="error" class="ipd-error">{{ error }}</p>
    </div>

    <template #footer>
      <Button variant="outline" size="default" class="min-w-[100px] rounded-md" :disabled="busy" @click="close">
        {{ t('cancel', '取消') }}
      </Button>

      <template v-if="mode === 'set'">
        <Button variant="default" size="default" class="min-w-[100px] rounded-md" :disabled="busy" @click="onSubmit">
          <Loader2 v-if="busy" :size="16" class="animate-spin" />
          <Lock v-else :size="16" />
          {{ t('item_password_protect', '加密保护') }}
        </Button>
      </template>

      <template v-else-if="mode === 'unlock'">
        <Button variant="default" size="default" class="min-w-[100px] rounded-md" :disabled="busy" @click="onSubmit">
          <Loader2 v-if="busy" :size="16" class="animate-spin" />
          <Unlock v-else :size="16" />
          {{ t('item_password_unlock_btn', '解锁') }}
        </Button>
      </template>

      <template v-else-if="mode === 'managed'">
        <Button variant="outline" size="default" class="min-w-[100px] rounded-md" @click="lockNow">
          <EyeOff :size="16" />
          {{ t('item_password_lock', '锁定') }}
        </Button>
        <Button variant="destructive" size="default" class="min-w-[100px] rounded-md" :disabled="busy" @click="removeProtection">
          <Loader2 v-if="busy" :size="16" class="animate-spin" />
          <ShieldOff v-else :size="16" />
          {{ t('item_password_remove', '移除保护') }}
        </Button>
      </template>
    </template>
  </ModalDialog>
</template>

<style scoped>
.ipd { display: flex; flex-direction: column; gap: 8px; }
.ipd-desc { font-size: 13px; line-height: 1.6; color: var(--text-secondary); margin: 0 0 6px; }
.ipd-label { font-size: 13px; font-weight: 500; color: var(--text-primary); margin-top: 4px; }
.ipd-input-wrap { position: relative; display: flex; align-items: center; }
.ipd-input {
  width: 100%; height: 40px; padding: 0 40px 0 12px;
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
  background: var(--bg-input); color: var(--text-primary); font-size: 14px;
  outline: none; transition: border-color 0.15s;
}
.ipd-input:focus { border-color: var(--color-primary, #6366f1); }
.ipd-eye {
  position: absolute; right: 8px; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; background: transparent; color: var(--text-secondary);
  cursor: pointer; border-radius: var(--radius-sm);
}
.ipd-eye:hover { color: var(--text-primary); background: var(--bg-hover); }
.ipd-error { font-size: 13px; color: var(--destructive, #ef4444); margin: 6px 0 0; min-height: 18px; }
.ipd-managed {
  display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  background: color-mix(in srgb, var(--color-primary, #6366f1) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary, #6366f1) 30%, transparent);
  border-radius: var(--radius-md); font-size: 14px; color: var(--text-primary);
}
</style>
