# 部署 / 运维 / 基础设施 / 仓库卫生 审计

- 审计日期：2026-09-22
- 审计范围：docker-compose*、Dockerfile、nginx/、k8s/、monitoring/、.github/workflows/、scripts/ 运维脚本、docs/deploy 等发布运维文档、.env.*、.gitignore、桌面/移动/官网发布链路、git 历史与仓库卫生
- 纪律：只读审计，未修改任何源码/配置，未连接生产服务器，未执行任何运维脚本
- 排除项：已读 `docs/audit/external-dependency-audit-2026-09-09.md` 与 `docs/production-roadmap/external-dependencies.md`，域名/证书/DNS、Vault、Grafana/Sentry 云、负载均衡、扩缩容、代码签名证书本身不计为问题；只报「配置侧本可做而没做」的部分

## 结论（≤3 句）

**当前状态不能安全地跑生产 v1。** 最致命的一条：**公开 GitHub 仓库的 git 历史里含有完整开发数据库实体文件、数据库 SQL 备份、Redis 持久化文件和用户数据导出 CSV（含手机号/邮箱/密码哈希）**，任何人现在就能下载，必须立即做历史清除与凭据/数据影响评估。其次，生产入口（nginx TLS/WS/body-size、compose 本机覆盖）只存在于服务器文件系统、不在仓库，发布靠手工、无停机保护、回滚脚本与现实完全脱节、上传文件零备份——「跑着没问题」和「出事能恢复」是两回事，目前后者不成立。

---

## 凭据与敏感数据泄漏核对（含 git 历史）

结论先行：
- **HEAD（当前工作树跟踪文件）里没有真实密钥**：无 `.env` 实文件、无 pem/key/p12/jks/keystore、无 key.properties（`git ls-files` 全量核对）。`src/server/.env.test`、`.env.*.example` 均为 `*_change_me` 类占位值。
- **git 历史里有真实用户数据，且该历史就在公开的 origin/master 上**（仓库 https://github.com/CarlosShao/ClipSync 已确认为 public）。
- 5 个「支付宝授权函」docx **未入库**（untracked），但也**未被 .gitignore 覆盖**，仍躺在仓库根。

| 文件 | 是否入库（HEAD） | 是否在当前远端历史（origin/master 可达） | 内容类型 | 严重度 | 处置建议 |
|---|---|---|---|---|---|
| `data/postgres/**`（1300+ 文件，含 `base/1/*` 原始表数据） | 否（`/data/` 已 ignore） | **是**：初始提交 `9efb1374` 加入，`a9e5c4a5` 删除，历史仍可达 | PostgreSQL 原始数据目录（开发库全量：用户表、剪贴板条目等） | **S0** | `git filter-repo` 清史 + 双远端 force push + GitHub Support 清缓存 + 数据影响评估 |
| `data/backup_20260626_093500.sql` | 否 | **是**（`9efb1374` 加入） | 数据库 SQL 备份 | **S0** | 同上 |
| `data/redis/dump.rdb`、`appendonlydir/*.aof` | 否 | **是**（`9efb1374` 加入，`a9e5c4a5` 删除） | Redis 持久化（会话/验证码/缓存） | **S0** | 同上 |
| `backups/users_data_20260629.csv` | 否（已 ignore，但文件仍在本地磁盘） | **是**：`46f7ea10` 加入，`f6fb092c` 删除 | 用户导出：表头含 `phone,email,password_hash,phone_encrypted,email_encrypted`（2 行数据；本报告不摘录内容） | **S0** | 同上；本地文件移出仓库目录 |
| `.env.development` | 否 | 否（仅存在于被重写的旧历史 `753fdde6`，该提交不在 origin/master 祖先链上，但**曾出现在 `refs/original/refs/remotes/origin/master` 备份引用中，说明旧历史曾推送过远端**，GitHub 侧可能仍可按 SHA 访问） | 开发环境变量 | S1 | 清史时一并处理；其值与 `.env.test` 同为 `*_change_me` 占位，实际风险低 |
| `monitoring/prometheus/metrics-token` | **是**（HEAD 跟踪） | 是 | `/api/metrics` 的 Bearer 令牌，值为公开 dev 默认令牌（文档 `docs/deploy/monitoring-setup-guide.md:282-285` 明确生产 fail-closed、此为 dev 回退值） | S3 | 可接受；建议改 ignore + 提供 `.example` |
| `src/server/.env.test` | **是**（被 `!.env.test` 白名单） | 是 | 全部为 `dev_*_change_me` 占位值，非真实凭据 | S3 | 改名 `.env.test.example` 更稳妥 |
| `支付宝授权函-*.docx` ×5（仓库根，共 ~2.4MB） | 否（untracked） | 否 | 商务授权函，含签章/主体信息（可能含营业执照号等） | S2 | 移出仓库或加 `.gitignore`；一次 `git add .` 即泄漏 |
| `clipsync_events.log`（1.1GB，仓库根） | 否（`*.log` 已 ignore） | 否 | Docker 事件流日志，**内含 dev Redis 密码明文串**（`redis-cli -a <REDACTED:REDIS_PASSWORD> ping`，dev 值） | S2 | 删除；找出仍在追加它的游离 `docker events` 重定向进程（文件 mtime 为审计当日，仍在增长） |
| 硬编码密码扫描：`docker-compose.prod.yml` | — | — | **无写死密钥**：DB/Redis/JWT/ENCRYPTION/CSRF/ALIPAY 全部 `${VAR}` 无默认值（`docker-compose.prod.yml:11-13,43,100-102,115-119`） | ✅ | 保持 |
| `docker-compose.multi.yml:12,40,83-84` | 是 | 是 | **弱默认值写死**：`clipsync123`、`your-secret-key`、`your-32byte-encryption-key!!!!`，且 5432/6379 映射宿主 | S2 | 死配置带危险默认值，删除或去掉默认值（见问题清单） |
| `.env.*.example` 被代码当 fallback？ | — | — | 否。生产配置 `src/server/src/config/production.js:16,24,29` 对 DB_PASSWORD/REDIS_PASSWORD/JWT_SECRET 明确「NO default」；`src/server/src/utils/encryption.js:27-38` 对 ENCRYPTION_KEY 生产缺失/默认值/过短直接 fatal 退出 | ✅（但 JWT 见 S2-7） | — |

