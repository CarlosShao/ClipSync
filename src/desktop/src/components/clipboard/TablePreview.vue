<script setup lang="ts">
import { computed } from 'vue'
import { parseTable } from '@/utils/table'

const props = defineProps<{ content: string }>()
const parsed = computed(() => parseTable(props.content))
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
      {{ parsed.rows.length }} 行 × {{ parsed.hasHeader ? parsed.headers.length : parsed.rows[0]?.length || 0 }} 列 ·
      {{ parsed.delimiter === '\t' ? 'TSV' : parsed.delimiter === ',' ? 'CSV' : '分隔符' }}
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
  z-index: 1;
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
