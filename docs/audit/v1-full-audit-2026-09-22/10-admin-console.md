# 管理台（admin-console）审计

审计日期：2026-09-22 · 审计范围：`src/admin-console` 全部前端（16,291 行 TS/TSX）+ 与 `src/server/src/routes/admin/` 的契约
方式：纯静态阅读（未运行 dev/build/e2e）。所有结论均带 `文件:行号` 锚点。

---

## 结论（能不能上 v1）

**不能直接上，但离得很近。** 工程质量在同类内部后台里属上乘（`any` 0 处、`eslint-disable` 4 处、TS `strict + noUncheckedIndexedAccess`、危险操作普遍有原因必填弹窗、mock 在生产构建被证明彻底剔除），契约漂移也远比近期提交记录暗示的少。阻断项集中在两处：**① 超管 bearer token 明文落 localStorage 且前端 RBAC 完全由该可篡改存储驱动；② dev 控制台可一键（或被一个链接静默）指向生产后端并下发真实打款指令，全程无二次确认、无生产态警示、无只读保护。** 另有 4 条 S1 是「点了就坏」级别（2FA 管理员无法密码登录、审计操作者筛选固化了 mock 人名、mock 横幅谎报数据来源、版本发布一键推全网）。修完 2 条 S0 + 4 条 S1 即可上。

---

## 页面 → 数据来源全表

判定口径（唯一真相源 `src/api/upstream.ts:62-64`）：

```ts
export function mockInterceptsApi(): boolean {
  return upstreamEditable && import.meta.env.VITE_ENABLE_MSW !== 'false' && !getUpstream();
}
```

`upstreamEditable = import.meta.env.DEV`（`upstream.ts:21`）。**生产构建恒 false → MSW 不可能启动**；`vite.config.ts:115-123` 的 `stripMswWorkerFromBuild` 插件还在 `closeBundle` 阶段物理删除 `dist/mockServiceWorker.js`。这一层做得干净，无 S0。

但 dev（MSW 开启）下 `worker.start({ onUnhandledRequest: 'bypass' })`（`main.tsx:35`）意味着**没有 handler 的端点会静默穿透 vite proxy 打到真实后端**。逐个端点核对 `mocks/handlers.ts:1439-1455` 的 `handlers` 数组（52 个 handler）后：

| 页面 | 路由 | 数据来源 | 备注 |
|---|---|---|---|
| 登录 | `/login` | mock | login / send-code / verify-code / whoami 全有 handler |
| SSO 兑换 | `/sso` | **真实** | `/auth/sso-exchange` 无 handler |
| 数据看板 | `/dashboard` | mock | |
| 用户管理 | `/users` | **混合** | 列表/详情/改状态=mock；审批、强制下线、删除、导出=真实（4 端点无 handler） |
| 设备管理 | `/devices` | mock | 列表/统计/下线/密钥全有 |
| 订单与支付 | `/orders` | mock | 列表/详情/退款/对账全有 |
| **退款审核** | `/refund-review` | **全部真实** | refund-reviews ×3 + refund-settings ×2，**5 个端点 0 handler** |
| 订阅管理 | `/subscriptions` | mock | |
| 套餐与价格 | `/plans` | mock | |
| 客户端策略 | `/policies` | mock | |
| 审计日志 | `/audit` | mock | |
| 管理员会话 | `/security` | mock | |
| 角色权限 | `/roles` | mock | |
| **系统设置** | `/settings` | **混合** | 参数/开关/公告=mock；**邮件通道整卡 5 个端点全真实** |
| AI 平台 | `/ai` | mock | |
| 运维监控 | `/ops` | **混合** | 7 个端点=mock；`/ops/backups/download`=真实 |
| 403 / 404 | — | 无请求 | |

统计：**mock 页 11 个 · 混合页 3 个（users / settings / ops）· 全真实页 2 个（refund-review / sso）**。
共 **14 个前端在调、MSW 无 handler** 的端点。

**当前工作树状态另需注意**：`src/admin-console/.env.development.local`（已 gitignore，未入库）设了
`VITE_ENABLE_MSW=false` + `VITE_PROXY_TARGET=https://api.clipchain.top` + `VITE_PROXY_ORIGIN=https://admin.clipchain.top`。
即此刻 `npm run dev` 起来的管理台**整站直连生产后端**，MSW 完全不启用、红色 MOCK 横幅也不显示，页面上唯一的提示是右下角 dev 面板里一行灰色小字「直连 https://api.clipchain.top」+ Header 的「DEV 环境」标签（`AdminLayout.tsx:352`）。

---

## 前后端契约一致性核对表

逐个核对 `src/api/*.ts` 的 68 个调用点与 `src/server/src/routes/admin/` 的实现。**结论：没有「前端调了后端不存在」的端点，没有分页参数名不一致（全站统一 `page/pageSize`，后端上限 200），没有 list/items 解包错误。** 差异如下：

| # | 前端调用 | 后端实现 | 一致? | 差异详情 + 锚点 |
|---|---|---|---|---|
| 1 | `GET /admin/refund-reviews` 解 `resp.items` | `refundReviews.js:42` 同时下发 `list` 与 `items` 同值 | ✅ | 前端 `refundReviews.ts:107-108` 只认 `items` 并在 API 层转成 `list`，转换收在一处。后端双键冗余但无害 |
| 2 | `POST /auth/login` → `RealLoginResp{token,sessionId,user}` | `auth.js:1229` 在 `two_factor_enabled` 时返回 **HTTP 200 `{twoFactorRequired:true, challengeToken}`** | ❌ **S1-1** | 前端 `auth.ts:46-50` 不判该分支，`real.token` 为 `undefined` → `finalizeSession` 带 `Bearer undefined` 打 whoami → 401 → `client.ts:134` 硬跳登录页 |
| 3 | `LoginResp.refreshToken` | `/auth/login` 响应体（`auth.js:1263-1278`）**不含 refreshToken** | ❌ **S2-2** | `auth.ts:32` 硬编码 `refreshToken: null`，`client.ts:69` 因此恒早退，整套 401 续期是死代码 |
| 4 | `FeatureFlag{key,name,description,enabled}` | `configs.js:663` 额外下发 **`enforced`** | ❌ **S2-5** | 前端 `types.ts:264-269` 无该字段，设置页从不渲染 → AN-10 防「开关改了不生效」机制在前端作废 |
| 5 | `PaymentChannel = 'wechat'\|'alipay'\|'stripe'` | `orders.js:51` `CHANNEL_CASE_SQL` 的 `ELSE 'unknown'` | ❌ **S2-7** | `mappers.ts:83-87` `channelLabel` 无 `unknown` 键 → 订单列表/详情渠道列渲染空白。对账接口已单独给 `unknown` 行（`orders.js:407-408`），同一笔订单两处显示不一致 |
| 6 | `AuditOperatorFilter = 'all'\|'Carlos'\|'Yuki'\|'end_user'` | `audit.js:207` `u.nickname = $n` 精确匹配 | ❌ **S1-2** | 类型本身把 mock 人名固化成唯一合法取值；`audit.js:205` 注释也写着「如 Carlos / Yuki」 |
| 7 | `AuditLogListParams`（`types.ts:193-202`） | `audit.js:172` 还支持 `q`、`userId` | ⚠️ | `userId` 前端在 `AuditFilters` 里有、类型里漏（能跑，AF-34 靠它）；**`q` 完全未暴露 → 审计页无全文搜索** |
| 8 | `testSmtp(): Promise<{messageId:string}>` | `configs.js:571` 返回 `{to, messageId}`，`messageId` 可为 `null` | ⚠️ | 类型说 `string`，实际可 `null`。当前 UI 不读该字段，未爆 |
| 9 | `getSlowQueries` 403 判定 `err.code === 40301` | `requirePerm` 拒绝用 **`4030`**（`adminAuth.js:45,130`） | ⚠️ | `ops/index.tsx:84` 常量错；靠 `:86` 的 `status === 403` 兜住，未爆 |
| 10 | `ApproveRefundReviewResp.order{orderNo,status}` | `refundRequest.js` 实际还带 `refundAmount` | ⚠️ | 类型窄于实现（少字段无害），`refund-review/index.tsx:133` 只读 `orderNo` |
| 11 | `RejectRefundReviewResp.entitlementRestored?` | `refundReviews.js:119` 恒下发 | ✅ | 前端标为可选并在 `:153` 用 `=== false` 严格判定，注释如实说明「契约未列、服务端实测带」 |
| 12 | `POST /admin/subscriptions/:id/grant` `{planId:'pro',months,reason}` | `subscriptions.js` 兼容套餐名与 UUID；months 后端 1–36 / 前端 1–12 | ✅ | 前端更严，后端注释明确说明是刻意放宽 |
| 13 | `PATCH /admin/plans/:id` 白名单 11 字段 | `plans.js:114-127` `FIELD_VALIDATORS` 同 11 键 | ✅ | 逐键核对无差 |
| 14 | 时间字段格式 | 两种混用 | ❌ **S2-1** | 见下节 |
| 15 | 其余 54 个端点（users/devices/orders/roles/policies/releases/sessions/ai-providers/email-channels/ops ×7/overview/audit/announcements/permissions/whoami） | — | ✅ | URL、方法、参数名、响应壳 `{code,data,message}` 逐一对齐，未发现差异 |
| 16 | `POST /admin/subscriptions/:id/revoke` `{reason,mode}`（**2026-10-05 新增**） | `subscriptions.js` 的 `/:id/revoke`：`mode` 缺省 `immediate`；有真实已付订单 ⇒ 409 `HAS_PAID_ORDER` | ✅ | 保护闸是该端点的核心设计（用户花钱买到的权益不能在管理台撤销，只能走退款）；权限刻意复用 `admin.subscriptions.grant`，避免为语义细分动 043 权限目录的迁移 |
| 17 | `POST /admin/users/:id/notify` `{title,body,notificationType?}`（**2026-10-05 新增**） | `users.js` 的 `/:id/notify`：类型走服务端白名单（4 类），返回 `onlineDevices` | ✅ | 权限刻意用 `admin.announce.send`（对外触达类）而非 `users.manage`；刻意**不**读 `notification_preferences`（用户关掉产品推送不该屏蔽客服私信）。清单与前后端对齐见 `docs/audit/admin-console-db-only-gaps-2026-10-05.md` |

### 时间戳格式（S2-1 的证据表）

后端有两套互不兼容的序列化：

| 风格 | 出处 | 前端处理 | 结果 |
|---|---|---|---|
| `toISOString().replace('T',' ').slice(0,N)` — **UTC 裸串，无时区标记** | `audit.js:106`、`users.js:134`、`overview.js:81`、`sessions.js:43`、`devices.js:65`、`configs.js:355`、`aiProviders.js:39`、`emailChannels.js:49`、`announcements.js:50` | `dayjs(...)` 把无时区串当**本地时间**解析（`format.ts:18-22`、`audit/index.tsx:149`） | **显示值 = UTC 挂钟时间**，比北京时间慢 8 小时，且无任何时区标注 |
| `toISOString()` — **带 Z 的 ISO** | `orders.js:96`（createdAt/paidAt）、`services/refundRequest.js:62,63,339`（requestedAt/reviewedAt/paidAt）、`ops.js:336`（mtime） | dayjs 正确转本地 | **正确** |

即：**订单页与退款审核页显示本地时间，审计页/用户页/设备页/会话页/看板显示 UTC**，两套都写着同样的 `YYYY-MM-DD HH:mm`，肉眼无从分辨。

---

## 问题清单

### [S0-1] 超管 bearer token 与全量权限清单明文存 localStorage，前端 RBAC 全部由该可篡改存储驱动

**证据**：`src/admin-console/src/stores/authStore.ts:23-52`

```ts
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({ accessToken: null, refreshToken: null, roleKey: null, ... permissions: [],
```
`:51` → `{ name: 'clipsync-admin-auth' }`（zustand persist 默认写 localStorage）

