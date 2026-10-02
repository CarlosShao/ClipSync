<script setup lang="ts">
// === 应用内反馈工单弹窗（设置 → 关于 ClipSync → 发送反馈）===
// 取代原先跳转 GitHub Issues 的外链：字段与 POST /api/feedback 的契约一一对应
// （title / category / content / contact? / appVersion? / platform?）。
//
// 弹窗范式与项目既有 ModalDialog / SettingsDialog 保持一致：Teleport 到 body、
// 统一遮罩点击关闭、Esc 关闭、Tab 焦点环、关闭后焦点归位；样式全部走主题 token。
//
// 减少动效双通道：① 设置页「减少动画」写入 html.reduce-motion（globals.css 的
// `html.reduce-motion *` 会压掉过渡）；② 系统 prefers-reduced-motion 由
// fx/useReducedMotion 命中后加 fb-panel--static（并另留一条 @media 兜底）。
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import { getVersion } from '@tauri-apps/api/app'
import { X } from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useConfigStore } from '@/stores/configStore'
import { useReducedMotion } from '@/components/fx/useReducedMotion'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Label from '@/components/ui/label/Label.vue'
import Textarea from '@/components/ui/textarea/Textarea.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABEL_KEYS,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_TITLE_MAX,
  submitFeedback,
  type FeedbackCategory,
} from '@/api/feedback'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()
const configStore = useConfigStore()
const reduced = useReducedMotion()

const panelRef = ref<HTMLElement | null>(null)
/** 提交中：既驱动按钮 loading 文案，也是防重复提交的闸门 */
const sending = ref(false)
/** 客户端版本：Tauri 运行时取 tauri.conf.json 的 version；取不到留空串，不编造 */
const appVersion = ref('')

const form = reactive({
  title: '',
  category: 'feature' as FeedbackCategory,
  content: '',
  contact: '',
})

let previousActiveElement: HTMLElement | null = null

/** 剩余可输入字数（与服务端 CONTENT_MAX 同源，避免出现"本地能填、服务端 400"） */
const remaining = computed(() => Math.max(0, FEEDBACK_CONTENT_MAX - form.content.length))

function categoryLabel(category: FeedbackCategory) {
  return t(FEEDBACK_CATEGORY_LABEL_KEYS[category])
}

/** 平台标识：与 configStore.registerCurrentDevice / QrPairingModals 的既有判定保持一致 */
function detectPlatform(): string {
  if (/Mac/i.test(navigator.userAgent)) return 'macos'
  if (/Linux/i.test(navigator.userAgent)) return 'linux'
  return 'windows'
}

function resetForm() {
  form.title = ''
  form.category = 'feature'
  form.content = ''
  form.contact = ''
}

function onClose() {
  if (sending.value) return
  emit('close')
}

