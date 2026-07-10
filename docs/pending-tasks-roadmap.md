# ClipSync 待办任务总览

> 更新时间：2026-07-10
> 状态：待审核，未开始实施

---

## 一、收藏（Favorites）功能

### 已完成 ✅
| 层级 | 内容 | 文件 |
|------|------|------|
| 数据库 | `is_favorite` 字段 | `scripts/init-db.sql` |
| 后端 API | `PUT /api/clipboard/:id/favorite` toggle | `src/server/src/routes/clipboard.js:452-486` |
| 后端 API | `GET /api/clipboard?favorites=true` 过滤 | `src/server/src/routes/clipboard.js:69-71` |
| 后端广播 | WS `clipboard_favorite` 事件 | `src/server/src/routes/clipboard.js:476-481` |
| 前端 composable | `toggleFavorite()` 乐观更新 + 失败回滚 | `src/desktop/src/composables/useClipboard.ts:933-941` |
| 前端 UI | ClipboardView 筛选标签页 + 星标按钮 | `src/desktop/src/components/clipboard/ClipboardView.vue:73, 542-543` |
| i18n | 中英文文案 | `src/desktop/src/composables/useI18n.ts:13, 298` |
| 移动端 | Flutter 模型 + provider + 本地化 | `src/mobile/lib/` 多文件 |

### 待讨论 / 待实现 ❌
| 优先级 | 内容 | 说明 |
|--------|------|------|
| P1 | 侧边栏收藏入口 | 在 AppSidebar 中增加"收藏"导航项，独立路由 |
| P1 | 收藏独立视图 | 从 ClipboardView 的 tab 筛选改为独立页面，支持更丰富的交互 |
| P2 | 收藏排序 | 用户自定义收藏顺序 |
| P2 | 收藏分组/标签 | 收藏夹分类管理 |
| P3 | 批量收藏/取消收藏 | 多选后批量操作 |

> 用户原话："收藏这一块还得再讨论下"

---

## 二、E2E 测试

### 已有基础 ✅
| 内容 | 位置 | 状态 |
|------|------|------|
| Playwright 依赖 | 根 `package.json` (`@playwright/test ^1.61.1`) | 已安装，无配置 |
| 服务端测试框架 | `src/server/` vitest + supertest | 可用 |
| 服务端测试文件 | `src/server/tests/` 14 个文件 | 部分被 skip |
| 手工 e2e 脚本 | `.workbuddy/scripts/e2e-test.js` | ad-hoc，未集成 CI |
| 手工 UI 脚本 | `.workbuddy/scripts/ui-e2e-playwright.mjs` | ad-hoc，未集成 CI |
| Flutter 测试 | `src/mobile/test/` 4 个文件 | 基础 widget 测试 |

### 待建设 ❌
| 优先级 | 内容 | 说明 |
|--------|------|------|
| P0 | `playwright.config.ts` | 正式 Playwright 配置（baseURL、浏览器、超时、报告） |
| P0 | 桌面端核心流程 E2E | 登录 → 剪贴板同步 → 收藏 → 文件预览 |
| P1 | 服务端 e2e.test.js 解除 skip | `describe.skip` → 正式运行 |
| P1 | CI 集成 E2E 阶段 | GitHub Actions 增加 E2E job |
| P1 | 测试覆盖标准 | 定义哪些流程必须 E2E 覆盖（验收门禁） |
| P2 | 多用户并发 E2E | 模拟两台设备同时复制同一内容 |
| P2 | 离线→上线 E2E | 断网复制 → 恢复网络 → 数据同步验证 |

> 用户原话："E2E 工程量太大，延后"

---

## 三、文档预览抽屉改造

### 需求
> 用户原话："改造一下，如果是文档类型的文件，比如 markdown、word、excel、pdf 等文件的查看方式，改造成点击预览图标弹出一个抽屉页面查看文档内容，不用弹窗查看这种文件流了；其他文件类型的预览还是弹出，照常就行"

### 待实现 ❌
| 优先级 | 内容 | 说明 |
|--------|------|------|
| P1 | 创建 DocumentDrawer 组件 | 右侧滑出面板，带关闭按钮、标题栏 |
| P1 | 迁移文档预览内容 | markdown/code/docx/PDF 从 ModalManager 迁移到 Drawer |
| P1 | Drawer 内 TOC 目录 | markdown 文档的目录侧边栏在 Drawer 内工作 |
| P2 | 保留图片/其他文件的弹窗预览 | ModalManager 仅处理非文档类型 |
| P2 | Drawer 动画 | 滑入/滑出过渡动画 |
| P3 | 响应式 | 窄屏下 Drawer 全屏覆盖 |

---

## 四、商用化系统排查计划

### 4.1 多用户并发场景分析

