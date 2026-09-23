# P0-C / C1 — 拆掉服务端生产代码里的 `NODE_ENV === 'test'` 安全旁路

分支：`test/admin-full-audit`（基于 `b7c16f4`）
范围：仅 `src/server/src/**` 与 `src/server/tests/**`（除 `tests/ai-orchestration.test.js`、`src/utils/audit.js`）
本文件随做随写。

---

## 0. 环境确认（改动前）

- DB：`clipsync_test` @ localhost:5433 —— 可达（`tests/setup.js` 的 beforeAll 会真连，连不上即整套失败）。
- Redis（测试实例）：localhost:6380 —— **可达**（实测 `getRedisClient()` 58ms 返回 client）。
  ⇒ 这意味着拆旁路后 `isJtiBlacklisted()` 是**真查 Redis**，不是走降级分支。
- 未新增任何依赖。

### 改动前基线（本机 HEAD 工作树，实测复跑，非引用票面数字）

```
cd src/server && npx vitest run
 Test Files  50 passed | 3 skipped (53)
      Tests  643 passed | 48 skipped (693)
   Duration  97.89s
```
与票面基线 643/0/48 一致。3 个整文件跳过：`e2e.test.js`(19)、`error-recovery.test.js`(10)、`stress.test.js`(7)。

---

## 1. 锚点复核（逐条）

| # | 锚点 | 复核结论 |
|---|------|----------|
| 1 | `src/server/src/index.js:367` | **成立**。`metricsAuth()` 首行 `if (NODE_ENV==='test') return next()` —— `/api/metrics` 与 `/api/metrics/prometheus` 在测试环境完全匿名可读，METRICS_TOKEN fail-closed 逻辑（同文件 354-363）与 `requireRole(50)` 全部未被验证。 |
| 2 | `src/server/src/middleware/auth.js:16` | **成立**。`authenticateToken` 直接注入固定用户 UUID `00000000-…-000000000001` 并 `next()`：真验签、挑战令牌拦截、Redis jti 黑名单、账户/会话活性双检（C1 修复）全部为 no-op。**这是全仓影响面最大的一条**。 |
| 3 | `src/server/src/middleware/csrf.js:144` | **成立**。`csrfProtection` 首行短路。注意：即使拆掉，该中间件对 `Authorization: Bearer *` 仍放行（153-159 行，设计如此——本站无 cookie 认证，见 §3 判断）。 |
| 4 | `src/server/src/middleware/planFeature.js:116` | **成立**。`requirePlanFeature()` 工厂首行短路 → 套餐功能墙（`team_management` / `ai_classify`）在服务端测试中从未生效。 |
| 5 | `src/server/src/middleware/rateLimiter.js:224` | **成立**。`createRateLimiter` 内 `if (NODE_ENV==='test' && storeName==='api') return next()` —— 影响所有以 `storeName:'api'` 构造的 limiter。 |
| 6 | `src/server/src/middleware/rateLimiter.js:269` | **成立**，且是**占位导出**：`apiLimiter = NODE_ENV==='test' ? (req,res,next)=>next() : createRateLimiter({...})`。上面 224 行的分支实际永远走不到（三元先把整个中间件换掉了）。 |
| 7 | `src/server/src/middleware/rateLimiter.js:421` | **成立**。`adminLimiter` 同样形态的 passThrough 占位导出。 |
| 8 | `src/server/src/middleware/rateLimiter.js:436` | **成立**。`adminStrictLimiter` 同样形态。 |
| 9 | `src/server/src/middleware/subscriptionCheck.js:11` | **成立**。`subscriptionCheck` 首行短路 → 订阅态/套餐配额从未在 HTTP 层被装配过，下游 `checkDeviceLimit` / `checkClipboardLimit` / `requireFeature` 因 `req.user.plan` 恒为 undefined 而全部走 `if (!plan) return next()` 的放行分支。 |
| 10 | `src/server/src/ws/server.js:92` | **成立但不是安全旁路**，判定保留（理由见 §5）。 |

补充（票面未列、与 F1 同源，本票范围内处理/报备）：
- `src/server/src/middleware/adminAuth.js:14` 的注释描述了 auth.js 的测试旁路（注释本身不是旁路；`adminAuth` 无 NODE_ENV 判断，管理端点在测试下确实 fail-closed，且 `tests/admin/*` 已按 `vi.mock('../../src/middleware/auth.js')` 自注身份）。**改 auth.js 后需同步更正该注释**，否则注释会变成假的。
- `src/server/src/middleware/csrf.js:13` / `idempotency.js:20` / `chunked-upload.js:98` / `rateLimiter.js:219` / `redis-map.js:187` 的 `useRedis = NODE_ENV === 'production'`：**存储选型（Redis vs 进程内存），两条分支都执行真实校验/计数，不是安全旁路**，本票不改（改它需要测试环境 Redis 键空间设计，属另一张票）。
- `src/server/src/db/pool.js:32`：`if (NODE_ENV !== 'test')` 控制的是连接池监控/日志，非安全路径，不改。

---

## 2. 替代方案（每条旁路改成什么、测试为什么仍然算真验过）

> 本节由接手代理从 `git diff` 反推补写。前任没留文字记录，所以表里三栏分别是：
> **「改动内容」= diff 能确证的事实**、「替代手段」= 现在靠什么让测试跑得动、
> **「判据」= 删掉哪条用例会红**（能答出这条，才算"仍真验过"）。
> 动机只在能反推处写，反推不出的写「意图不可考」（§9-H）。
> 判「是不是放水」只看两条：① 断言有没有被弱化；② helper 是不是原有的。全表按这两条给结论（逐条清单见 §7）。

