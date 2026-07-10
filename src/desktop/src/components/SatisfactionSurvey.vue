<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import { api } from '@/api/client'
import Button from '@/components/ui/button/Button.vue'

const { t } = useI18n()
const toast = useToast()
const emit = defineEmits<{ complete: [] }>()

const visible = ref(false)
const step = ref<'nps' | 'feedback' | 'done'>('nps')
const npsScore = ref<number | null>(null)
const feedbackText = ref('')
const submitting = ref(false)

// Trigger conditions: show after 7 days of usage, max once per 30 days
const SURVEY_KEY = 'clipsync-survey'
const COOLDOWN = 30 * 24 * 60 * 60 * 1000 // 30 days
const FIRST_USE_KEY = 'clipsync-first-use'

onMounted(() => {
  const lastSurvey = localStorage.getItem(SURVEY_KEY)
  const firstUse = localStorage.getItem(FIRST_USE_KEY)

  if (!firstUse) {
    localStorage.setItem(FIRST_USE_KEY, Date.now().toString())
    return
  }

  if (lastSurvey) {
    const elapsed = Date.now() - parseInt(lastSurvey)
    if (elapsed < COOLDOWN) return
  }

  // Show after 7 days of first use
  const daysSinceFirstUse = (Date.now() - parseInt(firstUse)) / (24 * 60 * 60 * 1000)
  if (daysSinceFirstUse >= 7) {
    visible.value = true
  }
})

function selectNps(score: number) {
  npsScore.value = score
  step.value = 'feedback'
}

async function submitSurvey() {
  submitting.value = true
  try {
    const res = await api('POST', '/api/surveys', {
      type: 'nps',
      score: npsScore.value,
      feedback: feedbackText.value || undefined,
    })
    if (!res.ok) {
      toast.show(res.error || 'Failed to submit survey', 'error')
      return
    }
    localStorage.setItem(SURVEY_KEY, Date.now().toString())
    step.value = 'done'
    setTimeout(() => { visible.value = false; emit('complete') }, 2000)
  } catch (e: any) {
    toast.show(e.message || 'Network error', 'error')
  } finally { submitting.value = false }
}

function skip() {
  localStorage.setItem(SURVEY_KEY, Date.now().toString())
  visible.value = false
  emit('complete')
}

function npsLabel(score: number): string {
  if (score <= 6) return t('survey_detractor')
  if (score <= 8) return t('survey_passive')
  return t('survey_promoter')
}
</script>

<template>
  <div v-if="visible" class="survey-overlay" @click.self="skip">
    <div class="survey-card">
      <!-- Step 1: NPS Score -->
      <template v-if="step === 'nps'">
        <h3 class="survey-title">{{ t('survey_title') }}</h3>
        <p class="survey-desc">{{ t('survey_nps_question') }}</p>
        <div class="survey-nps">
          <button
            v-for="n in 11"
            :key="n - 1"
            class="nps-btn"
            :class="{ selected: npsScore === n - 1, detractor: n - 1 <= 6, passive: n - 1 >= 7 && n - 1 <= 8, promoter: n - 1 >= 9 }"
            @click="selectNps(n - 1)"
          >{{ n - 1 }}</button>
        </div>
        <div class="survey-nps-labels">
          <span>{{ t('survey_not_likely') }}</span>
          <span>{{ t('survey_very_likely') }}</span>
        </div>
      </template>

      <!-- Step 2: Optional Feedback -->
      <template v-else-if="step === 'feedback'">
        <h3 class="survey-title">{{ t('survey_thanks') }}</h3>
        <p class="survey-desc">{{ t('survey_feedback_hint') }}</p>
        <textarea
          v-model="feedbackText"
          class="survey-textarea"
          rows="3"
          :placeholder="t('survey_feedback_ph')"
          maxlength="500"
        ></textarea>
        <Button class="w-full" :disabled="submitting" @click="submitSurvey">
          {{ submitting ? '...' : t('survey_submit') }}
        </Button>
        <Button variant="ghost" class="w-full mt-2" @click="skip">{{ t('survey_skip') }}</Button>
      </template>

      <!-- Step 3: Done -->
      <template v-else>
        <div class="survey-done">
          <div class="survey-done-icon">{{ npsScore !== null && npsScore >= 9 ? '🎉' : '👍' }}</div>
          <h3 class="survey-title">{{ t('survey_done_title') }}</h3>
          <p class="survey-desc">{{ t('survey_done_desc') }}</p>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.survey-overlay {
  position: fixed; inset: 0; z-index: 10001;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-modal-overlay);
  animation: fadeIn .2s ease;
}
.survey-card {
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-xl); padding: 32px; max-width: 420px; width: 100%;
  box-shadow: var(--shadow-modal);
  animation: slideUp .3s cubic-bezier(.16,1,.3,1);
}
.survey-title { font-size: 16px; font-weight: 700; text-align: center; margin-bottom: 6px; color: var(--text-primary); }
.survey-desc { font-size: 13px; color: var(--text-secondary); text-align: center; margin-bottom: 20px; line-height: 1.5; }
.survey-nps { display: flex; gap: 4px; justify-content: center; margin-bottom: 8px; }
.nps-btn {
  width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border-default);
  background: var(--bg-surface); color: var(--text-secondary); cursor: pointer;
  font-size: 12px; font-weight: 600; transition: all .15s;
}
.nps-btn:hover { border-color: var(--accent); color: var(--text-primary); }
.nps-btn.selected { background: var(--accent); color: #fff; border-color: var(--accent); }
.nps-btn.detractor.selected { background: var(--danger); border-color: var(--danger); }
.nps-btn.passive.selected { background: var(--warning); border-color: var(--warning); }
.nps-btn.promoter.selected { background: var(--success); border-color: var(--success); }
.survey-nps-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-tertiary); }
.survey-textarea {
  width: 100%; padding: 10px; border: 1px solid var(--border-default); border-radius: var(--radius-md);
  font-size: 13px; resize: none; background: var(--bg-surface); color: var(--text-primary); font-family: inherit;
  margin-bottom: 16px;
}
.survey-textarea:focus { outline: none; border-color: var(--border-focus); }
.mt-2 { margin-top: 8px; }
.survey-done { text-align: center; }
.survey-done-icon { font-size: 32px; margin-bottom: 12px; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
</style>