`src/admin-console/src/api/client.ts:52-55`：
```ts
const { accessToken } = useAuthStore.getState();
if (accessToken) config.headers.set('Authorization', `Bearer ${accessToken}`);
```
`src/admin-console/src/utils/permissions.ts:8-12`：
```ts
const { roleKey, permissions } = useAuthStore.getState();
if (roleKey === 'super_admin') return true;
if (permissions.includes('*')) return true;
```
`src/admin-console/src/router/RequireRole.tsx:23-34` 同样只读这个 store。

**失败场景**：管理台任意一处 XSS（依赖链里的 antd/echarts/axios 任一被投毒，或运营者在控制台粘贴了一段被污染的富文本），脚本 `localStorage.getItem('clipsync-admin-auth')` 即拿到**长期有效的超管 JWT**（`config/production.js:30` 默认 `24h`，dev 是 `7d`），外传后攻击者可在自己机器上直接调 `POST /api/admin/refund-reviews/:id/approve` 真打款、`DELETE /api/admin/users/:id` 删号、`PATCH /api/admin/configs/maintenance_mode` 全站停摆。`/api/admin` 挂载点（`src/server/src/index.js:554`）**没有 `csrfProtection`**，Bearer token 就是全部凭据——token 一旦离体即等于完全接管。恶意浏览器扩展同理，无需 XSS。
另一面：运营者自己在 DevTools 里把 `roleKey` 改成 `super_admin`、`permissions` 改成 `["*"]`，整个 UI（菜单、按钮、路由守卫）立刻全解锁；后端每个请求仍会 403（`adminAuth.js:93-133` fail-closed，做得对），所以不是真越权，但会造成「菜单全在、点什么都弹权限不足」的极差体验，也让「前端权限」这个东西彻底失去可信度。

**影响**：安全（S0）。管理员权限极大且含资金动作，token 明文可被任意脚本读取。

**修法**：access token 只放内存（页面刷新时用 `GET /admin/whoami` 配合 httpOnly SameSite=Strict 的会话 cookie 恢复），并给 `/api/admin` 补上 `csrfProtection`；短期最小改动是至少把 `permissions`/`roleKey` 从持久化里剔除、改为每次应用启动重新 `whoami` 拉取（顺带修掉 S2-3）。

---

### [S0-2] dev 控制台可一键（或被一个链接静默）指向生产后端并下发真实指令，无二次确认、无生产态警示、无只读保护

**证据 A —— 一键切生产，无确认**：`src/admin-console/src/components/UpstreamDevPanel/index.tsx:13-16`
```ts
const PRESETS: { label: string; value: string }[] = [
  { label: '生产', value: 'https://api.clipchain.top' },
```
`:27-41` `apply()` 内直接 `setUpstream(value); window.location.reload();` —— 没有 `Modal.confirm`，没有输入确认，没有「你即将操作生产环境」提示。

**证据 B —— 一个 URL 参数即可静默接管**：`src/admin-console/src/api/upstream.ts:70-86`
```ts
export function adoptUpstreamFromQuery(): void {
  if (!upstreamEditable || typeof window === 'undefined') return;
  const raw = url.searchParams.get('api'); ...
  localStorage.setItem(STORAGE_KEY, next);
  if (next !== previous) window.location.reload();
```
`main.tsx:15` 在应用启动最早期无条件调用它，且 `:75-76` **把 `?api=` 从地址栏抹掉**——运营者事后连自己是怎么被切走的都看不到。

**证据 C —— vite proxy 重写 Origin 让生产 CORS 白名单放行**：`src/admin-console/vite.config.ts:18-20` + `:83-88`
```ts
const UPSTREAM_FRONTEND_ORIGIN: Record<string, string> = {
  'https://api.clipchain.top': 'https://admin.clipchain.top',
};
...
if (origin) proxyReq.setHeader('origin', origin);
```
配合 `src/server/src/index.js:117-126` 的生产 CORS 白名单校验，本地页面因此获得与部署版管理台**完全相同的 Origin 身份**。

**证据 D —— dev server 对全网段开放且转发目标由请求头决定**：`vite.config.ts:51` `host: true`；`:72-81`
```ts
const raw = ... req.headers[UPSTREAM_HEADER];
const upstream = raw && ORIGIN_ONLY.test(raw.trim()) ? raw.trim() : '';
if (!upstream) return send(req, res, options);
return send(req, res, { ...options, target: upstream });
```
`ORIGIN_ONLY = /^https?:\/\/[^\s/?#@]+$/i`（`:12`）只挡路径与凭据，**不挡内网地址**：`http://169.254.169.254`、`http://127.0.0.1:6379`、`http://10.x.y.z` 全部合法。

**失败场景**：
1. 运营者本地跑 `npm run dev`，为了看真实数据点一下右下角面板的「生产」→ 页面刷新 → 从此**每一次点击都作用于生产库**。他随后在退款审核页点「通过」（`refund-review/index.tsx:202-205` → `POST /admin/refund-reviews/:id/approve`），那一刻**真的调支付宝把钱打出去了**，而页面上唯一表明「这是生产」的地方是右下角一行 12px 灰字。误操作资金不可撤销。
2. 攻击者在 issue / 群里丢一条 `http://localhost:5273/?api=https://evil.tld`。运营者点开 → 静默写入 localStorage → 整页重载 → 他看到的是**外观完全正常的管理台**，登录框照常。他输入管理员手机号/密码 → 凭据直送攻击者服务器；攻击者返回一个伪造 token + 伪造 `whoami{roleKey:'super_admin',permissions:['*']}` → 运营者进入一个**全部由攻击者编排数据的假后台**，可以在上面「审核退款」「封号」而毫无察觉。
3. 同网段任意主机（咖啡馆 WiFi、被入侵的同事机器）向 `开发者IP:5273/api/...` 发一个带 `X-ClipSync-Upstream` 的请求，就把开发机当成**无鉴权 SSRF 跳板**：既可探测内网/云元数据，也可指定 `https://api.clipchain.top` 从而以生产信任的 Origin 打生产 API。

**影响**：安全 + 资金 + 数据（S0）。

**关于 `903429c` 的声明「能改地址只在测试环境存在」——生产侧核实通过**：`upstreamEditable = import.meta.env.DEV`（`upstream.ts:21`）使 `getUpstream()` 恒返回 `''`、`upstreamHeaders()` 恒返回 `{}`、`adoptUpstreamFromQuery()` 直接 return；`App.tsx:17` 用字面量 `import.meta.env.DEV` 判定，Rollup 能把整个面板从 bundle 摇掉；proxy 的 `configure()` 只存在于 `server` 段，线上是 nginx 反代。**生产构建确实没有这个入口。** S0 指的是 dev→生产这座桥本身没有任何护栏，而非生产 bundle 有问题。

**修法**：切到非本地地址时强制 `Modal.confirm` + 输入目标域名确认，并在 Header 挂一条不可忽略的红色「生产环境」横幅；对生产 upstream 默认只读（拦截所有非 GET）；`adoptUpstreamFromQuery` 只接受白名单域且保留地址栏参数；`host: true` 改回默认或给 proxy 的 header 通道加本机限定 + 拒绝私网/链路本地地址段。

---

### [S1-1] 绑定 2FA 的管理员无法用密码登录管理台；登录页的两步验证码输入框与「30 秒刷新」按钮是纯装饰

**证据**：后端 `src/server/src/routes/auth.js:1223-1230`
```js
if (user.two_factor_enabled) {
  const challengeToken = jwt.sign({ userId: user.id, twoFactorChallenge: true }, ...);
  return res.json({ twoFactorRequired: true, challengeToken });
}
```
（HTTP **200**，响应体里**没有 `token`**）

前端 `src/admin-console/src/api/auth.ts:46-50`
```ts
const real = await apiPost<RealLoginResp>('/auth/login', {
  ...splitAccount(payload.account), password: payload.password,
});
return finalizeSession(real, payload.account.trim());
```
`RealLoginResp`（`:14-18`）只声明 `{token, sessionId?, user?}`，**完全没有 `twoFactorRequired` 分支**；`auth.ts:11` 的注释直言「TOTP：…本层暂不传（字段保留在表单）」。

`src/admin-console/src/pages/login/index.tsx:141-144` 把含 `totp` 的整个 `values` 交给 `loginByPassword`，而 `loginByPassword` 只解构 `account`/`password` → **运营者输入的 6 位动态码被静默丢弃**。
`:175` 还有一个没有任何 `onClick` 的按钮：
```tsx
<Button className={styles.otpBtn} icon={<ClockCircleOutlined />} title="30 秒刷新" />
```

**失败场景**：运营者开了 2FA，切到「密码登录」，输入账号、密码、TOTP 动态码，点登录。`finalizeSession` 拿着 `real.token === undefined` 去调 `GET /admin/whoami`，请求头成 `Authorization: Bearer undefined` → 401 → `client.ts:124-135` 尝试刷新（`refreshToken` 为 null，立即失败）→ `redirectToLogin()` 执行 `window.location.replace('/login')`。运营者看到的是**页面闪一下回到登录页 + 一句「登录已过期，请重新登录」**，完全不知道自己是被 2FA 挡住的，也不知道该怎么做。反复重试都是同样结果。
更糟的组合：`force_2fa_for_admin` 开关（`configs.js:331`，设置页可开）打开后，`auth.js:1258-1260` 会对**未绑定** 2FA 的管理角色直接 403。于是开关一开：没绑 2FA 的管理员被 403 拦在门外，绑了 2FA 的管理员被本条 bug 拦在门外——**密码登录这条路对所有人都不通**，只剩短信验证码和桌面端 SSO。

**影响**：可用性 + 安全（S1）。安全控制形同虚设（表单收了 TOTP 却从不发送），同时把合法管理员锁在门外。

**修法**：`loginByPassword` 判 `twoFactorRequired`，拿 `challengeToken` 走两步验证校验端点（桌面端已有该链路），把表单里的 `totp` 真正传上去；未实现前先把 TOTP 输入框和那个死按钮摘掉，别摆着一个不工作的安全控件。

---

### [S1-2] 审计日志「操作者」筛选把 mock 人名 Carlos / Yuki 固化进了 TS 契约类型，生产环境该筛选恒返回空

**证据**：`src/admin-console/src/api/types.ts:693-694`
```ts
/** 审计操作者筛选项：end_user=终端用户（operatorRole=user，含打码手机号） */
export type AuditOperatorFilter = 'all' | 'Carlos' | 'Yuki' | 'end_user';
```
`src/admin-console/src/pages/audit/index.tsx:51-56`
```ts
const OPERATOR_OPTIONS: { value: AuditOperatorFilter; label: string }[] = [
  { value: 'all', label: '操作者：全部' },
  { value: 'Carlos', label: 'Carlos（超管）' },
  { value: 'Yuki', label: 'Yuki（管理员）' },
  { value: 'end_user', label: '终端用户' },
];
```
后端 `src/server/src/routes/admin/audit.js:205-207`
```js
// 具体操作者：昵称精确匹配（如 Carlos / Yuki）
params.push(String(operator));
where.push(`u.nickname = $${params.length}`);
```
（mock 人名连后端注释都渗进去了）

**失败场景**：生产环境发生一笔可疑退款，运营者打开审计日志想查「超管 X 今天做了什么」。他展开「操作者」下拉，看到的是 **Carlos（超管）/ Yuki（管理员）** 两个根本不存在的人。选 Carlos → 后端 `u.nickname = 'Carlos'` → 0 行 → 表格显示空态。他会得出「今天没有超管操作」的**错误结论**。而下拉里没有任何入口能填真实昵称，`AuditLogListParams` 也没有暴露后端支持的 `q` 全文搜索（`audit.js:172` 支持，前端 `types.ts:193-202` 没有该字段）——**按操作者追责这条路在整个管理台里是不通的**。

**影响**：可用性 + 运营效率 + 安全审计能力（S1）。「谁在什么时候改了什么」是审计页的核心用途，按人筛选是其中最高频的动作。

**修法**：把 `operator` 改成自由文本输入（后端已是昵称精确匹配，或顺手加 ILIKE 模糊匹配），同时暴露后端的 `q` 参数；从类型里删掉 Carlos/Yuki。

