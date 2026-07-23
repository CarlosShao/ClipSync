<script setup lang="ts">
import { ref, reactive, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import * as tauri from '@/lib/tauri'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import { Pencil } from 'lucide-vue-next'
import './modal-shared.css'

defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()

// ===== Shortcut Customization =====
// global = registered with Tauri (works when app unfocused/minimized)
// app    = in-app key (only when main window focused), handled by local listeners
const DEFAULT_SHORTCUTS = {
  quickPaste: ['Ctrl', 'Shift', 'V'],
  toggleWindow: ['Ctrl', 'Alt', 'Space'],
  copyClip: ['Enter'],
  deleteClip: ['Delete'],
  search: ['Ctrl', 'F'],
}
const GLOBAL_IDS = ['quickPaste', 'toggleWindow']
const STORAGE_KEY = 'clipsync-custom-shortcuts'
type ShortcutId = keyof typeof DEFAULT_SHORTCUTS

// Sanitize a saved shortcut array — remove empty/non-string entries
function sanitizeKeys(keys: string[]): string[] {
  return keys.filter((k) => k && typeof k === 'string' && k.trim().length > 0).map((k) => k.trim())
}

let savedShortcuts: Record<string, string[]> = {}
try {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  // Sanitize each stored key array to clean up any corrupt entries
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      savedShortcuts[k] = sanitizeKeys(v)
    }
  }
} catch {
  /* ignore */
}
const customShortcuts = reactive<Record<string, string[]>>({ ...DEFAULT_SHORTCUTS, ...savedShortcuts })
const recordingId = ref<string | null>(null)
const recorderEl = ref<HTMLElement | null>(null)

const shortcutList = [
  { id: 'quickPaste' as ShortcutId, label: 'sk_quick_paste', global: true },
  { id: 'toggleWindow' as ShortcutId, label: 'sk_toggle_window', global: true },
  { id: 'copyClip' as ShortcutId, label: 'sk_copy_clip', global: false },
  { id: 'deleteClip' as ShortcutId, label: 'sk_delete_clip', global: false },
  { id: 'search' as ShortcutId, label: 'sk_search', global: false },
]

function getKeys(id: string): string[] {
  return customShortcuts[id] || []
}

function startRecord(id: string) {
  recordingId.value = id
  // Auto-focus the recorder element so keydown events are captured.
  // Double nextTick + type guard: ModalDialog may have enter animation,
  // v-else branch might not be mounted on first tick; ref may resolve
  // to non-DOM object in Tauri webview edge cases.
  // Note: ref inside v-for becomes an array in Vue 3, so we need to handle both cases.
  nextTick(() => {
    nextTick(() => {
      const el = Array.isArray(recorderEl.value) ? recorderEl.value[0] : recorderEl.value
      if (el && typeof el.focus === 'function') {
        el.focus()
      }
    })
  })
}

function stopRecord() {
  if (recordingId.value) {
    recordingId.value = null
  }
}

// Special key display-name mapping (e.code / e.key → human-readable label)
const SPECIAL_KEY_MAP: Record<string, string> = {
  // Whitespace / navigation
  Space: 'Space',
  ' ': 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  // Function keys
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
  // Symbols (need explicit mapping because .toUpperCase() mangles some)
  ';': ';',
  '=': '=',
  ',': ',',
  '-': '-',
  '.': '.',
  '/': '/',
  '`': '`',
  '[': '[',
  '\\': '\\',
  ']': ']',
  '"': '"',
  // Arrow keys (useful for in-app shortcuts)
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  // Numpad
  NumLock: 'NumLock',
  ScrollLock: 'ScrollLock',
  Pause: 'Pause',
  CapsLock: 'CapsLock',
}

function getDisplayKey(raw: string): string {
  return SPECIAL_KEY_MAP[raw] || raw
}

// Display safety: if a key looks like garbage (non-printable, too long, etc.),
// fall back to a placeholder rather than rendering junk.
function safeDisplayKey(k: string): string {
  if (!k || k.length > 12) return '�' // suspiciously long → replacement char
  // Check for non-printable/control characters (allow space and common symbols)
  // eslint-disable-next-line no-control-regex -- intentionally detecting non-printable keys
  if (/[\x00-\x1F\x7F]/.test(k) && k !== ' ' && !SPECIAL_KEY_MAP[k]) return '�'
  return k
}

function resolveMainKey(e: KeyboardEvent): string | null {
  // ── Special-case high-surface-area keys FIRST (before general logic) ──
  // These keys are commonly used in shortcuts but have unreliable e.key/e.code
  // across OS / keyboard layout / WebView2 versions.
  const spaceLike: Record<string, string> = {
    Space: 'Space',
    ' ': 'Space',
    space: 'Space',
    // WebView2 on Windows sometimes reports Space with these codes
    Spacebar: 'Space',
  }
  if (spaceLike[e.key] || spaceLike[e.code]) return 'Space'

  // Try e.code first (more stable across keyboard layouts), fall back to e.key
  const code = e.code.replace(/^(Key|Digit|Numpad)/, '') // 'KeyA' → 'A', 'Digit3' → '3'
  const rawKey = e.key

  // Single printable character
  if (rawKey.length === 1) return rawKey.toUpperCase()

  // Known special key — use the mapped display name
  const mapped = SPECIAL_KEY_MAP[rawKey] || SPECIAL_KEY_MAP[code]
  if (mapped) return mapped

  // Modifier-only press — ignore
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(rawKey)) return null

  // Fallback: use raw e.key (covers edge cases)
  return rawKey || null
}

