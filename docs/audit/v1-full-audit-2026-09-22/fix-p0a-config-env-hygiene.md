# P0-A 修复记录：配置与凭据卫生（config / env hygiene）

批次：v1-full-audit-2026-09-22 / P0-A
负责范围（独占文件）：`.gitignore`、`src/server/.env.test`（仅取消跟踪）、`src/server/.env.test.example`（新增）、`src/server/src/config.js`、`docker-compose.*`（仅 JWT 默认值相关，见结论）、本记录文件。
凭据纪律：本文件**不含任何真实密钥值**，敏感项一律以「文件:行号 + 凭据类型」描述。

---

## 修复 1（S0）：`src/server/.env.test` 被 git 跟踪且含真实凭据

### 1.1 文件内容复核（按行 + 类型，不含值）
`src/server/.env.test` 共 5 个键，**全部为敏感凭据**，无「端口 / NODE_ENV / 开关」这类无害项（文件头注释也说明非敏感项由 `src/config/test.js` 控制）：

| 行号 | 键 | 凭据类型 | 是否敏感 |
|------|-----|----------|----------|
| 6  | `DB_PASSWORD`    | 测试/开发库密码 | 是 |
| 9  | `REDIS_PASSWORD` | Redis 密码      | 是 |
| 12 | `JWT_SECRET`     | JWT 签名密钥（可伪造任意用户 token） | 是（最高危） |
| 15 | `ENCRYPTION_KEY` | 静态加密主密钥（AES-256-GCM） | 是 |
| 18 | `CSRF_SECRET`    | CSRF 密钥       | 是（但见 1.5：服务端零读取，是死变量） |

补充事实：`JWT_SECRET`(行12) 的值与 `docker-compose.dev.yml:87` 的 `${JWT_SECRET:-...}` 默认串**相同**；`DB_PASSWORD`(行6)/`REDIS_PASSWORD`(行9) 与 `src/config/development.js:15` / `test.js:15,23` / `docker-compose.dev.yml` 的硬编码 dev 默认**相同**。即：这些值既是 `.env.test` 内容，也散落在多个**已入库**文件里，早已公开。

### 1.2 已执行的动作
- `git rm --cached src/server/.env.test`（**唯一**的 git 写操作；只动索引，工作树文件保留，不动历史）。
  - 验证：`git ls-files src/server/.env.test` 现为空（UNTRACKED）；`test -f src/server/.env.test` 仍在（LOCAL FILE PRESENT）；`git status` 显示 `D  src/server/.env.test`（暂存的索引删除，**未 commit**）。
- `.gitignore` env 段修正（见 1.3）。
- 新增 `src/server/.env.test.example`（见 1.4）。

### 1.3 `.gitignore` env 段：为什么之前会被跟踪
原规则显式反向放行了 `.env.test`：
```
.env
.env.*
!.env.example
!.env.test              <- 元凶：强制把 .env.test 放回跟踪
!.env.development.example
```
改为（删除 `!.env.test`，并把模板放行 generalized 为 `!.env.*.example`，自动覆盖 `.env.test.example` / `.env.development.example` / 未来任何 `.env.*.example`）：
```
.env
.env.*
!.env.example
!.env.*.example
```
`git check-ignore -q` 退出码实测（0=忽略，1=可入库）：
- `src/server/.env.test` -> IGNORED ✓
- `src/server/.env.test.example` -> TRACKABLE ✓
- `.env.example` / `src/server/.env.example` / `.env.development.example` -> TRACKABLE ✓（模板未误伤）
- `src/server/.env.production` -> IGNORED ✓

### 1.4 新增 `src/server/.env.test.example`
完整抄 `.env.test` 的键结构与逐项注释，5 个敏感值全部替换为占位符 `CHANGE_ME_test_only`，顶部 2 行说明「复制为 .env.test 后填入本地测试库凭据（值需与 docker-compose.dev.yml 的 dev 默认一致）」。无任何真实值落盘。

### 1.5 CI 加载 `.env.test` 的判断（未改 `.github/workflows/`，按要求）
- 加载点：`src/server/tests/setup.js:10` `dotenv.config({ path: '../.env.test' })`。
- `dotenv.config` 对**缺失文件不报错**（返回 `{error}` 但不抛）。因此 CI（无 `.env.test`）**不会因本次取消跟踪而崩**。
- 缺 `.env.test` 时测试仍能从 `src/config/test.js` 的**硬编码默认**取到 db/redis/jwt 值（且这些默认与 dev compose 默认一致），故本地与 CI 的 config 解析行为不变。
- 实测：本地 `.env.test` 仍在，`npx vitest run` 日志出现 `injected env (5) from .env.test`，测试正常通过。
- 结论：CI 侧真正的问题是**连不上测试库**（CI 用 5432、本地/`test.js` 用 5433），属 P0-C 批次，本批**未触碰**。取消 `.env.test` 跟踪**不会**让 CI 变好也不会变坏。

