import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getFavoriteCollections,
  migrateHierarchy,
} from '@/api/client'
import { onAiDataRefresh } from '@/composables/useAiDataRefresh'

function buildTree(flat: any[]) {
  const nodes: Map<string, any> = new Map()
  const roots: any[] = []

  for (const row of flat) {
    const rowId = row?.id
    const rowPath = row?.path
    const pathStr = typeof rowPath === 'string' ? rowPath : String(rowPath ?? '')
    if (!row || !rowId) continue
    const finalPath = pathStr || 'root.' + rowId.replace(/-/g, '_')
    const parts = finalPath.split('.')
    const depth = parts.length
    const node = {
      id: row.id,
      name: row.name || 'Untitled',
      icon: row.icon || 'folder',
      path: finalPath,
      depth,
      children: [],
      expanded: false,
      item_count: row.item_count || 0,
      sort_order: row.sort_order ?? 0,
    }
    nodes.set(row.id, node)
  }

  for (const node of nodes.values()) {
    const parts = node.path.split('.')
    if (parts.length <= 1) {
      roots.push(node)
    } else {
      const parentPath = parts.slice(0, -1).join('.')
      let found = false
      for (const candidate of nodes.values()) {
        if (candidate.path === parentPath) {
          candidate.children.push(node)
          found = true
          break
        }
      }
      if (!found) roots.push(node)
    }
  }

  function sortChildren(n: any) {
    n.children.sort((a: any, b: any) => a.sort_order - b.sort_order || a.path.localeCompare(b.path))
    n.children.forEach(sortChildren)
  }
  roots.forEach(sortChildren)

  return roots
}

function expandToDepth(nodes: any[], depth: number) {
  for (const node of nodes) {
    if (node.depth < depth) node.expanded = true
    if (node.children?.length) expandToDepth(node.children, depth)
  }
}

function syncExpandedState(nodes: any[], set: Set<string>) {
  for (const node of nodes) {
    if (node.expanded) set.add(node.path)
    if (node.children?.length) syncExpandedState(node.children, set)
  }
}

export const useCollectionStore = defineStore('collections', () => {
  const flatCollections = ref<any[]>([])
  const expandedPaths = ref<Set<string>>(new Set())
  const loading = ref(false)
  const initialized = ref(false)

  const tree = computed<any[]>(() => buildTree(flatCollections.value))

  const visibleNodes = computed<any[]>(() => {
    const result: any[] = []
    function walk(nodes: any[] | undefined) {
      if (!nodes) return
      for (const node of nodes) {
        if (!node) continue
        result.push(node)
        if ((node.children?.length ?? 0) > 0 && expandedPaths.value.has(node.path)) {
          walk(node.children)
        }
      }
    }
    walk(tree.value)
    return result
  })

  function autoExpandParentPaths(nodes: any[]) {
    let changed = false
    const walk = (n: any) => {
      if (n.depth > 1) {
        const parentPath = n.path.split('.').slice(0, -1).join('.')
        if (parentPath && !expandedPaths.value.has(parentPath)) {
          expandedPaths.value.add(parentPath)
          changed = true
        }
      }
      if (n.children?.length) n.children.forEach(walk)
    }
    nodes.forEach(walk)
    if (changed) expandedPaths.value = new Set(expandedPaths.value)
  }

  async function loadCollections(opts?: { expandParents?: boolean }) {
    loading.value = true
    try {
      const data = await getFavoriteCollections()
      if (data?.collections && data.collections.length > 0) {
        flatCollections.value = data.collections
        if (expandedPaths.value.size === 0) {
          expandToDepth(tree.value, 2)
          syncExpandedState(tree.value, expandedPaths.value)
        }
        if (opts?.expandParents) {
          autoExpandParentPaths(tree.value)
        }
      } else if (data?.collections && data.collections.length === 0) {
        flatCollections.value = []
      } else {
        const migrated = await migrateHierarchy()
        if (migrated) {
          expandedPaths.value = new Set()
          const retry = await getFavoriteCollections()
          if (retry?.collections && retry.collections.length > 0) {
            flatCollections.value = retry.collections
            expandToDepth(tree.value, 2)
            syncExpandedState(tree.value, expandedPaths.value)
          } else {
            flatCollections.value = []
          }
        }
      }
    } catch (e) {
      console.error('[collectionStore] loadCollections failed:', e)
    } finally {
      loading.value = false
    }
  }

  function toggleExpand(path: string) {
    if (expandedPaths.value.has(path)) {
      expandedPaths.value.delete(path)
    } else {
      expandedPaths.value.add(path)
    }
    expandedPaths.value = new Set(expandedPaths.value)
  }

  function expandPath(path: string) {
    expandedPaths.value.add(path)
    expandedPaths.value = new Set(expandedPaths.value)
  }

  function removeFromTree(id: string, path?: string) {
    if (path) {
      const prefix = path + '.'
      flatCollections.value = flatCollections.value.filter(
        (c: any) => c.id !== id && !(c.path && c.path.startsWith(prefix))
      )
    } else {
      flatCollections.value = flatCollections.value.filter((c: any) => c.id !== id)
    }
  }

  function upsertInTree(collection: any) {
    const idx = flatCollections.value.findIndex((c: any) => c.id === collection.id)
    if (idx >= 0) {
      flatCollections.value[idx] = { ...flatCollections.value[idx], ...collection }
    } else {
      flatCollections.value.push(collection)
    }
  }

  function resetExpandedPaths() {
    expandedPaths.value = new Set()
  }

  function findNodeById(id: string): any | null {
    function walk(nodes: any[]): any | null {
      for (const node of nodes) {
        if (node.id === id) return node
        const found = walk(node.children)
        if (found) return found
      }
      return null
    }
    return walk(tree.value)
  }

  function isDescendantOf(sourceId: string | null, targetId: string | null): boolean {
    if (!sourceId || !targetId) return false
    const source = findNodeById(sourceId)
    if (!source) return false
    const target = findNodeById(targetId)
    if (!target) return false
    return target.path.startsWith(source.path + '.')
  }

  let listenersRegistered = false

  function registerEventListeners() {
    if (listenersRegistered) return
    listenersRegistered = true

    onAiDataRefresh((event) => {
      if (event.type === 'collections') {
        const isCreate =
          event.toolName === 'create_collection' ||
          event.toolName === 'create_sub_collection'
        loadCollections({ expandParents: isCreate })
      }
    })

    if (typeof window !== 'undefined') {
      window.addEventListener('clipsync:collections-updated', (e) => {
        const detail = (e as CustomEvent)?.detail as
          | { reason?: string; id?: string }
          | undefined
        const isCreate =
          detail?.reason === 'ai-tool' ||
          detail?.reason === 'create' ||
          detail?.reason === 'create-from-popover'
        loadCollections({ expandParents: isCreate })
      })
    }
  }

  async function init() {
    if (initialized.value) return
    initialized.value = true
    registerEventListeners()
    await loadCollections()
  }

  function reset() {
    initialized.value = false
    flatCollections.value = []
    expandedPaths.value = new Set()
  }

  return {
    // state
    flatCollections,
    expandedPaths,
    loading,
    initialized,
    // getters
    tree,
    visibleNodes,
    // actions
    init,
    loadCollections,
    toggleExpand,
    expandPath,
    removeFromTree,
    upsertInTree,
    resetExpandedPaths,
    reset,
    findNodeById,
    isDescendantOf,
    registerEventListeners,
  }
})