| # | 旁路（§1 编号） | 改动内容（diff 确证） | 让测试继续跑得动的替代手段 | 「仍然算真验过」的判据（删掉哪条用例会红） |
|---|---|---|---|---|
| 1 | `index.js` metricsAuth | 删掉 `if (NODE_ENV==='test') return next()`，只留注释 | 无替代；测试改为显式带凭据 | `tests/security.test.js > GET /api/metrics 鉴权`：匿名→401、prometheus 匿名→401、普通用户 token→403（这条穿的是 `requireRole(50)`）。把旁路加回去 → 这三条立刻红。 |
| 2 | `middleware/auth.js` authenticateToken | 删掉固定用户注入分支（18 行） | `tests/test-helpers.js` 新增 `signAccessToken()/authHeaders()/ensureAuthUser()`：**用 `config.jwt.secret` 真签 JWT**（与 auth.js 验签同一个值，凭据值不出现在测试代码里）+ users 表真账号 | 实测 17 个测试文件引用了这两个 helper；`security.test.js` 新增三条（别的密钥签的 token→401、过期 token→401、真 token+真账号→200）。把签名密钥换掉或把 userId 换成库里没有的 → 大批用例红。helper 是**新增**的（原有 helper 一个没改）。 |
| 3 | `middleware/csrf.js` csrfProtection | 删掉首行短路 | 无替代；请求本身必须长成生产形态 | `feature-flags.test.js` 的 enable_public_sharing 用例（见 §4.2 —— 它就是被这条真分支打红的）+ `security.test.js` CSRF 章节两条：匿名 POST→401 且 `code!=='CSRF_INVALID'`、Bearer POST→not 403。设计判断见 §3。 |
| 4 | `middleware/planFeature.js` requirePlanFeature | 删掉工厂首行短路 | —— | **⚠ 本节唯一"改了但零效果"的一条**：实测 `requirePlanFeature` 全仓只有 `export`，**没有任何挂载点/引用**（grep `planFeature` 在 src/ 与 tests/ 仅命中两处注释）。所以拆旁路前后行为完全一致，既没有测试收益也没有风险。§1 #4 的结论（这道墙从未生效）成立，但**归因不是 NODE_ENV**——是这道墙从来没接线。见 §9-A。 |
| 5 | `rateLimiter.js` createRateLimiter 内 `storeName==='api'` 分支 | 删掉 | `resetAllRateLimitStores()`（新增导出）+ `tests/setup.js` 的 `beforeEach` 清零 | `tests/middleware/runtime-limits.test.js`（动态阈值真生效）+ `auth-s0-security.test.js` 的 429 两条（现已改为单用例内打满，见 §4.1）。 |
| 6-8 | `apiLimiter` / `adminLimiter` / `adminStrictLimiter` 三处三元占位导出 | 三元整体删除，改为恒定 `createRateLimiter({...})`（参数一字未改） | 同上（清零替代占位函数） | 224 行那条分支此前"永远走不到"是 §1 #6 已核实的事实；现在每个 limiter 只有一份实现，不存在"测试里是空函数"的第二形态。**直接凭据（本轮新增用例）**：`tests/middleware/runtime-limits.test.js > apiLimiter 不再是 test 占位函数` —— 把 `rate_limit_api_per_min` 配成 2，同一 userId 第 3 次调用必须 429、且 `next()` 不被调用、响应头 `X-RateLimit-Limit:2` 必须存在（占位函数三样都做不到）。 |
| 9 | `middleware/subscriptionCheck.js` | 删掉首行短路 | 无替代 | `req.user.plan` 现在真的从库加载 ⇒ `checkDeviceLimit`（挂在 `index.js:410` 的 POST /api/devices）第一次具备拒绝能力。**注意：没有任何用例证明它真的会拒**（§9-B）。拆旁路的价值在于它不再是"测试里恒真"的黑洞，代价是 §6 的三条新缺陷暴露。 |
| 10 | `routes/clipboard.js` + `routes/versions.js` | 不是拆旁路，是拆旁路后撞出来的真 bug 修复 | —— | 见 §6。 |

### 2.1 我这一轮对替代方案本身做的两处修正

1. **`beforeEach(resetAllRateLimitStores)` 的副作用**（前任的选择本身我判定成立，但它没交代代价）：
   清零是**全局、每用例一次**的，任何「依赖前一条用例残留计数」的用例都会失去前提 —— 实测撞倒了
   `auth-s0-security.test.js:289`（§4.1）。方向我认可（用例内阈值真生效 > 跨用例累加的巧合），
   但从此**写限流用例必须在同一用例内打满阈值**，这条口径已写进 `setup.js` 与
   `auth-s0-security.test.js` 的文件头注释。
2. **`security.test.js` metrics 直通用例是"静默通过"，不是"跳过"**：原写法
   `const token = process.env.METRICS_TOKEN; if (!token) return;` —— 实测 `.env.test` 里
   `METRICS_TOKEN` **未配置**（只看变量名，未读任何值），所以这条永远走 `return`，在报告里显示成一条
   绿用例 = 用"看起来覆盖了"顶替"覆盖了"。已改为 `it.skipIf(!process.env.METRICS_TOKEN)`，
   现在它显式计为 skipped（数字见 §8）。**这不是弱化**：原用例在该环境下本来一条断言都不会执行。
   另外记一笔：`index.js:362` 在非生产给 METRICS_TOKEN 留了**写死在源码里的兜底字面量**（值不抄进本文件），
   所以 `metricsAuth` 的 503 fail-closed 分支在测试环境**结构上不可达**，见 §9-C。

---

## 3. 判断：CSRF 为什么可以放行 Bearer（兑现 §1 表 #3 的引用）

接手代理独立复核过，不是照抄前任：

- **本站没有任何 cookie 认证**：`grep -rn "cookieParser|express-session|res.cookie(" src/` → 零命中。
  CSRF 的前提（浏览器会自动带上凭据）不成立。
