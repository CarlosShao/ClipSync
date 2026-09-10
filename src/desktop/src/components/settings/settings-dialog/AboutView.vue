<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getVersion } from '@tauri-apps/api/app'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import { api } from '@/api/client'
import * as tauri from '@/lib/tauri'
import { Github, ExternalLink, RefreshCw } from 'lucide-vue-next'

const { t } = useI18n()
const toast = useSonner()

// A7：版本号动态取自 tauri.conf.json 的 version，不再硬编码 '0.1.0'
const appVersion = ref('…')
const checkingUpdate = ref(false)
const installingUpdate = ref(false)
/** 有待安装的新版本 → 就地展示"发现新版本 vX + 立即安装/稍后"；forceUpdate=true 时不可跳过（无"稍后"） */
const pendingUpdate = ref<{ version: string; forceUpdate: boolean } | null>(null)
const lastChecked = ref('')

onMounted(async () => {
  try {
    appVersion.value = await getVersion()
  } catch {
    // 浏览器 dev 环境没有 Tauri 运行时
    appVersion.value = import.meta.env.DEV ? 'dev' : '—'
  }
})

function errMessage(e: unknown, fallbackKey: string): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  // Rust 侧约定标记（lib.rs check_for_updates），映射为本地化文案而非透传中文
  if (raw === 'UPDATER_NOT_CONFIGURED') return t('sg_update_not_configured')
  return raw || t(fallbackKey)
}

async function checkForUpdates() {
  if (checkingUpdate.value || installingUpdate.value) return
  checkingUpdate.value = true
  pendingUpdate.value = null
  try {
    const res = await tauri.checkForUpdates()
    lastChecked.value = new Date().toLocaleDateString()
    if (res?.hasUpdate && res.version) {
      // A7：有更新 → 先确认，用户点了"立即安装"才下载
      pendingUpdate.value = { version: res.version, forceUpdate: false }
      // AN-04：Rust check_for_updates 只回传 hasUpdate/version/notes/date，不透传 force_update；
      // 前端另查公开端点 /api/app/version 补齐强更标记。失败静默按普通更新处理，不阻塞更新流程。
      api<{ forceUpdate?: boolean }>('GET', '/api/app/version')
        .then((r) => {
          if (pendingUpdate.value && r.ok && r.data) {
            pendingUpdate.value.forceUpdate = !!r.data.forceUpdate
          }
        })
        .catch(() => {})
    } else {
      toast.show(t('sg_update_latest'), 'success')
    }
  } catch (e: unknown) {
    // A7：pubkey 未配置 / 网络失败都明确报错，绝不再谎报"已是最新版本"
    toast.show(errMessage(e, 'sg_update_fail'), 'error')
  } finally {
    checkingUpdate.value = false
  }
}

async function installUpdate() {
  if (installingUpdate.value) return
  installingUpdate.value = true
  toast.show(t('sg_update_installing'), 'info')
  try {
    await tauri.installUpdate()
    // 成功时 Rust 会直接 relaunch，不会走到下面
  } catch (e: unknown) {
    toast.show(errMessage(e, 'sg_update_fail'), 'error')
  } finally {
    installingUpdate.value = false
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
        <div class="about-version">{{ t('app_version', { v: appVersion }) }}</div>
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
        <span v-if="lastChecked" class="about-row-hint"
          >{{ t('sg_update_last') || '上次检查' }}: {{ lastChecked }}</span
        >
      </div>
      <Button
        variant="outline"
        size="sm"
        :disabled="checkingUpdate || installingUpdate"
        class="update-btn"
        @click="checkForUpdates"
      >
        <RefreshCw :size="14" :class="{ spin: checkingUpdate }" />
        {{ checkingUpdate ? t('sg_update_checking') : t('btn_check') }}
      </Button>
    </div>

    <!-- A7：发现新版本 → 就地确认；确认后才 download_and_install + relaunch。
         AN-04：force_update=true → 危险色强更条，不提供"稍后"（不可跳过） -->
    <div v-if="pendingUpdate" class="about-update" :class="{ 'about-update--force': pendingUpdate.forceUpdate }">
      <div class="about-update-text">
        {{ t('sg_update_found', { v: pendingUpdate.version }) }}
        <span v-if="pendingUpdate.forceUpdate" class="about-update-force-hint">{{
          t('sg_update_force_hint')
        }}</span>
      </div>
      <div class="about-update-actions">
        <Button size="sm" :disabled="installingUpdate" @click="installUpdate">{{ t('btn_install') }}</Button>
        <Button
          v-if="!pendingUpdate.forceUpdate"
          variant="outline"
          size="sm"
          :disabled="installingUpdate"
          @click="pendingUpdate = null"
          >{{ t('btn_later') }}</Button
        >
      </div>
    </div>

    <!-- Feedback row -->
    <div class="about-row">
      <a href="https://github.com/CarlosShao/ClipSync/issues" target="_blank" rel="noopener" class="about-link">
        {{ t('fb_title') || '发送反馈' }}
        <ExternalLink :size="12" class="link-ext" />
      </a>
    </div>
  </div>
</template>

<style scoped>
.about-view {
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* Hero */
.about-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-hover) 100%);
  margin-bottom: 8px;
}
.about-logo {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  /* Logo 品牌渐变：沿用主题的 logo-gradient token，避免明暗主题下对比度失控（C6②） */
  background: var(--logo-gradient);
  color: var(--accent-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.25);
}
.about-info {
  flex: 1;
  min-width: 0;
}
.about-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}
.about-version {
  font-size: 13px;
  color: var(--accent);
  font-weight: 500;
  margin-top: 2px;
}
.about-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  padding: 4px 0 16px;
}

/* Row */
.about-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 0;
  border-top: 1px solid var(--border-subtle);
}
.about-row--space {
  justify-content: space-between;
}
.about-row-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.about-row-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}
.about-row-hint {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* Link */
.about-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
  transition: opacity 0.15s;
}
.about-link:hover {
  opacity: 0.75;
}
.link-ext {
  opacity: 0.5;
}

/* Update button */
.update-btn {
  gap: 6px;
}

/* 发现新版本后的就地确认条 */
.about-update {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--accent-light);
}
.about-update-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
}
.about-update-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* AN-04：强制更新 → 危险色强更条（颜色一律走 token） */
.about-update--force {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}
.about-update--force .about-update-text {
  color: var(--danger);
}
.about-update-force-hint {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.spin {
  animation: spin 1s linear infinite;
}
</style>