补充：`.git` pack 体积 466MB，其中大头即上述 `data/postgres` 历史对象——这也是仓库克隆慢的原因，清史可一并瘦身。

---

## 问题清单（按严重度从高到低）

### [S0-1] 公开仓库的 git 历史含数据库实体、SQL 备份、Redis 持久化与用户导出 CSV

- 证据：
  - `git log origin/master --name-only -- data/postgres/PG_VERSION` → 加入于 `9efb1374`（**当前 origin/master 的根提交**），删除于 `a9e5c4a5`；同批还有 `data/backup_20260626_093500.sql`、`data/redis/dump.rdb`、`appendonly.aof.*`（共 1367 个 `data/` 文件在 `9efb1374` 树中）。
  - `git log origin/master --name-only -- backups/users_data_20260629.csv` → 加入于 `46f7ea10`（提交信息「chore: 提交所有修改文件」），删除于 `f6fb092c`。CSV 表头：`id,phone,email,nickname,...,password_hash,...,phone_encrypted,email_encrypted,...`。
  - WebFetch 确认 `github.com/CarlosShao/ClipSync` 为 **public**；且按 `AGENTS.md` 约定双远端推送，`cnb.cool` 同样持有该历史。
- 失败场景：任何人 `git clone` 后 `git log --diff-filter=D` / 直接按 SHA checkout 即可拿到：开发库全量数据（用户账号、手机号、邮箱、密码哈希、加密剪贴板内容）、SQL 备份、Redis 会话。密码哈希可离线爆破；若开发库曾导入过真实用户数据（产品自己就在真机上用），即为真实用户隐私泄漏。这不需要任何「攻击」，现在就是可下载状态。
- 影响：合规（个保法/GDPR 类义务）、用户信任、安全。v1 上线前必须处置——上线后再爆出来就是公关事故。
- 修法：`git filter-repo` 清除 `data/`、`backups/users_data_*.csv`、`.env.development` 全部历史 → 双远端 force push → 提 GitHub Support 清除缓存视图与 fork → 评估泄漏数据是否含真实用户（若含，按个保法评估通知义务）→ 轮换所有曾出现在这些文件里的口令/密钥（至少 dev DB/Redis 口令与 JWT/加密密钥，若开发库曾用生产密钥则升级为生产轮换）。

### [S1-1] 生产入口配置不在仓库：nginx（TLS/WS/上传限制）、compose 本机覆盖、证书续期脚本全部只存在于服务器

- 证据：
  - `docs/deploy/production-server-runbook.md:60`「`docker-compose.prod.local.yml` 是本机专属覆盖（**不进仓库**）」；`:84-87`「**不要**对 `nginx/*.conf` 执行 `git checkout`……生产配置已另存为 `*.prod-local` 并写入 `.gitignore`」；`:227` 续期 cron 指向 `/opt/clipsync/certbot-renew.sh`（仓库无此文件，`git ls-files | grep certbot` 为空）。
  - `.gitignore:118-121` 显式 ignore `nginx/nginx.conf.prod-local`、`nginx/conf.d/clipsync.conf.prod-local`、`.env.production`、`nginx/certbot/`。
  - 仓库内唯一的 `nginx/conf.d/clipsync.conf` 是「多实例 HA 草稿」：upstream 指向不存在的 `clipsync-api-1/-2`（`nginx/nginx.conf:50-51`），443 段整体被注释（`clipsync.conf:84-99`），且**全文件无 `client_max_body_size`**（默认 1MB）。
- 失败场景：已经发生过一次——runbook `:85-86` 记录 2026-09-16 误 `git checkout -- nginx/` 导致**全站 HTTPS 挂掉**。此外：服务器磁盘损坏/被重装时，TLS 终结、WS 升级头、`proxy_read_timeout`、上传体积限制、3 站点分流的全部生产真相随之消失，无法从仓库重建；审计者（包括本次）无法验证生产 WS 超时与 body size 是否与后端 50MB 一致。
- 影响：可用性 + 可恢复性 + 不可审计。这是单点故障，且已有前科。
- 修法：把 `nginx/*.prod-local` 与 `docker-compose.prod.local.yml` **脱敏后入仓**（它们本身不含密钥，密钥走 `--env-file`），服务器上改为「仓库文件 + 薄覆盖」；`certbot-renew.sh` 入 `scripts/`。仓库里那份危险的 HA 草稿移到 `docs/` 或删除。

### [S1-2] 备份体系与文档承诺严重不符：上传文件零备份、生产 DB 备份从未验证过可恢复、无异地副本

- 证据：
  - 生产备份 = compose 内 hourly 循环 `pg_dump -Fc -f /backups/clipsync_*.dump`，落在宿主机 `/opt/clipsync/backups`（`docker-compose.prod.yml:146-180`、runbook `:58`）——**同机同盘，无异地**；dump 失败只 `echo FAILED`，无告警（`:176`）。
  - 全仓无任何对 `uploads/`（用户图片/文件，宿主机 bind mount `docker-compose.prod.yml:126`）的备份逻辑；prod compose 无 `STORAGE_TYPE`/S3 变量，即生产用本地盘存储。
  - `scripts/verify-backup.sh:35` 只找 `clipsync_*.sql.gz*`，`:130` 用 `gzip -t` 验完整性——**生产产物是 `.dump`（pg_dump -Fc 自定义格式），该脚本对生产备份完全失效**；且它 `docker exec clipsync-postgres`（`:175`），生产容器名是 `clipsync-<REDACTED:DB_HOST>`。
  - `docs/deploy/disaster-recovery.md:54-58` 宣称「每日 cron 02:00、本地+异地（推荐S3/OSS）、每周自动运行 verify-backup.sh」——三项均无对应实现；`docs/production-roadmap/phases-01-04.md:172` 把灾备标记为「✅ 已完成」。
- 失败场景：服务器磁盘损坏/云主机释放 → DB 备份与用户上传的媒体文件**同时**消失，用户付费同步的图片、文件全丢，DB 只能恢复到「从没验证过能否 restore」的最近一次 hourly dump（若 dump 一直在静默失败，则一无所有）。RPO 承诺 <1 小时仅对 DB 且仅在 dump 成功时成立。
- 影响：数据（用户资产）+ 钱（付费用户索赔/退订）+ 合规。
- 修法：备份容器加 uploads 打包（或生产切 MinIO/S3 + 版本化）；备份完成后跑一次 `pg_restore --list` 冒烟验证并失败告警；每日把最新 dump 推到异地（OSS/rclone 均可）；同时把 DR 文档改成与现实一致。