- **每一处 csrfProtection 都排在 authenticateToken 之后**：活挂载点共 **21 处**（`index.js` 20 处 +
  `routes/sharedLinks.js:22` 的 `protect = [authenticateToken, csrfProtection, …]`），逐条看过，
  全部形如 `app.use('/api/x', authenticateToken, …, csrfProtection, …)`。
  ⇒ 能走到 CSRF 校验的请求必然已带 `Authorization: Bearer …` ⇒ csrf.js 的"校验 CSRF token"分支
  在应用内**结构上不可达**（`if (!userId) return next()` 那条同理）。
  ⚠ 前任写在 `security.test.js` 里的「index.js 里 24 处挂载点」是把 import 行与两行注释也数进去了，
  实数 20 处；该注释本轮已按实测更正。
  ⚠ 另：`src/utils/route-loader.js` 里还有一份挂载表（也写 csrfProtection），但**没有任何模块 import 它**
  （实测 grep 零命中）⇒ 死表，不构成挂载点；它写的口径（如 `/api/subscriptions` 挂 authenticateToken、
  `/api/clipboard` 挂 checkClipboardLimit）与 index.js 现状**不一致**，见 §9-J。
- **真正承载 CSRF 的是 WS 握手**：`ws/server.js:155-196` 自己校验 `?csrf_token=`（Redis 键前缀 `csrf:`、
  一次性消费），这条我读了代码、未跑用例（不在本票范围）。
- **但"不可达"只对真 authenticateToken 成立**：`feature-flags.test.js` / `tests/admin/*` 用
  `vi.mock('../../src/middleware/auth.js')` 注入身份、又不带 Bearer 头 ⇒ 该分支在**打桩测试里可达**。
  §4.2 那条失败就是这条判断的实证。⇒ 拆掉 CSRF 旁路的实际收益不是"多验一道 CSRF"，
  而是**把测试自己造的假请求形态暴露出来了**。

---

## 4. 三个失败的收尾（我这一轮的全部改动）

### 4.1 `tests/auth-s0-security.test.js`「连续尝试触发 429」

**根因（不是限流没生效，是用例的前提被换掉了）**

- 路由确实挂了 limiter：`routes/auth.js:896` = `authCodeIpLimiter, authCodeAccountLimiter`
  （两条都是 `storeName:'authCode'`、`windowMs:15min`、`max:5`，键分别是 `authCode:ip:<req.ip>` 与
  `authCode:id:<归一化 email>`）。`trust proxy`/`clientIp` **本票一行都没改**（票面提示里"前任改过
  trust proxy 与 key 归一化"这一点我实测**不成立**：`git diff` 里 `index.js` 只动了 metricsAuth，
  `rateLimiter.js` 的 `clientIp/normalizeIdentity` 未被触碰）。
- 没有 `skipFailedRequests`/`statusCode` 这类配置，也不看业务响应码 —— 401 一样计数（内存桶实现
  `checkRateLimitMemory` 只支持 `skipSuccessfulRequests`，且这两个 limiter 都没开）。
- Redis 分支不参与：`useRedis = NODE_ENV==='production' && REDIS_HOST`，测试环境
  （`.env.test` 未设 `REDIS_HOST`，实测确认）走内存桶，`resetAllRateLimitStores()` 清的正是它。
- **真正的前提**：该用例原注释自己写着「前面的用例已消耗 3 次 IP 额度，这里再打 4 次必然越过阈值」
  —— 它靠同文件相邻用例在**同一个 IP 桶**上留下的 3 次残留才凑满 5+1。前任新增的
  `tests/setup.js` `beforeEach(resetAllRateLimitStores)` 把桶清成 0 ⇒ 只剩 4 次 ⇒
  永远不到阈值 ⇒ 4 次全 401。单跑/全跑都一样红，与并发无关。
- **为什么此前一直绿**：拆旁路前 `authCode` 这条 limiter 从来不被旁路（旁路只对 `storeName==='api'`），
  所以它的跨用例累加一直是真的；用例只是搭了"没有用例级清理"的便车。

**修法（没有碰任何 limiter 配置、没有加 passThrough、没有改阈值、没有清 Redis）**

在该用例内打满真实阈值，并把阈值精确值钉成断言：6 次请求，前 5 次必须 **401**（限流器不得吞业务响应），
第 6 次必须 **429**。比原来的 `expect(statuses).toContain(429)` **更强**（原断言既不能区分"第 6 次才拒"
与"第 2 次就误杀"）。同时更正文件头那段描述旧世界的注释。
内存桶语义核对：`if (timestamps.length >= max)` ⇒ 第 1..5 次放行、第 6 次拒，与断言一致。

### 4.2 `tests/feature-flags.test.js:113`「创建分享 403 但 flagDisabled undefined」

**先推翻票面的假设**：这不是 `subscriptionCheck`/`planFeature` 造成的 —— `/api/shared-links`
这条链路上**根本没挂** `subscriptionCheck`（`index.js:552` 只有 `apiLimiter` + 路由内部
`protect=[authenticateToken, csrfProtection, …] → apiLimiter → requireFlag('enable_public_sharing')`）。
把 `req.user.plan` 变活的改动对这条路径**零影响**。

**真实闸门 = csrfProtection**（三步实测钉死，不是推理）：
1. 用假 req 直接调中间件：POST + 无 `Authorization` + `req.user` 已注入 ⇒
   `403 {error:'Invalid or expired CSRF token', code:'CSRF_INVALID'}`；同一 req 加 `Bearer ` 头 ⇒ next()。
2. 本文件用 `vi.mock` 桩掉 authenticateToken 并注入超管（csrf.js 没被桩）⇒ 恰好命中上面第一种形态。
3. 因此 `requireFlag` 从未被执行，`flagDisabled` 自然 undefined。

**生产上这条路径的真实优先级**（就是代码里的挂载顺序，我已核）：
`apiLimiter → authenticateToken(401) → csrfProtection(403/401) → apiLimiter → requireFlag(403+flagDisabled) → handler`。
`flagDisabled` 字段**只可能由 `utils/featureFlags.js:59 requireFlag` 写进 body**，没有第二个人写它。
⇒ 一个真实的已登录客户端（永远带 Bearer）在开关关闭时得到的正是 403 + `flagDisabled:'enable_public_sharing'`；
测试里之所以偏，是因为**用例发的是一条生产上不存在的不带凭据请求**。

