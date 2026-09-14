<script setup lang="ts">
// === 工单 A2：「AI 整理收藏」两段式内联流程卡 ===
// 阶段一：打开即自动 run（useInlineAi → /api/ai/inline），prompt 契约要求只输出 JSON 方案；
// 阶段二：解析 JSON 渲染分组/标签预览 —— 超管可确认后真实执行（建合集 + 归组 + 打标签），
//          非超管仅预览 + 复制建议清单；解析失败降级为纯文本预览（不提供采纳、不白屏）。
// 仅预览不落库：所有写操作都发生在用户确认「采纳执行」之后。
import { ref, computed, watch, onMounted } from 'vue'
import { useInlineAi } from '@/composables/useInlineAi'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useUser } from '@/composables/useUser'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { createFavoriteCollection, addCollectionItem, createTag, setItemTags } from '@/api/client'
import { Sparkles, X, RefreshCw, Folder, Tag, Copy, Check, Info } from 'lucide-vue-next'
import type { ClipItem } from '@/composables/useClipboard'

const props = defineProps<{ items: ClipItem[] }>()
const emit = defineEmits<{
  close: []
  applied: []
}>()

const { tf } = useI18n()
const toast = useSonner()
const { isSuperAdmin, fetchUser } = useUser()
const { status, text, error, run, reset } = useInlineAi()

// --- AI 输出契约（与服务端 aiChat.js 的 JSON 约束写法同风格） ---
interface GroupPlan {
  name: string
  icon?: string
  refs: number[]
}
interface TagPlan {
  name: string
  color?: string
  refs: number[]
}
interface OrgPlan {
  groups: GroupPlan[]
  tags: TagPlan[]
}

// 随 prompt 附带的条目索引清单（0 起），itemRefs 需映射回 props.items 真实条目 id
const MAX_ITEMS = 60
const CONTEXT_ITEM_SLICE = 60

const ORGANIZE_PROMPT = [
  '你是剪贴板收藏整理助手。参考上下文是收藏条目的索引清单，每行格式为「#序号 [类型] 内容摘要」（序号从 0 开始）。',
  '请把这批收藏整理为「分组（合集）」与「标签」两类建议。',
  '',
  '只输出一个 JSON 对象（不要 markdown 代码围栏、不要任何解释文字），结构如下：',
  '{"groups":[{"name":"分组名","icon":"folder","itemRefs":[0,1]}],"tags":[{"name":"标签名","color":"#RRGGBB","itemRefs":[2,3]}]}',
  '',
  '要求：',
  '- groups：2~6 个，每组名称 2~10 个字；itemRefs 是该组应包含的条目序号数组；每组至少 2 条，不要为单条建组；icon 可省略',
  '- tags：2~8 个，每个名称 2~6 个字；itemRefs 是适合打该标签的条目序号数组；color 可省略',
  '- 同一条目可同时出现在多个组/多个标签中；无法归类的条目不要强行列入',
  '- itemRefs 只能引用清单中出现过的序号，不要编造',
  '- 只输出 JSON 对象本身，不要输出其它内容',
].join('\n')

// --- 上下文构建 ---
function contentPreview(item: ClipItem): string {
  let raw = ''
  if (item.type === 'image') raw = '（图片）'
  else if (item.type === 'file') {
    try {
      const meta = JSON.parse(item.content)
      raw = meta.name || (Array.isArray(meta.paths) && meta.paths[0]) || item.content || ''
    } catch {
      raw = item.content || ''
    }
  } else raw = item.content || ''
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, CONTEXT_ITEM_SLICE)
}

function buildContext(): string {
  const lines: string[] = props.items.slice(0, MAX_ITEMS).map((item, i) => `#${i} [${item.type}] ${contentPreview(item)}`)
  return lines.join('\n')
}

// --- 解析：容错 markdown 围栏 / 首尾杂质，失败降级纯文本 ---
const plan = ref<OrgPlan | null>(null)
const parseFailed = ref(false)

function validIcon(v: unknown): string | undefined {
  return typeof v === 'string' && ['folder', 'star', 'code', 'globe', 'zap', 'palette'].includes(v) ? v : undefined
}
function validColor(v: unknown): string | undefined {
  return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? v : undefined
}

