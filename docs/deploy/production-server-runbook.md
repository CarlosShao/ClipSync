# 生产服务器运维手册（阿里云 ECS）

> 对象：`root@182.92.108.240`（`/opt/clipsync`）
> 这份文档记录**本机实际生效**的命令与踩过的坑。`docs/deploy/deployment.md` 是通用模板，
> 两者冲突时以本文件为准（本文件对应真实部署：3 站点 + nginx 容器 + 本地覆盖文件）。

---

## 0. 一条铁律：`--env-file .env.production`

生产栈**必须**这样启动：

```bash
cd /opt/clipsync
docker compose --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.prod.local.yml up -d
```

### 为什么（真实事故，2026-09-16）

`docker-compose.prod.yml` 里大量使用 `${REDIS_PASSWORD}` / `${DB_USER}` 这类变量插值：

```yaml
# docker-compose.prod.yml:40-46
redis-prod:
  command: >
    redis-server
    --appendonly yes
    --requirepass ${REDIS_PASSWORD}     # ← 变量为空时，这一行塌陷成 "redis-server ... --requirepass --maxmemory 256mb ..."
```

而 `.env.production` **不是** compose 默认读取的 `.env`，所以漏掉 `--env-file` 时：

- `${REDIS_PASSWORD}` 展开成**空串**
- redis 启动命令变成 `--requirepass --maxmemory 256mb` → redis 认为 `--maxmemory` 是密码
- → `FATAL CONFIG FILE ERROR: 'requirepass "--maxmemory" "256mb"' wrong number of arguments`
- → redis 反复崩溃重启 → 依赖它的 api / nginx 起不来 → **全站 502**

**已做的加固**：本机已把 `.env` 做成指向 `.env.production` 的软链，漏写 `--env-file` 也不会再塌：

```bash
ln -sfn .env.production .env
```

> ⚠️ 软链只是兜底，**命令里仍要显式写 `--env-file`**。
> `.env.production` 权限 `600`，含 JWT_SECRET / ENCRYPTION_KEY / 各密码，**永远不要提交**。

---

## 1. 组件与端口

| 容器 | 镜像 | 宿主端口 | 说明 |
|---|---|---|---|
| `clipsync-nginx` | nginx（含 3 个站点） | 80 / 443 | 唯一对外入口 |
| `clipsync-api-prod` | `clipsync-api-prod`（本地构建） | 3002 | Node 22 / Express 5 |
| `clipsync-postgres-prod` | postgres | 不暴露 | 数据卷 `postgres_prod_data` |
| `clipsync-redis-prod` | redis:7-alpine | 不暴露 | 数据卷 `redis_prod_data` |
| `clipsync-backup-prod` | — | — | 每小时 dump 到 `/opt/clipsync/backups/` |

`docker-compose.prod.local.yml` 是本机专属覆盖（**不进仓库**）：内存上限 api 640m / pg 384m /
redis 192m / backup 128m，`API_PORT=3002`。

**监控栈（Prometheus/Grafana）故意不部署** —— 内存受限。

---

## 2. nginx 站点布局

```
nginx/nginx.conf                     主配置（含 map $http_upgrade $connection_upgrade）
nginx/conf.d/clipsync.conf           3 组 server 块，按 Host 分流
nginx/sites/website/                 官网构建产物  → 挂 /usr/share/nginx/sites/website
nginx/sites/admin/                   管理台构建产物 → 挂 /usr/share/nginx/sites/admin
```

| Host | 内容 |
|---|---|
| `api.clipchain.top` | 反代 api-prod:3002，含 `/api`、法务页、`/ws` 升级 |
| `ws.clipchain.top` | WebSocket 反代 |
| `updates.clipchain.top` | Tauri 更新端点（`update.json` / `version`） |
| `www.clipchain.top` + `clipchain.top`（裸域） | 官网静态站 |
| `admin.clipchain.top` | 管理台静态站（SPA 深链回退到 index.html） |

> ⚠️ **不要**对 `nginx/*.conf` 执行 `git checkout`。
> 仓库里的那份是「多实例 HA 草稿」（upstream 指向不存在的 `clipsync-api-1/-2`、443 段全注释），
> 2026-09-16 误 checkout 曾导致重启后**全站 HTTPS 挂掉**。
> 生产配置已另存为 `*.prod-local` 并写入 `.gitignore`。

---

