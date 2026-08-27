<script setup lang="ts">
import { ref, computed, inject } from 'vue'
import { CheckCircle2, HelpCircle, PenLine, Send, ChevronLeft, ChevronRight, Loader2 } from 'lucide-vue-next'
import { respondAiChatAskUser, type ToolCall, type ToolResult } from '@/api/ai'

const props = defineProps<{
  step: ToolCall
  toolResult?: ToolResult | null
}>()

const injectSend = inject<((content: string) => void) | null>('aiChatSend', null)

interface AskQuestion {
  question: string
  options: string[]
  is_multi_select: boolean
  context?: string
}

interface AskUserData {
  questions: AskQuestion[]
  context?: string
}

// 选项卡片状态
const currentQuestionIndex = ref(0)
const userSelections = ref<Record<number, string[]>>({})
const customOtherInputs = ref<Record<number, string>>({})
const extraNote = ref('')
const submittedPayload = ref('')
const isSubmitting = ref(false)

const settledText = computed(() => {
  if (submittedPayload.value) return submittedPayload.value
  if (!props.toolResult?.content) return ''
  try {
    const obj = typeof props.toolResult.content === 'object' ? props.toolResult.content : JSON.parse(props.toolResult.content)
    if (obj?.user_response) return obj.user_response
  } catch {
    /* ignore */
  }
  return ''
})

function normalizeOptions(raw: any): string[] {
  if (!raw) return []
  let list = raw
  if (typeof list === 'string') {
    if (list.includes('\n') || list.includes(',') || list.includes('，')) {
      list = list.split(/[\n,，]+/).map((s: string) => s.trim()).filter(Boolean)
    } else {
      list = [list.trim()]
    }
  }
  if (!Array.isArray(list)) {
    if (typeof list === 'object') {
      return Object.entries(list).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
    return [String(list)]
  }
  return list.map((item, idx) => {
    if (typeof item === 'string') return item.trim()
    if (typeof item === 'number') return String(item)
    if (item && typeof item === 'object') {
      return (item.label || item.text || item.title || item.name || item.value || JSON.stringify(item)).trim()
    }
    return `选项 ${idx + 1}`
  }).filter(Boolean)
}

const askData = computed<AskUserData>(() => {
  let parsed: any = {}
  const rawArgs = props.step?.arguments as any
  if (rawArgs) {
    if (typeof rawArgs === 'object') {
      parsed = { ...rawArgs }
    } else if (typeof rawArgs === 'string' && rawArgs.trim()) {
      try {
        parsed = JSON.parse(rawArgs)
      } catch {
        /* ignore */
      }
    }
  }

  // 兜底：从 result 中解析
  if (!parsed.questions && !parsed.question && !parsed.options && props.toolResult?.content) {
    try {
      const resObj = typeof props.toolResult.content === 'object' ? props.toolResult.content : JSON.parse(props.toolResult.content)
      if (resObj && typeof resObj === 'object') {
        parsed = { ...resObj, ...parsed }
      }
    } catch {
      /* ignore */
    }
  }

  const questions: AskQuestion[] = []

  if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
    for (const q of parsed.questions) {
      questions.push({
        question: q.question || q.title || q.prompt || '请做出选择：',
        options: normalizeOptions(q.options ?? q.choices ?? q.items ?? q.selections),
        is_multi_select: Boolean(q.is_multi_select || q.multiple || q.isMultiSelect),
        context: q.context || q.description || '',
      })
    }
  } else {
    const singleQ = parsed.question || parsed.title || parsed.prompt || parsed.message || '请做出选择：'
    const singleOpts = normalizeOptions(parsed.options ?? parsed.choices ?? parsed.items ?? parsed.selections ?? parsed.candidates)
    questions.push({
      question: singleQ,
      options: singleOpts.length ? singleOpts : ['确认执行', '取消操作'],
      is_multi_select: Boolean(parsed.is_multi_select || parsed.multiple || parsed.isMultiSelect),
      context: parsed.context || parsed.description || '',
    })
  }

  return {
    questions,
    context: parsed.context || '',
  }
})

