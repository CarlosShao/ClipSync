<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChat } from '@/composables/useAiChat'
import { useUser } from '@/composables/useUser'
import { useResizablePanel } from '@/composables/useResizablePanel'
import Button from '@/components/ui/button/Button.vue'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import AiMessageList from './AiMessageList.vue'
import AiChatInput from './AiChatInput.vue'
import AiConversationList from './AiConversationList.vue'
import AiMemoryPanel from './AiMemoryPanel.vue'
import AiCompressProgress from './AiCompressProgress.vue'
import {
  X,
  Bot,
  Plus,
  MessageSquare,
  Workflow,
  History,
  Brain,
  ShieldCheck,
  UserCog,
  User,
  CopyCheck,
  Package,
} from 'lucide-vue-next'

const props = defineProps<{
  open: boolean
  /** 当前页面/视图上下文（#229）：由 HomeView 传入 currentSub，注入 AI 请求让模型感知用户所在页面 */
  view?: string
}>()
const emit = defineEmits<{ close: []; 'open-settings': [] }>()
const { t, currentLang } = useI18n()

const {
  providers,
  selectedProviderId,
  selectedModel,
  settings,
  persistSettings,
  messages,
  isStreaming,
  error,
  contextUsage,
  duplicateImageNotice,
  compressProgress,
  hasProviders,
  canSend,
  providerSupportsCache,
  manualCompact,
  memoryEnabled,
  setMemoryEnabled,
  init,
  loadProviders,
  selectProvider,
  selectModel,
  send,
  stop,
  clear,
  conversations,
  currentConversationId,
  currentConversation,
  loadConversations,
  newConversation,
  loadConversation,
  renameConversation,
  deleteConversation,
  // 注意：resume（继续生成）按钮已按用户要求移除，用户可自行输入“继续”。
} = useAiChat()

// 记忆面板展开状态
const showMemory = ref(false)

// 模式：ask 或 agent（localStorage 作瞬时回退，DB 加载后由 settings 覆盖）
const mode = ref<'ask' | 'agent'>((localStorage.getItem('ai-mode') as 'ask' | 'agent') || 'ask')

// 思考模式（localStorage 瞬时回退，DB 为准）
const thinkingEnabled = ref(localStorage.getItem('ai-thinking-enabled') === 'true')
const thinkingStrength = ref<'low' | 'medium' | 'high'>(
  (localStorage.getItem('ai-thinking-strength') as 'low' | 'medium' | 'high') || 'medium',
)

// DB 偏好加载后：以 DB 为准覆盖本地（仅一次）
let settingsApplied = false
watch(
  settings,
  (s) => {
    if (s && !settingsApplied) {
      settingsApplied = true
      mode.value = s.defaultMode || 'ask'
      thinkingEnabled.value = s.thinkingEnabled || false
      thinkingStrength.value = s.thinkingStrength || 'medium'
    }
  },
  { immediate: true },
)

// 变更时：同时写 localStorage（瞬时回退）与 DB（持久化，满足“入库不丢失”）
watch([mode, thinkingEnabled, thinkingStrength], () => {
  localStorage.setItem('ai-mode', mode.value)
  localStorage.setItem('ai-thinking-enabled', String(thinkingEnabled.value))
  localStorage.setItem('ai-thinking-strength', thinkingStrength.value)
  persistSettings({
    defaultMode: mode.value,
    thinkingEnabled: thinkingEnabled.value,
    thinkingStrength: thinkingStrength.value,
  })
})

// 历史面板：改为 Popover 覆盖层（#216），不占布局宽度
const historyOpen = ref(false)

// 历史消息搜索定位（#231）：打开对话后滚动并高亮到命中消息
const msgListRef = ref<InstanceType<typeof AiMessageList> | null>(null)
const chatInputRef = ref<InstanceType<typeof AiChatInput> | null>(null)
function onLocateMessage(hit: import('@/api/ai').ConversationSearchHit) {
  // 等对话加载完成后再定位（select 已触发 loadConversation）
  setTimeout(() => {
    msgListRef.value?.scrollToPos(hit.posInConv, hit.snippet.slice(0, 40))
  }, 150)
}

