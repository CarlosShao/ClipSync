<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import { Link, Copy } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'

const { t } = useI18n()
const toast = useToast()

interface SharedLink {
  id: string
  title: string
  url: string
  views: number
  createdAt: string
}

const links = ref<SharedLink[]>([
  { id: '1', title: 'Project Alpha - Design Specs', url: 'https://clipsync.io/s/xK9mP2qL', views: 127, createdAt: '2d ago' },
  { id: '2', title: 'Meeting Notes - Q3 Planning', url: 'https://clipsync.io/s/aB3nR7wK', views: 43, createdAt: '5d ago' },
  { id: '3', title: 'API Documentation', url: 'https://clipsync.io/s/pQ9xL2mN', views: 89, createdAt: '1w ago' },
])

function copyLink(url: string) {
  navigator.clipboard.writeText(url)
  toast.show(t('copied'), 'success')
}
</script>

<template>
  <div class="settings-view">
    <h2 class="sv-title">{{ t('shared_links_t') }}</h2>
    <div class="links-list">
      <div v-for="link in links" :key="link.id" class="link-card">
        <div class="link-icon">
          <Link :size="20" />
        </div>
        <div class="link-info">
          <div class="link-title">{{ link.title }}</div>
          <div class="link-url">{{ link.url }}</div>
        </div>
        <div class="link-meta">
          <div class="link-views">{{ link.views }} views</div>
          <div class="link-date">Created {{ link.createdAt }}</div>
        </div>
        <Button variant="ghost" size="icon-sm" class="link-copy" @click="copyLink(link.url)">
          <Copy :size="14" />
        </Button>
      </div>
    </div>
    <div v-if="links.length === 0" class="empty-state">
      <div class="empty-icon">🔗</div>
      <div class="empty-text">{{ t('shared_links_t') }} — No links created yet.</div>
    </div>
  </div>
</template>

<style scoped>
.settings-view { padding: 24px; max-width: 720px; overflow-y: auto; flex: 1; }
.sv-title { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
.links-list { display: flex; flex-direction: column; gap: 12px; }
.link-card { display: flex; align-items: center; gap: 16px; padding: 16px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); transition: all 0.15s; }
.link-card:hover { border-color: var(--accent); box-shadow: var(--shadow-elevated); }
.link-icon { width: 40px; height: 40px; border-radius: var(--radius-sm); background: var(--info-bg); display: flex; align-items: center; justify-content: center; color: var(--info); flex-shrink: 0; }
.link-info { flex: 1; min-width: 0; }
.link-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
.link-url { font-size: 12px; color: var(--text-secondary); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-meta { text-align: right; flex-shrink: 0; }
.link-views { font-size: 12px; color: var(--text-tertiary); }
.link-date { font-size: 11px; color: var(--text-tertiary); }
.link-copy { background: none; border: none; cursor: pointer; color: var(--text-tertiary); padding: 8px; border-radius: var(--radius-sm); transition: all 150ms; flex-shrink: 0; }
.link-copy:hover { color: var(--accent); background: var(--accent-light); }
.empty-state { text-align: center; padding: 40px 0; }
.empty-icon { font-size: 32px; margin-bottom: 8px; }
.empty-text { font-size: 13px; color: var(--text-secondary); }
</style>
