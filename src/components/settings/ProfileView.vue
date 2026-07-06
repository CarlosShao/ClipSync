<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'

const { t } = useI18n()
const configStore = useConfigStore()
</script>

<template>
  <div class="profile-card">
    <div class="profile-avatar">{{ configStore.user.name?.slice(0, 2) || 'CS' }}</div>
    <div class="profile-details">
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">{{ t('pf_name') }}</div></div>
        <div class="sg-control">{{ configStore.user.name || t('pf_noset') }}</div>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">{{ t('pf_phone') }}</div></div>
        <div class="sg-control">{{ configStore.config.device_id || t('pf_noset') }}</div>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;">{{ t('pf_plan') }}</div></div>
        <div class="sg-control">{{ t(configStore.user.plan === 'Pro' ? 'role_pro' : 'pf_free') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile-card { display: flex; gap: 24px; padding: 24px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); }
.profile-avatar { width: 64px; height: 64px; border-radius: 50%; background: var(--accent); color: var(--text-inverse); display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700; flex-shrink: 0; }
.profile-details { flex: 1; }
</style>