### [S1-3] 发版=停机、回滚脚本是空转的摆设、迁移无 down

- 证据：
  - 生产为单 API 容器（runbook `:52-58`），发版命令 `build api-prod` + `up -d`（runbook `:209-215`）→ 容器重建期间 API/WS 全断，无蓝绿/无 second instance；`docker-compose.prod.yml` 只有一个 `api-prod`。
  - `scripts/rollback.sh` 引用的现实全不存在：`deploy/current-version`（`:25`，仓库无 `deploy/` 目录）、`backups/*.version`（`:39`，无任何代码生成它）、`docker-compose down` 后 `restart`/`up` 的服务名 `api`/`postgres`（生产是 `api-prod`/`<REDACTED:DB_HOST>`）、`docker exec clipsync-postgres`（`:127`，生产容器名 `clipsync-<REDACTED:DB_HOST>`）、健康检查 `localhost:3000`（`:62`，生产宿主端口是 3002，runbook `:55`）。它还会把 `backups/docker-compose-<ver>.yml` 覆盖到 `docker-compose.yml`（`:84`）——没有任何流程产生该备份文件。
  - 迁移在启动时自动跑（`src/server/src/index.js:619`），失败 `process.exit(1)`——不会「代码新、库旧」，这点好；但 `src/server/src/db/migrations/`（72 个 SQL）**只有 up 没有 down**（`grep -n "down\|rollback" migrate.js migrate-manager.js` 为空），DB 层面无法回退。
- 失败场景：v1 发布后 30 分钟发现严重 bug——回滚路径是什么？`rollback.sh` 会在第一步 `No current-version file found` 后继续空转然后对着不存在的容器报错；实际可行的是「git checkout 旧 tag → 重新 build → up -d」，但**没有任何文档写过这条路**，且若新版已跑过 forward-only 迁移，旧代码可能不兼容新 schema。每次发版都有分钟级全站中断 + WS 集体掉线（同步中的客户端全部重连）。
- 影响：可用性 + 发版安全。上线后第一次热修就会踩到。
- 修法：runbook 增加「回滚 = checkout 上一 tag + build + up」的实测记录；迁移约定「只加列不改列、旧代码兼容 N-1 schema」；中期用镜像 tag 化（registry 或本地 `docker tag` 保留 N-1）实现分钟级回切。

### [S1-4] CI/CD 是「假绿灯」：lint 永不失败、测试失败不阻塞、deploy job 会对错误目标静默空转并报成功

- 证据：
  - `.github/workflows/ci.yml:56`：`npx eslint src/ --ext .js --max-warnings=0 || true`——注释写着「Lint（必须通过）」，实际 `|| true` 吞掉一切失败。
  - `ci.yml:75` test job `continue-on-error: true`，`:157` 测试步骤再套一层 `continue-on-error: true`。
  - `ci.yml:289-293` deploy job：`docker compose -f docker-compose.prod.yml restart backend || true`——**所有 compose 文件里都没有名为 `backend` 的服务**（生产是 `api-prod`），restart 必然失败但被 `|| true` 吞掉；整个 job 不重建镜像、不带 `--env-file .env.production`（违反 runbook `:9-17` 的铁律），最后 echo「🎉 部署完成」。
  - `docs/deploy/github-secrets.md:11-19` 还在指导配置 `DEPLOY_HOST/USER/SSH_KEY` 供该 job 使用。
- 失败场景：有人信任绿色 CI，用 workflow_dispatch 触发「部署」→ 服务器被 `git reset --hard origin/master` 拉了新代码、旧容器继续跑旧镜像、飞书通知「部署 success」→ 团队以为新版已上线，实际什么都没发生；下一次无关重启才「突然上线」了未经审视的代码。lint/测试全红也能合并。
- 影响：发版流程完整性 + 团队对信号的信任。
- 修法：去掉 lint 的 `|| true`；deploy job 要么删掉（现状真实发版走 runbook 手工），要么改为「build api-prod + `--env-file` + `up -d` + 健康检查 + 失败非零退出」并改成正确的服务名。

### [S2-1] `docker-compose.multi.yml` 是带危险默认值的死配置：弱密码 + DB/Redis 端口映射宿主

- 证据：`docker-compose.multi.yml:12` `POSTGRES_PASSWORD: ${DB_PASSWORD:-clipsync123}`、`:15-16` `ports: "5432:5432"`、`:43-44` Redis 同样映射 6379、`:83-84` `JWT_SECRET:-your-secret-key` / `ENCRYPTION_KEY:-your-32byte-encryption-key!!!!`。生产实际用的是 `prod.yml`（runbook `:52-58`），multi 仅被 `docs/deploy/multi-instance-deployment-guide.md` 引用。
- 失败场景：将来扩容/换人运维时有人照 multi 指南「一键起」→ Postgres/Redis 直接暴露公网 + 公开默认密码 = 数据库秒被拖库/勒索（互联网上 5432 扫描是分钟级的）。
- 影响：安全（潜在 S0，只因当前未使用而降级）。
- 修法：删除 multi.yml + 对应指南，或去掉所有 secrets 默认值、`ports: []`、加 `internal` 网络。

### [S2-2] `.env.production.example` 与 `docker-compose.prod.yml` 变量清单对不上：照抄模板部署必然复现 403/503 事故

- 证据：`docker-compose.prod.yml:110` 读 `CORS_ORIGINS`、`:115-119` 读 `ALIPAY_APP_ID/PRIVATE_KEY/PUBLIC_KEY/NOTIFY_URL/SANDBOX`、`:156` 读 `BACKUP_KEEP_DAYS`——`.env.production.example` **一项都没有**；example 里给的 `ALLOWED_ORIGINS`（`.env.production.example:36`）是 prod.yml 注释自认的死变量（`docker-compose.prod.yml:108`），`MAX_FILE_SIZE`（example:32）在 server 代码中零读取（上限硬编码在 `config/production.js:53-54`）。runbook `:182-192` 记录了 2026-09-19 因 CORS_ORIGINS 缺失导致「所有带 Origin 请求一律 403」的真实事故。
- 失败场景：换服务器/灾备重建时，新运维照 example 配 `.env.production` → 桌面端与管理台全部 403、支付 503，重演已记录过的事故。环境变量清单没有单一事实源。
- 影响：可用性 + 灾备可执行性。
- 修法：example 与 prod.yml 对齐（补 CORS_ORIGINS/ALIPAY_*/BACKUP_KEEP_DAYS，删死变量），并加注释指向 runbook。

