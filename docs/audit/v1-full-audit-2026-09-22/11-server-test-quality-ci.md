# 后端测试有效性 / CI 门禁 审计

审计日期：2026-09-22 ｜ 范围：`src/server/tests/**`（47 个文件，13,032 行）+ `.github/workflows/*` + 测试基建
纪律：只读审计，未修改任何源码/测试/配置；未执行 git 写操作。

## 结论

**「测试全绿」不能作为 v1 上线依据。** 理由：① CI 的 Tests/Lint job 是结构性假门禁（双重 `continue-on-error` + `|| true`，最后一次 CI 实跑就有 1 个测试失败但 workflow 显示 success；且当前发布候选分支的 config 改动会让 CI 测试连库都连不上、ci.yml 又只在 master 触发，本分支 47 个文件从未进过 CI）；② 生产代码在 `NODE_ENV==='test'` 下系统性旁路了 JWT 鉴权、CSRF、限流、套餐墙、Redis 幂等、WS Origin 校验——本地 525 个用例全绿验证的是一个**生产中不存在的形态**；③ 支付宝回调 happy path、WebSocket、同步游标这三个核心面在活跃测试里是零覆盖。
需要说明的公道话：9 月中旬新增的金钱链路测试（alipay/refund/proration/invoices/subscription-upgrade 等约 20 个文件）是**真库 + 真 RSA 验签 + 篡改/并发/幂等断言**的高质量测试，本地实跑绿是可信的——问题不在它们，而在旧测试的假绿、安全中间件旁路和 CI 门禁失效。

## 实跑结果

- 命令：`cd src/server && npx vitest run`（首次用 `--reporter=basic` 失败：vitest 4 已无 basic reporter，改默认 reporter 重跑）
- 环境：**真库**——Docker `clipsync-db`（postgres:15，宿主 5433 → 容器内 `clipsync_test` 库）+ `clipsync-redis`（宿主 6380），与 `src/config/test.js` 硬编码一致；非 mock DB。
- 结果：**Test Files 44 passed | 3 skipped (47)；Tests 525 passed | 48 skipped (575)；0 failed；耗时 119.53s；EXIT=0**
- 3 个整文件跳过：`e2e.test.js`(19)、`error-recovery.test.js`(12)、`stress.test.js`(7)；其余 10 个为零散 `it.skip`/`describe.skip`。
- 输出文件：`docs/audit/v1-full-audit-2026-09-22/_evidence/test-run-output.txt`
- 注意：**本地实跑 ≠ CI 实跑**。CI（GitHub Actions）环境配置与当前分支 config 冲突，测试在 CI 里根本跑不起来（见下文 S0-3）。

## 判据仪器失效清单（按严重度排）

### [S0-1] 生产代码内置 `NODE_ENV==='test'` 旁路：整套 HTTP 测试验证的是一个「无鉴权、无 CSRF、无限流、无套餐墙」的假形态

- 证据（全部为生产源码，非测试代码）：
  - `src/middleware/auth.js:8-20`：
    ```js
    if (process.env.NODE_ENV === 'test') {
      req.user = { userId: '00000000-0000-0000-0000-000000000001', ... roleLevel: 10, isAdmin: false };
      return next();
    }
    ```
  - `src/middleware/csrf.js:143-146`（测试环境跳过 CSRF）；`src/middleware/subscriptionCheck.js:10-13`（跳过订阅检查）；`src/middleware/planFeature.js:115-118`（跳过付费墙）
  - `src/middleware/rateLimiter.js:238-239, 369-370, 387-388`：`apiLimiter/adminLimiter/adminStrictLimiter` 在 test 下直接是 `(req,res,next)=>next()`；`:193` storeName==='api' 也短路
  - `src/ws/server.js:127`（Origin 校验仅 production）、`:160`（WS CSRF 仅 production 强制）、`:205`
  - `src/middleware/idempotency.js:20`、`src/routes/chunked-upload.js:98`、`src/utils/redis-map.js:187`、`rateLimiter.js:188`：`useRedis = NODE_ENV==='production'` → 测试永远走内存降级分支，**生产用的 Redis 幂等/限流实现 0 测试**
  - `src/index.js:363`（metricsAuth 测试环境跳过）
- 假装验证了什么 / 实际验证了什么：`security.test.js`、`csrf.test.js`、几十个路由测试假装验证了「鉴权/CSRF/限流下的接口行为」；实际这些中间件在测试进程里全部是 no-op。`authenticateToken` 的真实逻辑（jwt.verify、jti 黑名单、`user_sessions.is_active` 双重校验，auth.js:30-60）**在任何测试里都没有执行过一次**。测试注释自己也承认：`security.test.js:103`「测试环境 CSRF 被跳过，此章节跳过」、`:117`「测试环境 auth 被跳过」。
- 能逃过的真实 bug 举例：① `jwt.verify` 的 secret 取错配置/过期不生效/黑名单查错 key → 所有请求照过；② 会话吊销（C1 修复）失效 → 登出后 token 仍可用；③ CSRF 中间件在生产形态下的分支（Bearer 豁免、x-csrf-token 校验）任何回归；④ 限流 keyGenerator 写错（`rateLimiter.js:100` 的注释自述曾因此长期未暴露）；⑤ Redis 版幂等中间件序列化/过期写错 → 生产回调重复发货。
- 影响：认证绕过、会话不失效、CSRF、限流失效、幂等失效类事故全部漏网——恰是安全审计的基本盘。
- 修法：删除生产代码里的所有 test 旁路，改为依赖注入/显式开关（如 `AUTH_BYPASS=1` 仅在 setup.js 中按需设置且逐路由可控），并补一组「真 JWT + 真中间件链」的路由测试（用真实登录签发的 token 打接口）。

### [S0-2] CI 门禁三重假绿：Lint `|| true`、Tests 双重 `continue-on-error`、最后一次 CI 实跑有失败测试却显示 success