const totalQuestions = computed(() => askData.value.questions.length)
const currentQ = computed(() => askData.value.questions[currentQuestionIndex.value] || askData.value.questions[0])

function setQuestionIndex(idx: number) {
  currentQuestionIndex.value = Math.min(Math.max(0, idx), totalQuestions.value - 1)
}

function getSelectedForQ(qIdx: number): string[] {
  if (!userSelections.value[qIdx]) userSelections.value[qIdx] = []
  return userSelections.value[qIdx]
}

function isOptSelected(qIdx: number, opt: string): boolean {
  return getSelectedForQ(qIdx).includes(opt)
}

function handleSelectOption(qIdx: number, opt: string, isMulti: boolean) {
  if (submittedPayload.value) return
  if (!userSelections.value[qIdx]) userSelections.value[qIdx] = []

  if (isMulti) {
    const list = userSelections.value[qIdx]
    const pos = list.indexOf(opt)
    if (pos >= 0) list.splice(pos, 1)
    else list.push(opt)
  } else {
    userSelections.value[qIdx] = [opt]
  }
}

function getCustomOther(qIdx: number): string {
  return customOtherInputs.value[qIdx] || ''
}

function setCustomOther(qIdx: number, val: string) {
  customOtherInputs.value[qIdx] = val
  if (!getSelectedForQ(qIdx).includes('__OTHER__')) {
    getSelectedForQ(qIdx).push('__OTHER__')
  }
}

const canSubmit = computed<boolean>(() => {
  if (submittedPayload.value) return false
  const hasChoice = askData.value.questions.some((_, qi) => {
    const sel = getSelectedForQ(qi)
    if (sel.length === 0) return false
    if (sel.includes('__OTHER__') && !getCustomOther(qi).trim()) {
      return sel.length > 1
    }
    return true
  })
  return hasChoice || Boolean(extraNote.value.trim())
})

async function submitAllAnswers() {
  if (isSubmitting.value) return
  isSubmitting.value = true

  const summaryLines: string[] = ['我已做出选择：']

  askData.value.questions.forEach((q, qi) => {
    const sel = getSelectedForQ(qi)
    const displayOptions = sel.map((opt) => {
      if (opt === '__OTHER__') {
        const custom = getCustomOther(qi).trim()
        return custom ? `其他(${custom})` : '其他'
      }
      return opt
    }).filter(Boolean)

    if (displayOptions.length > 0) {
      summaryLines.push(`${qi + 1}. 【${q.question}】：${displayOptions.join('、')}`)
    }
  })

  const note = extraNote.value.trim()
  if (note) {
    summaryLines.push(`【补充说明与附加要求】：${note}`)
  }

  const finalMessage = summaryLines.join('\n')
  submittedPayload.value = finalMessage

  // 1. 优先通过人类在回路 API 回调后端正在挂起的 executeTool('ask_user')
  // 这样 Agent 在同一消息/同一个工作流 turn 内直接继续执行，不会产生多余的用户气泡！
  const reqId = props.step?.id || (props.step as any)?.requestId
  if (reqId) {
    try {
      const res = await respondAiChatAskUser({ requestId: reqId, userResponse: finalMessage })
      if (res.ok) {
        isSubmitting.value = false
        return
      }
    } catch {
      /* ignore and fallback */
    }
  }

  // 2. 兜底回退：如果会话连接已断开，回退到发送新消息驱动
  if (typeof injectSend === 'function') {
    injectSend(finalMessage)
  } else {
    window.dispatchEvent(new CustomEvent('clipsync:ai-send-message', { detail: { content: finalMessage } }))
  }
  isSubmitting.value = false
}
</script>

