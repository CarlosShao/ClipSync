<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useFavoritePopover } from '@/composables/useFavoritePopover'
import type { ClipItem } from '@/composables/useClipboard'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import { Star, Plus, Check, X, Folder, FolderPlus } from 'lucide-vue-next'

const props = defineProps<{ item: ClipItem }>()

const { t } = useI18n()
const fav = useFavoritePopover()

/** t() 在 key 缺失时返回 key 字面字符串；这里显式判断保证 fallback 生效。 */
function tf(key: string, fallback: string, params?: Record<string, any>): string {
  const v = t(key, params as any)
  if (typeof v === 'string' && v && v !== key) return v
  return fallback
}

// 新建子收藏夹时，用户可指定父级。
// 顶级 = 'root'；其它值 = 已存在的收藏夹 id。
const newCollectionParent = ref<string>('root')

function startCreate() {
  newCollectionParent.value = 'root'
  fav.showFavNewInput.value = true
}
function confirmCreate(itemId: string) {
  const parent = newCollectionParent.value === 'root' ? undefined : newCollectionParent.value
  fav.createAndMove(itemId, parent)
}
</script>

<template>
  <div class="add-col-wrap" :data-item-id="item.id">
    <Button
      variant="ghost"
      size="icon-sm"
      class="btn-action-hide"
      :class="{ favorited: item.isFavorite }"
      :title="item.isFavorite ? t('unfavorite') : t('favorite')"
      @click.stop="fav.handleFavorite(item)"
    >
      <Star :size="14" :fill="item.isFavorite ? 'currentColor' : 'none'" />
    </Button>
    <!-- Popover: inline collection picker (no navigation needed) -->
    <div
      v-if="fav.favPopoverItemId.value === item.id"
      class="fav-popover"
      :class="{ 'fav-popover--flipped': fav.favPopoverFlipped.value }"
      @click.stop
      @mouseenter="fav.onFavPopoverEnter"
      @mouseleave="fav.onFavPopoverLeave"
    >
      <div class="fav-popover-msg">✓ {{ t('fav_popper_msg') }}</div>
      <div class="fav-popover-cols">
        <Button
          v-for="node in fav.collectionTreeNodes.value"
          :key="node.id"
          variant="ghost"
          size="sm"
          class="fav-popover-col w-full justify-start"
          :style="{ paddingLeft: (node.depth - 2) * 16 + 8 + 'px' }"
          @click="fav.pickCollection(item.id, node.id)"
        >
          <component :is="fav.collectionIconMap[node.icon] || Folder" :size="14" />
          <span>{{ node.name }}</span>
        </Button>
      </div>
      <template v-if="!fav.showFavNewInput.value">
        <Button
          variant="outline"
          size="sm"
          class="w-full justify-start gap-1"
          @click="startCreate"
        >
          <Plus :size="12" /> {{ t('fav_new_col') }}
        </Button>
      </template>
      <template v-else>
        <!-- 父级下拉：用户可决定新建在顶级还是某个已有收藏夹下 -->
        <div class="fav-new-parent">
          <span class="fav-new-parent-label">
            <FolderPlus :size="11" />
            {{ tf('fav_new_col_parent_label', '建在') }}
          </span>
          <select v-model="newCollectionParent" class="fav-new-parent-select">
            <option value="root">{{ tf('fav_new_col_parent_root', '顶级') }}</option>
            <option v-for="node in fav.collectionTreeNodes.value" :key="node.id" :value="node.id">
              {{ '— '.repeat(Math.max(0, node.depth - 2)) }}{{ node.name }}
            </option>
          </select>
        </div>
        <div class="flex items-center gap-1">
          <Input
            v-model="fav.favNewName.value"
            class="h-8 flex-1 px-2 text-xs"
            :placeholder="t('fav_new_col_placeholder')"
            maxlength="100"
            @keydown.enter="confirmCreate(item.id)"
            @keydown.esc="fav.dismissFavPopover()"
          />
          <Button variant="default" size="icon-sm" :title="t('confirm_t')" @click="confirmCreate(item.id)"
            ><Check :size="12"
          /></Button>
          <Button variant="ghost" size="icon-sm" :title="t('fav_cancel')" @click="fav.dismissFavPopover()"
            ><X :size="12"
          /></Button>
        </div>
      </template>
    </div>
    <!-- Dropdown: shown when collections exist (旧 add-col-dropdown 路径)
         改为内嵌 + 新建收藏夹入口，与 fav-popover 体验一致 -->
    <div
      v-if="fav.addToColItemId.value === item.id"
      class="fav-popover"
      :class="{ 'fav-popover--flipped': fav.favPopoverFlipped.value }"
      @click.stop
      @mouseenter="fav.onFavPopoverEnter"
      @mouseleave="fav.onFavPopoverLeave"
    >
      <div class="fav-popover-msg">{{ tf('fav_popper_msg', '已加入收藏，要移到某个收藏夹吗？') }}</div>
      <div class="fav-popover-cols">
        <Button
          v-for="node in fav.collectionTreeNodes.value"
          :key="node.id"
          variant="ghost"
          size="sm"
          class="fav-popover-col w-full justify-start"
          :style="{ paddingLeft: (node.depth - 2) * 16 + 8 + 'px' }"
          @click="fav.addToCollection(node.id, item.id)"
        >
          <component :is="fav.collectionIconMap[node.icon] || Folder" :size="14" />
          <span>{{ node.name }}</span>
        </Button>
      </div>
      <template v-if="!fav.showFavNewInput.value">
        <Button
          variant="outline"
          size="sm"
          class="w-full justify-start gap-1"
          @click="startCreate"
        >
          <Plus :size="12" /> {{ tf('fav_new_col', '新建收藏夹') }}
        </Button>
      </template>
      <template v-else>
        <div class="fav-new-parent">
          <span class="fav-new-parent-label">
            <FolderPlus :size="11" />
            {{ tf('fav_new_col_parent_label', '建在') }}
          </span>
          <select v-model="newCollectionParent" class="fav-new-parent-select">
            <option value="root">{{ tf('fav_new_col_parent_root', '顶级') }}</option>
            <option v-for="node in fav.collectionTreeNodes.value" :key="node.id" :value="node.id">
              {{ '— '.repeat(Math.max(0, node.depth - 2)) }}{{ node.name }}
            </option>
          </select>
        </div>
        <div class="flex items-center gap-1">
          <Input
            v-model="fav.favNewName.value"
            class="h-8 flex-1 px-2 text-xs"
            :placeholder="tf('fav_new_col_placeholder', '收藏夹名')"
            maxlength="100"
            @keydown.enter="confirmCreate(item.id)"
            @keydown.esc="fav.dismissFavPopover()"
          />
          <Button variant="default" size="icon-sm" :title="tf('confirm_t', '确认')" @click="confirmCreate(item.id)"
            ><Check :size="12"
          /></Button>
          <Button variant="ghost" size="icon-sm" :title="tf('fav_cancel', '取消')" @click="fav.dismissFavPopover()"
            ><X :size="12"
          /></Button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.add-col-wrap {
  position: relative;
  display: inline-flex;
}
.btn-action-hide.favorited {
  color: var(--warning);
}

