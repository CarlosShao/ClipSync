<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useClipboard } from '@/composables/useClipboard'
import {
  getSharedLinks,
  createSharedLink,
  deleteSharedLink,
  type SharedLink,
} from '@/api/client'
import { Link, Copy, Trash2, ChevronDown } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

const { t } = useI18n()
const toast = useSonner()
const { copyText } = useClipboard()

const links = ref<SharedLinkLike[]>([])
const loading = ref(false)
const addOpen = ref(false)
const content = ref('')
const title = ref('')
const expiresInHours = ref<number | ''>('')
const error = ref('')
const revokeId = ref<string | null>(null)

// 列表项结构（与后端 /api/shared-links 返回一致）
interface SharedLinkLike extends SharedLink {}

async function load() {
  loading.value = true
  try {
    const data = await getSharedLinks()
    links.value = data ?? []
  } catch (e: any) {
    console.warn('[SharedLinks] load failed', e)
    toast.show(t('shared_links_load_err'), 'error')
  } finally {
    loading.value = false
  }
}

async function createLink() {
  error.value = ''
  if (!content.value.trim()) {
    error.value = t('shared_links_content_required')
    return
  }
  try {
    const created = await createSharedLink({
      content: content.value,
      title: title.value.trim() || undefined,
      expiresInHours: expiresInHours.value === '' ? undefined : Number(expiresInHours.value),
    })
    if (created) {
      links.value = [created, ...links.value]
      content.value = ''
      title.value = ''
      expiresInHours.value = ''
      addOpen.value = false
      toast.show(t('shared_links_created'), 'success')
    } else {
      error.value = t('shared_links_create_err')
    }
  } catch (e: any) {
    console.warn('[SharedLinks] create failed', e)
    error.value = t('shared_links_create_err')
  }
}

async function copyLink(url: string) {
  const ok = await copyText(url)
  toast.show(ok ? t('shared_links_copied') : t('shared_links_copy_err'), ok ? 'success' : 'error')
}

function confirmRevoke(id: string) {
  revokeId.value = id
}

async function doRevoke() {
  if (!revokeId.value) return
  const id = revokeId.value
  revokeId.value = null
  const ok = await deleteSharedLink(id)
  if (ok) {
    links.value = links.value.filter((l) => l.id !== id)
    toast.show(t('shared_links_revoked'), 'success')
  } else {
    toast.show(t('shared_links_revoke_err'), 'error')
  }
}