### 1.6 必须由用户亲自做（凭据轮换 + 历史清理）
> 这些值已随公开仓库（github/cnb 双远端）泄露，**仅从 HEAD 移除不足以消除风险**。

**必须轮换的凭据类型（按 `.env.test` 行号）：**
1. **JWT 签名密钥**（行12）—— 最高危：可伪造任意用户 token。轮换后所有旧 token 失效，需评估在线用户重登。
2. **数据库密码**（行6）。
3. **Redis 密码**（行9）。
4. **静态加密主密钥 ENCRYPTION_KEY**（行15）—— 轮换需谨慎：已用旧密钥加密的 `content_encrypted` 数据需重加密迁移，否则无法解密。
5. **CSRF 密钥**（行18）—— 见下方说明，服务端实际零读取，但既然入了公开库仍建议一并作废/移除。

**同时必须做：**
- 上述 dev 默认值还散落在 `src/config/development.js`、`src/config/test.js`、`docker-compose.dev.yml`（均已入库、公开）。轮换时一并处理，别再让生产复用任何 `dev_*_change_me` 形态的值。
- **git 历史清理由用户本人负责**（`git filter-repo` / BFG 等），本代理未做任何历史改写。历史里仍能翻出旧值 → 轮换是根治手段。

---

## 修复 2（S0）：生产配置校验从 `console.warn` 改为 fail-fast

### 2.1 复核锚点（改前）
`src/server/src/config.js:84-105`：`if (nodeEnv === 'production')` 内收集 `warnings[]`（JWT / DB / Redis / CORS），仅 `console.warn` 后**继续启动**。JWT 黑名单当时只有一个值（即 `development.js:27` 的 dev 默认）。

各环境默认来源复核：
- `production.js`：`db.password` / `redis.password` / `jwt.secret` 均 `process.env.X`（**无硬编码兜底**，缺失即 undefined）；`cors.origins = process.env.CORS_ORIGINS || ''`。**未发现 `process.env.X || 'some-dev-secret'` 式的生产兜底**（这点审计的担忧在 production.js 不成立，值得肯定）。
- `development.js:27` / `test.js:27` 的 `jwt.secret` 为硬编码 dev/test 默认，但因 `envConfigs[nodeEnv]` 选择机制，**生产不会取到它们**（除非 NODE_ENV 配错）。
- `ENCRYPTION_KEY` / `CSRF_SECRET` **不在 config 对象内**（production.js 无此字段），由 `src/utils/encryption.js` 等直接读 `process.env`。

### 2.2 改动（`src/server/src/config.js`）
新增两个「已知不安全值」黑名单常量 + `collectConfigIssues(isProduction)` + 分支：
- **JWT 黑名单**（3 个，均为仓库内公开 dev 默认，按来源注释）：`development.js` 值、`test.js` 值、**`docker-compose.dev.yml:87` 的默认串（= `.env.test:12`）—— 即审计所指「黑名单漏掉的 compose 默认值」**。
- **ENCRYPTION_KEY 黑名单**（3 个）：`encryption.js:55` 兜底值、`docker-compose.dev.yml:88` 默认、**`.env.test:15` 的值**（此值 `encryption.js` 的 `DEFAULT_KEYS` 未覆盖，这里从 config 侧补上）。
- **生产（fatal，抛错终止）**：JWT 缺失或命中黑名单；DB 密码缺失；Redis 密码缺失；ENCRYPTION_KEY 缺失/命中黑名单/<32 字符；CORS_ORIGINS 为空或 `*`。→ `console.error` 列出「缺哪个变量 + 怎么设」（**绝不打印任何密钥值**）后 `throw new Error(...)`，进程以非零码退出。
- **非生产（development/test）**：只对「JWT/DB  outright 缺失」告警，**永不抛错**。因 dev/test 配置有硬编码默认，实际不会触发 → 不产生噪音、不影响 525 测试。CORS/Redis/ENCRYPTION 的严格校验仅在生产生效（dev/test 合法使用 `*` 与 dev 默认）。

### 2.3 docker-compose 结论（未改 compose，按「影响生产部署方式则只改校验侧」原则）
- `docker-compose.prod.yml:100-102`：`JWT_SECRET/ENCRYPTION_KEY/CSRF_SECRET` 均为 `${VAR}`（**无默认值**）。即生产 compose **不存在**不安全默认串，无需删默认。
  - 注意：compose 对未设的 `${VAR}` 会**插值为空串并告警**（不报错）→ 空 JWT 由 config.js 新增的「JWT 缺失」fatal 兜住。
