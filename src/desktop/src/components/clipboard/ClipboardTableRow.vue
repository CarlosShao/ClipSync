<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useClipItemDisplay, detectContentType } from '@/composables/useClipItemDisplay'
import type { ClipItem } from '@/composables/useClipboard'
import { TableRow, TableCell } from '@/components/ui/table'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import FavoriteStarCell from '@/components/clipboard/FavoriteStarCell.vue'
import {
  Copy,
  Image as ImageIcon,
  Link,
  ExternalLink,
  FileText,
  Folder,
  Star,
  Archive,
  ArchiveRestore,
  Trash2,
  Lock,
  Clock,
  MoreHorizontal,
} from 'lucide-vue-next'

const props = defineProps<{
  item: ClipItem
  focused: boolean
  isArchive: boolean
  moreOpenId: string | null
}>()

const emit = defineEmits<{
  focus: []
  dblclick: [item: ClipItem]
  contextmenu: [item: ClipItem, e: MouseEvent]
  preview: [item: ClipItem]
  copy: [item: ClipItem]
  delete: [item: ClipItem]
  unarchive: [item: ClipItem]
  'toggle-more': [item: ClipItem]
  share: [item: ClipItem]
  reveal: [item: ClipItem]
  'open-protection': [item: ClipItem]
  'archive-toggle': [item: ClipItem]
  'expiry-from-dropdown': [item: ClipItem, e: MouseEvent]
  'toggle-select': [item: ClipItem, selected: boolean]
}>()

const { t } = useI18n()
const display = useClipItemDisplay()
</script>

<template>
  <TableRow
    :data-state="item.selected ? 'selected' : undefined"
    :class="{ focused }"
    @mouseenter="emit('focus')"
    @click="emit('focus')"
    @dblclick="emit('dblclick', item)"
    @contextmenu.prevent="emit('contextmenu', item, $event)"
  >
    <TableCell class="w-12">
      <Checkbox
        :model-value="item.selected"
        @update:model-value="(v: boolean | string) => emit('toggle-select', item, v === true)"
      />
    </TableCell>
    <TableCell class="cell-content">
      <div class="cell-content-inner">
        <!-- 条目级密码保护遮罩：受保护且未解锁/超时时覆盖所有内容 -->
        <template v-if="!display.isItemVisible(item)">
          <div class="cell-protected-mask">
            <Lock :size="14" />
            <span>{{ t('item_protected_mask') }}</span>
            <Button
              variant="outline"
              size="sm"
              class="h-7 px-3 text-[11px] rounded-md"
              @click.stop="emit('open-protection', item)"
              >{{ t('item_unlock') }}</Button
            >
          </div>
        </template>
        <!-- 图片预览 -->
        <span v-else-if="item.type === 'image'" class="cell-img-preview">
          <img v-if="item.preview && item.preview !== 'loading'" :src="item.preview" alt="" class="cell-thumb" />
          <div v-else class="cell-thumb cell-thumb-placeholder">
            <ImageIcon :size="14" style="opacity: 0.4" />
          </div>
        </span>
        <!-- URL 链接样式 -->
        <span
          v-else-if="item.type === 'link' || detectContentType(display.displayContent(item)) === 'url'"
          class="cell-link-preview"
        >
          <ExternalLink :size="12" class="cell-link-icon" />
          <span class="cell-link-content">
            <span class="cell-link-text">{{ display.displayContent(item) }}</span>
            <span class="cell-link-domain">{{ display.extractDomain(display.displayContent(item)) }}</span>
          </span>
        </span>
        <!-- 文件类型（必须在 code/url 检测之前，否则 JSON 路径数组会被误判为 code） -->
        <span v-else-if="item.type === 'file'" class="cell-text">
          <span v-if="item.id.startsWith('local-') || item.id.startsWith('file-')" class="syncing-label">
            <span class="syncing-dot" /> {{ display.formatContent(item) }}
          </span>
          <span v-else>{{ display.formatContent(item) }}</span>
        </span>
        <!-- 代码样式 -->
        <span v-else-if="detectContentType(display.displayContent(item)) === 'code'" class="cell-code-preview">
          <code>{{ display.displayContent(item) }}</code>
        </span>
        <!-- 普通文本（表格/HTML 仅详情弹窗优化展示，主列表保持 plain text，避免撑大单元格） -->
        <span v-else class="cell-text">
          {{ display.formatContent(item) }}
        </span>
      </div>
    </TableCell>
    <TableCell class="cell-source">{{ item.source || 'Desktop' }}</TableCell>
    <TableCell>
      <Badge variant="outline" class="type-badge-new" :data-type="item.type">
        <span class="type-dot" />
        {{ display.getTypeLabel(item.type) }}
      </Badge>
    </TableCell>
    <TableCell class="cell-time">
      <span>{{ display.timeAgo(item.timestamp) }}</span>
      <span
        v-if="item.expiresAt"
        class="cell-expiry"
        :title="t('exp_label') + ': ' + new Date(item.expiresAt).toLocaleString()"
      >
        <Clock :size="11" />{{ display.formatExpiryShort(item.expiresAt) }}
      </span>
    </TableCell>
    <TableCell>
      <div class="cell-actions">
        <!-- 常驻：预览（按类型路由，与右键菜单共用 preview 事件） -->
        <Button
          variant="ghost"
          size="icon-sm"
          class="btn-action-hide"
          :title="t('preview')"
          @click="emit('preview', item)"
        >
          <ImageIcon v-if="item.type === 'image'" :size="14" />
          <ExternalLink v-else-if="item.type === 'link'" :size="14" />
          <FileText v-else :size="14" />
        </Button>

        <!-- 回收站视图：恢复（取消归档） + 删除（永久清空），仅此三项 -->
        <template v-if="isArchive">
          <Button
            variant="ghost"
            size="icon-sm"
            class="btn-action-hide"
            :title="t('unarchive_action')"
            @click="emit('unarchive', item)"
          >
            <ArchiveRestore :size="14" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="btn-action-hide danger"
            :title="t('delete')"
            @click="emit('delete', item)"
          >
            <Trash2 :size="14" />
          </Button>
        </template>

        <!-- 主列表视图：复制 / 收藏 / 删除 / 更多 -->
        <template v-else>
          <Button
            v-if="item.type !== 'file' || display.hasLocalPath(item)"
            variant="ghost"
            size="icon-sm"
            class="btn-action-hide"
            :title="t('copy')"
            @click="emit('copy', item)"
          >
            <Copy :size="14" />
          </Button>
          <!-- 常驻：收藏（含收藏夹 popover） -->
          <FavoriteStarCell :item="item" />
          <!-- 常驻：删除 -->
          <Button
            variant="ghost"
            size="icon-sm"
            class="btn-action-hide danger"
            :title="t('delete')"
            @click="emit('delete', item)"
          >
            <Trash2 :size="14" />
          </Button>
          <!-- 更多下拉：分享 / 文件夹 / 保护 / 归档 / 过期（与右键菜单逐类型对齐） -->
          <div class="more-wrap">
            <Button
              variant="ghost"
              size="icon-sm"
              class="btn-action-hide"
              :title="t('more_actions')"
              @click.stop="emit('toggle-more', item)"
            >
              <MoreHorizontal :size="14" />
            </Button>
            <div v-if="moreOpenId === item.id" class="more-dropdown" @click.stop>
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
              <button type="button" class="more-item" @click="emit('archive-toggle', item)">
                <Archive :size="14" />{{ isArchive ? t('unarchive_action') : t('archive_action') }}
              </button>
              <div class="more-sep" />
              <button
                type="button"
                class="more-item more-item--accent"
                @click="emit('expiry-from-dropdown', item, $event)"
              >
                <Clock :size="14" />{{ t('exp_set') }}…
              </button>
            </div>
          </div>
        </template>
      </div>
    </TableCell>
  </TableRow>
