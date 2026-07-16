# 05 — Frontend: tree interactions

**What to build:** 右键菜单、拖拽嵌套（高亮变色）、悬停 flyout 预览子集，用户可以在树上完成所有组织操作。

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] 右键菜单组件（Teleport to body）：重命名 / 新建子收藏夹 / 移动到 / 删除
- [ ] 右键空白区域 → 新建根收藏夹
- [ ] 新建子收藏夹 → 内联编辑名称 → 调用 `POST /collections` with `parentId`
- [ ] 拖拽收藏夹到另一个收藏夹上方 → 高亮变色反馈 → 调用 `PUT /move`
- [ ] 拖拽到自身后代 → 禁止（无视觉反馈，不调用 API）
- [ ] 同级拖拽重排序 → 水平插入指示器
- [ ] 内联重命名（双击节点名称 → 输入框 → Enter 确认 / Escape 取消）
- [ ] 悬停父节点 → flyout 面板显示直接子收藏夹列表 → 点击跳转