- 不安全默认串只在 `docker-compose.dev.yml:87-89`（dev 用），**删它会破坏本地免 .env 起 dev**，故不改；改为把该默认串列入 config.js 生产黑名单（已在 2.2 完成）——生产即使误用 dev 默认也会被拒启动。
- **建议（交用户决定，本代理未改 compose）**：可把 `docker-compose.prod.yml` 的 `JWT_SECRET: ${JWT_SECRET}` 等升级为 `${JWT_SECRET:?err}` 形式，让 compose 在解析期即失败（比空串+应用层抛错更早、更直观）。因这属生产部署机制改动，按纪律留作用户决定。

### 2.4 fail-fast 实测（5 种，输出已确认不含任何密钥值）
命令形态：`env NODE_ENV=... <vars> node --input-type=module -e "import c from './src/config.js'; ..."`（从 `src/server` 运行）。

- **场景1 production + JWT_SECRET 缺失（其余合法）→ FAIL-FAST**
  ```
  ❌ Production configuration validation failed — refusing to start:
    - JWT_SECRET is required — set a unique signing secret of at least 32 characters
  Set the above via environment variables / .env.production, then restart the service.
  Error: Production configuration invalid: 1 security-critical issue(s); refusing to start
  EXIT=1
  ```
- **场景2 production + JWT_SECRET = docker-compose dev 默认串 → FAIL-FAST**（值经 sed 从 compose 提取，未在命令/输出中出现明文）
  ```
  ❌ Production configuration validation failed — refusing to start:
    - JWT_SECRET is a known dev/default value — set a unique production secret (>=32 chars)
  Error: Production configuration invalid: 1 security-critical issue(s); refusing to start
  EXIT=1
  ```
- **场景3 test + 安全变量全空 → 不抛错**
  ```
  LOADED_OK env=test
  EXIT=0
  ```
- **场景4 development + 安全变量全空 → 不抛错**
  ```
  LOADED_OK env=development
  EXIT=0
  ```
- **场景5（附加）production + 全部合法强值 → 正常加载（证明未过度拦截）**
  ```
  LOADED_OK env=production
  EXIT=0
  ```
- **附加：production + 全部缺失 → 一次性列出 5 项缺口后 EXIT=1**（JWT/DB/Redis/ENCRYPTION/CORS 各一行，无密钥值）。

> 真实启动时 config.js 由 index.js 静态 import，抛错为未捕获异常 → 进程退出码 1（与上面 EXIT=1 一致）。

### 2.5 回归验证（测试库在线：clipsync-db:5433 / clipsync-redis:6380 healthy）
- `npx vitest run tests/api.test.js` → **13 passed**。
- `npx vitest run tests/integration.test.js tests/subscription-api.test.js` → **16 passed（2 文件）**。
- `node --check src/config.js` → SYNTAX_OK。
- 全仓 grep 确认：**无任何测试把 NODE_ENV 设为 production**，故生产 fail-fast 分支不会被测试触发；test/dev 走非 fatal 分支。525 测试的主要回归风险已排除。

### 2.6 部署前必须由用户确认的生产环境变量清单（缺任一 → 服务拒绝启动，这是预期的正确行为）
config.js 生产 fatal 校验项：
1. `JWT_SECRET`（唯一、≥32 字符、非任何 dev 默认）
2. `DB_PASSWORD`
3. `REDIS_PASSWORD`
4. `ENCRYPTION_KEY`（唯一、≥32 字符、非 dev 默认；注意与既有密文兼容，见 1.6）
5. `CORS_ORIGINS`（显式逗号白名单，不能为空、不能为 `*`）

`docker-compose.prod.yml` 还以 `${VAR}`（无默认）透传、虽未被 config.js 设为 fatal 但生产实际需要的：`DB_NAME`、`DB_USER`、以及支付相关 `ALIPAY_APP_ID/ALIPAY_PRIVATE_KEY/ALIPAY_PUBLIC_KEY/ALIPAY_NOTIFY_URL`（未配则支付接口运行时报 `ALIPAY_NOT_CONFIGURED`，见 2.7）。**请在 `docker compose -f docker-compose.prod.yml up` 前确认服务器 `.env.production` 上述变量齐全。**

### 2.7 经复核「不纳入 config.js 启动期 fatal」的项（说明理由）
- **支付宝等支付密钥**：审计要求「如果它们在 config 里有默认值」才纳入。复核：`src/utils/alipay.js:32-35` 用 `process.env.ALIPAY_* || ''`（**空兜底，非硬编码密钥默认**），且这些键**不在 config 对象内**；`alipay.js:136` 调用时已 `throw 'ALIPAY_PRIVATE_KEY not configured'`。故不纳入启动期 fatal——否则未启用支付的部署会被误杀。条件不成立，按纪律不强改。
- **CSRF_SECRET**：全仓 grep 确认 `src/server/src` **零读取**（`docker-compose.multi.yml:85` CO-34 注释亦印证「死变量，CSRF 走 csrfTokens 机制」）。既然服务端不消费，设为生产 fatal 无意义且可能误伤，故不纳入；但它仍出现在公开 `.env.test`，建议用户按 1.6 作废/移除。

