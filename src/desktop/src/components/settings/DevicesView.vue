<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useDevice } from '@/composables/useDevice'
import { useSonner } from '@/composables/useSonner'
import { Monitor, Smartphone, Globe, Trash2, QrCode, Plus, AlertTriangle, RefreshCw, ShieldCheck, ArrowDown, ArrowUp, Sparkles } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import { useSyncLog } from '@/composables/useSyncLog'

const { t, tf } = useI18n()
const device = useDevice()
const toast = useSonner()
const props = defineProps<{ aiEnabled?: boolean }>()
const emit = defineEmits<{ 'open-modal': [type: string] }>()
const deviceList = computed(() => device.devices.value)
const isLoading = computed(() => device.loading.value)
const loadError = computed(() => device.error.value)
const onlineCount = computed(() => deviceList.value.filter((d) => d.online).length)
const syncLog = useSyncLog()
function logAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('just_now')
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + t('m_ago')
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + t('h_ago')
  return Math.floor(diff / 86_400_000) + t('d_ago')
}

function retryLoad() {
  device.loadDevices()
}

// 自愈：进入页面时单例列表为空就主动拉一次（此前只依赖外部触发，会一直停在空态）
onMounted(() => {
  if (deviceList.value.length === 0 && !isLoading.value) void device.loadDevices()
})

// AI 诊断同步：设备在线情况 + 本机最近同步流水（真实数据）交给 AI 判断链路健康度
function askAi(prompt: string) {
  window.dispatchEvent(new CustomEvent('clipsync:toggle-ai'))
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('clipsync:ai-send-message', { detail: { content: prompt } }))
  }, 120)
}
function aiDiagnose() {
  const devs =
    deviceList.value.map((d) => `${d.name}（${d.online ? t('dev_online') : t('dev_offline')}）`).join('、') ||
    t('dev_empty')
  const lines =
    syncLog.events.value
      .slice(0, 10)
      .map((e) => `${e.dir === 'down' ? '↓' : '↑'} ${e.kind}${e.size ? ' · ' + e.size : ''} · ${e.source} · ${logAgo(e.ts)}`)
      .join('\n') || t('dev_synclog_empty', '暂无同步记录')
  askAi(
    `${tf('dev_ai_diagnose', 'AI 诊断同步')}：已配对 ${deviceList.value.length} 台设备：${devs}；端到端加密已开启。本机最近同步流水：\n${lines}\n请判断当前同步链路是否健康（设备在线情况、最近收发是否正常、有无长期未同步的迹象），给出排查与改进建议。`,
  )
}

function getDeviceIcon(type: string) {
  switch (type) {
    case 'mobile':
      return Smartphone
    case 'browser':
      return Globe
    default:
      return Monitor
  }
}

async function handleDelete(id: string, name: string) {
  if (!confirm(t('confirm_msg') + ` (${name})`)) return
  const res = await device.removeDevice(id)
  if (res.ok) {
    toast.show(t('deleted'), 'success')
  } else {
    toast.show(t('del_fail') + (res.error || ''), 'error')
  }
}
</script>