/**
 * Esc 关闭 + Tab 焦点环。
 * 用捕获阶段监听并在 Esc 上 stopPropagation：本弹窗可能叠在设置页/设置弹窗之上，
 * 不能让同一个 Esc 顺带把外层也关掉（外层是冒泡阶段的 document 监听）。
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    onClose()
    return
  }
  if (e.key === 'Tab' && panelRef.value) {
    const focusable = panelRef.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    } else if (document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

function detachKeydown() {
  document.removeEventListener('keydown', onKeydown, true)
  previousActiveElement?.focus?.()
  previousActiveElement = null
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) {
      detachKeydown()
      return
    }
    // 默认带出当前登录用户邮箱（contact 可选，服务端只校验长度）
    form.contact = configStore.user?.email || ''
    if (!appVersion.value) {
      try {
        appVersion.value = await getVersion()
      } catch {
        // 浏览器 dev / 非 Tauri 环境拿不到版本 → 空串（服务端落 NULL），不假装有版本
        appVersion.value = ''
      }
    }
    previousActiveElement = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', onKeydown, true)
    await nextTick()
    panelRef.value?.querySelector<HTMLElement>('input, textarea')?.focus()
  },
  { immediate: true },
)

onUnmounted(detachKeydown)

async function onSubmit() {
  if (sending.value) return
  const title = form.title.trim()
  const content = form.content.trim()
  const contact = form.contact.trim()

  // 本地前置校验：服务端对 title/content 缺失是硬性 400，先在本地给即时提示
  if (!title) {
    toast.show(t('fb_title_required'), 'error')
    return
  }
  if (title.length > FEEDBACK_TITLE_MAX) {
    toast.show(t('fb_title_too_long'), 'error')
    return
  }
  if (!content) {
    toast.show(t('fb_desc_required'), 'error')
    return
  }
  if (content.length > FEEDBACK_CONTENT_MAX) {
    toast.show(t('fb_desc_too_long'), 'error')
    return
  }
  if (contact.length > FEEDBACK_CONTACT_MAX) {
    toast.show(t('fb_contact_too_long'), 'error')
    return
  }

  sending.value = true
  try {
    const res = await submitFeedback({
      title,
      category: form.category,
      content,
      contact,
      appVersion: appVersion.value,
      platform: detectPlatform(),
    })
    if (!res.ok) {
      // res.error 可能是服务端机器码/英文句子，toast.show 内部走 tMsg 兜底原文
      toast.show(res.error || t('fb_submit_fail'), 'error')
      return
    }
    toast.show(t('fb_sent'), 'success')
    resetForm()
    emit('close')
  } catch {
    toast.show(t('fb_submit_fail'), 'error')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fb-overlay" @click.self="onClose">
      <div
        ref="panelRef"
        class="fb-panel"
        :class="{ 'fb-panel--static': reduced }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-dialog-title"
      >
        <div class="fb-header">
          <span id="fb-dialog-title" class="fb-heading">{{ t('fb_title') }}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            class="fb-close"
            :disabled="sending"
            :aria-label="t('close')"
            @click="onClose"
          >
            <X :size="16" />
          </Button>
        </div>

        <div class="fb-body">
          <div class="fb-field">
            <Label for="fb-title-input" class="fb-label">{{ t('fb_field_title') }}</Label>
            <Input
              id="fb-title-input"
              v-model="form.title"
              class="fb-input"
              :maxlength="FEEDBACK_TITLE_MAX"
              :disabled="sending"
              :placeholder="t('fb_field_title_ph')"
            />
          </div>

          <div class="fb-field">
            <Label class="fb-label">{{ t('fb_category') }}</Label>
            <CustomSelect
              class="fb-select"
              :model-value="form.category"
              @update:model-value="(v: string) => (form.category = v as FeedbackCategory)"
            >
              {{ categoryLabel(form.category) }}
              <template #options>
                <CustomSelectOption
                  v-for="c in FEEDBACK_CATEGORIES"
                  :key="c"
                  :value="c"
                  :selected="form.category === c"
                  @select="(v: string) => (form.category = v as FeedbackCategory)"
                  >{{ categoryLabel(c) }}</CustomSelectOption
                >
              </template>
            </CustomSelect>
          </div>

          <div class="fb-field">
            <div class="fb-field-head">
              <Label for="fb-content-input" class="fb-label">{{ t('fb_desc') }}</Label>
              <span class="fb-count">{{ t('fb_chars_left', { n: remaining }) }}</span>
            </div>
            <Textarea
              id="fb-content-input"
              v-model="form.content"
              class="fb-textarea"
              rows="5"
              :maxlength="FEEDBACK_CONTENT_MAX"
              :disabled="sending"
              :placeholder="t('fb_desc_ph')"
            />
          </div>

          <div class="fb-field">
            <Label for="fb-contact-input" class="fb-label">
              {{ t('fb_contact') }} <span class="fb-optional">({{ t('fb_optional') }})</span>
            </Label>
            <Input
              id="fb-contact-input"
              v-model="form.contact"
              class="fb-input"
              :maxlength="FEEDBACK_CONTACT_MAX"
              :disabled="sending"
              :placeholder="t('fb_contact_ph')"
            />
          </div>
        </div>

        <div class="fb-footer">
          <Button variant="outline" :disabled="sending" @click="onClose">{{ t('cancel') }}</Button>
          <Button :disabled="sending" @click="onSubmit">{{ sending ? t('fb_submitting') : t('fb_submit') }}</Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fb-overlay {
  position: fixed;
  inset: 0;
  /* 可能叠在设置页/设置弹窗之上：比 --z-modal 高一层，避免被外层遮罩压住 */
  z-index: calc(var(--z-modal) + 1);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-modal-overlay);
  animation: fb-overlay-in 160ms var(--ease);
}

.fb-panel {
  width: 460px;
  max-width: 92vw;
  max-height: min(85vh, 640px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
  animation: fb-panel-in 200ms var(--ease);
}

/* 减少动效（系统偏好通道）：设置开关通道由 globals.css 的 `html.reduce-motion *` 兜底；
   useReducedMotion 双通道命中时也会加本类。 */
.fb-panel--static {
  animation: none;
}

@keyframes fb-overlay-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fb-panel-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fb-overlay,
  .fb-panel {
    animation: none;
  }
}

.fb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-default);
  flex: none;
}

.fb-heading {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.fb-close {
  color: var(--text-secondary);
}

.fb-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.fb-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fb-field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.fb-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.fb-optional {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.fb-count {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* 表单控件：覆盖 shadcn 默认的大内边距，贴合设置页的紧凑密度 */
.fb-input {
  height: 38px;
  padding: 0 12px;
  font-size: 13px;
  border-radius: var(--radius-md);
}

.fb-textarea {
  min-height: 110px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  border-radius: var(--radius-md);
}

.fb-select {
  width: 100%;
}

.fb-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border-default);
  flex: none;
}
</style>
