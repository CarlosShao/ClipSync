<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useNotifications, type NotifCategory } from '@/composables/useNotifications'
import { Bell, Gift, Download, Smartphone, ShieldAlert, CheckCheck } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'

const { t } = useI18n()
const { notifications, unreadCount, loadHistory, markRead, markAllRead } = useNotifications()

type CatKey = NotifCategory
const activeFilter = computed<{ value: string; labelKey: string }[]>(() => [
  { value: 'all', labelKey: 'notif_filter_all' },
  { value: 'unread', labelKey: 'notif_filter_unread' },
  { value: 'subscription', labelKey: 'notif_filter_sub' },
  { value: 'update', labelKey: 'notif_filter_update' },
  { value: 'device', labelKey: 'notif_filter_device' },
  { value: 'security', labelKey: 'notif_filter_security' },
])
import { ref } from 'vue'
const currentFilter = ref<string>('all')

onMounted(() => { loadHistory() })

const filtered = computed(() => {
  if (currentFilter.value === 'all') return notifications.value
  if (currentFilter.value === 'unread') return notifications.value.filter((n) => !n.read)
  return notifications.value.filter((n) => n.category === currentFilter.value)
})

const catMeta: Record<CatKey, { icon: any; color: string; labelKey: string }> = {
  subscription: { icon: Gift,        color: 'var(--accent)',  labelKey: 'notif_cat_subscription' },
  update:       { icon: Download,    color: 'var(--info)',    labelKey: 'notif_cat_update' },
  device:       { icon: Smartphone,  color: 'var(--success)', labelKey: 'notif_cat_device' },
  security:     { icon: ShieldAlert, color: 'var(--danger)',  labelKey: 'notif_cat_security' },
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return Math.floor(diff / 86400000) + t('d_ago')
}
</script>

<template>
  <div class="notif-page">
    <!-- Header -->
    <div class="notif-header">
      <div class="notif-title-wrap">
        <h2 class="notif-title">{{ t('notif_title') }}</h2>
        <Badge v-if="unreadCount > 0" variant="destructive" class="notif-unread-badge">
          {{ unreadCount }} {{ t('notif_unread').replace('{n}', '').trim() }}
        </Badge>
      </div>
      <Button v-if="unreadCount > 0" variant="outline" size="sm" @click="markAllRead">
        <CheckCheck :size="14" />
        <span>{{ t('notif_mark_all') }}</span>
      </Button>
    </div>

    <!-- Filter segmented control -->
    <div class="notif-filters">
      <button
        v-for="f in activeFilter"
        :key="f.value"
        class="notif-filter-btn"
        :class="{ active: currentFilter === f.value }"
        @click="currentFilter = f.value"
      >{{ t(f.labelKey) }}</button>
    </div>

    <!-- List -->
    <div class="notif-list">
      <div v-if="filtered.length > 0" class="notif-items">
        <div
          v-for="n in filtered"
          :key="n.id"
          class="notif-item"
          :class="{ unread: !n.read }"
          @click="markRead(n.id)"
        >
          <div
            class="notif-icon"
            :style="{ color: catMeta[n.category].color, background: catMeta[n.category].color + '1f' }"
          >
            <component :is="catMeta[n.category].icon" :size="18" />
          </div>
          <div class="notif-body">
            <div class="notif-item-head">
              <span class="notif-cat">{{ t(catMeta[n.category].labelKey) }}</span>
              <span class="notif-time">{{ timeAgo(n.time) }}</span>
            </div>
            <div class="notif-item-title">{{ n.title }}</div>
            <div class="notif-item-desc">{{ n.body }}</div>
          </div>
          <div v-if="!n.read" class="notif-dot" />
        </div>
      </div>

      <div v-else class="notif-empty">
        <div class="notif-empty-icon"><Bell :size="40" /></div>
        <h3 class="notif-empty-title">{{ t('notif_empty_title') }}</h3>
        <p class="notif-empty-desc">{{ t('notif_empty_desc') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notif-page { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

/* Header */
.notif-header {
  display: flex; align-items: center; justify-content: space-between;
  height: 56px; padding: 0 24px; background: var(--bg-surface); flex-shrink: 0;
}
.notif-title-wrap { display: flex; align-items: center; gap: 10px; }
.notif-title { font-weight: 600; font-size: 16px; letter-spacing: -0.01em; }
.notif-unread-badge { font-size: 11px; font-weight: 600; }

/* Filter segmented control (matches clipboard filter-row style) */
.notif-filters {
  display: flex; align-items: center; gap: 12px; padding: 12px 24px; flex-shrink: 0;
  overflow-x: auto;
}
.notif-filter-btn {
  font-size: 13px; font-weight: 500; color: var(--text-secondary);
  background: var(--bg-hover); border: none; border-radius: var(--radius-md);
  padding: 5px 14px; cursor: pointer; transition: all 0.15s ease; white-space: nowrap;
  line-height: 1.4;
}
.notif-filter-btn:hover { color: var(--text-primary); background: var(--bg-active); }
.notif-filter-btn.active {
  background: var(--bg-surface); color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); font-weight: 600;
}

/* List */
.notif-list { flex: 1; overflow-y: auto; padding: 4px 24px 24px; }
.notif-items { display: flex; flex-direction: column; gap: 8px; }

.notif-item {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 14px; border-radius: var(--radius-lg);
  background: var(--bg-surface); border: 1px solid var(--border-subtle);
  cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease;
  position: relative;
}
.notif-item:hover { background: var(--bg-hover); border-color: var(--border-default); }
.notif-item.unread { border-color: color-mix(in srgb, var(--accent) 35%, var(--border-subtle)); }

.notif-icon {
  width: 36px; height: 36px; border-radius: var(--radius-md);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.notif-body { flex: 1; min-width: 0; }
.notif-item-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 3px;
}
.notif-cat {
  font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase;
  color: var(--text-tertiary);
}
.notif-time { font-size: 11px; color: var(--text-tertiary); }
.notif-item-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
.notif-item-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.notif-dot {
  width: 8px; height: 8px; border-radius: 9999px; background: var(--accent);
  flex-shrink: 0; margin-top: 6px;
}

/* Empty state */
.notif-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 80px 20px; text-align: center;
}
.notif-empty-icon {
  width: 64px; height: 64px; border-radius: 16px; background: var(--bg-hover);
  display: flex; align-items: center; justify-content: center; margin-bottom: 16px;
  color: var(--text-tertiary); opacity: 0.6;
}
.notif-empty-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; color: var(--text-primary); }
.notif-empty-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
</style>
