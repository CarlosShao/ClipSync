# 06 — Migration: flatten existing collections to root

**What to build:** 确保现有扁平收藏夹数据在新层级结构中正确迁移，零数据丢失。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 现有收藏夹 `path = id::text::ltree`（全部变为根节点）
- [ ] 现有 `favorite_collection_items` 保持原样（条目归属不变）
- [ ] 迁移后 `SELECT path, nlevel(path) FROM favorite_collections` 返回 `nlevel = 1`
- [ ] 前端 `GET /collections` 返回 `path` 后树形渲染正确显示单层
- [ ] 升级前/后数据一致性检查（行数、条目关联数不变）
