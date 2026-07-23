// ============================================
// Templates API（模板库，变量解析在前端完成）
// Template Variables API（全局变量默认值，后端按用户隔离存储）
// ============================================
import { api } from './client'

export async function getTemplates(): Promise<{ data: any[] } | null> {
  const res = await api('GET', '/api/templates')
  return res.ok ? res.data : null
}

export async function createTemplate(name: string, content: string): Promise<any | null> {
  const res = await api('POST', '/api/templates', { name, content })
  return res.ok ? res.data : null
}

export async function updateTemplate(id: string, data: { name?: string; content?: string }): Promise<any | null> {
  const res = await api('PUT', `/api/templates/${id}`, data)
  return res.ok ? res.data : null
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const res = await api('DELETE', `/api/templates/${id}`)
  return res.ok
}

export async function getTemplateVariables(): Promise<{ data: any[] } | null> {
  const res = await api('GET', '/api/template-variables')
  return res.ok ? res.data : null
}

export async function upsertTemplateVariable(name: string, value: string): Promise<any | null> {
  const res = await api('PUT', '/api/template-variables', { name, value })
  return res.ok ? res.data : null
}

export async function deleteTemplateVariable(name: string): Promise<boolean> {
  const res = await api('DELETE', `/api/template-variables/${encodeURIComponent(name)}`)
  return res.ok
}
