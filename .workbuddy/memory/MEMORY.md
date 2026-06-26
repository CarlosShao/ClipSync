# ClipSync 项目长期记忆

## 技术栈（已锁定）
- 桌面端：Tauri 2 (Rust + WebView)
- 移动端：Flutter 3.x
- 后端：Node.js (Express + WebSocket)
- 数据库：**PostgreSQL** + **Redis**（不允许替换）
- 编译环境：需设置 `CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse` 解决 crates.io 连接问题

## 用户要求
- 不允许擅自更改技术栈
- 有外部环境依赖直接告知，不要自己绕路
- 不要遗留问题，解决好一个再进下一个
- 要求直接高效，不需要冗余解释

## 用户环境信息
- Git 安装在 `C:\Users\swq\.workbuddy\vendor\PortableGit`，PATH 需包含 `cmd` 子目录
- Flutter 安装在 `D:\work\server\flutter\flutter`
- PostgreSQL/Redis 通过 Docker 容器管理
- Node.js 有系统版和 managed 版（22.22.2）
- Flutter Web 运行需先添加 Git 到 PATH：`$env:PATH += ";C:\Users\swq\.workbuddy\vendor\PortableGit\cmd"`

## 生产级部署外部依赖
完成ClipSync生产级部署需要以下外部条件：
1. 域名和SSL证书（HTTPS）
2. 云服务器（生产环境）
3. 开发者账号（iOS/Android上架）
4. 第三方短信服务商
5. 推送通知证书（APNs/FCM）
6. 监控服务账号（Sentry/Prometheus）
7. 负载均衡器（云服务商提供）

## 项目完成状态
- **内部任务已完成（12/12）**：文件预览、全文搜索、配置分离、错误恢复测试、性能测试、压力测试、CI/CD、回滚机制、备份验证、灾难恢复、数据迁移、国际化
- **测试套件状态**：11个测试文件通过（114个测试），3个跳过（43个测试 - e2e/error-recovery/stress，需特殊环境）
- **当前整体进度约85%（72/84任务已完成）**
- **剩余内部任务**：
  1. Git初始化+首次提交（代码还在本地，未提交）
  2. Flutter移动端测试（无.test.dart文件）
  3. Tauri桌面端编译验证
  4. 内存存储迁移到Redis（uploadSessions/connections/csrfTokens）
- **仅剩7项外部依赖任务**：HTTPS/TLS(域名)、推送通知(开发者账号)、密钥管理(Vault)、监控部署(Grafana/Sentry)、负载均衡(云服务)、自动扩缩容(云服务)、短信服务
- **发现并修复的bug**：clipboard_items缺少updated_at、file_versions表未定义、CSRF中间件顺序错误、WebSocket内存泄漏、测试环境隔离问题、NODE_ENV守卫缺失
- **已创建Bruno API文档**：StreamApiTest目录，41个.bru文件覆盖28个端点

## 本轮完成的12项内部任务
1. 文件预览（文本/代码）- GET /api/media/:id/text-preview，30+种格式
2. 全文搜索（tsvector）- search_vector列+GIN索引+触发器+GET /api/clipboard/search
3. 配置文件分离 - config/development.js+test.js+production.js + config.js深度合并
4. 错误恢复测试 - error-recovery.test.js（DB恢复/WS重连/速率恢复/离线队列）
5. 性能测试 - performance.test.js（P95响应/并发/内存）
6. 压力测试 - stress.test.js（100并发读/50并发写/混合负载/1000次/内存泄漏）
7. CI/CD - .github/workflows/ci.yml
8. 回滚机制 - scripts/rollback.sh
9. 备份验证 - scripts/verify-backup.sh
10. 灾难恢复 - docs/disaster-recovery.md + scripts/dr-drill.sh
11. 数据迁移 - src/db/migrate-manager.js
12. 国际化 - app_en.arb + app_zh.arb 80+条翻译 + AppLocalizations启用

## 潜在问题需关注
- uploadSessions/connections/csrfTokens为内存Map（生产环境需Redis）
- WebSocket限流未被实际调用
- sync/pull的NOT IN子查询逻辑可能不准确

## 已实现的核心功能
1. **安全加固**：端到端加密、输入验证、XSS防护、SQL注入防护、速率限制、安全响应头
2. **功能完善**：图片同步、文件同步（含文本/代码预览）、离线支持、推送通知、文件版本管理、全文搜索
3. **测试覆盖**：单元测试、集成测试、端到端测试、性能测试、安全测试
4. **部署运维**：Docker Compose、CI/CD(GitHub Actions)、数据库备份+验证、健康检查、回滚机制、灾难恢复演练、数据迁移管理
5. **配置管理**：env变量+JS配置文件分离，深度合并，生产环境校验
6. **用户体验**：深色模式、新手引导、过渡动画、无障碍访问、国际化（中英80+条）
6. **性能优化**：首屏加载优化、缓存策略、懒加载、内存管理
7. **监控反馈**：错误报告、用户反馈、满意度调查、性能监控

## 关键技术决策
1. **数据库**：PostgreSQL + Redis（用户明确要求，不允许替换）
2. **测试框架**：Vitest + Supertest（后端）、Flutter测试（移动端）
3. **状态管理**：Provider模式（Flutter）
4. **缓存策略**：内存缓存 + 磁盘缓存，支持LRU淘汰
5. **错误处理**：全局错误捕获，本地存储未发送报告