### [S2-3] 容器日志无轮转配置；应用文件日志写在容器层不持久化

- 证据：五个 compose 文件均无 `logging:`/`max-size`（grep 为空）；`docker-compose.prod.yml` 无该项，api 依赖 docker json-file 默认（无上限，除非服务器 daemon.json 设了——仓库不可见，无法证明有）。应用侧 `src/server/src/utils/logger.js:82-90` 生产写 `/app/logs/clipsync-YYYYMMDD.log`（有 14 天滚动，好），但 `docker-compose.prod.yml:125-127` **没有挂载 logs 卷** → 日志留在容器可写层，容器重建即丢，排障时「上一次崩溃的日志」不存在。仓库根那个仍在增长的 1.1GB `clipsync_events.log` 证明本项目已经真实发生过「无人管的日志无限膨胀」。
- 失败场景：磁盘被 json-file 日志撑满（runbook `:60` 显示这是台内存/资源紧张的小机器）→ Postgres 写 WAL 失败 → 整站数据库宕机；或事故后想查日志发现容器已被 `up -d` 重建、日志清零。
- 影响：可用性 + 可观测性。
- 修法：prod.yml 每服务加 `logging: {driver: json-file, options: {max-size: 50m, max-file: 3}}`；`/app/logs` 加 bind mount。

### [S2-4] 生产 API 端口以 0.0.0.0 绑定宿主，绕过 nginx 直达应用

- 证据：`docker-compose.prod.yml:123-124` `ports: - "${API_PORT:-3000}:3000"`（runbook `:55`：宿主 3002）。未写 `127.0.0.1:` 前缀即绑定所有网卡；是否公网可达取决于阿里云安全组（仓库外，无法验证），但 runbook `:54` 声称 nginx 是「唯一对外入口」，配置并未保证这一点。
- 失败场景：安全组误开 3002（或换机器时复制了默认安全组）→ 客户端可直连 Node 应用，绕过 nginx 的 TLS/限流/头部策略；`X-Forwarded-For` 也由客户端自定。
- 影响：安全 + 可用性。
- 修法：改为 `127.0.0.1:${API_PORT:-3000}:3000`（nginx 容器同机走宿主回环或共享网络）。

### [S2-5] 限流信任可伪造的 X-Forwarded-For 首值