function fmt(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

onMounted(load)
</script>

<template>
  <div class="settings-view">
    <h2 class="sv-title">{{ t('shared_links_t') }}</h2>

    <!-- 创建分享链接（可展开行，与“修改密码”卡片一致） -->
    <div class="sg-row" style="cursor: pointer" @click="addOpen = !addOpen">
      <div class="sg-label">
        <div class="sg-name">{{ t('shared_links_create') }}</div>
        <div class="sg-hint">{{ t('shared_links_create_h') }}</div>
      </div>
      <ChevronDown :size="18" :class="['sg-arrow', { 'sg-arrow--rotated': addOpen }]" />
    </div>

    <div v-if="addOpen" class="pwd-change-form">
      <div class="pwd-field">
        <label class="pwd-label">{{ t('shared_links_content') }}</label>
        <Textarea
          v-model="content"
          class="sg-input--block"
          :placeholder="t('shared_links_content_ph')"
          rows="4"
        />
      </div>
      <div class="pwd-field">
        <label class="pwd-label">{{ t('shared_links_title') }}</label>
        <Input v-model="title" class="sg-input--block" :placeholder="t('shared_links_title_ph')" />
      </div>
      <div class="pwd-field">
        <label class="pwd-label">{{ t('shared_links_expire') }}</label>
        <Input
          v-model="expiresInHours"
          type="number"
          min="1"
          class="sg-input--block"
          :placeholder="t('shared_links_expire_ph')"
        />
      </div>
      <div v-if="error" class="pwd-error">{{ error }}</div>
      <div class="pwd-actions">
        <Button size="default" class="px-6 min-w-[100px] rounded-md" @click="createLink">
          {{ t('shared_links_create_btn') }}
        </Button>
        <Button
          size="default"
          variant="outline"
          class="px-6 min-w-[100px] rounded-md"
          @click="addOpen = false"
        >
          {{ t('shared_links_cancel') }}
        </Button>
      </div>
    </div>

    <!-- 列表 -->
    <div v-if="loading" class="empty-state">
      <div class="empty-text">{{ t('shared_links_loading') }}</div>
    </div>
    <div v-else-if="links.length === 0" class="empty-state">
      <div class="empty-icon">🔗</div>
      <div class="empty-text">{{ t('shared_links_empty') }}</div>
    </div>
    <div v-else class="links-list">
      <div v-for="link in links" :key="link.id" class="link-card">
        <div class="link-icon">
          <Link :size="20" />
        </div>
        <div class="link-info">
          <div class="link-title">{{ link.title }}</div>
          <div class="link-url">{{ link.url }}</div>
        </div>
        <div class="link-meta">
          <div class="link-views">{{ link.views }} {{ t('shared_links_views') }}</div>
          <div class="link-date">{{ fmt(link.createdAt) }}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          class="link-copy"
          :title="t('shared_links_copy')"
          @click="copyLink(link.url)"
        >
          <Copy :size="14" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          class="link-revoke"
          :title="t('shared_links_revoke')"
          @click="confirmRevoke(link.id)"
        >
          <Trash2 :size="14" />
        </Button>
      </div>
    </div>

    <ConfirmDialog
      :open="revokeId !== null"
      :title="t('shared_links_revoke_title')"
      :message="t('shared_links_revoke_msg')"
      :confirm-text="t('shared_links_revoke')"
      :cancel-text="t('shared_links_cancel')"
      @confirm="doRevoke"
      @cancel="revokeId = null"
    />
  </div>
</template>

<style scoped>
.settings-view { padding: 24px; max-width: 720px; overflow-y: auto; flex: 1; }
.sv-title { font-size: 22px; font-weight: 700; margin-bottom: 24px; }

/* 系统设置分组/行样式（与 SettingsView 一致） */
.sg-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: var(--radius-md); gap: 16px; margin-bottom: 8px; }
.sg-row:hover { background: var(--bg-hover); }
.sg-label { flex: 1; min-width: 0; }
.sg-name { font-size: 14px; font-weight: 500; }
.sg-hint { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
.sg-arrow { width: 16px; height: 16px; color: var(--text-tertiary); flex-shrink: 0; transition: transform 0.15s; }
.sg-arrow--rotated { transform: rotate(180deg); }

.pwd-change-form {
  margin: 4px 0 16px;
  padding: 20px 24px !important;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
.pwd-field { margin-bottom: 14px; padding-left: 4px; }
.pwd-label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; padding-left: 4px; }
.sg-input--block { width: 100%; padding-left: 16px !important; }
.pwd-actions { display: flex; gap: 10px; margin-top: 12px; padding-left: 4px; }
.pwd-error { color: var(--danger, #ef4444); font-size: 12px; margin-top: 6px; }

.links-list { display: flex; flex-direction: column; gap: 12px; }
.link-card { display: flex; align-items: center; gap: 16px; padding: 16px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); transition: all 0.15s; }
.link-card:hover { border-color: var(--accent); box-shadow: var(--shadow-elevated); }
.link-icon { width: 40px; height: 40px; border-radius: var(--radius-sm); background: var(--info-bg); display: flex; align-items: center; justify-content: center; color: var(--info); flex-shrink: 0; }
.link-info { flex: 1; min-width: 0; }
.link-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-url { font-size: 12px; color: var(--text-secondary); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-meta { text-align: right; flex-shrink: 0; }
.link-views { font-size: 12px; color: var(--text-tertiary); }
.link-date { font-size: 11px; color: var(--text-tertiary); }
.link-copy, .link-revoke { background: none; border: none; cursor: pointer; color: var(--text-tertiary); padding: 8px; border-radius: var(--radius-sm); transition: all 150ms; flex-shrink: 0; }
.link-copy:hover { color: var(--accent); background: var(--accent-light); }
.link-revoke:hover { color: var(--danger, #ef4444); background: var(--danger-light, rgba(239, 68, 68, 0.1)); }
.empty-state { text-align: center; padding: 40px 0; }
.empty-icon { font-size: 32px; margin-bottom: 8px; }
.empty-text { font-size: 13px; color: var(--text-secondary); }
</style>
