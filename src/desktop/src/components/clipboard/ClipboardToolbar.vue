<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'
import { Upload, Plus } from 'lucide-vue-next'

defineProps<{ isArchive: boolean; totalItems: number }>()
const emit = defineEmits<{ upload: []; 'new-clip': [] }>()

const { t } = useI18n()
</script>

<template>
  <div class="toolbar">
    <div class="toolbar-left">
      <span class="toolbar-title">{{ isArchive ? t('nav_archive') : t('nav_clipboard') }}</span>
      <Badge variant="secondary" class="count-badge">{{ totalItems }} {{ t('items_c') }}</Badge>
    </div>
    <div class="toolbar-spacer" />
    <div class="toolbar-right">
      <Button v-if="!isArchive" variant="outline" size="sm" @click="emit('upload')">
        <Upload :size="15" />
        <span>{{ t('upload_file') }}</span>
      </Button>
      <Button v-if="!isArchive" variant="default" size="sm" @click="emit('new-clip')">
        <Plus :size="15" />
        <span>{{ t('new_clip') }}</span>
      </Button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 56px;
  padding: 0 24px;
  background: var(--bg-surface);
  flex-shrink: 0;
}
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.toolbar-title {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
}
.count-badge {
  padding: 2px 10px !important;
}
.toolbar-spacer {
  flex: 1;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* Ensure toolbar buttons have comfortable padding like the reference */
.toolbar-right :deep(button) {
  padding-left: 18px !important;
  padding-right: 18px !important;
}
</style>
