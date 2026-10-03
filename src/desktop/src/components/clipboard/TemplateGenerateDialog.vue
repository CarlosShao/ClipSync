<script setup lang="ts">
// === 工单 A3：「AI 生成模板」内联对话框（不进侧栏消息流） ===
// 两段式：意图输入 → useInlineAi(/api/ai/inline，只输出 JSON 契约，maxTokens 3000) → 解析容错 →
// 预览（正文 {{变量}} 高亮 + 变量 chip，与模板详情同一套正则/样式）→ 保存走 TemplatesView 现有创建路径。
// 解析失败显示错误态 + 重新生成，不白屏；空意图点生成 toast 防呆。
import { ref, watch } from 'vue'
import { useInlineAi } from '@/composables/useInlineAi'
import { inlinePromptFor } from '@/utils/inlinePrompts'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useTemplateStore, isBuiltinVar } from '@/stores/templateStore'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import { Textarea } from '@/components/ui/textarea'
import Button from '@/components/ui/button/Button.vue'
import { Sparkles, Loader2, RefreshCw, Save } from 'lucide-vue-next'
import AiStreamText from '@/components/ai/AiStreamText.vue'
import type { ClipboardTemplate } from '@/types'
import { highlightTemplateVars } from '@/utils/htmlText'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; saved: [tpl: ClipboardTemplate] }>()

const { tf } = useI18n()
const toast = useSonner()
const store = useTemplateStore()
const { status, text, error, run, reset } = useInlineAi()

// --- AI 输出契约（与服务端 aiChat.js 的 JSON 约束写法同风格，对齐 FavOrganizeFlow） ---
interface TplDraft {
  name: string
  content: string
  variables: string[]
}

// 提示词按**当前界面语言**取（zh/en 双份见 utils/inlinePrompts.ts，末尾附语言要求）；
// 每次调用实时取语言 ⇒ 切语言后下一个请求立刻生效。

// --- 解析：容错 markdown 围栏 / 首尾杂质，失败降级错误态（不白屏） ---
const intent = ref('')
const parsed = ref<TplDraft | null>(null)
const parseFailed = ref(false)
const saving = ref(false)

function extractDraft(raw: string): TplDraft | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonStr = fenced ? fenced[1].trim() : raw
  let obj: any = null
  try {
    obj = JSON.parse(jsonStr)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try {
        obj = JSON.parse(raw.slice(s, e + 1))
      } catch {
        obj = null
      }
    }
  }
  if (!obj || typeof obj !== 'object') return null
  const content = typeof obj.content === 'string' ? obj.content.trim() : ''
  if (!content) return null
  const aiName = typeof obj.name === 'string' ? obj.name.trim().slice(0, 60) : ''
  const name = aiName || intent.value.trim().slice(0, 30) || tf('tpl_ai_gen_default_name', 'AI 生成的模板')
  // 变量以正文实际占位符为准（与预览高亮同一正则，保证「看到的 chip = 真实占位符」），
  // AI 声明的 variables 仅作校验参考，不直接采信
  const variables = extractPreviewVars(content)
  return { name, content, variables }
}

watch(status, (s) => {
  if (s !== 'done') return
  const draft = extractDraft(text.value)
  if (draft) {
    parsed.value = draft
    parseFailed.value = false
  } else {
    parsed.value = null
    parseFailed.value = true
  }
})

// P0-C C3：原 esc()/hlVars() 三份副本已抽到 utils/htmlText.highlightTemplateVars —— 豁免理由留在 SFC 里就没法被单测覆盖
function extractPreviewVars(content: string): string[] {
  return [...new Set((content.match(/\{\{\s*([^:{}]+?)\s*\}\}/g) || []).map((m) => m.replace(/[{}]/g, '').trim()).filter(Boolean))]
}

// --- 流程控制 ---
function generate() {
  const q = intent.value.trim()
  if (!q) {
    toast.show(tf('tpl_ai_gen_empty_intent', '请先描述模板需求'), 'error')
    return
  }
  parsed.value = null
  parseFailed.value = false
  void run(inlinePromptFor('generateTemplate'), q, { maxTokens: 3000 })
}

