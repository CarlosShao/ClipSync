<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useClipItemDisplay, detectContentType } from '@/composables/useClipItemDisplay'
import type { ClipItem } from '@/composables/useClipboard'
import Button from '@/components/ui/button/Button.vue'
import FavoriteStarCell from '@/components/clipboard/FavoriteStarCell.vue'
import {
  Copy,
  Image as ImageIcon,
  Link,
  ExternalLink,
  FileText,
  Folder,
  Star as _Star,
  Archive,
  ArchiveRestore,
  Trash2,
  Lock,
  Clock,
  MoreHorizontal,
  History,
  Type,
  Link2,
  Code2,
  Sparkles,
  Pin,
} from 'lucide-vue-next'

const props = defineProps<{
  item: ClipItem
  focused: boolean
  isArchive: boolean
  moreOpenId: string | null
  selecting: boolean
}>()

const emit = defineEmits<{
  focus: []
  click: [item: ClipItem]
  dblclick: [item: ClipItem]
  contextmenu: [item: ClipItem, e: MouseEvent]
  preview: [item: ClipItem]
  copy: [item: ClipItem]
  delete: [item: ClipItem]
  unarchive: [item: ClipItem]
  'toggle-more': [item: ClipItem]
  share: [item: ClipItem]
  reveal: [item: ClipItem]
  'version-history': [item: ClipItem]
  'open-protection': [item: ClipItem]
  'archive-toggle': [item: ClipItem]
  'expiry-from-dropdown': [item: ClipItem, e: MouseEvent]
  'toggle-select': [item: ClipItem, selected: boolean]
  ai: [item: ClipItem]
  'pin-toggle': [item: ClipItem]
}>()

const { t } = useI18n()
const display = useClipItemDisplay()

// 本地乐观条目的临时 id 前缀（与 useClipboard 的 LOCAL_ID_PREFIX_RE 对齐）
const LOCAL_ID_PREFIX_RE = /^(local-|text-|img-|file-|browser-)/
const isServerItem = computed(() => !LOCAL_ID_PREFIX_RE.test(props.item.id))
// 「仅本机」标记（B7 / 决策 D3）：文件字节未随条目上传，对端无法还原
const isLocalOnlyFile = computed(
  () => props.item.type === 'file' && props.item.metadata?.localOnly === true,
)

// v2 原型：type-tile 图标 + 徽标类型映射
const isLink = computed(
  () => props.item.type === 'link' || detectContentType(display.displayContent(props.item)) === 'url',
)
const isCode = computed(
  () => props.item.type !== 'file' && !isLink.value && detectContentType(display.displayContent(props.item)) === 'code',
)
const tileClass = computed(() => {
  if (props.item.type === 'image') return 't-image'
  if (props.item.type === 'file') return 't-file'
  if (isLink.value) return 't-link'
  if (isCode.value) return 't-code'
  return 't-text'
})
const badgeClass = computed(() => {
  if (props.item.type === 'image') return 'b-image'
  if (props.item.type === 'file') return 'b-file'
  if (isLink.value) return 'b-link'
  if (isCode.value) return 'b-code'
  return 'b-text'
})
const badgeLabel = computed(() => display.getTypeLabel(props.item.type))

// 原型：批量选择模式下点击条目 = 切换选中；否则聚焦
function onRowClick() {
  if (props.selecting) emit('toggle-select', props.item, !props.item.selected)
  else if (props.item.type === 'file') emit('preview', props.item)
  // 文件类型沿用原文件预览弹窗（md 左目录右内容）；其余走详情抽屉
  else emit('click', props.item)
}

// 键盘 ↑↓ 移动焦点行时必须把它滚进可视区，否则焦点跑到视口外，
// 用户看到的是"高亮消失"，按 Enter 复制的是看不见的条目。
const rowRef = ref<HTMLElement | null>(null)
watch(
  () => props.focused,
  (isFocused) => {
    if (!isFocused) return
    nextTick(() => {
      rowRef.value?.scrollIntoView({ block: 'nearest' })
    })
  },
)
</script>