// 可拖拽面板宽度（#215）：固定右侧，拖左边缘调宽，持久化到 localStorage
const { width, startDrag } = useResizablePanel({
  storageKey: 'ai-sidebar-width',
  min: 320,
  max: 760,
  default: 420,
})

// 当前用户角色（#217 / RBAC）：用于头部角色徽章
const { roleKey, isSuperAdmin, isAdmin, fetchUser } = useUser()

onMounted(() => {
  init()
  fetchUser()
})

watch(
  () => props.open,
  (v) => {
    if (v) {
      loadProviders()
      loadConversations()
      fetchUser()
    }
  },
)

// 切换对话时同步模式/思考开关
async function onSelectConversation(id: string) {
  await loadConversation(id)
  if (currentConversation.value) {
    mode.value = currentConversation.value.mode || 'ask'
    thinkingEnabled.value = currentConversation.value.thinking_enabled || false
  }
}

async function onNewConversation() {
  await newConversation({ mode: mode.value, thinkingEnabled: thinkingEnabled.value })
}

// 当前视图 → 注入给 AI 的上下文提示（#229 上下文感知）。
// 让模型知道用户此刻正在浏览哪个页面，回答更贴合场景。
const VIEW_CONTEXT_KEYS: Record<string, string> = {
  clipboard: 'ai_ctx_view_clipboard',
  archive: 'ai_ctx_view_archive',
  favorites: 'ai_ctx_view_favorites',
  templates: 'ai_ctx_view_templates',
  devices: 'ai_ctx_view_devices',
  profile: 'ai_ctx_view_profile',
  notifications: 'ai_ctx_view_notifications',
  subscription: 'ai_ctx_view_subscription',
}
const viewContextText = computed(() => {
  const v = props.view
  if (!v) return undefined
  const key = VIEW_CONTEXT_KEYS[v]
  if (key) return t(key)
  return t('ai_ctx_view_other', { view: v })
})

function onSend(text: string, images?: import('@/api/ai').ChatImage[]) {
  send(text, {
    mode: mode.value,
    thinking: thinkingEnabled.value,
    thinkingStrength: thinkingStrength.value,
    images,
    viewContext: viewContextText.value,
  })
}

// 快捷指令（总结/翻译/格式化/解释/优化）：不在输入框写入 prompt，仅告诉 send() 走哪个 instruction。
// useAiChat.send() 会自动在 user 消息之前注入一条隐藏 system 消息（systemMeta.kind='quick_action_xxx'）。
function onQuickAction(
  action: 'summarize' | 'translate' | 'format' | 'explain' | 'optimize',
  text: string,
  images?: import('@/api/ai').ChatImage[],
) {
  send(text, {
    mode: mode.value,
    thinking: thinkingEnabled.value,
    thinkingStrength: thinkingStrength.value,
    images,
    viewContext: viewContextText.value,
    quickAction: action,
  })
}

// 历史用户消息「重新编辑」：把消息内容填回输入框并聚焦，让用户继续修改后重发。
function onReedit(content: string) {
  chatInputRef.value?.setDraft(content)
}

function toggleThinking() {
  thinkingEnabled.value = !thinkingEnabled.value
}

function setThinkingStrength(s: 'low' | 'medium' | 'high') {
  thinkingStrength.value = s
}

async function onRename(id: string, title: string) {
  await renameConversation(id, title)
}

async function onDelete(id: string) {
  await deleteConversation(id)
}

// 图片重复感知（#225）：把后端下发的记录时间格式化为本地可读字符串
function formatDupTime(iso?: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(currentLang.value === 'en' ? 'en-US' : 'zh-CN')
  } catch {
    return ''
  }
}
</script>

