<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChat } from '@/composables/useAiChat'
import Button from '@/components/ui/button/Button.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import AiMessageList from './AiMessageList.vue'
import AiChatInput from './AiChatInput.vue'
import { X, Trash2, Bot, Plus, Settings2 } from 'lucide-vue-next'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; 'open-settings': [] }>()
const { t } = useI18n()

const { providers, selectedProviderId, messages, isStreaming, error, hasProviders, canSend, init, loadProviders, selectProvider, send, stop, clear } =
  useAiChat()

const providerLabel = computed(() => {
  const p = providers.value.find((x) => x.id === selectedProviderId.value)
  return p?.name || t('ai_select_provider')
})

onMounted(init)

// 每次打开时刷新供应商列表（用户在设置里改动后回来能看到）
watch(
  () => props.open,
  (v) => {
    if (v) loadProviders()
  },
)

function onSend(text: string) {
  send(text)
}
</script>

<template>
  <aside class="ai-sidebar" :class="{ 'ai-sidebar--open': open }" :aria-hidden="!open">
    <div class="ai-header">
      <div class="ai-header-title">
        <Bot :size="18" />
        <span>{{ t('sg_ai') }}</span>
      </div>
      <div class="ai-header-actions">
        <Button v-if="messages.length" variant="ghost" size="icon-sm" :title="t('ai_clear')" @click="clear">
          <Trash2 :size="15" />
        </Button>
        <Button variant="ghost" size="icon-sm" :title="t('close_btn')" @click="emit('close')">
          <X :size="16" />
        </Button>
      </div>
    </div>

    <div class="ai-toolbar">
      <CustomSelect :model-value="selectedProviderId" @update:model-value="selectProvider">
        {{ providerLabel }}
        <template #options>
          <CustomSelectOption
            v-for="p in providers"
            :key="p.id"
            :value="p.id"
            :selected="selectedProviderId === p.id"
            @select="selectProvider"
          >
            {{ p.name }}
          </CustomSelectOption>
        </template>
      </CustomSelect>
      <Button variant="outline" size="icon-sm" :title="t('ai_manage')" @click="emit('open-settings')">
        <Settings2 :size="15" />
      </Button>
    </div>

    <div v-if="!hasProviders" class="ai-no-providers">
      <p>{{ t('ai_no_providers_hint') }}</p>
      <Button class="min-w-[140px]" @click="emit('open-settings')">
        <Plus :size="14" />
        {{ t('ai_go_settings') }}
      </Button>
    </div>

    <template v-else>
      <AiMessageList :messages="messages" :is-streaming="isStreaming" />
      <div v-if="error" class="ai-error-bar">{{ error }}</div>
      <AiChatInput :disabled="!canSend" :is-streaming="isStreaming" @send="onSend" @stop="stop" />
    </template>
  </aside>
</template>

<style scoped>
.ai-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: 380px;
  max-width: 92vw;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-default);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.22s ease;
  z-index: var(--z-panel, 40);
}
.ai-sidebar--open {
  transform: translateX(0);
}
.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.ai-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.ai-header-actions {
  display: flex;
  gap: 4px;
}
.ai-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.ai-toolbar :deep(.cs-trigger) {
  flex: 1;
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
  font-size: 13px;
}
.ai-error-bar {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--danger, #ef4444);
  background: var(--danger-bg, #fef2f2);
  border-top: 1px solid var(--border-default);
}
</style>