function onKeyDown(e: KeyboardEvent) {
  if (!recordingId.value) return
  e.preventDefault()
  e.stopPropagation()

  // Build key list: modifier keys + main key (ignore modifiers alone)
  const keys: string[] = []
  if (e.ctrlKey || e.metaKey) keys.push(e.metaKey ? 'Cmd' : 'Ctrl')
  if (e.altKey) keys.push('Alt')
  if (e.shiftKey) keys.push('Shift')

  const mainKey = resolveMainKey(e)

  // Must have a non-modifier main key + at least one modifier (for global shortcuts,
  // single keys like Enter/Delete are OK for in-app shortcuts)
  if (!mainKey) return

  keys.push(mainKey)

  // Global shortcuts require at least one modifier; in-app allow bare keys
  const isGlobal = GLOBAL_IDS.includes(recordingId.value!)
  if (isGlobal && keys.length < 2) return

  // Save new shortcut (sanitize to prevent garbage characters)
  const id = recordingId.value!
  const cleanKeys = sanitizeKeys(keys)
  customShortcuts[id] = cleanKeys
  const shortcutStr = cleanKeys.join('+')
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...savedShortcuts, [id]: cleanKeys }))
  } catch (e) {
    console.warn('[Shortcuts] persist failed:', e)
  }
  recordingId.value = null

  if (isGlobal) {
    // Global shortcuts: re-register ALL global ones with Tauri.
    const globalMap: Record<string, string> = {}
    for (const gid of GLOBAL_IDS) {
      const ks = customShortcuts[gid]
      if (ks && ks.length) globalMap[gid] = ks.join('+')
    }
    tauri
      .setGlobalShortcuts(globalMap)
      .then(() => {
        toast.show(`Shortcut updated: ${shortcutStr}`, 'success')
      })
      .catch((err: any) => {
        toast.show(`Failed to register shortcut: ${err}`, 'error')
      })
  } else {
    // In-app shortcut: persisted only, handled by local key listeners.
    toast.show(`Shortcut updated: ${shortcutStr}`, 'success')
  }
}
</script>

<template>
  <ModalDialog
    :open="showModalType === 'shortcuts'"
    :title="t('modal_shortcuts')"
    max-width="440px"
    @close="emit('close')"
  >
    <div class="shortcut-list">
      <div v-for="sk in shortcutList" :key="sk.id" class="sk-item" :class="{ 'sk-recording': recordingId === sk.id }">
        <span class="sk-label-wrap"
          >{{ t(sk.label) }}<span v-if="sk.global" class="sk-global-tag">{{ t('sk_global') }}</span></span
        >
        <div v-if="recordingId !== sk.id" class="sk-keys" @click="startRecord(sk.id)">
          <kbd v-for="k in getKeys(sk.id)" :key="k">{{ safeDisplayKey(k) }}</kbd>
          <Pencil :size="12" class="sk-edit-ico" />
        </div>
        <div v-else ref="recorderEl" class="sk-recorder" tabindex="0" @blur="stopRecord" @keydown="onKeyDown">
          {{ t('sk_press_keys') }}...
        </div>
      </div>
    </div>
    <div class="sk-hint">
      {{ t('sk_hint') }}
    </div>
  </ModalDialog>
</template>

<style scoped>
.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sk-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 13px;
}
.sk-item:last-child {
  border-bottom: none;
}
.sk-item.sk-recording {
  background: var(--accent-light);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.sk-label-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sk-global-tag {
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 9999px;
  background: var(--accent-light);
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.sk-keys {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  flex-shrink: 0;
}
.sk-keys kbd {
  font-size: 11px;
  background: var(--bg-hover);
  border: 1px solid var(--border-default);
  border-radius: 3px;
  padding: 2px 6px;
  font-family: monospace;
  cursor: pointer;
  transition: all 0.15s;
}
.sk-keys kbd:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.sk-recorder {
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  border: 2px dashed var(--accent);
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  outline: none;
  min-width: 120px;
  text-align: center;
  animation: pulse-border 1.5s infinite;
}
.sk-edit-ico {
  margin-left: 4px;
  opacity: 0.4;
  cursor: pointer;
}
.sk-hint {
  margin-top: 12px;
  padding: 8px 10px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.6;
}

/* Shortcut recorder pulse animation */
@keyframes pulse-border {
  0%,
  100% {
    border-color: var(--accent);
    opacity: 1;
  }
  50% {
    border-color: var(--text-tertiary);
    opacity: 0.6;
  }
}
</style>
