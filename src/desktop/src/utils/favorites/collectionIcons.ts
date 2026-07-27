/**
 * Collection icon utilities for Favorites
 */
import {
  Folder,
  FolderOpen,
  FolderPlus,
  FolderX,
  FolderSearch,
  FolderInput,
  FolderOutput,
  FolderSync,
  Star,
  Heart,
  Zap,
  Shield,
  Globe,
  Code2,
  Music,
  Video,
  Settings,
  Palette,
} from 'lucide-vue-next'

export const COLLECTION_ICON_MAP: Record<string, any> = {
  folder: Folder,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  'folder-x': FolderX,
  'folder-search': FolderSearch,
  'folder-input': FolderInput,
  'folder-output': FolderOutput,
  'folder-sync': FolderSync,
  star: Star,
  heart: Heart,
  zap: Zap,
  shield: Shield,
  globe: Globe,
  code: Code2,
  music: Music,
  video: Video,
  settings: Settings,
  palette: Palette,
}

export function renderCollectionIcon(iconName: string, size = 14) {
  const comp = COLLECTION_ICON_MAP[iconName] || Folder
  return comp
}