- 证据：`src/server/src/middleware/rateLimiter.js:248,376,394` `req.headers['x-forwarded-for']?.split(',')[0]?.trim()`；仓库内 nginx 草稿用 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`（`nginx/conf.d/clipsync.conf:32`）——`$proxy_add_x_forwarded_for` 是**追加**，客户端自带的首值原样保留；生产 nginx 配置不在仓库（S1-1），无法证明其覆盖为 `$remote_addr`。
- 失败场景：攻击者每次请求换一个伪造 XFF 首值 → 登录失败限流、发码限流（`config/production.js:43-45`：sendCode 5 次/时）全部失效 → 短信轰炸刷钱、密码爆破。
- 影响：安全 + 钱（短信费）。
- 修法：生产 nginx 用 `X-Forwarded-For $remote_addr` 覆盖；或后端改用 `trust proxy` + `req.ip` 并只信最后一跳。

### [S2-6] 桌面端 release 构建带 `--remote-debugging-port=9222` 且关闭 SmartScreen 保护

- 证据：`src/desktop/src-tauri/tauri.conf.json:26` `"additionalBrowserArgs": "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9222"`——只有这一份 conf（无 dev/release 分离），该参数会进入正式安装包。
- 失败场景：用户机器上任意本地进程（含恶意软件）可连 `127.0.0.1:9222` 的 CDP，读取 webview 中的剪贴板内容、JWT、支付宝扫码页 DOM——对一个「剪贴板+支付」产品这是本地提权级泄漏面；且 v1 正式包将带着它分发。
- 影响：安全（客户端）。
- 修法：调试参数移到 dev-only 配置（`tauri dev` 时注入），release conf 移除 9222 与 SmartScreen 关闭项。

### [S2-7] 生产缺 JWT_SECRET/CORS_ORIGINS 只 warn 不退出（与 ENCRYPTION_KEY 的 fail-fast 不一致）

- 证据：`src/server/src/config.js:84-106`：生产校验只 `console.warn`；对照 `src/server/src/utils/encryption.js:27-38` ENCRYPTION_KEY 是 `logger.error('FATAL...')` + 退出。JWT_SECRET 缺失时进程照常起，签发/校验 token 在运行期才炸。
- 失败场景：`.env.production` 漏一行（runbook 已记录过漏 `--env-file` 的真实事故）→ 服务「健康启动」但所有鉴权 500，或更糟——若某处对 undefined secret 有兜底，等于弱签名。
- 影响：可用性 + 安全。
- 修法：把 config.js 的 warnings 在 `NODE_ENV=production` 时升级为 fatal exit（与 encryption.js 对齐）。

### [S2-8] Android release 构建在 keystore 缺失时静默回退 debug 签名

- 证据：`src/mobile/android/app/build.gradle.kts:55-59`「有 key.properties 时用正式签名；缺失则回退 debug，保证构建不中断」；`key.properties` 不入库（正确）。
- 失败场景：换构建机/CI 上打包发布 APK → 得到 debug 签名包而无任何报错；若直接分发（非商店渠道），用户装了 debug 签名版，后续正式版签名不一致**无法覆盖安装**，等于让用户卸载重装、丢本地数据。
- 影响：发布质量 + 用户体验。
- 修法：release buildType 在 `hasReleaseKeystore=false` 时直接 `throw GradleException`，而不是回退。

### [S2-9] `docs/deploy/desktop-release-process.md` 指引的发布路径会触发一条必死的 K8s 部署流水线，且与 runbook 冲突

- 证据：该文档「Step 1」要求 `git tag v0.2.0 && git push origin v0.2.0`（`desktop-release-process.md:70-77`）；`.github/workflows/deploy.yml:13-17` 恰好在 `v*` tag 上触发，构建镜像后 `deploy-k8s`（`:107-166`）用 `KUBE_CONFIG_BASE64` 连一个**不存在的集群**（生产是单机 compose，runbook `:52-58`；仓库无任何 k8s 在用证据）。文档还说「GitHub Actions 构建 + 签名 + 上传 Release」，但 `.github/workflows/` 里**没有桌面构建 workflow**；runbook `:109-118` 明确「托管在自有域名 downloads/，**不走 GitHub Releases**，本地 pwsh 构建 + scp」。另 `deploy.yml:316` 的 `fromJSON('["false","true"]')[env.IS_PRERELEASE == 'true']` 是非法表达式（布尔不能做数组下标）。
- 失败场景：发桌面新版的人照文档打 tag → deploy.yml 跑起来 → 推一个没人用的 ghcr 镜像 → K8s 部署步骤红 → 飞书/邮件「生产部署失败」告警 → 发布人误以为线上出事；同时文档间互相矛盾，新人不知道以哪份为准。
- 影响：发布流程可信度。
- 修法：删除或 `workflow_dispatch`-only 化 deploy.yml；`k8s/` 移入 `docs/archive/` 或删除；desktop-release-process.md 与 runbook §3.1 合并成一份事实源。

### [S3-1] 仓库根 1.1GB `clipsync_events.log` 仍在增长，来源不明

- 证据：文件 mtime 为审计当日（`ls -la`：1158042678 字节）；内容是 `docker events` 流（首行 `container exec_create: redis-cli -a <REDACTED:REDIS_PASSWORD> ping ...`）；全仓 grep `clipsync_events` 零引用——是某个游离的后台重定向在写。已被 `*.log` ignore，不会入库。
- 失败场景：本地磁盘被慢慢吃掉；文件含 dev Redis 密码字样，随手打包外发即泄漏。
- 修法：删文件、找出并停掉写它的进程；此类事件流如需保留应带轮转。

### [S3-2] `scripts/` 运维脚本群与现实环境脱节，属误导性死代码

- 证据：`scripts/backup-db.sh:24` `docker exec clipsync-postgres pg_dump -U clipsync clipsync`（生产容器 `clipsync-<REDACTED:DB_HOST>`、库名/用户来自 env）；`scripts/dr-drill.sh:68,107` 操作服务名 `api`/`postgres`（不存在）且用 `docker-compose`（v1 命令）；`scripts/verify-backup.sh` 见 S1-2；`rollback.sh` 见 S1-3。四个脚本没有任何一个能在生产环境按原样跑通。`scripts/migrations/` 5 个 SQL（003/004/005/010/011）**零引用**，且编号与真实的 `src/server/src/db/migrations/`（000-074）冲突撞号。
- 失败场景：出事时运维照文档跑脚本，在最脆弱的时刻收获一堆「No such container」。
- 修法：脚本参数化（容器名/库名走 env）并在 staging 实测一次，或删除；`scripts/migrations/` 直接删。

### [S3-3] 已入库的仓库杂物（详见「仓库卫生处置表」）

- 证据：`git ls-files` 确认 `src/bak/**`（1.8MB 旧桌面端备份）、`audit-out-day2/*.png`（21 张，2.3MB）、`gui-test-screenshots/*.png`、`tasks/done/*.md`、`_c_smoke.mjs`、`src/server/fix-merged-lines.{js,mjs}`、`src/server/fix-subscriptions.js`、`src/admin-console/*.png` 均被跟踪；`clipboard-dump/target/**`（含 .exe/.pdb/.o，数十 MB）曾入库、后删除但仍在历史（`.git` 466MB 的另一贡献者）。
- 修法：一次性 `git rm --cached` 清理 + 归档到 `docs/audit/` 或删除。

### [S3-4] monitoring/ 与 k8s/ 为死配置（生产明确不用）

- 证据：runbook `:63`「**监控栈（Prometheus/Grafana）故意不部署**——内存受限」；`docker-compose.monitoring.yml:63` feishu webhook 仍是占位符 `"<FEISHU_WEBHOOK_URL>"`（起了也发不出告警）；k8s/ 无任何真实集群对应（S2-9）。`monitoring/prometheus/prometheus.yml` 抓取目标指向的服务名在生产网络不存在。
- 修法：保留可以（作为未来选项），但要在目录 README 首行标注「当前未部署，配置未验证」；或移入 `docs/archive/`。

### [S3-5] README 部署/启动说明失真

- 证据：`README.md:143-145`「Docker 部署：`docker-compose up -d`」——基础 `docker-compose.yml` 只有 networks/volumes **没有任何 service**，该命令什么都不起；`README.md:149-152`「复制 `.env.production` 为 `.env`」——仓库只有 `.env.production.example`；`README.md:40-46` 说后端起在 3000，而 AGENTS.md 约定的 docker dev 实际是 3001（`docker-compose.dev.yml:119`）。
- 修法：README 指向 runbook / developer-guide，删除失真命令。

### [S3-6] `admin-console.yml` 触发分支不含 master，永远不会跑

- 证据：`.github/workflows/admin-console.yml:5` `branches: ['feature/admin-console', 'dev/cnb', 'main']`；仓库实际主分支是 `master`（ci.yml 注释「触发分支是 master（你的仓库实际分支）」，`git branch` 无 `main`）。
- 修法：分支列表加 `master` 或删该 workflow。

---

## docker-compose.prod.yml 逐项核对表

| 检查项 | 现状 | 判定 |
|---|---|---|
| restart 策略 | 全服务 `restart: always`（`:9,39,79,149`） | ✅ |
| depends_on + service_healthy | api 依赖 postgres/redis 均 `condition: service_healthy`（`:128-132`） | ✅ |
| 健康检查 | postgres `pg_isready`（`:19-24`）、redis `redis-cli ping`（`:50-55`）、api 由镜像内 HEALTHCHECK 覆盖（`src/server/Dockerfile:76-77`，wget /api/health） | ✅ |
| DB/Redis 端口暴露 | `ports: []`（`:15,47`），仅内部网络 | ✅ |
| API 端口暴露 | `"${API_PORT:-3000}:3000"` 绑 0.0.0.0（`:123-124`） | ⚠️ S2-4 |
| 资源限制 | 每服务 `mem_limit`+`cpus`（`:29-30,60-61,137-138,166-167`） | ✅ |
| volume 持久化 | DB/Redis 命名卷；uploads、backups bind mount（`:125-127`）；**/app/logs 未挂载** | ⚠️ S2-3 |
| 环境变量注入 | `environment` + `${VAR}` 插值，secrets 无默认值，值来自服务器 `.env.production`（600 权限，runbook `:46`） | ✅（example 不同步 → S2-2） |
| 网络隔离 | 单网络 `clipsync-prod-net`，`internal: false`（`:182-185`），未分 frontend/backend | ⚠️ 轻微（单机可接受） |
| 日志驱动与轮转 | **无任何 `logging:` 配置** | ❌ S2-3 |
| 容器用户 | 镜像 `USER clipsync`（Dockerfile:67）+ `no-new-privileges` | ✅ |
| TLS 终结 | 不在本 compose——在服务器本机 nginx 容器（配置未入仓） | ❌ S1-1 |
| 自动备份 | backup 容器 hourly pg_dump -Fc + 14 天清理（`:146-180`） | ⚠️ 有但同机、未验证、无告警（S1-2）；`./backups` 同时以 rw 挂给 api（`:127`），API 被攻破可篡改/删除备份 |
| Dockerfile | 多阶段 ✅、非 root ✅、HEALTHCHECK ✅、层缓存（package*.json 先 COPY）✅、`.dockerignore` 存在（91B，含 node_modules/.env/.git）✅、生产依赖 `npm ci --only=production` ✅ | ✅ 质量良好 |