<template>
  <!-- v2 原型（devices.html）：页头 + 统计面板 + 本机/已配对设备行 -->
  <div class="dev-page">
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-eyebrow">Device Mesh</div>
          <div class="page-title page-title--big">{{ t('nav_devices') }}</div>
          <div class="page-sub">{{ tf('page_sub_dev', '局域网端到端加密同步 · 配对即信任') }}</div>
        </div>
        <div class="page-acts">
          <button v-if="props.aiEnabled" type="button" class="pl-btn" @click="aiDiagnose">
            <Sparkles :size="14" /><span>{{ tf('dev_ai_diagnose', 'AI 诊断同步') }}</span>
          </button>
          <button type="button" class="pl-btn" @click="emit('open-modal', 'pair-scan')">
            <QrCode :size="14" /><span>{{ t('pair_scan') }}</span>
          </button>
          <button type="button" class="pl-btn pl-btn--acc" @click="emit('open-modal', 'pair-generate')">
            <Plus :size="14" /><span>{{ t('pair_generate') }}</span>
          </button>
        </div>
      </div>

      <!-- 统计面板（仅真实数据：在线数 / 总数 / 端到端加密） -->
      <div class="panel dev-stats">
        <div class="stat">
          <span class="k">{{ t('dev_stat_online', '在线设备') }}</span>
          <span class="v">{{ onlineCount }}</span>
          <span class="d">{{ t('dev_stat_online_d', '心跳正常') }}</span>
        </div>
        <div class="stat dev-stat-sep">
          <span class="k">{{ t('dev_stat_total', '总设备') }}</span>
          <span class="v">{{ deviceList.length }}</span>
          <span class="d">{{ t('dev_stat_total_d', '含离线设备') }}</span>
        </div>
        <div class="stat dev-stat-sep">
          <span class="k">{{ t('dev_stat_e2e', '端到端加密') }}</span>
          <span class="v dev-stat-text">{{ t('dev_stat_e2e_on', '已开启') }}</span>
          <span class="d">{{ t('dev_stat_e2e_d', '密钥不出设备') }}</span>
        </div>
      </div>

      <!-- 已配对设备 -->
      <div class="panel dev-list-panel">
        <div class="panel-head">
          <span class="panel-title">{{ t('dev_paired', '已配对设备') }}</span>
          <span class="dev-count-hint">{{ deviceList.length }} {{ t('dev_count_unit', '台') }}</span>
        </div>
        <div class="panel-body dev-list-body">
          <!-- Skeleton Loading -->
          <template v-if="isLoading && deviceList.length === 0">
            <div v-for="n in 3" :key="'sk-' + n" class="clip-item dev-row dev-row-skeleton">
              <div class="sk sk-icon" />
              <div class="clip-body">
                <div class="sk sk-name" />
                <div class="sk sk-detail" />
              </div>
            </div>
          </template>
          <!-- 加载失败：与"确实没有设备"区分开，并提供重试入口 -->
          <div v-else-if="loadError" class="empty-state">
            <div class="empty-icon error-icon"><AlertTriangle :size="32" /></div>
            <div class="empty-title">{{ t('load_failed_title') }}</div>
            <div class="empty-desc">{{ t('load_failed_desc') }}</div>
            <Button variant="outline" size="sm" class="dev-retry-btn" :disabled="isLoading" @click="retryLoad">
              <RefreshCw :size="14" />
              <span>{{ t('retry_btn') }}</span>
            </Button>
          </div>
          <div v-else-if="deviceList.length === 0" class="pl-empty">
            <Smartphone :size="30" />
            <div class="t">{{ t('dev_empty') }}</div>
            <div class="d">{{ t('dev_empty_hint') }}</div>
            <Button variant="outline" size="sm" class="dev-retry-btn" :disabled="isLoading" @click="retryLoad">
              <RefreshCw :size="14" />
              <span>{{ t('retry_btn') }}</span>
            </Button>
          </div>
          <template v-else>
            <div v-for="d in deviceList" :key="d.id" class="clip-item dev-row">
              <div class="type-tile t-text">
                <component :is="getDeviceIcon(d.type)" :size="16" />
              </div>
              <div class="clip-body">
                <div class="dev-name">{{ d.name }}</div>
                <div class="clip-meta">
                  <span>{{ d.location || t('dev_desktop') }}</span>
                  <span class="mono">{{ d.online ? t('dev_online') : t('dev_offline') }}</span>
                </div>
              </div>
              <span class="badge" :class="d.online ? 'b-ok' : 'b-gray'">
                {{ d.online ? t('dev_online') : t('dev_offline') }}
              </span>
              <button type="button" class="pl-icon-btn dev-del" :title="t('delete_btn')" @click="handleDelete(d.id, d.name)">
                <Trash2 :size="14" />
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- 原型 v1：同步日志（最近 N 条 · 仅本机可见） -->
      <div class="panel dev-synclog">
        <div class="panel-head">
          <span class="panel-title">{{ t('dev_synclog_title', '同步日志') }}</span>
          <span class="dev-count-hint">{{ tf('dev_synclog_hint', '最近 {n} 条 · 仅本机可见', { n: syncLog.events.value.length }) }}</span>
        </div>
        <div class="panel-body">
          <div v-if="syncLog.events.value.length === 0" class="dev-synclog-empty">{{ t('dev_synclog_empty', '暂无同步记录，复制内容后这里会显示收发流水') }}</div>
          <div v-for="(e, i) in syncLog.events.value" :key="e.ts + '-' + i" class="dev-synclog-row">
            <component :is="e.dir === 'down' ? ArrowDown : ArrowUp" :size="13" :class="e.dir === 'down' ? 'down' : 'up'" />
            <span class="dev-synclog-kind">{{ e.kind }}</span>
            <span v-if="e.size" class="dev-synclog-size">{{ e.size }}</span>
            <span class="dev-synclog-src">{{ e.source }}</span>
            <span class="dev-synclog-time">{{ logAgo(e.ts) }}</span>
          </div>
        </div>
      </div>

      <!-- 端到端加密说明条 -->
      <div class="dev-e2e-hint">
        <ShieldCheck :size="14" />
        <span>{{ tf('dev_e2e_hint', '剪贴内容在设备间端到端加密传输，服务端不可读。') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dev-page {
  height: 100%;
  overflow-y: auto;
}
.dev-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin-bottom: 16px;
}
.dev-stat-sep {
  border-left: 1px solid var(--border-subtle);
}
.dev-stat-text {
  font-size: 15px;
}
.dev-list-panel {
  margin-bottom: 14px;
}
.dev-count-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-tertiary);
}
.dev-list-body {
  padding: 10px 12px;
}
.dev-row {
  cursor: default;
  align-items: center;
  margin-bottom: 6px;
}
.dev-row:last-child {
  margin-bottom: 0;
}
.dev-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
}
.dev-del {
  opacity: 0;
}
.dev-row:hover .dev-del {
  opacity: 1;
}
.dev-del:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
}
.dev-e2e-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  background: var(--accent-light);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--accent);
}
.dev-e2e-hint svg {
  flex: none;
}

