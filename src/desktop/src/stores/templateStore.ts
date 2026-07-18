import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from '@/api/client'
import { useClipboard } from '@/composables/useClipboard'
import { useSonner } from '@/composables/useSonner'
import * as tauri from '@/lib/tauri'
import type { ClipboardTemplate } from '@/types'

// 变量语法：{{ name }}，name 为字母/数字/下划线（允许前后空格）
const VAR_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

// 内置变量（自动解析，无需用户输入）
export const BUILTIN_VARS = ['date', 'time', 'datetime', 'clipboard'] as const
export type BuiltinVar = (typeof BUILTIN_VARS)[number]

export function isBuiltinVar(name: string): boolean {
  return (BUILTIN_VARS as readonly string[]).includes(name)
}

// 提取模板内容中的全部变量名（去重、保序）
export function extractVariables(content: string): string[] {
  const re = new RegExp(VAR_PATTERN.source, 'g')
  const seen = new Set<string>()
  const result: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const name = m[1]
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function fmtTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${fmtTime(d)}`
}

// 解析模板内容：内置变量即时求值，用户变量用 userValues 替换（缺失则填空串）
export async function resolveTemplate(
  content: string,
  userValues: Record<string, string> = {},
): Promise<string> {
  const now = new Date()
  const builtins: Record<string, string> = {
    date: fmtDate(now),
    time: fmtTime(now),
    datetime: fmtDateTime(now),
    clipboard: '',
  }
  // clipboard 需读取当前剪贴板内容；失败（非 Tauri 环境/无权限）时降级为空串
  try {
    builtins.clipboard = (await tauri.getClipboardContent()) || ''
  } catch {
    builtins.clipboard = ''
  }
  const re = new RegExp(VAR_PATTERN.source, 'g')
  return content.replace(re, (_full, name: string) => {
    if (name in builtins) return builtins[name]
    return userValues[name] ?? ''
  })
}

export const useTemplateStore = defineStore('templates', () => {
  const templates = ref<ClipboardTemplate[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const initialized = ref(false)

  const { copyText } = useClipboard()
  const toast = useSonner()

  async function fetchTemplates() {
    loading.value = true
    error.value = null
    try {
      const res = await getTemplates()
      templates.value = (res?.data || []) as ClipboardTemplate[]
      initialized.value = true
    } catch (e: any) {
      error.value = e?.message || 'Failed to load templates'
      console.warn('[Templates] fetch failed', e)
    } finally {
      loading.value = false
    }
  }

  async function create(name: string, content: string): Promise<ClipboardTemplate | null> {
    try {
      const created = await createTemplate(name, content)
      if (created) {
        templates.value.unshift(created as ClipboardTemplate)
        toast.show('模板已创建', 'success')
        return created as ClipboardTemplate
      }
    } catch (e: any) {
      toast.show('创建失败：' + (e?.message || ''), 'error')
      console.warn('[Templates] create failed', e)
    }
    return null
  }

  async function update(
    id: string,
    data: { name?: string; content?: string },
  ): Promise<ClipboardTemplate | null> {
    try {
      const updated = await updateTemplate(id, data)
      if (updated) {
        const idx = templates.value.findIndex((t) => t.id === id)
        if (idx !== -1) templates.value[idx] = updated as ClipboardTemplate
        toast.show('模板已更新', 'success')
        return updated as ClipboardTemplate
      }
    } catch (e: any) {
      toast.show('更新失败：' + (e?.message || ''), 'error')
      console.warn('[Templates] update failed', e)
    }
    return null
  }

  async function remove(id: string): Promise<boolean> {
    try {
      const ok = await deleteTemplate(id)
      if (ok) {
        templates.value = templates.value.filter((t) => t.id !== id)
        toast.show('模板已删除', 'success')
        return true
      }
    } catch (e: any) {
      toast.show('删除失败：' + (e?.message || ''), 'error')
      console.warn('[Templates] delete failed', e)
    }
    return false
  }

  // 解析并写入剪贴板；userValues 为用户变量填充值
  async function insertTemplate(
    tpl: ClipboardTemplate,
    userValues: Record<string, string> = {},
  ): Promise<boolean> {
    try {
      const resolved = await resolveTemplate(tpl.content, userValues)
      const ok = await copyText(resolved)
      if (ok) {
        toast.show('已插入剪贴板', 'success')
        return true
      }
      toast.show('插入失败', 'error')
    } catch (e: any) {
      toast.show('插入失败：' + (e?.message || ''), 'error')
      console.warn('[Templates] insert failed', e)
    }
    return false
  }

  // 该模板需要用户填充的变量（排除内置变量）
  function userVariables(tpl: ClipboardTemplate): string[] {
    return extractVariables(tpl.content).filter((v) => !isBuiltinVar(v))
  }

  // 该模板的全部变量（含内置，用于编辑器提示）
  function allVariables(tpl: ClipboardTemplate): string[] {
    return extractVariables(tpl.content)
  }

  return {
    templates,
    loading,
    error,
    initialized,
    fetchTemplates,
    create,
    update,
    remove,
    insertTemplate,
    extractVariables,
    userVariables,
    allVariables,
  }
})