**修法（没有删断言、没有放宽断言）**
给该请求补上真签名的 Bearer 头（`signAccessToken({userId: adminId})`，走的是 csrf.js 那条 Bearer 放行分支
= 生产客户端的真实形态），使请求真正走到 `requireFlag`；并**新增**两条断言把 403 钉死在开关闸门上：
`res.body.code !== 'CSRF_INVALID'`、`res.body.error` 含「共享链接功能已由管理员关闭」。
顺带更正本文件头"test 环境真实链路会被固定 level=10 测试用户替换"的过期说明（该旁路已不存在，
打桩的真正理由是"需要一个超管身份"），并把 `adminAuth.js:14` 的注释同步更正（§1 补充项，前任已改，我核过措辞与事实一致）。

### 4.3 `tests/performance.test.js:62` beforeAll 撞 `devices_user_id_device_name_key`

**判定：(b) 测试库脏数据 + 清理不彻底 —— 且清理失效是"全局静默失效"，不只是这一个文件的问题。**
(a) 不成立：`createTestDevice(...,'性能测试设备')` 这一行在 HEAD 版本里就在（diff 只是删了那条
`if (NODE_ENV==='test')` 死分支），helper 本身**未被前任改过**（`git diff` 里 test-helpers.js 只有
新增的 4 个导出）。(c) 半对：用例本来就不幂等（裸 INSERT + 固定 (user_id, device_name)），
但它过去能反复绿，因为全局清理本来会把 139xx 测试账号连带级联删掉。

**证据链（全部实测，非推理）**
1. 库里有 `users.phone='13900440000'`（created 2026-09-23T04:32:20Z，即 12:32 本地——**早于** owner
   12:34/12:36 的两次运行）与 `devices.device_name='性能测试设备'` 同行，user_id 指向该账号 ⇒
   失败是"上一轮残留"，不是并发。
2. `tests/setup.js` 的 `DELETE FROM users WHERE phone LIKE '13800%' OR phone LIKE '13900%'` 在
   BEGIN/ROLLBACK 里真跑一次：**23503 `clipboard_deletions_user_id_fkey`**。
3. 成因：`trg_clipboard_deletion_tombstone`（AFTER DELETE ON clipboard_items，函数
   `fn_clipboard_deletion_tombstone`）会 `INSERT INTO clipboard_deletions(user_id, item_id) VALUES(OLD.user_id, OLD.id)`。
   删 users 时 PG 级联删 clipboard_items，触发器写入的 user_id 正是**同一语句里正在被删**的用户
   ⇒ 外键立即检查失败 ⇒ 整条清理回滚 ⇒ 被 `catch` 吞成一行 warn，从此**每个测试文件开头都静默不清理**。
4. 为什么以前不炸：拆旁路前所有 `POST /api/clipboard` 都被 auth.js 白送给固定 UUID
   `00000000-…-01`，139xx 账号名下**没有 clipboard_items** ⇒ 级联碰不到触发器。
   前任让真实用户持有自己的行之后（perf 用户名下实测 100 条），这条清理语句才第一次被触发器咬住。
5. 单独验证过修法：BEGIN 里先删 clipboard_items 再删 users ⇒ `items=102, users=3`，ROLLBACK，无报错。

**修法（"让用例自己造干净前置态" + 修好清理，不手工删库）**
- `tests/setup.js`：把清理改成外键安全顺序（refund_requests → file_versions → clipboard_items → users），
  并把删除行数打进日志（原来那行 warn 会把硬错误伪装成"清理跳过"）。顺序理由写进注释，
  因为这是个会再踩的坑。
- `tests/performance.test.js`：beforeAll 里先 `DELETE FROM devices WHERE user_id=$1`（用例自己的账号）
  再造设备 —— 这样即使全局清理哪天又坏，该文件也不会整片红。`createTestDevice`（原有 helper）语义未改。
- 收尾后实测：50 个测试文件**全部报"旧测试数据已清理"，零次"清理跳过"**。

### 4.4 本轮（收尾）改动的文件清单，供逐文件复核

| 文件 | 改了什么 | 性质 |
|---|---|---|
| `tests/auth-s0-security.test.js` | 429 用例改为自足（4→6 次、断言钉阈值）；文件头旧世界描述更正 | 修失败 + 记口径 |
| `tests/feature-flags.test.js` | 分享用例补真签名 Bearer 头 + 2 条新断言；文件头过期说明更正 | 修失败 |
| `tests/setup.js` | 全局清理改外键安全顺序（refund_requests→file_versions→clipboard_items→users）+ 删除行数打进日志 + 顺序理由写进注释 | 修失败根因 |
| `tests/performance.test.js` | beforeAll 增"删自己的设备再建"前置态 | 修失败（纵深防御） |
| `tests/security.test.js` | 新增 tsquery 回归用例（覆盖两个分支）；metrics 直通改为显式 `it.skipIf`；CSRF 挂载点注释按实测更正（24→20+1） | 补覆盖 / 去假绿 |
| `tests/middleware/runtime-limits.test.js` | 新增 apiLimiter 429 用例；更正"apiLimiter 在 test 下整体短路"那句已失效的注释 | 补本票核心凭据 |
| `src/routes/clipboard.js` | **只改注释**（buildTsQuery 的字符清单按实测更正）。未碰 `AUDIT_ACTIONS.CLIPBOARD_CREATE/DELETE`（`git diff` 反查确认零命中，owner 自己的票） | 记录纠偏 |
| `src/routes/versions.js` | **只改注释**（content_preview/content_size 并非 NOT NULL，实测 information_schema）；行为一字未改（§5/§9-E） | 记录纠偏 |

未改：任何 limiter 配置、阈值、`trust proxy`、`clientIp/normalizeIdentity`、`package.json`、
依赖、禁改清单里的文件（见 §9-O）。**没有任何一处用"重新留 passThrough / 调大阈值 / 清 Redis"把红变绿。**

---

## 5. 判定保留不动的（兑现 §1 表 #10 的引用）

接手代理独立复核，结论与前任一致，另补一条：