---

### [S1-3] MSW 红色横幅声称「未连接真实后端」，而 14 个端点（含整个退款审核域）正静默穿透到真实后端

**证据**：`src/admin-console/src/main.tsx:33-42`
```ts
if (!mockInterceptsApi()) return;
const { worker } = await import('@/mocks/browser');
await worker.start({ onUnhandledRequest: 'bypass' });
// AF-54：MSW 模式可见化——防止假数据被误当真实后端
tag.textContent = 'MOCK 数据 · 未连接真实后端';
```
`src/admin-console/src/mocks/handlers.ts:1439-1455` 的 `handlers` 聚合里**没有** `refundReviewsHandlers`、`refundSettingsHandlers`、`emailChannelsHandlers`，也没有用户 `approve`/`force-logout`/`DELETE`/`export`、`sso-exchange`、`ops/backups/download`。

**失败场景**：新克隆仓库的开发者 `npm run dev`（无 `.env.development.local`，`VITE_ENABLE_MSW` 未定义 → `mockInterceptsApi()` 为 true）。左下角出现红色「MOCK 数据 · 未连接真实后端」，用户/订单/审计全是种子数据，他合理地认为整个后台都是假的。然后他点进「退款审核」——**这一页的 5 个端点一个 handler 都没有**，请求全部 bypass 到 vite proxy → `http://127.0.0.1:3001` 的真实后端。于是同一块屏幕上：横幅说「未连接真实后端」，而退款审核列表显示的是真实数据库里的真实待审申请。
- 若本地库是生产快照、且本地 `.env` 带着生产支付宝密钥（`3af1695` 已把 `ALIPAY_*` 注入段入仓），他点「通过」就是**一笔真实打款**。
- 若本地后端没起，请求失败 → 拦截器 toast → 表格空态 → 他得出「没有待审退款」的结论，而生产上可能正积压着用户的退款申请（用户权益在申请时已被收回，等审期间是没有套餐的）。
系统设置页的「邮件通道」整卡、用户抽屉的「强制下线 / 删除账户 / 导出数据」同理：横幅说假数据，实际打真后端。

**影响**：产品诚信 + 资金 + 数据（S1）。不是「假数据被当真实」，而是**「真实数据被横幅宣称为假」**——同样会让运营者做出错误决策，且方向更危险（他以为在沙盘里演练，实际在生产上动刀）。

**修法**：`onUnhandledRequest` 改为 `'error'` 或 `'warn'` 并把未拦截的 URL 汇总上报；横幅文案改为「MOCK 模式 · 未拦截的请求会直连 <proxy target>」并列出本域未 mock 的端点；或者干脆把退款审核/邮件通道/用户危险操作的 handler 补齐，让 mock 模式真的是全 mock。

---

### [S1-4] 版本发布「发布 / 撤回」一键即对全部客户端生效，无二次确认、无原因、无「即将发布什么」的复核

**证据**：`src/admin-console/src/pages/releases/index.tsx:248-254`
```ts
/** 发布/撤回（回滚）：切 is_published，客户端 60s 缓存内生效 */
const togglePublish = (release: AppRelease) => {
  patchMutation.mutate({ id: release.id, patch: { is_published: !release.isPublished } });
};
```
`:284-286`
```tsx
<Button type="link" size="small" onClick={() => togglePublish(record)}>
  {record.isPublished ? '撤回' : '发布'}
</Button>
```
同页的**删除**却老老实实走了 `ConfirmReasonModal`（`:375-385`，原因必填写审计）。发布/撤回既没有确认弹窗、没有原因字段、也不展示将要发布的版本号/平台/下载地址/灰度比例/是否强制更新，按钮在 `patchMutation.isPending` 期间也不禁用。

**失败场景**：运营者在版本列表里想点某一行的「编辑」核对一下下载地址，鼠标错位点到相邻的「发布」→ **一次点击就把一个还没核对过的草稿版本推给全部客户端**（`is_published=true`，客户端 60s 内开始提示更新；若该草稿的 `force_update` 为 true，则是强制更新，用户不升不能用）。下载地址写错（`platforms` 是自由文本 JSON，前端只校验「是合法 JSON 对象」，`:349-364`，**不校验 url 是否为合法 https 地址**）→ 全量客户端更新失败。反向也一样：想点「编辑」误点「撤回」→ 线上版本立刻从更新端点消失。事后审计日志里只有一条 `admin.release.update`，**没有原因**，无法回答「当时为什么发的/为什么撤的」。

**影响**：可用性 + 运营效率（S1）。这是管理台里爆炸半径最大的动作之一（推二进制到每一个客户端），却是防护最薄的一个。

**修法**：发布/撤回统一走 `ConfirmReasonModal`，正文列出 `version / 平台 target / 下载地址 / rollout / force_update / 当前状态 → 目标状态`，原因写入审计；`force_update=true` 或 `rollout=100` 时追加输入版本号确认；`platforms[].url` 加 https URL 校验。

---

### [S2-1] 全站时间显示时区不一致：审计/用户/设备/会话/看板显示 UTC，订单/退款审核显示本地时间，两套都无时区标注，同一事件跨页差 8 小时

**证据**：见上文「时间戳格式」表。前端格式化统一走 `src/admin-console/src/utils/format.ts:18-22`
```ts
export function fmtTime(input?: string | null): string {
  if (!input) return '—';
  const d = dayjs(input);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : input;
}
```
`dayjs('2026-09-22 03:15:44')`（无时区标记）被当本地时间；`dayjs('2026-09-22T03:15:44.000Z')` 被转成本地时间。前者原样显示 UTC 挂钟值，后者正确 +8。

最刺眼的两处：
- `src/admin-console/src/pages/audit/index.tsx:148-150` → `dayjs(value).format('MM-DD HH:mm:ss')`，`value` 来自 `audit.js:106` 的 UTC 裸串。
- `src/admin-console/src/pages/audit/AuditDetailModal.tsx:45` → `{log.createdAt}` **完全不格式化**，UTC 裸串原样进详情弹窗和 CSV 导出（`auditCsv.ts:23`）。
- `src/admin-console/src/pages/security/index.tsx:100,106` → 登录时间/最近活跃同样原样渲染 `sessions.js:43` 的 UTC 裸串。
- `src/admin-console/src/pages/policies/index.tsx:153` → `updatedAt.replace('T',' ').slice(0,19)` 手撕 ISO 串。
- `src/admin-console/src/pages/settings/index.tsx:797` → `item.sentAt.slice(5,10)` 直接切字符串取「MM-DD」，跨零点时日期还会错一天。

**失败场景**：用户在 11:15（北京时间）付款后没拿到权益，来投诉。运营者去订单页查，看到「支付时间 11:15」——正确。再去审计页查同一时刻的履约日志，看到「03:15」——他以为这是**另一件事**（8 小时前的凌晨操作），或者以为审计日志时钟坏了，于是一路排查错方向。退款审核场景更敏感：`requestedAt`（ISO Z，显示本地）与紧邻的审计记录（UTC）在同一屏里差 8 小时，运营者无法判断「申请」与「审核动作」的先后顺序，而先后顺序正是判断该不该打款的依据。

**影响**：可用性 + 运营效率 + 间接资金决策（S2）。任务书把「时区错」列为运营误判来源，此处完全命中，且是**系统性**的（10 个后端文件 vs 3 个）。

**修法**：后端全部统一为带 `Z` 的 ISO 8601（把 `toISOString().replace('T',' ').slice()` 一律换成 `toISOString()`），前端只在展示层用 `fmtTime` 转本地；过渡期至少在所有时间列头/详情里标注「(UTC)」或「(本地)」。

---

### [S2-2] 401 无可用续期链路（refreshToken 恒为 null），token 过期时整页 `location.replace` 到登录页，正在填写的表单内容全丢；全站无任何未保存提示

**证据**：`src/admin-console/src/api/auth.ts:30-38`
```ts
return {
  accessToken: real.token,
  refreshToken: null,          // ← 硬编码
```
（后端 `auth.js:1263-1278` 的 `/auth/login` 响应确实不含 refreshToken，所以前端也拿不到）

`src/admin-console/src/api/client.ts:67-69`
```ts
async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return null;      // ← 恒走这里
```
`:85-90` + `:134`
```ts
function redirectToLogin(): void {
  useAuthStore.getState().clearAuth();
  if (window.location.pathname !== '/login') window.location.replace('/login');
}
```
`src/admin-console/src/stores/authStore.ts:20-21` 的注释是**错的**：「由 client.ts 在 401 时用 refreshToken 单次续期」——该路径永不可达。`src/admin-console/src/api/auth.ts:68` 导出的 `refresh()` 全仓无人 import（死代码）。

`src/admin-console/src/layouts/AdminLayout.tsx:189-194` 每 60 秒轮询一次看板：
```ts
const { data: overview } = useQuery({ queryKey: queryKeys.overview(), queryFn: getOverview, refetchInterval: 60_000, ... });
```
全站 `grep beforeunload|useBlocker|Prompt` = **0 命中**。

**失败场景**：生产 JWT 有效期 24h（`config/production.js:30`）。运营者早上登录，晚上回来接着处理退款。他在退款审核页填了 200 字的驳回理由、或者在系统设置页改了 5 个参数正准备点保存——此时 AdminLayout 的 60s 轮询撞上过期 token → 401 → 刷新失败 → `window.location.replace('/login')` → **整页重载，填的内容一个字不剩，而且没有任何预警**。他甚至不知道自己是被登出的，只看到登录页和一句「登录已过期」。重新登录后刚才那笔驳回要重新找、重新填。
同理，`settings/index.tsx` 的配置表单、`plans` 的套餐编辑弹窗、`policies` 的策略草稿、`roles` 的权限勾选（切个角色就丢，`roles/index.tsx:71-73`）、`audit` 的筛选草稿，全部没有离开保护。

**影响**：可用性 + 运营效率（S2，涉及金钱操作的重复劳动时接近 S1）。

**修法**：让 `/auth/login` 与 `/auth/sso-exchange` 下发 refreshToken 并在 `RealLoginResp` 里接住，把已有的续期逻辑真正接通；同时在 `AdminLayout` 挂 `beforeunload`、在含 dirty 表单的页面挂 `useBlocker`。

---

### [S2-3] 权限只在登录瞬间 `whoami` 一次并持久化，此后永不复校 → 后端撤权后前端按钮长期显示可用

**证据**：`whoami` 的调用点全仓只有 `src/admin-console/src/api/auth.ts:27`（在 `finalizeSession` 内，仅登录/SSO 时执行一次）。应用启动路径 `main.tsx` → `App.tsx` → `router/index.tsx` 无任何权限重新拉取。权限随 `persist` 落进 localStorage（`authStore.ts:32-40`），刷新页面直接复用旧值。

**失败场景**：某运营者离职或转岗，超管在「角色权限」页把他所属自定义角色的 `admin.orders.refund` 取消勾选并保存（`roles.js:355` 会 `clearPermCache()`，后端最迟 60s 内生效）。但该运营者已打开的管理台页面（以及他之后每一次刷新，只要不重新登录）里，`hasPerm('admin.orders.refund')` 仍然返回 true，订单页的「退款」按钮、退款审核页的「通过 / 驳回」按钮**照常是亮的**。他点下去 → 后端 403 → 拦截器 toast「没有执行该操作的权限」。他会以为系统坏了并反复重试；更麻烦的是他可能已经对着这笔退款做了别的动作（比如先给用户打了电话说「马上退」）。
反过来也一样：给他**新增**权限后，他不重新登录就永远看不到新按钮。

**影响**：可用性 + 运营效率 + 权限治理可信度（S2）。后端 fail-closed 做得对，所以不是安全漏洞。

**修法**：应用启动时（以及每 N 分钟 / 每次路由切换）调一次 `GET /admin/whoami` 覆盖 store 里的 `roleKey`/`permissions`；顺带把权限从 persist 里剔除（与 S0-1 同一改动）。

---