<template>
  <div class="ai-ask-card">
    <!-- 已提交结论展示 -->
    <div v-if="settledText" class="ai-ask-card__settled">
      <div class="ai-ask-card__settled-header">
        <CheckCircle2 :size="15" class="ai-ask-card__settled-icon" />
        <span>已提交您的选择与要求</span>
      </div>
      <pre class="ai-ask-card__settled-body">{{ settledText }}</pre>
    </div>

    <!-- 交互作答面板 -->
    <div v-else class="ai-ask-card__interactive">
      <!-- 头部：问题标题 + 题号导航 + 单选/多选标签 -->
      <div class="ai-ask-card__head">
        <div class="ai-ask-card__title-wrap">
          <HelpCircle :size="15" class="ai-ask-card__icon" />
          <span class="ai-ask-card__question">
            {{ currentQ?.question }}
          </span>
        </div>
        <div class="ai-ask-card__badges">
          <span v-if="totalQuestions > 1" class="ai-ask-card__step-tag">
            {{ currentQuestionIndex + 1 }} / {{ totalQuestions }}
          </span>
          <span class="ai-ask-card__badge" :class="{ multi: currentQ?.is_multi_select }">
            {{ currentQ?.is_multi_select ? '多选' : '单选' }}
          </span>
        </div>
      </div>

      <!-- 问题背景说明（若有） -->
      <div v-if="currentQ?.context" class="ai-ask-card__desc">
        {{ currentQ.context }}
      </div>

      <!-- 选项列表 -->
      <div class="ai-ask-card__options">
        <!-- 预设选项 -->
        <button
          v-for="(opt, oi) in currentQ?.options || []"
          :key="oi"
          type="button"
          class="ai-ask-card__opt-btn"
          :class="{ selected: isOptSelected(currentQuestionIndex, opt) }"
          @click="handleSelectOption(currentQuestionIndex, opt, !!currentQ?.is_multi_select)"
        >
          <span class="ai-ask-card__opt-index">{{ String.fromCharCode(65 + (oi % 26)) }}</span>
          <span class="ai-ask-card__opt-label">{{ opt }}</span>
          <CheckCircle2 v-if="isOptSelected(currentQuestionIndex, opt)" :size="14" class="ai-ask-card__opt-check" />
        </button>

        <!-- 内置“其他 (自定义填写)”选项 -->
        <div
          class="ai-ask-card__opt-btn other"
          :class="{ selected: isOptSelected(currentQuestionIndex, '__OTHER__') }"
          @click="handleSelectOption(currentQuestionIndex, '__OTHER__', !!currentQ?.is_multi_select)"
        >
          <div class="ai-ask-card__other-head">
            <span class="ai-ask-card__opt-index other"><PenLine :size="10" /></span>
            <span class="ai-ask-card__opt-label">其他（自定义填写）</span>
            <CheckCircle2 v-if="isOptSelected(currentQuestionIndex, '__OTHER__')" :size="14" class="ai-ask-card__opt-check" />
          </div>
          <div
            v-if="isOptSelected(currentQuestionIndex, '__OTHER__')"
            class="ai-ask-card__other-input-wrap"
            @click.stop
          >
            <input
              type="text"
              class="ai-ask-card__other-input"
              :value="getCustomOther(currentQuestionIndex)"
              placeholder="请输入您的自定义选项或具体要求..."
              @input="setCustomOther(currentQuestionIndex, ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>
      </div>

      <!-- 底部：补充说明输入框 + 分页/提交工具栏 -->
      <div class="ai-ask-card__footer">
        <!-- 补充说明大输入框 -->
        <div class="ai-ask-card__notes-wrap">
          <div class="ai-ask-card__notes-label">
            <PenLine :size="11" />
            <span>补充说明 / 附加要求（可选）：</span>
          </div>
          <textarea
            class="ai-ask-card__notes-input"
            :value="extraNote"
            rows="2"
            placeholder="如需补充其他指示或注意事项，可在此输入..."
            @input="extraNote = ($event.target as HTMLTextAreaElement).value"
          />
        </div>

        <!-- 动作栏：上一题 / 下一题 / 提交选择 -->
        <div class="ai-ask-card__actions">
          <div class="ai-ask-card__nav-btns">
            <button
              v-if="totalQuestions > 1 && currentQuestionIndex > 0"
              type="button"
              class="ai-ask-card__nav-btn"
              @click="setQuestionIndex(currentQuestionIndex - 1)"
            >
              <ChevronLeft :size="13" />
              <span>上一题</span>
            </button>
            <button
              v-if="totalQuestions > 1 && currentQuestionIndex < totalQuestions - 1"
              type="button"
              class="ai-ask-card__nav-btn primary"
              @click="setQuestionIndex(currentQuestionIndex + 1)"
            >
              <span>下一题</span>
              <ChevronRight :size="13" />
            </button>
          </div>

          <button
            type="button"
            class="ai-ask-card__submit-btn"
            :disabled="!canSubmit"
            @click="submitAllAnswers"
          >
            <Send :size="12" />
            <span>提交选择</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 内嵌于工具时间线（flow 风格）：视觉令牌与 ai-diff-card 一致 */