/** 保存为模板：走 TemplatesView 现有创建路径（store.create → createTemplate API，自带成功/失败 toast） */
async function save() {
  const p = parsed.value
  if (!p || saving.value) return
  saving.value = true
  try {
    const created = await store.create(p.name, p.content)
    if (created) {
      emit('saved', created)
      intent.value = ''
    }
  } finally {
    saving.value = false
  }
}

function close() {
  emit('close')
}

// 关闭即中止在途请求并清理解析态；意图保留，便于误关后恢复
watch(
  () => props.open,
  (open) => {
    if (!open) {
      reset()
      parsed.value = null
      parseFailed.value = false
      saving.value = false
    }
  },
)
</script>

<template>
  <ModalDialog
    :open="open"
    :title="tf('tpl_ai_gen_dialog_title', 'AI 生成模板')"
    max-width="560px"
    @close="close"
  >
    <div class="tgd-form">
      <!-- 意图输入：始终可见，生成后仍可修改后重新生成 -->
      <div class="tgd-field">
        <label class="tgd-label" for="tgd-intent">{{ tf('tpl_ai_gen_intent_label', '模板需求') }}</label>
        <Textarea
          id="tgd-intent"
          v-model="intent"
          :placeholder="tf(
            'tpl_ai_gen_intent_ph',
            '例如：一个每日站会汇报模板，包含昨日进展、今日计划、当前阻塞…',
          )"
          class="tgd-intent min-h-[88px]"
          :disabled="status === 'loading'"
        />
        <p class="tgd-hint">{{ tf('tpl_ai_gen_intent_hint', '一句话或要点即可，生成的模板将使用变量占位符') }}</p>
      </div>

      <!-- 生成中 -->
      <div v-if="status === 'loading'" class="tgd-loading">
        <span class="tgd-spinner" />
        <span>{{ tf('inline_ai_generating', '正在生成…') }}</span>
      </div>

      <!-- 调用失败 -->
      <div v-else-if="status === 'error'" class="tgd-error">
        <span>{{ error || tf('inline_ai_failed', 'AI 调用失败') }}</span>
      </div>

      <!-- JSON 解析失败：错误态 + 重新生成，不白屏 -->
      <template v-else-if="status === 'done' && parseFailed">
        <div class="tgd-error">
          <span>{{ tf('tpl_ai_gen_parse_fail', 'AI 返回格式无法解析，请调整需求后重新生成') }}</span>
        </div>
        <div class="tgd-plaintext markdown-body"><AiStreamText :text="text" :done="true" /></div>
      </template>

      <!-- 预览：模板名 + 正文（变量高亮）+ 变量 chip -->
      <template v-else-if="status === 'done' && parsed">
        <div class="tgd-stage-label">{{ tf('tpl_ai_gen_preview', '模板预览') }}</div>
        <div class="tgd-preview">
          <div class="tgd-preview-name">{{ parsed.name }}</div>
          <!-- eslint-disable-next-line vue/no-v-html -- 模板正文由用户/AI 撰写，但 highlightTemplateVars（utils/htmlText）先把整段 escapeHtmlText 再做占位符替换，最终字符串里唯一能活的标签只有本项目自己写死的那对 <span class="var-hl">，内容里的任何 < 都已是 &lt;。不变式由 utils/__tests__/vhtml-invariants.test.ts 钉住 -->
          <div class="tgd-preview-body" v-html="highlightTemplateVars(parsed.content, false)"></div>
          <div v-if="parsed.variables.length" class="tgd-preview-vars">
            <span class="tgd-vars-label">{{ tf('tpl_ai_gen_vars', '变量') }}</span>
            <span
              v-for="v in parsed.variables"
              :key="v"
              :class="['var-chip', isBuiltinVar(v) ? 'builtin' : 'user']"
              >{{ '{' + '{' + v + '}' + '}' }}</span
            >
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <!-- 输入 / 生成中 -->
      <template v-if="status === 'idle' || status === 'loading'">
        <Button variant="outline" size="default" class="px-6 min-w-[100px] rounded-md" @click="close">
          {{ tf('cancel_btn', '取消') }}
        </Button>
        <Button size="default" class="px-6 min-w-[100px] rounded-md" :disabled="status === 'loading'" @click="generate">
          <Loader2 v-if="status === 'loading'" :size="14" class="animate-spin" />
          <Sparkles v-else :size="14" />
          <span>{{ status === 'loading' ? tf('inline_ai_generating', '正在生成…') : tf('tpl_ai_gen_generate', '生成') }}</span>
        </Button>
      </template>

      <!-- 结果态：保存为模板 / 重新生成（保留意图重跑）/ 放弃 -->
      <template v-else>
        <Button variant="outline" size="default" class="px-6 min-w-[100px] rounded-md" :disabled="saving" @click="close">
          {{ tf('inline_ai_discard', '放弃') }}
        </Button>
        <Button
          variant="outline"
          size="default"
          class="px-6 min-w-[100px] rounded-md"
          :disabled="saving"
          @click="generate"
        >
          <RefreshCw :size="14" />
          <span>{{ tf('tpl_ai_gen_regen', '重新生成') }}</span>
        </Button>
        <Button
          v-if="status === 'done' && parsed"
          size="default"
          class="px-6 min-w-[100px] rounded-md"
          :disabled="saving"
          @click="save"
        >
          <Loader2 v-if="saving" :size="14" class="animate-spin" />
          <Save v-else :size="14" />
          <span>{{ tf('tpl_ai_gen_save', '保存为模板') }}</span>
        </Button>
      </template>
    </template>
  </ModalDialog>
