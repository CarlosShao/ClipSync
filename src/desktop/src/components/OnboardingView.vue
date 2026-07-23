<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Clipboard, Monitor, Keyboard, CheckCircle } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'

const { t } = useI18n()
const emit = defineEmits<{ complete: [] }>()

const step = ref(0)

const steps = [
  { icon: Clipboard, color: 'var(--accent)' },
  { icon: Monitor, color: 'var(--success)' },
  { icon: Keyboard, color: 'var(--info)' },
  { icon: CheckCircle, color: 'var(--success)' },
]

function next() {
  if (step.value < steps.length - 1) {
    step.value++
  } else {
    localStorage.setItem('clipsync-onboarded', '1')
    emit('complete')
  }
}

function skip() {
  localStorage.setItem('clipsync-onboarded', '1')
  emit('complete')
}
</script>

<template>
  <div class="onb-overlay" role="dialog" :aria-label="t('onb_title')">
    <div class="onb-card">
      <div class="onb-steps">
        <div v-for="(_, i) in steps" :key="i" class="onb-dot" :class="{ active: i === step, done: i < step }" />
      </div>

      <div class="onb-content">
        <div class="onb-icon-wrap" :style="{ color: steps[step].color, background: steps[step].color + '15' }">
          <component :is="steps[step].icon" :size="40" />
        </div>
        <h2 class="onb-title">{{ t(`onb_step${step}_title`) }}</h2>
        <p class="onb-desc">{{ t(`onb_step${step}_desc`) }}</p>
      </div>

      <div class="onb-actions">
        <Button v-if="step < steps.length - 1" variant="ghost" size="sm" @click="skip">{{ t('onb_skip') }}</Button>
        <div v-else />
        <Button size="default" class="onb-next-btn" @click="next">
          {{ step < steps.length - 1 ? t('onb_next') : t('onb_start') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onb-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-modal-overlay);
  animation: onbFadeIn 0.3s ease;
}
.onb-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  padding: 40px;
  max-width: 420px;
  width: 100%;
  box-shadow: var(--shadow-modal);
  animation: onbSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
.onb-steps {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 32px;
}
.onb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border-default);
  transition: all 0.2s ease;
}
.onb-dot.active {
  background: var(--accent);
  width: 24px;
  border-radius: 4px;
}
.onb-dot.done {
  background: var(--accent);
  opacity: 0.5;
}
.onb-content {
  text-align: center;
  margin-bottom: 32px;
}
.onb-icon-wrap {
  width: 72px;
  height: 72px;
  border-radius: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 20px;
}
.onb-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text-primary);
}
.onb-desc {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.onb-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.onb-next-btn {
  min-width: 100px;
}
@keyframes onbFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes onbSlideUp {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