<template>
  <aside
    class="ai-panel"
    :class="{ 'ai-panel--open': open }"
    :aria-hidden="!open"
    :style="open ? { width: width + 'px', minWidth: width + 'px' } : {}"
  >
    <!-- 左侧拖拽手柄（#215） -->
    <div class="ai-resize-handle" title="拖拽调整宽度" @mousedown="startDrag" />

    <div class="ai-main">
      <!-- 顶部栏 -->
      <div class="ai-header">
        <div class="ai-header-left">
          <Popover v-model:open="historyOpen">
            <PopoverTrigger as-child>
              <Button v-if="hasProviders" variant="ghost" size="icon-sm" :title="t('ai_history') || '历史'">
                <History :size="16" />
              </Button>
            </PopoverTrigger>
            <PopoverContent class="ai-history-pop" side="bottom" align="start" :side-offset="6">
              <AiConversationList
                :conversations="conversations"
                :current-id="currentConversationId"
                :loading="false"
                @select="
                  (id) => {
                    onSelectConversation(id)
                    historyOpen = false
                  }
                "
                @rename="onRename"
                @delete="onDelete"
                @locate="onLocateMessage"
              />
            </PopoverContent>
          </Popover>
          <Button
            v-if="hasProviders"
            variant="ghost"
            size="icon-sm"
            :title="t('ai_memory') || '记忆'"
            @click="showMemory = !showMemory"
          >
            <Brain :size="16" />
          </Button>
          <div class="ai-header-title">
            <Bot :size="18" />
            <span>AI</span>
            <!-- 角色徽章（#217 / RBAC） -->
            <span v-if="hasProviders" class="ai-role-badge" :class="`ai-role-${roleKey}`">
              <ShieldCheck v-if="isSuperAdmin" :size="11" />
              <UserCog v-else-if="isAdmin" :size="11" />
              <User v-else :size="11" />
              {{ roleKey }}
            </span>
          </div>
        </div>
        <div class="ai-header-right">
          <Button
            v-if="hasProviders && currentConversationId && !isStreaming && messages.length >= 2"
            variant="ghost"
            size="icon-sm"
            :title="t('ai_compact_tooltip') || '压缩上下文 (/compact)'"
            @click="manualCompact"
          >
            <Package :size="15" />
          </Button>
          <Button
            v-if="hasProviders"
            variant="ghost"
            size="icon-sm"
            :title="t('ai_new_chat') || '新对话'"
            @click="onNewConversation"
          >
            <Plus :size="15" />
          </Button>
          <Button v-if="messages.length" variant="ghost" size="icon-sm" :title="t('ai_clear')" @click="clear">
            <MessageSquare :size="15" />
          </Button>
          <Button variant="ghost" size="icon-sm" :title="t('close_btn')" @click="emit('close')">
            <X :size="16" />
          </Button>
        </div>
      </div>

      <!-- 记忆管理面板 -->
      <AiMemoryPanel
        v-if="showMemory"
        :open="showMemory"
        :memory-enabled="memoryEnabled"
        @close="showMemory = false"
        @update:memory-enabled="setMemoryEnabled"
      />

      <!-- 无供应商提示 / 主聊天区 -->
      <template v-else>
        <div v-if="!hasProviders" class="ai-no-providers">
          <Bot :size="48" class="ai-no-providers-icon" />
          <h3>{{ t('ai_no_providers_title') || 'No AI Provider' }}</h3>
          <p>{{ t('ai_no_providers_hint') }}</p>
          <Button class="ai-setup-btn" @click="emit('open-settings')">
            <Plus :size="14" />
            {{ t('ai_go_settings') }}
          </Button>
        </div>

        <!-- 主聊天区 -->
        <template v-else>
          <div v-if="mode === 'agent'" class="ai-workflow-bar">
            <div class="ai-workflow-info">
              <Workflow :size="14" />
              <span>{{ t('ai_workflow_active') || 'Workflow Mode Active' }}</span>
            </div>
          </div>

          <AiMessageList
            ref="msgListRef"
            :messages="messages"
            :is-streaming="isStreaming"
            @reedit="onReedit"
          />

          <!-- 图片重复感知（#225）：本次发送的图片已在历史剪贴板中存在 -->
          <div v-if="duplicateImageNotice" class="ai-dup-image-bar">
            <CopyCheck :size="15" class="ai-dup-image-icon" />
            <span class="ai-dup-image-text">{{
              t('ai_dup_image_notice', { earliestTime: formatDupTime(duplicateImageNotice.createdAt) })
            }}</span>
            <Button variant="ghost" size="icon-sm" :title="t('close_btn')" @click="duplicateImageNotice = null">
              <X :size="14" />
            </Button>
          </div>

          <!-- 上下文压缩进度：手动 /compact 与后端自动压缩共用（分割线 + 扫光动画） -->
          <AiCompressProgress v-if="compressProgress" :progress="compressProgress" />

          <div v-if="error" class="ai-error-bar">{{ error }}</div>

          <AiChatInput
            ref="chatInputRef"
            :disabled="!canSend"
            :is-streaming="isStreaming"
            :providers="providers"
            :selected-provider-id="selectedProviderId"
            :selected-model="selectedModel"
            :thinking-enabled="thinkingEnabled"
            :thinking-strength="thinkingStrength"
            :mode="mode"
            :context-usage="contextUsage"
            :provider-supports-cache="providerSupportsCache"
            @send="onSend"
            @quick-action="onQuickAction"
            @reedit="onReedit"
            @stop="stop"
            @select-provider="selectProvider"
            @select-model="selectModel"
            @toggle-thinking="toggleThinking"
            @set-thinking-strength="setThinkingStrength"
            @set-mode="(m) => (mode = m)"
            @open-settings="emit('open-settings')"
          />
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.ai-panel {
  position: relative;
  width: 0;
  min-width: 0;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-default);
  display: flex;
  flex-direction: row;
  overflow: hidden;
  transition:
    width 0.22s ease,
    min-width 0.22s ease;
  flex-shrink: 0;
}