### [S2-4] 系统设置页「功能开关」的 Switch 未按 `admin.configs.manage` 裁剪（同页其他所有写控件都裁了）

**证据**：`src/admin-console/src/pages/settings/index.tsx:673-677`
```tsx
<Switch
  checked={flag.enabled}
  loading={flagMutation.isPending && flagMutation.variables?.key === flag.key}
  onChange={(enabled) => flagMutation.mutate({ key: flag.key, enabled })}
/>
```
没有 `disabled`。对照同文件里其他写控件：维护模式 `:688` `disabled={!maintenanceConfig || maintenanceMutation.isPending || !canManageConfigs}`；邮件通道开关 `:869` `disabled={!canManageChannels}`；参数保存按钮 `:966` `disabled={!canManageConfigs}`；公告发送 `:785` `disabled={!canSendAnnouncement}`。变量 `canManageConfigs` 在 `:202` 已就绪，只是开关这一处漏用。
路由守卫只要求 `['admin.configs.view','admin.announce.send']` 任一（`router/index.tsx:161`），后端 PATCH 要求 `admin.configs.manage`（`configs.js` flagsRouter.patch）。

**失败场景**：给客服配一个只有 `admin.configs.view` 的自定义角色，让他进设置页看当前开关状态。他看到「注册总开关」是**可点**的，顺手关掉想试试——`:236-239` 的乐观更新立刻把开关拨到 off，页面看起来「已经关掉了」；随后 403 回来，`:242` 回滚并 toast「开关切换失败，已回滚」。在那一两秒里他看到的是「注册已被我关闭」，如果此时他截图或转身去告知别人，就传播了一个错误状态。这类开关（`enable_signup` / `enable_subscription` / `signup_waitlist`）都是全站级影响，UI 上给出「可操作」的假象本身就有风险。

**影响**：可用性 + 权限一致性（S2）。后端拦住了，不是越权。

**修法**：给该 Switch 补 `disabled={!canManageConfigs}`，与同页其余控件对齐。

---

### [S2-5] 后端专门为「开关改了不生效」下发的 `enforced` 字段被前端类型与页面完全丢弃

**证据**：后端 `src/server/src/routes/admin/configs.js:661-663`
```js
enabled: row ? Boolean(row.enabled) : false,
// AN-10：是否存在服务端强制点（ENFORCED_FLAG_KEYS 静态清单，防 AF-04 复发）
enforced: isFlagEnforced(meta.key),
```
文件头 `:19-21` 把它写进契约：「FeatureFlag: { key, name, description, enabled, enforced }…false = UI 有开关但改了不生效（AF-04 告警口径）」。`src/server/src/utils/featureFlags.js:67-75` 甚至为此实现了**启动时扫描源码自动发现强制点**，注释写明是为了「漏登则 enforced 静默失真」这个结构性隐患归零。

前端 `src/admin-console/src/api/types.ts:264-269`
```ts
export interface FeatureFlag {
  key: string; name: string; description: string; enabled: boolean;
}
```
无 `enforced`。`src/admin-console/src/mocks/data.ts:967-986` 的 `mockFlags` 同样没有。设置页 `settings/index.tsx:643-680` 渲染开关时只用了一份**前端硬编码**的 `FLAG_META`（`:87-116`）来显示生效范围/生效方式，且该表只覆盖 6 个开关——后端 `FLAG_CATALOG` 有 **7** 个（第 7 个是 `force_2fa_for_admin`，`configs.js:330-334`），所以「强制管理员两步验证」这一行连范围说明的 ⓘ 图标都没有。

**失败场景**：后端为了防「UI 有开关但改了不生效」专门造了一套自扫描机制并把结论下发到前端，前端把它扔了。将来某个开关的服务端强制点被重构掉（`enforced` 变 false），管理台上它照样是一个看起来完全正常、切换后还 toast「开关已切换并写入审计日志」（`:246`）的开关，运营者以为功能已被关闭，实际上服务端根本没有拦截点——**这正是 AF-04 的复发路径，而防线只修了后端一半**。对比：配置项那侧的同类机制（AN-09 `consumer`）前端是接了的，`settings/index.tsx:604-609` 会打红色「未接入」角标，`:588` 还做了汇总计数。同一个设计，两半实现。

**影响**：产品诚信 + 可用性（S2）。

**修法**：`FeatureFlag` 补 `enforced: boolean`，mock 同步；设置页对 `enforced === false` 的开关打红色「无服务端强制点 · 改了不生效」角标（复用 `consumer` 那套视觉），并把 `FLAG_META` 缺的 `force_2fa_for_admin` 补上。

---

### [S2-6] 订单页时间范围只有「近 7 天 / 近 30 天」，没有「全部」，且 `dateFrom` 与订单号搜索是 AND → 查历史订单恒查不到

**证据**：`src/admin-console/src/pages/orders/index.tsx:35-40` + `:65-74`
```ts
const DEFAULT_FILTERS: OrderFilters = { q: undefined, status: 'all', channel: 'all', range: '7d' };
const RANGE_OPTIONS: { value: '7d' | '30d'; label: string }[] = [
  { value: '7d', label: '时间：近 7 天' },
  { value: '30d', label: '时间：近 30 天' },
];
```
`rangeToDateFrom` 的 `return undefined` 分支（`:73`）在 UI 上**不可达**——没有「全部」选项。
后端 `src/server/src/routes/admin/orders.js:163-180`：`dateFrom` 与 `q` 都 push 进同一个 `where` 数组，最终 `where.join(' AND ')`。

**失败场景**：用户投诉三个月前的一笔订单。运营者到订单页，把订单号完整粘进搜索框，回车。`dateFrom` 仍是默认的 7 天前 → SQL 变成 `created_at >= (今天-7天) AND order_no ILIKE '%...%'` → **0 行**，表格空态。他换成「近 30 天」，还是 0 行。页面上没有任何提示说「当前受时间范围限制」，也没有更宽的选项。他于是回复用户「系统里没有这笔订单」——而订单就在库里，钱也真收过。若这笔订单随后涉及退款争议，这个误判会直接导致拒退或错误对账。
同一问题还会让看板的待办跳转失效：`overview.js:233,253` 把待办的 `actionTo` 设成 `/orders?status=refunding` 与 `/orders?status=pending`，运营者点「查看订单」进来后仍被 7 天窗口卡住，超期的待处理订单看不见。

**影响**：可用性 + 资金对账准确性（S2，接近 S1）。

**修法**：`RANGE_OPTIONS` 增加「全部时间」，选中时不发 `dateFrom`；或当 `q`（订单号/流水号）非空时自动解除时间限制并在 UI 上说明。

---

### [S2-7] `PaymentChannel` 类型缺 `'unknown'`，后端会返回它 → 订单列表与详情的「渠道」列渲染空白，且该桶无法筛选

**证据**：前端 `src/admin-console/src/api/types.ts:117`
```ts
export type PaymentChannel = 'wechat' | 'alipay' | 'stripe';
```
`src/admin-console/src/components/StatusTag/mappers.ts:83-87`
```ts
export const channelLabel: Record<'wechat' | 'alipay' | 'stripe', string> = { ... };
```
后端 `src/server/src/routes/admin/orders.js:45-52`
```js
const CHANNEL_CASE_SQL = `
  CASE ... ELSE 'unknown' END`;
```
`:43-44` 注释说明动机：「§4-A4：识别不出渠道（mock/空值等）归入 'unknown' —— 项目**根本没有微信渠道**，把认不出的单算成 wechat 会让对账/看板/占比三处一起虚高（宁可显式未知，不可造假）」。对账接口已单独输出该行（`:407-408`）。
前端消费点：`orders/index.tsx:190` `channelLabel[value]`、`OrderDetailModal/index.tsx:106` `channelLabel[data.channel]` → `undefined` → 单元格空白。筛选器 `orders/index.tsx:58-63` 也只有 4 项，无 `unknown`。

**失败场景**：库里存在 `payment_channel` 为空的历史单（后端注释明确说这类单存在）。订单列表里这些行的「渠道」列**什么都不显示**（不是「未知」，是空白），运营者以为是前端渲染 bug 或数据缺失。渠道筛选里也选不到它们，只能靠肉眼在全部订单里翻。更矛盾的是：同一笔单打开「对账报告」弹窗，它会正确地出现在「未识别渠道」那一行并带金额——**同一份数据在同一个页面的两个位置，一处如实展示、一处静默丢失**。而「未识别渠道的订单」恰恰是最需要人工核账的一批（可能是渠道字段写坏的真实收款）。

**影响**：可用性 + 对账完整性（S2）。TS 类型在这里是「骗人的类型」：它声明了一个后端不会遵守的闭集，导致编译器无法提醒到这个缺口。

**修法**：`PaymentChannel` 增加 `'unknown'`，`channelLabel` 补「未识别」，渠道筛选器补该选项。

---

### [S2-8] 多键配置保存是「逐键串行 PATCH」且无 catch → 部分键已落库但只报一句错，运营者不知道哪些生效了

**证据**：`src/admin-console/src/pages/settings/index.tsx:478-499`
```ts
const saveConfigGroup = async (form, setSaving, keys?) => {
  ...
  setSaving(true);
  try {
    for (const [key, value] of changed) {
      await patchConfig(key, String(value));
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.configs() });
    void message.success(`已保存 ${changed.length} 项参数，变更记入审计日志`);
  } finally { setSaving(false); }
};
```
`try` 有 `finally` 但**没有 `catch`**；调用点是 `:967-972` 的 `void saveConfigGroup(...)` → 异常成为未处理的 Promise rejection。同样模式：`src/admin-console/src/pages/ai/index.tsx:149-166`（`saveParams`，2 键）与 `:117-138`（`saveSearch`，3 键）；`src/admin-console/src/pages/orders/index.tsx:160-169`（`handleExport`）。
对照做得对的：`src/admin-console/src/pages/policies/index.tsx:125-132` 用了 `mutateAsync` + 单次 PATCH（后端合并写入，天然原子）。

**失败场景**：运营者在「限流配置」卡里同时改了 `rate_limit_api_per_min` 和 `rate_limit_send_code_per_hour`，点保存。第一个 PATCH 成功（已写库、已写审计、已热生效），第二个因为某种原因 400/500（例如后端 `configs.js:436-438` 的生产环境禁止关闭限流规则命中）。他看到：一句拦截器 toast（比如「请求参数错误」），**没有成功提示**，弹窗/表单保持原样。他无法知道第一个已经生效了。若他据此「重试保存」，第一个键会被再写一次（幂等，无害）；若他据此认为「都没保存上」并放弃，那么系统就处在一个他以为不存在的**半配置状态**——限流阈值改了一半。这在事故处置时（比如正在被刷短信，急着调 `rate_limit_send_code_per_hour`）会造成真实误判。
`ai/index.tsx:117-138` 的 `saveSearch` 更明显：3 个键（provider / apiKey / baseUrl）分别 PATCH，第 2 个失败时第 1 个已改，结果是「搜索源已切到 searxng 但地址还是旧的」这种自相矛盾的配置。

**影响**：数据一致性 + 运营效率（S2）。

**修法**：给后端加一个批量 `PATCH /admin/configs`（一次事务写多键、一条审计含全部前后值），前端改单次调用；过渡期至少在 catch 里明确报「已成功 N 项 / 失败于第 M 项 `<key>`」并强制刷新表单。

---

### [S2-9] 套餐页与版本页的 `handleSave` 用 `mutate` 而非 `mutateAsync`，`try/finally` 立刻把 `saving` 置回 false → `confirmLoading` 永不生效，保存按钮提交中可连点

**证据**：`src/admin-console/src/pages/plans/index.tsx:219-233`
```ts
setSaving(true);
try {
  patchMutation.mutate({ id: editing.id, patch });   // ← 不 await
} finally {
  setSaving(false);                                   // ← 同步立刻执行
}
```
`:272` `confirmLoading={saving}`。同样：`src/admin-console/src/pages/releases/index.tsx:217-245`（`createMutation.mutate` / `patchMutation.mutate`）+ `:308` `confirmLoading={saving}`。
对照做得对的：`RefundModal/index.tsx:73-88`、`ConfirmReasonModal/index.tsx:43-53`、`GrantSubscriptionModal.tsx:56-66` 都是 `await onConfirm(...)` 包在 `setSubmitting(true)` / `finally setSubmitting(false)` 里，`okButtonProps.loading` 真正生效。