<template>
  <!-- v2 原型卡片行：type-tile + clip-body(内容+meta) + hover 悬浮操作列 -->
  <div
    ref="rowRef"
    class="clip-item"
    :class="{ focused, selected: item.selected, selecting }"
    @mouseenter="emit('focus')"
    @click="onRowClick"
    @dblclick="emit('dblclick', item)"
    @contextmenu.prevent="emit('contextmenu', item, $event)"
  >
    <!-- 原型：复选框仅批量选择模式渲染且恒显 -->
    <input
      v-if="selecting"
      type="checkbox"
      class="cbx"
      :checked="item.selected"
      :aria-label="t('select_item', '选择此条')"
      @click.stop
      @change="emit('toggle-select', item, ($event.target as HTMLInputElement).checked)"
    />

    <!-- 条目级密码保护遮罩：受保护且未解锁/超时时覆盖所有内容 -->
    <template v-if="!display.isItemVisible(item)">
      <div class="type-tile t-file"><Lock :size="16" /></div>
      <div class="clip-body">
        <div class="cell-protected-mask">
          <span>{{ t('item_protected_mask') }}</span>
          <Button
            variant="outline"
            size="sm"
            class="h-7 px-3 text-[11px] rounded-md"
            @click.stop="emit('open-protection', item)"
            >{{ t('item_unlock') }}</Button
          >
        </div>
      </div>
    </template>

    <template v-else>
      <div class="type-tile" :class="tileClass">
        <ImageIcon v-if="item.type === 'image'" :size="16" />
        <FileText v-else-if="item.type === 'file'" :size="16" />
        <Link2 v-else-if="isLink" :size="16" />
        <Code2 v-else-if="isCode" :size="16" />
        <Type v-else :size="16" />
      </div>

      <div class="clip-body">
        <!-- 图片预览 -->
        <template v-if="item.type === 'image'">
          <div class="clip-thumb">
            <img v-if="item.preview && item.preview !== 'loading'" :src="item.preview" alt="" />
            <span v-else class="thumb-placeholder"><ImageIcon :size="16" /></span>
          </div>
        </template>
        <!-- 文件类型（必须在 code/url 检测之前，否则 JSON 路径数组会被误判为 code） -->
        <div v-else-if="item.type === 'file'" class="clip-text" style="white-space: nowrap">
          <span v-if="item.id.startsWith('local-') || item.id.startsWith('file-')" class="syncing-label">
            <span class="syncing-dot" /> {{ display.formatContent(item) }}
          </span>
          <span v-else>{{ display.formatContent(item) }}</span>
          <!-- 仅本机可用：文件字节未上传，对端点击复制会给出明确提示而不是隐晦报错 -->
          <span v-if="isLocalOnlyFile" class="local-only-badge" :title="t('file_local_only_hint')">
            {{ t('file_local_only') }}
          </span>
        </div>
        <!-- 代码样式 -->
        <div v-else-if="isCode" class="clip-text code">{{ display.displayContent(item) }}</div>
        <!-- 链接 / 普通文本 -->
        <div v-else class="clip-text" :class="{ code: false }">{{ display.formatContent(item) }}</div>

        <div class="clip-meta">
          <span class="badge" :class="badgeClass">{{ badgeLabel }}</span>
          <span>{{ item.source || 'Desktop' }}</span>
          <span class="mono">{{ display.timeAgo(item.timestamp) }}</span>
          <span
            v-if="item.expiresAt"
            class="cell-expiry"
            :title="t('exp_label') + ': ' + new Date(item.expiresAt).toLocaleString()"
          >
            <Clock :size="10" />{{ display.formatExpiryShort(item.expiresAt) }}
          </span>
        </div>
      </div>

      <div class="clip-acts">
        <!-- 回收站视图：恢复（取消归档） + 更多，仅此两项 -->
        <template v-if="isArchive">
          <button type="button" class="pl-icon-btn" :title="t('unarchive_action')" @click.stop="emit('unarchive', item)">
            <ArchiveRestore :size="14" />
          </button>
          <div class="more-wrap">
            <button
              type="button"
              class="pl-icon-btn"
              :title="t('more_actions')"
              @click.stop="emit('toggle-more', item)"
            >
              <MoreHorizontal :size="14" />
            </button>
            <div v-if="moreOpenId === item.id" class="more-dropdown" @click.stop>
              <button type="button" class="more-item" @click="emit('archive-toggle', item)">
                <Archive :size="14" />{{ t('unarchive_action') }}
              </button>
              <div class="more-sep" />
              <button
                type="button"
                class="more-item more-item--accent"
                @click="emit('expiry-from-dropdown', item, $event)"
              >
                <Clock :size="14" />{{ t('exp_set') }}…
              </button>
              <div class="more-sep" />
              <button type="button" class="more-item more-item--danger" @click="emit('delete', item)">
                <Trash2 :size="14" />{{ t('delete') }}
              </button>
            </div>
          </div>
        </template>

        <!-- 主列表视图：原型动作列 = 收藏 / AI / 更多（复制与删除收进更多，保持一行紧凑） -->
        <template v-else>
          <!-- 常驻：收藏（含收藏夹 popover） -->
          <FavoriteStarCell :item="item" />
          <!-- 常驻：AI 处理（呼出 AI dock 并附带条目内容） -->
          <button type="button" class="pl-icon-btn" :title="t('row_ai_hint', '用 AI 处理这条')" @click.stop="emit('ai', item)">
            <Sparkles :size="14" />
          </button>
          <!-- 更多下拉：复制 / 分享 / 文件夹 / 保护 / 归档 / 过期 / 删除 -->
          <div class="more-wrap">
            <button
              type="button"
              class="pl-icon-btn"
              :title="t('more_actions')"
              @click.stop="emit('toggle-more', item)"
            >
              <MoreHorizontal :size="14" />
            </button>
            <div v-if="moreOpenId === item.id" class="more-dropdown" @click.stop>
              <button type="button" class="more-item" @click="emit('copy', item)">
                <Copy :size="14" />{{ t('copy') }}
              </button>
              <button type="button" class="more-item" @click="emit('share', item)">
                <Link :size="14" />{{ t('shared_link') }}
              </button>
              <button
                v-if="item.type === 'file' && display.hasLocalPath(item)"
                type="button"
                class="more-item"
                @click="emit('reveal', item)"
              >
                <Folder :size="14" />{{ t('show_in_folder') }}
              </button>
              <button type="button" class="more-item" @click="emit('open-protection', item)">
                <Lock :size="14" />{{ t('protection_set') }}
              </button>
              <!-- 版本历史：仅服务端条目有历史（本地临时 id 会打到 400），故对临时项隐藏 -->
              <button
                v-if="isServerItem"
                type="button"
                class="more-item"
                @click="emit('version-history', item)"
              >
                <History :size="14" />{{ t('modal_versions') }}
              </button>
              <button type="button" class="more-item" @click="emit('archive-toggle', item)">
                <Archive :size="14" />{{ t('archive_action') }}
              </button>
              <button type="button" class="more-item" @click="emit('pin-toggle', item)">
                <Pin :size="14" />{{ item.pinned ? t('unpin_item', '取消置顶') : t('pin_item', '置顶') }}
              </button>
              <div class="more-sep" />
              <button
                type="button"
                class="more-item more-item--accent"
                @click="emit('expiry-from-dropdown', item, $event)"
              >
                <Clock :size="14" />{{ t('exp_set') }}…
              </button>
              <div class="more-sep" />
              <button type="button" class="more-item more-item--danger" @click="emit('delete', item)">
                <Trash2 :size="14" />{{ t('delete') }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 受保护条目遮罩 */
.cell-protected-mask {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border: 1px dashed color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-secondary);
}
.cell-protected-mask :deep(button) {
  padding: 2px 12px !important;
}

