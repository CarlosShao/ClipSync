<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { Marked } from 'marked'
import { sanitizeHtml } from '@/utils/html'

/**
 * AiStreamText — Markdown 节流渲染原语（UI-C）
 *
 * 流式期间不逐 token 重渲整棵 Markdown：增量文本累积，满足以下任一条件才执行一次
 * marked.parse + sanitizeHtml（复用 utils/html 的 DOMPurify 封装）：
 *   - 距上次渲染 ≥100ms（RENDER_INTERVAL_MS）；或
 *   - 自上次渲染新累积 ≥200 字符（CHUNK_FLUSH_CHARS，长回答突发时避免长时间无反馈）。
 *
 * 渲染动作通过 requestAnimationFrame 推迟到下一帧执行，setTimeout 只负责补齐节流
 * 间隔，两者都不在 SSE 回调线程内同步 parse，避免阻塞主线程。
 *
 * 终态：done 置 true 后取消挂起的节流任务并立即做最终刷新，保证结尾 Markdown 完整。
 */
const props = withDefaults(defineProps<{ text: string; done?: boolean }>(), { done: false })

const RENDER_INTERVAL_MS = 100
const CHUNK_FLUSH_CHARS = 200

const marked = new Marked({ gfm: true, breaks: false })

const html = ref('')
let lastRenderAt = 0
let lastRenderedLen = 0
let flushTimer: number | undefined
let rafId: number | undefined

function fixIncompleteMarkdown(raw: string): string {
  if (!raw) return ''
  // 压缩连续多余空行，但不强制 trim 掉末尾换行符（避免打字流式时高度持续跳动）
  let text = raw.replace(/\n{3,}/g, '\n\n')
  
  // 1. 自动闭合流式中的未闭合代码块（避免在段落 p 与 pre 之间高频跳变）
  const backtickMatches = text.match(/```/g)
  if (backtickMatches && backtickMatches.length % 2 === 1) {
    text += '\n```'
  }

  // 2. 自动修补流式中的表格结构
  // 如果最后一行处于表格内（以 | 开头且未以 | 结尾），临时补齐一个尾部 |，使 marked 稳定将其识别为表格行而非普通段落 <p>
  const lines = text.split('\n')
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1]
    if (lastLine.trim().startsWith('|') && !lastLine.trim().endsWith('|')) {
      text += ' |'
    }
  }

  return text
}

function doRender() {
  const raw = props.text || ''
  lastRenderAt = Date.now()
  lastRenderedLen = raw.length
  if (!raw) {
    html.value = ''
    return
  }
  const prepared = fixIncompleteMarkdown(raw)
  try {
    html.value = sanitizeHtml(marked.parse(prepared) as string)
  } catch {
    html.value = sanitizeHtml(prepared)
  }
}

function cancelScheduled() {
  if (flushTimer !== undefined) {
    window.clearTimeout(flushTimer)
    flushTimer = undefined
  }
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId)
    rafId = undefined
  }
}

function scheduleFlush() {
  if (rafId !== undefined || flushTimer !== undefined) return
  // 字符突发：新累积 ≥200 字符 → 下一帧立即刷新（优先于时间阈值）
  if (props.text.length - lastRenderedLen >= CHUNK_FLUSH_CHARS) {
    rafId = requestAnimationFrame(() => {
      rafId = undefined
      doRender()
    })
    return
  }
  // 时间节流：距上次渲染不足 100ms → 补齐剩余时间后于下一帧刷新
  const wait = Math.max(0, RENDER_INTERVAL_MS - (Date.now() - lastRenderAt))
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined
    rafId = requestAnimationFrame(() => {
      rafId = undefined
      doRender()
    })
  }, wait)
}

onMounted(() => {
  // 首帧（历史消息 / 已有初始内容）直接渲染建立节流基线，后续增量走节流
  if (props.text) doRender()
})

watch(
  () => props.text,
  (now) => {
    if (props.done) return
    // 内容变短 → 消息被整体替换（如切换会话复用组件）：立即全量重渲，避免残留旧内容
    if (now.length < lastRenderedLen) {
      cancelScheduled()
      doRender()
      return
    }
    scheduleFlush()
  },
)

watch(
  () => props.done,
  (done) => {
    if (done) {
      // 终态：取消挂起任务并立即最终刷新
      cancelScheduled()
      doRender()
    }
  },
)

onBeforeUnmount(cancelScheduled)
</script>

<template>
  <div class="ai-stream-text" v-html="html"></div>
</template>

<style scoped>
.ai-stream-text {
  min-width: 0;
  max-width: 100%;
}
</style>
