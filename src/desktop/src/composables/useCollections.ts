import { ref, computed, nextTick } from 'vue'
import {
  getFavoriteCollections, createFavoriteCollection, deleteFavoriteCollection,
  moveCollection as apiMoveCollection, getCollectionItems, updateFavoriteCollection,
  migrateHierarchy,
} from '@/api/client'
import { useSonner } from '@/composables/useSonner'

export interface CollectionNode {
  id: string
  name: string
  icon: string
  path: string
  depth: number
  children: CollectionNode[]
  expanded: boolean
  item_count: number
}

// Build tree from flat list sorted by ltree path
function buildTree(flat: any[]): CollectionNode[] {
  const nodes: Map<string, CollectionNode> = new Map()
  const roots: CollectionNode[] = []

  for (const row of flat) {
    const rowId = row?.id
    const rowPath = row?.path
    const pathStr = typeof rowPath === 'string' ? rowPath : String(rowPath ?? '')
    if (!row || !rowId) continue // skip invalid entries
    // 兜底：path 为空时自动生成根节点路径（兼容迁移未覆盖的数据）
    const finalPath = pathStr || 'root.' + rowId.replace(/-/g, '_')
    const parts = finalPath.split('.')
    const depth = parts.length
    const node: CollectionNode = {
      id: row.id,
      name: row.name || 'Untitled',
      icon: row.icon || 'folder',
      path: finalPath,
      depth,
      children: [],
      expanded: false,
      item_count: row.item_count || 0,
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
      // 如果找不到父节点（孤儿子节点），提升为根节点
      if (!found) roots.push(node)
    }
  }

  function sortChildren(n: CollectionNode) {
    n.children.sort((a, b) => a.path.localeCompare(b.path))
    n.children.forEach(sortChildren)
  }
  roots.forEach(sortChildren)

  return roots
}

// Expand all nodes up to a given depth
function expandToDepth(nodes: CollectionNode[], depth: number) {
  for (const node of nodes) {
    if (node.depth < depth) node.expanded = true
    expandToDepth(node.children, depth)
  }
}

