<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ClipItem } from '@/composables/useClipboard'
import { getCachedContent } from '@/composables/clipboardCache'
import { useImageZoom } from '@/composables/useImageZoom'
import { openUrl } from '@/lib/tauri'
import { useSonner } from '@/composables/useSonner'
import InlineAiCard from '@/components/ai/InlineAiCard.vue'
import { useInlineAi } from '@/composables/useInlineAi'
import { fetchFullContentDecrypted } from '@/composables/clipboardLoad'
import { isE2eItem } from '@/utils/e2eCrypto'
import {
  Copy,
  Star,
  Trash2,
  X,
  Sparkles,
  Image as ImageIcon,
  Link2,
  Code2,
  FileText,
  Type,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RotateCw,
  Download,
  ExternalLink,
} from 'lucide-vue-next'

const props = defineProps<{ item: ClipItem | null }>()
const emit = defineEmits<{
  close: []
  copy: [item: ClipItem]
  'toggle-fav': [item: ClipItem]
  delete: [item: ClipItem]
  ai: [action: string, item: ClipItem]
}>()

const { t, tf } = useI18n()
const toast = useSonner()

const TYPE_META: Record<string, { tile: string; badge: string; label: string; icon: any }> = {
  text: { tile: 't-text', badge: 'b-text', label: '文本', icon: Type },
  link: { tile: 't-link', badge: 'b-link', label: '链接', icon: Link2 },
  code: { tile: 't-code', badge: 'b-code', label: '代码', icon: Code2 },
  image: { tile: 't-image', badge: 'b-image', label: '图片', icon: ImageIcon },
  file: { tile: 't-file', badge: 'b-file', label: '文件', icon: FileText },
}