## 3. 更新官网

官网是**构建期注入**的静态站（备案号走这个管线）：

```bash
cd /opt/clipsync/src/website
npm run build                      # tsc --noEmit && vite build
npm run check                      # 产物完整性 + 备案号断言，必须 PASS
rm -rf /opt/clipsync/nginx/sites/website
cp -a dist /opt/clipsync/nginx/sites/website
```

- 备案号常量在 `src/data/icp.ts`（环境变量 `VITE_ICP_LICENSE` 可覆盖）
- `npm run check` 会断言页脚出现备案号**且**是链到 `beian.miit.gov.cn` 的 `<a>`
- 服务器上**没有 rsync**，用 `cp -a`

## 4. 更新管理台

```bash
cd /opt/clipsync/src/admin-console
VITE_API_BASE=https://api.clipchain.top/api VITE_ENABLE_MSW=false npm run build
rm -rf /opt/clipsync/nginx/sites/admin
cp -a dist /opt/clipsync/nginx/sites/admin
# 构建产物里的 mockServiceWorker.js 必须删掉，否则管理台会显示 MOCK 数据
rm -f /opt/clipsync/nginx/sites/admin/mockServiceWorker.js
```

## 5. 更新后端

法务页（`views/`、`public/`）与业务代码都**烤进镜像**，改完必须重建：

```bash
cd /opt/clipsync
docker compose --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.prod.local.yml build api-prod
docker compose --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.prod.local.yml up -d
```

> `src/shared/` 通过 `additional_contexts` 以命名上下文 `shared` 传入构建
> （构建上下文是 `./src/server`，够不到仓库根的 `src/shared`）。
> 缺这个配置 api 启动即 `ERR_MODULE_NOT_FOUND: /shared/domains.js`。

---

## 6. HTTPS 证书

- Let's Encrypt，`/etc/letsencrypt/live/api.clipchain.top/`
- **6 个 SAN**：`api` / `ws` / `updates` / `www` / `admin` / 裸域 `clipchain.top`
- 到期 **2026-12-14**，自动续期 cron：`30 3 * * 1 /opt/clipsync/certbot-renew.sh`
- webroot 模式，走 `/var/www/certbot`

**权限坑**：`/etc/letsencrypt/live` 与 `archive` 默认 `drwx------`，nginx worker（user `nginx`）
读不到证书 → TLS 握手被 reset（`SSL_ERROR_SYSCALL` / `errno=104`）。已修为目录 `755`、`*.pem` `644`。

```bash
# 续期演练（务必保留 --dry-run 先验证）
docker run --rm -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/www/certbot:/var/www/certbot certbot/certbot renew --dry-run
```

---

## 7. ICP 备案

- 主体备案号 **苏ICP备2026067775号**（主办单位：邵伟琦）
- 网站备案号 **苏ICP备2026067775号-1**（网站名称：网页分享，域名 `clipchain.top`）
- 管局审核通过：**2026-09-16**

`clipchain.top` 备一次即可，`api.` / `www.` / `admin.` / `ws.` / `updates.` **子域无需单独备案**。

备案号展示位置（事实源 `src/website/src/data/icp.ts`）：

| 页面 | 位置 |
|---|---|
| 官网首页 / 404 | 构建期由 `vite.config.ts` 插件注入 |
| 6 个法务页 | 源码内字面量（`express.static` 托管，不经构建管线） |

备案后义务：号展示在底部（已做）、主体/服务器/域名变更需做变更备案、每年配合真实性核验短信。

---

## 8. 排障速查

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep clipsync
docker logs --tail 50 clipsync-api-prod
docker logs --tail 50 clipsync-redis-prod       # redis 起不来先看这里
docker inspect clipsync-api-prod --format '{{.State.Health.Status}}'
```

**不要**在服务器上用 `curl https://...` 直连自己的 443：走 FlClash/本机 DNS 会踩假 IP，
且 `openssl s_client` 可能挂住并卡死 SSH 会话。容器内自测用：

```bash
docker exec clipsync-nginx wget -qO- --no-check-certificate \
  --header="Host: www.clipchain.top" https://127.0.0.1/
```

公网验收从**本机**发（`--resolve` 绕开本地 DNS）：

```powershell
curl.exe -s -o NUL -w "%{http_code}" --resolve "api.clipchain.top:443:182.92.108.240" https://api.clipchain.top/api/health
```
