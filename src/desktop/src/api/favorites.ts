// ============================================
// Favorites API（收藏集合 / 标签）
// ============================================
import { api } from './client'

export async function getFavoriteCollections(): Promise<{ collections: any[] } | null> {
  const res = await api('GET', '/api/favorites/collections')
  return res.ok ? res.data : null
}

/** Run ltree hierarchy migration on the database (idempotent). */
export async function migrateHierarchy(): Promise<boolean> {
  const res = await api('POST', '/api/favorites/migrate-hierarchy')
  return res.ok
}

export async function createFavoriteCollection(
  name: string,
  icon?: string,
  parentId?: string,
): Promise<{ collection: any } | null> {
  const body: any = { name, icon }
  if (parentId) body.parentId = parentId
  const res = await api('POST', '/api/favorites/collections', body)
  return res.ok ? res.data : null
}

export async function updateFavoriteCollection(
  id: string,
  data: { name?: string; icon?: string; sortOrder?: number },
): Promise<{ collection: any } | null> {
  const res = await api('PUT', `/api/favorites/collections/${id}`, data)
  return res.ok ? res.data : null
}

export async function deleteFavoriteCollection(id: string): Promise<boolean> {
  const res = await api('DELETE', `/api/favorites/collections/${id}`)
  return res.ok
}

export async function moveCollection(id: string, parentId: string | null): Promise<{ collection: any } | null> {
  const res = await api('PUT', `/api/favorites/collections/${id}/move`, { parentId })
  return res.ok ? res.data : null
}

export async function reorderCollections(orders: { id: string; sortOrder: number }[]): Promise<boolean> {
  const res = await api('PUT', '/api/favorites/collections/reorder', { orders })
  return res.ok
}

export async function addCollectionItem(collectionId: string, itemId: string): Promise<boolean> {
  const res = await api('POST', `/api/favorites/collections/${collectionId}/items`, { itemId })
  return res.ok
}

export async function removeCollectionItem(collectionId: string, itemId: string): Promise<boolean> {
  const res = await api('DELETE', `/api/favorites/collections/${collectionId}/items/${itemId}`)
  return res.ok
}

export async function getCollectionItems(collectionId: string): Promise<{ items: any[] } | null> {
  const res = await api('GET', `/api/favorites/collections/${collectionId}/items`)
  return res.ok ? res.data : null
}

export async function setItemTags(
  itemId: string,
  tags: string[],
  tagColors?: Record<string, string>,
): Promise<{ tags: string[]; tagColors: Record<string, string> } | null> {
  const body: any = { tags }
  if (tagColors) body.tagColors = tagColors
  const res = await api('PUT', `/api/favorites/${itemId}/tags`, body)
  return res.ok ? res.data : null
}

export async function deleteTag(tagName: string): Promise<boolean> {
  const res = await api('DELETE', `/api/favorites/tags/${encodeURIComponent(tagName)}`)
  return res.ok
}

export interface FavoriteTag {
  name: string
  color: string | null
}
export async function getAllFavoriteTags(): Promise<FavoriteTag[]> {
  const res = await api('GET', '/api/favorites/tags')
  return res.ok ? res.data?.tags || [] : []
}

/** Toggle manual sensitive flag on a clipboard item */
export async function toggleSensitive(
  itemId: string,
  sensitive: boolean,
): Promise<{ id: string; sensitive: boolean } | null> {
  const res = await api('PUT', `/api/clipboard/${itemId}/sensitive`, { sensitive })
  return res.ok ? res.data : null
}