- `ws/server.js:92` 及 `useRedis = NODE_ENV === 'production'` 系列（`csrf.js:13`、`idempotency.js:20`、
  `chunked-upload.js:98`、`rateLimiter.js:219`、`redis-map.js:187`）：**存储选型开关**，两条分支都执行
  真实的校验/计数逻辑，不是"测试里把安全关掉"。`ws/server.js:160` 的
  `if (config.nodeEnv === 'production' || csrfToken)` 方向上是**生产更严**（生产无条件要 CSRF token，
  dev/test 只在带 token 时校验），拆掉它只会放宽生产语义或破坏本地联调，两者都不是本票目标。
  改它需要"测试环境 Redis 键空间 + WS 测试基建设计"，属另一张票（§9-D）。
- `db/pool.js:32`（`if (NODE_ENV !== 'test')` 控制 statement_timeout / 连接监控日志）：
  非安全路径，不改。
- **新增保留项**：`routes/versions.js` 的 contentPreview/contentSize 400 校验。
  见 §6-④：它属于"主动收紧契约"而不是修 bug（这两个列其实可空且有默认值）。
  我**没有**改行为——本仓没有任何 POST /api/versions 的调用方（desktop 只用 GET 与 restore），
  所以无存量伤害；但它和它带的 5 条断言是"实现自己定义的契约"，该不该放宽由 owner 定（§9-E）。
  我只更正了那段把两列说成 NOT NULL 的注释（按 information_schema 实测）。

---

## 6. 拆旁路后新暴露的真 bug 清单

> 共同点：这些都不是"测试写错了"，而是过去被旁路挡在 handler 之外的真实请求第一次打进来。
> 每一条都给得出"删掉修复后哪条用例会红"。

**① 搜索词触发 tsquery 语法错误 → HTTP 500（前任修，我保留并更正其注释）** — `routes/clipboard.js`
- 现象：`GET /api/clipboard/search?q=` 与 `GET /api/clipboard?q=` 对含 tsquery 运算符的搜索词稳定 500
  （`sanitizeString()` 的 HTML 实体转义结果 + 用户输入的运算符直接拼进 `to_tsquery`）。
  **参数化是对的，不是注入**；错在错误没兜住、进 tsquery 前没清洗。任何登录用户可复现。
- 我逐字符实测复核（把旧实现的产物真送去 `to_tsquery` 跑）：**会 500 的是 `(` `)` `:` `!`**
  以及 `'; DROP TABLE users; --`（转义后含 `#x27;` 组合）；
  **不会 500 的是 `&` `|` `;` `*` `<` `>`**。
  ⇒ 前任写在 `buildTsQuery` 上方的清单（「`&` `;` `#` 与 `| ! ( ) < > : *` 全是非法字符」，
  并举例 "Q&A"、"a|b" 会 500）**是未经实测的夸大**：实测 `Q&A`、`a|b` 在旧实现下**不报错**。
  已按实测更正该注释。**修复本身保留**（它覆盖的是真会 500 的那批）。
- 补覆盖：新增用例 `搜索词含 tsquery 运算符或纯符号时不得 500（两个分支都钉）`，
  钉 `c:(d)`/`a(b`/`a!b`（旧实现下 42601）与 `!!!`/`<>&`（新实现下 `tsQuery` 为空 ⇒
  走 ILIKE-only 分支）两类；该 else 分支与 `/search` 里 `relevanceExpr='0'` 此前**零覆盖**。
  参数占位符编号我逐条对过（tsQuery 分支 push 3 个/`paramIndex+=3`，空分支 push 1 个/`+=1`，
  列表 SQL 与 COUNT SQL 共用同一 whereClause）⇒ 无 off-by-one。

**② POST /api/versions 缺正文 → 500（前任修）**
- `contentEncrypted` 是唯一真正 NOT NULL 的正文字段（实测 information_schema）；缺失时撞非空约束被
  catch 兜成 500。现在 400。`contentSize` 传非数字同理（22P02 → 500）→ 现在 400。
- 用例会红：`version.test.js > 缺 contentEncrypted / contentPreview / contentSize → 400，不是 500`
  （其中 `contentEncrypted: undefined`、`contentEncrypted:''`、`contentSize:'abc'` 三例是真 500→400；
  `contentPreview:''`、`contentSize:-1`/缺失 属 §6-④ 的收紧，不是 500 修复）。

**③ POST /api/versions 可把版本挂到他人设备（前任修）**
- 旧代码只校验 clipboardItemId 归属，`sourceDeviceId` 原样落库 ⇒ 可为别人的 device_id 造版本行（冒名/污染对方时间线）。
  现在校验设备归属 + UUID 格式，不属于自己 → 404（不泄漏存在性）。
- 用例会红：`version.test.js > sourceDeviceId 不属于自己 → 404`。这是本票范围外**顺带发现的真缺陷**，
  我复核判定成立、修复方向正确。

**④ 配额契约收紧过头（前任引入，我未改，交回定夺）**
- `content_preview` 默认 `''`、`content_size` 默认 `0`，**都可空**（information_schema 实测）。
  新增校验把"缺这两个字段"也拒成 400 ⇒ 拒掉了库里本来合法接受的请求形态。
  判据：若哪天有客户端只提交正文密文不提交 preview，它会得到 400 而不是过去的一致性默认值。
  本仓无调用方 ⇒ 今天无伤害。**没有回退路径**（不像维护/开关能一键放行），所以必须显式登记（§9-E）。

**⑤ 全局测试清理静默失效（我这一轮发现并修）** —— 见 §4.3，根因是 `trg_clipboard_deletion_tombstone`
  与级联删除的外键撞车。这条的影响面覆盖**所有** 53 个测试文件，不止 performance。

**⑥ `/api/sync/push` 绕过 `max_clipboard_items` 配额（本轮实测到，未修，非本票范围）**
- `subscriptionCheck` 拆旁路后 `req.user.plan` 真的有了；条数墙 `checkClipboardLimit` 只挂在
  `routes/clipboard.js:556` 的 POST 上，而 `/api/sync/push` 的 `changes[].action==='create'` 同样写
  clipboard_items 却不经过它。实测：一个 Free 账号（`max_clipboard_items=50`）在 performance.test.js
  一轮跑完后名下有 **100 条**（50 条走 POST /api/clipboard 正好卡在 50 的天花板内，另外 50 条走 sync/push 无校验）。
  ⇒ 配额墙可以从 sync 侧整段绕开。属产品/计费边界缺陷，**不是测试问题**，已登记（§9-F）。

