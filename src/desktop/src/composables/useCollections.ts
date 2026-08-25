import { ref, computed, nextTick } from 'vue'
import {
  getFavoriteCollections,
  createFavoriteCollection,
  deleteFavoriteCollection,
  moveCollection as apiMoveCollection,
  getCollectionItems,
  updateFavoriteCollection,
  migrateHierarchy,
  reorderCollections,
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
  sort_order: number
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
      // 如果找不到父节点（孤儿子节点），提升为根节点
      if (!found) roots.push(node)
    }
  }

  function sortChildren(n: CollectionNode) {
    n.children.sort((a, b) => a.sort_order - b.sort_order || a.path.localeCompare(b.path))
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

  // Context menu node (for template checks like root/depth)
  const ctxMenuNode = computed<CollectionNode | null>(() => {
    if (!ctxMenuNodeId.value) return null
    return findNodeById(tree.value, ctxMenuNodeId.value)
  })

  // Flyout state (hover preview of children)
  const flyoutNodeId = ref<string | null>(null)
  const flyoutTimer = ref<number | null>(null)

  // Drag state
  const dragNodeId = ref<string | null>(null)
  const dragOverNodeId = ref<string | null>(null)
  const dropTargetId = ref<string | null>(null)
  const dropPosition = ref<'before' | 'after' | 'inside' | null>(null)

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

  // Flat list of all nodes (ignores expanded state) for pickers/dropdowns
  const allNodes = computed<CollectionNode[]>(() => {
    const result: CollectionNode[] = []
    function walk(nodes: CollectionNode[] | undefined) {
      if (!nodes) return
      for (const node of nodes) {
        if (!node) continue
        result.push(node)
        walk(node.children)
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
  // 暴露成命名导出，组件（如 FavoritesView）无需构造整个 composable 实例即可查询 tree
  function _findNodeById(id: string): CollectionNode | null {
    return findNodeById(tree.value, id)
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

  // Get parent id of a node by path
  function getParentId(node: CollectionNode): string | null {
    const parts = node.path.split('.')
    if (parts.length <= 1) return null
    const parentPath = parts.slice(0, -1).join('.')
    const parent = findNodeByPath(tree.value, parentPath)
    return parent?.id || null
  }

  // Get all sibling node IDs under a given parent (null = root)
  function getSiblings(parentId: string | null): CollectionNode[] {
    return (tree.value || []).filter((n) => getParentId(n) === parentId)
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
      // 收藏夹树结构由 flatCollections 派生（computed buildTree）。
      // 仅 push 新节点到 flatCollections 并标记 parent 展开，可能因为后端 path 缓存与前端
      // 不一致导致 buildTree 计算的父子关系错位、新节点不显示。
      // 安全做法：直接从后端重新拉一次，让 tree 跟后端真相源对齐。
      const res = await getFavoriteCollections()
      if (res?.collections) {
        flatCollections.value = res.collections
        // 保留用户已展开的路径（不重置 expandedPaths）
        if (expandedPaths.value.size === 0) {
          expandToDepth(tree.value, 2)
          syncExpandedState(tree.value, expandedPaths.value)
        }
      }
      if (parentId) {
        // 拉完后再次展开 parent，确保用户看到新建的子节点
        const parent = findNodeById(tree.value, parentId)
        if (parent) {
          parent.expanded = true
          expandedPaths.value.add(parent.path)
          expandedPaths.value = new Set(expandedPaths.value)
        }
      }
      // 通知其它使用收藏夹列表的组件（如剪贴板的筛选下拉）也重新拉取
      // 跨 composable 单例同步，避免剪贴板看不到刚在收藏页新建的子目录
      window.dispatchEvent(new CustomEvent('clipsync:collections-updated', { detail: { reason: 'create', id: data.collection.id } }))
    }
    return data
  }

  async function deleteCollection(id: string) {
    // 后端会级联删除目标及所有后代（ltree path <@）。
    // 前端必须在 flatCollections 里删掉**目标 + 所有后代**，否则子节点变成"孤儿"被 buildTree 当顶级渲染。
    const targetNode = findNodeById(tree.value, id)
    const targetPath = targetNode?.path
    await deleteFavoriteCollection(id)
    if (targetPath) {
      const prefix = targetPath + '.'
      flatCollections.value = flatCollections.value.filter(
        (c) => c.id !== id && !c.path.startsWith(prefix),
      )
    } else {
      flatCollections.value = flatCollections.value.filter((c) => c.id !== id)
    }
    if (activeNodeId.value === id) activeNodeId.value = null
    closeCtxMenu()
    // 跨组件同步事件：剪贴板筛选下拉也刷新
    window.dispatchEvent(new CustomEvent('clipsync:collections-updated', { detail: { reason: 'delete', id } }))
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
      flatCollections.value = flatCollections.value.map((c) => {
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

  // Signal to parent: open new-collection input under this parent
  const newSubCollectionParentId = ref<string | null>(null)

  async function ctxRename() {
    if (!ctxMenuNodeId.value) return
    startRename(ctxMenuNodeId.value)
    closeCtxMenu()
  }

  function startRename(nodeId: string | null) {
    if (!nodeId) return
    const node = findNodeById(tree.value, nodeId)
    if (!node) return
    renamingNodeId.value = nodeId
    renameValue.value = node.name
    renameConfirmed.value = false
  }

  async function ctxNewSubCollection() {
    const parentId = ctxMenuNodeId.value
    // Signal to parent: open new-collection input under this parent
    newSubCollectionParentId.value = parentId
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
    // 不直接删：发全局事件，让宿主组件（FavoritesView 等）弹二次确认框后真正删除。
    // 避免误删父级目录。
    const id = ctxMenuNodeId.value
    closeCtxMenu()
    if (id) {
      window.dispatchEvent(new CustomEvent('clipsync:collection-delete-requested', { detail: { id } }))
    }
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
    nextTick(() => {
      renameConfirmed.value = false
    })
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

  function computeDropPosition(event: DragEvent): 'before' | 'after' | 'inside' {
    const target = event.currentTarget as HTMLElement | null
    if (!target) return 'inside'
    const rect = target.getBoundingClientRect()
    const y = event.clientY - rect.top
    const height = rect.height || 1
    if (y < height * 0.25) return 'before'
    if (y > height * 0.75) return 'after'
    return 'inside'
  }

  function onDragOver(targetId: string | null, event: DragEvent) {
    const draggedId = dragNodeId.value
    if (!draggedId || draggedId === targetId) return
    if (targetId && isDescendantOf(draggedId, targetId)) return
    event.preventDefault()
    dropTargetId.value = targetId
    dropPosition.value = computeDropPosition(event)
    dragOverNodeId.value = targetId
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move'
    }
  }

  function onDragLeave(event: DragEvent) {
    // Ignore dragleave when the cursor is still inside this element or a child
    const related = event.relatedTarget as HTMLElement | null
    const current = event.currentTarget as HTMLElement | null
    if (related && current && current.contains(related)) return
    dragOverNodeId.value = null
    if (dropTargetId.value !== null) {
      dropTargetId.value = null
      dropPosition.value = null
    }
  }

  // Reassign sequential sort_order within a parent, placing draggedId at targetIndex.
  // targetIndex is expressed relative to the full sibling list (including dragged).
  // The dragged node is removed first, then inserted at the equivalent position.
  async function setOrderAtIndex(draggedId: string, parentId: string | null, targetIndex: number) {
    const siblings = getSiblings(parentId)
    const draggedIdx = siblings.findIndex((n) => n.id === draggedId)
    const others = siblings.filter((n) => n.id !== draggedId)

    // Adjust insertion index after removing the dragged item
    let insertIndex = targetIndex
    if (draggedIdx >= 0 && targetIndex > draggedIdx) {
      insertIndex = targetIndex - 1
    }
    insertIndex = Math.max(0, Math.min(insertIndex, others.length))

    const ordered = [...others]
    const moved = draggedIdx >= 0 ? siblings[draggedIdx] : findNodeById(tree.value, draggedId)
    if (moved) ordered.splice(insertIndex, 0, moved)

    const orders = ordered.map((n, i) => ({ id: n.id, sortOrder: i }))

    // Optimistically update local state
    flatCollections.value = flatCollections.value.map((c) => {
      const o = orders.find((o) => o.id === c.id)
      if (o) return { ...c, sort_order: o.sortOrder }
      return c
    })

    try {
      await reorderCollections(orders)
    } catch (e: any) {
      console.warn('[collections] reorder failed:', e)
      toast.show(e.message || '排序收藏夹失败', 'error')
      await loadCollections()
    }
  }

  async function reorderCollection(
    draggedId: string,
    targetId: string | null,
    position: 'before' | 'after' | 'inside' | null,
  ) {
    const draggedNode = findNodeById(tree.value, draggedId)
    if (!draggedNode) return

    // Step 1: handle parent changes first so the rest of the math is based on the new tree
    if (position === 'inside' && targetId) {
      const currentParentId = getParentId(draggedNode)
      if (currentParentId !== targetId) {
        await moveCollection(draggedId, targetId)
      }
    } else if (targetId === null) {
      // Root drop zones
      const currentParentId = getParentId(draggedNode)
      if (currentParentId !== null) {
        await moveCollection(draggedId, null)
      }
    }

    // Step 2: compute final ordering based on the (possibly updated) tree
    const targetNode = targetId ? findNodeById(tree.value, targetId) : null
    let targetParentId: string | null
    let targetIndex: number

    if (position === 'inside') {
      targetParentId = targetId
      const children = targetNode ? targetNode.children : []
      targetIndex = children.length
    } else if (targetNode) {
      targetParentId = getParentId(targetNode)
      const siblings = getSiblings(targetParentId)
      const idx = siblings.findIndex((n) => n.id === targetId)
      if (position === 'before') {
        targetIndex = Math.max(0, idx)
      } else {
        targetIndex = idx + 1
      }
    } else {
      // Root drop zones
      targetParentId = null
      const siblings = getSiblings(null)
      targetIndex = position === 'after' ? siblings.length : 0
    }

    await setOrderAtIndex(draggedId, targetParentId, targetIndex)
  }

  async function onDrop(targetId: string | null) {
    const draggedId = dragNodeId.value
    const position = dropPosition.value
    dragOverNodeId.value = null
    dropTargetId.value = null
    dropPosition.value = null
    if (!draggedId || draggedId === targetId) {
      dragNodeId.value = null
      return
    }
    if (targetId && isDescendantOf(draggedId, targetId)) {
      dragNodeId.value = null
      return
    }
    try {
      await reorderCollection(draggedId, targetId, position)
    } catch (e: any) {
      console.warn('[collections] drop failed:', e)
      toast.show(e.message || '移动收藏夹失败', 'error')
    } finally {
      dragNodeId.value = null
    }
  }

  // Root / top-of-list drop zone
  function onDragOverRoot(event: DragEvent) {
    const draggedId = dragNodeId.value
    if (!draggedId) return
    event.preventDefault()
    dropTargetId.value = null
    dropPosition.value = 'before'
    dragOverNodeId.value = null
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }
  function onDragLeaveRoot() {
    if (dropTargetId.value === null && dropPosition.value === 'before') {
      dropPosition.value = null
    }
  }
  async function onDropRoot() {
    const draggedId = dragNodeId.value
    dragOverNodeId.value = null
    dropTargetId.value = null
    dropPosition.value = null
    if (!draggedId) return
    try {
      await reorderCollection(draggedId, null, 'before')
    } catch (e: any) {
      console.warn('[collections] drop root failed:', e)
      toast.show(e.message || '移动到根目录失败', 'error')
    } finally {
      dragNodeId.value = null
    }
  }

  // Bottom-of-list drop zone (move to root at last position)
  function onDragOverBottom(event: DragEvent) {
    const draggedId = dragNodeId.value
    if (!draggedId) return
    event.preventDefault()
    dropTargetId.value = null
    dropPosition.value = 'after'
    dragOverNodeId.value = null
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }
  function onDragLeaveBottom() {
    if (dropTargetId.value === null && dropPosition.value === 'after') {
      dropPosition.value = null
    }
  }
  async function onDropBottom() {
    const draggedId = dragNodeId.value
    dragOverNodeId.value = null
    dropTargetId.value = null
    dropPosition.value = null
    if (!draggedId) return
    try {
      await reorderCollection(draggedId, null, 'after')
    } catch (e: any) {
      console.warn('[collections] drop bottom failed:', e)
      toast.show(e.message || '移动到根目录失败', 'error')
    } finally {
      dragNodeId.value = null
    }
  }

  function onDragEnd() {
    dragNodeId.value = null
    dragOverNodeId.value = null
    dropTargetId.value = null
    dropPosition.value = null
  }

  return {
    tree,
    visibleNodes,
    allNodes,
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
    ctxMenuNode,
    ctxMenuPos,
    ctxMenuVisible,
    openCtxMenu,
    closeCtxMenu,
    ctxRename,
    startRename,
    ctxNewSubCollection,
    newSubCollectionParentId,
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
    dropTargetId,
    dropPosition,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
    onDragOverRoot,
    onDragLeaveRoot,
    onDropRoot,
    onDragOverBottom,
    onDragLeaveBottom,
    onDropBottom,
    findNodeById: _findNodeById,
  }
}

// ============ AI 数据刷新事件监听 ============
// 当 AI Agent 执行收藏夹相关工具后，自动刷新收藏夹数据实现无感更新
import { onAiDataRefresh } from './useAiDataRefresh'

if (typeof window !== 'undefined' && !(window as any).__collectionsAiRefreshInited) {
  ;(window as any).__collectionsAiRefreshInited = true
  
  onAiDataRefresh((event) => {
    if (event.type === 'collections') {
      // 静默刷新收藏夹数据
      const data = getFavoriteCollections().catch(() => null)
      if (data?.collections) {
        // 找到 useCollections 的实例并刷新
        // 这里通过 window 事件通知已有实例
        window.dispatchEvent(new CustomEvent('clipsync:collections-updated', { 
          detail: { reason: 'ai-tool', tool: event.toolName } 
        }))
      }
    }
  })
}