</template>

<style scoped>
/* Cell styles */
.cell-content {
  overflow: hidden;
  max-width: 0;
}
.cell-content-inner {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 受保护条目遮罩 */
.cell-protected-mask {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--color-primary, #6366f1) 10%, transparent);
  border: 1px dashed color-mix(in srgb, var(--color-primary, #6366f1) 40%, transparent);
  border-radius: var(--radius-md);
  font-size: 13px;
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

/* 普通文本 */
.cell-text {
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-word;
}

/* 图片预览 */
.cell-img-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  position: relative;
}
.cell-thumb {
  width: 48px;
  height: 34px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}
.cell-thumb-placeholder {
  width: 48px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
}

/* URL 链接样式 */
.cell-link-preview {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 5px 9px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  transition: background 0.15s;
}
.cell-link-preview:hover {
  background: var(--bg-active);
}
.cell-link-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--info);
}
.cell-link-content {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.cell-link-text {
  font-size: 13px;
  color: var(--info);
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}
.cell-link-domain {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* 代码样式 */
.cell-code-preview {
  display: block;
  width: 100%;
  padding: 5px 9px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.cell-source {
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
}

/* Type badge (shadcn Badge + colored dot) */
.type-badge-new {
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  padding-left: 8px;
  padding-right: 9px;
}
.type-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--text-tertiary);
  flex-shrink: 0;
}
.type-badge-new[data-type='image'] .type-dot {
  background: var(--success);
}
.type-badge-new[data-type='link'] .type-dot {
  background: var(--info);
}
.type-badge-new[data-type='file'] .type-dot {
  background: var(--warning);
}
.type-badge-new[data-type='text'] .type-dot {
  background: var(--text-tertiary);
}

.cell-time {
  color: var(--text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}
.cell-expiry {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
  font-size: 10px;
  white-space: nowrap;
}

/* Action buttons (always visible) */
.cell-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  justify-content: flex-end;
}
.cell-actions .btn-action-hide {
  opacity: 1;
  color: var(--text-tertiary);
  border-radius: var(--radius-sm);
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.cell-actions .btn-action-hide:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}
.cell-actions .btn-action-hide.danger {
  color: var(--danger);
}
.cell-actions .btn-action-hide.danger:hover {
  background: var(--danger-bg);
}
.cell-actions .btn-action-hide.sensitive-locked {
  color: var(--danger);
}
.cell-actions .btn-action-hide.sensitive-locked:hover {
  background: var(--danger-bg);
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
  z-index: 50;
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
.more-sep {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 2px;
}
</style>