**⑦ `POST /api/clipboard` 的 P95 以前测的是"被旁路阉割过的链路"（本轮实测到，未修，交回定夺）**
- 拆旁路前该端点的 5 个中间件全部短路，`measurePerf` 计到的是几乎裸 handler 的耗时；
  现在每请求真实多 **4 次 DB 往返**（已逐条定位）：`auth.js:53` 账户活性、
  `subscriptionCheck` 查 users、`getPlanByName('Free')` 查 subscription_plans、
  `checkClipboardLimit` 的 `COUNT(*)`。⇒ 同一台机器上 500ms 的 SLO 预算被真实吃掉了大半。
- 实测分布（**阈值我一个字没改**）：单跑 performance.test.js 两次 p95 = **216ms / 181ms（绿）**；
  全量 53 文件并发跑一次 p95 = **592ms（红：expected 592 to be less than 500）**、
  另三次全量跑 181–220ms 量级（绿）。⇒ **边缘性 flake**，在全机负载（兄弟代理在编译 / owner 真机调试）
  下会翻红。这不是"用例写错"，也不是可以靠调大阈值了事的：`toBeLessThan(500)` 是产品 SLO，
  调它=改契约，必须 owner 拍板（要么显式改 SLO 数字并记原因，要么把 plan/配额查询做进程内缓存）。
  见 §9-L。
- 同一用例的另一面：它只断言延迟、**完全不看状态码**（`measurePerf` 不检查 res.status）
  ⇒ 配额墙 403 也算"响应快"。今天 50 次写入正好卡在 Free `max_clipboard_items=50` 天花板内
  （`timestamps.length >= max` 式判定：第 50 次时库里是 49 条 → 放行），所以没咬到；
  但只要这条用例的迭代数被调到 51+，它就会开始静默把 403 当成性能样本测。已登记（§9-M）。

---


## 7. 动过的每一条断言（逐条）

统计口径：`git diff`（工作树 vs HEAD，含本票两任代理的全部改动）里删除/新增的 `expect(` 行数 ——
version.test.js -8/+21、security.test.js -1/+18、subscriptions.test.js -1/+3、
runtime-limits.test.js -0/+6（我，全是新增用例的断言）、auth-s0-security.test.js -1/+2（我）、
feature-flags.test.js -0/+2（我）、invoices-read.test.js -3/+3（同行改写）、
payment-refund.test.js -1/+1（同行改写）、
其余 10 个测试文件 **±0**（只加 `.set(auth)` / `.set(authHeaders())`，断言一字未动）。

| 文件 / 用例 | 原断言 | 新断言 | 是否弱化 | 理由 |
|---|---|---|---|---|
| security.test.js：搜索注入、设备注册注入、存储型 XSS(设备名) | `it.skip`（整条不执行） | `it` + 原断言 + 额外库侧断言（users 表仍在 / 落库名等于转义串且不含 `<script`） | 否，**从"零验证"变成有验证** | 原来 skip 的理由是"测试环境走 mock"，旁路没了之后能跑 |
| security.test.js：CSRF 攻击测试（原 `describe.skip`） | `expect([403,404]).toContain(...)` 且整段不执行 | 两条：匿名 POST→**401 且 code≠CSRF_INVALID**；Bearer POST→**not 403** | 否（覆盖面重定义，见 §3） | REST CSRF 分支在生产不可达，硬造 403 断言只能靠环境旁路 |
| security.test.js：认证绕过 / 权限提升（原 `describe.skip`） | 不执行 + `expect([403,404])` | 401/401/403 确定性断言 + 3 条新用例（别的密钥、过期 token、真 token 放行） | 否 | 同上 |
| security.test.js：metrics（**我这一轮**） | `if (!token) return;` 后 `expect(200)` | `it.skipIf(!process.env.METRICS_TOKEN)` + 同一断言 | 否（原写法的断言永不执行） | 见 §2.1-2 |
| version.test.js：5 处 `expect([201,404,200]).toContain(res.status)` 等"或"断言 | `expect([201,404,200])` / `[200,404]` / `[400,404]` | `toBe(201)`/`toBe(200)`/`toBe(400)`/`toBe(404)` 等确定性 | 否，**这是本轮最典型的"假绿"清理** | 前任注释说得对：旧世界所有请求都被 auth 白送给固定 UUID，数据挂在别的 UUID 名下 ⇒ 恒 404 ⇒ "或 404" 永远绿，一条都没验过版本创建 |
| version.test.js：`应该拒绝无效token` | `expect(res.status).toBe(403)` | `toBe(401)` | 否 | 该断言在原 `describe.skip` 里从未执行；真实实现返回 401 |
| version.test.js：`应该成功回滚到指定版本` | `expect([200,404]).toContain` | `toBe(404)`（并改名说明路由不存在） | **是——但对象是"不存在的路由"** | 服务端真实端点是 `POST /api/versions/restore/:versionId`；用例打的路径压根没注册。钉 404 = 钉住现状，将来实现了这条会红，届时必须改断言（前任注释已写明） |
| version.test.js：`应该成功删除版本` | `expect([200,404]).toContain` | `toBe(404)` | 同上，同一处理 | `DELETE /api/versions/:versionId` 未实现（我核过 routes/versions.js 的注册列表） |
| version.test.js：`创建多个版本应触发自动清理` | 循环里不检查响应 + `expect([200,404])` | 循环里 `toBe(201)` + `versionNumber` 逐条递增 + 列表非空 | 否，变强 | 旧用例连"版本建没建成"都不看 |
| version.test.js：缺正文 5 例 400 | 不存在（只有 `expect([400,404])`） | 新增 `for` 循环 5 例 `toBe(400)` | 否 | 其中 2 例是 §6-④ 的收紧断言（若 owner 决定放宽 preview/size，需同步删这 3 例：`contentPreview:''`、`contentSize:'abc'`、`contentSize:-1`） |
| subscriptions.test.js：`应该拒绝未认证的请求`(/plans) | `if (NODE_ENV !== 'test') expect([401,403])` | 改名 + `toBe(200)`，并**新增** `/current → 401` | 否，但**断言方向翻转**，需要证据 | 我核过 `routes/subscriptions.js:15` 的 `/plans` 确实**不挂** authenticateToken（公开目录），`:46` 的 `/current` 挂了 ⇒ 旧用例期望的 401 对这个端点从来是错的（且被 `if` 跳过）。新断言把"这个端点是公开的"钉成显式决定，并补了真正该 401 的端点。**若产品认为 /plans 不该匿名可读，那是另一张票**（§9-G） |
| invoices-read.test.js / payment-refund.test.js | 3+1 行 `expect(...)` | 同一断言，只是链式加了 `.set(auth)` | 否 | diff 是同行改写 |
| **我这一轮**：auth-s0-security `429` | `expect(statuses).toContain(429)`（4 次，靠邻用例残留凑数） | 6 次：前 5 次 `toEqual([401×5])` + 第 6 次 `toBe(429)` | 否，变强 | §4.1 |
| **我这一轮**：feature-flags `enable_public_sharing` | `toBe(403)` + `flagDisabled==='enable_public_sharing'` | 同两条 + `code!=='CSRF_INVALID'` + error 文案 | 否，变强（多了"必须来自开关闸门"的判据） | §4.2 |
| **我这一轮**：runtime-limits `apiLimiter` | 不存在（该文件旧注释反而声称"apiLimiter 在 test 下整体短路"，即**明写自己不测它**） | 新增 1 条用例：阈值 2 → 第 3 次 429 + `next()` 未被调用 + `X-RateLimit-Limit` 存在 | 否，从"自我声明不覆盖"变成有直接凭据 | 本票核心断言（占位导出已拆除）此前**没有任何用例能证伪**；旧注释已同步更正 |
| helper 变更 | —— | `test-helpers.js` 只**新增** `TEST_USER_ID/TEST_PHONE/signAccessToken/authHeaders/ensureAuthUser`；`ensureTestUser/createTestDevice/createTestClipboardItem/cleanupTestData/getTestApp` 等原有 helper **一字未改** | —— | 判放水的第二条：没有为了变绿去改共享 helper 的语义 |

