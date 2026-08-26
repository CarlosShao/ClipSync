<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, provide } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChat } from '@/composables/useAiChat'
import { useAiChatUi } from '@/composables/useAiChatUi'
import { useUser } from '@/composables/useUser'
import { useResizablePanel } from '@/composables/useResizablePanel'
import Button from '@/components/ui/button/Button.vue'
import AiPanel from './AiPanel.vue'
import AiNavRail from './AiNavRail.vue'
import AiInspector from './AiInspector.vue'
import AiMessageList from './AiMessageList.vue'
import AiChatComposer from './AiChatComposer.vue'
import AiMemoryPanel from './AiMemoryPanel.vue'
import AiUsageMeter from './AiUsageMeter.vue'
import {
  X,
  Bot,
  Plus,
  MessageSquare,
  Workflow,
  Brain,
  ShieldCheck,
  UserCog,
  User,
  CopyCheck,
  Package,
  PanelRight,
  PanelLeft,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  ChevronDown,
  Check,
  ShieldAlert,
} from 'lucide-vue-next'

/**
 * AiChatPanel — AI 聊天面板（正式编排宿主，UI-F 由过渡壳 AISidebar 更名整合）。
 * 对宿主（HomeView/App.vue）契约不变：props { open, view } / emits { close, open-settings }。
 * 内部渲染 AiPanel 三栏 Shell（Nav=AiNavRail / Canvas=消息流+AiChatComposer / Detail=AiInspector），
 * 业务编排（useAiChat 协议层调用）集中在本宿主，布局状态归 useAiChatUi。
 */
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
  pendingConfirm,
  approving,
  approve,
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

const { breakpoint, setNavOverlayOpen, toggleInspector } = useAiChatUi()

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

// 历史消息搜索定位（#231）：打开对话后滚动并高亮到命中消息（搜索已迁入 AiNavRail）
const msgListRef = ref<InstanceType<typeof AiMessageList> | null>(null)
const chatInputRef = ref<InstanceType<typeof AiChatComposer> | null>(null)
function onLocateMessage(hit: import('@/api/ai').ConversationSearchHit) {
  // 等对话加载完成后再定位（select 已触发 loadConversation）
  setTimeout(() => {
    msgListRef.value?.scrollToPos(hit.posInConv, hit.snippet.slice(0, 40))
  }, 150)
}

