# 04 — Frontend: tree sidebar rendering

**What to build:** 收藏夹侧边栏从水平 tab 栏改为垂直树形结构，带缩进、展开/折叠三角、图标+名称+条目数、面包屑导航。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 侧边栏替换水平 tab 栏为垂直树形列表
- [ ] 每个父节点有展开/折叠三角图标（ChevronRight / ChevronDown）
- [ ] 树形缩进（`padding-left` 按 depth 递增）
- [ ] 节点显示图标 + 名称 + 条目数徽章
- [ ] 顶部面包屑导航（`root > models > AI`），每段可点击跳转
- [ ] 点击节点 → 选中并加载直接子条目
- [ ] 内容区显示选中收藏夹的直接子条目 + 子收藏夹快速访问行