function extractPlan(raw: string): OrgPlan | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  let jsonStr = fenced ? fenced[1].trim() : raw
  let parsed: any = null
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try {
        parsed = JSON.parse(raw.slice(s, e + 1))
      } catch {
        parsed = null
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  // itemRefs 只认随清单发送过的索引范围（前 MAX_ITEMS 条）
  const refBound = Math.min(props.items.length, MAX_ITEMS)
  const cleanRefs = (v: unknown): number[] => {
    if (!Array.isArray(v)) return []
    return [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < refBound))]
  }
  const groups: GroupPlan[] = Array.isArray(parsed.groups)
    ? parsed.groups
        .filter((g: any) => g && typeof g.name === 'string' && g.name.trim())
        .map((g: any) => ({ name: g.name.trim().slice(0, 50), icon: validIcon(g.icon), refs: cleanRefs(g.itemRefs) }))
        .filter((g: GroupPlan) => g.refs.length > 0)
    : []
  const tags: TagPlan[] = Array.isArray(parsed.tags)
    ? parsed.tags
        .filter((t: any) => t && typeof t.name === 'string' && t.name.trim())
        .map((t: any) => ({ name: t.name.trim().slice(0, 50), color: validColor(t.color), refs: cleanRefs(t.itemRefs) }))
        .filter((t: TagPlan) => t.refs.length > 0)
    : []
  if (!groups.length && !tags.length) return null
  return { groups, tags }
}

watch(status, (s) => {
  if (s !== 'done') return
  const parsed = extractPlan(text.value)
  if (parsed) {
    plan.value = parsed
    parseFailed.value = false
  } else {
    plan.value = null
    parseFailed.value = true
  }
})

// --- 流程控制 ---
function start() {
  plan.value = null
  parseFailed.value = false
  void run(ORGANIZE_PROMPT, buildContext(), { maxTokens: 3500 })
}
function close() {
  reset()
  emit('close')
}

onMounted(() => {
  // App 启动时已拉取用户态；这里幂等兜底，确保 isSuperAdmin 可用
  void fetchUser()
  start()
})

// --- 预览辅助 ---
function refsToItems(refs: number[]): ClipItem[] {
  return refs.map((r) => props.items[r]).filter(Boolean)
}
const hasPlan = computed(() => !!plan.value && (plan.value.groups.length > 0 || plan.value.tags.length > 0))

function buildSuggestionText(): string {
  if (plan.value) {
    const lines: string[] = []
    if (plan.value.groups.length) {
      lines.push('分组建议：')
      for (const g of plan.value.groups) {
        lines.push(`- ${g.name}（${g.refs.length} 条）：${refsToItems(g.refs).map(contentPreview).join('、')}`)
      }
    }
    if (plan.value.tags.length) {
      lines.push('标签建议：')
      for (const t of plan.value.tags) {
        lines.push(`- ${t.name}（${t.refs.length} 条）：${refsToItems(t.refs).map(contentPreview).join('、')}`)
      }
    }
    return lines.join('\n')
  }
  return text.value // 解析失败降级：复制原文
}
function copySuggestion() {
  void navigator.clipboard.writeText(buildSuggestionText())
  toast.show(tf('inline_ai_copied', '已复制'), 'success')
}

// --- 采纳执行（仅超管）---
const applying = ref(false)
const showAdoptConfirm = ref(false)
const applyError = ref('')

const adoptMessage = computed(() => {
  const p = plan.value
  const groupItems = p ? p.groups.reduce((s, g) => s + g.refs.length, 0) : 0
  const tagItems = p ? p.tags.reduce((s, t) => s + t.refs.length, 0) : 0
  const detail =
    p && (p.groups.length || p.tags.length)
      ? `将创建 ${p.groups.length} 个合集（涉及 ${groupItems} 条次）与 ${p.tags.length} 个标签（涉及 ${tagItems} 条次）。\n`
      : ''
  return detail + tf('inline_ai_org_adopt_confirm', '将按上述方案调整你的收藏分组与标签，确认执行？')
})

/** 读取条目已有标签（metadata 可能是字符串或对象），采纳时合并而不是覆盖 */
function itemTags(item: ClipItem): string[] {
  let meta: any = (item as any).metadata
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta)
    } catch {
      meta = null
    }
  }
  return Array.isArray(meta?.tags) ? meta.tags.map(String) : []
}