// 可拖拽面板宽度（#215）：固定右侧，拖左边缘调宽，持久化到 localStorage。
// UI-B：max 放宽到 1200，宽视口下拉宽面板可体验三栏 Shell（Nav + Canvas + Detail）
const { width, startDrag } = useResizablePanel({
  storageKey: 'ai-sidebar-width',
  min: 320,
  max: 1200,
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

// 破坏性工具确认下拉菜单状态
const showConfirmMenu = ref(false)
watch(pendingConfirm, () => {
  showConfirmMenu.value = false
})

function closeConfirmMenu(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target?.closest('.ai-cfm-pop__allow-wrap')) {
    showConfirmMenu.value = false
  }
}

// 监听 settings 保存/删除 provider 后的全局事件，刷新本地列表
// 否则 AI 面板常驻打开时，新增/修改的 provider 不会立刻出现在下拉里（只能刷新页面）
const onProvidersChanged = () => loadProviders()
onMounted(() => {
  window.addEventListener('clipsync:ai-providers-changed', onProvidersChanged)
  document.addEventListener('click', closeConfirmMenu)
})
onBeforeUnmount(() => {
  window.removeEventListener('clipsync:ai-providers-changed', onProvidersChanged)
  document.removeEventListener('click', closeConfirmMenu)
})

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

async function onRename(id: string, title: string) {
  await renameConversation(id, title)
}

async function onDelete(id: string) {
  await deleteConversation(id)
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

provide('aiChatSend', onSend)

const onCustomSendMessage = (e: any) => {
  if (e?.detail?.content) {
    onSend(e.detail.content)
  }
}
onMounted(() => {
  window.addEventListener('clipsync:ai-send-message', onCustomSendMessage)
})
onBeforeUnmount(() => {
  window.removeEventListener('clipsync:ai-send-message', onCustomSendMessage)
})

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

// 图片重复感知（#225）：把后端下发的记录时间格式化为本地可读字符串
function formatDupTime(iso?: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(currentLang.value === 'en' ? 'en-US' : 'zh-CN')
  } catch {
    return ''
  }
}

// 破坏性工具确认门控（Agent-C）：这些工具触发确认卡片时以红色强调（破坏性强），
// 其余写工具以安全色强调。清单与后端 WRITE_TOOL_NAMES/破坏性登记保持一致。
const DESTRUCTIVE_TOOLS = new Set(['destroy_clips'])
const isDestructiveConfirm = computed(() => {
  return !!pendingConfirm.value && DESTRUCTIVE_TOOLS.has(pendingConfirm.value.tool)
})
// 确认卡片工具名：优先 i18n 键，缺失时把 snake_case 人性化作为兜底。
function confirmToolName(tool?: string): string {
  if (!tool) return ''
  const key = 'ai_tool_' + tool
  const val = t(key)
  if (val && val !== key) return val
  return tool
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
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
      <!-- 记忆管理面板 -->
      <AiMemoryPanel
        v-if="showMemory"
        :open="showMemory"
        :memory-enabled="memoryEnabled"
        @close="showMemory = false"
        @update:memory-enabled="setMemoryEnabled"
      />

      <!-- 无供应商提示 -->
      <div v-else-if="!hasProviders" class="ai-no-providers">
        <Bot :size="48" class="ai-no-providers-icon" />
        <h3>{{ t('ai_no_providers_title', 'No AI Provider') }}</h3>
        <p>{{ t('ai_no_providers_hint') }}</p>
        <Button class="ai-setup-btn" @click="emit('open-settings')">
          <Plus :size="14" />
          {{ t('ai_go_settings') }}
        </Button>
      </div>

      <!-- 三栏 Shell：Nav（会话）+ Canvas（消息流+输入）+ Detail（Inspector） -->
      <AiPanel v-else>
        <template #nav>
          <AiNavRail
            :conversations="conversations"
            :current-id="currentConversationId"
            :loading="false"
            @select="onSelectConversation"
            @rename="onRename"
            @delete="onDelete"
            @locate="onLocateMessage"
            @new-chat="onNewConversation"
            @open-settings="emit('open-settings')"
            @open-memory="showMemory = true"
          />
        </template>

        <template #canvas>
          <!-- 顶部栏 -->
          <div class="ai-header">
            <div class="ai-header-left">
              <Button
                v-if="breakpoint === 'sm'"
                variant="ghost"
                size="icon-sm"
                :title="t('ai_nav_open', '打开导航栏')"
                @click="setNavOverlayOpen(true)"
              >
                <PanelLeft :size="16" />
              </Button>
              <div class="ai-header-title">
                <Bot :size="18" />
                <span>AI</span>
                <!-- 角色徽章（#217 / RBAC） -->
                <span class="ai-role-badge" :class="`ai-role-${roleKey}`">
                  <ShieldCheck v-if="isSuperAdmin" :size="11" />
                  <UserCog v-else-if="isAdmin" :size="11" />
                  <User v-else :size="11" />
                  {{ roleKey }}
                </span>
              </div>
            </div>
            <div class="ai-header-right">
              <Button
                variant="ghost"
                size="icon-sm"
                :title="t('ai_inspector_toggle', 'Inspector')"
                @click="toggleInspector()"
              >
                <PanelRight :size="15" />
              </Button>
              <Button
                v-if="currentConversationId && !isStreaming && messages.length >= 2"
                variant="ghost"
                size="icon-sm"
                :title="t('ai_compact_tooltip', '压缩上下文 (/compact)')"
                @click="manualCompact"
              >
                <Package :size="15" />
              </Button>
              <Button variant="ghost" size="icon-sm" :title="t('ai_new_chat', '新对话')" @click="onNewConversation">
                <Plus :size="15" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                :title="t('ai_memory', '记忆')"
                @click="showMemory = !showMemory"
              >
                <Brain :size="15" />
              </Button>
              <Button v-if="messages.length" variant="ghost" size="icon-sm" :title="t('ai_clear')" @click="clear">
                <MessageSquare :size="15" />
              </Button>
              <Button variant="ghost" size="icon-sm" :title="t('close_btn')" @click="emit('close')">
                <X :size="16" />
              </Button>
            </div>
          </div>

          <div v-if="mode === 'agent'" class="ai-workflow-bar">
            <div class="ai-workflow-info">
              <Workflow :size="14" />
              <span>{{ t('ai_workflow_active', 'Workflow Mode Active') }}</span>
            </div>
          </div>

          <AiMessageList
            ref="msgListRef"
            :messages="messages"
            :is-streaming="isStreaming"
            :confirm-tool="pendingConfirm?.tool ?? null"
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

          <!-- 上下文压缩进度：手动 /compact 与后端自动压缩共用（能力已并入 AiUsageMeter，UI-E） -->
          <AiUsageMeter v-if="compressProgress" variant="compress" :compress="compressProgress" />

          <!-- 破坏性工具确认门控（Agent-C）：内嵌气泡卡片，参考 Trae 权限请求框样式 -->
          <Transition name="ai-cfm-pop">
            <div
              v-if="pendingConfirm"
              class="ai-cfm-pop"
              :class="{ 'ai-cfm-pop--destructive': isDestructiveConfirm }"
              role="alertdialog"
              aria-live="assertive"
            >
              <!-- 气泡箭头（指向消息区） -->
              <div class="ai-cfm-pop__arrow" aria-hidden="true"></div>

              <!-- 头部：权限请求标题行 -->
              <div class="ai-cfm-pop__head">
                <div class="ai-cfm-pop__title-row">
                  <span
                    class="ai-cfm-pop__icon"
                    :class="{ 'ai-cfm-pop__icon--danger': isDestructiveConfirm }"
                  >
                    <ShieldCheck :size="14" />
                  </span>
                  <span class="ai-cfm-pop__title">
                    {{ t('ai_confirm_perm_title', '权限请求') }}：
                    <code class="ai-cfm-pop__tool-code">{{ confirmToolName(pendingConfirm.tool) }}</code>
                  </span>
                  <span v-if="isDestructiveConfirm" class="ai-cfm-pop__danger-tag">
                    {{ t('ai_confirm_destructive') || '破坏性' }}
                  </span>
                </div>
              </div>

              <!-- 参数/影响单行展示 -->
              <div class="ai-cfm-pop__body">
                <div v-if="pendingConfirm.argsSummary" class="ai-cfm-pop__cmd">
                  {{ pendingConfirm.argsSummary }}
                </div>
                <div v-if="pendingConfirm.impact" class="ai-cfm-pop__impact">
                  <AlertTriangle :size="11" class="ai-cfm-pop__impact-icon" />
                  <span>{{ pendingConfirm.impact }}</span>
                </div>
              </div>

              <!-- 按钮区：拒绝 + 仅本对话下拉 -->
              <div class="ai-cfm-pop__actions">
                <button
                  class="ai-cfm-pop__btn ai-cfm-pop__btn--deny"
                  :disabled="approving"
                  @click="approve(false)"
                >
                  <XCircle :size="13" />
                  {{ t('ai_confirm_deny') || '拒绝' }}
                  <span class="ai-cfm-pop__kbd">Esc</span>
                </button>
                <div class="ai-cfm-pop__allow-wrap">
                  <button
                    class="ai-cfm-pop__btn ai-cfm-pop__btn--allow"
                    :disabled="approving"
                    @click="approve(true, 'once')"
                  >
                    <CheckCircle2 :size="13" />
                    {{ approving ? (t('ai_confirm_approving') || '处理中…') : (t('ai_confirm_once') || '仅本次') }}
                  </button>
                  <button
                    class="ai-cfm-pop__btn-caret"
                    :disabled="approving"
                    title="更多选项"
                    tabindex="0"
                    @click.stop="showConfirmMenu = !showConfirmMenu"
                  >
                    <ChevronDown :size="13" />
                  </button>

                  <!-- 下拉快捷放行菜单 -->
                  <div v-if="showConfirmMenu" class="ai-cfm-pop__menu">
                    <button
                      type="button"
                      class="ai-cfm-pop__menu-item"
                      @click="showConfirmMenu = false; approve(true, 'once')"
                    >
                      <Check :size="12" />
                      <span>{{ t('ai_confirm_once') || '仅本次允许' }}</span>
                    </button>
                    <button
                      v-if="pendingConfirm?.tool"
                      type="button"
                      class="ai-cfm-pop__menu-item"
                      @click="showConfirmMenu = false; approve(true, 'tool')"
                    >
                      <ShieldCheck :size="12" />
                      <span>本会话始终允许 {{ pendingConfirm.tool }}</span>
                    </button>
                    <button
                      type="button"
                      class="ai-cfm-pop__menu-item ai-cfm-pop__menu-item--danger"
                      @click="showConfirmMenu = false; approve(true, 'all')"
                    >
                      <ShieldAlert :size="12" />
                      <span>本会话始终允许所有操作</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Transition>

          <div v-if="error" class="ai-error-bar">{{ error }}</div>

          <AiChatComposer
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

        <template #detail>
          <AiInspector
            :context-usage="contextUsage"
            :provider-supports-cache="providerSupportsCache"
            :memory-enabled="memoryEnabled"
            @open-memory="showMemory = true"
          />
        </template>
      </AiPanel>
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
  z-index: var(--z-sticky);
  background: transparent;
  transition: opacity 0.12s;
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
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 1.4;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
}
.ai-role-super_admin {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-color: color-mix(in srgb, var(--danger) 30%, transparent);
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
  font-size: var(--text-sm);
  color: var(--accent);
  font-weight: 500;
}

.ai-error-bar {
  padding: 8px 12px;
  font-size: var(--text-sm);
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border-top: 1px solid var(--border-default);
}

/* ========== 工具确认气泡卡片（内嵌式，参考 Trae 权限请求框） ========== */
.ai-cfm-pop {
  position: relative;
  margin: 8px 10px 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  box-shadow:
    0 4px 14px rgba(0, 0, 0, 0.08),
    0 1px 3px rgba(0, 0, 0, 0.04);
  flex-shrink: 0;
  z-index: 5;
}
.ai-cfm-pop--destructive {
  border-color: color-mix(in srgb, var(--danger, #ef4444) 22%, var(--border-subtle));
  background: color-mix(in srgb, var(--danger, #ef4444) 3%, var(--bg-surface));
}

/* 气泡箭头：指向消息区（上方） */
.ai-cfm-pop__arrow {
  position: absolute;
  top: -7px;
  left: 24px;
  width: 12px;
  height: 12px;
  background: inherit;
  border-left: 1px solid var(--border-subtle);
  border-top: 1px solid var(--border-subtle);
  transform: rotate(45deg);
  border-radius: 2px 0 0 0;
}
.ai-cfm-pop--destructive .ai-cfm-pop__arrow {
  border-left-color: color-mix(in srgb, var(--danger, #ef4444) 22%, var(--border-subtle));
  border-top-color: color-mix(in srgb, var(--danger, #ef4444) 22%, var(--border-subtle));
}

/* 头部标题行 */
.ai-cfm-pop__head {
  display: flex;
  align-items: center;
}
.ai-cfm-pop__title-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  min-width: 0;
}
.ai-cfm-pop__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.ai-cfm-pop__icon--danger {
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
}
.ai-cfm-pop__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.ai-cfm-pop__tool-code {
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--accent);
  padding: 2px 7px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.ai-cfm-pop--destructive .ai-cfm-pop__tool-code {
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent);
}
.ai-cfm-pop__danger-tag {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 20%, transparent);
  border-radius: 4px;
  padding: 1px 6px;
  line-height: 1.4;
}

/* 正文：参数 + 影响 */
.ai-cfm-pop__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 2px;
}
.ai-cfm-pop__cmd {
  font-size: 11.5px;
  font-family: ui-monospace, monospace;
  color: var(--text-secondary);
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--bg-hover);
  word-break: break-all;
  line-height: 1.5;
}
.ai-cfm-pop__impact {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-primary);
  opacity: 0.92;
}
.ai-cfm-pop__impact-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--warning);
}

/* 按钮区 */
.ai-cfm-pop__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}
.ai-cfm-pop__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 6px;
  border: 1px solid transparent;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease,
    color 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.08s ease;
  white-space: nowrap;
}
.ai-cfm-pop__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ai-cfm-pop__btn:not(:disabled):active {
  transform: scale(0.97);
}
.ai-cfm-pop__kbd {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
  border: 1px solid var(--border-subtle);
  line-height: 1.3;
  margin-left: 2px;
}