---

## 8. 数字（实测，非引用票面）

| 阶段 | Test Files | Tests |
|---|---|---|
| 拆旁路前基线（§0，前任实测） | 50 passed / 3 skipped (53) | **643 passed** / 48 skipped (693) |
| 前任交件时（owner 复跑） | 3 failed / 47 passed / 3 skipped (53) | 2 failed / 656 passed / 46 skipped (706) |
| **本轮收尾后（`npx vitest run`，exit 0，86.4s）** | **50 passed / 3 skipped (53)** | **666 passed / 40 skipped (708)**，**0 failed** |

- 相对基线净增 **23 条通过用例**（新增/解 skip +24，转显式 skip -1），文件数不变。
- 收尾过程逐条验证：先单跑三个红文件（`3 passed`，25 passed / 1 skipped）→ 全量（下表旧一次）→
  补 apiLimiter 用例后再全量一次（=上表）。同一天共 5 次全量，最后一次才是上表数字。
- **唯一非确定性**：`performance.test.js > POST /api/clipboard 应在500ms内响应（P95）`
  在 5 次全量里**红过 1 次**（592ms > 500ms，见 §6-⑦/§9-L），其余 4 次全量与所有单跑均绿；
  上表这次是绿的。**没有为了变绿改过任何阈值。**
- skipped 从 48→40 的构成：performance.test.js 的 beforeAll 不再炸（该文件的 8 条从"整片 skipped"变成
  7 passed + 1 条 `it.skip`「20 个并发写」——后者 HEAD 里本来就 skip，未动）；新增 1 条 metrics 显式 skip。
- 「passed+skipped ≠ 总数」的 2 条差额在**基线输出里同样存在**（643+48=691 vs 693），是 vitest 对
  整文件 skip 的计数口径，不是丢用例；两轮差值一致，故不影响结论。
- 全量运行期间 `旧测试数据已清理` 出现 **50 次**、`测试数据清理跳过` 出现 **0 次**
  （§4.3 修复生效的直接读数；修前每次都是那条 warn 被吞掉）。

---

## 9. 未尽事项 / 交回 owner 的判断

- **A. 套餐/权益墙接线情况（实测逐个点名）**：
  - `planFeature.js` 的 `requirePlanFeature` —— 只有 `export`，**全仓零引用**（含 tests）⇒ 这道墙完全不存在。
  - `subscriptionCheck.js` 的 `requireFeature` —— 在 `index.js:48` 被 import，但**从未挂到任何路由** ⇒ 死代码。
  - `checkClipboardLimit` —— 只挂在 `routes/clipboard.js:556`（POST /api/clipboard）一处；
    `/api/sync/push` 的 create 路径不经过它（见 F）。
  - `checkDeviceLimit` —— 挂在 `index.js:410`（POST /api/devices），是本票拆完旁路后**唯一真正活着的权益墙**。
  ⇒ 想验「Free 不能用 team_management / ai_classify」这条产品承诺，服务端目前没有任何强制点。
  本票不动它（拆一个没接线的旁路不产生任何安全收益），需要开票。
  完成判据：任一端点挂上该墙 + 一条「Free→403 / Pro→200」的用例。
- **B. 设备数上限墙无拒绝侧用例**：`checkDeviceLimit` 现在真的会 403（Free=2 台），但全仓没有任何用例
  打过这条边界（`grep` 只有 `tests/admin/plans.test.js` 提到 maxDevices）。⇒ 墙"活着但没被证明会咬人"。
- **C. metrics 的 503 fail-closed 分支在测试环境结构上不可达**：`index.js:354-363` 的
  `METRICS_TOKEN` IIFE 在非生产回落到写死的兜底字面量（值不抄这里）。那条 503 只在
  `NODE_ENV==='production' && !METRICS_TOKEN` 时可达。要真验它，得让 token 解析可注入（小重构，超本票范围）。
  另外**源码里存在硬编码凭据兜底值**本身是另一类问题（非 NODE_ENV 旁路），未处理。