</template>

<style scoped>
.tgd-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.tgd-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tgd-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.tgd-intent {
  min-height: 88px;
  font-size: 13px;
}
.tgd-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
.tgd-loading {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-hover);
}
.tgd-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: tgd-spin 0.8s linear infinite;
}
@keyframes tgd-spin {
  to {
    transform: rotate(360deg);
  }
}
.tgd-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: var(--danger);
  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
.tgd-plaintext {
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-secondary);
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-hover);
}
/* 解析失败降级区的 Markdown 预览排版（与 InlineAiCard 同 token） */
.tgd-plaintext.markdown-body :deep(p) {
  margin: 6px 0;
}
.tgd-plaintext.markdown-body :deep(ul),
.tgd-plaintext.markdown-body :deep(ol) {
  padding-left: 20px;
  margin: 6px 0;
}
.tgd-plaintext.markdown-body :deep(li) {
  margin: 3px 0;
}
.tgd-plaintext.markdown-body :deep(h1),
.tgd-plaintext.markdown-body :deep(h2),
.tgd-plaintext.markdown-body :deep(h3),
.tgd-plaintext.markdown-body :deep(h4) {
  margin: 12px 0 6px;
  font-weight: 600;
}
.tgd-plaintext.markdown-body :deep(h1) {
  font-size: 17px;
}
.tgd-plaintext.markdown-body :deep(h2) {
  font-size: 15px;
}
.tgd-plaintext.markdown-body :deep(h3) {
  font-size: 13.5px;
}
.tgd-plaintext.markdown-body :deep(code) {
  background: var(--bg-overlay-l1, var(--bg-hover));
  padding: 2px 5px;
  border-radius: 4px;
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--accent);
}
.tgd-plaintext.markdown-body :deep(pre) {
  background: var(--bg-base-secondary, var(--bg-hover));
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 10px 0;
}
.tgd-plaintext.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  color: var(--text-default, var(--text-primary));
}
.tgd-plaintext.markdown-body :deep(strong) {
  font-weight: 600;
}
.tgd-plaintext.markdown-body :deep(a) {
  color: var(--accent);
}
.tgd-plaintext.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--accent);
  background: var(--bg-overlay-l1, var(--bg-hover));
  padding: 8px 14px;
  border-radius: 6px;
  margin: 8px 0;
  color: var(--text-secondary);
}
.tgd-plaintext.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}
.tgd-plaintext.markdown-body :deep(th),
.tgd-plaintext.markdown-body :deep(td) {
  padding: 8px 12px;
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  text-align: left;
}
.tgd-plaintext.markdown-body :deep(th) {
  background: var(--bg-base-secondary, var(--bg-hover));
  font-weight: 600;
}
.tgd-plaintext.markdown-body :deep(tr:nth-child(2n)) {
  background: var(--bg-base-secondary, var(--bg-hover));
}
.tgd-stage-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.tgd-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}
.tgd-preview-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle);
}
.tgd-preview-body {
  font-family: var(--font-content);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}
.tgd-preview-vars {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
}
.tgd-vars-label {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
