# 03 — Frontend: collection types + useCollections composable

**What to build:** 收藏夹的 TypeScript 类型定义和 `useCollections` 组合式函数，管理树形状态、展开/折叠、选中节点和面包屑。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 定义 `FavoriteCollection` 接口（`id`, `name`, `icon`, `path`, `sort_order`, `item_count`, `created_at`）
- [ ] 定义 `FavoriteCollectionItem` 接口
- [ ] 新建 `useCollections` composable：从服务端扁平列表构建树形结构
- [ ] 树形节点包含 `children[]`, `depth`, `expanded` 状态
- [ ] 面包屑栈管理（当前路径 → 祖先路径数组）
- [ ] 选中节点管理（当前 active collection）
- [ ] 替换 FavoritesView 中 `collections: any[]` 为 `useCollections` 返回的树形状态