/* 宽度由 useResizablePanel 通过 inline style 动态设置（#215）；此处仅保留展开基线宽度作为回退 */
.ai-panel--open {
  width: 420px;
  min-width: 420px;
}

/* 左侧拖拽手柄（#215） */
.ai-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 6;
  background: transparent;
  transition: background 0.12s;
}
.ai-resize-handle:hover {
  background: var(--accent);
  opacity: 0.4;
}

.ai-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.ai-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

/* 角色徽章（#217 / RBAC） */
.ai-role-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 2px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
}
.ai-role-super_admin {
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
  border-color: color-mix(in srgb, var(--danger, #ef4444) 30%, transparent);
}
.ai-role-admin {
  color: var(--accent);
  background: var(--accent-bg);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}
.ai-role-user {
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-color: var(--border-default);
}

.ai-header-right {
  display: flex;
  gap: 4px;
}

.ai-no-providers {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
}

.ai-no-providers-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}

.ai-no-providers h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.ai-no-providers p {
  font-size: 13px;
  margin: 0;
  line-height: 1.5;
}

.ai-setup-btn {
  min-width: 140px;
}

.ai-workflow-bar {
  padding: 8px 14px;
  background: var(--accent-bg);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.ai-workflow-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--accent);
  font-weight: 500;
}

.ai-error-bar {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--danger, #ef4444);
  background: var(--danger-bg, #fef2f2);
  border-top: 1px solid var(--border-default);
}

/* 图片重复感知横幅（#225） */
.ai-dup-image-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.5;
  color: hsl(210 90% 25%);
  background: hsl(210 80% 92%);
  border-top: 1px solid hsl(210 70% 85%);
  flex-shrink: 0;
}
.ai-dup-image-bar .ai-dup-image-icon {
  flex-shrink: 0;
  color: hsl(210 90% 35%);
}
.ai-dup-image-bar .ai-dup-image-text {
  flex: 1;
  min-width: 0;
}
.dark .ai-dup-image-bar {
  color: hsl(210 80% 85%);
  background: hsl(210 60% 20%);
  border-top-color: hsl(210 50% 30%);
}
.dark .ai-dup-image-bar .ai-dup-image-icon {
  color: hsl(210 80% 60%);
}

/* 历史 Popover（内容被 teleport 到 body，用 :deep 穿透作用域，#216） */
:deep(.ai-history-pop) {
  width: 268px;
  padding: 0;
  overflow: hidden;
}
:deep(.ai-history-pop .ai-conv-panel) {
  width: 100%;
  min-width: 0;
  border-right: none;
  border-radius: 0;
}
</style>