export function useCollections() {
  const toast = useSonner()
  const flatCollections = ref<any[]>([])
  const activeNodeId = ref<string | null>(null)
  const expandedPaths = ref<Set<string>>(new Set())
  const collectionItemsMap = ref<Map<string, Set<string>>>(new Map())
  const collectionsLoaded = ref<Set<string>>(new Set())
  const loading = ref(false)

  // Context menu state
  const ctxMenuNodeId = ref<string | null>(null)
  const ctxMenuPos = ref({ top: 0, left: 0 })
  const ctxMenuVisible = ref(false)

  // Flyout state (hover preview of children)
  const flyoutNodeId = ref<string | null>(null)
  const flyoutTimer = ref<number | null>(null)

  // Drag state
  const dragNodeId = ref<string | null>(null)
  const dragOverNodeId = ref<string | null>(null)

  // Inline rename state
  const renamingNodeId = ref<string | null>(null)
  const renameValue = ref('')
  const renameConfirmed = ref(false) // guard against blur double-call

  const tree = computed<CollectionNode[]>(() => buildTree(flatCollections.value))

  // Flat list of visible nodes (respects expanded state) for template rendering
  const visibleNodes = computed<CollectionNode[]>(() => {
    const result: CollectionNode[] = []
    function walk(nodes: CollectionNode[] | undefined) {
      if (!nodes) return
      for (const node of nodes) {
        if (!node) continue
        result.push(node)
        const children = node.children || []
        if (children.length > 0 && expandedPaths.value.has(node.path)) {
          walk(children)
        }
      }
    }
    walk(tree.value)
    return result
  })

  // Breadcrumb: path from root to active node
  const breadcrumb = computed<CollectionNode[]>(() => {
    if (!activeNodeId.value) return []
    const node = findNodeById(tree.value, activeNodeId.value)
    if (!node) return []
    const pathParts = node.path.split('.')
    const crumbs: CollectionNode[] = []
    let currentPath = ''
    for (const part of pathParts) {
      currentPath = currentPath ? `${currentPath}.${part}` : part
      const found = findNodeByPath(tree.value, currentPath)
      if (found) crumbs.push(found)
    }
    return crumbs
  })

  function findNodeById(nodes: CollectionNode[], id: string): CollectionNode | null {
    for (const node of nodes) {
      if (node.id === id) return node
      const found = findNodeById(node.children, id)
      if (found) return found
    }
    return null
  }

  function findNodeByPath(nodes: CollectionNode[], path: string): CollectionNode | null {
    for (const node of nodes) {
      if (node.path === path) return node
      const found = findNodeByPath(node.children, path)
      if (found) return found
    }
    return null
  }

  // Check if targetId is a descendant of sourceId (prevents circular refs)
  function isDescendantOf(sourceId: string | null, targetId: string | null): boolean {
    if (!sourceId || !targetId) return false
    const source = findNodeById(tree.value, sourceId)
    if (!source) return false
    const target = findNodeById(tree.value, targetId)
    if (!target) return false
    // If target path starts with source path, target is a descendant
    return target.path.startsWith(source.path + '.')
  }

  // Auto-expand path when selecting a node deep in the tree
  async function selectNode(id: string | null) {
    if (id) {
      // 先加载收藏夹内容，再激活筛选，避免 computed 读到空状态
      await loadNodeItems(id)
      const node = findNodeById(tree.value, id)
      if (node) {
        const pathParts = node.path.split('.')
        for (let i = 1; i < pathParts.length; i++) {
          const ancestorPath = pathParts.slice(0, i).join('.')
          expandedPaths.value.add(ancestorPath)
        }
        expandedPaths.value = new Set(expandedPaths.value)
      }
    }
    activeNodeId.value = id
    closeCtxMenu()
    closeFlyout()
  }

  async function loadCollections() {
    loading.value = true
    try {
      const data = await getFavoriteCollections()
      if (data?.collections && data.collections.length > 0) {
        flatCollections.value = data.collections
        if (expandedPaths.value.size === 0) {
          expandToDepth(tree.value, 2)
          syncExpandedState(tree.value, expandedPaths.value)
        }
      } else if (data?.collections && data.collections.length === 0) {
        flatCollections.value = []
      } else {
        toast.show('正在修复收藏夹数据...', 'info')
        const migrated = await migrateHierarchy()
        if (migrated) {
          expandedPaths.value = new Set()
          const retry = await getFavoriteCollections()
          if (retry?.collections && retry.collections.length > 0) {
            flatCollections.value = retry.collections
            expandToDepth(tree.value, 2)
            syncExpandedState(tree.value, expandedPaths.value)
            toast.show(`已恢复 ${retry.collections.length} 个收藏夹`, 'success')
          } else {
            flatCollections.value = []
            toast.show('收藏夹为空', 'info')
          }
        } else {
          toast.show('收藏夹迁移失败，请重启后端服务', 'error')
        }
      }
    } catch (e: any) {
      toast.show(e.message || '加载收藏夹失败', 'error')
    } finally {
      loading.value = false
    }
  }

  function syncExpandedState(nodes: CollectionNode[], set: Set<string>) {
    for (const node of nodes) {
      if (node.expanded) set.add(node.path)
      syncExpandedState(node.children, set)
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

  async function createCollection(name: string, icon: string, parentId?: string) {
    const data = await createFavoriteCollection(name, icon, parentId)
    if (data?.collection) {
      flatCollections.value = [...flatCollections.value, data.collection]
      if (parentId) {
        const parent = findNodeById(tree.value, parentId)
        if (parent) {
          parent.expanded = true
          expandedPaths.value.add(parent.path)
        }
      }
    }
    return data
  }

  async function deleteCollection(id: string) {
    await deleteFavoriteCollection(id)
    flatCollections.value = flatCollections.value.filter(c => c.id !== id)
    if (activeNodeId.value === id) activeNodeId.value = null
    closeCtxMenu()
  }

  async function moveCollection(id: string, parentId: string | null) {
    const data = await apiMoveCollection(id, parentId)
    if (!data?.collection) {
      throw new Error('移动收藏夹失败')
    }
    const oldPath = findNodeById(tree.value, id)?.path
    if (oldPath) {
      const oldPrefix = oldPath + '.'
      const newPrefix = data.collection.path + '.'
      flatCollections.value = flatCollections.value.map(c => {
        if (c.id === id) {
          return { ...c, path: data.collection.path }
        } else if (c.path.startsWith(oldPrefix)) {
          return { ...c, path: c.path.replace(oldPrefix, newPrefix) }
        }
        return c
      })
    } else {
      // If old path not found in tree (e.g. null path), reload to be safe
      await loadCollections()
    }
    closeCtxMenu()
    return data
  }

  async function loadNodeItems(id: string) {
    if (collectionsLoaded.value.has(id)) return collectionItemsMap.value.get(id)
    const data = await getCollectionItems(id)
    const newMap = new Map(collectionItemsMap.value)
    if (data?.items && data.items.length > 0) {
      newMap.set(id, new Set(data.items.map((i: any) => i.id)))
    } else {
      newMap.set(id, new Set())
    }
    collectionItemsMap.value = newMap
    collectionsLoaded.value = new Set(collectionsLoaded.value)
    collectionsLoaded.value.add(id)
    return newMap.get(id)
  }

  // ---- Context menu ----
  function openCtxMenu(nodeId: string, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    ctxMenuNodeId.value = nodeId
    ctxMenuPos.value = { top: event.clientY, left: event.clientX }
    ctxMenuVisible.value = true
    closeFlyout()
  }

  function closeCtxMenu() {
    ctxMenuVisible.value = false
    ctxMenuNodeId.value = null
  }

  async function ctxRename() {
    const node = findNodeById(tree.value, ctxMenuNodeId.value!)
    if (node) {
      renamingNodeId.value = node.id
      renameValue.value = node.name
    }
    closeCtxMenu()
  }

  async function ctxNewSubCollection() {
    const parentId = ctxMenuNodeId.value
    // Signal to parent: open new-collection input under this parent
    ctxMenuNodeId.value = '___new_sub___' + parentId
    ctxMenuVisible.value = false // close the context menu
  }

  async function ctxMoveToRoot() {
    if (ctxMenuNodeId.value) {
      try {
        await moveCollection(ctxMenuNodeId.value, null)
      } catch (e: any) {
        console.warn('[collections] move to root failed:', e)
        toast.show(e.message || '移动到根目录失败', 'error')
      }
    }
    closeCtxMenu()
  }

  async function ctxDelete() {
    if (ctxMenuNodeId.value) {
      await deleteCollection(ctxMenuNodeId.value)
    }
    closeCtxMenu()
  }

  async function confirmRename() {
    if (renameConfirmed.value) return // guard: already confirmed via Enter
    renameConfirmed.value = true
    if (renamingNodeId.value && renameValue.value.trim()) {
      await updateFavoriteCollection(renamingNodeId.value, { name: renameValue.value.trim() })
      const node = findNodeById(tree.value, renamingNodeId.value)
      if (node) node.name = renameValue.value.trim()
    }
    renamingNodeId.value = null
    renameValue.value = ''
    // Reset guard after a tick so future renames work
    nextTick(() => { renameConfirmed.value = false })
  }

  function cancelRename() {
    renameConfirmed.value = false
    renamingNodeId.value = null
    renameValue.value = ''
  }

  // ---- Flyout (hover preview of children) ----
  function openFlyout(nodeId: string) {
    if (flyoutTimer.value) clearTimeout(flyoutTimer.value)
    flyoutTimer.value = window.setTimeout(() => {
      flyoutNodeId.value = nodeId
    }, 200)
  }

  function closeFlyout() {
    if (flyoutTimer.value) clearTimeout(flyoutTimer.value)
    flyoutNodeId.value = null
  }

  // ---- Drag and drop ----
  function onDragStart(nodeId: string, event: DragEvent) {
    dragNodeId.value = nodeId
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', nodeId)
      event.dataTransfer.effectAllowed = 'move'
    }
  }

  function onDragOver(targetId: string | null, event: DragEvent) {
    const draggedId = dragNodeId.value
    if (!draggedId || draggedId === targetId) return
    if (targetId && isDescendantOf(draggedId, targetId)) return
    dragOverNodeId.value = targetId
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move'
    }
  }

  function onDragLeave() {
    dragOverNodeId.value = null
  }

  async function onDrop(targetId: string | null) {
    const draggedId = dragNodeId.value
    dragOverNodeId.value = null
    if (!draggedId || draggedId === targetId) {
      dragNodeId.value = null
      return
    }
    // targetId === null means "move to root"
    if (targetId && isDescendantOf(draggedId, targetId)) {
      dragNodeId.value = null
      return
    }
    try {
      await moveCollection(draggedId, targetId)
    } catch (e: any) {
      console.warn('[collections] drop move failed:', e)
      toast.show(e.message || '移动收藏夹失败', 'error')
    } finally {
      dragNodeId.value = null
    }
  }

  function onDragEnd() {
    dragNodeId.value = null
    dragOverNodeId.value = null
  }

  return {
    tree,
    visibleNodes,
    flatCollections,
    activeNodeId,
    breadcrumb,
    expandedPaths,
    collectionItemsMap,
    collectionsLoaded,
    loading,
    selectNode,
    toggleExpand,
    loadCollections,
    createCollection,
    deleteCollection,
    moveCollection,
    loadNodeItems,
    // Context menu
    ctxMenuNodeId,
    ctxMenuPos,
    ctxMenuVisible,
    openCtxMenu,
    closeCtxMenu,
    ctxRename,
    ctxNewSubCollection,
    ctxMoveToRoot,
    ctxDelete,
    // Rename
    renamingNodeId,
    renameValue,
    confirmRename,
    cancelRename,
    // Flyout
    flyoutNodeId,
    openFlyout,
    closeFlyout,
    // Drag
    dragNodeId,
    dragOverNodeId,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
  }
}
