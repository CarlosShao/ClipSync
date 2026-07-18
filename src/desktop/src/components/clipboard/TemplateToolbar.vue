<script setup lang="ts">
import { Search, Plus } from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'
import Input from '@/components/ui/input/Input.vue'
import Button from '@/components/ui/button/Button.vue'

defineProps<{ search: string }>()
const emit = defineEmits<{ 'update:search': [v: string]; new: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="tpl-toolbar">
    <h1 class="tpl-title">{{ t('templates_title') }}</h1>
    <div class="tpl-toolbar-right">
      <div class="tpl-search">
        <Search :size="16" class="tpl-search-icon" />
        <Input
          :model-value="search"
          @update:model-value="emit('update:search', String($event))"
          :placeholder="t('templates_search_ph')"
          class="tpl-search-input"
        />
      </div>
      <Button @click="emit('new')">
        <Plus :size="16" /> {{ t('templates_new') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.tpl-toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin-bottom: 18px; flex-wrap: wrap;
}
.tpl-title { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--text-primary); }
.tpl-toolbar-right { display: flex; align-items: center; gap: 12px; }
.tpl-search { position: relative; display: flex; align-items: center; }
.tpl-search-icon { position: absolute; left: 12px; color: var(--text-muted); pointer-events: none; }
.tpl-search-input { padding-left: 36px; width: 240px; max-width: 50vw; }
</style>
