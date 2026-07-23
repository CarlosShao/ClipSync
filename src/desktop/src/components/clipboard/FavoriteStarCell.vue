<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useFavoritePopover } from '@/composables/useFavoritePopover'
import type { ClipItem } from '@/composables/useClipboard'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import { Star, Plus, Check, X, Folder } from 'lucide-vue-next'

const props = defineProps<{ item: ClipItem }>()

const { t } = useI18n()
const fav = useFavoritePopover()
</script>

<template>
  <div class="add-col-wrap" :data-item-id="item.id">
    <Button variant="ghost" size="icon-sm" class="btn-action-hide" :class="{ 'favorited': item.isFavorite }" @click.stop="fav.handleFavorite(item)" :title="item.isFavorite ? t('unfavorite') : t('favorite')">
      <Star :size="14" :fill="item.isFavorite ? 'currentColor' : 'none'" />
    </Button>
    <!-- Popover: inline collection picker (no navigation needed) -->
    <div v-if="fav.favPopoverItemId.value === item.id" class="fav-popover" :class="{ 'fav-popover--flipped': fav.favPopoverFlipped.value }" @click.stop @mouseenter="fav.onFavPopoverEnter" @mouseleave="fav.onFavPopoverLeave">
      <div class="fav-popover-msg">✓ {{ t('fav_popper_msg') }}</div>
      <div class="fav-popover-cols">
        <Button v-for="node in fav.collectionTreeNodes.value" :key="node.id" variant="ghost" size="sm" class="fav-popover-col w-full justify-start" :style="{ paddingLeft: (node.depth - 2) * 16 + 8 + 'px' }" @click="fav.pickCollection(item.id, node.id)">
          <component :is="fav.collectionIconMap[node.icon] || Folder" :size="14" />
          <span>{{ node.name }}</span>
        </Button>
      </div>
      <template v-if="!fav.showFavNewInput.value">
        <Button variant="outline" size="sm" class="w-full justify-start gap-1" @click="fav.showFavNewInput.value = true">
          <Plus :size="12" /> {{ t('fav_new_col') }}
        </Button>
      </template>
      <template v-else>
        <div class="flex items-center gap-1">
          <Input v-model="fav.favNewName.value" class="h-8 flex-1 px-2 text-xs" :placeholder="t('fav_new_col_placeholder')" maxlength="100"
            @keydown.enter="fav.createAndMove(item.id)" @keydown.esc="fav.dismissFavPopover()" />
          <Button variant="default" size="icon-sm" @click="fav.createAndMove(item.id)" :title="t('confirm_t')"><Check :size="12" /></Button>
          <Button variant="ghost" size="icon-sm" @click="fav.dismissFavPopover()" :title="t('fav_cancel')"><X :size="12" /></Button>
        </div>
      </template>
    </div>
    <!-- Dropdown: shown when collections exist -->
    <div v-if="fav.addToColItemId.value === item.id && fav.collections.value.length > 0" class="add-col-dropdown">
      <div class="add-col-dropdown-title">收藏到</div>
      <Button v-for="node in fav.collectionTreeNodes.value" :key="node.id" variant="ghost" size="sm" class="add-col-option w-full justify-start" :style="{ paddingLeft: (node.depth - 2) * 16 + 8 + 'px' }" @click="fav.addToCollection(node.id, item.id)">
        <component :is="fav.collectionIconMap[node.icon] || Folder" :size="14" />
        <span>{{ node.name }}</span>
      </Button>
    </div>
  </div>
</template>

<style scoped>
.add-col-wrap { position: relative; display: inline-flex; }
.btn-action-hide.favorited { color: var(--warning); }

/* Add to collection dropdown */
.add-col-dropdown {
  position: absolute; top: 100%; right: 0; margin-top: 4px;
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-md); box-shadow: var(--shadow-modal);
  padding: 4px; z-index: 50; min-width: 160px;
}
.add-col-option {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 10px; border: none; background: none;
  text-align: left; font-size: 12px; color: var(--text-primary); cursor: pointer;
  border-radius: var(--radius-sm); white-space: nowrap;
}
.add-col-option:hover { background: var(--bg-hover); }
.add-col-dropdown-title {
  padding: 4px 10px 2px; font-size: 11px; color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-subtle); margin-bottom: 2px;
}

/* Favorite popover (方案 A: inline collection picker, no navigation) */
.fav-popover {
  position: absolute; top: 100%; right: 0; margin-top: 6px;
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-md); box-shadow: var(--shadow-modal);
  padding: 10px 12px; z-index: 50; min-width: 200px; max-width: 280px;
  animation: favPopIn 0.2s ease;
}
.fav-popover--flipped {
  position: absolute; bottom: 100%; right: 0; margin-bottom: 6px;
}
.fav-popover-msg { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; white-space: nowrap; }
.fav-popover-cols { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.fav-popover-col {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 5px 10px; border: none; border-radius: var(--radius-sm);
  background: transparent; font-size: 12px; color: var(--text-primary);
  cursor: pointer; text-align: left; white-space: nowrap; transition: all 0.12s;
}
.fav-popover-col:hover { background: var(--accent-bg); color: var(--accent); }
/* fav-popover 内的操作按钮已统一改用 shadcn Button / Input 组件 */

@keyframes favPopIn {
  from { opacity: 0; transform: translateY(-4px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
