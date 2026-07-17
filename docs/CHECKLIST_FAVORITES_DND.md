# 收藏夹优化与修复 Checklist

## 目标
1. 修复收藏夹拖拽排序/嵌套无效
2. 新建收藏夹输入行改为无感创建（与现有列表图标对齐、无额外留白）
3. 移除左侧拖拽把手（GripVertical）

## 根因排查（Phase 1: Scan）
- [x] 复核 `useCollections.ts` 拖拽排序逻辑
- [x] 复核 `FavoritesView.vue` 拖拽事件绑定与样式
- [x] 复核后端 `favorites.js` move/reorder 路由
- [x] 检查数据库 favorite_collections path/sort_order 状态
- [x] 检查后端运行日志中是否有拖拽相关错误

## 修复与改造
- [x] 修复 `setOrderAtIndex`：移除 dragged 后重新计算插入位置，避免 before/after 错位
- [x] 修复 `reorderCollection`：跨父级移动后重新计算 targetIndex，避免旧树索引失效
- [x] 改进 dragleave 处理，避免子元素间移动时状态闪烁
- [x] 从 `FavoritesView.vue` 树节点移除 `.fav-tree-drag-handle`
- [x] 从新建收藏夹输入行移除拖拽把手占位
- [x] 重新设计输入行样式：图标与下面收藏夹对齐、无突出边框、无额外留白
- [x] 清理不再使用的 `.fav-tree-drag-handle` CSS
- [x] 移除 `GripVertical` 导入（如不再使用）

## 验证
- [x] `vue-tsc --noEmit` 通过
- [x] `node --check src/routes/favorites.js` 通过
- [x] 未改动后端，无需重启 `clipsync` 容器
- [x] 检查最终 diff，确认无意外改动

## 完成报告
- [x] 输出标准反糊弄报告（完成度、验证证据、遗留风险）
