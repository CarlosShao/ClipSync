<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getVersion } from '@tauri-apps/api/app'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import { api } from '@/api/client'
import * as tauri from '@/lib/tauri'
import { Github, ExternalLink, RefreshCw, MessageSquare } from 'lucide-vue-next'

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
    <!-- 重排版：一张连体卡片（品牌行 + 行式条目），与其它设置分节同一套卡片语言 -->
    <div class="about-card">
      <!-- 品牌行 -->
      <div class="about-brand">
        <div class="about-logo">C</div>
        <div class="about-info">
          <div class="about-name-row">
            <span class="about-name">{{ t('app_name') }}</span>
            <span class="about-ver">v{{ appVersion }}</span>
          </div>
          <div class="about-desc">{{ t('app_desc') }}</div>
        </div>
      </div>

      <!-- 检查更新行 -->
      <div class="about-line">
        <div class="about-line-label">
          {{ t('sg_update') || '检查更新' }}
          <span v-if="lastChecked" class="about-line-hint"
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

      <!-- 开源仓库行 -->
      <a class="about-line about-line--link" href="https://github.com/CarlosShao/ClipSync" target="_blank" rel="noopener">
        <span class="about-line-label"><Github :size="14" />{{ t('app_github') }}</span>
        <ExternalLink :size="12" class="link-ext" />
      </a>

      <!-- 问题反馈行 -->
      <a class="about-line about-line--link" href="https://github.com/CarlosShao/ClipSync/issues" target="_blank" rel="noopener">
        <span class="about-line-label"><MessageSquare :size="14" />{{ t('fb_title') || '发送反馈' }}</span>
        <ExternalLink :size="12" class="link-ext" />
      </a>
    </div>
  </div>
</template>

<style scoped>
/* 连体卡片：与设置页其它分节同语言（surface 底 + 细分隔线行） */
.about-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  padding: 4px 14px;
}

/* 品牌行 */
.about-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 0 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.about-logo {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--logo-gradient);
  color: var(--accent-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  flex: none;
}
.about-info {
  flex: 1;
  min-width: 0;
}
.about-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.about-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}
.about-ver {
  font-family: var(--font-content);
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 1px 8px;
}
.about-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-top: 3px;
}

/* 行式条目 */
.about-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.about-line:last-child {
  border-bottom: none;
}
.about-line-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  min-width: 0;
}
.about-line-label svg {
  color: var(--text-tertiary);
  flex: none;
}
.about-line-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-tertiary);
  margin-left: 6px;
}
.about-line--link {
  text-decoration: none;
  cursor: pointer;
}
.about-line--link:hover .about-line-label {
  color: var(--accent);
}
.about-line--link:hover .about-line-label svg {
  color: var(--accent);
}
.link-ext {
  opacity: 0.45;
  flex: none;
}

/* 检查更新按钮 */
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
  margin: 10px 0;
  padding: 10px 12px;
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