.empty-state {
  text-align: center;
  padding: 40px 0;
}
.empty-icon {
  color: var(--text-tertiary);
  margin-bottom: 12px;
  display: flex;
  justify-content: center;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.empty-desc {
  font-size: 13px;
  color: var(--text-secondary);
}
.error-icon {
  color: var(--danger) !important;
}
.dev-retry-btn {
  margin-top: 12px;
  gap: 6px !important;
}

/* Skeleton Loading */
.dev-row-skeleton {
  pointer-events: none;
}
.sk {
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  animation: sk-pulse 1.5s ease-in-out infinite;
}
.sk-icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  flex: none;
}
.sk-name {
  width: 100px;
  height: 14px;
  margin-bottom: 6px;
}
.sk-detail {
  width: 140px;
  height: 12px;
}
@keyframes sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
/* 原型 v1：同步日志面板 */
.dev-synclog .panel-body {
  display: flex;
  flex-direction: column;
}
.dev-synclog-empty {
  padding: 18px 0;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 12px;
}
.dev-synclog-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12.5px;
}
.dev-synclog-row:last-child {
  border-bottom: none;
}
.dev-synclog-row svg.down {
  color: var(--success, #2e9e6b);
}
.dev-synclog-row svg.up {
  color: var(--accent);
}
.dev-synclog-kind {
  color: var(--text-primary);
}
.dev-synclog-size {
  color: var(--text-tertiary);
  font-family: var(--font-content);
  font-size: 11px;
}
.dev-synclog-src {
  margin-left: auto;
  color: var(--text-secondary);
}
.dev-synclog-time {
  color: var(--text-tertiary);
  font-size: 11px;
  flex: none;
}
</style>