/* Add to collection dropdown */
.add-col-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-modal);
  padding: 4px;
  z-index: var(--z-dropdown);
  min-width: 160px;
}
.add-col-option {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  text-align: left;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  white-space: nowrap;
}
.add-col-option:hover {
  background: var(--bg-hover);
}
.add-col-dropdown-title {
  padding: 4px 10px 2px;
  font-size: 11px;
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 2px;
}

/* Favorite popover (方案 A: inline collection picker, no navigation) */
.fav-popover {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-modal);
  padding: 10px 12px;
  z-index: var(--z-dropdown);
  min-width: 220px;
  max-width: 300px;
  /* 限制 popover 总高度 + 内部 cols 滚动；确保底部"+ 新建收藏夹"按钮始终可见 */
  max-height: 420px;
  display: flex;
  flex-direction: column;
  animation: favPopIn 0.2s ease;
}
.fav-popover--flipped {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 6px;
}
.fav-popover-msg {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
  white-space: nowrap;
}
.fav-popover-cols {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  overflow-y: auto;
  /* flex 子项必须配 min-height: 0，否则滚动条不出现 */
  min-height: 0;
  flex: 0 1 auto;
  scrollbar-width: thin;
}
.fav-popover-cols::-webkit-scrollbar {
  width: 6px;
}
.fav-popover-cols::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--text-tertiary) 40%, transparent);
  border-radius: 999px;
}
.fav-popover-col {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  transition: all 0.12s;
}
.fav-popover-col:hover {
  background: var(--accent-bg);
  color: var(--accent);
}
/* 新建收藏夹的父级下拉 */
.fav-new-parent {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 4px 6px;
  background: var(--bg-hover);
  border-radius: 6px;
  font-size: 11.5px;
}
.fav-new-parent-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.fav-new-parent-select {
  flex: 1;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 2px 4px;
  font-size: 11.5px;
  color: var(--text-primary);
  cursor: pointer;
}
.fav-new-parent-select:focus {
  outline: none;
  border-color: var(--accent);
}
/* fav-popover 内的操作按钮已统一改用 shadcn Button / Input 组件 */

@keyframes favPopIn {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