const meta = computed(() => TYPE_META[props.item?.type || 'text'] || TYPE_META.text)
const isCode = computed(() => {
  const c = fullContent.value
  return !!props.item && props.item.type !== 'file' && props.item.type !== 'image' && /[{;=]\s*$|^\s*(function|const|let|var|import|class)\b|<\/?[a-z]+>/m.test(c)
})

/* B7：E2E 条目按需解密——打开抽屉时拉全文解密入缓存；失败保持 [E2E] 占位 */
const e2ePlain = ref('')
watch(
  () => props.item?.id,
  async () => {
    e2ePlain.value = ''
    const it = props.item
    if (!it || it.type === 'image' || it.type === 'file') return
    if (!isE2eItem(it.metadata)) return
    const plain = await fetchFullContentDecrypted(it)
    if (plain !== null) e2ePlain.value = plain
  },
  { immediate: true },
)

/* 全文：E2E 解密结果 → 本地缓存全文 → 条目自带内容（E2E 未解出时即 [E2E] 占位） */
const fullContent = computed(() => {
  if (!props.item) return ''
  return e2ePlain.value || getCachedContent(props.item.id) || props.item.content || props.item.preview || ''
})

const sizeText = computed(() => {
  if (!props.item || props.item.type === 'image') return ''
  const n = props.item.contentSize
  if (!n || !Number.isFinite(Number(n))) return ''
  const b = Number(n)
  return b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`
})

function fmtTime(ts: number): string {
  try {
    const d = new Date(ts)
    const p = (n: number) => (n < 10 ? '0' + n : String(n))
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch {
    return ''
  }
}

const AI_ACTS = [
  { key: 'summary', i18n: 'ai_act_summary', fallback: '总结', prompt: '请总结以下内容：提炼核心要点与主题，中文输出，简明扼要。' },
  { key: 'translate', i18n: 'ai_act_translate', fallback: '翻译为英文', prompt: '请将以下内容完整翻译为英文，只输出译文，不要附加解释。' },
  { key: 'extract', i18n: 'ai_act_extract', fallback: '提取关键信息', prompt: '请从以下内容中提取关键信息（要点、链接、数字、代码要点等），以简洁列表输出。' },
] as const

// A6 抽屉原位 AI：页内 InlineAiCard 出结果，不跳侧栏；再次点击同一按钮收起，切换条目自动收起
const drawerAi = useInlineAi()
const activeAiAct = ref<string | null>(null)
const activeActMeta = computed(() => AI_ACTS.find((a) => a.key === activeAiAct.value) || null)

function onAiAct(act: (typeof AI_ACTS)[number]) {
  if (activeAiAct.value === act.key) {
    closeDrawerAi()
    return
  }
  const content = fullContent.value.trim()
  if (!content) {
    toast.show(tf('inline_ai_no_text', '该条目没有可分析的文本内容'), 'info')
    return
  }
  activeAiAct.value = act.key
  drawerAi.run(act.prompt, content.slice(0, 20000))
}

function closeDrawerAi() {
  activeAiAct.value = null
  drawerAi.reset()
}

/** 结果卡的重试：重跑当前动作（不能走 onAiAct，否则同 key 会先收起） */
function retryDrawerAi() {
  const act = activeActMeta.value
  const content = fullContent.value.trim()
  if (!act || !content) return
  drawerAi.run(act.prompt, content.slice(0, 20000))
}

watch(
  () => props.item?.id,
  () => {
    if (activeAiAct.value) closeDrawerAi()
  },
)

/* 图片查看：与老版图片弹窗同一套缩放/旋转/拖拽能力（滚轮缩放、按住平移） */
const {
  imgZoom,
  imgPanX,
  imgPanY,
  imgRotate,
  IMG_ZOOM_MIN,
  IMG_ZOOM_MAX,
  resetImgZoom,
  rotateLeft,
  rotateRight,
  zoomIn,
  zoomOut,
  onImgWheel,
  onImgPointerDown,
  onImgPointerMove,
  onImgPointerUp,
  imgCursor,
} = useImageZoom()

// 切换条目时重置图片视图
watch(
  () => props.item?.id,
  () => resetImgZoom(),
)

const hasImg = computed(() => !!props.item?.preview && props.item?.preview !== 'loading')

async function downloadImage() {
  const src = props.item?.preview || props.item?.content
  if (!src) return
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: `clipsync-image-${Date.now()}.png`,
        types: [{ description: 'Image', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg'] } }],
      })
      const blob = await (await fetch(src)).blob()
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      toast.show(t('img_saved'), 'success')
      return
    } catch (e: any) {
      if (e?.name === 'AbortError') return // 用户取消
    }
  }
  const a = document.createElement('a')
  a.href = src
  a.download = `clipsync-image-${Date.now()}.png`
  a.click()
  toast.show(t('img_saved'), 'success')
}

/* 链接条目：一键跳浏览器 */
const isLinkItem = computed(() => {
  if (!props.item) return false
  if (props.item.type === 'link') return true
  return /^https?:\/\/\S+$/i.test((fullContent.value || '').trim())
})
function openInBrowser() {
  const url = (fullContent.value || '').trim().split(/\s+/)[0]
  if (url) void openUrl(url)
}
</script>

<template>
  <Teleport to="body">
    <template v-if="item">
      <!-- 原型 drawer：无遮罩，点击其他条目直接切换内容；仅 ❌ / Esc 关闭 -->
      <aside class="drawer" role="dialog" :aria-label="t('clip_drawer_title', '条目详情')">
        <div class="drawer-head">
          <div class="type-tile" :class="meta.tile">
            <component :is="meta.icon" :size="16" />
          </div>
          <div>
            <div class="dt">{{ tf('clip_drawer_title', '条目详情') }}</div>
            <div class="dd">{{ t('clip_drawer_from', '来自') }} {{ item.source || 'Desktop' }} · {{ fmtTime(item.timestamp) }}</div>
          </div>
          <button type="button" class="pl-icon-btn" style="margin-left: auto" :title="t('close')" @click="emit('close')">
            <X :size="15" />
          </button>
        </div>

        <div class="drawer-body">
          <!-- 图片：可缩放/旋转/拖拽查看（能力对齐老版图片弹窗） -->
          <div v-if="item.type === 'image'" class="panel drawer-content-panel drawer-img-panel">
            <div
              v-if="hasImg"
              class="drawer-img-viewport"
              :style="{ cursor: imgCursor() }"
              @wheel.prevent.stop="onImgWheel"
              @pointerdown="onImgPointerDown"
              @pointermove="onImgPointerMove"
              @pointerup="onImgPointerUp"
              @pointercancel="onImgPointerUp"
            >
              <img
                :src="item.preview"
                alt=""
                draggable="false"
                :style="{
                  transform: `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom}) rotate(${imgRotate}deg)`,
                  transition: imgZoom > 1 ? 'none' : 'transform 0.15s ease',
                }"
              />
            </div>
            <div v-else class="pl-empty" style="padding: 32px 16px"><ImageIcon :size="24" /><div class="t">{{ t('loading') }}</div></div>
            <div v-if="hasImg" class="drawer-img-bar">
              <button type="button" class="pl-icon-btn" :disabled="imgZoom <= IMG_ZOOM_MIN" :title="tf('img_zoom_out', '缩小')" @click="zoomOut">
                <ZoomOut :size="14" />
              </button>
              <span class="drawer-img-zoom-label">{{ Math.round(imgZoom * 100) }}%</span>
              <button type="button" class="pl-icon-btn" :disabled="imgZoom >= IMG_ZOOM_MAX" :title="tf('img_zoom_in', '放大')" @click="zoomIn">
                <ZoomIn :size="14" />
              </button>
              <button v-if="imgZoom !== 1 || imgRotate !== 0" type="button" class="pl-icon-btn drawer-img-reset" :title="tf('img_reset', '重置')" @click="resetImgZoom">1:1</button>
              <span class="drawer-img-sep" />
              <button type="button" class="pl-icon-btn" :title="tf('img_rotate_left', '左旋90度')" @click="rotateLeft">
                <RotateCcw :size="14" />
              </button>
              <button type="button" class="pl-icon-btn" :title="tf('img_rotate_right', '右旋90度')" @click="rotateRight">
                <RotateCw :size="14" />
              </button>
              <span class="drawer-img-sep" />
              <button type="button" class="pl-icon-btn" :title="t('img_download')" @click="downloadImage">
                <Download :size="14" />
              </button>
            </div>
          </div>
          <!-- 文本/链接/代码/文件 全文 -->
          <div v-else class="panel drawer-content-panel">
            <div class="drawer-fulltext" :class="{ code: isCode }">{{ fullContent }}</div>
          </div>

          <!-- 链接条目：一键跳浏览器 -->
          <button v-if="isLinkItem" type="button" class="pl-btn pl-btn--sm drawer-link-btn" @click="openInBrowser">
            <ExternalLink :size="13" /><span>{{ tf('open_in_browser', '在浏览器打开') }}</span>
          </button>

          <div class="drawer-badges">
            <span class="badge" :class="meta.badge">{{ meta.label }}</span>
            <span v-if="sizeText" class="badge b-gray">{{ sizeText }}</span>
            <span v-if="item.isFavorite" class="badge b-ok">{{ t('fav_done', '已收藏') }}</span>
          </div>

          <div class="drawer-ai-label">{{ t('clip_drawer_ai', '原位 AI 操作（结果在本抽屉内展开）') }}</div>
          <div class="drawer-ai-acts">
            <button
              v-for="a in AI_ACTS"
              :key="a.key"
              type="button"
              class="pl-btn pl-btn--sm"
              :class="{ 'pl-btn--on': activeAiAct === a.key }"
              @click="onAiAct(a)"
            >
              <Sparkles :size="12" />{{ tf(a.i18n, a.fallback) }}
            </button>
          </div>
          <!-- A6 内联结果区：随点随出，不进侧栏消息流 -->
          <InlineAiCard
            v-if="activeAiAct && activeActMeta"
            class="drawer-inline-ai"
            :title="tf(activeActMeta.i18n, activeActMeta.fallback)"
            :status="drawerAi.status.value"
            :text="drawerAi.text.value"
            :error="drawerAi.error.value"
            closable
            @close="closeDrawerAi"
            @retry="retryDrawerAi"
          />
        </div>

        <div class="drawer-foot">
          <button type="button" class="pl-btn pl-btn--acc" style="flex: 1" @click="emit('copy', item)">
            <Copy :size="14" /><span>{{ t('copy') }}</span>
          </button>
          <button type="button" class="pl-btn" :title="t('favorite')" @click="emit('toggle-fav', item)">
            <Star :size="14" :fill="item.isFavorite ? 'currentColor' : 'none'" />
          </button>
          <button type="button" class="pl-btn pl-btn--danger" :title="t('delete')" @click="emit('delete', item)">
            <Trash2 :size="14" />
          </button>
        </div>
      </aside>
    </template>
  </Teleport>
</template>