## nginx 配置逐项核对表

**前提：生产真实生效的 nginx 配置不在仓库（S1-1），下表核对的是仓库内的两份文件（`nginx/nginx.conf` + `nginx/conf.d/clipsync.conf`，即 multi 实例草稿）。**

| 检查项 | 仓库内配置 | 生产实际 | 判定 |
|---|---|---|---|
| TLS 版本/套件 | 443 段整体被注释（clipsync.conf:84-99），注释里是 `TLSv1.2 TLSv1.3`（无 1.0/1.1，好） | runbook `:224-231`：Let's Encrypt、6 SAN、到期 2026-12-14、每周一 cron 续期 + dry-run 演练记录 | 生产侧机制存在；**但仓库无法审计实际 ssl_protocols/ciphers** |
| HTTP/2 | 注释段有 `http2` | 不可知 | ⚠️ 入仓后可审 |
| HSTS / CSP / Referrer-Policy | 无（只有 X-Frame-Options DENY、nosniff、X-XSS-Protection，clipsync.conf:9-11） | 不可知 | ❌ 至少草稿缺 HSTS/CSP |
| server_tokens off | 无 | 不可知 | ❌ |
| WebSocket 升级 | `/ws/` 有 Upgrade/Connection 头 + `proxy_read_timeout 86400s`（:45-56），配置本身合格 | 不可知（runbook `:70` 提到主配置含 `map $http_upgrade`，倾向已配） | ⚠️ 无法验证 = S1-1 的一部分 |
| client_max_body_size | **未设置**（默认 1MB） | 不可知 | ❌ 若生产同样未设，>1MB 上传全部 413（后端上限 50MB，`config/production.js:54`）；必须在入仓后核对 |
| X-Forwarded-For/Proto | 有传（:32-33），但用 `$proxy_add_x_forwarded_for`（可被客户端预置首值） | 不可知 | ⚠️ S2-5 |
| 静态资源缓存策略 | 无任何 `expires`/`Cache-Control`（官网/管理台是静态站，index.html 缓存策略在生产配置里，不可知） | 不可知 | ⚠️ |
| rate limit | zone 已定义（nginx.conf:38-39）但 `limit_req` **被注释「临时关闭以方便测试」**（clipsync.conf:40-41,58-59） | 不可知 | ❌ 草稿状态就是关闭的 |
| 敏感路径暴露 | `/uploads/` 直接反代（:63-67）；无 `/metrics`、`.git`、备份文件的 deny 规则 | 不可知 | ⚠️ |
| 日志格式 | main 格式含 XFF（nginx.conf:18-20），无 request-id 关联 | — | ⚠️ 轻微 |

## 备份/灾备/回滚能力评估

**现状**：
- DB：生产每小时 `pg_dump -Fc` 到同机 `/opt/clipsync/backups`，保留 14 天，失败仅打日志（compose backup 容器）。另有管理台手动备份 API（`src/server/src/routes/admin/ops.js:264-314`，含备份下载端点——理论上可人工拉异地副本，但无流程/无排班）。
- 用户上传媒体：**零备份**（本地盘 bind mount，无 S3、无打包脚本）。
- Redis：AOF 开着但无备份（定位为缓存，可接受——但 prod 用 Redis 存会话/限流态，重建后全员重新登录，属可接受损失）。
- 验证：`verify-backup.sh` 只能验 `.sql.gz`（scripts/backup-db.sh 的产物），对生产 `.dump` 无效且容器名不对 → **生产备份从未被验证过可恢复**（仓库与 docs 中无任何演练记录；`dr-drill.sh` 无一次执行留痕，`backups/` 下无 drill 日志）。
- 回滚：代码回滚无文档化路径（S1-3）；DB 无 down migration；`rollback.sh` 不可用。

**真出事能恢复到什么程度**：
- 场景 A（误删数据/逻辑 bug 污染库）：能恢复到最近整点 dump——前提是 dump 一直在成功且能 restore（未验证），RPO ≤1h，媒体文件不受影响。**中等信心**。
- 场景 B（磁盘/整机丢失）：DB 与备份同盘同灭 → **全量数据丢失**，只能从 0 建库；媒体文件必然全丢；nginx 生产配置、`.env.production`（含支付宝私钥、JWT/加密密钥）同盘丢失且无异地副本 → **加密数据即使有 DB 副本也无法解密**。当前答案是：**恢复不了**。
- 场景 C（发新版炸了）：无标准回滚路径，靠手工 checkout+rebuild，DB schema 不可回退。

