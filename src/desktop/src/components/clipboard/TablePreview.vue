<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { parseTable } from '@/utils/table'

const props = defineProps<{ content: string }>()
const { tf } = useI18n()
const parsed = computed(() => parseTable(props.content))

const dimensionText = computed(() =>
  tf('table_rows_cols', '{rows} 行 × {cols} 列', {
    rows: parsed.value?.rows.length ?? 0,
    cols: parsed.value ? (parsed.value.hasHeader ? parsed.value.headers.length : parsed.value.rows[0]?.length || 0) : 0,
  }),
)
const delimiterText = computed(() => {
  const d = parsed.value?.delimiter
  if (d === '\t') return 'TSV'
  if (d === ',') return 'CSV'
  return tf('table_delim_other', '分隔符')
})
</script>

<template>
  <div v-if="parsed" class="table-preview-wrap">
    <div class="table-preview-scroll">
      <table class="table-preview">
        <thead v-if="parsed.hasHeader">
          <tr>
            <th v-for="(h, i) in parsed.headers" :key="'h' + i">{{ h }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in parsed.rows" :key="'r' + ri">
            <td v-for="(cell, ci) in row" :key="'c' + ci">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="table-preview-meta">
      {{ dimensionText }} · {{ delimiterText }}
    </div>
  </div>
  <span v-else class="fallback-text">{{ content }}</span>
</template>

<style scoped>
.table-preview-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.table-preview-scroll {
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}
.table-preview {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
  line-height: 1.45;
}
.table-preview th,
.table-preview td {
  padding: 4px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border-subtle);
  border-right: 1px solid var(--border-subtle);
  white-space: nowrap;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.table-preview th {
  position: sticky;
  top: 0;
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-weight: 600;
  z-index: var(--z-base);
}
.table-preview tbody tr:hover {
  background: var(--bg-hover);
}
.table-preview td {
  color: var(--text-primary);
}
.table-preview-meta {
  font-size: 11px;
  color: var(--text-tertiary);
}
.fallback-text {
  font-size: 13px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