- **D. `useRedis`/WS CSRF 的测试化**：需要设计测试环境 Redis 键空间与 WS 测试基建，独立开票。
- **E. §6-④ 的 400 收紧**：要不要退回"缺 contentPreview/contentSize 时按 DB 默认值收下"？
  我的判断：**建议退回**（它不是修 500，而是替客户端定义契约；且没有开关能回退）。
  若退回，需同步删 version.test.js 那 3 例断言（§7 表已列名）。等 owner 拍板，我没改。
- **F. §6-⑥ sync/push 绕开条数配额**：真实计费边界缺陷，Free 用户可通过 sync 无限写。未修（超出本票，
  且修法涉及产品口径：是"push 也查配额"还是"配额改为软限制"）。
- **G. `GET /api/subscriptions/plans` 匿名可读**：本轮把它钉成了显式断言（§7）。若产品口径是"套餐目录也不匿名"，
  该断言应改为 401 并给路由挂 auth —— 需要 owner 确认，我按"现状即设计"处理。
- **H. 前任超出票面的改动清单（供 owner 复核范围）**：`routes/versions.js` 的全部 4 项（§6-②③④）与
  `routes/clipboard.js` 的 tsquery 修复（§6-①）都**不是**"拆旁路"本身，而是拆完后撞出来的真缺陷。
  我逐条复核判定成立并保留（④ 除外，见 E）。**意图不可考的部分**：前任没解释为什么把 limiter 隔离手段
  选成"全局 beforeEach 清零"而不是"按文件名/按桶清理"—— 从 diff 只能看出它避免了
  `resetRateLimit('api')` 在每个文件里重复调用；我沿用未改（§4.1 已记代价）。
- **J. `src/utils/route-loader.js` 是一份"看起来像真相源"的死表**（本轮实测：全仓零引用）。
  它声明的挂载口径与 `index.js` 现状**冲突**，例如：
  `/api/subscriptions: [apiLimiter, authenticateToken, csrfProtection]`（现状：整个前缀不挂 auth，
  `/plans` 匿名可读，见 G）、`/api/clipboard: [… , checkClipboardLimit]`（现状：该 limiter 挂在
  `routes/clipboard.js:556` 的 POST 上）。⇒ 任何人（含下一个审计代理）读它都会得出与运行态相反的结论；
  若哪天被接上线，§7 里"`/plans` 匿名 200"那条断言会立刻红（这正是我们想要的信号）。
  建议：删表或加一行"本表未被使用，勿作依据"，属独立小票，本票未动它。
- **K. `adminLimiter` / `adminStrictLimiter` 仍无边界用例**：本轮给 `apiLimiter` 补了直接凭据（§2 表 6-8），
  另两个只是"不再是占位函数"，没有一条"打满阈值 → 429"的用例；`tests/admin/*` 全部走
  `vi.mock(auth.js)` 且按 IP 分桶，容易互相污染计数。补法与 apiLimiter 那条同形（单测级，不碰真库）。
- **L. `POST /api/clipboard` 的 500ms P95 SLO 需要 owner 拍板**（§6-⑦）：真实链路现在每请求多 4 次 DB 往返，
  全量并发跑时实测 592ms 翻红。两条出路：① 显式改 SLO 数字并在用例注释里写原因与机器基线（= 改契约，需批准）；
  ② 把 `getPlanByName` / `checkClipboardLimit` 的计数做进程内短 TTL 缓存（像 `getRuntimeLimits` 那样），
  保住 500ms。**我两者都没做**，因为①是产品决定、②是性能工单，都不属于"拆旁路"。
  现状：全量跑此用例**有概率红**（本轮 5 次全量里 1 次），单跑稳定绿。
- **M. 性能用例不看状态码**（§6-⑦）：`measurePerf` 只计时不校验 `res.status`，所以任何被闸门 401/403/429
  拒掉的请求也会被当成"性能样本"。这条在拆旁路之前是无害的（闸门全是 no-op），现在不是了。
  补法：在 `measurePerf` 里对 `res.status >= 400` 计数并断言为 0 —— 会牵动 6 条用例的通过口径，
  留作独立小票（本票不动，避免把性能基线一起改了）。
- **N. 三条整文件 skip 仍未处理**（`e2e.test.js` 19 / `error-recovery.test.js` 10 / `stress.test.js` 7），
  与本票无关，但它们是"拆旁路后没人回头看"的最大一块盲区：e2e 里那些用例从没在任何环境下跑过。
- **O. 本票未跑的东西**：desktop/admin-console/mobile 侧测试与 lint **一律没跑**（C3 在跑 desktop，
  避免互造假失败）；`src/server/src/utils/audit.js`、`tests/ai-orchestration.test.js`、
  `clipboard.js` 里 `AUDIT_ACTIONS.CLIPBOARD_CREATE/DELETE` 两行、`routes/admin/configs.js`、
  `utils/sms.js`、`src/desktop/**`、`.github/**` 全部**未触碰**（`git diff` 里它们仍只属于 owner/兄弟代理）。
  没有新增依赖，`package.json` 未改。

---

## 10. 交接 provenance

- §0–§1（锚点复核、环境基线、"不属于安全旁路"的判定）= **前任代理**（在被中断前写完，接手代理抽查后确认成立，
  并更正了两处措辞：`planFeature` 的归因、`adminAuth.js` 注释已由前任改好）。
- §2 表格的"改动内容/替代手段"= 接手代理从 `git diff` 反推；前任未留任何文字记录，
  动机只在可反推处写，其余标「意图不可考」（§9-H）。
- §2.1 / §3 / §4 / §4.4 / §6-⑤⑥⑦ / §7 标（我）的行 / §8 第三行 / §9-A…N = **接手代理**本轮产出。
- 本文件不含任何凭据值（只出现变量名）；写完后用 `.env.test` 的值做过字面量反扫，命中 0 处。
