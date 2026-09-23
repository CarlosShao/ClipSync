# 后端认证/会话/权限 审计

- 审计日期：2026-09-22
- 审计范围：`src/server/src` 的认证 / 会话 / 权限 / 防护全链路（routes/auth*、sessions、two-factor、device、admin/*、middleware/*、utils/sms|email|encryption|totp|refreshToken|audit、config*、ws/server.js）
- 审计方式：只读（Read/Grep/git）。未运行测试、未启动服务、未执行 docker。
- 排除项：已按 `docs/audit/external-dependency-audit-2026-09-09.md` 与 `docs/production-roadmap/external-dependencies.md` 排除「短信服务商 / SMTP / CAPTCHA / OAuth / HTTPS 证书」等**外部账号未申请**类事项。凡「代码侧本可做却没做的防护」仍计入（例：短信是 mock 不计；发码/重置接口没有限流、把验证码回给客户端，计）。

## 结论（≤3 句）

**不能上 v1。** 认证链路存在 4 个 S0：2FA 挑战令牌本身就是一张全功能 access token（2FA 形同虚设且可被永久改绑）、`/forgot-password` 在未配 SMTP 时把密码重置码直接回给未认证调用方、`/reset-password` 零限流 + `Math.random()` 6 位码可爆破改密、以及登录时无条件执行的「按昵称/邮箱合并账号」把他人剪贴板整体搬进攻击者账号。另有 2 个 S1：用户自助「踢出设备」因写了一个不存在的列而 100% 返回 500（会话从未被吊销），以及限流 key 只读 `req.body.phone` 导致邮箱登录/发码/找回密码共用一个全局 5 次桶（5 个匿名请求即可锁死全站邮箱登录）。S0/S1 修完之前，账号体系不具备对抗性；`tests/security.test.js` 的 CSRF / 认证绕过 / 越权三节全是 `describe.skip`，CI 对上述问题零覆盖。

---

## 问题清单（按严重度从高到低）

> 编号索引（正文交叉引用用）：
>
> | ID | 标题 |
> |---|---|
> | S0-1 | 2FA 挑战令牌就是一张全功能 access token |
> | S0-2 | `/forgot-password` 把密码重置码返回给未认证调用方 |
> | S0-3 | `/reset-password` 零限流 + `Math.random()` 6 位码可爆破改密 |
> | S0-4 | 登录时按昵称/邮箱「合并账号」搬走他人全部剪贴板 |
> | S1-1 | `DELETE /api/sessions[/:id]` 恒 500（写了不存在的 `updated_at` 列），会话从未吊销 |
> | S1-2 | 限流 key 只读 `req.body.phone`，邮箱登录/发码/找回密码共用全局 5 次桶 |
> | S2-1 | `X-Forwarded-For` 原样信任，所有 IP 限流可绕过 |
> | S2-2 | `clearLoginFailed` 在 Redis 模式下删错 key（双重前缀） |
> | S2-3 | `authenticateToken` 活性校验 DB 出错时 fail-open |
> | S2-4 | 登录验证码可重放（SELECT 不带 `used = FALSE`） |
> | S2-5 | `/2fa/verify-login` 无限流、挑战令牌可重复消费、TOTP 无重放保护 |
> | S2-6 | `PUT /api/auth/profile` 可无验证占用他人邮箱、无唯一性校验 |
> | S2-7 | `users.is_admin` 角色变更后从不同步，降权管理员永久保留无限额度 |
> | S2-8 | 扫码配对绕过设备配额与全部账号状态校验 |
> | S2-9 | `GET /api/admin/overview` 无权限点，任何 admin 都能看全站营收 |
> | S2-10 | WS 握手不校验会话/账号活性，JWT 走 URL query string |
> | S2-11 | WS 的 Origin 白名单在 `CORS_ORIGINS` 为字符串时退化成子串匹配 |
> | S2-12 | JWT 与 `audit_logs.details` 里放明文手机号/邮箱 |
> | S2-13 | 无并发会话上限、无会话 TTL、无清理任务，会话列表不可用 |
> | S2-14 | 认证错误泄漏 `detail`，`/login` 三种失败可区分（账号枚举） |
> | S2-15 | `tests/security.test.js` 的 CSRF/认证绕过/越权三节全 `.skip` |
> | S3-1 | 三个 auth 路由文件（约 860 行）被完全遮蔽，含两处无鉴权死端点 |
> | S3-2 | `POST /api/auth/reset-pin` 无限流且无实际作用 |
> | S3-3 | `POST /api/auth/2fa/setup` 静默关闭已启用的 2FA |
> | S3-4 | 所有验证码用 `Math.random()`，实现复制 4 份 |
> | S3-5 | `HASH_SALT` 有仓库内明文兜底；`ENCRYPTION_IV`/`hashField` 是死代码 |
> | S3-6 | `csrfProtection` 在任何环境下都不可能生效 |
> | S3-7 | 若干挂载点缺限流；限流总开关可关掉管理台高危节流；审计路径前缀写错 |
> | S3-8 | 腾讯云短信分支结构性不可用；`/pairing/redeem` 一次性消费非原子 |

### [S0-1] 2FA 挑战令牌就是一张全功能 access token —— 两步验证可被完全绕过并永久改绑

- **证据**：

  `src/server/src/routes/auth.js:437-443`（`/verify-code`，`/login` 在 `:1223-1230` 与 `:1248-1255` 同样写法）：

  ```js
  if (user.two_factor_enabled) {
    const challengeToken = jwt.sign(
      { userId: user.id, twoFactorChallenge: true },
      config.jwt.secret,
      { expiresIn: '5m' }
    );
    return res.json({ twoFactorRequired: true, challengeToken });
  ```

  `src/server/src/middleware/auth.js:30-47`——`authenticateToken` 只验签名，从不看 `twoFactorChallenge`：

  ```js
  const decoded = jwt.verify(token, config.jwt.secret);
  if (decoded.jti) {
    const blacklisted = await isJtiBlacklisted(decoded.jti);
  ```

  `src/server/src/middleware/auth.js:69`——会话活性检查被 `decoded.jti` 短路，而挑战令牌**没有 jti**：

  ```js
  if (decoded.jti && row.session_active === false) {
  ```

- **失败场景**：攻击者拿到受害者密码（撞库/泄露/钓鱼）但没有 TOTP。
  1. `POST /api/auth/login {account, password}` → 响应 `{twoFactorRequired:true, challengeToken}`。
  2. 用 `Authorization: Bearer <challengeToken>` 直接打任意受保护端点，全部通过：
     - `GET /api/auth/export-data`（`auth.js:1463`）→ 拿到全部剪贴板 + 设备 + 版本历史；
     - `GET /api/clipboard`、`GET /api/media/:id/download` → 逐条读数据；
     - WebSocket 握手同样接受（`ws/server.js:147` 只 `jwt.verify`，`:216` 的黑名单检查是 `if (redis && decoded.jti)`，无 jti → 整段跳过）；
     - `POST /api/auth/2fa/setup`（`two-factor.js:59-62`）→ `UPDATE users SET two_factor_pending_secret=<攻击者的>, two_factor_enabled = FALSE`；再 `POST /api/auth/2fa/enable`（`:92-100`）→ 2FA 被**永久改绑到攻击者的身份验证器**，受害者从此被锁在自己账号外；
     - `POST /api/devices/pairing/init` + `POST /api/devices/pairing/redeem`（`device.js:32`/`:56`，redeem 无 2FA 校验）→ 把 5 分钟的挑战升级成**一张带真实会话行、24 小时有效的正式 token**。
- **影响**：安全（最高）。2FA 提供的保护为 0；可数据外泄、可永久夺取账号、可让合法所有者无法登录。开启 `force_2fa_for_admin` 的管理员同样被绕过——该策略只拦「登录签发正式会话」，拦不住挑战令牌本身。
- **修法**：挑战令牌必须被 `authenticateToken` 显式拒绝（`if (decoded.twoFactorChallenge) return 401`），并改用独立 `typ`/独立密钥签发，同时要求正式 access token 必须携带 `jti`。

---

### [S0-2] `/forgot-password` 在 SMTP 未配置时把密码重置码直接返回给未认证调用方

- **证据**：

  `src/server/src/routes/auth.js:788-797`（注释声称「仅在非生产环境返回」，但代码没有任何环境判断）：

  ```js
  const emailResult = await sendVerificationCodeEmail(cleanEmail, resetCode, 'reset');
  if (emailResult.fallback) {
    logger.info(`[MVP] SMTP未配置，密码重置码: ${resetCode}`);
    return res.json({
      message: 'Reset code generated (SMTP not configured)',
      code: resetCode,       // 仅在非生产环境返回
      expiresIn: 600
  ```

  `src/server/src/utils/email.js:246-258`——无可用通道即走 console 兜底并**报告成功**：

  ```js
  const usable = candidates.filter(isChannelComplete);
  if (usable.length === 0) {
    ...
    return { success: true, fallback: true };
  ```

- **失败场景**：任意未登录的人执行
  `curl -X POST /api/auth/forgot-password -d '{"email":"victim@corp.com"}'`
  → `200 {"message":"Reset code generated (SMTP not configured)","code":"483920","expiresIn":600}`
  → `curl -X POST /api/auth/reset-password -d '{"email":"victim@corp.com","code":"483920","newPassword":"Attacker123"}'`
  → 受害者密码被改掉，攻击者用新密码登录。
  这不是理论路径：`docs/audit/external-dependency-audit-2026-09-09.md` A3 明确记录 SMTP「代码就绪，**管理台未填**」，即**当前生产状态就会命中 `fallback:true` 分支**。同批 A4 修复已经给短信做了正确的 fail-closed（`auth.js:177-188` 未配置短信直接 503），邮箱这一侧被漏掉了。
- **影响**：安全 + 数据。任何有邮箱的账号都可被未认证接管；遍历常见邮箱即可批量收割账号。
- **修法**：绝不把 code 写进响应体；生产环境无可用邮件通道时对齐短信口径返回 503，仅 `NODE_ENV !== 'production'` 才回显。

---

### [S0-3] `/reset-password` 完全没有限流，重置码是 `Math.random()` 6 位且可重复使用 —— 可爆破改任意账号密码

- **证据**：

  `src/server/src/routes/auth.js:813`——同文件的 `/forgot-password`（`:748`）挂了 `sendCodeLimiter`，`/reset-password` 一个限流器都没有：

  ```js
  router.post('/reset-password', async (req, res) => {
  ```

  `src/server/src/routes/auth.js:776`——重置码用非密码学随机源，空间 9×10^5：

  ```js
  const resetCode = String(Math.floor(100000 + Math.random() * 900000));
  ```

  `src/server/src/routes/auth.js:846-851`——校验 SELECT **不带 `used = FALSE`**，所以 `:858-861` 的 `SET used = TRUE` 是空转，同一个码在 10 分钟内可反复改密：

  ```js
  const result = await pool.query(
    `SELECT id FROM verification_codes
     WHERE phone = $1 AND code = $2 AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
  ```

  `src/server/src/index.js:393-399`——整个 `/api/auth` 挂载点没有 `apiLimiter`（对比 `:407` 的 `/api/devices`、`:411` 的 `/api/clipboard` 都有）：

  ```js
  app.use('/api/auth', authRoutes);
  app.use('/api/auth', authVerifyRoutes);
  ```

- **失败场景**：攻击者对受害者邮箱触发一次 `/forgot-password`（该接口有 `sendCodeLimiter`，但 key 落在 `sendCode:unknown`，见 S1-2，实际拦不住），然后在 10 分钟有效期内以服务器能承受的最大速率轮询 `POST /api/auth/reset-password`，遍历 6 位数字。没有任何计数器、没有失败锁定、没有 IP 桶。命中即 `UPDATE users SET password_hash = ...`（`:886-889`），受害者账号被接管。即使不爆破，只要攻击者拿到过**任意一个**已使用过的重置码，10 分钟内也能再改一次密码。
- **影响**：安全。未认证的账号接管，且可无限重复。这是把 S2-1（XFF 伪造）变成实战武器的主目标。
- **修法**：给 `/reset-password` 挂「按标识符 + 按 IP」双桶限流（如 5 次/15 分钟、超限作废该码），所有验证码 SELECT 统一加 `AND used = FALSE`，码源换 `crypto.randomInt`。

---

### [S0-4] 登录时无条件执行的「身份合并」按用户自选昵称/未验证邮箱搬走他人全部剪贴板

- **证据**：

  `src/server/src/routes/auth.js:98-109`——合并键之一是 **nickname ILIKE**，昵称既不唯一也不需验证：

  ```js
  if (canonicalNickname && canonicalNickname !== '') {
    const dupByNick = await pool.query(
      `SELECT id, phone, email, nickname FROM users WHERE nickname ILIKE $1 AND id != $2 AND merged_into IS NULL`,
      [canonicalNickname, canonicalUserId]
  ```

  `src/server/src/routes/auth.js:116-119` 与 `:143-146`——命中即把对方的剪贴板整体改归属，并把对方账号「阉割」：

  ```js
  const moveResult = await pool.query(
    `UPDATE clipboard_items SET user_id = $1 WHERE user_id = $2`,
    [canonicalUserId, dup.id]
  );
  ...
  `UPDATE users SET merged_into = $1, phone = CASE WHEN phone IS NOT NULL THEN phone || '_merged' ELSE NULL END, email = NULL, nickname = nickname || '_merged' WHERE id = $2`,
  ```

  调用点在**每一次登录**上无条件执行：`auth.js:425`（`/verify-code`）、`:659`（`/verify-email-code`）、`:1233`（`/login`）。
  昵称/邮箱可被攻击者自由设置：`auth.js:1355-1360`（`PUT /profile`）只校验邮箱**格式**，无唯一性、无所有权验证：

  ```js
  if (email !== undefined && email !== null && email !== '') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
  ```

  而 `/register`（`:941-958`）查重只查 phone 和 email，**不查 nickname**。

- **失败场景**：
  - 路径 A（昵称）：攻击者注册账号并把昵称改成受害者的昵称「Alice」（注册时传，或 `PUT /api/auth/profile {nickname:"Alice"}`）。攻击者下一次登录 → `dupByNick` 命中真正的 Alice → Alice 的 `clipboard_items` 全部 `user_id` 改成攻击者 → Alice 的 `email` 被置 NULL、`phone` 被加后缀 `_merged`、`registration` 状态被打上 `merged_into`。攻击者随后 `GET /api/clipboard` 读走全部数据；Alice 再登录时账号已被拆空，且邮箱登录路径彻底失效（email 变 NULL）。
  - 路径 B（邮箱）：攻击者 `PUT /api/auth/profile {"email":"alice@corp.com"}`（无需任何验证）→ 下次登录 `dupByEmail`（`:90-94`）命中 → 同样后果。
  - 全过程只有一条 `logger.info`（`:148`），**不写 `logAuditEvent`**，管理台审计页查不到；没有事务包裹，中途失败会留下半合并状态（数据搬了、账号没标记，或反之）。
- **影响**：数据 + 安全（最高）。跨租户数据窃取 + 受害者账号被破坏，任何普通用户零成本触发，无需管理员参与，无审计痕迹。这是本次审计中最容易在生产上被真实利用的一条。
- **修法**：立即把 nickname 从合并键中删除；邮箱必须先经验证码确认才可作为合并键；整个合并动作改为需用户显式确认或管理员操作，并加事务 + `logAuditEvent`。

---

### [S1-1] 用户自助「踢出设备 / 退出所有设备」100% 返回 500 —— SQL 写了不存在的 `updated_at` 列，会话从未被吊销

- **证据**：

  `src/server/src/routes/sessions.js:77-81`（`DELETE /api/sessions/:sessionId`）：

  ```js
  await pool.query(`
    UPDATE user_sessions
    SET is_active = false, updated_at = NOW(), revoked_at = NOW()
    WHERE id = $1 AND user_id = $2
  `, [sessionId, userId]);
  ```

  `src/server/src/routes/sessions.js:109-116`（`DELETE /api/sessions`，退出全部）同样是 `SET is_active = false, updated_at = NOW(), revoked_at = NOW()`。

  但 `user_sessions` **没有 `updated_at` 列**——`src/server/src/db/migrations/012_schema_completion.sql:27-38`：

  ```sql
  CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name VARCHAR(100) DEFAULT 'Unknown Device',
    ...
    created_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
  );
  ```

  `src/server/src/db/migrate.js:88-100` 的建表 DDL 同样只有 `created_at` / `revoked_at`；全量迁移里 `grep "ADD COLUMN.*updated_at"` 只命中 `012_schema_completion.sql:22` 的 `users.consent_updated_at`，没有任何迁移给 `user_sessions` 补列。

- **失败场景**：用户怀疑自己的账号在别的设备上被别人登着，打开 设置 → 会话管理 → 点「踢出」。桌面端 `SessionsSubPage.vue:100` / `SessionsModal.vue:54` 发 `DELETE /api/sessions/${sessionId}`，移动端 `api_service.dart:472` / `sessions_api_service.dart:58` 同一端点 → PostgreSQL 抛 42703 `column "updated_at" of relation "user_sessions" does not exist` → 被 `sessions.js:93-96` 的 catch 吞掉 → 客户端收到 `500 {"error":"Failed to revoke session"}`。
  后果不止报错：会话行仍是 `is_active = TRUE`，`:85` 的 `blacklistJti(sessionId, ttl)` 在失败语句**之后**，永远执行不到，所以那张 JWT 依旧全程有效，被踢的设备继续同步。`DELETE /api/sessions`（退出全部，`sessions.js:109`）同理，移动端 `api_service.dart:483` 在用。
  同一 bug 还在 `src/server/src/routes/aiTools.js:4459`（AI 工具 `terminate_session`），它也在 `blacklistJti` 之前抛错，所以 AI 助手报告「强制下线失败」且会话依然在线。
  **对照组**：管理端的所有吊销路径都写对了——`routes/admin/sessions.js:173`、`admin/users.js:529` 与 `:724`、`admin/ops.js:549` 全是 `SET is_active = FALSE, revoked_at = NOW()`，管理员踢人正常工作。坏的只有**用户自己踢自己**这一条。
- **影响**：安全 + 可用性。用户面对账号被盗时唯一能自助采取的处置手段是死的，且无任何自愈路径（不会随时间恢复）。同时 `user_sessions` 会残留大量本该失效的活跃会话（见 S2-13）。
- **修法**：删掉这两条（以及 `aiTools.js:4459`）里的 `updated_at = NOW()`，或补一个迁移加列；改完手工验一次「踢出后旧 token 立刻 401」。

---

### [S1-2] 限流 key 只读 `req.body.phone` —— 邮箱登录 / 邮箱发码 / 找回密码共用一个全局 5 次桶，5 个匿名请求即可锁死全站

- **证据**：

  `src/server/src/middleware/rateLimiter.js:280-283`：

  ```js
  keyGenerator: (req) => {
    const phone = req.body?.phone;
    return phone ? `loginFailed:${phone}` : 'loginFailed:unknown';
  },
  ```

  `src/server/src/middleware/rateLimiter.js:264-267`（`sendCodeLimiter`）同构：

  ```js
  keyGenerator: (req) => {
    const phone = req.body?.phone;
    return phone ? `sendCode:${phone}` : 'sendCode:unknown';
  },
  ```

  但这些端点的 body 里**没有 `phone`**：`routes/auth.js:498` `/verify-email-code`（`{email, code}`）、`:210` `/send-email-code`（`{email}`）、`:748` `/forgot-password`（`{email}`）、`:1130` `/login`（`{account|email, password}`）。
  桌面端确认了这个 body 形态——`src/desktop/src/components/auth/AuthPage.vue:252-256`：

  ```js
  let loginBody: any = { password: authPassword.value }
  if (/^1[3-9]\d{9}$/.test(acct)) loginBody.phone = acct
  else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acct)) loginBody.email = acct
  else loginBody.account = acct
  ```

  并且 `createRateLimiter` 统计的是**每一次请求**，不是失败次数——`skipSuccessfulRequests` 在 `rateLimiter.js:183` 声明后，整个实现（`:191-231`）从未读取它。

- **失败场景**：
  - 正常业务：全站所有邮箱密码登录、所有邮箱验证码登录、所有邮箱发码、所有找回密码请求，分别落进 `loginFailed:unknown`（5 次/15 分钟）和 `sendCode:unknown`（5 次/小时）两个**全局共享**桶。第 6 个用邮箱登录的用户收到 `429 Too many login attempts, please try again in 15 minutes`；第 6 个想找回密码的用户收到 `429 ... try again in 1 hour`。v1 上线当天只要有 6 个人用邮箱登录就会复现。
  - 攻击：任何人不带凭据发 5 个 `POST /api/auth/login {"email":"x@y.z","password":"wrong"}`，即可让**全体用户**在 15 分钟内无法用邮箱/昵称登录；每 15 分钟重复一次即为持续拒绝服务。5 个 `POST /api/auth/forgot-password` 即可锁死全站密码找回 1 小时。成本为 0，且 `adminLimiter`/`apiLimiter` 都拦不住（`/api/auth` 挂载点没有 `apiLimiter`，见 S0-3 证据）。
- **影响**：可用性 + 安全。主登录路径之一被免费 DoS，且会自然踩中。
- **修法**：key 改成「实际存在的标识符」——`(req.body.phone || req.body.email || req.body.account)`，并叠加一个按 IP 的桶；同时真正实现 `skipSuccessfulRequests`，只统计失败。

---

### [S2-1] `X-Forwarded-For` 原样信任 —— 所有按 IP 的限流都能靠换一个请求头绕过

- **证据**：`src/server/src/middleware/rateLimiter.js:248`（`apiLimiter`）、`:376`（`adminLimiter`）、`:394`（`adminStrictLimiter`）三处同一写法：

  ```js
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.ip ||
         req.connection?.remoteAddress;
  ```

  全仓 `grep "trust proxy"` **0 命中**（Express 从未被告知信任代理，`req.ip` 本就是直连对端）。而 `nginx/conf.d/clipsync.conf:32` 与 `:52`：

  ```nginx
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  ```

  `$proxy_add_x_forwarded_for` = `$http_x_forwarded_for, $remote_addr`，即**客户端自带的值被保留在第 0 位**，`split(',')[0]` 取到的正是攻击者可控的那一段。

- **失败场景**：`for i in $(seq 1 100000); do curl -H "X-Forwarded-For: 10.0.0.$i" -X POST .../api/auth/reset-password -d '{"email":"victim@x.com","code":"'$RANDOM'","newPassword":"Passw0rd!1"}'; done` —— 每次请求落在不同的限流桶里，`apiLimiter`（300/分钟）、`adminLimiter`（100/分钟）、`adminStrictLimiter`（退款/强制下线/删除账号 10/分钟）全部失效。管理台的资金类端点（`admin/index.js:61-70` 列的 refund / approve / force-logout / user-delete）因此失去唯一的高危节流。这条本身不直接造成损失，但它是 S0-3 爆破和 S1-2 锁定攻击从单机可行的前提。
- **影响**：安全。移除了对登录爆破与管理台资金操作的唯一速率防线。
- **修法**：`app.set('trust proxy', 1)` 后统一用 `req.ip`，绝不直接读原始 header。

---

### [S2-2] `clearLoginFailed` 在 Redis 模式下删错 key（双重前缀），成功登录从不清计数 —— 生产独有，dev/test 测不出

- **证据**：写入侧 `src/server/src/middleware/rateLimiter.js:70`：

  ```js
  const redisKey = `ratelimit:${storeName}:${key}`;
  ```

  其中 `key` 由 `:282` 的 keyGenerator 产出，**已经带 `loginFailed:` 前缀**，故实际 Redis key 是 `ratelimit:loginFailed:loginFailed:<phone>`。
  清除侧 `src/server/src/middleware/rateLimiter.js:293`：

  ```js
  const redisKey = `ratelimit:loginFailed:${phone}`;
  client.del(redisKey).catch(() => {});
  ```

  少了一层前缀，删的是不存在的 key。内存分支（`:298` `memoryStores.loginFailed.delete(key)`）用的是完整 key，**是对的**。`useRedis` 只在 `NODE_ENV === 'production' && REDIS_HOST` 时为真（`:188`）。
  同族 bug：`getRateLimitStatus`（`:423`）和 `resetRateLimit`（`:454`）拼的都是 `ratelimit:${key}`，漏了 `storeName`。

- **失败场景**：这正是 `rateLimiter.js:94-101` 注释里记录过的同一类事故（「之所以长期未暴露：dev/test 环境走内存降级分支，该分支实现正确；只有生产才触发」）。生产上：用户手滑输错密码 5 次，第 6 次起 15 分钟内被锁；期间即使他改用验证码成功登录（`auth.js:308` / `:1239` 调 `clearLoginFailed`），计数**不会被清掉**，密码登录继续 429 直到窗口自然过期。更糟的是攻击者可以用 5 次失败把某个手机号的密码登录锁满 15 分钟，且受害者无法通过成功登录自救——这是一个稳定的账号级锁定 DoS。
- **影响**：安全 + 可用性。账号锁定型拒绝服务；只在生产出现，本地与 CI 全绿。
- **修法**：把 `clearLoginFailed` / `getRateLimitStatus` / `resetRateLimit` 的 key 拼接统一走同一个 `buildKey(storeName, key)` 函数。

---

### [S2-3] `authenticateToken` 的活性校验在 DB 出错时 fail-open，与 Redis 降级叠加后两层吊销同时失效

- **证据**：`src/server/src/middleware/auth.js:76-79`：

  ```js
  } catch (err) {
    // DB 查询失败：记录告警，但放行（避免误杀正常请求）
    console.warn('[auth] user/session active check failed:', err.message);
  }
  ```

  catch 包住的是 `:52-60` 的「用户活性 + 会话活性 + RBAC」查询，之后直接落到 `:88` 的 `next()`。
  另一层 `src/server/src/utils/redis-client.js:274` 与 `:279`：

  ```js
  if (!client) return false; // Redis 不可用 → 降级为“未吊销”，由 DB session 活性兜底
  ...
  return false; // Redis 抖动时降级，避免全站 403（H2 修复）
  ```

- **失败场景**：连接池打满（`config/production.js:18` `poolMax: 20`，且 `middleware/auth.js:52` 让**每个**认证请求都多打一次 DB）或 PG 短暂抖动时，被管理员停用的账号（`is_active=false`）和被吊销的会话照常拿到全量 API 权限——注释里承诺的「DB 层兜底」正是此时一起失效的那一层。同时 `req.user.roleKey/roleLevel/isAdmin` 走 `:82-86` 的兜底，管理员被降级成 `user`（管理台一片 403），而**被停用的普通用户反而畅通**——故障时的行为与期望完全相反。
- **影响**：安全。会话吊销与账号停用是「尽力而为」而非「保证」，且失效方向偏向放行。
- **修法**：活性查询失败时 fail-closed（503 + 客户端退避重试）；至少对携带 `jti` 的 token，在无法验证时拒绝。

---

### [S2-4] 登录验证码可重放 —— 真正生效的 SELECT 不带 `used = FALSE`（修好的那份代码在被遮蔽的死文件里）

- **证据**：`src/server/src/routes/auth.js:280-285`（`/verify-code`）：

  ```js
  const result = await pool.query(
    `SELECT id FROM verification_codes
     WHERE phone = $1 AND code = $2 AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
  ```

  随后 `:302-305` 才 `SET used = TRUE`，但 SELECT 不看这个字段 → 标记毫无作用。`/verify-email-code`（`:522-527`）同样。
  对比同文件 `/register`（`:961-966`）和 `/set-password`（`:1063-1068`）都写了 `AND used = FALSE`——说明作者知道该加，只在登录路径漏了。
  而被遮蔽的 `routes/auth-verify.js:178` 做得更彻底（直接 `DELETE FROM verification_codes WHERE phone = $1`），但 `index.js:393` 的 `authRoutes` 先于 `:394` 的 `authVerifyRoutes` 注册，Express 在第一个应答的路由处停止 → **这份修复从不执行**。

- **失败场景**：一个验证码在 10 分钟有效期内（`auth.js:175`）可被重复提交任意次，每次都新建一条 `user_sessions` 行并签发一对新的 access/refresh token。攻击者只要截获过一次码（短信转发、日志泄露、共享设备），就能持续铸会话；受害者要靠会话列表逐个踢——而踢出功能是坏的（S1-1）。`db/migrate.js:159` 还专门为 `used = FALSE` 建了部分索引，登录路径根本没用到它。
- **影响**：安全。「一次性验证码」不是一次性的；每次重放都留下一个无法撤销的活跃会话。
- **修法**：两处 SELECT 加 `AND used = FALSE`（或直接照 `auth-verify.js:178` 删行）。

---

### [S2-5] `/2fa/verify-login` 无限流、挑战令牌可重复消费、TOTP 无重放保护

- **证据**：`src/server/src/routes/two-factor.js:145`——同目录其他路由都挂了限流器，这条没有：

  ```js
  router.post('/2fa/verify-login', async (req, res) => {
  ```

  `:152-160` 只 `jwt.verify` 挑战令牌，**从不作废它**，所以它在整个 `CHALLENGE_TTL = '5m'`（`:23`）内可被无限次重试。
  `src/server/src/utils/totp.js:50-58`——±1 步窗口（合计 90 秒）内同一码始终有效，且没有任何「已消费计数器」记录：

  ```js
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const counter = Math.floor((forTime + errorWindow * timeStep * 1000) / 1000 / timeStep);
    if (tokenForCounter(secret, counter, digits) === cleaned) return true;
  ```

  备份码是 8 位 hex（32 bit）× 10 个，bcrypt cost 10（`two-factor.js:87-90`），同样在这条无限流端点上被校验。

- **失败场景**：攻击者用受害者密码打一次 `/login` 拿到挑战令牌，然后在 5 分钟内以最大速率轮询 `/2fa/verify-login` 猜 6 位动态码（10^6 空间，无任何计数）；猜中即 `createSessionAndGenerateToken`（`:180`）签发正式会话。即使不猜 TOTP，也可以转向 10 个备份码。另外 `:56` 的字符串 `===` 比较不是常量时间的。
- **影响**：安全。把 2FA 降级成一次可爆破的 6 位猜测（与 S0-1 独立成立）。
- **修法**：按 `userId` 限流（每张挑战令牌最多 5 次尝试），首次失败即作废挑战令牌，并记录已消费的 TOTP counter 防重放。

---

### [S2-6] `PUT /api/auth/profile` 允许任意用户无验证占用他人邮箱，且无唯一性校验

- **证据**：`src/server/src/routes/auth.js:1355-1371`——只校验格式，随后直接 UPDATE：

  ```js
  const result = await pool.query(
    `UPDATE users SET
      nickname = COALESCE($1, nickname),
      email = COALESCE($2, email),
  ```

  对比 `/register`（`:949-958`）是查重的（`WHERE email = $1 OR email_hash = $2`）；改邮箱这条路径既不查重也不发确认码，而且**不更新 `email_encrypted` / `email_hash`**——于是 `users.email` 是新值、`email_hash` 还是旧值，两个查询路径给出不同答案。
  下游消费方：`/login`（`:1203-1206`）`WHERE ${identifierField} = $1` 无 `LIMIT` 无排序，取 `result.rows[0]`；`/forgot-password`（`:764-767`）、`/reset-password`（`:867-870`）都按邮箱定位用户。

- **失败场景**：攻击者把自己账号的 email 改成 `alice@corp.com`。库里出现两行同邮箱。此后：(1) Alice 用邮箱登录时 `rows[0]` 是哪一行取决于物理顺序，可能登进攻击者账号；(2) Alice 走 `/forgot-password` → 重置码可能被写进/匹配到攻击者那一行，攻击者据此改掉 Alice 的密码；(3) 该状态同时是 S0-4 路径 B 的触发条件（下次登录即合并 Alice 的数据）。
- **影响**：安全 + 数据。账号混淆、密码重置被劫持、跨账号数据搬迁的前置步骤。
- **修法**：邮箱变更必须经验证码确认后才落库，`users.email` / `email_hash` 加 UNIQUE 约束，并在同一条 UPDATE 里同步 `email_encrypted` 与 `email_hash`。

---

### [S2-7] `users.is_admin` 在角色变更后从不同步 —— 被降权的管理员永久保留「无限量套餐」

- **证据**：`src/server/src/routes/admin/users.js:664-667`：

  ```js
  await pool.query(`UPDATE users SET role_id = $2, updated_at = NOW() WHERE id = $1`, [
    user.id,
    role.id,
  ]);
  ```

  `is_admin` 未被触碰。而该不变量只在 `src/server/src/db/migrations/028_roles.sql:76-79` 被一次性建立：

  ```sql
  UPDATE users SET is_admin = TRUE
  WHERE role_id IN (SELECT id FROM roles WHERE role_key IN ('super_admin', 'admin'));
  UPDATE users SET is_admin = FALSE
  WHERE role_id IN (SELECT id FROM roles WHERE role_key = 'user');
  ```

  仍在读这个陈旧布尔值的地方：`middleware/auth.js:75`、`middleware/subscriptionCheck.js:33` 与 `:37-49`、`routes/auth.js:1328`。`grep "is_admin = "` 全仓只有迁移文件命中，**没有任何运行时端点会写它**。

- **失败场景**：超管把用户 Y 从 `admin` 降回 `user`。`requireRole(50)` 读的是 `roles.level`，会正确拒绝管理台 API；但 `subscriptionCheck.js:37` 读的是 `is_admin` → `if (user.is_admin)` 命中 → Y 拿到 `{ maxDevices: 9999, maxClipboardItems: 99999, maxFileSizeMb: 500, maxStorageMb: 100000, isUnlimited: true }`，`checkDeviceLimit`（`:166`）与 `checkClipboardLimit`（`:203`）双双 `return next()`。Y 在 Free 套餐上永久享受无限量，而**没有任何端点能把 `is_admin` 清掉**（改角色不同步、删账号才行）。`GET /api/auth/me` 也继续返回 `isAdmin: true`。反向同理：把 X 提升为 `admin` 时 `is_admin` 仍是 FALSE，X 拿不到本应有的无限额度，表现为「升了管理员却还是被设备数拦住」。
- **影响**：钱 + 数据。配额体系被绕过且不可关闭；两套并行的授权事实源（`is_admin` 布尔 vs `roles` 表）长期发散。
- **修法**：删除 `is_admin` 列，权限与额度一律由 `roles` 派生；过渡期至少在改 `role_id` 的同一条语句里同步 `is_admin`。

---

### [S2-8] 扫码配对绕过设备配额与全部账号状态校验

- **证据**：`src/server/src/index.js:402` 与 `:407` 两个挂载点的中间件链不对等：

  ```js
  app.use('/api/devices', apiLimiter, pairingRouter);
  ...
  app.use('/api/devices', authenticateToken, apiLimiter, csrfProtection, subscriptionCheck, checkDeviceLimit, (req, res, next) => {
  ```

  配对路由没有 `subscriptionCheck`，也没有 `checkDeviceLimit`，而 `routes/device.js:119-123` 直接 INSERT 设备：

  ```js
  await pool.query(
    `INSERT INTO devices (user_id, device_name, device_type, platform, platform_version, app_version, public_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  ```

  `routes/device.js:84-92` 取用户时也不看状态——对比 `routes/auth.js:409-422` 登录路径会拦 `is_active === false` 与 `registration_status === 'waitlist'`，`:437` 还会拦 `two_factor_enabled`；`redeem` 三项全无。

- **失败场景**：
  1. **配额绕过**：Free 套餐上限 2 台设备（`subscriptionCheck.js:279` `maxDevices: 2`）。用户循环 `POST /api/devices/pairing/init`（带自己的 Bearer）→ `POST /api/devices/pairing/redeem`，每次都成功插入一台新设备，`checkDeviceLimit` 从未被调用 → 免费用户挂 100 台设备进同步组。付费转化点被直接掏空。
  2. **2FA 绕过**：`redeem` 会 `createSessionAndGenerateToken`（`:99`）签发正式会话，全程不查 `two_factor_enabled`。与 S0-1 串起来：挑战令牌 → `/pairing/init` → `/pairing/redeem` → 拿到一张 24 小时、带真实会话行的正式 token。
- **影响**：钱 + 安全。
- **修法**：配对挂载点补 `subscriptionCheck` + `checkDeviceLimit`；`redeem` 内重新校验 `is_active` / `registration_status` / `two_factor_enabled`。

---

### [S2-9] `GET /api/admin/overview` 只有 `requireRole(50)`、没有权限点 —— 任何 admin 角色都能看到全站营收/MRR/退款率

- **证据**：`src/server/src/routes/admin/overview.js:88`（本文件唯一一个路由，全仓只有它和 `roles.js:155` 的权限目录列表没挂 `requirePerm`）：

  ```js
  router.get('/', async (req, res) => {
  ```

  `src/server/src/routes/admin/index.js:116` 把这写成有意为之：

  ```
  //       看板聚合仅要求 requireRole(50) 门槛（权限目录中无 overview view 权限点）。
  ```

  返回内容见 `overview.js:91-130`：全站注册用户数、本周新增、**本月营收、上月营收、近 30 天退款率、MRR、年付占比、付费用户数、转化率**、近 14 天订单金额与退款、套餐分布、渠道占比。

- **失败场景**：超管给某位运营同学授予 `admin` 角色（level 50）并只分配 `admin.announce.send`（发公告）这一个权限点。该同学打开管理台首页即拿到完整损益表——因为权限目录里**根本不存在** `admin.overview.view` 这个键，所以没有任何办法「给他一点权限但不给他营收」。这是「能读不能写」的镜像漏洞：能读任何东西的人必然能读最敏感的那份聚合数据。`requireRole(50)` 只区分「是不是管理员」，不区分「是哪一类管理员」。
- **影响**：数据（商业机密）。RBAC 粒度在最敏感的读端点上失效，且无法通过配置补救。
- **修法**：在 `PERM_CATALOG` 增加 `admin.overview.view` 并挂到该路由；启动自检（`index.js:643-654`）会顺带把它纳入死键检查。

---

### [S2-10] WS 握手不校验会话/账号活性，且 JWT 走 URL query string

- **证据**：`src/server/src/ws/server.js:138`：

  ```js
  const token = url.searchParams.get('token') || req.headers['authorization']?.split(' ')[1];
  ```

  `:147` 仅 `jwt.verify(token, config.jwt.secret)`；`:216-222` 是唯一的吊销检查，且同样被 `jti` 短路：

  ```js
  if (redis && decoded.jti) {
    const blacklisted = await redis.get(`bl:${decoded.jti}`);
  ```

  握手全程**没有**任何 `user_sessions.is_active` / `users.is_active` 查询（对比 `middleware/auth.js:52-75` 每个 REST 请求都查）。

- **失败场景**：
  1. Redis 不可用（`redis` 为 null → 整段跳过），或 `bl:` 从未写入（S1-1 的吊销路径 500、`auth-session.js:57` 写错 key，见 S3-1）→ 已吊销会话 / 已停用账号照样建立 WS 连接，实时收到该用户的剪贴板同步推送。
  2. S0-1 的挑战令牌没有 `jti` → `if (redis && decoded.jti)` 为假 → 黑名单检查整段跳过 → 挑战令牌同样拿到完整 WS 通道。
  3. `?token=<JWT>` 让一张 24 小时有效的凭据进入 nginx `access_log`、任何中间代理日志、浏览器历史与 `Referer`。`nginx/conf.d/clipsync.conf` 的 `/ws/` location 未关闭 access_log（只有 `/api/health` 在 `:26` 关了）。
- **影响**：安全。实时通道的吊销不被执行；长期凭据经日志外泄。
- **修法**：握手时执行与 `authenticateToken` 相同的活性查询；token 只接受 `Authorization` 头或 `Sec-WebSocket-Protocol`，或改为一次性短时效 ticket；`/ws/` location 关闭 access_log。

---

### [S2-11] WS 的 Origin 白名单在 `CORS_ORIGINS` 为逗号字符串时退化成子串匹配

- **证据**：`src/server/src/ws/server.js:127-131`：

  ```js
  if (config.nodeEnv === 'production' && origin) {
    const allowedOrigins = config.cors?.origins || [];
    if (!allowedOrigins.includes(origin)) {
  ```

  `config/production.js:34` 给的是**字符串**：`origins: process.env.CORS_ORIGINS || ''`；只有当 env 变量真的被设置时，`config.js:67-69` 才会把它 split 成数组。HTTP 侧 `index.js:117-120` 明确处理了两种形态：

  ```js
  const rawOrigins = config.cors?.origins || '';
  const allowedOrigins = (Array.isArray(rawOrigins) ? rawOrigins : rawOrigins.split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  ```

  WS 侧没有这段。

- **失败场景**：生产漏配 `CORS_ORIGINS`（`docker-compose.prod.yml:110` 是 `CORS_ORIGINS: ${CORS_ORIGINS}`，`.env.production` 里空着就是空串）→ `'' || []` → `[]` → `[].includes(origin)` 恒 false → **所有带 Origin 的 WS 连接被 4003 拒绝**。Tauri webview 会发 `Origin: tauri://localhost`，于是桌面端实时同步全灭，而命令行/移动端（不发 Origin）照常工作——故障表现极难定位。反之若配成逗号字符串而 env 覆盖未生效，`'https://a.top,https://b.top'.includes(x)` 变成子串匹配，白名单里任何一段的子串都会通过。
- **影响**：可用性 + 安全。
- **修法**：抽出 `index.js:118-120` 的归一化逻辑为公共函数，HTTP 与 WS 共用。

---

### [S2-12] JWT 与 `audit_logs.details` 里放明文手机号/邮箱，抵消了字段级加密设计

- **证据**：`src/server/src/routes/auth.js:60-64`（`auth-refresh.js:57-61`、`auth-session.js:30-34`、`auth-password.js:30-34`、`auth-verify.js:34-38` 同）：

  ```js
  const token = jwt.sign(
    { userId: user.id, phone: user.phone, email: user.email, sessionId: sessionId, jti: sessionId },
    config.jwt.secret,
  ```

  `src/server/src/routes/auth.js:289-296` 与 `:551-559` 把明文 PII 写进审计：

  ```js
  await logAuditEvent({
    action: AUDIT_ACTIONS.LOGIN_FAILED,
    ...
    details: { phone: cleanPhone },
  ```

  `src/server/src/utils/audit.js:59` 直接 `JSON.stringify(details)` 落到明文 JSONB 列。
  而 `users` 表本身是加密存的——`auth.js:385-386`、`:975-978` 写 `phone_encrypted` / `phone_hash`，`routes/admin/audit.js:86-91` 还专门有 `maskPhone()` 在**读取侧**打码。

- **失败场景**：access token 是 Bearer 字符串，存在 `localStorage`（`AuthPage.vue:268`）、经 nginx 转发、可能进任何访问日志。任何拿到它的人 base64 解码 payload 即得受害者手机号与邮箱——`users.phone_encrypted` 的 AES-256-GCM 形同虚设。同理，一次 DB 泄露或一个只有 `admin.audit.view` 的管理员，可以从 `audit_logs.details` 拿到全站登录/登录失败记录的**明文手机号**，而管理台 UI 上却显示的是 `138****2765`（读侧打码给人「已经脱敏了」的错觉）。
- **影响**：数据 / 合规。个人信息保护层面的实质缺陷，与产品自身的加密承诺矛盾。
- **修法**：JWT 只放 `userId`/`sessionId`/`jti`（各路由本来就回查用户行，`auth.js:466-469` 已经在做解密回退）；审计 `details` 写入前用 `maskPhone` 同款函数打码。

---

### [S2-13] 没有并发会话上限、没有会话 TTL、没有清理任务 —— `user_sessions` 无限增长且会话列表不可用

- **证据**：全仓 `grep "MAX_SESSIONS|maxSessions|session_limit|COUNT(\*) FROM user_sessions"` **0 命中**。每次登录 INSERT 一行（`routes/auth.js:53-57`），且没有任何机制让它失效。`src/server/src/db/cleanup.js` 清的是 `clipboard_items`（`:28`）、`verification_codes`（`:39-43`）、`notification_history`（`:53`）、`clipboard_deletions`（`:67`）、`audit_logs`（`:206`）——**从不清 `user_sessions`**。
  列表接口 `routes/sessions.js:44-46` 又把可用信息抹掉了：

  ```js
  userAgent: '',
  createdAt: row.created_at,
  lastActiveAt: row.created_at,
  ```

  而 `user_agent` 列是存在的（`012_schema_completion.sql:34`），`lastActiveAt` 直接用创建时间冒充。

- **失败场景**：每天登录一次的用户，一年后 `GET /api/sessions`（`sessions.js:21-34`，`WHERE user_id = $1 AND is_active = true`）返回 365 行，每行 `deviceName` 都是 `'Unknown Device'`（客户端不传时 `auth.js:47` 的默认值）、`userAgent` 都是空串、时间都是登录时刻——**完全无法分辨哪条是哪台设备**。想一次性清掉就调 `DELETE /api/sessions`，它要逐条 `blacklistJti` 365 次（`:120-122`），而且反正会 500（S1-1）。表本身无上限增长，`idx_user_sessions_active` 部分索引随之膨胀。
- **影响**：可用性 + 安全。「会话管理」这个安全功能在数据层面就无法完成它的职责；无界表增长。
- **修法**：加每用户并发会话上限（超限淘汰最旧）+ 新增并维护 `last_active_at` 列 + 在 `cleanup.js` 里加会话过期清理 + 列表如实返回 `user_agent`。

---

### [S2-14] 认证错误响应泄漏内部细节，且 `/login` 三种失败可区分 —— 账号枚举

- **证据**：`src/server/src/middleware/auth.js:95`：

  ```js
  return res.status(401).json({ error: 'Invalid token', detail: err.message });
  ```

  对比 `src/server/src/index.js:586-588` 的全局错误处理是刻意 hiding 的：

  ```js
  error: config.nodeEnv === 'production' ? 'Internal server error' : err.message,
  ```

  `src/server/src/routes/auth.js:1210-1219` 三个分支返回三种不同响应体：

  ```js
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!user.password_hash) {
    return res.status(401).json({ error: 'Account has no password set. Please log in with a verification code.' });
  }
  ```

- **失败场景**：
  1. 攻击者构造畸形 JWT 打任意受保护端点，从 `detail` 字段拿到 jsonwebtoken 的原始报错（`jwt malformed` / `invalid signature` / `jwt expired`），得到一个区分「结构错」与「签名错」的判定预言机，用于验证自己猜的密钥是否接近正确。
  2. 攻击者拿一批邮箱/手机号打 `/login`：返回「Account has no password set」= 该账号**存在**且是纯验证码注册；返回「Invalid credentials」= 不存在或已设密码。配合 `/register` 的 409（`:946` `This phone number is already registered`）可以完整枚举注册用户库。`/forgot-password` 在 `:770-773` 特意做了防枚举（用户不存在也返回成功），但 `/login` 这条把它抵消了。
- **影响**：安全（中低）。为定向撞库提供账号清单与签名判定预言机。
- **修法**：`detail` 只在非生产返回；`/login` 三个失败分支合并成同一个响应体与同一个耗时特征（对不存在的用户也跑一次 `bcrypt.compare` 假哈希）。

---

### [S2-15] `tests/security.test.js` 的 CSRF / 认证绕过 / 越权三节全是 `describe.skip` —— 认证面在 CI 里零覆盖

- **证据**：`src/server/tests/security.test.js:105`、`:119`、`:133`：

  ```js
  describe.skip('CSRF攻击测试', () => {
  ...
  describe.skip('认证绕过测试', () => {
  ...
  describe.skip('权限提升测试', () => {
  ```

  另有 `:28`、`:38`、`:71` 三个 `it.skip`。存活的 5 条断言全是 `expect(res.status).not.toBe(500)` 或 `expect([200,400,404]).toContain(res.status)`，而 `middleware/auth.js:8-20` 在 `NODE_ENV=test` 下直接注入固定假用户、`middleware/csrf.js:144-146`、`middleware/subscriptionCheck.js:11-13`、`middleware/planFeature.js:116-118` 全部短路 → 这些断言无条件通过。
  `tests/csrf.test.js` 是唯一实质的 CSRF 测试，但它直接 import 中间件函数（`:2`），从不经过 `index.js` 的挂载链，所以 S3-6 描述的「整条链路是死的」它测不出来。`tests/sms.test.js` 覆盖 fail-closed 与 `generateCode` 形态，但没有（也无法）测出 `Math.random()` 的可预测性。

- **失败场景**：本报告里的 4 个 S0 与 2 个 S1，**没有一条**会被现有 CI 拦住。文件名叫 `security.test.js`，会让「安全有测试兜底」的判断成立——而实际上认证绕过、CSRF、越权三类断言全部处于关闭状态，剩下的断言在测试环境下恒真。
- **影响**：安全（流程）。这块的回归网是关掉的，这正是上述缺陷能长期存活到 v1 前的直接原因。
- **修法**：单独一个 suite 以 `NODE_ENV=development` 跑（或把各处 `NODE_ENV === 'test'` 旁路收敛到一个显式的 `TEST_AUTH_BYPASS=1` 开关），让认证/CSRF/越权断言真正执行。

---

### [S3-1] 三个 auth 路由文件（约 860 行）被完全遮蔽，其中两处是「上了膛的死代码」

- **证据**：`src/server/src/index.js:393-397` 按此顺序把 5 个 router 挂在同一个前缀：

  ```js
  app.use('/api/auth', authRoutes);          // routes/auth.js
  app.use('/api/auth', authVerifyRoutes);    // routes/auth-verify.js
  app.use('/api/auth', authPasswordRoutes);  // routes/auth-password.js
  app.use('/api/auth', authProfileRoutes);   // routes/auth-profile.js
  app.use('/api/auth', authSessionRoutes);   // routes/auth-session.js
  ```

  Express 在第一个应答的路由处停止，故 `auth.js` 的版本全胜。重复定义清单：
  - `auth-verify.js`：`/send-code`(`:50` vs `auth.js:158`)、`/send-email-code`(`:104` vs `:210`)、`/verify-code`(`:147` vs `:259`)、`/verify-email-code`(`:248` vs `:498`)、`/accept-tos`(`:459` vs `:712`)
  - `auth-password.js`：`/forgot-password`(`:42` vs `:748`)、`/reset-password`(`:93` vs `:813`)、`/login`(`:139` vs `:1130`) —— **整个文件全部不可达**
  - `auth-profile.js`：`/me`(`/profile`/`/account`/`/export-data`/`/deactivate`/`/reactivate`/`/consent` 七个全部与 `auth.js:1286-1780` 重复）—— **整个文件全部不可达**
  - `auth-session.js`：`/logout`(`:70` vs `auth.js:1833`)

  两处上了膛的死代码：
  - `auth-profile.js:205`——**没有 `authenticateToken`**，凭 body 里的邮箱/手机号就能激活任意账号：

    ```js
    router.put('/reactivate', async (req, res) => {
      const { email, phone } = req.body;
      ...
      await pool.query('UPDATE users SET is_active = TRUE, deactivated_at = NULL WHERE id = $1', [userId]);
    ```
    （`auth.js:1668` 的同名路由是有鉴权的，所以当前不可达；`index.js` 里调换两行顺序就立刻变成未认证的账号解封接口。）
  - `auth-verify.js:459`——同样无鉴权，`UPDATE users SET tos_accepted = TRUE ... WHERE phone = $1` 可写任意用户；且用的列名是 `tos_accepted`，而 `auth.js:722-727` 用的是 `tos_accepted_at`（列名漂移）。

  遮蔽还导致**修好的代码不生效**：`auth-verify.js:178` 用 `DELETE FROM verification_codes` 实现一次性消费、`auth-password.js:120` 同样，而生效的 `auth.js:280-285` 没有（→ S2-4）；`auth-session.js:82-83` 的注释还专门记录了「此前写 `blacklist:{id}`、读的是 `bl:{jti}`，键不一致导致黑名单从未生效」并在 `/logout` 修好了——但**同一个文件 `:57` 的 `DELETE /sessions/:sessionId` 还在写 `blacklist:${sessionId}`**，修复只做了一半，而那个 `/logout` 本身又是死的。

- **失败场景**：维护者改 `auth-password.js` 的密码重置逻辑、跑起来发现毫无变化（实际执行的是 `auth.js:813`）；或调整 `index.js` 挂载顺序做重构，未认证的 `/reactivate` 与 `/accept-tos` 静默上线。
- **影响**：可维护性 + 潜在安全。A4 短信修复被迫在两个文件里各写一遍（`auth.js:155-157` 与 `auth-verify.js:46-49` 是同一段注释），就是这种结构的直接成本。
- **修法**：删除 `auth-password.js`、`auth-profile.js` 两个文件与 `auth-verify.js`/`auth-session.js` 中重复的 handler，一个路径只留一处定义。

---

### [S3-2] `POST /api/auth/reset-pin` 无限流、无实际作用，只能被用来消耗受害者的待用验证码

- **证据**：`src/server/src/routes/auth-verify.js:418`（这条是该文件里少数**可达**的路由之一，`auth.js` 没有同名路径）：

  ```js
  router.post('/reset-pin', async (req, res) => {
  ```

  无限流器（同文件其他路由都挂了 `sendCodeLimiter`/`loginFailedLimiter`）。校验成功后 `:448` `DELETE FROM verification_codes WHERE phone = $1`，`:451` 返回：

  ```js
  res.json({ message: 'PIN reset verified', resetToken: identifier });
  ```

  `resetToken` 只是把请求里的手机号/邮箱原样回显。文件头注释也说明 PIN 存在前端 localStorage（`:417`），服务端无可重置之物。

- **失败场景**：攻击者对某手机号无限次猜 6 位码（无计数、无 IP 桶）；猜中即把该标识符下所有待用验证码删掉，受害者正在进行的登录/改密流程被打断。除此之外拿不到任何东西——即这是一个纯粹的、无限速的「验证码消耗」端点。
- **影响**：安全（低）/ 可用性。
- **修法**：加限流；或直接删除该端点（PIN 是客户端本地概念，服务端没有对应状态）。

---

### [S3-3] `POST /api/auth/2fa/setup` 会静默关闭已启用的 2FA，无需任何验证码

- **证据**：`src/server/src/routes/two-factor.js:59-62`：

  ```js
  await pool.query(
    'UPDATE users SET two_factor_pending_secret = $1, two_factor_enabled = FALSE WHERE id = $2',
    [encryptField(secret), userId]
  );
  ```

  不检查当前 `two_factor_enabled`，也不要求提供现有动态码（对比 `/2fa/disable` 在 `:120-126` 是要求验证码的）。

- **失败场景**：任何已认证调用方（包括 S0-1 的挑战令牌）一次 `POST /api/auth/2fa/setup` 就把受害者的 `two_factor_enabled` 翻成 FALSE 并写入自己的 pending secret；随后 `/2fa/enable`（`:92-100`）用攻击者自己的动态码把 `two_factor_secret` 覆盖掉。这是 S0-1 从「5 分钟访问」升级为「永久改绑 + 原主锁死」的具体机制。
- **影响**：安全。2FA 的关闭/改绑缺少二次确认。
- **修法**：`two_factor_enabled` 已为 TRUE 时返回 409，除非同时提供有效的当前动态码或备份码。

---

### [S3-4] 所有验证码使用 `Math.random()`，且同一实现被复制了 4 份

- **证据**：`src/server/src/utils/sms.js:95-97`：

  ```js
  export function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
  ```

  其上方 `:92-93` 的论证是「有效期 10 分钟 + 一次性消费 + 限流器已覆盖爆破面」——三个前提在本次审计中**全部不成立**：一次性消费未生效（S2-4）、`/reset-password` 无限流（S0-3）、邮箱路径的限流器落在全局共享桶（S1-2）。
  同样的表达式被内联复制在 `routes/auth.js:776`、`routes/auth-verify.js:121`、`:395`、`routes/auth-password.js:67`。V8 的 `Math.random` 是 xorshift128+，不是 CSPRNG。

- **失败场景**：在 `/reset-password` 无速率限制的前提下，9×10^5 的空间可以在 10 分钟窗口内被显著比例地覆盖（见 S0-3）。此外 `tests/sms.test.js:96-99` 的随机性断言是「200 次采样去重后 > 150 种」，`Math.random()` 轻松通过，测不出可预测性。
- **影响**：安全。
- **修法**：`crypto.randomInt(100000, 1000000)`，一行改动；顺手删掉 4 处内联副本，统一走 `generateCode()`。

---

### [S3-5] `HASH_SALT` 有仓库内明文兜底；`ENCRYPTION_IV` 与 `hashField` 是死代码

- **证据**：`src/server/src/routes/auth.js:30`：

  ```js
  const HASH_SALT = process.env.ENCRYPTION_KEY?.substring(0, 16) || 'CLIPSYNC_SALT_2026';
  ```

  生产靠 `utils/encryption.js:25-39` 的 `process.exit(1)`（缺 key / 用默认值 / 长度 < 32 都退出）间接兜住；但 dev/test 环境下所有 `phone_hash` / `email_hash` 都是 `sha256(value + 'CLIPSYNC_SALT_2026')`，盐值在公开仓库里，而这些哈希正是 `WHERE phone_hash = $1` 的匹配依据（`auth.js:322`、`:875`、`:943`）。
  `src/server/src/utils/encryption.js:56` 与 `:71` 计算了模块级 `IV`：

  ```js
  const IV_RAW = process.env.ENCRYPTION_IV || 'default_iv_12b';
  ...
  const IV = Buffer.from(IV_RAW).length === IV_LENGTH ? Buffer.from(IV_RAW) : padOrTruncateKey(IV_RAW, IV_LENGTH);
  ```

  但 `encrypt()`（`:91`）每次自己 `crypto.randomBytes(IV_LENGTH)` 并把 IV 写进密文，`decrypt()`（`:129`）从密文里读——模块级 `IV` 与 `ENCRYPTION_IV` 这个环境变量**从头到尾没被用过**（`:77-79` 还专门为它写了一条长度告警）。
  `:315-317` 的 `hashField` 是**无盐** SHA-256，`grep "hashField("` 全仓只命中它自己的定义与 `:326` 的 `verifyHash`，无任何调用方。

- **失败场景**：运维照 `.env.production.example` 之外的文档去调 `ENCRYPTION_IV`，改完发现行为毫无变化（该变量无效）；有人误以为 `hashField` 是手机号哈希的实现而拿去用（无盐，可被字典反查）；dev/test 库里泄露一份数据即可用公开盐值反查明文手机号。
- **影响**：安全（低）/ 可维护性。
- **修法**：所有环境都要求 `ENCRYPTION_KEY` 存在才允许计算哈希；删除 `IV_RAW`/`IV`/`ENCRYPTION_IV` 与 `hashField`/`verifyHash`。

---

### [S3-6] `csrfProtection` 在任何环境下都不可能生效 —— REST CSRF 层整体是死的

- **证据**：`src/server/src/middleware/csrf.js:156-159`：

  ```js
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return next();
  }
  ```

  以及 `:170-173`：

  ```js
  if (!userId) {
    return next();
  }
  ```

  `index.js` 里每一处 `csrfProtection` 都排在 `authenticateToken` 之后（`:407`、`:411`、`:415`…），而 `authenticateToken` 只有拿到 Bearer 头才可能通过（`middleware/auth.js:22-27`）；测试环境 `csrf.js:144-146` 又整体短路。**三条出口合起来覆盖了 100% 的流量**。
  全站没有 cookie：`grep "res.cookie|req.cookies|cookie-parser|Set-Cookie|httpOnly|sameSite" src/server/src` → **0 命中**；admin-console 也没有 `credentials`/`withCredentials`/`document.cookie`。
  客户端侧同样断开：`src/desktop/src/api/client.ts:50` 读 `data.token`，而 `csrf.js:204-207` 返回的是 `{ csrfToken, expiresIn }` → `csrfToken` 恒为 null，桌面端从不发送该头（`:47` 的 `credentials: 'include'` 也是无意义的）。移动端把绕过写进了注释：`search_history_api_service.dart:58`「认证请求在服务端跳过 CSRF 校验（csrf.js:157）」、`shared_links_api_service.dart:113`「服务端 csrfProtection 对 Bearer 请求直接放行」。

- **失败场景**：不是运行时故障，而是**认知故障**：约 200 行中间件、一套 Redis 键空间（`csrf:token:{token}`）、一个 `docker-compose.prod.yml:101` 的 `CSRF_SECRET` 环境变量（全仓 0 处读取）、以及桌面端每次冷启动一次 `GET /api/csrf-token` 往返（`client.ts:46`，注释里还把它算进了「减少 ~50% 请求量」的性能账），共同保护了 0 个请求。而真正需要 CSRF 防护的地方——WS 握手（`ws/server.js:159-210`）——用的是**另一套键空间** `csrf:{token}`（`routes/ws.js:20`），`refreshToken.js:8` 的注释专门警告过「勿混用」。
- **影响**：可维护性 + 虚假安全感。策略本身是自洽的（纯 Bearer ⇒ CSRF 确实不构成威胁），但代码没有表达这一点。
- **修法**：删除 `middleware/csrf.js` 及其全部挂载点、`CSRF_SECRET` 与桌面端的 token 拉取，只保留 WS 握手令牌；若坚持保留则在中件顶部注释明确「Bearer-only 架构下本中间件为 no-op」。

---

### [S3-7] 若干挂载点缺限流；限流总开关可一键关掉管理台高危节流；审计路径前缀写错

- **证据**：
  - `src/server/src/index.js:443`、`:446`——`/api/sessions`、`/api/notifications` 只挂了 `authenticateToken`，无限流：

    ```js
    app.use('/api/sessions', authenticateToken, sessionRoutes);
    app.use('/api/notifications', authenticateToken, notificationRoutes);
    ```
    `:449` 的 `/api/subscriptions` 有 `apiLimiter` 但没有 `csrfProtection`（其他改状态挂载点都有）。`:393-399` 的 `/api/auth` 整段无 `apiLimiter`，于是没挂路由级限流器的 `/reset-password`、`/set-password`、`/change-password`、`/2fa/verify-login`、`/reset-pin`、`/logout` 全部裸奔。
  - `src/server/src/middleware/rateLimiter.js:200-201`——总开关作用于**每一个** limiter，包括 `adminStrictLimiter`：

    ```js
    const snapshot = await getRuntimeLimits();
    if (snapshot.disabled) return next();
    ```
    这与它自己 `:364-366` 的注释矛盾：「防止管理台误操作把自己的防线调高/关闭；`rate_limit_disabled` 总开关仍生效」。即一个管理台开关可以把退款/强制下线/删账号的 10 次/分钟节流一并关掉。
  - `:107-113`——Redis ZCARD 结果异常时选择放行（`return { allowed: true, ... }`），是 2026-09-15 生产事故的权衡结果，但意味着限流在 Redis 异常时静默失效。
  - `src/server/src/middleware/superAdminAudit.js:15-20` 与 `:63`——排除清单是绝对路径，而 `req.path` 在挂载路由内是相对路径：

    ```js
    const AI_EXCLUDED_PREFIXES = ['/api/ai/chat', ...];
    ...
    if (!isExcludedPath(req.path)) {
    ```
    在 `index.js:512` 的 `/api/ai` 挂载点下 `req.path` 是 `/chat`，永不匹配 → 防双写的排除逻辑从未生效；同理 `:69,72` 写入审计的 `resourceId`/`path` 缺 `/api/admin` 前缀，审计页看到的是 `/users/xxx/force-logout` 而非完整路径。
  - `src/server/src/routes/admin/audit.js:191`——唯一一处把值直接拼进 SQL（虽然来源是文件内硬编码的 `Set`，不可注入，但与上下 5 行的参数化写法不一致）：

    ```js
    const list = [...SENSITIVE_EXACT_ACTIONS].map((a) => `'${a}'`).join(', ');
    where.push(`(al.action LIKE 'admin.%' OR al.action IN (${list}))`);
    ```

- **失败场景**：管理台把 `rate_limit_disabled` 打开做压测后忘记关闭 → 全站所有限流（含资金类高危操作）静默失效，且没有任何告警；审计页按路径检索超管操作时对不上真实 URL。
- **影响**：安全（低）/ 可观测性。
- **修法**：给 `/api/auth`、`/api/sessions`、`/api/notifications` 补 `apiLimiter`；`adminStrictLimiter` 不受总开关影响；`superAdminAudit` 改用 `req.originalUrl`。

---

### [S3-8] 腾讯云短信分支结构性不可用；`/pairing/redeem` 的一次性消费非原子

- **证据**：
  - `src/server/src/utils/sms.js:212` 与 `:217` 读取 `config.sms_region` / `config.sms_sdk_app_id`，但这两个键**不在** `:32-38` 的 `SMS_KEYS` 列表里，因此 `getSmsConfig()` 从不读取它们，恒为 `undefined`；`getSmsConfig` 的完整性判断（`:69-74`）也不检查它们，所以 `sms_provider=tencent` 能通过校验、然后在 `:201` `await import('tencentcloud-sdk-nodejs-sms')` 抛 MODULE_NOT_FOUND（该包不在 `src/server/package.json`，`@alicloud/dysmsapi20170525` 在 `:26`）→ 被 `:141-154` 捕获 → 每次发码都返回 503 `短信服务暂不可用`。管理台上 `tencent` 是一个可选但必然失败的值。
  - `src/server/src/routes/device.js:68` 与 `:81`——配对令牌用 `get` 后再 `del`，不是原子操作：

    ```js
    const raw = await redis.get(`pairing:${token}`);
    ...
    await redis.del(`pairing:${token}`);
    ```
    对比 `utils/refreshToken.js:31` 的刷新令牌就用了 `redis.getDel`（并在 `:7` 的注释里说明了「并发重放时只有第一个请求成功」）。

- **失败场景**：管理员在管理台把短信服务商选成腾讯云并填齐 4 个凭据，保存后所有用户的手机验证码登录一律 503，日志里是 `unsupported`/模块缺失，排查方向被误导到网关侧。配对令牌在两个并发 redeem 下可被消费两次（各得一张有效 token），需要先拿到令牌才可利用，故危害有限。
- **影响**：可用性（低）。
- **修法**：把 `sms_region`/`sms_sdk_app_id` 加进 `SMS_KEYS` 与完整性校验并安装 SDK，否则在管理台把 `tencent` 选项去掉；`redis.get` + `redis.del` 换成 `getDel`。

---

## 设计层面的观察（架构/可维护性）

**1. 认证有 5 处独立实现，且靠挂载顺序决定谁生效。**
`createSessionAndGenerateToken` 被复制了 4 份：`routes/auth.js:44`（导出版，被 `device.js:11` 与 `two-factor.js:18` 复用）、`routes/auth-verify.js:20`、`routes/auth-password.js:16`，加上 `auth-refresh.js:57` 内联的 `jwt.sign`。四份的 payload 形状一致纯属人工维持。加上 S3-1 描述的路由遮蔽，实际结果是：**修一个认证 bug 需要同时改 4 个文件，而其中 3 个改了也没用**——A4 短信修复在 `auth.js:155-157` 与 `auth-verify.js:46-49` 各写了一遍同样的注释，S2-4 的「一次性验证码」修在了永不执行的文件里，`auth-session.js:82-83` 的黑名单键修复只做了一半。这是本次审计中 S0/S1 密度如此之高的结构性原因。建议：把认证收敛为「一个 session 服务 + 一个 auth 路由模块」，其余删除。

**2. `NODE_ENV === 'test'` 旁路散落在 6 处，构成一个隐形的「全站无防护」模式。**
`middleware/auth.js:8-20`（注入固定假用户，跳过一切校验）、`middleware/csrf.js:144`、`middleware/subscriptionCheck.js:11`、`middleware/planFeature.js:116`、`middleware/rateLimiter.js:193` 与 `:238`/`:369`/`:387`、`index.js:363`（metrics 免鉴权）。任何一处误设 `NODE_ENV=test` 都会同时关掉认证、CSRF、订阅校验、套餐墙与限流。`docker-compose.prod.yml:82` 写死了 `production`，所以目前安全；但这个「一个环境变量决定六道防线」的耦合应当收敛成一个显式的 `TEST_AUTH_BYPASS=1`，并且只在 `import.meta` 顶层允许一次。

**3. 三套并行的授权事实源。**
`users.is_admin`（布尔，只在 `028_roles.sql` 回填过一次，被 `subscriptionCheck.js:37` 用来发无限额度）、`roles.level`（`requireRole`）、`role_permissions`/`permissions`（`requirePerm`）。三者可以互相矛盾，S2-7 就是矛盾已经实际发生的例子。`middleware/auth.js:75` 甚至把两者 OR 起来（`Boolean(row.is_admin) || row.role_key === 'super_admin'`）。建议：`is_admin` 列退役，额度与权限一律由 `roles` + `role_permissions` 派生。

**4. Fail-open 与 fail-closed 的口径不统一，且缺少一处集中的说明。**
fail-closed 的：`middleware/adminAuth.js:117-125`（权限查询出错 → 500，注释明确「宁可拒绝不可放行」）、`utils/encryption.js:25-39`（生产缺密钥 → `process.exit(1)`）、`utils/sms.js:114-118`（未配置 → 不伪造成功）、`ws/server.js:203-207`（生产 Redis 不可用 → 拒连）。
fail-open 的：`middleware/auth.js:76-79`（活性查询出错 → 放行）、`utils/redis-client.js:274,279`（黑名单不可用 → 视为未吊销）、`utils/adminSecurity.js:50-57`（角色查询出错 → 允许管理员不绑 2FA 登录）、`middleware/rateLimiter.js:107-113`（计数异常 → 放行）、`utils/email.js:246-258`（无邮件通道 → 报成功）。
两个方向都有道理，但混在一起时会产生 S2-3 那种「Redis 抖动 + DB 抖动同时发生 → 两层吊销一起失效」的组合。建议：明确一条规则——**「拒绝服务」类检查（限流、活性、吊销）默认 fail-closed，只有当 fail-closed 会造成全站不可用时才降级，且降级必须打 error 级日志并触发告警**。目前的 `console.warn`（`auth.js:78`）和 `logger.warn` 都进不了告警。

**5. 传输与头部：应用层做得比入口层好。**
`index.js:80-98` 手工设置了 X-Frame-Options / nosniff / CSP / Referrer-Policy / Permissions-Policy，生产加 HSTS——覆盖齐全（未用 helmet，但等效）。问题在入口：`nginx/conf.d/clipsync.conf:5` 只 `listen 80`，`:85-97` 的 443/TLS 整段被注释掉，`server_name localhost`；而 `docker-compose.prod.yml:123-124` 又把 API 直接暴露成 `${API_PORT:-3000}:3000`。也就是说生产环境下客户端可以完全绕过 nginx 直连 3000 端口走明文 HTTP，此时 HSTS 头是空发的（浏览器只在 HTTPS 响应上记录 HSTS），Bearer token 与 JWT payload 里的明文手机号/邮箱（S2-12）全程明文。HTTPS 证书本身属于排除项（A2），但「compose 把 API 端口直接对宿主开放、绕过唯一的入口层」是配置侧可自行决定的，建议 `ports: []` + 只经 nginx/Traefik 暴露。另：`nginx/conf.d/clipsync.conf:40` 的 `limit_req` 与 `:57` 的 `limit_conn` 都被注释掉了（注为「临时关闭以方便测试」），入口层限流目前也是 0。

**6. 每个认证请求多打一次 DB。**
`middleware/auth.js:52-60` 在每个受保护请求上执行一次 `users LEFT JOIN roles LEFT JOIN user_sessions`。这是 S2-3 里 fail-open 会被频繁触发的原因（连接池压力），也是 `subscriptionCheck`（`:18`）、`planFeature.loadPlanFeatures`（`:58`）之外第三次同类查询——一次 `GET /api/clipboard` 要打 3 次用户/角色查询。建议合并为一次带缓存的用户上下文加载（`utils/cache.js` 已有 `getUserCache`，只在 `auth-profile.js` 那个死文件里用了）。

---

## 建议补充的功能（v1 可选，按性价比排序）

1. **登录/发码/重置的「按 IP + 按标识符」双桶限流，并接入告警**（半天）。同时修掉 S1-2 的 keyGenerator 与 S2-1 的 XFF。这是把 S0-3 的爆破成本从「几小时」抬到「不可行」的最小改动，也是 v1 上线后最容易被自动化脚本打到的面。
2. **登录失败锁定与「新设备登录」通知落地**（1 天）。`ws/server.js detectAndNotifyNewLogin` 已在 `auth.js:430`、`:663`、`:1241` 被调用，但用户端没有可操作的处置入口（会话列表不可用，见 S2-13/S1-1）。补齐「异地登录提醒 → 一键踢出」这条闭环，是账号被盗时唯一的止损手段。
3. **`users.email` / `phone` 的 UNIQUE 约束 + 邮箱变更验证码流程**（1 天）。一次性堵住 S2-6 与 S0-4 的路径 B，并让 `/login`、`/forgot-password`、`/reset-password` 的「按邮箱定位唯一用户」这个隐含前提在数据库层成立。
4. **会话表加 `last_active_at` + 并发上限 + 清理任务**（1 天）。S2-13 的完整修法；顺带让「踢出设备」这个 UI 真正可辨认。
5. **管理台补 `admin.overview.view` 权限点**（1 小时）。S2-9 的最小修法，让「授予最小权限」这件事在营收数据上第一次变得可能。
6. **删除 `middleware/csrf.js` 与三个死路由文件**（半天，纯减法）。S3-1 + S3-6。减少约 1100 行永不执行的代码，直接消除两处「上了膛」的无鉴权端点，并让后续认证改动不再需要判断「我改的这个文件到底跑不跑」。
7. **验证码/令牌统一走 `crypto.randomInt` / `crypto.randomBytes`，并给验证码加 `attempts` 计数列**（半天）。S3-4 + S0-3 的加固层：即使限流被绕过，5 次错误后作废该码也能封顶爆破收益。
8. **`security.test.js` 的三个 `describe.skip` 恢复运行**（1-2 天）。S2-15。需要先做第 2 条观察里的 `TEST_AUTH_BYPASS` 收敛，否则测试环境无法产生真实的 401/403。这是唯一能防止上述缺陷在 v1 后回归的机制。