**缺口清单**（按优先级）：异地副本（DB dump + uploads + `.env.production` 密钥托管）、恢复演练并留档、backup 容器失败告警（哪怕 webhook）、uploads 纳入备份、回滚 runbook。

## 发布流程还原（代码合并 → 用户用上新版）

**后端**（事实源：runbook §5）：
1. 本地开发（docker-compose.dev.yml）→ push 双远端（origin+cnb，AGENTS.md）。
2. **人工**：SSH 到 `/opt/clipsync` → `git pull`（未见文档明写，隐含）→ `docker compose --env-file .env.production -f prod.yml -f prod.local.yml build api-prod` → `up -d`。
3. 容器重建期间全站中断（分钟级），WS 全断；启动时自动跑 forward-only 迁移，迁移失败则容器 crash-loop（`restart: always` + `process.exit(1)`）——**失败会表现为反复重启而非明确回滚**。
4. 无部署后自动验收、无自动回滚、无部署记录（`.last_deploy_commit` 只存在于那条坏掉的 CI deploy job 里）。
- 风险点：步骤 2 的 `--env-file` 铁律靠人记住（有一次全站 502 前科，runbook §0）；`git checkout -- nginx/` 类误操作有全站 HTTPS 挂掉前科。

**桌面端**（事实源：runbook §3.1，与 desktop-release-process.md 冲突，以后者为准会踩坑）：
1. 本地 `pwsh scripts/build-desktop-installer.ps1`（签名私钥 `~/.tauri/clipsync.key`，**无口令**——拿到构建机即可签任意「官方」更新包；公钥已正确烧入 `tauri.conf.json:54`）。
2. `scp` exe+sig 到服务器 `/opt/clipsync/downloads/`（nginx `/downloads/` 托管）。
3. 管理台/SQL 登记 `app_releases` 发布单（version/url/signature/rollout_percent/force_update，支持灰度与强更——这套设计不错）。
4. 客户端 updater 轮询 `https://updates.clipchain.top/api/app/updates/latest`（与 tauri.conf.json:53 一致 ✅）。
- 风险点：打 `v*` tag 会触发死的 deploy.yml（S2-9）；签名私钥无口令且只在一台开发机（github-secrets.md 自己都写了「私钥丢失=无法再发布任何更新」，无离线备份证据）。

**移动端**：`build.gradle.kts` 版本走 flutter pubspec（`0.1.0+1`）；release 签名依赖本机 `key.properties`（未入库，正确），缺失时静默 debug 签名（S2-8）；上架流程文档齐（docs/publish/android/、domestic-android-publish-guide.md），软著/备案为外部依赖不计。

**官网**：CI 只产 artifact（website.yml，构建+备案号断言 `npm run check`，合格）；发布是服务器上手工 `npm run build && cp -a dist nginx/sites/website`（runbook §3）——可重复、有完整性断言，但同样无版本记录。

**三端兼容策略**：无 API 版本化（全部裸 `/api/*`）；有 `force_update` 与 `rollout_percent` 机制（`src/server/src/routes/app.js:263-311`）可作最低版本强更的抓手，但**没有 min-version 字段/强制拦截逻辑**——旧客户端连新后端全靠「接口别改坏」的默契。属设计观察，见下节。

## 仓库卫生处置表

| 路径 | 是否入库(HEAD) | 内容/体积 | 建议处置 |
|---|---|---|---|
| `clipsync_events.log` | 否（ignored） | docker events 流，1.1GB，**仍在增长**，含 dev redis 密码串 | 删除 + 找到并停掉写入进程（S3-1） |
| `支付宝授权函-*.docx` ×5 | 否（untracked，**未被 ignore**） | 商务授权函 ~2.4MB，含签章/主体信息 | 移出仓库目录；或加 `*.docx`/显式 ignore（S2 级风险敞口） |
| `data/`（postgres/minio/redis/backup sql/corrupted） | 否（ignored；**但在公开远端历史中**） | 本地 597MB，含开发库实体与用户数据 | 历史清除（S0-1）；本地整目录移出仓库 |
| `backups/users_data_20260629.csv` | 否（ignored；**在公开远端历史中**） | 用户导出（2 行） | 历史清除（S0-1）；本地删除或移走 |
| `backups/old-settings-v1/` | **是** | 旧 Vue 组件备份 | git rm，归档到 git 历史即可 |
| `clipboard-dump/` | 部分（Cargo.toml/lock/src 入库；target/ 已 ignore 但曾在历史） | Rust 小工具 6.1MB | 工具保留可接受；target 历史随 filter-repo 一并清 |
| `audit-out-day2/` | **是**（21 png + json） | 2.3MB 审计截图 | 移 `docs/audit/` 或删除 |
| `test-output/` | 否（ignored） | 1.8MB | 删除 |
| `gui-test-screenshots/` | **是**（3.2MB png） | GUI 测试截图 | 移 docs 或删除 |
| `ui-prototype/` | **是**（glm/minimax 被显式白名单入库） | 2.1MB 设计原型 | 团队有意保留（.gitignore 注释），可接受；建议移 `design/` |
| `documents/` | 否（ignored） | 52KB | 删除或明确用途 |
| `design/` | **是** | logo/mockups | 合理，保留 |
| `tmp/`、`tmp-desktop-build.log` | 否（ignored） | 构建日志 | 定期清 |
| `StreamApiTest/` | **是** | Bruno API 集合（environments 里 token 为空，干净） | 保留可接受，建议移 `tests/api/` |
| `src/bak/` | **是**（1.8MB） | 旧桌面端代码备份 | git rm（有 git 还要 bak 目录属反模式） |
| `src/stash-lint.log`、`src/admin-console/*.log` | 否（ignored） | 排查残留 | 删除 |
| `src/admin-console/*.png` ×3 | **是** | 验证截图 | git rm |
| `src/server/fix-merged-lines.{js,mjs}`、`fix-subscriptions.js` | **是** | 一次性修数脚本 | git rm 或移 `scripts/oneoff/` 并注明已执行 |
| `_c_smoke.mjs` | **是** | 冒烟脚本残片 | git rm |
| `.worktrees/` | 否（ignored） | 两个完整 worktree（各含 Dockerfile 副本） | 本地清理 |
| `k8s/`、`monitoring/`、`docker-compose.multi.yml`、`docker-compose.monitoring.yml` | **是** | 死配置 | 归档到 `docs/archive/` 或加显著「未部署」标注（S3-4/S2-1） |
| `tasks/` | **是** | agent 任务记录 | 团队自定；建议移 docs |

