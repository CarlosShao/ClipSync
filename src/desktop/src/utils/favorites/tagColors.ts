/**
 * Tag color utilities for Favorites
 */

export const TAG_PRESET_COLORS = [
  '#6366F1',
  '#EC4899',
  '#F59E0B',
  '#10B981',
  '#3B82F6',
  '#8B5CF6',
  '#EF4444',
  '#06B6D4',
  '#F97316',
  '#14B8A6',
]

export const TAG_AUTO_COLORS = [
  '#6366F1',
  '#EC4899',
  '#F59E0B',
  '#10B981',
  '#3B82F6',
  '#8B5CF6',
  '#EF4444',
  '#06B6D4',
  '#F97316',
  '#14B8A6',
]

export function getTagAutoColor(tag: string): string {
  let hash = 0
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash)
  return TAG_AUTO_COLORS[Math.abs(hash) % TAG_AUTO_COLORS.length]
}

export function getTagDisplayColor(tag: string, colorMap: Record<string, string>): string {
  return colorMap[tag] || getTagAutoColor(tag)
}

export function tagColorStyle(tag: string, colorMap: Record<string, string>): string {
  const c = getTagDisplayColor(tag, colorMap)
  return `--tag-c: ${c}; --tag-c-bg: ${c}25; --tag-c-border: ${c}60;`
}
