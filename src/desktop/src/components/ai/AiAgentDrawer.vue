<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { AgentRun } from '@/api/ai'
import AiAgentRun from './AiAgentRun.vue'
import { X } from 'lucide-vue-next'

const props = defineProps<{ run: AgentRun; isStreaming: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

// E4：抽屉打开后焦点移入关闭按钮，键盘用户可直接 Tab 遍历抽屉内容
const closeBtnRef = ref<HTMLButtonElement | null>(null)
onMounted(async () => {
  await nextTick()
  closeBtnRef.value?.focus()
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

// ESC 关闭抽屉；用捕获阶段确保优先于其它 ESC 处理器
onMounted(() => document.addEventListener('keydown', onKey, true))
onUnmounted(() => document.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div class="ai-agent-drawer-backdrop" @click.self="emit('close')">
      <div class="ai-agent-drawer" role="dialog" aria-modal="true">
        <div class="ai-agent-drawer-head">
          <span class="ai-agent-drawer-title">{{ t('ai_subagent_drawer_title') }}</span>
          <button
            ref="closeBtnRef"
            class="ai-agent-drawer-close"
            :aria-label="t('ai_subagent_close', '关闭')"
            @click="emit('close')"
          >
            <X :size="16" />
          </button>
        </div>
        <div class="ai-agent-drawer-body">
          <AiAgentRun :run="run" :is-streaming="isStreaming" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ai-agent-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 半透明遮罩：rgba(0,0,0,.45) 为刻意的遮蔽强度，跨主题保持一致（非 token 化对象） */
  background: rgba(0, 0, 0, 0.45);
  padding: 24px;
  animation: ai-drawer-fade 0.15s ease-out;
}
.ai-agent-drawer {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 460px;
  max-height: 80vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg, 12px);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}
.ai-agent-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-hover);
}
.ai-agent-drawer-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
}
.ai-agent-drawer-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md, 8px);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.ai-agent-drawer-close:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}
.ai-agent-drawer-body {
  padding: 12px;
  overflow-y: auto;
}
@keyframes ai-drawer-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* 键盘可达性：focus-visible 高亮（--accent token） */
.ai-agent-drawer-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