## 文档漂移清单（文档说的 vs 实际）

| # | 文档说法 | 实际 | 严重度 |
|---|---|---|---|
| 1 | `disaster-recovery.md:54-58`：每日 02:00 cron 备份、异地 S3/OSS、每周自动 verify | hourly compose 备份、同机、verify 脚本对生产格式无效、无 cron 证据 | S1（伴随 S1-2） |
| 2 | `phases-01-04.md:172`：灾备「✅ 已完成（dr-drill.sh 3级演练）」 | dr-drill.sh 服务名/容器名全不对，无一次演练留痕 | S2 |
| 3 | `disaster-recovery.md:45`：`scripts/backup-db.sh restore` 可恢复数据 | backup-db.sh 无 restore 分支，传 `restore` 会当作备份类型再 dump 一次 | S2 |
| 4 | `disaster-recovery.md:160`、`deployment.md` 恢复命令：`docker exec -i clipsync-postgres psql -U clipsync` | 生产容器名 `clipsync-<REDACTED:DB_HOST>`，用户/库名来自 env | S2 |
| 5 | `deployment.md:5`：「部署方式: Kubernetes (推荐)」+ 全文 K8s 教程 | 生产是单机 docker compose；K8s 集群不存在 | S2（runbook 已声明以己为准，但该文档仍以「生产部署指南」名义存在） |
| 6 | `desktop-release-process.md`：打 tag → GitHub Actions 构建签名 → GitHub Releases 托管 | 无桌面 CI workflow；runbook §3.1 明确本地构建 + 自有域名托管、「不走 GitHub Releases」；打 tag 反而触发死的 deploy.yml | S2（两文档直接互斥） |
| 7 | `github-secrets.md:11-19`：DEPLOY_HOST/USER/SSH_KEY 供自动部署 | 对应 deploy job 重启不存在的服务、不重建镜像，等于不可用 | S2 |
| 8 | `README.md:143-152`：`docker-compose up -d` 即部署、`cp .env.production .env` | 基础 compose 无 service；仓库无 `.env.production` | S3 |
| 9 | `.env.production.example` 变量清单 | 缺 CORS_ORIGINS/ALIPAY_*/BACKUP_KEEP_DAYS，含死变量 ALLOWED_ORIGINS/MAX_FILE_SIZE | S2（=S2-2） |
| 10 | `README.md:46` / `developer-guide.md:47`：后端起在 3000 | docker dev 实际 3001（compose `:119`）；仅裸 `npm run dev` 是 3000，两种模式并存但文档不区分 | S3 |
| 11 | runbook 本身 | **与实况一致**（端口 3002、容器名、--env-file 铁律、事故复盘都对得上配置）——这是全仓质量最高的一份运维文档，应确立其唯一权威地位 | ✅ |

## 设计层面的观察

1. **「文档权威」错位**：runbook 是唯一与现实一致的文档，但 deployment.md/DR.md/desktop-release-process.md 等更「正式」的文档全是过期幻想。新人（或半年后的自己）会先读到错的那份。建议：过期文档统一移 `docs/archive/` 并在首行加废弃声明。
2. **生产真相分散在三处不可版本化的地方**：服务器上的 `.env.production`、`nginx/*.prod-local`、`docker-compose.prod.local.yml`。三者任何一个丢失都不可重建（密钥丢失还意味着加密数据不可解）。密钥托管属外部依赖不苛责，但 nginx/compose 覆盖文件完全可以脱敏入仓。
3. **无 API 版本化 + 无最低版本强制**：三端发布节奏不同（桌面走 updater 灰度、移动端走商店审核周期数天），后端一旦改了字段/语义，旧客户端静默坏。已有 `force_update`/`rollout_percent` 基础设施，缺一个 `min_supported_version` 拦截（返回特定错误码引导升级）。
4. **fail-fast 不一致**：ENCRYPTION_KEY 缺了会 fatal（好），JWT_SECRET/CORS 缺了只 warn（坏），compose 变量缺了 redis 会以奇怪方式崩（runbook §0 记录过）。启动期一次性校验所有必需 env 并硬失败，是性价比最高的一类加固。
5. **做得好的地方要说**：prod compose 的资源限制/健康检查/depends_on/no-new-privileges/非 root/DB 不暴露端口全部到位；Dockerfile 多阶段+dockerignore 规范；迁移在监听前同步执行避免了 schema 竞态；/api/metrics 生产 fail-closed；发布单支持灰度+强更；证书续期有 cron+dry-run 记录。这不是一个草台班子配置，主要问题是「仓库里的世界」与「服务器上的世界」脱节。

## 建议补充的能力（按性价比排序）

1. **git 历史清除 + 泄漏数据影响评估**（S0，一次性工作量半天，filter-repo + force push + GitHub 工单）。
2. **生产 nginx/compose 覆盖文件脱敏入仓**（S1，1 小时；入仓后立即补审 client_max_body_size、WS 超时、HSTS、rate limit 的生产实际值）。
3. **备份三件套**：uploads 纳入备份、dump 后自动 `pg_restore --list` 验证 + 失败告警（飞书 webhook 已有基建）、每日异地推送（rclone→任一对象存储，S1，半天）。
4. **prod compose 加 logging max-size + /app/logs 挂载**（S2，10 分钟）。
5. **回滚 runbook**：写明「checkout 上一 tag → build → up -d」并实测一次记录耗时；镜像本地 tag 保留 N-1（S1，半天）。
6. **CI 修真**：lint 去掉 `|| true`；deploy job 修正服务名+加 `--env-file`+build+健康检查，或直接删除（S1，2 小时）。
7. **启动期必需 env 校验 fail-fast**（S2，1 小时）。
8. **API 端口绑 127.0.0.1 + XFF 覆盖式转发**（S2，nginx 入仓后一并改）。
9. **release 构建剥离 remote-debugging-port**（S2，30 分钟）。
10. **仓库大扫除**：按处置表 git rm 杂物、删/归档 k8s+multi+monitoring 死配置、删 1.1GB 日志（S3，2 小时，顺带 .git 瘦身 400MB+）。
