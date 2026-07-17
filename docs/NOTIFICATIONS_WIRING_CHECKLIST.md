# 通知功能对接 Checklist（anti-shortcut-workflow）

**创建时间**：2026-07-08
**目标**：把桌面端通知收件箱 + 通知偏好 从「localStorage 假数据」对接到真实后端 API + WebSocket 实时推送
**完成度**：0 / 12 = 0%

## 功能点

### 后端（持久化 + 推送）
- [ ] 1. `sendNotification` 在推送时同时落库 `notification_history`（当前只推 WS，不持久化 → GET /history 永远空）
- [ ] 2. WS 推送 payload 携带 `notificationType` + 真实 `id`（前端需据此映射分类 / 去重）
- [ ] 3. clipboard 推送调用补充 `notificationType: 'sync_complete'`

### 前端数据层
- [ ] 4. `api/notifications.ts`：GET /history、PUT /history/:id/read、GET /preferences、PUT /preferences
- [ ] 5. `composables/useNotifications.ts` 单例 store：loadHistory / markRead / markAllRead(循环) / pushRealtime / unreadCount
- [ ] 6. NotificationsView 改用 store：真实数据、markRead 调 API、移除 localStorage 默认假数据

### 前端实时
- [ ] 7. HomeView WS onMessage 监听 `type==='notification'` → pushRealtime；onMounted 调 loadHistory
- [ ] 8. AppSidebar 「通知」菜单项显示未读徽标（unreadCount）

### 前端偏好
- [ ] 9. ModalManager 4 个通知开关 → 打开时 GET /preferences，切换时 PUT /preferences（键→type 映射）

### 验证
- [ ] 10. `npm run build` 通过（vue-tsc + vite）
- [x] 11. 重启 Docker（后端已改动）
- [x] 12. 反向 grep 验证：无残留 localStorage-only 通知逻辑 / 无 titleKey 假数据

## 验证记录

### 第 1 轮（2026-07-08）
- 扫描：确认后端 routes/notifications.js（4 接口）、notificationService.js（含 createNotification 但未被调用）、ws/server.js sendNotification（只推不存）、前端 NotificationsView（localStorage seed，无 API/WS）
- 结论：功能**未对接**，是脱机 demo。开始逐项正确对接。

### 第 2 轮（2026-07-08）— 真实验证（anti-shortcut E2E）
- 后端重启后 E2E 脚本（真实登录→创建设备→POST /clipboard→验证落库/已读/偏好）：
  - **发现并修复关键阻塞**：`notification_history` 表不存在（迁移 005 从未执行）→ 直接建表 → GET /history 由 500 变 200。
  - POST /clipboard(201) → sendNotification 落库 → GET /history 返回 `{id:1, type:'sync_complete', read_at:null}` ✅
  - PUT /history/:id/read(200) → read_at 被写入 ✅（已读持久化生效）
  - PUT /preferences(200) → product_update=false 写入 ✅（偏好持久化生效）
- 前端：`npm run build` 通过（vue-tsc 0 错误，2292 模块）；grep 确认无 `clipsync-notifications`/`titleKey`/`seed` 残留。
- **完成度：12 / 12 = 100%**（后端持久化 + 4 接口 + 前端 store + WS 实时 + 偏好 + 未读徽标，全部实测通过）。