**失败场景**：运营者把 Pro 月价从 19 改成 29，点「保存」。网络稍慢（或后端 `plans.js` 的审计写入耗时），按钮**没有任何 loading 反馈**，他以为没点上，再点两下 → 三个 `PATCH /admin/plans/:id` 并发出去。对价格这种幂等写，最终值一样，但会落**三条 `admin.plans.update` 审计**，事后查「谁在什么时候改的价」会看到三条重复记录、无法判断是误操作还是三次真实调价。新建版本时更糟：连点两次 `POST /admin/releases` → 第二次撞版本号唯一约束 409 → 弹一句「该版本号已存在」，运营者以为版本没建成功。

**影响**：可用性 + 审计可读性（S2）。注意这**不是**退款重复提交问题——退款/驳回/赠期/下线/删除全部走 `ConfirmReasonModal` 或 `RefundModal`，那两处的 `submitting` 门闩是正确的，且后端另有幂等（`refundReviews.js:53-55` CAS + 支付宝 `out_request_no`）。

**修法**：两处改成 `await patchMutation.mutateAsync(...)`，或直接把 `confirmLoading` 绑到 `patchMutation.isPending` / `createMutation.isPending`。

---

### [S2-10] 改套餐价格/配额、群发公告：无二次确认、无原因、无「当前值 → 新值」对比；且配置与套餐的审计只记新值不记旧值

**证据**：
- 套餐：`src/admin-console/src/pages/plans/index.tsx:267-345` 是一个普通编辑 Modal，`okText="保存"`，点下即 `PATCH`。没有 `ConfirmReasonModal`、没有 reason 字段（`api/plans.ts:22-24` 的 `PlanPatchPayload` 不含 reason）、没有「¥19 → ¥29，将影响所有新订单」这样的对比确认。`is_active` 停用开关（`:341-343`）同样一键即改，无「该套餐下有 N 个存量订阅」的提示。价格 `InputNumber min={0}`（`:288,291`）→ **可以把付费套餐价格改成 0**，无任何警告。
- 公告：`settings/index.tsx:750-756` `onFinish={(values) => announceMutation.mutate(values)}` —— 表单提交即群发，无确认弹窗、无受众人数预估。而后端 `announcements.js:139` 会算出 `deliveredCount = await countAudience(audience)`（受众人数），前端**发送前拿不到这个数字**，发送后才在「最近发送」里看到（`:795-803`）。
- 审计只有新值：`configs.js:497-504` `details: reason ? { value: auditValue, reason } : { value: auditValue }`；`plans.js:210-215` `details: { planName, changes }`，`changes[field] = result.value`（新值）。**两处都没有旧值。** 唯一做对的是 `roles.js:334-338`（`details: { role, added, removed }`）和 `refundSettings.js:114-122`。
- 常规配置改动不带 reason：`settings/index.tsx:492` `await patchConfig(key, String(value))` —— 只有维护模式（`:1022-1027`）、AI 参数（`ai/index.tsx:155,158`）、客户端策略（`policies/index.tsx:263`）走了 `ConfirmReasonModal` 收集原因。后端 `configs.js:426-431` 也只对 `maintenance_mode` 强制 reason。

**失败场景**：
1. 运营者想把 Pro 年价从 199 改成 299，在弹窗里改完直接点保存 → 立即对全站生效（`plans.js` 写库即生效，客户端下次拉套餐就是新价）。事后发现改错了（本想改月价），去审计日志看，只看到 `changes={price_yearly:299}`，**看不到原来是多少**，无法确认这次误改的实际影响面，也无法一键回滚。
2. 运营者写了一条公告，受众选「全部用户」，点「发送公告」→ 立刻推给全站（`announcements.js:180-190` WS 广播）。没有「即将发送给 12,847 名用户，确认？」这一道闸。手滑或错别字在标题里就已经发出去了，而公告**没有撤回入口**（前端只有下发和历史列表，`api/configs.ts:33-40`）。
3. 有人把 `rate_limit_send_code_per_hour` 从 5 改成 500（`InputNumber min={1}` 只挡 0，不挡过大值），短信费用随后暴涨；审计里只有 `value=500`，看不出原来是 5，也看不出为什么改。

**影响**：资金 + 数据 + 运营效率（S2）。任务书第 5 条点名的四类防护（二次确认 / 原因 / 前后值对比 / 不可逆警告），套餐与公告这两处基本都缺。

**修法**：套餐保存与公告发送统一走 `ConfirmReasonModal`，正文渲染逐字段「旧值 → 新值」表格；公告追加受众人数预估（后端加一个 `GET /admin/announcements/audience-count?audience=`）与「发送后不可撤回」明示；后端 `admin.config.update` / `admin.plans.update` 的审计 details 补 `previous` 字段（对齐 `roles.js` 的 added/removed 口径）；价格改 0 或降幅超阈值时要求输入套餐名确认。

---

### [S2-11] 管理员会话「强制下线」成功后不失效列表缓存 → 行还在、按钮还能点

**证据**：`src/admin-console/src/pages/security/index.tsx:46-50`
```ts
const revokeMutationLike = async (target: AdminSession, reason: string) => {
  await revokeAdminSession(target.id, { reason });
  void message.success(`已下线 ${target.nickname || target.phone} 的会话`);
  setRevokeTarget(null);
};
```
没有 `useMutation`、没有 `queryClient.invalidateQueries({ queryKey: ['admin-sessions'] })`。对照同目录其他页面：`devices/index.tsx:75`、`subscriptions/index.tsx:87`、`releases/index.tsx:141` 都做了失效。`:191` 还把 `confirmLoading={false}` 写死（实际靠 `ConfirmReasonModal` 内部 `submitting` 兜住，未爆）。

**失败场景**：发现一个异常管理员会话（比如离职同事的机器还登着），运营者点「强制下线」、填原因、确认。toast 说「已下线 X 的会话」，**但表格里那一行原封不动地留着，「强制下线」按钮还是亮的**。他会认为操作没生效，于是再点一次 → 后端 `sessions.js` 返回 404/400「会话不存在或已下线」→ 弹一句错误。此时他无法判断到底是第一次成功了还是两次都失败了——而在「有异常管理员会话在线」这个场景下，这种不确定性直接对应安全风险（他可能就此以为已处置，实际没有；或者反复重试而忽略了真正需要做的改密/撤权）。刷新页面才会看到真实状态。

**影响**：可用性 + 安全处置可靠性（S2）。

**修法**：改用 `useMutation` 并在 `onSuccess` 里 `invalidateQueries({ queryKey: ['admin-sessions'] })`；`confirmLoading` 绑到 `mutation.isPending`。

---

### [S2-12] `AdminLayout` 无条件拉 `GET /admin/configs`：自定义角色缺 `admin.configs.view` 时，每个页面都弹一次 403，且 AF-51 空闲自动登出静默失效

**证据**：`src/admin-console/src/layouts/AdminLayout.tsx:197-206`
```ts
// AF-51：管理台空闲自动登出（读 session_timeout_minutes；0/缺省 = 不启用）
const { data: configs } = useQuery({ queryKey: queryKeys.configs(), queryFn: getConfigs, staleTime: 5 * 60_000 });
const idleTimeoutMinutes = Number(configs?.find((c) => c.key === 'session_timeout_minutes')?.value ?? 0);
```
后端 `src/server/src/routes/admin/configs.js:385` `router.get('/', requirePerm('admin.configs.view'), ...)`。
`:208` `if (!Number.isFinite(idleTimeoutMinutes) || idleTimeoutMinutes <= 0) return;` → 拿不到配置时**整个空闲登出计时器直接不装**。
内置 `admin` 角色由 `049_admin_view_permissions.sql:31-36` 授予全部 `admin.%.view`，所以只有**通过角色页新建的自定义角色**会命中。

**失败场景**：超管给客服建一个自定义角色，只勾了 `admin.users.view` + `admin.users.manage`（完全合理的配置）。客服登录后：
1. 每进一个页面，`client.ts:137-142` 的拦截器都会 toast 一句「没有执行该操作的权限」——因为布局层的 configs 查询失败了。他什么也没点，页面就一直在弹权限错误，看起来像是账号有问题。
2. 更严重的：`session_timeout_minutes`（DB 默认 `'30'`，见 `038_rbac_admin_tables.sql:38`）**读不到 → 归 0 → 空闲自动登出永远不启用**。也就是说，恰恰是权限最小、最该被自动登出保护的那个账号，反而失去了这项安全控制，而且没有任何提示说明它没生效。他离开工位，管理台会一直开着。

**影响**：安全 + 可用性（S2）。安全控制静默失效是这里最坏的部分。

**修法**：把 `session_timeout_minutes` 挪进 `GET /admin/whoami` 的响应（登录态自身就该带会话策略），或给它单开一个只要求 `requireRole(50)` 的端点；`configs` 查询失败时不要静默归 0，至少落到一个保守默认值（如 30 分钟）并在 UI 上说明「读取失败，已按默认 30 分钟」。

---

### [S2-13] AI 平台页 `paramsDirty` 只计算 `ai_max_tokens`，漏了 `ai_default_provider` → 只改「AI 默认服务商」时保存按钮恒为灰，改动无法保存

**证据**：`src/admin-console/src/pages/ai/index.tsx:180-182`
```ts
const paramsDirty =
  draft.maxTokens !== null &&
  String(draft.maxTokens) !== aiConfigs.find((c) => c.key === 'ai_max_tokens')?.value;
```
而保存函数 `:149-166` 是**两个键都处理**的：
```ts
if (providerConfig && draft.defaultProvider !== providerConfig.value) {
  await patchConfig('ai_default_provider', draft.defaultProvider, reason);
}
```
按钮 `:290-300` `disabled={!canManageConfigs || !paramsDirty}`。
对照：同页 `searchDirty`（`:113-116`）正确地把 provider / apiKey / baseUrl 三项都算进去了。

**失败场景**：运营者要把 AI 兜底服务商从 `openrouter` 换成 `deepseek`（比如 openrouter 涨价或不可用）。他在下拉里选了 `deepseek`，下拉框显示的就是 deepseek，看起来已经改好了。但「保存全局参数」按钮**依然是灰的**，因为 `paramsDirty` 只看 maxTokens。页面上没有任何提示解释为什么不能保存。他可能：(a) 以为下拉选择即时生效了就离开——实际什么都没写库，AI 兜底路由仍在用 openrouter，等到用户投诉 AI 不可用才发现；或 (b) 反复点灰按钮、怀疑是权限问题（页面确实有「缺少权限」的 Tooltip 逻辑在别处），去查角色权限，白折腾一圈。唯一的绕过办法是**顺手把 maxTokens 也改一下**，让 `paramsDirty` 变 true，两个键才会一起提交——这个「诀窍」没有任何地方写着。

**影响**：可用性（S2）。一个配置项在 UI 上可改但实际改不了。

**修法**：`paramsDirty` 补上 `draft.defaultProvider !== aiConfigs.find(c => c.key === 'ai_default_provider')?.value`（照 `searchDirty` 的写法）。

---

### [S2-14] AI 供应商列表后端无 LIMIT，全量返回后前端客户端分页 → 随用户数无界增长

**证据**：后端 `src/server/src/routes/admin/aiProviders.js:77-90`
```js
router.get('/', requirePerm('admin.ai.manage'), async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.user_id, u.phone, u.nickname, ... FROM ai_providers p
     LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.updated_at DESC`);      // ← 无 LIMIT / 无分页参数
  return res.json({ code: 0, data: rows.map(mapProviderRow) });
