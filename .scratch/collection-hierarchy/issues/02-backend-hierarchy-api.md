# 02 — Backend API: hierarchy operations

**What to build:** 收藏夹层级操作的后端 API，支持创建子收藏夹、移动收藏夹、级联删除，以及条目唯一归属约束。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `POST /api/favorites/collections` 接受可选 `parentId` 参数，服务器计算子节点 `path = parent.path || '.' || new_id`
- [ ] `PUT /api/favorites/collections/:id/move` 接受 `parentId`，验证目标不是自身后代（防循环引用），更新 `path` 及所有子孙路径
- [ ] `DELETE /api/favorites/collections/:id` 级联删除所有子收藏夹（ltree 路径查询 `path <@ target.path`）
- [ ] `favorite_collection_items` 新增 `item_id` 唯一索引，确保条目在全树范围内唯一归属
- [ ] `GET /api/favorites/collections` 返回 `path` 字段
- [ ] 所有新端点使用 `apiLimiter` 限流