- 证据：
  - `.github/workflows/ci.yml:56`：`run: npx eslint src/ --ext .js --max-warnings=0 || true`——且 `src/server` **没有 eslint 配置也没有 eslint 依赖**（`package.json:46-49` devDeps 仅 supertest/vitest；`ls src/server/eslint.config.* .eslintrc*` 不存在），这条命令必然报错然后被 `|| true` 吞掉。job 注释「Lint（必须通过）」是假的。
  - `ci.yml:76`（job 级 `continue-on-error: true`）+ `ci.yml:156`（Run tests 步骤再叠一层 `continue-on-error: true`），注释自认：「关键：test 失败不让 workflow 失败」。
  - 实证（gh CLI 拉取 run 32467333008，2026-08-21 master）：Tests job 日志末尾
    ```
    Test Files  1 failed | 12 passed | 3 skipped (16)
         Tests  1 failed | 123 passed | 48 skipped (174)
    ```
    失败用例 `tests/archive.test.js > 默认主列表含条目…`，annotation「X Process completed with exit code 1」——但 run 整体显示 **✓ success**，飞书通报的也是 success。
  - `ci.yml:192-199`：Deploy job `needs: [lint, test]` 但两者永远「成功」，且 deploy 自身也 `continue-on-error: true` → 手动部署无任何门槛。
- 假装验证了什么 / 实际验证了什么：假装「lint 必须通过、测试失败会警告」；实际红灯被系统性吞掉，团队看到的永远是绿灯（这正是「flaky/红灯疲劳」的制度化成因）。
- 能逃过的真实 bug：任何让测试变红的回归——已经发生过（archive 失败挂了一个月无人处理）。
- 修法：去掉两层 continue-on-error 和 `|| true`；lint 先装 eslint + 写 flat config；分支保护设 Tests 为 required check。

### [S0-3] 当前发布候选分支的 config 改动使 CI 测试 job 必然连不上库；且 ci.yml 只在 master 触发——本分支 31 个新增测试文件从未在 CI 跑过

