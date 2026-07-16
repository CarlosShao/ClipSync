# 01 — Database migration: ltree schema

**What to build:** `favorite_collections` 表支持层级结构所需的后端 schema 变更，DBA 可以验证路径查询和级联删除行为。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 在 `favorite_collections` 表新增 `path ltree` 列（dot-separated 路径，如 `.root.1234`）
- [ ] 启用 PostgreSQL `ltree` 扩展（`CREATE EXTENSION IF NOT EXISTS ltree`）
- [ ] 创建 GIST 索引 `idx_favcol_path` on `favorite_collections(path)` 以加速子树查询
- [ ] 数据迁移：现有收藏夹的 `path` 设为自身 `id`（全部变为根节点，`parent_id = null`）
- [ ] 级联删除验证：删除父收藏夹时子收藏夹和条目均被清理
- [ ] 迁移脚本幂等（可重复执行不报错）
