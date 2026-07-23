<script setup lang="ts">
import { ref, reactive, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import * as tauri from '@/lib/tauri'
import { Pencil } from 'lucide-vue-next'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

// ── Shortcut defaults & storage ───────────────────────────────────────
const DEFAULT_SHORTCUTS = {
  'quickPaste': ['Ctrl', 'Shift', 'V'],
  'toggleWindow': ['Ctrl', 'Alt', 'Space'],
  'copyClip': ['Enter'],
  'deleteClip': ['Delete'],
  'search': ['Ctrl', 'F'],
}
const GLOBAL_IDS = ['quickPaste', 'toggleWindow']
const STORAGE_KEY = 'clipsync-custom-shortcuts'
type ShortcutId = keyof typeof DEFAULT_SHORTCUTS

let savedShortcuts: Record<string, string[]> = {}
try {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) { savedShortcuts[k] = sanitizeKeys(v) }
  }
} catch { /* ignore */ }

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

// ── Key display / resolution helpers ──────────────────────────────────
const SPECIAL_KEY_MAP: Record<string, string> = {
  'Space': 'Space', ' ': 'Space',
  'Enter': 'Enter', 'Tab': 'Tab', 'Backspace': 'Backspace', 'Delete': 'Delete',
  'Insert': 'Insert',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
  'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  ';': ';', '=': '=', ',': ',', '-': '-', '.': '.', '/': '/', '`': '`',
  '[': '[', '\\\\': '\\\\', ']': ']', '"': '"',
  'ArrowUp': '\u2191', 'ArrowDown': '\u2193', 'ArrowLeft': '\u2190', 'ArrowRight': '\u2192',
  'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
  'NumLock': 'NumLock', 'ScrollLock': 'ScrollLock', 'Pause': 'Pause',
  'CapsLock': 'CapsLock',
}

function getKeys(id: string): string[] { return customShortcuts[id] || [] }

function safeDisplayKey(k: string): string {
  if (!k || k.length > 12) return '\uFFFD'
  if (/[\x00-\x1F\x7F]/.test(k) && k !== ' ' && !SPECIAL_KEY_MAP[k]) return '\uFFFD'
  return k
}

function resolveMainKey(e: KeyboardEvent): string | null {
  const spaceLike: Record<string, string> = {
    'Space': 'Space', ' ': 'Space',
    'space': 'Space',
    'Spacebar': 'Space',
  }
  if (spaceLike[e.key] || spaceLike[e.code]) return 'Space'

  const code = e.code.replace(/^(Key|Digit|Numpad)/, '')
  const rawKey = e.key

  if (rawKey.length === 1) return rawKey.toUpperCase()

  const mapped = SPECIAL_KEY_MAP[rawKey] || SPECIAL_KEY_MAP[code]
  if (mapped) return mapped

  if (['Control', 'Alt', 'Shift', 'Meta'].includes(rawKey)) return null

  return rawKey || null
}

function sanitizeKeys(keys: string[]): string[] {
  return keys
    .filter(k => k && typeof k === 'string' && k.trim().length > 0)
    .map(k => k.trim())
}

// ── Recording logic ───────────────────────────────────────────────────
function startRecord(id: string) {
  recordingId.value = id
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

function onKeyDown(e: KeyboardEvent) {
  if (!recordingId.value) return
  e.preventDefault()
  e.stopPropagation()

  const keys: string[] = []
  if (e.ctrlKey || e.metaKey) keys.push(e.metaKey ? 'Cmd' : 'Ctrl')
  if (e.altKey) keys.push('Alt')
  if (e.shiftKey) keys.push('Shift')

  const mainKey = resolveMainKey(e)

  if (!mainKey) return

  keys.push(mainKey)

  const isGlobal = GLOBAL_IDS.includes(recordingId.value!)
  if (isGlobal && keys.length < 2) return

  const id = recordingId.value!
  const cleanKeys = sanitizeKeys(keys)
  customShortcuts[id] = cleanKeys
  const shortcutStr = cleanKeys.join('+')
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...savedShortcuts, [id]: cleanKeys }))
  } catch (e) { console.warn('[Shortcuts] persist failed:', e) }
  recordingId.value = null

  if (isGlobal) {
    const globalMap: Record<string, string> = {}
    for (const gid of GLOBAL_IDS) {
      const ks = customShortcuts[gid]
      if (ks && ks.length) globalMap[gid] = ks.join('+')
    }
    tauri.setGlobalShortcuts(globalMap).then(() => {
      toast.show(`Shortcut updated: ${shortcutStr}`, 'success')
    }).catch((err: any) => {
      toast.show(`Failed to register shortcut: ${err}`, 'error')
    })
  } else {
    toast.show(`Shortcut updated: ${shortcutStr}`, 'success')
  }
}
</script>

<template>
  <div class="sp-root">
    <div class="shortcut-list">
      <div v-for="sk in shortcutList" :key="sk.id" class="sk-item" :class="{ 'sk-recording': recordingId === sk.id }">
        <span class="sk-label-wrap">{{ t(sk.label) }}<span v-if="sk.global" class="sk-global-tag">{{ t('sk_global') }}</span></span>
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
  </div>
</template>

<style scoped>
.sp-root { padding: 4px 0; }

.shortcut-list { display: flex; flex-direction: column; }
.sk-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 13px;
}
.sk-item:last-child { border-bottom: none; }
.sk-item.sk-recording { background: var(--accent-light); border-radius: var(--radius-sm); padding: 10px 12px; }
.sk-label-wrap { display: inline-flex; align-items: center; gap: 6px; }
.sk-global-tag {
  font-size: 9px; font-weight: 600; line-height: 1;
  padding: 2px 5px; border-radius: 9999px;
  background: var(--accent-light); color: var(--accent);
  text-transform: uppercase; letter-spacing: .03em;
}
.sk-keys { display: inline-flex; align-items: center; gap: 4px; flex-wrap: nowrap; flex-shrink: 0; }
.sk-keys kbd {
  font-size: 11px; background: var(--bg-hover); border: 1px solid var(--border-default);
  border-radius: 3px; padding: 2px 6px; font-family: monospace;
  cursor: pointer; transition: all .15s;
}
.sk-keys kbd:hover { border-color: var(--accent); color: var(--accent); }
.sk-recorder {
  padding: 6px 14px; border-radius: var(--radius-sm);
  border: 2px dashed var(--accent); font-size: 13px; font-weight: 500;
  color: var(--accent); outline: none; min-width: 120px; text-align: center;
  animation: pulse-border 1.5s infinite;
}
.sk-edit-ico { margin-left: 4px; opacity: .4; cursor: pointer; }
.sk-hint {
  margin-top: 12px; padding: 8px 10px;
  background: var(--bg-hover); border-radius: var(--radius-sm);
  font-size: 11px; color: var(--text-tertiary); line-height: 1.6;
}

@keyframes pulse-border {
  0%, 100% { border-color: var(--accent); opacity: 1; }
  50% { border-color: var(--text-tertiary); opacity: 0.6; }
}
</style>
