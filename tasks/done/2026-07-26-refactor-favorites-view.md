---
id: 2026-07-26-refactor-favorites-view
title: 拆分 FavoritesView.vue 为 6 个子组件
priority: done
status: done
source: manual
assignee: ''
module: desktop-frontend
tags:
  - refactor
  - vue
  - favorites
  - css-cleanup
progress: 100
created: '2026-07-26'
updated: '2026-07-26'
lifecycle_id: ''
batchId: batch-20260726-refactor
---

## 目标
将 FavoritesView.vue（3340行）拆分为 6 个职责单一的子组件，合并重复的 CSS 声明。

## 拆分方案
从 FavoritesView.vue 提取以下子组件到 `src/components/favorites/` 目录：

| 子组件 | 职责 | 预估行数 |
|---|---|---|
| FavoritesTree.vue | 左侧文件树/集合管理 | ~600 |
| FavoritesGrid.vue | 网格视图 | ~400 |
| FavoritesList.vue | 列表视图 | ~400 |
| FavoritesContextMenu.vue | 右键菜单 | ~300 |
| FavoritesTagBar.vue | 标签过滤栏 | ~200 |

FavoritesView.vue 保留主容器、状态管理和路由。

## 验收标准
- [ ] FavoritesView.vue 行数减少到 600 行以下
- [ ] 5 个子组件在 `src/components/favorites/` 目录下
- [ ] 收藏列表、文件树、标签过滤、右键菜单功能完整
- [ ] 网格/列表视图切换正常
- [ ] 拖拽功能正常
- [ ] 重复的 CSS 声明已合并
- [ ] 构建通过，无 TypeScript 错误
