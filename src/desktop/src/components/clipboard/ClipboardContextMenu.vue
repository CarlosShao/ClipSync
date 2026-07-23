<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useFavoritePopover } from '@/composables/useFavoritePopover'
import { useClipItemDisplay } from '@/composables/useClipItemDisplay'
import ExpiryPicker from '@/components/clipboard/ExpiryPicker.vue'
import {
  Copy,
  Image as ImageIcon,
  Link,
  ExternalLink,
  FileText,
  Folder,
  Star,
  Archive,
  Trash2,
  Lock,
  Clock,
} from 'lucide-vue-next'

const props = defineProps<{
  item: ClipItem | null
  x: number
  y: number
  isArchive: boolean
  initialMode?: 'main' | 'expiry'
}>()

const emit = defineEmits<{
  close: []
  copy: [item: ClipItem]
  share: [item: ClipItem]
  preview: [item: ClipItem]
  reveal: [item: ClipItem]
  'open-protection': [item: ClipItem]
  'archive-toggle': [item: ClipItem]
  delete: [item: ClipItem]
}>()

const { t } = useI18n()
const toast = useSonner()
const clip = useClipboard()
const fav = useFavoritePopover()
const display = useClipItemDisplay()

// 菜单模式：main = 主菜单；expiry = 过期设置子菜单。打开新条目时按 initialMode 重置
const mode = ref<'main' | 'expiry'>(props.initialMode ?? 'main')
watch(
  () => props.item,
  (it) => {
    if (it) mode.value = props.initialMode ?? 'main'
  },
)

function ctxSetExpiryMode() {
  mode.value = 'expiry'
}
function ctxBack() {
  mode.value = 'main'
}

// 定位：防出屏
const ctxStyle = computed(() => {
  const w = 200
  const h = 360
  const vw = window?.innerWidth || 1200
  const vh = window?.innerHeight || 800
  const x = Math.min(props.x, vw - w - 8)
  const y = Math.min(props.y, vh - h - 8)
  return { left: Math.max(8, x) + 'px', top: Math.max(8, y) + 'px' }
})

function actCopy() {
  if (props.item) {
    emit('copy', props.item)
    emit('close')
  }
}
function actShare() {
  if (props.item) {
    emit('share', props.item)
    emit('close')
  }
}
function actPreview() {
  if (props.item) {
    emit('preview', props.item)
    emit('close')
  }
}
function actReveal() {
  if (props.item) {
    emit('reveal', props.item)
    emit('close')
  }
}
function actProtection() {
  if (props.item) {
    emit('open-protection', props.item)
    emit('close')
  }
}
function actDelete() {
  if (props.item) {
    emit('delete', props.item)
    emit('close')
  }
}

function actFavorite() {
  if (props.item) {
    fav.handleFavorite(props.item)
    emit('close')
  }
}

function actArchiveToggle() {
  if (props.item) {
    emit('archive-toggle', props.item)
    emit('close')
  }
}

async function ctxApplyExpiry(iso: string | null) {
  const item = props.item
  if (!item) return
  const ok = await clip.setExpiry(item, iso)
  if (ok) toast.show(iso ? t('exp_set_toast') : t('exp_clear_toast'), 'success')
  else toast.show(t('del_fail'), 'error')
  emit('close')
}
</script>

<template>
  <!-- 右击上下文菜单（含过期设置，exp-menu #188） -->
  <template v-if="item">
    <div class="ctx-overlay" @click="emit('close')" @contextmenu.prevent="emit('close')" />
    <div class="ctx-menu" :style="ctxStyle">
      <template v-if="mode === 'main'">
        <button type="button" class="ctx-item" @click="actCopy"><Copy :size="14" />{{ t('copy') }}</button>
        <button v-if="!isArchive" type="button" class="ctx-item" @click="actShare">
          <Link :size="14" />{{ t('shared_link') }}
        </button>
        <button type="button" class="ctx-item" @click="actPreview">
          <ImageIcon v-if="item!.type === 'image'" :size="14" />
          <ExternalLink v-else-if="item!.type === 'link'" :size="14" />
          <FileText v-else :size="14" />{{ t('preview') }}
        </button>
        <button
          v-if="!isArchive && item!.type === 'file' && display.hasLocalPath(item!)"
          type="button"
          class="ctx-item"
          @click="actReveal"
        >
          <Folder :size="14" />{{ t('show_in_folder') }}
        </button>
        <button v-if="!isArchive" type="button" class="ctx-item" @click="actProtection">
          <Lock :size="14" />{{ t('protection_set') }}
        </button>
        <button v-if="!isArchive" type="button" class="ctx-item" @click="actFavorite">
          <Star :size="14" :fill="item!.isFavorite ? 'currentColor' : 'none'" />{{
            item!.isFavorite ? t('unfavorite') : t('favorite')
          }}
        </button>
        <button type="button" class="ctx-item" @click="actArchiveToggle">
          <Archive :size="14" />{{ isArchive ? t('unarchive_action') : t('archive_action') }}
        </button>
        <button v-if="!isArchive" type="button" class="ctx-item ctx-item--accent" @click="ctxSetExpiryMode">
          <Clock :size="14" />{{ t('exp_set') }}…
        </button>
        <div v-if="!isArchive" class="ctx-sep" />
        <button type="button" class="ctx-item ctx-item--danger" @click="actDelete">
          <Trash2 :size="14" />{{ t('delete') }}
        </button>
      </template>
      <template v-else>
        <button type="button" class="ctx-item ctx-back" @click="ctxBack">{{ t('exp_back') }}</button>
        <div class="ctx-expiry"><ExpiryPicker :model-value="item.expiresAt" @select="ctxApplyExpiry" /></div>
      </template>
    </div>
  </template>
</template>

<style scoped>
/* ===== 右击上下文菜单 ===== */
.ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: transparent;
}
.ctx-menu {
  position: fixed;
  z-index: 91;
  width: 200px;
  padding: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 2px;
  animation: ctxFadeIn 0.12s ease;
}
@keyframes ctxFadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  transition: background 0.12s;
}
.ctx-item svg {
  flex-shrink: 0;
  color: var(--text-tertiary);
}
.ctx-item:hover {
  background: var(--bg-hover);
}
.ctx-item--accent {
  color: var(--accent);
}
.ctx-item--accent svg {
  color: var(--accent);
}
.ctx-item--danger {
  color: var(--danger);
}
.ctx-item--danger svg {
  color: var(--danger);
}
.ctx-item--danger:hover {
  background: var(--danger-bg);
}
.ctx-sep {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 2px;
}
.ctx-expiry {
  padding: 4px 2px 2px;
}
</style>
