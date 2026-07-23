<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'

const { t } = useI18n()
const emit = defineEmits<{ complete: [] }>()

const currentStep = ref(0)
const highlightRect = ref({ top: 0, left: 0, width: 0, height: 0 })
const tooltipPos = ref({ top: 0, left: 0 })
const visible = ref(false)

const steps = [
  { selector: '.clipboard-view', tooltipKey: 'coach_clipboard', placement: 'bottom' as const },
  { selector: '.sb-item.active', tooltipKey: 'coach_sidebar', placement: 'right' as const },
  { selector: '.toolbar-right', tooltipKey: 'coach_toolbar', placement: 'bottom' as const },
]

function positionHighlight() {
  const s = steps[currentStep.value]
  const el = document.querySelector(s.selector)
  if (!el) {
    next()
    return
  }
  const r = el.getBoundingClientRect()
  highlightRect.value = { top: r.top - 4, left: r.left - 4, width: r.width + 8, height: r.height + 8 }

  if (s.placement === 'right') {
    tooltipPos.value = { top: r.top + r.height / 2 - 40, left: r.right + 16 }
  } else {
    tooltipPos.value = { top: r.bottom + 12, left: r.left + r.width / 2 - 140 }
  }
}

function next() {
  if (currentStep.value < steps.length - 1) {
    currentStep.value++
    nextTick(positionHighlight)
  } else {
    complete()
  }
}

function complete() {
  visible.value = false
  localStorage.setItem('clipsync-coach-done', '1')
  emit('complete')
}

onMounted(() => {
  if (localStorage.getItem('clipsync-coach-done')) {
    complete()
    return
  }
  visible.value = true
  nextTick(positionHighlight)
  window.addEventListener('resize', positionHighlight)
})
</script>

<template>
  <div v-if="visible" class="coach-overlay" @click="complete">
    <!-- Highlight cutout -->
    <div
      class="coach-highlight"
      :style="{
        top: highlightRect.top + 'px',
        left: highlightRect.left + 'px',
        width: highlightRect.width + 'px',
        height: highlightRect.height + 'px',
      }"
      @click.stop="next"
    />

    <!-- Tooltip -->
    <div class="coach-tooltip" :style="{ top: tooltipPos.top + 'px', left: tooltipPos.left + 'px' }" @click.stop>
      <p class="coach-text">{{ t(steps[currentStep].tooltipKey) }}</p>
      <div class="coach-actions">
        <span class="coach-progress">{{ currentStep + 1 }} / {{ steps.length }}</span>
        <Button size="sm" class="coach-btn" @click="next">
          {{ currentStep < steps.length - 1 ? t('onb_next') : t('onb_start') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.coach-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998;
}
.coach-highlight {
  position: fixed;
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  cursor: pointer;
  z-index: 9999;
}
.coach-tooltip {
  position: fixed;
  z-index: 10000;
  max-width: 300px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 16px;
  box-shadow: var(--shadow-modal);
  animation: coachFadeIn 0.25s ease;
}
.coach-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 12px;
}
.coach-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.coach-progress {
  font-size: 11px;
  color: var(--text-tertiary);
}
.coach-btn {
  min-width: 80px;
}
@keyframes coachFadeIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