/* 拒绝按钮：次级 */
.ai-cfm-pop__btn--deny {
  color: var(--text-secondary);
  border-color: var(--border-default);
  background: var(--bg-surface);
}
.ai-cfm-pop__btn--deny:not(:disabled):hover {
  color: var(--text-primary);
  background: var(--bg-hover);
  border-color: var(--border-default);
}

/* 允许按钮组合：主按钮 + 下拉箭头 */
.ai-cfm-pop__allow-wrap {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  border-radius: 6px;
  overflow: visible;
  border: 1px solid var(--danger, #ef4444);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.ai-cfm-pop__allow-wrap:has(:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}
.ai-cfm-pop__btn--allow {
  color: #fff;
  background: var(--danger, #ef4444);
  border-color: transparent;
  border-radius: 5px 0 0 5px;
  border-right: 1px solid color-mix(in srgb, #fff 18%, transparent);
}
.ai-cfm-pop__btn--allow:not(:disabled):hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 88%, #000);
}
.ai-cfm-pop__btn-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  padding: 0 5px;
  border: none;
  border-radius: 0 5px 5px 0;
  background: var(--danger, #ef4444);
  color: #fff;
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.ai-cfm-pop__btn-caret:not(:disabled):hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 88%, #000);
}
.ai-cfm-pop__btn-caret:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 浮动下拉菜单 */
.ai-cfm-pop__menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  background: var(--bg-surface, #ffffff);
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 100;
}
.ai-cfm-pop__menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary, #1f2937);
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  transition: background-color 0.12s, color 0.12s;
}
.ai-cfm-pop__menu-item:hover {
  background: var(--bg-hover, #f3f4f6);
}
.ai-cfm-pop__menu-item--danger {
  color: var(--danger, #ef4444);
}
.ai-cfm-pop__menu-item--danger:hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
}

/* 过渡动画：从下方滑入 */
.ai-cfm-pop-enter-active,
.ai-cfm-pop-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.ai-cfm-pop-enter-from,
.ai-cfm-pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .ai-cfm-pop-enter-active,
  .ai-cfm-pop-leave-active {
    transition: none;
  }
}

/* 键盘可达性 */
.ai-cfm-pop__btn:focus-visible,
.ai-cfm-pop__btn-caret:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* 图片重复感知横幅（#225） */
.ai-dup-image-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-hover);
  border-top: 1px solid var(--border-default);
  flex-shrink: 0;
}
.ai-dup-image-bar .ai-dup-image-icon {
  flex-shrink: 0;
  color: var(--accent);
}
.ai-dup-image-bar .ai-dup-image-text {
  flex: 1;
  min-width: 0;
}
</style>