async function applyPlan() {
  const p = plan.value
  if (!p || applying.value) return
  applying.value = true
  applyError.value = ''
  try {
    // 1) 合集：逐组建合集 + 逐条归组
    for (const g of p.groups) {
      const created = await createFavoriteCollection(g.name, g.icon)
      const colId = created?.collection?.id
      if (!colId) throw new Error(tf('inline_ai_org_apply_fail', '整理执行失败，请重试') + `（create ${g.name}）`)
      for (const ref of g.refs) {
        const item = props.items[ref]
        if (!item) continue
        const ok = await addCollectionItem(colId, item.id)
        if (!ok) throw new Error(tf('inline_ai_org_apply_fail', '整理执行失败，请重试') + `（${g.name} #${ref}）`)
      }
    }
    // 2) 标签：先建全局标签（已存在时创建失败不中断），再按条目聚合一次 setItemTags（该接口为整体覆盖语义，须合并既有标签）
    for (const t of p.tags) {
      await createTag(t.name, t.color)
    }
    const tagsByRef = new Map<number, string[]>()
    for (const t of p.tags) {
      for (const ref of t.refs) {
        const arr = tagsByRef.get(ref) || []
        arr.push(t.name)
        tagsByRef.set(ref, arr)
      }
    }
    for (const [ref, names] of tagsByRef) {
      const item = props.items[ref]
      if (!item) continue
      const merged = [...new Set([...itemTags(item), ...names])]
      const res = await setItemTags(item.id, merged)
      if (!res) throw new Error(tf('inline_ai_org_apply_fail', '整理执行失败，请重试') + `（tag #${ref}）`)
    }
    toast.show(
      `${tf('inline_ai_org_done', '整理已执行')} · ${tf('inline_ai_org_undo_hint', '可在收藏页手动调整')}`,
      'success',
    )
    emit('applied')
    close()
  } catch (err: any) {
    // 失败保留预览，可重试
    applyError.value = String(err?.message || err) || tf('inline_ai_org_apply_fail', '整理执行失败，请重试')
    toast.show(applyError.value, 'error')
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <div class="fav-org-flow" role="region" :aria-label="tf('inline_ai_organize', 'AI 整理收藏')">
    <div class="fof-head">
      <span class="fof-title"><Sparkles :size="13" />{{ tf('inline_ai_organize', 'AI 整理收藏') }}</span>
      <button
        type="button"
        class="pl-icon-btn"
        :title="tf('inline_ai_close', '关闭')"
        :disabled="applying"
        @click="close"
      >
        <X :size="14" />
      </button>
    </div>

    <!-- 阶段一：分析中 -->
    <div v-if="status === 'loading'" class="fof-loading">
      <span class="fof-spinner" />
      <span>{{ tf('inline_ai_organizing', '正在分析整理收藏…') }}</span>
    </div>

    <!-- 调用失败：重试 -->
    <div v-else-if="status === 'error'" class="fof-error">
      <span>{{ error || tf('inline_ai_failed', 'AI 调用失败') }}</span>
      <button type="button" class="pl-btn pl-btn--sm" @click="start">
        <RefreshCw :size="12" /><span>{{ tf('inline_ai_retry', '重试') }}</span>
      </button>
    </div>

    <!-- JSON 解析失败：降级为纯文本预览（不提供采纳按钮，不白屏） -->
    <template v-else-if="status === 'done' && parseFailed">
      <div class="fof-notice">{{ tf('inline_ai_org_parse_fail', 'AI 返回格式无法解析，仅显示原文') }}</div>
      <div class="fof-plaintext">{{ text }}</div>
      <div class="fof-acts">
        <button type="button" class="pl-btn pl-btn--sm" @click="copySuggestion">
          <Copy :size="12" /><span>{{ tf('inline_ai_org_copy_list', '复制建议清单') }}</span>
        </button>
        <span class="fof-spacer" />
        <button type="button" class="pl-btn pl-btn--sm" @click="close">{{ tf('inline_ai_discard', '放弃') }}</button>
      </div>
    </template>

    <!-- 阶段二：方案预览 -->
    <template v-else-if="status === 'done' && hasPlan && plan">
      <div class="fof-stage-label">{{ tf('inline_ai_org_preview', '整理方案预览') }}</div>
      <div class="fof-body">
        <div v-if="plan.groups.length" class="fof-section">
          <div class="fof-section-title"><Folder :size="12" />{{ tf('fav_ai_org_groups', '分组建议') }}</div>
          <div v-for="(g, gi) in plan.groups" :key="'g' + gi" class="fof-row">
            <span class="fof-row-name">{{ g.name }}</span>
            <span class="fof-row-count">{{ tf('fav_items_count', '{n} 项', { n: g.refs.length }) }}</span>
            <span class="fof-row-items">
              {{ refsToItems(g.refs).slice(0, 3).map(contentPreview).join(' · ') }}{{ g.refs.length > 3 ? ' …' : '' }}
            </span>
          </div>
        </div>
        <div v-if="plan.tags.length" class="fof-section">
          <div class="fof-section-title"><Tag :size="12" />{{ tf('fav_ai_org_tags', '标签建议') }}</div>
          <div v-for="(tg, ti) in plan.tags" :key="'t' + ti" class="fof-row">
            <span class="fof-row-name">
              <span class="fof-row-dot" :style="{ background: tg.color || 'var(--border-strong)' }" />{{ tg.name }}
            </span>
            <span class="fof-row-count">{{ tf('fav_items_count', '{n} 项', { n: tg.refs.length }) }}</span>
            <span class="fof-row-items">
              {{ refsToItems(tg.refs).slice(0, 3).map(contentPreview).join(' · ') }}{{ tg.refs.length > 3 ? ' …' : '' }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="applyError" class="fof-error fof-error--inline">{{ applyError }}</div>

      <div v-if="applying" class="fof-loading">
        <span class="fof-spinner" />
        <span>{{ tf('inline_ai_org_applying', '正在执行整理…') }}</span>
      </div>

      <div v-else class="fof-acts">
        <template v-if="isSuperAdmin">
          <button type="button" class="pl-btn pl-btn--sm pl-btn--acc" @click="showAdoptConfirm = true">
            <Check :size="12" /><span>{{ tf('inline_ai_adopt', '采纳执行') }}</span>
          </button>
        </template>
        <template v-else>
          <span class="fof-hint"><Info :size="12" />{{ tf('inline_ai_preview_only', '普通用户仅可查看建议，采纳执行需管理员') }}</span>
          <button type="button" class="pl-btn pl-btn--sm" @click="copySuggestion">
            <Copy :size="12" /><span>{{ tf('inline_ai_org_copy_list', '复制建议清单') }}</span>
          </button>
        </template>
        <span class="fof-spacer" />
        <button type="button" class="pl-btn pl-btn--sm" @click="close">{{ tf('inline_ai_discard', '放弃') }}</button>
      </div>

      <!-- 采纳前二次确认（确认条数） -->
      <ConfirmDialog
        v-model:open="showAdoptConfirm"
        :title="tf('inline_ai_organize', 'AI 整理收藏')"
        :message="adoptMessage"
        :confirm-text="tf('inline_ai_adopt', '采纳执行')"
        :cancel-text="tf('cancel_btn', '取消')"
        confirm-variant="default"
        @confirm="applyPlan"
      />
    </template>
  </div>
</template>

<style scoped>
/* 卡面语言对齐 InlineAiCard（clearline 卡）：token 化配色，随暗/亮主题 */
.fav-org-flow {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  overflow: hidden;
  animation: fof-in 160ms var(--ease);
}
@keyframes fof-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.fof-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.fof-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.fof-title svg {
  color: var(--accent);
}
.fof-head .pl-icon-btn {
  margin-left: auto;
}
.fof-loading {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.fof-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: fof-spin 0.8s linear infinite;
}
@keyframes fof-spin {
  to {
    transform: rotate(360deg);
  }
}
.fof-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px;
  font-size: 12.5px;
  color: var(--danger);
}
.fof-error--inline {
  padding: 8px 12px;
  justify-content: flex-start;
  border-top: 1px solid var(--border-subtle);
}
.fof-notice {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-subtle);
}
.fof-plaintext {
  padding: 12px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.fof-stage-label {
  padding: 8px 12px 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.fof-body {
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 320px;
  overflow-y: auto;
}
.fof-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fof-section-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.fof-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
}
.fof-row-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  flex-shrink: 0;
}
.fof-row-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.fof-row-count {
  font-size: 11px;
  color: var(--accent);
  flex-shrink: 0;
}
.fof-row-items {
  font-size: 11.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.fof-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
}
.fof-spacer {
  flex: 1;
}
.fof-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
</style>