---

## 修复 3（S2）：`.gitignore` 覆盖补全（仅预防，未删任何文件）

### 3.1 新增规则
- Rust 段补 catch-all：`target/`（覆盖任意 crate 构建产物；原有 `clipboard-dump/target/`、`src/desktop/src-tauri/target/` 变冗余但无害）。
- 测试/工具产物段补：`test-results/`、`playwright-report/`、`tmp/`、`audit-out-day2/`、`gui-test-screenshots/`。

### 3.2 已确认「无需新增」的（现有规则已覆盖，避免重复）
- `node_modules/`（:2，裸模式匹配任意层级 → 各子项目均覆盖）
- `dist/`（:7）、`build/`（:8,45）、`coverage/`（:64）
- `*.log`（:30，裸模式 → **全仓任意层级**，非仅根目录；根目录 1.1GB `clipsync_events.log` 已被其忽略、未入库）
- `test-output/`（:135）、`backups/`（:173，已覆盖 `backups/old-settings-v1/`）

### 3.3 ⚠️ 加了 ignore 规则但**因文件已被跟踪而无效**的路径（交用户决定是否 `git rm --cached`，本代理未执行）
`git ls-files` 实测：
- `audit-out-day2/` → **21 个已跟踪文件**（如 `00-login-dashboard.png` 等截图）。新规则只拦未来新增文件，已跟踪的不会消失。
- `gui-test-screenshots/` → **20 个已跟踪文件**（`t01_login_initial.png` 等）。同上。
- `backups/old-settings-v1/` → **2 个已跟踪文件**（`README.md`、`SettingsView.vue`）；虽 `backups/`(:173) 已忽略该目录，但这两个文件早被跟踪，ignore 对其无效。
- `clipboard-dump/target/` → **0 个已跟踪文件**（审计提到的 Rust `.exe/.pdb` 曾被提交，但现已不在跟踪中，新 `target/` 规则可正常预防复发）。

> 处置建议（用户决定）：若确认这些截图/备份不应入库，`git rm -r --cached audit-out-day2 gui-test-screenshots backups/old-settings-v1` 后再提交；本代理按纪律**未执行**任何此类删除。

---

## 顺带发现（未改，超出本批 3 项范围 / 属他人文件）
1. `src/utils/encryption.js:19` 的 `DEFAULT_KEYS` 黑名单**漏了 `.env.test:15` 的 ENCRYPTION_KEY 值**（只含 `docker-compose.dev.yml:88` 那个 dev 默认，不含 `.env.test` 那个更长的值）。我在 config.js 侧补了该值的黑名单，但 encryption.js 本体在 `utils/`（禁改），建议后续同步补入。
2. `src/routes/auth.js:30` 与 `src/routes/aiTools.js:51` 有硬编码盐兜底 `process.env.ENCRYPTION_KEY?.substring(0,16) || 'CLIPSYNC_SALT_2026'`（在 `routes/`，禁改）。生产若 ENCRYPTION_KEY 缺失会退回固定盐——不过 config.js 现已在生产对 ENCRYPTION_KEY 缺失 fatal，间接堵住此路径。
3. `src/utils/encryption.js:55` `MASTER_KEY_RAW` 有硬编码兜底默认（`utils/`，禁改）；生产已由 encryption.js 自身 `process.exit(1)` 与 config.js 双重拦截。
4. 根目录 `clipsync_events.log` 达 **1.1GB** 且无轮转（已被 `*.log` 忽略、未入库）。属运维问题，建议加日志轮转/上限，本批未处理。
5. `docker-compose.dev.yml:88` 的 `ENCRYPTION_KEY` dev 默认与 `.env.test:15` 值**不一致**（前者 `..32chars_min!!`，后者 `..32_bytes_long..`），两套 dev 默认并存易混淆，建议统一。
6. CI 测试库端口不匹配（CI 5432 vs 本地/`test.js` 5433）——属 P0-C，本批未触碰 `.github/workflows/`。

---

## 改动文件清单
- 改：`.gitignore`（env 段修正 + 新增 `target/` 等 6 条产物规则）
- 改：`src/server/src/config.js`（生产 fail-fast + 不安全值黑名单）
- 新增：`src/server/.env.test.example`（占位符模板）
- 新增：本记录文件
- 索引：`git rm --cached src/server/.env.test`（未 commit；工作树文件保留）
- **未改**：`docker-compose.prod.yml` / `docker-compose.dev.yml`（复核后判定不改更安全，改动建议见 2.3）
