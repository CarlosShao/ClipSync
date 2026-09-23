<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import type { ClipboardTemplate } from '@/types'
import { highlightTemplateVars } from '@/utils/htmlText'
import { Trash2, Zap, Pencil } from 'lucide-vue-next'

defineProps<{ templates: ClipboardTemplate[] }>()
const { t, tf } = useI18n()
const emit = defineEmits<{
  edit: [tpl: ClipboardTemplate]
  insert: [tpl: ClipboardTemplate]
  delete: [tpl: ClipboardTemplate]
}>()

// P0-C C3：原 esc()/hlVars() 三份副本已抽到 utils/htmlText.highlightTemplateVars —— 豁免理由留在 SFC 里就没法被单测覆盖
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    const p = (n: number) => (n < 10 ? '0' + n : String(n))
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  } catch {
    return ''
  }
}
</script>

<template>
  <!-- v2 原型（templates.html）tpl-card：头部 名称 / 正文 变量高亮 / 尾部 更新时间 + 使用/编辑/删除 -->
  <div class="tpl-grid">
    <div v-for="tpl in templates" :key="tpl.id" class="tpl-card" title="点击编辑" @click="emit('edit', tpl)">
      <div class="tpl-card-head">
        <span class="tpl-card-name">{{ tpl.name }}</span>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- 模板正文由用户/AI 撰写，但 highlightTemplateVars（utils/htmlText）先把整段 escapeHtmlText 再做占位符替换，最终字符串里唯一能活的标签只有本项目自己写死的那对 <span class="var-hl">，内容里的任何 < 都已是 &lt;。不变式由 utils/__tests__/vhtml-invariants.test.ts 钉住 -->
      <div class="tpl-body" v-html="highlightTemplateVars(tpl.content)"></div>
      <div class="tpl-foot">
        <span class="tpl-card-updated">{{ tf('tpl_updated_ago', '更新于 {ago}', { ago: fmtTime(tpl.updated_at) }) }}</span>
        <span class="tpl-foot-acts">
          <button type="button" class="pl-btn pl-btn--sm pl-btn--acc" @click.stop="emit('insert', tpl)">
            <Zap :size="12" />{{ t('tpl_use_btn', '使用') }}
          </button>
          <button type="button" class="pl-icon-btn" :title="t('edit', '编辑')" @click.stop="emit('edit', tpl)">
            <Pencil :size="13" />
          </button>
          <button type="button" class="pl-icon-btn tpl-card-del" :title="t('delete')" @click.stop="emit('delete', tpl)">
            <Trash2 :size="13" />
          </button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tpl-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tpl-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tpl-card-updated {
  flex: none;
  font-size: 11px;
  color: var(--text-tertiary);
}
.tpl-foot-acts {
  margin-left: auto;
  display: flex;
  gap: 4px;
  align-items: center;
  flex: none;
}
.tpl-card-del:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
}
</style>
