<script setup lang="ts">
import { computed } from 'vue'
import { ClipboardPlus, Pencil, Trash2 } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import type { ClipboardTemplate } from '@/types'
import { extractVariables, isBuiltinVar } from '@/stores/templateStore'

const props = defineProps<{ template: ClipboardTemplate }>()
const emit = defineEmits<{
  edit: [tpl: ClipboardTemplate]
  insert: [tpl: ClipboardTemplate]
  delete: [tpl: ClipboardTemplate]
}>()

const vars = computed(() => extractVariables(props.template.content))

const previewText = computed(() => {
  const flat = (props.template.content || '').replace(/\s+/g, ' ').trim()
  return flat.length > 140 ? flat.slice(0, 140) + '…' : flat || '—'
})

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    const p = (n: number) => (n < 10 ? '0' + n : String(n))
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch {
    return ''
  }
}
</script>

<template>
  <div class="tpl-row">
    <div class="tpl-main">
      <div class="tpl-name">{{ template.name }}</div>
      <div class="tpl-preview">{{ previewText }}</div>
      <div class="tpl-meta">
        <span v-if="vars.length" class="tpl-vars">
          <span
            v-for="v in vars"
            :key="v"
            :class="['var-chip', isBuiltinVar(v) ? 'var-builtin' : 'var-user']"
            :title="isBuiltinVar(v) ? '内置变量（自动填充）' : '自定义变量（插入时填写）'"
            >{{ '{' + '{' + v + '}' + '}' }}</span
          >
        </span>
        <span class="tpl-time">{{ fmtTime(template.updated_at) }}</span>
      </div>
    </div>
    <div class="tpl-actions">
      <Button size="sm" variant="outline" class="px-5 min-w-[80px] rounded-md" @click="emit('insert', template)">
        <ClipboardPlus :size="14" /> 插入
      </Button>
      <Button size="sm" variant="ghost" class="px-5 min-w-[80px] rounded-md" @click="emit('edit', template)">
        <Pencil :size="14" /> 编辑
      </Button>
      <Button size="icon-sm" variant="ghost" class="tpl-del" title="删除" @click="emit('delete', template)">
        <Trash2 :size="15" />
      </Button>
    </div>
  </div>
</template>

<style scoped>
.tpl-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-default);
  transition: background 0.12s;
}
.tpl-row:hover {
  background: var(--bg-hover);
}
.tpl-main {
  flex: 1;
  min-width: 0;
}
.tpl-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.tpl-preview {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.tpl-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.tpl-vars {
  display: inline-flex;
  gap: 8px;
  flex-wrap: wrap;
}
.var-chip {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
}
.var-builtin {
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 25%, transparent);
}
.var-user {
  background: var(--bg-hover);
  color: var(--text-secondary);
  border-color: var(--border-default);
}
.tpl-time {
  font-size: 11px;
  color: var(--text-muted);
}
.tpl-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.tpl-del:hover {
  color: var(--destructive);
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
}
</style>