```
前端 `src/admin-console/src/api/ai.ts:39-41` 返回 `AdminAiProvider[]`；`src/admin-console/src/pages/ai/index.tsx:391` `pagination={{ pageSize: 20, showSizeChanger: false }}` —— 纯客户端分页。
`ai_providers` 是 BYOK 表（每个用户可自带多把密钥，见 `api/ai.ts:5-6` 注释），行数随用户数线性增长。

**失败场景**：v1 上线后用户量涨到几万，其中一部分配了自己的 AI 密钥。超管打开「AI 平台」页 → 一次请求拉回全部行（每行含 user_id / nickname / 打码手机号 / provider / name / base_url / model）→ 后端全表扫描 + 全量 JSON 序列化，前端一次性 parse 并交给 antd Table。页面卡死数秒甚至浏览器标签页崩溃；同时这个端点也成了一个放大的数据出口（一次请求即拿到全体配了 AI 密钥的用户名单）。而 `client.ts:48` 的 axios `timeout: 15_000` 会在超时后直接失败，页面变成一片空白 + 一句「请求失败」。

**影响**：可用性 + 性能 + 数据暴露面（S2，随规模恶化为 S1）。

**修法**：后端加分页（`page/pageSize`，与其余列表页统一）+ `q`（按用户昵称/手机号）+ `provider`/`enabled` 筛选；前端改用 `useTableQuery`（与其他列表页同构，`hooks/useTableQuery.ts` 已就绪）。

---

### [S2-15] E2E 与「契约」单测都无法发现真实契约漂移：E2E 硬编码本机浏览器绝对路径 + 复用已存在的 dev server + 依赖非生产固定验证码；单测全部只验 MSW 自洽

**证据**：
`src/admin-console/playwright.config.ts:16-20`
```ts
launchOptions: {
  // 本机已安装 chromium-1234（npx playwright --version = 1.63），免 npx playwright install
  executablePath: 'C:\\Users\\swq\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
},
```
`:22-27` `webServer: { command: 'npm run dev', reuseExistingServer: true }`
`src/admin-console/tests/e2e/helpers.ts:12,19` → `phoneInput.fill('13505110772')` / `codeInput.fill('888888')`（固定码仅非生产可用，`src/server/src/routes/auth.js:174`）
`playwright.config.ts:3` 的注释写「默认以 MSW 模式启动 dev server」，而 `tests/e2e/smoke.spec.ts:5` 的注释写「E2E 冒烟（真实后端 + 真实登录）」——**两份注释互相矛盾**，实际跑在哪个后端完全取决于 `reuseExistingServer` 撞上的那个 dev server 的 `.env.development.local`，以及有没有人先手动起过。

单测侧：`src/mocks/handlers.test.ts`（832 行）与 `src/mocks/devicesSubscriptions.test.ts`（241 行）的 describe 名清一色是「…契约」（如 `'GET /api/admin/orders（订单页契约）'`、`'GET /api/admin/plans（套餐与价格页契约 AN-01）'`），但它们 import 的是 `@/mocks/handlers`，**打的是 MSW 假后端**。`vite.config.ts:97-100` 的 test 配置也只 include `src/**/*.test.ts`。

**失败场景**：`6ef9cec`「退款审核列表 JOIN 用错列名（u.name）→ 管理台一点就 500」正是这套测试体系的必然产物：`handlers.test.ts` 里可以有一条「GET /api/admin/refund-reviews 返回 N 行且字段齐全」的绿灯测试（如果当时写了的话），而真实后端的 SQL 是坏的。1,073 行的「契约测试」对契约漂移的检出能力为**零**——它只证明 mock 与自己一致。同理，本报告里的 S1-2（Carlos/Yuki）、S2-5（enforced 丢弃）、S2-7（channel unknown）、S2-1（时区）没有一条能被现有测试发现，因为它们全都是「前端与真实后端不一致」，而测试从不见真实后端。
另一方面 E2E 也跑不动：`executablePath` 是某个人的 Windows 用户目录，换一台机器 / 进 CI 直接找不到浏览器；`reuseExistingServer: true` 让它测的可能是任何人当前开着的那个 dev server（当前那台指向生产）；固定码 `888888` 在 `NODE_ENV=production` 下不成立（`auth.js:174` `const code = isProd ? generateCode() : '888888'`）。所以「7 个 E2E 用例」在 CI 里等价于 0 个。

**影响**：工程质量 + 回归风险（S2）。近期多个提交都在修管理台 bug，根因就在这里。

**修法**：① 删掉 `executablePath`，让 Playwright 自己管浏览器；② `reuseExistingServer: !process.env.CI`，并在 CI 里用 docker-compose 起一个确定性的非生产后端；③ 把「契约测试」改成**对真实后端跑**的集成测试（服务端已有测试体系，可在那里断言响应形状，前端只保留纯逻辑单测如 `format` / `permissions` / `upstream` / `auditDetail`）；④ 补 `fmtTime` 的时区回归用例——`utils/format.test.ts` 现有 6 个用例覆盖了 `fmtMoney`/`maskPhone`/`relativeTime`，**恰好没有 `fmtTime`**。

---

### [S3] 轻微问题（合并列出，均带锚点）

**仓库卫生**
- 3 张调试截图已入库（提交 `b840631b`）：`src/admin-console/debug-sendcode.png`（320 KB）、`verify-af23-ops.png`（74 KB）、`verify-an09-settings.png`（266 KB）。`.gitignore` 未排除 `*.png`。
- 仓库根另有 21 个 `audit-out-day2/*.png` 入库；`git ls-files` 里图片共 **128 个 / 7.4 MB**。
- 工作树里有 `clipsync_events.log` **1.16 GB**（已被 `*.log` gitignore，未入库，但占着磁盘且随时可能被误 `git add -f`）与 `tmp-desktop-build.log`。
- 仓库根躺着 5 个未跟踪的 `.docx`（支付宝授权函多版本），根 `.gitignore` 不排除 `.docx` → 一次 `git add -A` 就会把商务文件推进公开仓库。
- `src/admin-console/dist/`、`test-results/`、`.env.development.local` 均已正确 gitignore ✅。

**死控件 / 死代码**
- `pages/login/index.tsx:175` —— `<Button icon={<ClockCircleOutlined />} title="30 秒刷新" />`，无 `onClick`（见 S1-1）。
- `pages/login/index.tsx:260` —— `<span>忘记密码？</span>`，无 handler、非链接、无说明。
- `pages/dashboard/index.tsx:49` —— `<Button size="small">查看详情</Button>`，无 `onClick`。当前不可达（`overview.js:212,232,252` 恒给 `actionLabel`），属埋雷。
- `api/auth.ts:68` —— `refresh()` 导出但全仓无 import。
- `api/client.ts:57` —— 每个请求都发 `config.headers.set('X-CSRF-Token', 'placeholder')`，而 `/api/admin`（`src/server/src/index.js:554`）**没有挂 `csrfProtection`**；后端 CORS `allowedHeaders`（`index.js:129`）里也没有 `X-ClipSync-Upstream`。纯装饰，且注释「后端启用 CSRF 校验时由登录接口下发真实 token」与现实不符。
- `pages/forbidden/index.tsx:13` —— 403 页的「返回数据看板」跳 `/dashboard`，而 `/dashboard` 的 `RequireRole` 对非管理角色又会渲染 `ForbiddenPage` → 原地打转，应指向 `/login` 并提供登出。
- `pages/ops/index.tsx:84` —— `err.code === 40301`，而 `requirePerm` 拒绝用的是 `4030`（`adminAuth.js:130`）；靠 `:86` 的 `status === 403` 兜住。
- `pages/settings/index.tsx:990` —— 「第三方登录」占位卡的显示条件是 `configs?.some(c => c.key === 'smtp_host')`，与卡内容毫无关系；`smtp_host` 哪天退出目录，这张占位卡就静默消失。

**文案 / 一致性**
- `pages/devices/index.tsx:308` —— 确认弹窗正文里裸写 markdown：`该设备将被**立即断开连接并退出登录**`。JSX 不解析 `**`，运营者会**原样看到两组星号**。
- `pages/users/index.tsx:263` —— 页头写「手机号默认打码，明文查看将记入审计」。打码是真的（`users.js:216` `maskPhone`），但**「明文查看」这个功能全站不存在**（`UserDrawer` 里没有该入口）——承诺了一个没有的能力。
- `pages/users/index.tsx:239-251` —— 列表行的「删除」按钮（`danger`，红色）实际只是 `openDrawer(record.id)`，打开详情抽屉；真正的删除在抽屉里（`UserDrawer/index.tsx:313`）。红色危险按钮点了却只是打开抽屉，与同排「停用」直接弹确认弹窗的行为不一致。
- `pages/dashboard/index.tsx:169` —— `昨日同时段 <b className={styles.down}>{kpis.devicesDelta}</b>`，`down` 样式写死；`devicesDelta` 为正数时仍按下降配色。`:144,155` 的 `¥` 前缀也写死（`Order.currency` 契约里有币种字段）。
- `pages/devices/index.tsx:273` 用 `destroyOnClose`，其余弹窗（`ConfirmReasonModal:64`、`OrderDetailModal:88`、`plans:276`、`releases:312`）用 `destroyOnHidden` —— antd 5.25+ 已弃用前者，混用会打 deprecation warning。
- `pages/subscriptions/index.tsx:113` —— 列 `dataIndex: 'nickname'`，但 `AdminSubscription` 无该字段（render 里读的是 `record.userLabel`）；该列也未设 `width`/`ellipsis`，长昵称会挤压表格。
- `pages/security/index.tsx:122` 用原生 `title` 做权限提示，其余页面统一用 antd `Tooltip`。
- `components/UserDrawer/index.tsx:9` —— `import { GrantSubscriptionModal } from '@/pages/subscriptions/GrantSubscriptionModal'`：`components/` 反向依赖 `pages/`。`eslint.config.js:56-70` 的「页面之间禁止互相 import」规则只约束 `src/pages/**`，所以这条倒挂依赖绕过了 lint，与该规则声明的意图（「跨页逻辑必须下沉 components/」）相反。
- `pages/settings/index.tsx:87-116` `FLAG_META` 只有 6 项，后端 `FLAG_CATALOG` 有 7 项（缺 `force_2fa_for_admin`）。
- `api/types.ts:193-202` `AuditLogListParams` 缺 `userId`（前端实际在发）与 `q`（后端支持、前端未暴露）。
- `pages/settings/index.tsx:584` 数字类配置统一 `<InputNumber min={1} precision={0} />` → `session_timeout_minutes` **无法设成 0**，而 `AdminLayout.tsx:208` 的语义恰恰是「0 = 不启用空闲登出」，运营者没法从 UI 关掉它。
- i18n：全站中文硬编码，**中英混杂基本没有**（仅品牌名/技术词如 ClipSync Admin、Grafana、SMTP、MRR、p95），`ConfigProvider locale={zhCN}` + `dayjs.locale('zh-cn')`（`main.tsx:3,17`）一致。对纯内部后台可接受，无需 i18n。

**性能（已核实为良好，仅记录残余）**
- 路由 100% 懒加载（`router/index.tsx:7-29` 全部 `lazy()` + `Suspense`）✅
- echarts 按需引入（`components/charts/OrderBarChart.tsx:1-16` 只 `echarts.use([BarChart, Grid, Tooltip, Legend, CanvasRenderer])`）✅
- 无 1000 行大表风险：所有列表页走服务端分页，`pageSize` 上限 200（后端 `parsePaging`）✅；唯一例外是 S2-14 的 AI 供应商页
- 残余：Tab 计数用「同接口 `pageSize=1` 取 total」实现，订单页 6 个 Tab（`orders/index.tsx:107-115`）+ 列表 = 每次筛选变更 **7 个请求**；退款审核页 4 + 1 = 5 个（`refund-review/index.tsx:101-109`）。后端应提供一次返回各状态计数的聚合端点。
- 残余：`AdminLayout` 的 overview（60s 轮询）与 settings/ai 页各自的 `getConfigs` 共用 `queryKeys.configs()`，缓存复用做得对 ✅；`ops/index.tsx:331-334` 用手写 `setInterval(refetch)` 而非 react-query 的 `refetchInterval`（同页另外 4 个查询都用了后者），冗余且不受 `refetchOnWindowFocus:false` 之外的策略管辖。

---

## 危险操作防护核对

| 操作 | 二次确认 | 原因必填 | 后端审计 | 防重复提交 | 前端权限裁剪 | 后端权限 | 评价 |
|---|---|---|---|---|---|---|---|
| 退款审核·通过（**真打款**） | ✅ Modal + 红色 Alert「不可撤销」（`refund-review:449-488`） | ❌ **无原因** | ✅（`refundRequest.js` 服务层 + `superAdminAudit`） | ✅ `okButtonProps.loading`（`:454`）+ `maskClosable={false}` + 后端 CAS 抢占 `processing`（`refundReviews.js:53-55`）+ 支付宝 `out_request_no` 幂等 | ✅ `hasPerm('admin.orders.refund')`（`:185,339`） | ✅ `requirePerm` + `adminStrictLimiter`（`index.js:63`） | **防护最完整的一项**。唯一缺口：通过不要求填原因（驳回要求），事后审计无法回答「为什么同意退这笔」 |
| 退款审核·驳回 | ✅ `ConfirmReasonModal`（`:490-509`） | ✅ ≤200 字，前后端双校验 | ✅ | ✅ `confirmLoading={rejectMutation.isPending}` | ✅ | ✅ + 限流（`index.js:64`） | 好。`entitlementRestored === false` 时明确提示「旧权益未自动还原，请人工核对」（`:153-155`）——诚实 |
| 订单页·直接退款 | ✅ `RefundModal` + `maskClosable={false}` | ✅ | ✅ | ✅ `submitting` 门闩（`RefundModal:62,77,86`）+ `handleCancel` 在 submitting 时拒绝关闭（`:91`） | ✅ `canRefund`（`orders:156,241`） | ✅ + 限流 | 好。金额锁死全额不可改（`RefundModal:127-131`），`PARTIAL_REFUND_NOT_SUPPORTED` 有专门行内说明（`:117-125`） |
| 停用账号 | ✅ `ConfirmReasonModal` + 影响说明 | ✅ | ✅ | ✅ `mutateAsync` + `confirmLoading` | ✅ `canManage` | ✅ `admin.users.manage` | 好 |
| 删除账户（软删） | ✅ + 明示「软删、可重新启用」 | ✅ | ✅ | ✅ | ✅ `canDelete` | ✅ `admin.users.delete`（superAdminOnly） | 好。但入口藏得别扭（见 S3） |
| 强制下线用户 / 设备 / 管理员会话 | ✅ ×3 | ✅ ×3 | ✅ ×3 | ✅ ×3 | ✅ ×3 | ✅ + 限流 | 好。会话页缺缓存失效（S2-11） |
| 导出用户数据 | ✅ + 明示导出范围与「剪贴板正文不在范围」 | ✅ | ✅ | ✅ | ❌ 按钮无权限裁剪（`UserDrawer:319-321`），后端 `admin.users.view` | ✅ | 可接受 |
| 维护模式 | ✅ + 影响说明 | ✅（后端 40003 强制） | ✅ | ✅ | ✅ | ✅ | **样板级**：确认文案、原因必填、生效链路说明（`MAINTENANCE_HINT`）齐全 |
| 改套餐价格/配额/停用 | ⚠️ 仅普通编辑 Modal | ❌ | ⚠️ 只记新值 | ❌（S2-9） | ✅ `canManage` | ✅ | **S2-10** |
| 改系统配置（限流/日志/AI/短信…） | ❌ 直接保存 | ❌（仅维护模式要） | ⚠️ 只记新值 | ⚠️ 按钮有 loading，但多键非原子 | ✅ | ✅ | **S2-8 / S2-10**。校验做得不错：数字键 `min=1`、`log_level` 白名单前后端双校验、`menu_overrides` JSON 校验、`rate_limit_disabled=true` 生产环境后端直接拒（`configs.js:436-438`） |
| 改客户端策略 | ✅ `ConfirmReasonModal` + 变更项计数 | ✅ | ✅ | ✅ | ✅ | ✅ | 好。有 min/max 边界（`policies:215-216`）、「未接入」角标、「已自定义（默认 N）」对比标签（`:193-197`）——**这是全站唯一做了「当前值 vs 默认值」对比的页面** |
| 改功能开关 | ❌ 一键即切 | ❌ | ✅ | ✅ 乐观更新 + 失败回滚 | ❌（S2-4） | ✅ | 有 `FLAG_META` 说明生效范围与生效方式（≤5s / WS 广播），这点很好；缺 `enforced` 角标（S2-5） |
| 群发公告 | ❌ 提交即发 | ❌ | ✅ | ✅ `loading` | ✅ `canSendAnnouncement` | ✅ | **S2-10**：无受众人数预估、无撤回入口 |
| 改角色权限（**提权面**） | ❌ 直接保存 | ❌ | ✅ **含 added/removed 前后对比**（`roles.js:334-338`） | ✅ `loading={saveMutation.isPending}` | ❌ 保存/新建按钮无 `hasPerm('admin.roles.manage')` 裁剪（`roles:130,176-184`） | ✅ `requirePerm` + superAdminOnly 越级防护（`roles.js:324-330`）+ `clearPermCache()` | 后端**最严**（超管唯一性、越级拒绝、事务全量替换、审计含前后差、权限缓存即时失效），前端最松（给角色勾上 `admin.orders.refund` 这种提权动作，一次点击即生效，无确认无原因） |
| 版本发布 / 撤回 | ❌ | ❌ | ✅ 无原因 | ❌ 按钮不禁用 | ✅ `canManage` | ✅ | **S1-4** |
| 删除版本 | ✅ `ConfirmReasonModal` | ✅ | ✅ | ✅ | ✅ | ✅ | 好 |
| 运维动作（清缓存/重载/全员下线/立即备份） | ✅ 逐个动作有专属说明文案（`ACTION_META`） | ✅ | ✅ | ✅ | ❌ 按钮无裁剪（`ops:584-593`，路由守卫是 `admin.ops.view`，后端动作也是 `admin.ops.view` → 一致，可接受） | ✅ + 限流 | 好。「全员下线」明示「不影响你当前会话」（`:596`）——诚实 |
| 存储清理归档 | ✅ + 明示「清理不可恢复」 | ✅ | ✅ | ✅ | ❌（同上） | ✅ 受 `storage_cleanup_enabled` 闸门 | 好 |
| 删除邮件通道 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 好 |

**批量操作**：全站**没有任何批量选择/批量操作**（无 `rowSelection`），因此不存在「批量选中数量提示」「跨页选择保持」问题。这既是简化也是缺口——运营者要停用 10 个刷单账号得点 10 次。

---

## RBAC 前后端双侧核对

**账号体系**：与 C 端**同一套 `users` 表**，无独立管理员表。管理员 = `users.role_id → roles.role_key ∈ {admin(50), super_admin(100)}`。登录走 C 端的 `/api/auth/login` 或 `/api/auth/verify-code`，管理台额外用 `GET /api/admin/whoami`（`index.js:95-109`）取角色与权限。

**后端强制链**（`src/server/src/routes/admin/index.js:56`）：
```js
adminRouter.use(authenticateToken, requireRole(50), superAdminAudit);
```
+ 每个端点各自的 `requirePerm('<key>')`（`adminAuth.js:93-133`：查库 `users→roles→role_permissions→permissions`，**DB 异常时 fail-closed 返回 500 而非放行**，60s 内存缓存，角色变更时 `clearPermCache()` 立即失效）。
+ 高危写操作叠加 `adminStrictLimiter`（`index.js:61-77`，8 条正则覆盖退款/审核通过/审核驳回/强制下线/删号/设备下线/运维动作/会话吊销）。

**核对结果：后端每一个前端会调的端点都挂了 `requirePerm`，无一遗漏。** 唯一的例外是 `GET /admin/overview`（`overview.js:88`，只有 `requireRole(50)` 门槛）与 `GET /admin/whoami`——这是有意设计（权限目录里没有 overview 的 view 键），可接受。

**「只做前端隐藏等于没做」——本项目没有犯这个错**：`utils/permissions.ts:3-6` 与 `router/RequireRole.tsx:10-12` 的注释都明确写着「仅做 UX 裁剪，真正鉴权以后端 requirePerm 中间件为准」。逐条抽查了 6 个高危动作（退款、审核通过、删号、强制下线、改角色权限、改配置），**后端全部独立拦截**。「只读角色直接调 API 绕过前端禁用状态」这条路是**走不通的**。

**角色定义的两处来源与一致性**：
- 后端：`roles.js` 的 `PERM_CATALOG`（含 `superAdminOnly` 标记，`:42-53`），运行时经 `GET /admin/permissions` 下发给前端。
- 前端：**不硬编码权限目录**，`pages/roles/index.tsx:63,66` 完全从后端拉取渲染；分类顺序与中文标签在前端（`CATEGORY_ORDER` / `CATEGORY_LABELS`，`:21-35`）。
- 前端硬编码的只有：`ADMIN_ROLE_KEYS = ['admin','super_admin']`（`authStore.ts:56`，用于 `RequireRole` 的入场判定）与各页面里的 `hasPerm('<字面量键>')`。抽查 `admin.orders.refund` / `admin.users.manage` / `admin.users.delete` / `admin.configs.manage` / `admin.keys.view` / `admin.release.manage` / `admin.ai.manage` / `admin.email_channels.manage` / `admin.subscriptions.grant` / `admin.audit.view` / `admin.ops.view` 等键名，**与后端 `requirePerm` 参数逐一相符，无拼写漂移**。

**超级管理员判定**：前端 `permissions.ts:10-11`（`roleKey === 'super_admin'` 或 `permissions.includes('*')` 恒真），`auth.ts:37` 在登录时把超管的 permissions 归一为 `['*']`；后端 `whoami`（`index.js:80-81` 注释）照常返回真实键数组，归一逻辑放前端——两侧口径一致，且后端不依赖前端的归一。

**RBAC 侧的真问题不在「后端不拦」，而在三条**：
1. **S0-1**：整套前端 RBAC 的输入（`roleKey` + `permissions`）来自可被 DevTools 随意改写的 localStorage，因此前端权限展示不可信（后端仍然拦得住，所以是体验与可信度问题，不是越权）。
2. **S2-3**：权限**只在登录那一刻**取一次并永久持久化，无复校 → 撤权后前端长期显示旧权限。
3. **前端裁剪不一致**：绝大多数写控件都做了 `disabled={!canXxx}` + 「缺少权限」Tooltip（做得相当细，连 `refund-review:328-333` 的 Tooltip 都区分了「有权限时说明后果 / 无权限时说明缺哪个键」），但有 4 处漏了 —— 功能开关 Switch（S2-4）、角色页保存/新建（`roles:130,176-184`）、AI 页供应商启停已裁但全局参数区依赖 `canManageConfigs` ✅、运维动作区（依赖路由守卫，可接受）。漏掉的这几处点了都是 403 toast，不是安全问题，但破坏了「灰掉 = 我没权限，亮着 = 我能做」这个用户已经建立起来的心智模型。

---

## 工程质量指标

| 指标 | 数值 | 说明 |
|---|---|---|
| TS/TSX 总行数（`src/`） | 16,291 | 与任务描述的「约 1.6 万行」一致 |
| `: any` / `as any` / `<any>` | **0** | `eslint.config.js:31` 把 `@typescript-eslint/no-explicit-any` 设为 `error`，且用了 `recommendedTypeChecked` |
| `tsconfig` 严格度 | `strict: true` + `noUncheckedIndexedAccess` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch` + `verbatimModuleSyntax` | `tsconfig.app.json:16-24`，严格度高于绝大多数同类项目 |
| `eslint-disable` | **4** | `ErrorBoundary:25`(no-console)、`useTableQuery:51` + `settings:462` + `sso:57`(exhaustive-deps)，每处都有说明性注释 |
| `console.*` 残留 | **2** | `ErrorBoundary:26`(error)、`main.tsx:48`(warn)；`no-console` 配 `allow:['warn','error']`，无 log/info/debug 残留 |
| 自定义 lint 守卫 | 2 条 | 「页面之间禁止互相 import」（`eslint.config.js:56-70`）、「禁止裸写『后续版本』占位文案」（`:72-88`，配合 `src/placeholders.ts` 登记表 + `scripts/admin-full-audit/run-audit.mjs placeholders`）——**这两条是主动防腐设计，值得肯定** |
| 占位功能登记 | `PLACEHOLDER_FEATURES: [] = 空` | `placeholders.ts:35`，注释说明 AF-13/AF-15 落地后已清零 |
| 最长文件 Top10 | `mocks/data.ts` 1502 · `mocks/handlers.ts` 1455 · `pages/settings/index.tsx` **1207** · `api/types.ts` 872 · `mocks/handlers.test.ts` 832 · `pages/ops/index.tsx` **819** · `pages/refund-review/index.tsx` 512 · `components/UserDrawer/index.tsx` 446 · `pages/ai/index.tsx` 420 · `pages/releases/index.tsx` 388 | 前两名与第 5 名是 mock/测试数据，可接受。**`pages/settings/index.tsx` 1207 行是真正该拆的**：一个组件里塞了功能开关、维护模式、限流、公告、邮件通道 CRUD、系统参数分组、短信测试共 7 块职责 + 6 个 Form 实例 + 8 个 mutation。`pages/ops/index.tsx` 819 行同类问题（但已把列定义提到模块级，稍好） |
| 单元测试 | 7 个文件 / 31 个 `it`/`test` | `upstream` 8 · `navGroups` 12 · `format` 6 · `permissions` 4 · `auditUtils` 1 · `handlers` + `devicesSubscriptions` 约 40+（用 `test()` 而非 `it()`） |
| E2E | 2 个 spec / 7 个用例 | dashboard / users / orders / audit 冒烟 + settings 写操作闭环（含改后还原）。**CI 不可运行**（S2-15） |
| 测试盲区 | — | **退款审核页 0 覆盖**（单测与 E2E 都没有，而这是唯一直接触发真实打款的页面）；邮件通道 0 覆盖；用户删除/强制下线/导出 0 覆盖；`fmtTime` 时区 0 覆盖 |
| 误提交的构建产物 | 3 个 PNG（660 KB）在 `src/admin-console/`；仓库共 128 个图片 / 7.4 MB | `dist/`、`test-results/`、`*.log`、`.env*.local` 均已正确 gitignore ✅ |
| 死代码 | `api/auth.ts:refresh()`、`client.ts` 的整套 refresh 机制、`dashboard:49` 的无 onClick 按钮、`login:175` 的无 onClick 按钮、`login:260` 的「忘记密码？」span、`pages/orders/index.tsx:73` 不可达的 `return undefined` 分支（`RANGE_OPTIONS` 无「全部」项）、`DevicePlatform` 里 DB CHECK 不允许的 `'ipados'`/`'web'`（`scripts/init-db.sql:46`） | 均为小面积，无整页/整组件级死代码；`router/index.tsx` 的 15 条路由与 `AdminLayout` 的 15 个菜单项**一一对应，无孤儿页面**（`navGroups.test.ts` 有 12 个用例专门钉这件事） |
| 重复代码 | `formatDateTime`/`formatMinute` 在 `ops/index.tsx:71-75` 重新实现了一份（`utils/format.ts:18-22` 已有 `fmtTime`）；`fetchAllOrders`（`orders.ts:53-65`）与 `fetchAllAuditLogs`（`audit.ts:13-28`）是同一套分页循环导出模式的两份实现；`downloadBackupFile`（`ops.ts:58-69`）与 `exportUserData` 的 Blob→`<a>` 下载逻辑重复（`utils/download.ts` 只覆盖了文本） | 轻度，均有注释说明取舍 |

---

## 设计层面的观察

**做得好的（不是客套，这些是同类内部后台里少见的）**

1. **「诚实化」是一条贯穿的设计原则，而且真的执行了。** `ReconciliationModal:41-45` 明确写「本报告仅供运营自查，不能当作与支付宝账单的核销依据」；`refund-review:425` 在读失败时说「服务端可能尚未提供该端点」而不是假装没数据；AN-09 的 `consumer` 字段给每个配置项打「未接入」红角标（`settings:604-609`）+ 顶部汇总计数（`:924-929`），AN-02 的客户端策略页同款（`policies:141-149`）；`RefundModal:123` 在部分退款被拒时说「页面金额可能已过期，请刷新后按最新金额重新发起」。**一个后台愿意主动告诉运营者「这个按钮改了不生效」「这个数字不能当对账依据」，是产品诚信的正面证据**——也正因如此，S2-5（`enforced` 被丢弃）和 S1-3（MSW 横幅谎报）才显得格外刺眼：它们是这条原则的两个漏点。
2. **注释在解释「为什么」而不是「是什么」，并且大量记录了踩过的坑。** `refundReviews.ts:147-152` 解释为什么两种错误码形状都要读；`orders.js:42-44` 解释为什么未识别渠道宁可归 unknown 也不塞进 wechat；`upstream.ts:1-14` 完整交代了为什么只能在 dev server 上换后端（浏览器改不了 Origin 头）。这些注释本身构成了一份可审计的决策记录。
3. **资金链路的幂等做得扎实。** 退款审核「通过」用 CAS 把单子抢成 `processing` 再调渠道，失败退回 `pending`（`refundReviews.js:53-55`），叠加订单侧行锁复核与支付宝 `out_request_no` 幂等；前端把 `processing` 作为一个**独立的展示态**（`refund-review:54-55,62,357`「打款中，勿重复操作」）而不是塞进 pending，并诚实地在类型注释里说明它不在契约的筛选枚举里（`refundReviews.ts:15-24`）。这是全套审计里最让我放心的一块。
4. **`ConfirmReasonModal` 作为统一的危险操作入口是正确的抽象**：原因必填、≤200 字、`maskClosable` 由调用方控制、`submitting` 门闩内置、`destroyOnHidden` 保证每次打开都是干净表单。13 处危险操作里有 11 处用了它。缺的那 2 处（版本发布、套餐价格）正是 S1-4 与 S2-10。

**结构性隐患**

1. **MSW 是一份平行实现的后端，而不是从后端契约生成的。** `mocks/handlers.ts` 1455 行 + `data.ts` 1502 行 = **2957 行手写假后端**，占整个前端代码量的 18%。它与真实后端的同步完全靠人工（`configs.js:24-25` 的注释甚至写着「展示目录…与前端设置页契约（admin-console/src/mocks/data.ts mockConfigs / mockFlags）逐键对齐」——**后端源码把前端 mock 文件列为需要对齐的对象**）。这份成本已经付出了，收益却在衰减：14 个端点没跟上（S1-3），`enforced` 字段两边都缺（S2-5），而 1073 行的「契约测试」只验证 mock 自洽（S2-15）。**建议：v1 之后把 MSW 的定位从「平行后端」降级为「组件开发用的 storybook 式夹具」，契约验证移到对真实后端跑的集成测试。**
2. **前端有三份「谁是超管 / 有什么权限」的真相**：localStorage 里的持久化副本、`hasPerm` 的运行时判定、后端 DB。三者之间没有任何同步机制（S2-3），而第一份还是可篡改的（S0-1）。
3. **`settings/index.tsx` 的 1207 行是一个可预见的事故源。** 6 个 `Form.useForm` 实例 + 8 个 mutation + 3 套保存路径（`saveConfigGroup` 逐键 PATCH、`saveChannelMutation` 单次、各开关乐观更新）挤在一个组件里，`AF-01` 的注释（`:919-921`）已经在警告「所有参数卡必须包在同一个 `<Form>` 内，否则回填失效」——**一条靠注释维持的隐性约束，等于下一个改这个文件的人的陷阱**。E2E 里专门有一条 AF-01 回归用例（`settings.spec.ts:24-29`）说明它已经坏过一次。
4. **时间处理没有单一出口。** `utils/format.ts` 提供了 `fmtTime`/`fmtDate`，但 `ops/index.tsx:71`、`policies/index.tsx:153`、`settings/index.tsx:797`、`security/index.tsx:100`、`AuditDetailModal:45` 各自绕过它手撕字符串。这是 S2-1 之所以是**系统性**问题而非个别笔误的原因：没有一个强制的时间渲染出口。

---

## 建议补充的功能（按性价比排序）

1. **给退款审核「通过」补原因必填**（半天）。目前通过不打原因、驳回打原因，而通过才是真花钱的那个动作。直接复用 `ConfirmReasonModal`，正文保留现有的红色不可撤销 Alert。这是全部建议里「代价/收益」最高的一条。
2. **时间统一**（1 天）。后端所有 `toISOString().replace('T',' ')` 改为 `toISOString()`；前端禁止绕过 `fmtTime`（加一条 eslint `no-restricted-syntax` 挡住 `.slice(0,` / `.replace('T'` 这类模式，仓库已有同类守卫的先例）。顺带解决 S2-1 与 CSV 导出的时区问题。
3. **审计日志：操作者自由文本筛选 + 全文搜索 + 前后值对比**（1.5 天）。删掉 Carlos/Yuki（S1-2），暴露后端已支持的 `q`；`admin.config.update` / `admin.plans.update` 的 `details` 补 `previous`（对齐 `roles.js` 已有的 `added/removed`），详情弹窗按「旧 → 新」渲染。审计页会第一次真正可用。
4. **会话续期 + 未保存保护**（1 天）。`/auth/login` 与 `/auth/sso-exchange` 下发 refreshToken，前端接住（`RealLoginResp` 加字段），把 `client.ts` 里已经写好的续期逻辑接通；含 dirty 表单的页面挂 `useBlocker`。解决 S2-2。
5. **应用启动时重新 `whoami`**（半天）。解决 S2-3，并且是 S0-1 最小改动方案的前置步骤（把 `permissions`/`roleKey` 从 persist 里摘掉后，必须有这个才能刷新恢复权限）。
6. **版本发布走确认弹窗 + URL 校验**（半天）。解决 S1-4。
7. **订单页「全部时间」+ 有订单号时自动解除时间限制**（1 小时）。解决 S2-6，一行 options 加一项 + `rangeToDateFrom` 的 undefined 分支变成可达。
8. **`FeatureFlag.enforced` 接上「无服务端强制点」角标**（2 小时）。解决 S2-5，复用 `consumer` 那套现成视觉。
9. **配置批量 PATCH 端点 + 前端「旧值 → 新值」预览**（1.5 天）。解决 S2-8 与 S2-10 的配置部分，同时让「限流阈值改成 500」这类误操作在提交前可见。
10. **AI 供应商列表服务端分页**（半天）。解决 S2-14，趁用户量还小的时候做。
11. **拆分 `settings/index.tsx`**（1 天）。7 块职责拆成 7 个子组件，每块自己持有 Form 实例，消灭「必须包在同一个 Form 内」这条靠注释维持的约束。
12. **E2E 可在 CI 跑 + 契约测试改打真实后端**（2 天）。解决 S2-15。这是防止「近期多个提交都在修管理台 bug」这个趋势继续下去的根治手段，但工作量最大、见效最慢，放在功能补强之后。
13. **公告受众人数预估 + 撤回入口**（1 天）。发送前显示「即将推送给 12,847 名用户」；历史列表加「撤回」（后端 `admin_announcements` 需要一个 `revoked_at` 列 + 客户端拉取时过滤）。
14. **列表页批量操作**（2 天）。至少给「停用账号」和「强制下线设备」加 `rowSelection` + 批量确认（含选中数量提示与跨页保持）。目前运营者处理批量刷单只能一个个点。
15. **仓库卫生**（10 分钟）。`git rm --cached` 那 3 张 PNG 与 `audit-out-day2/`，`.gitignore` 补 `*.png`（或 `debug-*.png` / `verify-*.png`）与 `*.docx`，把 1.16 GB 的 `clipsync_events.log` 清掉并给日志加轮转。
