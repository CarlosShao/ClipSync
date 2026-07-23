import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getTemplateVariables, upsertTemplateVariable, deleteTemplateVariable } from '@/api/client'
import { useSonner } from '@/composables/useSonner'

// 全局模板变量：name → value（默认值 / 上次记住的输入）。
// 后端按用户隔离存储在 template_variables 表，前端解析模板时回退到此。
export interface TemplateVariable {
  id: string
  name: string
  value: string
  created_at: string
  updated_at: string
}

export const useTemplateVariableStore = defineStore('templateVariables', () => {
  // name → value
  const variables = ref<Record<string, string>>({})
  const loading = ref(false)
  const initialized = ref(false)
  const toast = useSonner()

  // 以数组形式返回（用于设置页渲染）
  function list(): TemplateVariable[] {
    return Object.entries(variables.value).map(([name, value]) => ({
      id: '',
      name,
      value,
      created_at: '',
      updated_at: '',
    }))
  }

  async function fetchVariables() {
    loading.value = true
    try {
      const res = await getTemplateVariables()
      const data = (res?.data || []) as TemplateVariable[]
      const map: Record<string, string> = {}
      data.forEach((v) => {
        map[v.name] = v.value
      })
      variables.value = map
      initialized.value = true
    } catch (e: any) {
      console.warn('[TemplateVariables] fetch failed', e)
    } finally {
      loading.value = false
    }
  }

  async function setVariable(name: string, value: string): Promise<boolean> {
    try {
      const res = await upsertTemplateVariable(name, value)
      if (res) {
        variables.value = { ...variables.value, [name]: value }
        return true
      }
    } catch (e: any) {
      toast.show('保存失败：' + (e?.message || ''), 'error')
      console.warn('[TemplateVariables] set failed', e)
    }
    return false
  }

  async function removeVariable(name: string): Promise<boolean> {
    try {
      const ok = await deleteTemplateVariable(name)
      if (ok) {
        const next = { ...variables.value }
        delete next[name]
        variables.value = next
        toast.show('变量已删除', 'success')
        return true
      }
    } catch (e: any) {
      toast.show('删除失败：' + (e?.message || ''), 'error')
      console.warn('[TemplateVariables] remove failed', e)
    }
    return false
  }

  function get(name: string): string {
    return variables.value[name] ?? ''
  }

  return {
    variables,
    loading,
    initialized,
    list,
    fetchVariables,
    setVariable,
    removeVariable,
    get,
  }
})
