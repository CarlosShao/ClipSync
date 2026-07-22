<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import { Github, ExternalLink, RefreshCw } from 'lucide-vue-next'

const { t } = useI18n()
const toast = useSonner()
const appVersion = '0.1.0'
const checkingUpdate = ref(false)
const lastChecked = ref('')

async function checkForUpdates() {
  checkingUpdate.value = true
  try {
    await new Promise(r => setTimeout(r, 1500))
    toast.show(t('sg_update_latest') || '当前已是最新版本', 'success')
    lastChecked.value = new Date().toLocaleDateString()
  } catch {
    toast.show(t('sg_update_fail') || '检查更新失败', 'error')
  } finally {
    checkingUpdate.value = false
  }
}
</script>

<template>
  <div class="about-view">
    <!-- Hero card -->
    <div class="about-hero">
      <div class="about-logo">C</div>
      <div class="about-info">
        <div class="about-name">{{ t('app_name') }}</div>
        <div class="about-version">{{ t('app_version').replace('{v}', appVersion) }}</div>
      </div>
    </div>

    <div class="about-desc">{{ t('app_desc') }}</div>

    <!-- Links row -->
    <div class="about-row">
      <a href="https://github.com/CarlosShao/ClipSync" target="_blank" rel="noopener" class="about-link">
        <Github :size="16" />
        <span>{{ t('app_github') }}</span>
        <ExternalLink :size="12" class="link-ext" />
      </a>
    </div>

    <!-- Update row -->
    <div class="about-row about-row--space">
      <div class="about-row-left">
        <span class="about-row-label">{{ t('sg_update') || '检查更新' }}</span>
        <span v-if="lastChecked" class="about-row-hint">{{ t('sg_update_last') || '上次检查' }}: {{ lastChecked }}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        :disabled="checkingUpdate"
        class="update-btn"
        @click="checkForUpdates"
      >
        <RefreshCw :size="14" :class="{ 'spin': checkingUpdate }" />
        {{ checkingUpdate ? (t('sg_update_checking') || '检查中...') : (t('btn_check') || '立即检查') }}
      </Button>
    </div>

    <!-- Feedback row -->
    <div class="about-row">
      <a
        href="https://github.com/CarlosShao/ClipSync/issues"
        target="_blank"
        rel="noopener"
        class="about-link"
      >
        {{ t('fb_title') || '发送反馈' }}
        <ExternalLink :size="12" class="link-ext" />
      </a>
    </div>
  </div>
</template>

<style scoped>
.about-view { display: flex; flex-direction: column; gap: 0; }

/* Hero */
.about-hero {
  display: flex; align-items: center; gap: 16px;
  padding: 20px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-hover) 100%);
  margin-bottom: 8px;
}
.about-logo {
  width: 52px; height: 52px;
  border-radius: 14px;
  background: linear-gradient(135deg, #6366F1 0%, #A78BFA 100%);
  color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; font-weight: 700;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(99,102,241,.25);
}
.about-info { flex: 1; min-width: 0; }
.about-name { font-size: 18px; font-weight: 700; color: var(--text-primary); }
.about-version { font-size: 13px; color: var(--accent); font-weight: 500; margin-top: 2px; }
.about-desc {
  font-size: 13px; color: var(--text-secondary);
  line-height: 1.6;
  padding: 4px 0 16px;
}

/* Row */
.about-row {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 0;
  border-top: 1px solid var(--border-subtle);
}
.about-row--space { justify-content: space-between; }
.about-row-left { display: flex; flex-direction: column; gap: 2px; }
.about-row-label { font-size: 14px; font-weight: 500; color: var(--text-primary); }
.about-row-hint { font-size: 12px; color: var(--text-tertiary); }

/* Link */
.about-link {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 14px; font-weight: 500;
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
  transition: opacity .15s;
}
.about-link:hover { opacity: .75; }
.link-ext { opacity: 0.5; }

/* Update button */
.update-btn { gap: 6px; }

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.spin { animation: spin 1s linear infinite; }
</style>