| 维度 | 排查内容 | 状态 |
|------|---------|------|
| 去重竞态 | 多设备同时复制同一内容，advisory lock 是否跨实例生效 | ⚠️ 已有锁但需验证 |
| 文件上传竞态 | 并发上传相同文件，幂等性中间件是否穿透 | ⚠️ 中间件非原子 |
| WebSocket 广播 | 多实例下 WS Pub/Sub 是否真正跨实例投递 | ⚠️ 已接入 Redis 但未验证 |
| 离线队列重放 | 用户 A 离线队列在用户 B 登录后被 flush | ❌ 未清理 |
| localStorage 泄漏 | content-cache / device-id / offline-queue 跨用户污染 | ❌ logout 未清理 |
| 图片预览内存 | object URL 未 revoke，长会话内存泄漏 | ❌ 未处理 |
| 剪贴板轮询泄漏 | HMR/remount 时 interval/listener 重复注册 | ⚠️ 需验证 |

### 4.2 高可用架构验证

| 组件 | 当前状态 | 商用标准 | 差距 |
|------|---------|---------|------|
| API 层 | 2 副本 + HPA + PDB(min=1) + 滚动更新 | 3 副本 + min=2 + 拓扑分散 | P1: PDB 不足 |
| PostgreSQL | 单实例 Deployment + Recreate | 主备 + 自动 failover + PITR | **P0: 单点故障** |
| Redis | 单实例 Deployment + Recreate | Sentinel/Cluster + 自动重连 | **P0: 单点故障** |
| 文件存储 | 本地 PVC（uploads-data） | 对象存储（S3/OSS）+ RWX PVC | **P0: 不支持多节点** |
| 备份 | pg_dump 到同 PVC + 无加密 | 异地 + PITR + GPG + 恢复演练 | **P0: 不可恢复** |
| 监控 | Prometheus + Grafana 已配置 | 目标可达 + 告警通道落地 + SLO | P1: 目标可能不可达 |
| CI/CD | 有回滚机制 | 健康检查路径正确 + 性能门禁 | P1: 路径错误 + 无压测 |

### 4.3 高并发能力评估

| 组件 | 瓶颈 | 影响 | 修复建议 |
|------|------|------|---------|
| DB 连接池 | max=50，集群模式平分 | 高并发下连接不足 | 监控 + 动态调整 + PgBouncer |
| Redis 连接 | 单连接无自动重连退避 | 网络抖动后降级 | ioredis retryStrategy |
| WS 连接限流 | 进程内 Map，多实例各允许 5 | 全局限流失效 | 迁移到 Redis ZSET |
| 分片上传 | multer.memoryStorage() | 大文件 OOM | 改为 diskStorage |
| S3 merge | Buffer.concat(chunks) | 大文件内存飙升 | 流式 multipart upload |
| 图片处理 | sharp 压缩同步 + base64 编码 | 主线程阻塞 | Worker threads |
| 压力测试 | stress.test.js 被 skip | 无 SLA 验证 | 解除 skip + k6 基准 |

### 4.4 CI/CD 缺陷

| 缺陷 | 位置 | 影响 |
|------|------|------|
| 健康检查路径错误 | `.github/workflows/deploy.yml:177-185` 检查 `/health`，实际是 `/api/health` | 部署后探测永远失败 |
| release digest 变量拼写错误 | `.github/workflows/deploy.yml:298` `build-andpush` 应为 `build-and-push` | Release 中 digest 为空 |
| 性能门禁被禁用 | `.github/workflows/ci.yml` performance test `continue-on-error: true` | 性能退化无感知 |
| WebSocket CSRF 代码顺序问题 | `src/server/src/ws/server.js:124` 使用 `redis` 但声明在 `:163` | 生产 WS 连接可能异常 |

---

## 五、商用化整改路线图（建议）

### 第一阶段：止血型修复（1-2 周）
1. 修复 WS CSRF `redis` 声明顺序
2. 修复 CI/CD 健康检查路径 + digest 拼写
3. logout 清理离线队列 / content-cache / 上传恢复状态
4. 分片上传 multer 改 diskStorage
5. WS 连接限流迁到 Redis
6. 解除 skipped 压测

### 第二阶段：HA 数据层改造（2-4 周）
7. PostgreSQL 替换为 CloudNativePG / 托管 RDS 主备
8. Redis 替换为 Sentinel / 托管 Redis
9. 文件存储迁移到对象存储（S3/OSS）
10. 备份改为异地 + PITR + 恢复演练

### 第三阶段：商用化收尾（1-2 周）
11. 收藏侧边栏 + 独立视图
12. 文档预览 Drawer 改造
13. E2E 测试套件 + CI 集成
14. 监控告警通道落地 + SLO 门禁