.ai-ask-card {
  margin: 6px 0 8px 0;
  border-radius: 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  overflow: hidden;
  font-size: 12px;
  width: 100%;
}

.ai-ask-card__settled {
  padding: 10px 12px;
  background: color-mix(in srgb, var(--success) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--success) 20%, transparent);
  border-radius: 8px;
}

.ai-ask-card__settled-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--success);
  font-size: 12px;
}

.ai-ask-card__settled-icon {
  color: var(--success);
}

.ai-ask-card__settled-body {
  margin: 6px 0 0 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  line-height: 1.5;
}

.ai-ask-card__interactive {
  padding: 10px 12px;
}

.ai-ask-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.ai-ask-card__title-wrap {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
}

.ai-ask-card__icon {
  color: var(--info);
  margin-top: 1px;
  flex-shrink: 0;
}

.ai-ask-card__question {
  line-height: 1.4;
}

.ai-ask-card__badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.ai-ask-card__step-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
  color: var(--text-secondary);
}

.ai-ask-card__badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--info) 10%, transparent);
  color: var(--info);
  font-weight: 500;
}

/* 多选徽章：原为紫色区分色，收敛为主题强调色（与单选的 info 蓝保持可辨） */
.ai-ask-card__badge.multi {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
}

.ai-ask-card__desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 10px;
  line-height: 1.45;
  padding-left: 21px;
}

.ai-ask-card__options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.ai-ask-card__opt-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
  font-size: 12.5px;
}

.ai-ask-card__opt-btn:hover {
  background: color-mix(in srgb, var(--accent) 4%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}

.ai-ask-card__opt-btn.selected {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 500;
}

.ai-ask-card__opt-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.ai-ask-card__opt-btn.selected .ai-ask-card__opt-index {
  background: var(--accent);
  color: var(--accent-foreground);
}

.ai-ask-card__opt-label {
  flex: 1;
  line-height: 1.35;
  word-break: break-word;
}

.ai-ask-card__opt-check {
  color: var(--accent);
  flex-shrink: 0;
}

.ai-ask-card__opt-btn.other {
  flex-direction: column;
  align-items: stretch;
  padding: 0;
}

.ai-ask-card__other-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
}

.ai-ask-card__other-input-wrap {
  padding: 0 10px 8px 10px;
}

.ai-ask-card__other-input {
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
}

.ai-ask-card__other-input:focus,
.ai-ask-card__notes-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.ai-ask-card__footer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px dashed var(--border-default);
  padding-top: 10px;
}

.ai-ask-card__notes-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.ai-ask-card__notes-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
  resize: vertical;
  min-height: 48px;
  font-family: inherit;
}

.ai-ask-card__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ai-ask-card__nav-btns {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-ask-card__nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
  border: 1px solid var(--border-default);
  font-size: 11.5px;
  color: var(--text-secondary);
  cursor: pointer;
}

.ai-ask-card__nav-btn:hover {
  background: color-mix(in srgb, var(--text-primary) 9%, transparent);
}

.ai-ask-card__nav-btn.primary {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 20%, transparent);
}

.ai-ask-card__submit-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-foreground);
  font-size: 12px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
  margin-left: auto;
}

.ai-ask-card__submit-btn:hover:not(:disabled) {
  filter: brightness(0.92);
}

.ai-ask-card__submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