/* Syncing indicator */
.syncing-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
}
.syncing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning);
  animation: syncPulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes syncPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

/* 「仅本机」标记（B7）：与同步中的圆点并列，视觉上不抢主文本 */
.local-only-badge {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 1px 6px;
  margin-left: 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
  font-size: 10px;
  line-height: 1.5;
  white-space: nowrap;
  vertical-align: middle;
}

.thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  opacity: 0.5;
}

.cell-expiry {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
  font-size: 10px;
  white-space: nowrap;
}

.pl-icon-btn.act-danger:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
}

/* 「更多」操作下拉 */
.more-wrap {
  position: relative;
  display: inline-flex;
}
.more-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: var(--z-dropdown);
  min-width: 172px;
  padding: 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
}
.more-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1;
  text-align: left;
  cursor: pointer;
}
.more-item:hover {
  background: var(--bg-active);
}
.more-item:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
  background: var(--bg-active);
}
.more-item svg {
  flex-shrink: 0;
  color: var(--text-tertiary);
}
.more-item--accent {
  color: var(--accent);
}
.more-item--accent svg {
  color: var(--accent);
}
.more-item--danger {
  color: var(--danger);
}
.more-item--danger svg {
  color: var(--danger);
}
.more-sep {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 2px;
}
</style>