- 证据：
  - `src/config.js:44`（commit 777ee645，2026-08-24，仅在本分支）：`if (nodeEnv !== 'test' && (process.env.DB_HOST || ...))` —— NODE_ENV=test 时**忽略全部 DB 环境变量**，强制使用 `src/config/test.js:10-18` 的 `localhost:5433 / clipsync / <REDACTED:DB_PASSWORD> / clipsync_test`。
  - `ci.yml:80-103`：CI service container 是 `postgres:16-alpine` 映射 **5432**，账号 `postgres/postgres`；环境变量 `DB_PORT=5432 DB_USER=postgres` 恰好是被 config.js:44 忽略的那些。5433 上无任何服务 → `npm run db:migrate`（ci.yml:149-151）ECONNREFUSED，测试步骤根本不会执行。
  - Redis 同理：CI redis service 无密码（ci.yml:104-112），而已提交进仓库的 `src/server/.env.test` 带 `REDIS_PASSWORD=<REDACTED:REDIS_PASSWORD>`（setup.js:10 加载）→ 对无密码 Redis 发 AUTH 即错。
  - `ci.yml:8-12` 只在 push/PR master 触发；`gh run list` 显示 ci.yml 最后一次运行是 2026-08-21，当时仅 16 个测试文件。8/21 之后新增的全部金钱链路测试（refund-*、payment-*、invoices-*、subscription-*、admin/* 等 31 个文件）**从未进过任何 CI**。当前工作分支为 `test/admin-full-audit`。
  - master 上的旧 `config.js`（`git show master:src/server/src/config.js`）没有这个 gating，说明这是合并后即引爆的定时炸弹。
- 假装验证了什么 / 实际验证了什么：CI 假装「有 Postgres/Redis service container、跑真库测试」；实际合并本分支后 Tests job 会在 migrate 步骤就死掉，然后被 S0-2 的 continue-on-error 变成绿色。
- 修法：CI env 与 `config/test.js` 对齐（或让 test 模式接受显式 `CLIPSYNC_TEST_DB_*` 覆盖）；给 CI redis 配 requirepass；把 ci.yml 触发扩到发布分支。

### [S0-4] 生产部署（deploy.yml，tag 触发 → K8s）没有任何测试/lint 门禁；Trivy 扫描被 continue-on-error 中和

- 证据：`.github/workflows/deploy.yml:29-104`：唯一前置 job 是 `build-and-push`（构建镜像），`deploy-k8s` 只 `needs: build-and-push`（:110）；全文件不含 lint/test。`:88-97` Trivy `exit-code: '1'` 但 `continue-on-error: true`（:97），漏洞扫描只上传 SARIF 不拦截。
- 假装验证了什么 / 实际验证了什么：假装「打 tag 走的是经过验证的发布流水线」；实际 `git tag v1.0.0 && git push --tags` 即可把**从未跑过任何测试**的代码直接部署到生产 K8s。
- 修法：deploy.yml 增加 `needs: test`（真实阻断版），Trivy 去掉 continue-on-error 或至少 CRITICAL 阻断。

### [S1-1] 支付宝回调只有「拒绝未验签」测试，没有合法签名 → 履约的 happy path；金额不符分支 0 覆盖

- 证据：
  - `tests/payment-webhooks.test.js` 全部 7 例只断言：路由可达（非 404）、不要求登录、未验签被拒（`:68-79`）、不走 CSRF。**没有任何用例构造合法签名的 notify 报文**（尽管 `alipay.test.js:144-150` 已示范了怎么用本地密钥签出合法报文）。
  - `src/services/orderFulfillment.js:130-138` 有 `expectedAmount` 金额比对分支（回调 `total_amount` ≠ 订单金额 → 拒绝）；全 tests/ 目录 grep `expectedAmount` 仅 `subscription-upgrade.test.js:370` 一处，且传的是**正确金额**——「金额与订单不符被拒绝」零覆盖。
  - `src/routes/paymentWebhooks.js:39` 挂了 `webhookIdempotencyMiddleware()`，但 test 环境走内存实现（`idempotency.js:20`），同一 `trade_no` 重放的 HTTP 层测试不存在；`trade_status` 非法迁移（如 TRADE_CLOSED→TRADE_SUCCESS）无测试。
- 假装验证了什么 / 实际验证了什么：payment-webhooks.test.js 假装保住了「钱扣了订阅不开通」的复发防线；实际只保住了「路由存在且拒未验签」。**「合法回调 → 订单 paid → 订阅 active → 发票/审计」这条最重要的履约链没有端到端测试**；`markOrderPaid` 只在 subscription-upgrade 里以服务层直调方式测了升级/续费语义。
- 能逃过的真实 bug：① 履约 SQL 列名/约束错误（回调收到但入库 500，支付宝重试 24h 后放弃 = 收钱不开通）；② `total_amount` 字符串 vs numeric 比较写错（`'9.90' !== 9.9`）→ 全部合法回调被拒；③ `webhookIdempotencyMiddleware` Redis 版实现错误 → 重复投递双开订阅。
- 修法：新增测试——用 `alipay.test.js` 同款本地密钥对，在 env 注入 `ALIPAY_PUBLIC_KEY` 后向 `/api/webhooks/alipay` POST 合法签名表单，断言 200 'success' + 订单/订阅/用户状态；再加金额不符、重放、非法状态迁移三个负例。

### [S1-2] WebSocket 全链路零活跃测试：握手鉴权、Origin、超大消息、畸形 JSON 全部无覆盖

- 证据：唯一的 WS 集成用例在 `tests/error-recovery.test.js:103`：`(process.env.NODE_ENV === 'test' ? describe.skip : describe)`，且外层 `:24` 已是 `describe.skip`——**双重跳过，任何环境都跑不到**。`api.test.js:149-155` 只断言 `typeof broadcastToUser === 'function'`。`ws/server.js` 的 token 校验（:147 jwt.verify）、4001/4002/4004/4006 关闭码、消息大小限制、JSON.parse 容错，均无测试。
- 假装验证了什么：api.test.js 假装「WebSocket Module 必要函数已导出」；实际连接建立后的一切行为无验证。
- 能逃过的真实 bug：握手用错 secret（生产 4002 全拒）；`JSON.parse` 未包 try/catch → 一条畸形消息崩掉连接处理器；无 maxPayload → 单连接 1GB 消息打爆内存。
- 修法：用 `ws` 客户端对 `server.listen(0)` 的临时端口做握手测试（无效 token→4002、缺 token→4001、超大 payload→拒绝、畸形 JSON→连接存活）。

### [S1-3] 同步核心（游标增量、删除传播、双端冲突）零活跃正确性测试

- 证据：`/api/sync/push|pull` 只出现在 `e2e.test.js:238,256`（整文件 skip）、`error-recovery.test.js:244,266`（整文件 skip）、`performance.test.js:137-152`（只断言 p95 时延，**不看响应内容**）。时钟回拨、离线删除传播、两端同改一条的冲突解决：0 用例。
- 影响：这是产品的核心功能（跨设备剪贴板同步）。「同步丢条目/删除不传播/冲突覆盖」类事故完全没有测试防线。
- 修法：真库集成测试——造两个 device，push→pull 游标推进、回拨 `since` 不丢条目、delete 变更传播、并发写同一条的最后写入语义钉死。

### [S1-4] admin 大部分端点用「mock pool + SQL 片段分发」，测不出 SQL 列名错误——已有真实事故证明这类 bug 会漏到生产

- 证据：
  - `tests/admin/users.test.js:96-101`（orders/audit/configs/roles/devices/plans/subscriptions/overview 同风格）：
    ```js
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm();
      if (sql.includes('device_count')) return { rows: [makeUserRow(), ...] };
    ```
    只要 SQL 文本含某片段就返回 fixture 行——SELECT 里写 `u.name` 还是 `u.nickname` 对测试结果毫无影响。
  - 真实事故：commit `6ef9cec0`（2026-09-21）「退款审核列表 JOIN 用错列名（u.name）→ 管理台一点就 500」，commit message 自述：*「这条查询此前没有任何测试覆盖，approve/reject 都是直接按 id 调服务，绕开了带 JOIN 的列表 SQL —— 列名写错只能等生产炸」*。事后补的 `refund-request.test.js:464-496`（真库跑 `listRefundRequestsForAdmin`）只修了这一处。
- 假装验证了什么 / 实际验证了什么：假装验证了「管理台列表/详情接口正常」；实际只验证了「路由把 mock 行映射成响应壳 + 打码逻辑 + RBAC 403」。**users/orders/audit/overview/devices/plans/subscriptions/configs/roles 九个 admin 面的真实 SQL 至今没有一条在真库上跑过**，同款 u.name 事故随时可以在其中任何一个复发。
- 修法：每个 admin 资源至少补一条真库冒烟用例（seed 一行 → 打接口 → 断言 200 + 关键字段），沿用 `admin-payment-surfaces.test.js` 已验证可行的真库范式。

### [S1-5] IDOR 越权测试只覆盖订单/发票两类资源；剪贴板条目、设备、会话、AI 会话、文件、分享链接全部没有

- 证据：已有的越权用例——订单：`payment-refund.test.js:204-216`（他人订单 → 404 同壳）、`refund-request.test.js:234-243`；发票：`invoices-read.test.js:160-177`、`invoice-download.test.js:203`；AI 工具 user_id 隔离：`ai-agent-ops.test.js`（write_clip/create_collection 硬隔离）。**没有**任何「用户 A 访问用户 B 的 clipboard item / device / session / ai_conversation / file / shared-link」用例（全 tests/ grep `OTHER_USER|别人|他人|越权` 无命中这些资源）。且因 S0-1 的 auth 旁路把所有 HTTP 请求固定为同一 userId，这类测试在现有基建下**根本写不出来**——expiry/archive 的 `PUT /api/clipboard/:id` 全部只操作自己（固定用户）的条目。
- 能逃过的真实 bug：`GET /api/clipboard/:id`、`GET /api/ai/conversations/:id`、`GET /api/sessions/:id/revoke` 等任何一处 WHERE 漏掉 `user_id = $x` → 横向拖库。
- 修法：先解决 S0-1（可注入身份），再为每类资源补「B 的资源用 A 的身份访问 → 404/403」的矩阵测试。

### [S1-6] 免费档位墙（subscriptionCheck / planFeature / 设备与剪贴板配额）零测试

- 证据：`subscriptionCheck.js:10-13` 与 `planFeature.js:115-118` 在 test 环境直接 `next()`；两者被挂在核心路由上（`index.js:407-435`：/api/devices、/api/clipboard、/api/media、/api/sync、/api/storage、/api/upload、/api/versions）。全 tests/ grep `40303|requirePlanFeature|subscriptionCheck` 仅命中一条注释（subscription-flag-gate.test.js:12）。「免费用户直接调付费接口被拒」「token 里档位过期后不放行」「checkDeviceLimit/checkClipboardLimit 超额拒绝」：0 用例。
- 修法：把配额判定抽成纯函数（像 refundPolicy 那样）+ 用真库 seed free 用户超额数据打接口。

### [S2-1] 三个整文件 skip：e2e(19)、stress(7)、error-recovery(12)——38 个用例是死代码，且内容已与实现脱节

- 证据：`e2e.test.js:31`、`stress.test.js:18`、`error-recovery.test.js:24` 均为 `describe.skip`。e2e 的「完整用户旅程」依赖 `code: '888888'` 固定码与 `test-token`（:37,76），与当前实现的 devCode 机制半脱节；error-recovery 里唯一有价值的「限流触发后恢复」「大请求体不崩」也随之死亡。
- 影响：注册→登录→建备→同步→健康检查的产品主干流程没有任何自动化验证；「服务重启/断连恢复」类风险无覆盖。
- 修法：要么修复并解 skip（配合 S0-1 改造后用真 token），要么删掉防止「看起来有覆盖」的错觉。

### [S2-2] security.test.js：名为「安全测试」，10 例中 7 例 skip，剩余 3 例断言恒真

- 证据：`security.test.js:28,38,71,105,119,133`——SQLi(搜索/设备)、XSS(设备名)、CSRF、认证绕过、**权限提升（IDOR）**全部 skip；活着的 3 例断言是 `expect(res.status).not.toBe(500)`（:25,63）和 `expect([200,201,400,404]).toContain(res.status)`（:98）——接口返回 401、403、404 还是 200 都算「通过」，等于没有断言。
- 假装验证了什么：假装防住了 SQLi/XSS；实际只验证了「特定 payload 没把进程打出 500」。
- 修法：SQLi 用真库断言「注入串被当字面量存储/查询报错 400」；XSS 断言响应体的转义结果；skip 的 IDOR/认证章节在 S0-1 修复后重写。

### [S2-3] version.test.js 全文件「状态码集合断言」：路由整体不存在也全绿

- 证据：`version.test.js:61` `expect([201, 404, 200]).toContain(res.status)`、`:74,88,101,125` `expect([200, 404]).toContain(...)`、`:143,156` `expect([400, 404]).toContain(...)`。注释自认「路由可能不存在，期望 201 或 404」（:60）。`/api/versions` 整条路由被删掉，9 个用例照样全绿。
- 修法：断言具体状态码 + body 结构；创建后读回版本内容做往返校验。

### [S2-4] webhook.test.js 只断言「导出是函数」，验签器从未被调用

- 证据：`webhook.test.js:6-44`：6 个用例全部是 `expect(typeof createXxxSignatureVerifier).toBe('function')` / `expect(verifier).toBeDefined()`。`middleware/webhook-signature.js` 的 WeChat/Stripe 验签逻辑（支付宝分支的逻辑已由 alipay.test.js 独立覆盖）没有任何行为测试——给 verifier 喂一个合法/非法签名各一次的用例都没有。
- 假装验证了什么：假装「webhook 验签模块正常」；实际只验证了模块能 import。
- 修法：对 WeChat（HMAC）与 Stripe（whsec）各写一组真签名/篡改签名用例，参照 alipay.test.js 的本地密钥模式。

### [S2-5] csrf.test.js：中间件用例被 test 旁路短路 + `expect(true).toBe(true)` + skip 藏住唯一能暴露旁路的用例

- 证据：
  - `csrf.test.js:190`：`expect(true).toBe(true);`（「令牌清理」用例，实际什么都没验）。
  - `:106-132`「应该对POST请求验证CSRF令牌」：`csrfProtection` 在 test 环境第一行就 `next()`（csrf.js:144），`not.toThrow()` 恒真——**这个用例从未验证过令牌校验逻辑**。`:92-104`、`:162-178` 同理（GET 跳过/无 userId 跳过这两条行为在 test 下与旁路不可区分）。
  - `:134` `it.skip('应该拒绝无效CSRF令牌的POST请求', ...)`，skip 理由「此测试在测试环境行为不一致」——**这个「不一致」正是旁路本身**，skip 把唯一能发现 S0-1 的用例藏掉了。
  - 值得肯定：`generateCsrfToken/validateCsrfToken` 的纯函数用例（:33-88）是真实有效的（单次使用、用户/会话绑定、非法令牌拒绝）。
- 修法：中间件测试显式构造非 test 的调用路径（把旁路改成可注入开关后测两态），解掉 :134 的 skip。

### [S2-6] api.test.js / integration.test.js / subscription-api.test.js：同义反复与「测第三方库」

- 证据：
  - `api.test.js:97-129`「JWT Authentication」：`jwt.sign(payload, secret)` 再 `jwt.verify(token, secret)`——测的是 jsonwebtoken 库自身，与 `middleware/auth.js` 无任何交集；`:132-136` 断言 `typeof mod.apiLimiter === 'function'`（在 test 下它就是个 no-op 函数，断言永真）；`:139-163` Logger/WS/Cleanup 均只断言导出存在。
  - `integration.test.js:38-50`：`expect(parseInt(count)).toBeGreaterThanOrEqual(0)`——COUNT 恒 ≥0，同义反复；`:52-57` 测 redis 客户端 set/get。
  - `subscription-api.test.js:80-91,110-130`：用例包在 `if (planRes.rows.length > 0) {...}` 里——种子缺失时**零断言静默通过**；`:84-90`「should create subscription with encrypted token」插入字面量 `'encrypted_token_test'` 再断言自己插入的值，与加密毫无关系（标题误导）。
  - `subscription-api.test.js:12-16`：beforeAll `DELETE FROM users WHERE phone LIKE '+86138%'`——按号段全局删用户，若其他文件/开发者数据用了同号段会被误删（跨文件污染风险）。
  - `subscriptions.test.js:46-52`「应该拒绝未认证的请求」：断言包在 `if (process.env.NODE_ENV !== 'test')` 里——**test 环境下该用例没有任何 expect，恒过**。
- 修法：删除测库/测导出的用例；条件断言改为「前置不满足即 fail」；`LIKE` 号段清理改为精确 ID 清理。

### [S2-7] performance.test.js：阈值机器相关、GC 断言无效、计时不断言状态码；并发写 skip

- 证据：`:77` `expect(stats.p95).toBeLessThan(100)`（health）、`:97` <200ms（verify-code）、`:119` <500ms、`:220` 内存增长 <25MB（用例名却写「<10MB」，:207）；`:208,215` `if (global.gc) global.gc()`——未以 `--expose-gc` 运行时 `global.gc` 不存在，内存断言在无 GC 控制下是噪声（flaky 源）。`measurePerf`（:17-36）只计时**不断言响应状态**：`verify-code` 用例（:87-98）用固定码 888888 走登录，若接口全返回 400/500，计时照样「通过」——测的可能是错误路径的时延。`:175` `it.skip('应该支持20个并发写请求')`（skip 理由「测试环境不稳定」）。
- 影响：这类阈值在 GitHub 共享 runner 上必然抖动，是「红灯疲劳」的典型来源（好在 CI 现在也跑不到它）。
- 修法：性能测试单独 `test:perf` 脚本 + 宽松阈值 + 断言状态码；不进 PR 门禁。

### [S2-8] 数据隔离：全靠「串行 + 共享固定用户 + 各文件自觉清理」维持，脆弱但目前有效

- 证据：`vitest.config.js:9-12` `fileParallelism:false, maxThreads:1`（串行是隔离的前提）；`test-helpers.js:48-58` 提供了 `withTransaction`（ROLLBACK 隔离）但**只有 ai-rbac.test.js 在用**；其余文件共享固定用户 `00000000-...-001`（auth.js 硬编码），`payment-refund.test.js:177` 临时把它改成 `is_admin=true` 并在 afterAll 还原（:194），`refund-request.test.js:471-472` 注释自认「昵称会被别的文件写成别的名字，这里只要求 JOIN 真的取到了列」；`setup.js:33` 全局 `DELETE FROM users WHERE phone LIKE '13800%' OR '13900%'`；`expiry.test.js:45-70` 用例间通过闭包变量 `itemId` 串联（第 2、3 个用例依赖第 1 个的产物，顺序耦合）。
- 影响：任何人打开 fileParallelism、或新增文件不清理 is_admin/flag 状态，就会出现「A 文件造的数据让 B 文件碰巧通过/失败」的随机红绿。
- 修法：推广 `withTransaction`；共享固定用户的可变字段（is_admin/subscription_status）改为「用完即还原 + beforeEach 断言基线」。

### [S2-9] coverage 无阈值、CI 不跑 coverage

- 证据：`vitest.config.js:18-25` coverage 仅配 provider/reporter/exclude，**无 thresholds**（`git show 9efb1374:src/server/vitest.config.js` 确认从初始提交起就没有，不存在「被调低」）；`package.json:12` 有 `test:coverage` 脚本但 ci.yml 用的是 `npm test`（ci.yml:155），coverage 从未在 CI 产生。
- 修法：先解决断言质量问题再谈阈值——当前很多文件的「覆盖」是恒真断言刷出来的，设阈值只会激励更多假绿。

### [S3-1] check-syntax.js 是一次性调试脚本，不在 CI，也不能替代任何测试

- 证据：`src/server/check-syntax.js` 全文只做单文件括号/反引号配平计数（默认目标 `src/routes/subscriptions.js`），无 exit code 语义（发现问题也只 console.log）；ci.yml 无引用。属遗留物，建议删除。

### [S3-2] 其它质量问题

- `package.json:13-14` `test:env` 指向 `scripts/start-test-env.sh`——**该文件不存在**（`ls scripts/` 无此文件），脚本引用已烂。
- `src/server/.env.test` 被提交进 git（含 DB/Redis/JWT/加密密钥的 dev 值）；虽是 dev 密钥，也属仓库卫生问题，且它会被 CI checkout 后由 setup.js 加载，成为 S0-3 中 Redis AUTH 失败的一半原因。
- 样板重复：`seedOrder/readOrder/cleanup` 在 payment-refund、refund-request、refund-service 三处近乎复制粘贴（各 ~60 行），密钥对生成 + `signWith` + `stubGatewayResponse` 在 4 个文件重复——应抽入 test-helpers.js（test-helpers 目前只提供 4 个函数，利用率低）。
- `ai-orchestration.test.js:22,58` 用真实 `setTimeout` sleep（`wait(120)`）等待 SSE 门控，慢机器上有 flaky 风险。
- `scripts/admin-full-audit/run-audit.mjs`：手动全链路审计脚本，打的是 **dev 后端（127.0.0.1:3001）+ dev 库**（`docker exec clipsync-db psql -d clipsync_dev`），与 CI 无任何关联，也不会在 CI 里跑——它发现的 admin 面问题不能算作测试覆盖。

## CI 门禁真实性核对

| 项 | ci.yml（master push/PR + 手动） | deploy.yml（tag → 生产 K8s） | admin-console.yml | website.yml |
|---|---|---|---|---|
| 跑什么 | Lint（`\|\| true` 装饰）→ Tests（migrate + `npm test --reporter=verbose`）→ 手动 Deploy（SSH restart） | 仅 Docker build+push → kustomize 部署 → 健康检查 → 失败自动回滚 | lint+typecheck+test+build（真实阻断） | build+check（真实阻断） |
| 有无真库 service | 有 postgres:16(5432)+redis:7(6380) 容器，**但与本分支 config/test.js（5433/clipsync/带密码 redis）不匹配 → 合并后必挂**（S0-3） | 无（不跑测试） | 不需要 | 不需要 |
| 失败是否阻断 | **否**：Tests job `continue-on-error:true`(:76) + 步骤级再来一层(:156)；Lint `\|\| true`(:56)；Deploy 也 `continue-on-error:true`(:199) | **无测试可失败**；Trivy `exit-code:1` 被 `continue-on-error:true`(:97) 中和；rollout 失败有自动回滚(:210-253，算亮点) | 是 | 是 |
| 能否绕过部署 | 手动 Deploy 只看 needs 的「绿色」（假绿），任何状态都能部署 | `git tag v* && git push --tags` 直通生产，零测试 | — | — |
| path filter | 无（但**只有 master 触发**——当前发布分支 31 个新测试文件从未进 CI） | 只 tag 触发 | 限 `src/admin-console/**` | 限 `src/website/**` |
| 其它 | concurrency 取消旧 run(:16-18)；无 timeout-minutes；npm cache；飞书通报 `job.status`（continue-on-error 下报的是假状态） | 健康检查带重试(:169-195)；`release` job 引用了不存在的 `needs.build-andpush`(:299 拼写错) | — | — |
| 桌面端(Tauri)/移动端(Flutter) | **完全没有 CI workflow**——desktop、mobile 无任何构建/测试门禁 | 同左 | — | — |

**逐条回答关键问题**：CI 跑了全部测试吗——命令上是（`npm test` 全量，无 `--changed`/grep 过滤），但本分支合并后会在 migrate 步骤就失败且失败被吞；测试失败阻断吗——不阻断（三重软化）；deploy 能否无测试部署——能（两条部署路径都能）；lint/typecheck 门禁——后端 lint 是装饰品，admin-console/website 有真门禁；前端门禁——admin-console/website 有，desktop/mobile 无。

## skip / todo / only 全清单

全仓 grep `\.skip|\.todo|\.only|runIf`（tests/ 下无 `.only`、无 `.todo`、无 `it.runIf`）：

| 位置 | 跳过了什么 | 风险 |
|---|---|---|
| `e2e.test.js:31` describe.skip | 完整用户旅程 19 例（注册→登录→设备→剪贴板→同步→健康检查） | 产品主干流程零自动化验证；内容已与实现半脱节（固定码 888888 / test-token） |
| `stress.test.js:18` describe.skip | 高并发读/写/混合负载/持续负载/内存泄漏 7 例 | 并发稳定性无覆盖（其中 :94、:123 还嵌套 it.skip） |
| `error-recovery.test.js:24` describe.skip | 断连恢复/大请求体/限流恢复/token 过期重登 12 例 | 错误恢复能力无覆盖 |
| `error-recovery.test.js:103` `(NODE_ENV==='test'?describe.skip:describe)` | WS 重连 + **无效 token WS 被拒(4002)** | 「本地跑不到、CI 也跑不到」的典型：test 环境恒 skip，非 test 环境外层已 skip——**任何环境都不会执行** |
| `security.test.js:28` it.skip | 搜索接口 SQLi | 搜索 SQL 注入无覆盖 |
| `security.test.js:38` it.skip | 设备注册 SQLi（注释：「测试环境走 mock，不会真正执行 SQL」——自证测试与生产不同形） | 同上 |
| `security.test.js:71` it.skip | 设备名存储型 XSS | XSS 防线无覆盖 |
| `security.test.js:105` describe.skip | CSRF 攻击 | 因 csrf.js:144 旁路而无法测（skip 是旁路的直接后果） |
| `security.test.js:119` describe.skip | 认证绕过（无 token/无效 token → 401） | **auth.js:8 旁路的直接后果**：真鉴权行为无法测 |
| `security.test.js:133` describe.skip | 权限提升（访问他人数据） | IDOR 无覆盖（S1-5） |
| `csrf.test.js:134` it.skip | 无效 CSRF token 的 POST 被 403 拒 | 唯一能暴露 csrf 旁路的用例被藏起（S2-5） |
| `performance.test.js:175` it.skip | 20 并发写（理由「不稳定」） | 并发写正确性/时延无覆盖 |
| `subscriptions.test.js:67` it.skip | 创建订阅订单（理由「需要支付集成」）；且体内 :89 还有 `expect(true).toBe(true)` 兜底 | 下单链路此文件无覆盖（已被 payment 系新测试部分补上） |
| `version.test.js:163` describe.skip | /api/versions 的 401/403 认证用例 | 版本接口鉴权无覆盖 |
| `ai-rbac.test.js:14,20` | 仅注释提及「未实现用例一律 it.skip 占位」——**实际文件中无 skip**，15 例全跑（W2 已落地） | 无风险（注释过时） |

无「环境判断导致 CI 永远跑不到」的其它形态（`process.env.X ? describe` 仅 error-recovery:103 一处）。

## 关键风险场景覆盖矩阵

| 场景 | 有无覆盖 | 文件:行 | 断言了什么 | 缺口说明 |
|---|---|---|---|---|
| 支付宝回调验签失败被拒 | ✅ | payment-webhooks.test.js:68-79；alipay.test.js:152-201 | 伪造 sign → 401 'failure'；工具层篡改金额/订单号/他人公钥 → verifyParams false | 工具层扎实；路由层仅测「未配置公钥→503 / 伪签→401」 |
| 回调金额与订单不符被拒 | ❌ | —（orderFulfillment.js:130-138 分支无测试） | — | **S1-1**：`expectedAmount` 只被传过正确值 |
| 合法回调 → 开通订阅（happy path） | ❌ | — | — | **S1-1**：无合法签名 notify 的 HTTP 测试；markOrderPaid 仅服务层直调（subscription-upgrade.test.js:351-468，履约/幂等语义质量好） |
| 同一 trade_no 重放不重复发货 | ⚠️部分 | subscription-upgrade.test.js:405-444（两笔订单重复支付→只顺延不插行）；refund-request.test.js:371-384（重复审核 409） | 同套餐最多一条 active；重复 approve 不再打款 | HTTP 层 webhookIdempotencyMiddleware 无测试；test 走内存实现，生产 Redis 实现 0 覆盖（idempotency.js:20） |
| trade_status 非法迁移被拒 | ❌ | — | — | paymentWebhooks.js:71 只认 TRADE_SUCCESS/FINISHED，其余「如实记日志」——无用例钉住 |
| 退款累计超已付被拒 | ⚠️部分 | refund-service.test.js:488-506（部分金额→400 不打款）；alipay.test.js:460-469（金额≤0/非数字拒发请求） | PARTIAL_REFUND_NOT_SUPPORTED；渠道零调用 | 系统设计为只支持全额退，「多次部分退累计超额」场景被设计排除且有测试钉住——可接受 |
| 退款审核通过后重复提交幂等 | ✅ | refund-service.test.js:348-358,407-428；refund-request.test.js:371-384 | 已退款 409；并发双退只有一笔落库（行锁）；重复 approve 409 且渠道不再调 | 质量高（真库+真验签） |
| 退款失败状态回滚 | ✅ | refund-service.test.js:360-405；payment-refund.test.js:374-420；refund-request.test.js:386-402 | 渠道失败/未确认/验签失败 → 订单仍 paid、订阅仍 active、写 failure 审计；approve 失败退回 pending | 覆盖充分，含响应篡改（签名不符）用例 |
| proration 边界（同天/剩0天/负数/四舍五入） | ✅ | proration.test.js:23-159 | 固定 UTC 时间戳：周期起点全额残值、剩半天线性、到期日 0 残值、残值≥新价兜底 0.01、时间倒挂、字符串/Date 等价、浮点进位 | 质量高；纯函数层。路由层取数落库在 subscription-upgrade.test.js:269-348 |
| 关单扫尾 vs「刚好此刻支付成功」竞态 | ❌ | —（全 tests/ 无 closeExpiredOrders/auto-close 用例，仅 admin/audit.test.js:246 把 'payment_auto_close' 当筛选值） | — | 关单任务本身 + 竞态窗口（关单事务 vs markOrderPaid 行锁）零覆盖 |
| 幂等键并发同时到达不双写 | ⚠️部分 | refund-service.test.js:407-428（退款并发，真库行锁） | 并发双退一成一 409 | HTTP Idempotency-Key 中间件（内存/Redis 两实现）无并发测试 |
| WS 握手鉴权失败被拒 | ❌ | error-recovery.test.js:131-140（双重 skip，永不执行） | （4002 断言存在但死代码） | **S1-2** |
| WS Origin 校验 | ❌ | —（ws/server.js:127 仅 production 生效） | — | 生产专属分支，测试环境形态里不存在 |
| WS 超大消息/畸形 JSON 不崩 | ❌ | error-recovery.test.js:177-194（HTTP 大 body，skip） | — | WS 层无任何用例 |
| 同步游标时钟回拨不丢条目 | ❌ | — | — | **S1-3** |
| 删除传播到离线设备 | ❌ | — | — | 同上 |
| 两端同改一条的冲突 | ❌ | — | — | 同上 |
| IDOR-订单 | ✅ | payment-refund.test.js:204-216；refund-request.test.js:234-243 | 他人订单与「不存在」同壳 404，渠道零调用，防探测 | — |
| IDOR-发票 | ✅ | invoices-read.test.js:160-177；invoice-download.test.js:202-227 | 他人发票 404；错误路径纯 JSON 不带附件头 | — |
| IDOR-剪贴板条目/设备/会话/AI 会话/文件/分享链接 | ❌ | — | — | **S1-5**；且 auth 旁路（所有请求=同一用户）使其在现基建下不可测 |
| 免费用户调付费接口被拒 | ❌ | —（subscriptionCheck/planFeature test 短路） | — | **S1-6** |
| token 档位过期不放行 | ❌ | — | — | 真 authenticateToken（含过期/黑名单/会话吊销）0 执行（S0-1）；api.test.js:97-129 只测 jwt 库本身 |
| 限流真的触发（登录/发码/重置密码） | ⚠️部分 | middleware/runtime-limits.test.js:165-210 | sendCodeLimiter 动态阈值 2 → 第 3 次 429 + Retry-After + 响应头；disabled 总开关放行；WS 连接数限制 | 单元层真实有效；但走**内存 store**（useRedis 仅 production），HTTP 端到端限流被 apiLimiter no-op 短路（rateLimiter.js:238），e2e 的限流用例 skip（e2e.test.js:274-285 甚至无断言） |
| 路径穿越文件名被拒 | ❌ | —（全 tests/ 无 traversal/`../` 上传用例） | — | storage.test.js 只测 local 后端读写契约（getFilePath 拼接，:80-83），未测恶意文件名；chunked-upload 路由 0 测试 |
| 上传超大文件被拒 / MIME 不合法被拒 | ❌ | — | — | config.test.js 的 upload 限额（20MB/50MB）无任何用例；/api/upload、/api/media 路由无测试 |
| IV 不复用 | ✅ | crypto.test.js:99-108,161-165 | 同明文两次加密 ciphertext/iv 不同；generateIV 12 字节且唯一 | — |
| 错误密码解不开 | ✅ | crypto.test.js:110-120 | 错 key 解密 throw | — |
| 跨端加密向量一致 | ❌ | — | — | crypto.test.js 只测 server 内部往返；与 desktop/mobile 的固定测试向量（golden vector）互验不存在——三端实现漂移无法被发现 |
| 事务回滚（多表写中途失败） | ⚠️部分 | integration.test.js:59-89（BEGIN/COMMIT/ROLLBACK 冒烟）；ai-rbac.test.js（withTransaction 全文件） | 事务机制可用；超管保护触发器 RAISE | 业务级「订单+订阅+用户三表写一半失败不留半成品」仅退款链路间接覆盖（refund-service 失败分支断言状态未动）；履约链路无中途失败注入测试 |
| async 路由抛异常被全局错误处理器兜住 | ⚠️部分 | admin/adminRoutes.test.js:107-115、adminAuth.test.js（mock DB 抛错 → 500 错误壳） | admin 面错误壳 { code:5000 } | 用户面路由（index.js:587 全局 handler）无「handler 主动 throw → 500 JSON、请求不挂死」用例（error-recovery 相应内容 skip） |
| 管理台 RBAC：只读角色写操作被拒 | ✅ | refund-service.test.js:561-579；admin-payment-surfaces.test.js:264-277；adminAuth.test.js 全文件；adminRoutes.test.js:53-68 | 无 perm → 403 { code:4030 }，渠道零调用，DB 状态不动；requireRole 等级门槛 fail-closed；DB 异常 fail-closed 500 | **真库 RBAC**（refund/grant 两个写面）+ 离线单测（中间件本身），组合扎实 |
| 普通管理员访问超管接口被拒 | ✅ | admin/roles.test.js（拒改 super_admin、越级 superAdminOnly 403）；ai-rbac.test.js:138-165（user 调 destroy_clips 拒、roleLevel 数值优先） | 越级/跨级防护 | roles.test.js 走 mock 事务（SQL 正确性除外） |
| performance/stress 阈值与 CI 稳定性 | ⚠️ | performance.test.js:77,97,119,130,151,172,220 | p95 100/200/500/200/300ms、50 并发<5s、内存<25MB | 阈值机器相关 + global.gc 不存在 + 计时不断言状态码 → 天然 flaky；stress 整文件 skip；CI 现状跑不到（S0-3） |

## 测试代码质量观察

**好的方面（明确记录，防止一刀切结论）**：
- 9 月中旬以来的「事故驱动回归测试」形成了成熟范式，质量显著高于旧文件：真库前置护栏（`dbName !== 'clipsync_test'` 即 throw，payment-webhooks.test.js:26-29 等 7 处）、测试内自生成 RSA 密钥做**真验签**（不是 mock 验签！alipay.test.js:25-29）、篡改/伪造/并发/幂等/边界负例齐全、断言打到 DB 终态而非只看响应码、注释写明「防复发目标」与事故编号。refund/proration/invoices/flag-gate 一线金钱链路目前是真防线。
- `test-helpers.js` 的 `withTransaction`（ROLLBACK 隔离）设计正确，可惜只有 ai-rbac.test.js 使用。
- 序列化执行（fileParallelism:false）+ 手机号号段分配的隔离策略目前有效（525 例 0 失败，实跑验证）。

**问题**：
- 两代测试质量断层严重：旧文件（api/integration/security/version/webhook/subscriptions/e2e/stress/error-recovery，约 2016 行）充斥恒真断言、skip、测第三方库；新文件（约 11k 行）质量高。旧文件提供的「覆盖感」是虚假的。
- 重复样板：seedOrder/readOrder/stubGatewayResponse/密钥对生成在 4+ 文件复制（合计 ~300 行），该抽 helper 未抽。
- 命名与断言不符：performance「内存增长应<10MB」断言 25MB；subscription-api「encrypted token」无加密；security「防止SQL注入」断言 not.toBe(500)。
- 魔法值分散：TEST_USER_ID 字符串在 8 个文件手写重复。
- `tests/admin/` 11 个文件风格统一（好事），但统一在 mock 范式上——范式本身测不到 SQL（S1-4）。

## 修复优先级建议（按性价比排序）

1. **修 CI 门禁（半天，收益最大）**：去掉 ci.yml 两层 `continue-on-error` 与 lint `|| true`；CI service container 与 `config/test.js` 对齐（5433→5432 或让 test 模式接受 `CLIPSYNC_TEST_DB_PORT` 类专用覆盖）；CI redis 加 requirepass；ci.yml 触发扩到发布分支；deploy.yml 加 `needs: test`。这是「判据仪器」本身的修复，不做则其它一切修复无法被守住。
2. **补支付宝回调 happy path + 金额不符 + 重放三件套（1 天）**：复用 alipay.test.js 的本地密钥模式向 `/api/webhooks/alipay` 打合法签名表单，断言订单/订阅/用户终态；金额不符、同 trade_no 重放、非法 trade_status 三个负例。这是「收钱不开通/重复开通」事故的直接防线。
3. **拆除 NODE_ENV==='test' 安全旁路（2-3 天，S0-1）**：改为可注入开关；随后解锁三类目前写不出来的测试——真 JWT 鉴权链（含黑名单/会话吊销）、HTTP 层 IDOR 矩阵（clipboard/device/session/AI 会话/文件/分享链接逐个资源）、CSRF/限流真链路。security.test.js 的 7 个 skip 与 csrf.test.js:134 随之复活。
4. **每个 admin 面补一条真库冒烟（1 天）**：users/orders/audit/overview/devices/plans/subscriptions/configs/roles 各一条「seed→打接口→断言字段」，封杀 u.name 类 SQL 列名事故的复发通道（已有 admin-payment-surfaces 范式可抄）。
5. **WS 握手与安全用例（半天）**：临时端口 listen(0) + ws 客户端：无 token→4001、坏 token→4002、黑名单→4004、超大 payload/畸形 JSON 不崩。
6. **同步正确性三件套（1 天）**：游标推进/回拨不丢、删除传播、并发冲突语义——产品核心功能目前裸奔。
7. **处理死代码与恒真断言（半天）**：e2e/stress/error-recovery 三个 skip 文件修复或删除；version/webhook/api/integration/subscription-api 的恒真断言重写为具体断言；performance 移出 PR 门禁。
8. **关单竞态 + 履约失败注入（1 天）**：closeExpiredOrders 与 markOrderPaid 的并发窗口、履约多表写中途失败的回滚。
9. **跨端加密 golden vector（半天，与桌面/移动审计联动）**：三端共享一组固定密钥+明文+期望密文向量，防实现漂移。
10. **清理仓库卫生（15 分钟）**：删 check-syntax.js、修 test:env 指向、把 .env.test 移出 git（改 .env.test.example + CI secrets）。
