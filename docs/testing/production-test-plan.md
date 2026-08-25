# ClipSync 生产级全面测试文档

> **文档版本**: v3.0
> **适用版本**: ClipSync 0.1.0+
> **最后更新**: 2026年6月27日
> **文档 owner**: 产品测试专员
> **目标**: 将产品测试至可商用部署的质量标准
>
> **v3.0 更新说明**：补充移动端功能测试完整用例（第13章），新增设备管理测试（6.8），修复章节编号错误，更新所有汇总表。

---

## 目录

1. [测试环境总览](#1-测试环境总览)
2. [外部依赖验证清单](#2-外部依赖验证清单)
3. [后端服务 Docker 容器化部署](#3-后端服务-docker-容器化部署)
4. [移动端App编译与安装](#4-移动端app编译与安装)
5. [PC桌面客户端编译与安装](#5-pc桌面客户端编译与安装)
6. [端对端同步全流程测试](#6-端对端同步全流程测试)
7. [异常场景与回滚方案](#7-异常场景与回滚方案)
8. [性能与压力测试](#8-性能与压力测试)
9. [安全测试](#9-安全测试)
10. [准出条件与生产环境就绪判定](#10-准出条件与生产环境就绪判定)
11. [测试报告模板](#11-测试报告模板)
12. [桌面端功能测试](#12-桌面端功能测试)
13. [移动端功能测试](#13-移动端功能测试)
14. [附录A：快速验证检查清单](#附录a快速验证检查清单)
15. [附录B：联系方式与升级路径](#附录b联系方式与升级路径)

---

## 1. 测试环境总览

### 1.1 硬件要求

| 设备类型 | 最低配置 | 推荐配置 | 用途 |
|-----------|-----------|-----------|------|
| 测试服务器 | 4核8G | 8核16G | 后端服务、数据库 |
| Android手机 | Android 10+ | Android 13+ | 移动端测试 |
| iPhone | iOS 15+ | iOS 17+ | 移动端测试 |
| PC（Windows） | Win10 | Win11 | 桌面端测试 |
| PC（macOS） | macOS 12+ | macOS 14+ | 桌面端测试 |

### 1.2 软件依赖版本

| 组件 | 版本要求 | 验证命令 |
|-------|-----------|----------|
| Node.js | 22.22.2（managed） | `node --version` |
| PostgreSQL | 15+ | `psql --version` |
| Redis | 7+ | `redis-cli --version` |
| Flutter | 3.x | `flutter --version` |
| Rust | 1.75+ | `rustc --version` |
| Docker | 24+ | `docker --version` |

### 1.3 网络环境

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Network (clipsync-net)             │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │  clipsync-   │   │  clipsync-   │   │  clipsync-   │    │
│  │    api       │   │   postgres   │   │    redis     │    │
│  │  (Node.js)   │──▶│ (PostgreSQL) │◀──│  (Redis)     │    │
│  │   :3001      │   │   :5432      │   │   :6379      │    │
│  └──────┬───────┘   └──────┬───────┘   └──────────────┘    │
│         │                   │                                │
│         │            ┌──────┴───────┐                        │
│         │            │  pgdata vol  │                        │
│         │            │  redis vol   │                        │
│         │            │  uploads vol │                        │
│         └────────────┴──────────────┘                        │
│                         │                                   │
└─────────────────────────┼───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐
   │ 移动端设备   │  │ PC桌面端    │  │ Flutter Web│
   │ Android/iOS │  │ Windows/.. │  │  :8080     │
   │ （外部启动） │  │（外部启动） │  │（外部启动） │
   └────────────┘  └────────────┘  └────────────┘
```

**端口规划**：

| 服务 | 容器内部端口 | 宿主机映射（开发） | 宿主机映射（生产） | 协议 | 说明 |
|------|-------------|-------------------|-------------------|------|------|
| 后端API | 3001 | 3001 | Nginx:80/443 | HTTP/WS | 主API服务 |
| PostgreSQL | 5432 | 5434 | 不暴露（仅内网） | TCP | 数据库 |
| Redis | 6379 | 6380 | 不暴露（仅内网） | TCP | 缓存/会话 |
| Nginx | 80,443 | — | 80,443 | HTTP/HTTPS | 反向代理（生产） |
| Flutter Web | — | 8080 | Nginx托管 | HTTP | Web端测试 |

**数据卷挂载方案**：

| 数据卷名 | 用途 | 开发环境路径 | 生产环境策略 |
|----------|------|-------------|-------------|
| `pgdata_dev` / `pgdata_prod` | PostgreSQL数据持久化 | Docker managed volume | 命名卷 + 定期备份 |
| `redisdata_dev` / `redisdata_prod` | Redis AOF持久化 | Docker managed volume | 命名卷，允许丢失 |
| `uploads_dev` / `uploads_prod` | 用户上传文件存储 | Docker managed volume | 命名卷 + 对象存储备份 |

---

## 2. 外部依赖验证清单

> ⚠️ **重要**：以下依赖必须在测试前验证通过，否则测试结果无效。

### 2.1 数据库依赖

#### PostgreSQL 验证

**操作步骤**：

```bash
# 1. 检查PostgreSQL容器状态
docker ps | grep clipsync-db
# 预期：显示 "clipsync-db" 状态为 "Up" / "healthy"

# 2. 通过容器验证数据库连接
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "SELECT version();"

# 3. 验证所需数据表
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "\dt"
```

**预期结果**：

```
                               List of relations
 Schema |           Name           | Type  |       Owner
--------+--------------------------+-------+--------------------
 public | clipboard_items        | table | clipsync
 public | devices                | table | clipsync
 public | file_versions          | table | clipsync
 public | users                  | table | clipsync
 public | upload_sessions        | table | clipsync
(5 rows)
```

**必须验证的字段**（防止迁移不完整）：

```sql
-- clipboard_items 必须有 updated_at 字段
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "
SELECT column_name FROM information_schema.columns 
WHERE table_name='clipboard_items' AND column_name='updated_at';"

-- 必须有 search_vector 字段（全文搜索）
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "
SELECT column_name FROM information_schema.columns 
WHERE table_name='clipboard_items' AND column_name='search_vector';"

-- file_versions 表必须存在
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "
SELECT EXISTS (SELECT FROM pg_tables WHERE tablename='file_versions');"
```

**异常场景与处理**：

| 异常 | 原因 | 处理方案 |
|------|------|----------|
| `connection refused` | PostgreSQL容器未启动 | `docker compose -f docker-compose.dev.yml up -d postgres` |
| `database "clipsync" does not exist` | 数据库未创建 | 检查 POSTGRES_DB 环境变量，或手动创建 |
| `relation "file_versions" does not exist` | 迁移未执行 | `docker exec clipsync node src/db/migrate.js` |
| `column "updated_at" does not exist` | 迁移不完整 | 手动执行迁移修复SQL |

**回滚方案**：

```bash
# 重置数据库到初始状态（Docker方式）
# 1. 停止API服务（避免写入冲突）
docker compose -f docker-compose.dev.yml stop api

# 2. 删除数据库卷（⚠️ 数据会丢失）
docker volume rm dev_pgdata_dev

# 3. 重新启动PostgreSQL（自动初始化新数据库）
docker compose -f docker-compose.dev.yml up -d postgres

# 4. 等待PostgreSQL健康后，重新启动API（自动执行迁移）
docker compose -f docker-compose.dev.yml up -d api
```

---

#### Redis 验证

**操作步骤**：

```bash
# 1. 检查Redis容器状态
docker ps | grep clipsync-redis
# 预期：显示 "clipsync-redis" 状态为 "Up" / "healthy"

# 2. 通过容器验证Redis连接
docker exec clipsync-redis redis-cli ping
# 预期返回: PONG

# 3. 验证读写功能
docker exec clipsync-redis redis-cli set test_key "hello"
docker exec clipsync-redis redis-cli get test_key
docker exec clipsync-redis redis-cli del test_key
```

**异常场景与处理**：

| 异常 | 原因 | 处理方案 |
|------|------|----------|
| `Connection refused` | Redis容器未启动 | `docker compose -f docker-compose.dev.yml up -d redis` |
| `NOAUTH Authentication required` | 密码配置错误（生产环境） | 检查 `REDIS_PASSWORD` 环境变量 |
| 数据丢失 | Redis配置了持久化但未开启 | 检查 docker-compose.yml 中 redis command 的 `--appendonly yes` |

---

### 2.2 存储服务依赖

#### 文件存储验证（本地存储模式）

**操作步骤**：

```bash
# 1. 验证上传目录存在且有写权限
ls -la ./uploads/
# 如不存在则创建
mkdir -p ./uploads && chmod 755 ./uploads

# 2. 测试写入
echo "test" > ./uploads/test.txt && cat ./uploads/test.txt && rm ./uploads/test.txt

# 3. 验证分片上传临时目录
mkdir -p ./uploads/temp && chmod 755 ./uploads/temp
```

**生产环境**（云存储模式）：

```bash
# 验证云存储连接（以AWS S3为例）
aws s3 ls s3://clipsync-uploads/
# 或验证配置
cat .env | grep -E "S3_BUCKET|S3_REGION|S3_ACCESS_KEY"
```

| 异常 | 原因 | 处理方案 |
|------|------|----------|
| `EACCES: permission denied` | 目录权限不足 | `chmod 755 uploads/` |
| `No such bucket` | 云存储桶未创建 | 在云存储控制台创建存储桶 |
| 分片合并失败 | 磁盘空间不足 | `df -h` 检查磁盘，清理空间 |

---

### 2.3 推送通道依赖

#### 推送通知验证清单

> 📱 **注意**：推送通知需要真实的移动设备（模拟器无法接收推送）。

**Android（FCM）验证**：

```bash
# 1. 验证firebase-admin-sdk配置
ls -la ./config/firebase-service-account.json

# 2. 验证FCM API启用状态（在Firebase Console确认）
# Firebase Console → Project Settings → Cloud Messaging

# 3. 验证设备Token注册API
curl -X POST http://localhost:3001/api/devices \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test","deviceName":"Test","platform":"android","pushToken":"test_fcm_token"}'
```

**iOS（APNs）验证**：

```
# 需要真实iOS设备 + Apple开发者账号
# 1. 验证推送证书配置
ls -la ./config/apns-cert.pem
ls -la ./config/apns-key.pem

# 2. 验证Bundle ID匹配
# iOS App → Signing & Capabilities → Bundle Identifier 必须与APNs证书匹配

# 3. 验证推送权限已获取
# iOS设备 → 设置 → ClipSync → 通知 → 允许通知
```

| 异常 | 原因 | 处理方案 |
|------|------|----------|
| FCM注册失败 | 防火墙屏蔽fcm.googleapis.com | 配置网络代理或放行Google IP段 |
| APNs推送不到达 | 证书过期或Bundle ID不匹配 | 重新生成APNs证书 |
| 设备Token为空 | 用户未授权通知权限 | 引导用户在系统设置中开启通知 |

**回滚方案**（推送功能异常时）：

```
如果推送功能无法正常工作，可暂时禁用推送功能，使用WebSocket轮询替代：
修改 src/config.js → notifications.enabled = false
```
---

### 2.4 短信服务依赖（生产环境）

> 📱 **测试环境**：使用固定验证码（如888888），不需要真实短信服务。  
> 🏭 **生产环境**：需要配置真实短信服务商（阿里云、腾讯云等）。

**验证步骤**（生产环境）：

```bash
# 1. 验证短信服务配置
cat .env | grep -E "SMS_|ALIYUN_|TENCENT_"

# 2. 发送测试短信（使用生产短信服务的测试接口）
curl -X POST http://localhost:3001/api/auth/send-code \
  -H "Content-Type: application/json" \
  -d '{"phone":"<您的真实手机号>"}'
# 检查手机是否收到短信

# 3. 验证短信验证码
curl -X POST http://localhost:3001/api/auth/verify-code \
  -H "Content-Type: application/json" \
  -d '{"phone":"<您的真实手机号>","code":"<收到的验证码>"}'
```

---

### 2.5 外部依赖验证汇总表

| 依赖项 | 验证方法 | 通过标准 | 阻塞级别 |
|--------|-----------|----------|----------|
| PostgreSQL | `pg_isready` + 表结构检查 | 5张表完整，字段齐全 | 🔴 阻塞 |
| Redis | `redis-cli ping` + 读写测试 | PONG + 读写正常 | 🔴 阻塞 |
| 文件存储 | 写入测试 + 分片目录检查 | 可正常读写 | 🟡 警告 |
| FCM推送 | Token注册API测试 | 返回201 | 🟡 警告 |
| APNs推送 | 真实设备推送测试 | 设备收到通知 | 🟡 警告 |
| 短信服务 | 发送测试短信 | 手机收到短信 | 🟠 可测试（用固定码） |

---

### 3.0 Docker 容器架构规范（v2.1）

> ⚠️ **重要变更（2026-06-23）**：已清理所有遗留容器，当前 Docker 环境为干净状态。
> **部署前必须使用 `docker-compose.dev.yml` 统一创建容器，禁止手动 `docker run` 创建孤立容器。**

**已删除的遗留容器**：

| 容器名 | 删除原因 | 数据处理 |
|--------|----------|----------|
| `clipsync-db` | 手动创建的孤立容器，不在Compose管理内 | 无数据（刚创建未使用） |
| `clipsync-redis` | 手动创建的孤立容器，端口6380冲突 | 无业务数据 |
| `clipsync-db-test` | 全流程测试遗留 | 测试数据卷已删除 |
| `clipsync-redis-test` | 全流程测试遗留 | 测试数据卷已删除 |

**当前 Docker 环境状态**：

```
✅ 已清理完成，当前无 ClipSync 相关容器
✅ word-helper-mobile 项目容器独立运行（不受影响）
✅ clipsync_default 网络已删除
✅ 测试数据卷（clipsync_postgres_test_data、clipsync_redis_test_data）已删除
```

**正确的容器架构（部署后应为以下结构）**：

```
Docker 环境
├── word-helper-mobile/          ← 其他项目，完全隔离
│   ├── word-helper-mobile       (port 3002)
│   └── word-helper-mobile-db    (port 5434)
│
└── clipsync/                    ← 本项目（通过 docker-compose.dev.yml 创建）
    ├── clipsync-db    (port 5433)
    ├── clipsync-redis       (port 6380)
    └── clipsync         (port 3001)
```

**启动命令**：

```bash
# 开发环境
docker compose -f docker-compose.dev.yml up -d

# 生产环境
docker compose -f docker-compose.prod.yml up -d

# 查看日志
docker compose -f docker-compose.dev.yml logs -f [service-name]

# 停止服务
docker compose -f docker-compose.dev.yml down
```

**文件结构**：

```
ClipSync/
├── docker-compose.yml           # 基础配置（网络、卷）
├── docker-compose.dev.yml      # 开发环境（热重载、调试）
├── docker-compose.prod.yml     # 生产环境（安全、资源限制）
├── .env.development.example   # 开发环境变量模板
├── .env.production.example    # 生产环境变量模板
└── src/server/Dockerfile      # 后端服务镜像
```

---

## 3. 后端服务 Docker 容器化部署

> 🐳 **核心原则**：后端服务（API + PostgreSQL + Redis）全部通过 Docker Compose 编排管理。移动端和PC桌面端作为**外部独立启动的应用**，不纳入 Docker 部署范围。

### 3.1 Docker 组件清单

| 组件 | 容器名 | 镜像 | 端口 | 职责 |
|------|--------|------|------|------|
| **PostgreSQL** | `clipsync-db` | `postgres:15-alpine` | 5432（内部）→ 5434（宿主机） | 主数据库 |
| **Redis** | `clipsync-redis` | `redis:7-alpine` | 6379（内部）→ 6380（宿主机） | 缓存 + 会话 + WebSocket状态 |
| **后端API** | `clipsync-api` | `node:22-alpine` | 3001（内部+宿主机） | Express API + WebSocket |
| **Nginx**（生产） | `clipsync-nginx` | `nginx:alpine` | 80/443 | 反向代理 + SSL终止 |

**不在 Docker 中的组件**：

| 组件 | 启动方式 | 说明 |
|------|----------|------|
| 移动端 App | `flutter run` / APK安装 | Android/iOS 原生应用 |
| PC桌面端 | Tauri编译后的 `.exe`/`.dmg` | 桌面原生应用 |
| Flutter Web | `python http.server` / Nginx托管 | Web前端静态资源 |

---

### 3.2 开发环境 Docker 配置

#### docker-compose.dev.yml

```yaml
# docker-compose.dev.yml — 开发/测试环境
version: "3.8"

services:
  # ====== 数据库层 ======
  postgres:
    image: postgres:15-alpine
    container_name: clipsync-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: clipsync
      POSTGRES_PASSWORD: Admin@Local2024
      POSTGRES_DB: clipsync
      TZ: Asia/Shanghai
    ports:
      - "5434:5432"
    volumes:
      - pgdata_dev:/var/lib/postgresql/data
      - ./src/server/src/db/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U clipsync -d clipsync_dev"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
    networks:
      - clipsync-net

  # ====== 缓存层 ======
  redis:
    image: redis:7-alpine
    container_name: clipsync-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    ports:
      - "6380:6379"
    volumes:
      - redisdata_dev:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - clipsync-net

  # ====== 应用层 ======
  api:
    build:
      context: ./src/server
      dockerfile: Dockerfile.dev
    container_name: clipsync
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: development
      PORT: 3001
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: clipsync
      DB_USER: clipsync
      DB_PASSWORD: Admin@Local2024
      REDIS_HOST: redis
      REDIS_PORT: 6379
      JWT_SECRET: dev-secret-change-in-production-64chars!!
      # 开发模式：固定验证码
      SMS_CODE_OVERRIDE: "888888"
      LOG_LEVEL: debug
      CORS_ORIGIN: "*"
    ports:
      - "3001:3001"
    volumes:
      - ./src/server:/app:delegated   # 热重载：本地代码映射到容器
      - uploads_dev:/app/uploads
      - /app/node_modules             # 防止覆盖容器内依赖
    command: npx nodemon src/index.js --watch --legacy-watch
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:3001/api/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - clipsync-net

volumes:
  pgdata_dev:
    driver: local
  redisdata_dev:
    driver: local
  uploads_dev:
    driver: local

networks:
  clipsync-net:
    driver: bridge
```

#### Dockerfile.dev（开发用）

```dockerfile
# src/server/Dockerfile.dev — 开发镜像，支持热重载
FROM node:22-alpine

WORKDIR /app

# 先复制package文件，利用Docker缓存层
COPY package*.json ./
RUN npm ci

# 复制源代码（通过volume挂载实现热重载）
COPY . .

EXPOSE 3001

CMD ["npx", "nodemon", "src/index.js", "--watch", "--legacy-watch"]
```

---

### 3.3 生产环境 Docker 配置

#### docker-compose.prod.yml

```yaml
# docker-compose.prod.yml — 生产环境
version: "3.8"

services:
  # ====== 数据库层（生产加固）=====
  postgres:
    image: postgres:15-alpine
    container_name: clipsync-db-prod
    restart: always
    environment:
      POSTGRES_USER: ${DB_USER:-clipsync}
      POSTGRES_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD必须设置}
      POSTGRES_DB: ${DB_NAME:-clipsync}
      TZ: UTC
    # 生产环境不暴露端口到宿主机，仅内部网络访问
    expose:
      - "5432"
    volumes:
      - pgdata_prod:/var/lib/postgresql/data
      - ./backups:/backups:ro           # 只读备份目录
      - ./scripts/init-prod.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: "1.0"
        reservations:
          memory: 512M
    networks:
      - clipsync-net

  # ====== 缓存层（生产加固）=====
  redis:
    image: redis:7-alpine
    container_name: clipsync-redis-prod
    restart: always
    command: >
      redis-server
      --appendonly yes
      --appendfsync everysec
      --maxmemory 512mb
      --maxmemory-policy allkeys-lru
      --requirepass ${REDIS_PASSWORD:?REDIS_PASSWORD必须设置}
    # 同样不暴露到宿主机
    expose:
      - "6379"
    volumes:
      - redisdata_prod:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "0.5"
    networks:
      - clipsync-net

  # ====== 应用层（生产加固）=====
  api:
    build:
      context: ./src/server
      dockerfile: Dockerfile.prod
    image: clipsync-api:${VERSION:-latest}
    container_name: clipsync-api-prod
    restart: always
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3001
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: ${DB_NAME:-clipsync}
      DB_USER: ${DB_USER:-clipsync}
      DB_PASSWORD: ${DB_PASSWORD}
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET必须为随机字符串>=32字符}
      # 生产环境不使用固定验证码
      # SMS_PROVIDER: aliyun  # 或 tencent
      # SMS_ACCESS_KEY: ${SMS_ACCESS_KEY}
      FCM_PROJECT_ID: ${FCM_PROJECT_ID:-}
      UPLOAD_MAX_SIZE: 104857600         # 100MB
      UPLOAD_DIR: /app/uploads
      LOG_LEVEL: info
      TRUST_PROXY: 1                     # Nginx反向代理时必需
    expose:
      - "3001"
    volumes:
      - uploads_prod:/app/uploads:rw
    read_only: true                       # 只读文件系统（安全加固，除uploads外）
    tmpfs:
      - /tmp:size=100M,mode=1777          # tmpfs防止磁盘写入
    healthcheck:
      test: ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3001/api/health',(r)=>{process.exit(r.statusCode===200?0:1)})\" || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 60s
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
        replicas: 1                        # 单实例（可扩展多实例+负载均衡）
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 5
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"
    networks:
      - clipsync-net

  # ====== 反向代理（生产可选）=====
  nginx:
    image: nginx:alpine
    container_name: clipsync-nginx-prod
    restart: always
    depends_on:
      api:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl/cert.pem:/etc/nginx/ssl/cert.pem:ro
      - ./ssl/key.pem:/etc/nginx/ssl/key.pem:ro
      - web_static:/usr/share/nginx/html:ro
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:80/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    networks:
      - clipsync-net

volumes:
  pgdata_prod:
    driver: local
    name: clipsync_pgdata_prod
  redisdata_prod:
    driver: local
    name: clipsync_redisdata_prod
  uploads_prod:
    driver: local
    name: clipsync_uploads_prod
  web_static:
    driver: local

networks:
  clipsync-net:
    driver: bridge
    name: clipsync-network-prod
    ipam:
      config:
        - subnet: 172.28.0.0/16
```

#### Dockerfile.prod（生产用）

```dockerfile
# src/server/Dockerfile.prod — 生产镜像，优化构建大小和安全
FROM node:22-alpine AS builder

WORKDIR /build

# 安装依赖并清理缓存
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 复制源码
COPY . .

# 构建TypeScript（如有）或直接打包
# RUN npx tsc  # 如果使用TS

# ====== 最小化运行镜像 ======
FROM node:22-alpine AS runtime

# 创建非root用户
RUN addgroup -S clipsync && adduser -S clipsync -G clipsync

WORKDIR /app

# 从builder阶段复制产物
COPY --from=builder --chown=clipsync:clipsync /build/node_modules ./node_modules
COPY --from=builder --chown=clipsync:clipsync /build/src ./src
COPY --from=builder --chown=clipsync:clipsync /build/package*.json ./

# 创建上传目录
RUN mkdir -p /app/uploads && chown clipsync:clipsync /app/uploads

USER clipsync

EXPOSE 3001

# 使用PM2管理进程（支持自动重启）
RUN npm install -g pm2
ENTRYPOINT ["pm2-runtime", "start", "src/index.js", "--name", "api"]
```

#### .env.production（生产环境变量模板）

```bash
# .env.production — 生产环境变量（绝不提交到Git！）
# 复制此文件为 .env 并填入真实值

# ====== 数据库 ======
DB_USER=clipsync
DB_PASSWORD=<强密码，至少16位>
DB_NAME=clipsync

# ====== Redis ======
REDIS_PASSWORD=<强密码，至少16位>

# ====== JWT ======
JWT_SECRET=<随机字符串，至少32位，可用 openssl rand -base64 32 生成>

# ====== 短信服务 ======
SMS_PROVIDER=aliyun
SMS_ACCESS_KEY=<阿里云AccessKey>
SMS_ACCESS_SECRET=<阿里云Secret>
SMS_SIGN_NAME=ClipSync
SMS_TEMPLATE_CODE=SMS_123456789

# ====== 推送通知 ======
FCM_PROJECT_ID=<Firebase项目ID>
FCM_SERVICE_ACCOUNT_PATH=/run/secrets/firebase-sa-key.json

# ====== 版本标签 ======
VERSION=v0.1.0
```

---

### 3.4 服务启动顺序与依赖关系

```
启动顺序（Docker Compose 自动按 depends_on 管理）：

Step 1: postgres ──────────────► healthcheck 通过 (pg_isready)
                                    │
Step 2: redis ────────────────────► healthcheck 通过 (redis ping)
                    │               │
                    │               ▼
                    └───────► Step 3: api ────► healthcheck 通过 (/api/health)
                                                    │
                                          Step 4: nginx（生产环境）

依赖关系图：
  postgres ←── api ←── nginx
     ↑              ↑
  redis ──────────┘
```

**关键说明**：
- `depends_on.condition: service_healthy` 确保 API 不会在数据库/Redis未就绪时启动
- 每个 database 服务都有独立的 `healthcheck` 定义
- 生产环境的 API 容器配置了 `restart_policy: on-failure`，崩溃后自动重启

---

### 3.5 操作命令速查

```bash
# ==================== 开发环境 ====================

# 启动所有服务（后台运行）
docker compose -f docker-compose.dev.yml up -d

# 启动所有服务（前台运行，查看实时日志）
docker compose -f docker-compose.dev.yml up

# 仅启动数据库和Redis（不启动API，用于手动调试）
docker compose -f docker-compose.dev.yml up -d postgres redis

# 查看日志
docker compose -f docker-compose.dev.yml logs -f api
docker compose -f docker-compose.dev.yml logs -f postgres

# 重启某个服务
docker compose -f docker-compose.dev.yml restart api

# 停止所有服务
docker compose -f docker-compose.dev.yml down

# 停止并删除数据卷（⚠️ 会清空数据库数据！）
docker compose -f docker-compose.dev.yml down -v


# ==================== 生产环境 ====================

# 首次部署前检查环境变量是否齐全
docker compose -f docker-compose.prod.yml config  # 如无报错则OK

# 构建并启动
docker compose -f docker-compose.prod.yml up -d --build

# 查看各容器健康状态
docker compose -f docker-compose.prod.yml ps

# 查看资源占用
docker stats --no-stream

# 滚动查看日志
docker compose -f docker-compose.prod.yml logs -f --tail=100 api

# 扩容API实例（需配合负载均衡器）
docker compose -f docker-compose.prod.yml up -d --scale api=3

# 停止服务（保留数据）
docker compose -f docker-compose.prod.yml down

# 完全清除（⚠️ 包括数据卷，不可恢复）
docker compose -f docker-compose.prod.yml down -v --rmi all
```

---

### 3.6 Docker 环境健康检查

**操作步骤**：

```bash
# 1. 检查所有容器状态
docker compose -f docker-compose.dev.yml ps
# 预期：所有服务的 Status 为 "healthy" 或 "running"

# 2. 检查网络连通性
docker exec clipsync wget -qO- http://postgres:5432 || echo "PG reachable"
docker exec clipsync redis-cli -h redis ping || echo "Redis reachable"

# 3. API健康检查
curl http://localhost:3001/api/health
# 预期：{"status":"ok","database":"ok","redis":"ok","timestamp":"..."}

# 4. 数据库表结构验证
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "\dt"

# 5. 验证数据库迁移已执行
docker exec clipsync node src/db/migrate.js
# 预期：All migrations completed successfully
```

**自动化健康检查脚本**：

```bash
#!/bin/bash
# scripts/docker-health-check.sh

COMPOSE_FILE="docker-compose.dev.yml"

echo "=== ClipSync Docker Health Check ==="

# Check containers running
echo -n "[1] Containers... "
STATUS=$(docker compose -f $COMPOSE_FILE ps --format json 2>/dev/null | grep -o '"health": "[^"]*"')
echo "$STATUS" | grep -q "healthy" && echo "✅ All healthy" || echo "❌ Some unhealthy"

# Check API
echo -n "[2] API... "
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/health)
[ "$HTTP" = "200" ] && echo "✅ PASS ($HTTP)" || echo "❌ FAIL ($HTTP)"

# Check DB
echo -n "[3] PostgreSQL... "
docker exec clipsync-db pg_isready -q 2>/dev/null && echo "✅ PASS" || echo "❌ FAIL"

# Check Redis
echo -n "[4] Redis... "
RESULT=$(docker exec clipsync-redis redis-cli ping 2>/dev/null)
[ "$RESULT" = "PONG" ] && echo "✅ PASS" || echo "❌ FAIL ($RESULT)"

echo "=== Done ==="
```

### 3.7 服务停止与清理

> ⚠️ **必须遵守规则**：测试完成后必须停止 Docker 容器，释放端口和内存。

```bash
# 方式1：停止所有容器（保留数据卷，下次可重新启动）
docker compose -f docker-compose.dev.yml down

# 方式2：停止并清理数据卷（⚠️ 测试数据会丢失）
docker compose -f docker-compose.dev.yml down -v

# 方式3：彻底清理（包括未标记的镜像）
docker system prune -af --volumes

# 验证清理结果
docker ps -a | grep clipsync || echo "✅ All ClipSync containers removed"
docker volume ls | grep clipsync || echo "✅ All ClipSync volumes removed"
netstat -ano | grep -E ":(3001|5434|6380)" || echo "✅ All ports freed"
```

---

## 4. 移动端App编译与安装

### 4.1 Android端编译与安装

#### 环境检查

```bash
# 1. 检查Flutter环境
flutter doctor

# 必须全部打勾（✓）：
# ✓ Flutter
# ✓ Android toolchain
# ✓ Android Studio
# ⚠ Chrome（可选，用于Web测试）
# ⚠ Android Emulator（可选，用于模拟器测试）
```

#### 编译Debug包（开发测试用）

```bash
cd src/mobile

# 1. 安装依赖
flutter pub get

# 2. 生成国际化文件（如启用了国际化）
flutter gen-l10n

# 3. 编译Debug APK
flutter build apk --debug

# 输出路径：build/app/outputs/flutter-apk/app-debug.apk
```

#### 编译Release包（生产测试用）

```bash
# 1. 编译Release APK
flutter build apk --release

# 输出路径：build/app/outputs/flutter-apk/app-release.apk

# 2. 验证APK签名（生产环境必须）
jarsigner -verify build/app/outputs/flutter-apk/app-release.apk

# 3. 查看APK信息
aapt dump badging build/app/outputs/flutter-apk/app-release.apk
```

#### 安装到Android设备

**方式1：USB调试安装**

```bash
# 1. 检查设备连接
adb devices
# 预期输出：List of devices attached
#             <device_id>  device

# 2. 安装APK
adb install build/app/outputs/flutter-apk/app-debug.apk
# 预期输出：Success

# 3. 如遇「INSTALL_FAILED_VERSION_DOWNGRADE」
adb install -r build/app/outputs/flutter-apk/app-debug.apk
# -r 参数表示覆盖安装
```

**方式2：直接运行（连接设备时）**

```bash
# 1. 查看已连接设备
flutter devices

# 2. 直接运行到设备（会自动编译+安装+启动）
flutter run --release -d <device_id>
```

#### Android测试检查清单

安装完成后，在手机上执行以下检查：

```
□ App图标出现在桌面
□ 点击图标能正常启动（不闪退）
□ 登录页面正常显示
□ 能收到短信验证码（或固定码888888可用）
□ 登录后能进入主界面
□ 剪贴板列表能正常加载
□ 能正常上传文件
□ 通知权限已获取（设置→应用管理→ClipSync→通知）
```

---

### 4.2 iOS端编译与安装

> 🍎 **前提条件**：
> - macOS系统
> - Xcode 15+
> - Apple开发者账号（真机调试需要）
> - 真实iOS设备（模拟器无法测试推送通知和某些系统功能）

#### 编译Debug包（开发测试用）

```bash
cd src/mobile

# 1. 安装依赖
flutter pub get

# 2. 打开iOS模块（需要用Xcode配置签名）
open ios/Runner.xcworkspace

# 在Xcode中：
# 1. 选择Runner → Signing & Capabilities
# 2. 选择Team（开发者账号）
# 3. 修改Bundle Identifier（必须是唯一的）
# 4. 确保勾选「Push Notifications」能力

# 3. 连接iPhone，运行Debug版本
flutter run --debug -d <iphone_device_id>
```

#### 编译Release包（TestFlight/生产测试用）

```bash
# 1. 在Xcode中配置Release签名
# Xcode → Runner → Signing & Capabilities → Release → 选择Team

# 2. 编译Archive
# Xcode → Product → Archive

# 3. 上传到TestFlight
# Xcode → Window → Organizer → Distribute App → TestFlight

# 或命令行方式
flutter build ipa --release
# 输出路径：build/ios/ipa/clipsync_mobile.ipa
```

#### iOS测试检查清单

```
□ App图标出现在桌面
□ 点击图标能正常启动（不闪退）
□ 系统弹窗请求通知权限（必须允许）
□ 登录页面正常显示
□ 能正常接收推送通知
□ 剪贴板列表能正常加载
□ 能正常上传文件
□ 后台刷新功能正常（设置→通用→后台App刷新→ClipSync→开启）
```

---

### 4.3 移动端测试环境清理

> ⚠️ **必须遵守**：测试完成后清理设备上的测试应用和数据。

**Android清理**：

```bash
# 1. 卸载应用
adb uninstall com.clipsync.app

# 2. 清理应用数据（如果未卸载）
adb shell pm clear com.clipsync.app

# 3. 清理测试文件
adb shell rm -rf /sdcard/Android/data/com.clipsync.app
```

**iOS清理**：

```
1. 长按App图标 → 删除App
2. 设置 → 通用 → iPhone存储 → 找到ClipSync → 删除App
3. 重置所有模拟器数据（模拟器测试时）
   Xcode → Device And Simulators → 选择模拟器 → Delete → 重新创建
```

---

## 5. PC桌面客户端编译与安装

### 5.1 Windows桌面端编译

#### 环境检查

```bash
# 1. 检查Rust环境
rustc --version
cargo --version

# 2. 检查Tauri CLI
cargo tauri --version

# 3. 检查WebView2（Windows 10/11通常预装）
# 如未安装：下载 https://developer.microsoft.com/en-us/microsoft-edge/webview2
```

#### 编译Debug版本

```bash
cd src/desktop

# 1. 安装依赖
npm install

# 2. 编译Debug版本（会打开一个窗口）
cargo tauri dev
# 预期：Tauri窗口打开，显示ClipSync界面

# 停止：在终端按 Ctrl+C
```

#### 编译Release版本

```bash
cd src/desktop

# 1. 编译Release MSI安装包
cargo tauri build

# 输出路径：src-tauri/target/release/bundle/msi/clipsync_<version>_x64_en-US.msi

# 2. 验证安装包
ls -lh src-tauri/target/release/bundle/msi/
```

#### 安装与测试

```bash
# 1. 双击MSI文件安装
# 安装路径默认：C:\Program Files\ClipSync\

# 2. 启动应用
# 方式1：开始菜单 → ClipSync
# 方式2：桌面快捷方式
# 方式3：命令行
"C:\Program Files\ClipSync\ClipSync.exe"

# 3. 验证功能
# - 系统托盘图标出现
# - 点击托盘图标显示主窗口
# - 登录功能正常
# - 剪贴板同步正常
```

---

### 5.2 macOS桌面端编译

```bash
cd src/desktop

# 1. 编译Release DMG安装包
cargo tauri build

# 输出路径：src-tauri/target/release/bundle/dmg/clipsync_<version>.dmg

# 2. 安装
# 双击DMG → 拖入Applications文件夹

# 3. 首次启动（可能需要绕过Gatekeeper）
xattr -d com.apple.quarantine /Applications/ClipSync.app
open /Applications/ClipSync.app
```

---

### 5.3 Linux桌面端编译

```bash
cd src/desktop

# 1. 安装系统依赖（Ubuntu/Debian）
sudo apt install libwebkit2gtk-4.0-dev libsqlite3-dev

# 2. 编译Release包
cargo tauri build

# 输出：.deb / .rpm / .AppImage（根据配置）
```

---

### 5.4 桌面端测试检查清单

```
□ 安装后桌面快捷方式出现
□ 系统托盘图标显示正常
□ 点击托盘图标能显示/隐藏主窗口
□ 开机自启动功能正常（如启用）
□ 登录功能正常
□ 剪贴板监控功能正常（复制内容能自动同步）
□ 文件拖拽上传功能正常
□ 设置页面能正常保存配置
□ 关闭窗口后托盘图标仍存在（如配置了最小化到托盘）
□ 完全退出后所有进程清理干净（任务管理器确认）
```

---

### 5.5 桌面端测试环境清理

**Windows清理**：

```bash
# 1. 卸载应用
# 设置 → 应用 → ClipSync → 卸载

# 2. 手动清理残留
rm -rf "%APPDATA%\com.clipsync.desktop"
rm -rf "%LOCALAPPDATA%\com.clipsync.desktop"

# 3. 清理注册表（如需要）
# regedit → 删除 HKEY_CURRENT_USER\Software\com.clipsync.desktop
```

**macOS清理**：

```bash
# 1. 删除应用
rm -rf /Applications/ClipSync.app

# 2. 清理应用数据
rm -rf ~/Library/Application\ Support/com.clipsync.desktop
rm -rf ~/Library/Preferences/com.clipsync.desktop.plist
rm -rf ~/Library/Caches/com.clipsync.desktop
```

---

## 6. 端对端同步全流程测试

> 🔬 **测试策略**：覆盖所有数据类型（文本、图片、文件）的双向同步验证。

### 6.1 测试环境准备

**设备准备**：

```
最少需要2台设备：
- 设备A：Android手机 或 PC桌面端
- 设备B：iPhone 或 另一台PC桌面端

推荐配置（覆盖最全）：
- 设备A：Android手机 + PC桌面端（Windows）
- 设备B：iPhone + PC桌面端（macOS）
```

**账号准备**：

```
使用同一手机号在两个设备上登录，系统会自动关联设备。
测试账号：13800138000（验证码：888888）
```

**网络准备**：

```
□ 所有设备在同一局域网内（减少网络延迟干扰）
□ 记录服务器IP地址（如：192.168.1.100）
□ 确认防火墙允许3001端口通信
```

---

### 6.2 文本剪贴板同步测试

#### 测试用例 6.2.1：基础文本同步

| 步骤 | 操作 | 预期结果 | 实际结果 | 通过 |
|------|------|----------|----------|------|
| 1 | 设备A复制文本「Hello ClipSync」 | 系统剪贴板显示「Hello ClipSync」 | | |
| 2 | 等待3秒（同步延迟） | | | |
| 3 | 设备B打开ClipSync App | 剪贴板列表显示「Hello ClipSync」 | | |
| 4 | 设备B点击该条目 | 设备B系统剪贴板变为「Hello ClipSync」 | | |
| 5 | 设备B复制新文本「Sync OK」 | | | |
| 6 | 设备A刷新剪贴板列表 | 显示「Sync OK」 | | |

**异常场景**：

| 异常 | 触发条件 | 预期处理 | 实际处理 |
|------|-----------|----------|----------|
| 同步超时 | 网络断开时复制 | 显示「同步失败，已保存到离线队列」 | |
| 冲突（同时修改） | 两台设备同时复制不同内容 | 以最新时间戳为准，另一个设备收到冲突通知 | |
| 空内容同步 | 复制空字符串 | 拒绝同步，提示「内容不能为空」 | |

---

#### 测试用例 6.2.2：特殊字符与格式

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | 复制中文「你好世界」 | 两端均正常显示中文 |
| 2 | 复制Emoji 😀🎉 | 两端均正常显示Emoji |
| 3 | 复制超长文本（>10000字符） | 正常同步，或提示「内容过长」 |
| 4 | 复制特殊字符（\n,\t,\\,\0） | 特殊字符正确转义，不同步失败 |
| 5 | 复制URL（https://...） | URL完整保留，可点击 |
| 6 | 复制多行文本 | 换行符正确保留 |

---

### 6.3 图片同步测试

#### 测试用例 6.3.1：截图同步

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 设备A截图（Ctrl+Shift+S / Command+Shift+4） | 截图自动保存到ClipSync | |
| 2 | 等待同步 | | |
| 3 | 设备B打开ClipSync | 图片缩略图显示在剪贴板列表 | |
| 4 | 设备B点击图片 | 图片全屏预览，可保存 | |
| 5 | 设备B长按/右键保存图片 | 图片保存到设备B相册/下载目录 | |

#### 测试用例 6.3.2：图片格式与大小

| 图片格式 | 大小 | 预期结果 | 通过 |
|----------|------|----------|------|
| JPG | 500KB | 正常同步 | |
| PNG | 2MB | 正常同步 | |
| GIF | 5MB | 正常同步（静态预览） | |
| WebP | 1MB | 正常同步 | |
| HEIC（iPhone） | 3MB | 正常同步（或自动转JPG） | |
| 超大图片 | 20MB | 提示「图片过大」，拒绝同步 | |

**异常场景**：

| 异常 | 处理方案 |
|------|----------|
| 图片上传失败（网络中断） | 显示上传进度条，网络恢复后自动续传 |
| 图片格式不支持 | 提示「不支持的图片格式」 |
| 存储空间不足 | 提示「存储空间不足，请清理后重试」 |

---

### 6.4 文件同步测试

#### 测试用例 6.4.1：小文件同步（<10MB）

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 设备A点击「上传文件」，选择一份PDF（2MB） | 显示上传进度条，上传成功 | |
| 2 | 等待同步 | | |
| 3 | 设备B刷新列表 | 显示该PDF文件条目 | |
| 4 | 设备B点击文件 | 调用系统应用打开PDF（或下载到本地） | |
| 5 | 设备B删除该文件 | 设备A收到「文件已删除」通知 | |

#### 测试用例 6.4.2：大文件分片上传

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 设备A选择大文件（50MB视频） | 显示「正在分片上传...」 | |
| 2 | 观察上传进度 | 进度条正常递增，无卡顿 | |
| 3 | 上传过程中断开网络5秒 | 上传暂停，网络恢复后自动续传 | |
| 4 | 等待上传完成 | 显示「上传完成」 | |
| 5 | 设备B下载该文件 | 文件完整，MD5校验通过 | |

**分片上传验证API**：

```bash
# 1. 初始化分片上传
curl -X POST http://localhost:3001/api/upload/init \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"fileName":"test.mp4","fileSize":52428800,"mimeType":"video/mp4"}'
# 预期返回：{"uploadId":"xxx","chunkSize":5242880,"totalChunks":10}

# 2. 上传分片（第1片）
curl -X POST http://localhost:3001/api/upload/chunk \
  -H "Authorization: Bearer <TOKEN>" \
  -F "uploadId=xxx" \
  -F "chunkIndex=0" \
  -F "file=@chunk_0.dat"

# 3. 查询上传状态
curl -X GET "http://localhost:3001/api/upload/status?uploadId=xxx" \
  -H "Authorization: Bearer <TOKEN>"

# 4. 完成上传
curl -X POST http://localhost:3001/api/upload/complete \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"uploadId":"xxx"}'
```

---

### 6.5 双向同步冲突处理测试

#### 测试用例 6.5.1：同时修改同一剪贴板条目

**测试步骤**：

```
1. 设备A和B同时在线，已同步
2. 设备A修改条目1的内容为「Version A」
3. 在设备A同步完成前（1秒内），设备B修改同一条目为「Version B」
4. 等待两台设备均完成同步
```

**预期结果（Last-Write-Wins策略）**：

```
- 时间戳较新的修改覆盖较旧的
- 被覆盖的设备收到冲突通知
- 用户可查看冲突历史（版本管理功能）
```

**验证方法**：

```bash
# 查看该条目的版本历史
curl -X GET http://localhost:3001/api/versions/history/<item_id> \
  -H "Authorization: Bearer <TOKEN>"
# 预期返回：两个版本记录，分别标记为「Version A」和「Version B」
```

---

### 6.6 离线同步测试

#### 测试用例 6.6.1：离线后重新上线

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 设备A断网（关闭WiFi/移动数据） | App显示「离线模式」 | |
| 2 | 设备A复制3条文本 | 本地保存成功，显示「待同步」标记 | |
| 3 | 设备A重新联网 | 自动触发同步，3条文本上传到服务器 | |
| 4 | 设备B刷新列表 | 显示设备A的3条文本 | |
| 5 | 查看同步日志 | 显示「离线队列已清空」 | |

**离线队列验证**：

```bash
# Android设备查看离线队列（需要root或通过adb）
adb shell
run-as com.clipsync.app
cat /data/data/com.clipsync.app/files/offline_queue.json
```

---

### 6.7 实时推送通知测试

#### 测试用例 6.7.1：新剪贴板推送

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 设备B在后台（App最小化） | | |
| 2 | 设备A上传新剪贴板 | | |
| 3 | 观察设备B | 收到推送通知「新剪贴板已同步」 | |
| 4 | 点击通知 | 自动打开ClipSync App，显示新内容 | |

#### 测试用例 6.7.2：文件分享推送

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 设备A分享文件到ClipSync | | |
| 2 | 设备B收到推送 | 通知显示文件名和大小 | |
| 3 | 点击通知 | 自动下载文件，完成后提示 | |

---

### 6.8 设备管理测试

> 📱 **功能说明**：ClipSync 支持多设备登录，用户可以查看已登录设备列表、移除设备、设置设备名称等。

#### 测试用例 6.8.1：设备列表查看

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 打开App，进入「设置」→「设备管理」 | 显示当前用户的所有已登录设备列表 | |
| 2 | 检查设备信息 | 显示设备名称、设备类型、最后在线时间、IP地址 | |
| 3 | 在当前设备上 | 显示「当前设备」标记 | |
| 4 | 在其他设备上 | 不显示「当前设备」标记 | |

**API测试命令**：

```bash
# 获取设备列表
curl -X GET "http://localhost:3001/api/devices" \
  -H "Authorization: Bearer <TOKEN>"

# 预期返回
{
  "success": true,
  "data": {
    "devices": [
      {
        "id": "device-uuid-1",
        "deviceName": "iPhone 13",
        "deviceType": "ios",
        "platform": "iOS",
        "platformVersion": "17.0",
        "isOnline": true,
        "lastSeenAt": "2026-06-27T01:00:00Z",
        "isCurrentDevice": false
      },
      {
        "id": "device-uuid-2",
        "deviceName": "Windows PC",
        "deviceType": "windows",
        "platform": "Windows",
        "platformVersion": "11",
        "isOnline": true,
        "lastSeenAt": "2026-06-27T01:05:00Z",
        "isCurrentDevice": true
      }
    ]
  }
}
```

#### 测试用例 6.8.2：设备名称修改

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在设备列表中点击某个设备 | 显示设备详情页 | |
| 2 | 点击「编辑设备名称」 | 弹出输入框，显示当前名称 | |
| 3 | 输入新名称「My iPhone 13」 | 名称更新成功 | |
| 4 | 重新获取设备列表 | 显示新名称 | |

**API测试命令**：

```bash
# 更新设备名称
curl -X PUT "http://localhost:3001/api/devices/{deviceId}" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"deviceName": "My iPhone 13"}'

# 预期返回
{
  "success": true,
  "message": "设备名称已更新",
  "data": {
    "id": "device-uuid-1",
    "deviceName": "My iPhone 13"
  }
}
```

#### 测试用例 6.8.3：设备移除

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在设备列表中滑动某个设备（或点击「移除」按钮） | 显示确认对话框 | |
| 2 | 确认移除 | 设备从列表中消失 | |
| 3 | 被移除的设备尝试同步 | 提示「设备已被移除，请重新登录」 | |
| 4 | 尝试移除当前设备 | 提示「不能移除当前设备」 | |

**API测试命令**：

```bash
# 移除设备
curl -X DELETE "http://localhost:3001/api/devices/{deviceId}" \
  -H "Authorization: Bearer <TOKEN>"

# 预期返回
{
  "success": true,
  "message": "设备已移除"
}
```

#### 测试用例 6.8.4：多设备同时在线

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在设备A（iPhone）登录 | 设备A显示在线 | |
| 2 | 在设备B（Android）登录同一账号 | 设备A和B都显示在线 | |
| 3 | 在设备C（Windows）登录同一账号 | 三个设备都显示在线 | |
| 4 | 在任意设备上传剪贴板 | 所有设备都收到同步推送 | |
| 5 | 退出设备B（App退出登录） | 设备B显示离线 | |

**验证要点**：
- 最多支持几个设备同时在线？（检查后端配置）
- 设备离线检测时间（心跳超时）
- 剪贴板同步是否在所有在线设备间正常工作

---

### 6.13 端对端测试汇总表

| 测试类型 | 测试用例数 | 通过 | 失败 | 阻塞 | 通过率 |
|----------|-------------|------|------|------|--------|
| 文本同步 | 2 | | | | |
| 图片同步 | 2 | | | | |
| 文件同步 | 2 | | | | |
| 文件预览 | 2 | | | | |
| 全文搜索 | 2 | | | | |
| 订阅与支付 | 4 | | | | |
| 通知设置 | 2 | | | | |
| 冲突处理 | 1 | | | | |
| 离线同步 | 1 | | | | |
| 推送通知 | 2 | | | | |
| **合计** | **20** | | | | |

---

### 6.9 文件预览测试

> 📁 **功能说明**：ClipSync 支持文本/代码文件预览，无需下载即可查看内容。

#### 测试用例 6.9.1：文本文件预览

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 设备A上传文本文件（test.txt，包含"Hello World"） | 上传成功 | |
| 2 | 设备B刷新列表，点击该文件 | 显示文件预览，内容为"Hello World" | |
| 3 | 检查预览页面 | 显示文件名、大小、编码格式 | |
| 4 | 点击"复制内容"按钮 | 文件内容复制到系统剪贴板 | |

#### 测试用例 6.9.2：代码文件预览（语法高亮）

| 文件类型 | 扩名 | 预期结果 | 通过 |
|----------|--------|----------|------|
| Python | .py | 语法高亮显示，关键字变色 | |
| JavaScript | .js | 语法高亮显示 | |
| Java | .java | 语法高亮显示 | |
| JSON | .json | 格式化显示，语法高亮 | |
| XML | .xml | 语法高亮显示 | |

**API测试命令**：

```bash
# 获取文件预览内容
curl -X GET "http://localhost:3001/api/media/{fileId}/text-preview" \
  -H "Authorization: Bearer <TOKEN>"

# 预期返回
{
  "success": true,
  "data": {
    "content": "file content here",
    "language": "python",
    "encoding": "utf-8",
    "size": 1234
  }
}
```

---

### 6.10 全文搜索测试

> 🔍 **功能说明**：ClipSync 使用 PostgreSQL tsvector 实现全文搜索，支持中文、英文、特殊字符搜索。

#### 测试用例 6.10.1：基础全文搜索

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在搜索框输入"Hello" | 显示包含"Hello"的所有剪贴板条目 | |
| 2 | 在搜索框输入"你好" | 显示包含"你好"的所有剪贴板条目 | |
| 3 | 在搜索框输入"Hello World" | 显示同时包含"Hello"和"World"的条目 | |
| 4 | 清空搜索框 | 显示所有剪贴板条目 | |

#### 测试用例 6.10.2：特殊字符搜索

| 搜索关键词 | 预期结果 | 通过 |
|------------|----------|------|
| `https://example.com` | 找到包含该URL的条目 | |
| `user@example.com` | 找到包含该邮箱的条目 | |
| `123-456-7890` | 找到包含该电话号码的条目 | |
| `C++` | 找到包含"C++"的条目 | |
| `100%` | 找到包含"100%"的条目 | |

**API测试命令**：

```bash
# 全文搜索
curl -X GET "http://localhost:3001/api/clipboard/search?q=Hello" \
  -H "Authorization: Bearer <TOKEN>"

# 预期返回
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "xxx",
        "contentPreview": "Hello World...",
        "contentType": "text",
        "rank": 0.8  // 相关性评分
      }
    ],
    "total": 10
  }
}
```

---

### 6.11 订阅与支付测试

> 💰 **功能说明**：ClipSync 提供免费版和付费订阅版，支持订阅计划选择、支付、取消、恢复。

#### 测试用例 6.11.1：订阅计划列表

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 打开订阅计划页面 | 显示所有可用的订阅计划 | |
| 2 | 检查计划详情 | 显示计划名称、价格、功能列表 | |
| 3 | 对比免费版和付费版 | 付费版显示更多功能 | |

**API测试命令**：

```bash
# 获取订阅计划列表
curl -X GET "http://localhost:3001/api/subscriptions/plans" \
  -H "Authorization: Bearer <TOKEN>"

# 预期返回
{
  "success": true,
  "data": {
    "plans": [
      {
        "id": "xxx",
        "name": "免费版",
        "price": 0,
        "currency": "CNY",
        "features": ["基础同步", "30天历史"]
      },
      {
        "id": "yyy",
        "name": "专业版",
        "price": 9.99,
        "currency": "CNY",
        "features": ["无限同步", "90天历史", "优先支持"]
      }
    ]
  }
}
```

#### 测试用例 6.11.2：当前订阅查询

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 打开订阅管理页面 | 显示当前用户的订阅状态 | |
| 2 | 检查订阅详情 | 显示订阅计划、开始日期、结束日期 | |
| 3 | 如果无订阅 | 显示"未订阅"状态 | |

**API测试命令**：

```bash
# 获取当前订阅
curl -X GET "http://localhost:3001/api/subscriptions/current" \
  -H "Authorization: Bearer <TOKEN>"

# 预期返回（有订阅）
{
  "success": true,
  "data": {
    "subscription": {
      "id": "xxx",
      "planId": "yyy",
      "planName": "专业版",
      "status": "active",
      "startDate": "2026-06-01T00:00:00Z",
      "endDate": "2026-07-01T00:00:00Z"
    }
  }
}
```

#### 测试用例 6.11.3：订阅创建（支付订单）

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 选择订阅计划（专业版） | 显示支付选项（微信、支付宝、Stripe） | |
| 2 | 选择微信支付 | 显示微信支付二维码 | |
| 3 | 模拟支付成功（调用Webhook） | 订阅状态变为"active" | |
| 4 | 检查订阅详情 | 显示正确的开始日期和结束日期 | |

**API测试命令**：

```bash
# 创建订阅订单
curl -X POST "http://localhost:3001/api/subscriptions/subscribe" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"planId":"yyy","paymentMethod":"wechat"}'

# 预期返回
{
  "success": true,
  "data": {
    "order": {
      "orderNo": "ORDER_xxx",
      "amount": 9.99,
      "currency": "CNY",
      "status": "pending"
    },
    "paymentParams": {
      "qrCode": "weixin://pay/xxx"  // 微信支付二维码
    }
  }
}
```

#### 测试用例 6.11.4：订阅取消与恢复

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在订阅管理页面点击"取消订阅" | 显示确认对话框 | |
| 2 | 确认取消 | 订阅状态变为"cancelled"，到期日不变 | |
| 3 | 在到期前点击"恢复订阅" | 订阅状态变回"active" | |
| 4 | 检查订阅详情 | 显示正确的订阅状态 | |

**API测试命令**：

```bash
# 取消订阅
curl -X POST "http://localhost:3001/api/subscriptions/cancel" \
  -H "Authorization: Bearer <TOKEN>"

# 恢复订阅
curl -X POST "http://localhost:3001/api/subscriptions/resume" \
  -H "Authorization: Bearer <TOKEN>"
```

---

### 6.12 通知设置测试

> 🔔 **功能说明**：ClipSync 支持自定义推送通知偏好设置。

#### 测试用例 6.12.1：通知设置页面UI

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 打开设置页面，进入通知设置 | 显示通知设置选项 | |
| 2 | 检查选项列表 | 显示"新剪贴板推送"、"文件分享推送"等选项 | |
| 3 | 切换开关 | 开关状态改变，显示保存成功提示 | |
| 4 | 退出重新进入 | 设置已保存，开关状态正确 | |

#### 测试用例 6.12.2：通知偏好保存API

**API测试命令**：

```bash
# 保存通知偏好
curl -X PUT "http://localhost:3001/api/notifications/preferences" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "newClipboardPush": true,
    "fileSharePush": true,
    "subscriptionExpireReminder": false
  }'

# 预期返回
{
  "success": true,
  "message": "通知偏好已保存"
}
```

---



## 6.14 二维码扫码配对测试（已实现 · P0 兜底方案）

> 📱 **功能说明**：二维码扫码配对是「自动账户同步不可用时的手动兜底方案」。
> 任一已登录设备点击「生成配对码」生成一次性二维码（有效期 5 分钟）；另一台设备点击「扫码配对」用摄像头扫描（或手动粘贴配对码），兑换成功后本设备即登录到对方账号并共享剪贴板。
>
> **底层原理**：配对令牌（`pairing:{token}`，存于 Redis，TTL 300s）兑换时由后端复用登录的会话+JWT 生成逻辑，返回与 `/api/auth/*` 完全一致的 `{ token, user }`，因此本质是一个「扫码登录」入口。

#### 测试用例 6.14.1：生成配对码

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 设置 → 设备管理 → 点击「生成配对码」 | 弹出二维码 + 明文配对码 + 倒计时 | |
| 2 | 检查二维码内容 | 形如 `clipsync://pair?token=<64位hex>` | |
| 3 | 等待 5 分钟 | 倒计时归零，提示「配对码已过期」 | |
| 4 | 点击「重新生成」 | 旧码失效，生成新码 | |

**API 测试命令**：

```bash
# 生成配对令牌（需登录）
curl -X POST http://localhost:3001/api/devices/pairing/init \
  -H "Authorization: Bearer <TOKEN>"

# 预期返回
{ "token": "<64hex>", "expiresAt": 1710000000000 }
```

#### 测试用例 6.14.2：扫码 / 粘贴配对

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 另一设备点击「扫码配对」→ 开启摄像头 | 摄像头预览出现 | |
| 2 | 扫描 6.14.1 的二维码 | 自动兑换，提示「配对成功」 | |
| 3 | 检查设备列表 | 两台设备出现在同一账号下，剪贴板互通 | |
| 4 | 无摄像头时 | 点击「停止」，在输入框粘贴配对码 → 点「配对」同样成功 | |
| 5 | 使用已过期/伪造令牌 | 返回 404「Invalid or expired pairing token」 | |

**API 测试命令**：

```bash
# 兑换配对令牌（无需登录，等价于登录到令牌所属账号）
curl -X POST http://localhost:3001/api/devices/pairing/redeem \
  -H "Content-Type: application/json" \
  -d '{"token":"<64hex>","deviceName":"Desktop","deviceType":"desktop","platform":"windows"}'

# 预期返回（与 /api/auth/login 结构一致）
{
  "token": "<JWT>",
  "user": { "id":"...", "phone":"...", "nickname":null, "avatarUrl":null,
            "tosAcceptedAt":null, "privacyAcceptedAt":null, "marketingConsent":false }
}
```

#### 测试用例 6.14.3：异常与边界

| 异常 | 预期处理 |
|------|----------|
| 令牌已使用一次 | 第二次兑换返回 404（一次性） |
| Redis 不可用 | `/pairing/init` 返回 503，`/pairing/redeem` 返回 503 |
| platform 非法（如 `unknown`） | 返回 400，提示合法 platform 列表 |
| 摄像头无权限/无设备 | 优雅降级：toast 提示，手动粘贴入口始终可用 |

---

## 6.15 链接分享测试（规划中 · 非 P0，暂不实现）

> 🔗 **功能说明**：链接分享（Shared Links）计划将剪贴板内容生成一个可访问的短链接（`clipsync.io/s/xxx`），发给未安装 ClipSync 的人即可在浏览器查看。
> **当前状态**：仅前端有 Mock 占位页面，**后端 API 与数据库尚未实现**，属于规划中功能。按优先级决策，**本迭代延后实现（非 P0）**。
>
> **待办（非 P0）**：
> - 后端：短链接生成 / 查询 / 过期回收接口（`POST /api/share`，`GET /api/share/:code`）
> - 数据库：`shared_links` 表（code, item_id, owner_id, expires_at, max_views）
> - 前端：DevicesView/剪贴板条目「分享为链接」入口 + 链接管理列表
> - 安全：链接访问审计、可选密码保护、过期策略

---

## 7. 异常场景与回滚方案

### 7.1 后端服务异常

#### 场景1：后端服务崩溃

**触发条件**：未捕获的异常导致Node.js进程退出

**检测方式**：

```bash
# 使用PM2时自动检测
pm2 logs clipsync-api --lines 50 | grep -i "error\|exception\|crash"

# 手动检测
curl -s http://localhost:3001/health || echo "Service DOWN"
```

**自动恢复方案**（使用PM2）：

```bash
# PM2会自动重启崩溃的进程
# 配置最大重启次数（防止无限重启）
pm2 start src/index.js --name clipsync-api --max-restarts 10
```

**手动恢复方案**：

```bash
# 1. 检查日志定位崩溃原因
tail -100 logs/server.log

# 2. 重启服务
pm2 restart clipsync-api

# 3. 如重启失败，回滚到上一版本
cd src/server && git log --oneline -5
git checkout <last_working_commit>
npm install
pm2 restart clipsync-api
```

---

#### 场景2：数据库连接丢失

**触发条件**：PostgreSQL服务停止、网络分区、连接池耗尽

**检测方式**：

```bash
# 检查数据库连接
node -e "
const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', port: 5434, database: 'clipsync', user: 'clipsync', password: 'Admin@Local2024' });
pool.query('SELECT 1').then(() => console.log('DB OK')).catch(e => console.log('DB ERROR:', e.message));
"
```

**恢复方案**：

```bash
# 1. 重启PostgreSQL
docker restart clipsync-db
# 或
pg_ctl restart -D /path/to/data

# 2. 验证连接恢复
pg_isready -h localhost -p 5434

# 3. 重启后端服务（重建连接池）
pm2 restart clipsync-api
```

**回滚方案**（数据库损坏时）：

```bash
# 1. 停止所有服务
pm2 stop all

# 2. 从最新备份恢复
# 查看可用备份
ls -lt backups/

# 恢复备份
psql -h localhost -p 5434 -U clipsync -d clipsync_dev < backups/clipsync_backup_20260623.sql

# 3. 重启服务
pm2 start all
```

---

#### 场景3：Redis连接丢失

**恢复方案**：

```bash
# 1. 重启Redis
docker restart clipsync-redis

# 2. 验证连接
redis-cli -h localhost -p 6380 ping

# 3. 如数据丢失（未配置持久化），需要重建缓存
# 缓存数据可从数据库重新加载，不影响核心功能
```

---

### 7.2 移动端异常

#### 场景1：App崩溃（Crash）

**捕获Crash日志**：

```bash
# Android
adb logcat -b crash > crash_log.txt

# iOS
# Xcode → Window → Devices and Simulators → 选择设备 → View Device Logs
```

**处理流程**：

```
1. 捕获Crash日志
2. 分析堆栈信息，定位崩溃原因
3. 修复Bug后重新编译
4. 回归测试验证修复
```

---

#### 场景2：同步冲突无法自动解决

**处理方案**：

```
1. App提示「同步冲突，需要您的操作」
2. 用户可选择：
   a. 保留服务器版本
   b. 保留本地版本
   c. 手动合并
3. 选择后，版本被标记为解决状态
```

---

### 7.3 桌面端异常

#### 场景1：系统托盘图标消失

**触发条件**：桌面环境异常、进程僵死

**恢复方案**：

```bash
# Windows
# 打开任务管理器 → 结束ClipSync进程 → 重新启动

# macOS
killall ClipSync
open /Applications/ClipSync.app

# Linux
pkill clipsync
~/Applications/clipsync &
```

---

### 7.4 数据丢失回滚方案

#### 回滚触发条件

- [ ] 数据库被误删
- [ ] 错误的数据迁移导致数据损坏
- [ ] 恶意操作导致大量数据删除

#### 回滚步骤

```bash
# === 完整回滚流程 ===

# 1. 立即停止所有写入操作
pm2 stop clipsync-api
# 或修改配置，将App设为「维护模式」

# 2. 确认最新可用备份
ls -lt backups/ | head -5
# 选择最新的、未损坏的备份文件

# 3. 备份当前状态（以便后续分析）
pg_dump -h localhost -p 5434 -U clipsync clipsync > backups/before_rollback_$(date +%Y%m%d_%H%M%S).sql

# 4. 执行回滚
psql -h localhost -p 5434 -U clipsync -d clipsync_dev < backups/clipsync_backup_<timestamp>.sql

# 5. 验证数据完整性
psql -h localhost -p 5434 -U clipsync -d clipsync_dev -c "
  SELECT 
    (SELECT COUNT(*) FROM users) as user_count,
    (SELECT COUNT(*) FROM clipboard_items) as clipboard_count,
    (SELECT COUNT(*) FROM devices) as device_count;
"

# 6. 清理Redis缓存（强制从数据库重新加载）
redis-cli -h localhost -p 6380 flushdb

# 7. 重启服务
pm2 start clipsync-api

# 8. 通知所有在线用户「数据已恢复到 <timestamp> 版本」
```

---

### 7.5 异常场景汇总与负责人

| 异常场景 | 检测方式 | 自动恢复 | 手动恢复 | 负责人 |
|----------|-----------|-----------|-----------|--------|
| 后端服务崩溃 | 健康检查失败 | PM2自动重启 | 手动重启 | 运维 |
| 数据库连接丢失 | 健康检查失败 | 重连机制 | 重启PostgreSQL | 运维 |
| Redis连接丢失 | 缓存查询失败 | 重连机制 | 重启Redis | 运维 |
| 移动端App崩溃 | 用户报告 | 无 | 修复Bug发版 | 开发 |
| 同步冲突 | 用户报告 | Last-Write-Wins | 用户手动选择 | 产品 |
| 数据丢失 | 用户报告 | 无 | 从备份恢复 | 运维+DBA |
| 推送失败 | 推送送达率<50% | 无 | 检查FCM/APNs配置 | 运维 |

---

## 8. 性能与压力测试

### 8.1 性能指标定义

| 指标 | 目标值 | 测量方法 |
|------|--------|----------|
| 文本同步延迟 | < 2秒（同局域网） | 设备A复制→设备B收到推送的时间差 |
| 图片上传速度 | > 1MB/s | 上传进度条时间计算 |
| 大文件上传速度 | > 5MB/s | 分片上传总大小/总时间 |
| API响应时间（P95） | < 200ms | 后端日志统计 |
| API响应时间（P99） | < 500ms | 后端日志统计 |
| 内存占用（移动端） | < 100MB | Android Profiler / Xcode Instruments |
| 内存占用（桌面端） | < 200MB | 任务管理器 / Activity Monitor |
| 启动时间（冷启动） | < 3秒 | 日志时间戳分析 |
| 数据库查询（1000条） | < 100ms | EXPLAIN ANALYZE |

---

### 8.2 压力测试步骤

#### 测试1：并发用户同步

**工具**：使用Node.js脚本模拟多用户

```javascript
// test/concurrent-sync.js
const http = require('http');
const WebSocket = require('ws');

const CONCURRENT_USERS = 50;
const TEST_DURATION = 60000; // 1分钟

async function simulateUser(userId) {
  // 1. 登录
  const token = await login(`user${userId}`);
  
  // 2. 建立WebSocket连接
  const ws = new WebSocket(`ws://localhost:3001/ws?token=${token}`);
  
  // 3. 持续发送剪贴板
  const interval = setInterval(() => {
    sendClipboard(ws, `User${userId}: ${Date.now()}`);
  }, 1000); // 每秒1条
  
  setTimeout(() => {
    clearInterval(interval);
    ws.close();
  }, TEST_DURATION);
}

// 启动50个并发用户
for (let i = 0; i < CONCURRENT_USERS; i++) {
  simulateUser(i);
}
```

**预期结果**：

- [ ] 所有用户均能成功同步
- [ ] 服务端CPU占用 < 80%
- [ ] 服务端内存占用稳定（无内存泄漏）
- [ ] 数据库CPU < 70%
- [ ] 无请求超时（Error Rate < 1%）

---

#### 测试2：大量剪贴板数据查询

```bash
# 在数据库中插入10000条测试数据
psql -h localhost -p 5434 -U clipsync -d clipsync_dev -c "
INSERT INTO clipboard_items (id, user_id, content, content_type, source_device_id, created_at)
SELECT 
  gen_random_uuid(),
  '<TEST_USER_ID>',
  'Test content ' || i,
  'text',
  'test-device',
  NOW() - (i || ' seconds')::interval
FROM generate_series(1, 10000) i;
"

# 测试分页查询性能
time curl -X GET "http://localhost:3001/api/clipboard?page=1&limit=20" \
  -H "Authorization: Bearer <TOKEN>"
# 预期：< 200ms
```

---

#### 测试3：大文件并发上传

```bash
# 使用ab（ApacheBench）测试上传接口
# 需要先准备一个10MB的测试文件
dd if=/dev/urandom of=test_10mb.dat bs=1M count=10

# 10个并发，每个上传10MB文件
ab -n 10 -c 10 -T "application/octet-stream" \
  -H "Authorization: Bearer <TOKEN>" \
  -p test_10mb.dat \
  http://localhost:3001/api/media/upload/file
```

**预期结果**：

- [ ] 所有上传请求均成功（或返回合理的限流响应）
- [ ] 服务端磁盘I/O等待 < 50%
- [ ] 无OOM（Out Of Memory）错误

---

### 8.3 性能测试报告模板

```
## 性能测试报告

**测试日期**：YYYY-MM-DD
**测试环境**：[服务器配置] [网络带宽]
**测试工具**：[工具名称]

### 测试结果

| 测试项 | 目标值 | 实测值 | 是否通过 |
|--------|--------|--------|----------|
| 文本同步延迟 | < 2s | | |
| API P95响应时间 | < 200ms | | |
| 并发用户（50） | 无错误 | | |
| 内存占用（移动端） | < 100MB | | |

### 发现的问题

1. [问题描述]
   - 复现步骤：
   - 影响范围：
   - 建议修复：

### 结论

- [ ] 通过，可以进入下一阶段
- [ ] 不通过，需要优化后重新测试
```

---

### 8.4 性能优化效果验证

> 🚀 **测试目标**：验证Android包大小优化、Windows启动速度优化、内存优化是否达到目标。

#### 测试用例 8.4.1：Android包大小验证

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 编译Android App（Release版） | 生成APK/AAB文件 | |
| 2 | 检查APK大小 | < 10MB（优化目标） | |
| 3 | 检查AAB大小 | < 8MB（上传到Play Store） | |
| 4 | 使用APK Analyzer分析 | 确认资源压缩、代码混淆生效 | |

**验证命令**：

```bash
# 编译Release版
cd src/mobile && flutter build apk --release

# 检查APK大小
ls -lh src/mobile/build/app/outputs/flutter-apk/android/release/app-release.apk

# 使用APK Analyzer（Android Studio）
# Build > Analyze APK > 选择app-release.apk
```

#### 测试用例 8.4.2：Windows启动速度验证

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 编译Windows桌面端（Release版） | 生成.exe文件 | |
| 2 | 冷启动应用（首次打开） | 启动时间 < 3秒 | |
| 3 | 热启动应用（后台切换） | 启动时间 < 1秒 | |
| 4 | 检查二进制大小 | < 20MB（优化目标） | |

**验证命令**：

```bash
# 编译Release版
cd src/desktop && cargo build --release

# 检查二进制大小
ls -lh src/desktop/src-tauri/target/release/clipsync.exe

# 使用性能监视器测量启动时间
# Windows性能分析器 > 启动应用 > 记录启动时间
```

#### 测试用例 8.4.3：内存占用验证

| 平台 | 目标 | 验证方法 | 通过 |
|--------|------|----------|------|
| Android | < 100MB | Android Studio Profiler | |
| Windows | < 200MB | 任务管理器 | |
| macOS | < 200MB | Activity Monitor | |

**验证步骤**：

```bash
# Android内存分析
# 1. 连接Android设备
# 2. 打开Android Studio > Profiler > 选择设备
# 3. 操作应用5分钟
# 4. 检查内存占用峰值

# Windows内存分析
# 1. 打开任务管理器
# 2. 操作应用5分钟
# 3. 检查clipsync.exe内存占用峰值
```

---

## 9. 安全测试

### 9.1 认证与授权测试

#### 测试用例 9.1.1：Token过期与刷新

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 使用过期Token访问API | 返回401 Unauthorized | |
| 2 | 使用无效Token访问API | 返回401 Unauthorized | |
| 3 | 使用其他用户的Token访问 | 返回403 Forbidden | |
| 4 | Token即将过期时自动刷新 | 无感刷新，用户不掉线 | |

---

#### 测试用例 9.1.2：CSRF保护

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | POST请求不携带CSRF Token | 返回403 Forbidden | |
| 2 | 使用GET /api/csrf-token获取Token | 返回200 + Token字符串 | |
| 3 | 使用获取到的Token发送POST请求 | 返回200成功 | |
| 4 | 重复使用同一CSRF Token | 返回403 Forbidden（单次使用） | |

**自动化测试**：

```bash
cd src/server && npm run test:security
# 预期输出：38 security tests passed
```

---

### 9.2 输入验证测试

#### 测试用例 9.2.1：SQL注入防护

```bash
# 尝试SQL注入
curl -X POST http://localhost:3001/api/auth/send-code \
  -H "Content-Type: application/json" \
  -d '{"phone":"13800138000; DROP TABLE users;--"}'
# 预期：返回400 Bad Request（参数验证失败），数据库未被删除

# 验证数据库完好
psql -h localhost -p 5434 -U clipsync -d clipsync_dev -c "SELECT COUNT(*) FROM users;"
# 预期：返回正常行数，未报错
```

---

#### 测试用例 9.2.2：XSS防护

```bash
# 尝试XSS注入
curl -X POST http://localhost:3001/api/clipboard \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <CSRF_TOKEN>" \
  -d '{"content":"<script>alert(\"XSS\")</script>","contentType":"text"}'
# 预期：内容被存储，但返回时<script>被转义或过滤

# 验证：获取该条目
curl -X GET http://localhost:3001/api/clipboard/<item_id> \
  -H "Authorization: Bearer <TOKEN>"
# 预期：返回的content中不包含可执行的<script>标签
```

---

#### 测试用例 9.2.3：文件上传安全

| 测试 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 文件类型验证 | 上传 `.exe` 文件 | 拒绝，返回「不支持的文件类型」 | |
| 文件大小限制 | 上传100MB文件 | 拒绝，返回「文件过大」 | |
| 文件名安全 | 上传文件名包含 `../` | 文件名被 sanitize，无路径遍历 | |
| 病毒扫描 | 上传包含EICAR测试病毒的文件 | 拒绝，记录安全日志 | |

---

### 9.3 速率限制测试

```bash
# 测试登录接口速率限制（防止暴力破解）
for i in {1..20}; do
  curl -X POST http://localhost:3001/api/auth/verify-code \
    -H "Content-Type: application/json" \
    -d '{"phone":"13800138000","code":"wrong"}' \
    -w "\nRequest $i: %{http_code}\n"
done
# 预期：前5次返回400（验证码错误），第6次开始返回429（Too Many Requests）
```

---

### 9.4 安全测试汇总

| 测试类型 | 测试用例数 | 通过 | 失败 | 风险等级 |
|----------|-------------|------|------|----------|
| 认证授权 | 4 | | | |
| 输入验证 | 3 | | | |
| 速率限制 | 1 | | | |
| CSRF保护 | 4 | | | |
| **合计** | **12** | | | |

**安全准出条件**：

- [ ] 所有SQL注入测试用例通过
- [ ] 所有XSS测试用例通过
- [ ] 速率限制功能正常工作
- [ ] CSRF保护覆盖所有写操作
- [ ] 文件上传有完整的类型和大小验证

---

### 9.5 Webhook 安全测试

> 🔒 **功能说明**：ClipSync 支持微信支付、支付宝、Stripe 的 Webhook 回调，并提供了签名验证机制。

#### 测试用例 9.5.1：微信支付 Webhook 签名验证

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 发送正确的签名头（`x-wxp-signature`, `x-wxp-timestamp`, `x-wxp-nonce`） | 返回 200，处理 Webhook | |
| 2 | 发送错误的签名 | 返回 401，提示 "Invalid signature" | |
| 3 | 缺少签名头 | 返回 401，提示 "Missing signature headers" | |
| 4 | 重放攻击（使用相同的签名和时间戳） | 返回 409，提示 "Duplicate webhook request" | |

**测试命令**：

```bash
# 生成正确的签名
TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)
BODY='{"event_type":"payment.success","resource":{"transaction_id":"xxx"}}'
SIGN_STRING="${TIMESTAMP}\n${NONCE}\n${BODY}\n"
SIGNATURE=$(echo -n "$SIGN_STRING" | openssl dgst -sha256 -hmac -key "your_api_secret" | awk '{print $NF}')

# 发送 Webhook 请求
curl -X POST "http://localhost:3001/api/payments/wechat/webhook" \
  -H "Content-Type: application/json" \
  -H "x-wxp-signature: $SIGNATURE" \
  -H "x-wxp-timestamp: $TIMESTAMP" \
  -H "x-wxp-nonce: $NONCE" \
  -d "$BODY"

# 预期返回：200 OK
```

#### 测试用例 9.5.2：支付宝 Webhook 签名验证

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 发送正确的签名头（`x-alipay-signature`） | 返回 200，处理 Webhook | |
| 2 | 发送错误的签名 | 返回 401，提示 "Invalid signature" | |
| 3 | 缺少签名头 | 返回 401，提示 "Missing signature header" | |

#### 测试用例 9.5.3：Stripe Webhook 签名验证

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 发送正确的 Stripe 签名头（`stripe-signature`） | 返回 200，处理 Webhook | |
| 2 | 发送错误的签名 | 返回 401，提示 "Invalid signature" | |
| 3 | 缺少签名头 | 返回 401，提示 "Missing signature header" | |

#### 测试用例 9.5.4：幂等性保证

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 发送 Webhook 请求（带唯一幂等性键） | 返回 200，处理成功 | |
| 2 | 再次发送相同的请求 | 返回 200，返回之前的处理结果（不重复处理） | |
| 3 | 检查幂等性记录 | 幂等性键已记录，TTL 正确 | |

---

### 9.6 加密功能测试

> 🔒 **功能说明**：ClipSync 使用 AES-256-GCM 算法对敏感信息（手机号、邮箱等）进行加密存储。

#### 测试用例 9.6.1：敏感信息加密存储

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 注册用户（手机号 +86 138 1234 5678） | 注册成功 | |
| 2 | 检查数据库 `users` 表 | `phone` 字段存储明文（用于查询），`phone_encrypted` 字段存储加密数据 | |
| 3 | 使用加密密钥解密 `phone_encrypted` | 解密后与 `phone` 字段一致 | |
| 4 | 登录用户 | 登录成功，返回的手机号是解密后的 | |

**验证命令**：

```bash
# 1. 检查数据库中的加密字段
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "
  SELECT phone, phone_encrypted FROM users WHERE phone = '+8613812345678';
"

# 预期结果：
#   phone: "+8613812345678"
#   phone_encrypted: "a1b2c3d4e5f..." (加密后的数据)

# 2. 使用 Node.js 解密验证
node -e "
  import('./src/server/src/utils/encryption.js').then(m => {
    const decrypted = m.decryptField('encrypted_data_here', 'secret_key_here');
    console.log('Decrypted:', decrypted);
  });
"
```

#### 测试用例 9.6.2：加密数据解密

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 登录用户，获取个人资料 | 返回的手机号、邮箱是解密后的明文 | |
| 2 | 调用需要解密的 API | API 返回解密后的数据 | |
| 3 | 检查 API 响应 | 不包含加密字段（如 `phone_encrypted`） | |

#### 测试用例 9.6.3：加密密钥轮换

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 生成新的加密密钥 | 新密钥已保存到 `encryption_keys` 表 | |
| 2 | 使用旧密钥加密的数据 | 仍可使用旧密钥解密 | |
| 3 | 使用新密钥加密的数据 | 使用新密钥解密 | |
| 4 | 将新密钥设为活跃密钥 | 新数据使用新密钥加密 | |

**验证命令**：

```bash
# 1. 查看当前活跃的加密密钥
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "
  SELECT key_name, algorithm, is_active, created_at FROM encryption_keys;
"

# 2. 生成新的加密密钥（使用 API 或脚本）
node -e "
  import('./src/server/src/utils/encryption.js').then(m => {
    const newKey = m.generateNewKey();
    console.log('New Key:', newKey);
  });
"

# 3. 将新密钥保存到数据库
docker exec clipsync-db psql -U clipsync -d clipsync_dev -c "
  INSERT INTO encryption_keys (key_name, key_value, iv, algorithm, is_active)
  VALUES ('clipsync_key_2026_06', 'new_key_here', 'iv_here', 'AES-256-GCM', true);
"
```

---

### 9.7 安全测试汇总

| 测试类型 | 测试用例数 | 通过 | 失败 | 风险等级 |
|----------|-------------|------|------|----------|
| 认证授权 | 4 | | | |
| 输入验证 | 3 | | | |
| 速率限制 | 1 | | | |
| CSRF 保护 | 4 | | | |
| Webhook 安全 | 4 | | | |
| 加密功能 | 3 | | | |
| **合计** | **19** | | | |

**安全准出条件**：

- [ ] 所有 SQL 注入测试用例通过
- [ ] 所有 XSS 测试用例通过
- [ ] 速率限制功能正常工作
- [ ] CSRF 保护覆盖所有写操作
- [ ] Webhook 签名验证正常工作
- [ ] 敏感信息加密存储正常
- [ ] 文件上传有完整的类型和大小验证

---

## 10. 准出条件与生产环境就绪判定

### 10.1 功能测试准出条件

| 条件 | 具体要求 | 验证方式 | 状态 |
|------|-----------|----------|------|
| 核心功能完整 | 所有PRODUCTION_ROADMAP中标记为✅的功能均可正常工作 | 端对端测试 | |
| 文本同步 | 双向同步延迟 < 2秒，准确率100% | 自动化测试+手动验证 | |
| 图片同步 | 支持JPG/PNG/GIF/WebP，准确率100% | 多格式测试 | |
| 文件同步 | 支持分片上传，断点续传正常 | 大文件上传测试 | |
| 离线同步 | 离线操作在联网后自动同步 | 离线→联网测试 | |
| 推送通知 | 新内容推送到达率 > 95% | 推送送达统计 | |
| 冲突处理 | Last-Write-Wins策略正常，用户可查看版本历史 | 冲突场景测试 | |

---

### 10.2 性能准出条件

| 条件 | 目标值 | 实测值 | 状态 |
|------|--------|--------|------|
| API P95响应时间 | < 200ms | | |
| API P99响应时间 | < 500ms | | |
| 文本同步延迟（局域网） | < 2s | | |
| 文本同步延迟（公网） | < 5s | | |
| 移动端启动时间 | < 3s | | |
| 移动端内存占用 | < 100MB | | |
| 桌面端内存占用 | < 200MB | | |
| 服务端CPU（50并发） | < 80% | | |
| 数据库CPU（50并发） | < 70% | | |

---

### 10.3 安全准出条件

| 条件 | 具体要求 | 状态 |
|------|-----------|------|
| 认证机制 | JWT Token过期自动刷新，无永久有效Token | |
| CSRF保护 | 所有写操作均需CSRF Token | |
| SQL注入防护 | 所有数据库查询使用参数化，无拼接SQL | |
| XSS防护 | 所有用户输入在显示时转义 | |
| 速率限制 | 登录/验证码接口有速率限制 | |
| HTTPS | 生产环境强制HTTPS（TLS 1.2+） | |
| 敏感数据加密 | 用户密码使用bcrypt加密，JWT Secret安全存储 | |

---

### 10.4 稳定性准出条件

| 条件 | 具体要求 | 验证方式 | 状态 |
|------|-----------|----------|------|
| 7x24小时运行 | 服务连续运行7天无崩溃 | 监控日志 | |
| 内存泄漏 | 服务端运行7天，内存增长 < 10% | 内存监控图表 | |
| 错误率 | 7天内API错误率 < 0.1% | 错误日志统计 | |
| 数据一致性 | 同步操作后，各设备数据一致 | 数据校验脚本 | |

**7x24稳定性测试步骤**：

```bash
# 1. 启动服务监控脚本
nohup node scripts/stability-monitor.js > logs/stability.log 2>&1 &

# 2. 监控脚本内容（示例）
# - 每5分钟执行一次健康检查
# - 记录响应时间
# - 记录错误日志
# - 每天生成一份稳定性报告

# 3. 7天后查看报告
cat logs/stability-report-$(date +%Y-%m-%d).txt
```

---

### 10.5 生产环境就绪判定表

**最终判定**：只有以下所有条件均满足时，才可部署到生产环境。

| # | 判定项 | 必须 | 实际 | 通过 |
|---|--------|------|------|------|
| 1 | 所有功能测试通过（10个端对端测试用例全部PASS） | ✓ | | |
| 2 | 性能测试通过（所有性能指标达标） | ✓ | | |
| 3 | 安全测试通过（12个安全测试用例全部PASS） | ✓ | | |
| 4 | 稳定性测试通过（7x24小时无崩溃） | ✓ | | |
| 5 | 外部依赖验证通过（数据库、Redis、推送、短信） | ✓ | | |
| 6 | 回滚方案验证通过（从备份恢复数据 < 30分钟） | ✓ | | |
| 7 | 灾难恢复演练通过（完整DR演练） | ✓ | | |
| 8 | 监控告警配置完成（Sentry/Prometheus/Grafana） | ✓ | | |
| 9 | 负载均衡配置完成（生产环境） | ✓ | | |
| 10 | 自动扩缩容配置完成（云环境） | ✓ | | |
| 11 | 域名和SSL证书配置完成 | ✓ | | |
| 12 | 用户操作指南文档完成 | ✓ | ✓ | |
| 13 | 运维部署文档完成 | ✓ | | |
| 14 | 测试报告经过产品负责人审批 | ✓ | | |

**判定结果**：

- [ ] ✅ **通过**：所有14项均通过，可以部署到生产环境
- [ ] ⚠️ **有条件通过**：非阻塞项（#8-#11）可在生产环境配置，但需要有明确的配置计划
- [ ] ❌ **不通过**：阻塞项（#1-#7）有未通过项，需要修复后重新测试

---

## 11. 测试报告模板

### 报告头信息

```
# ClipSync 生产级测试报告

**版本**：v0.1.0
**测试周期**：YYYY-MM-DD ~ YYYY-MM-DD
**测试负责人**：[姓名]
**测试环境**：
  - 后端服务器：[IP地址] [配置]
  - 数据库：PostgreSQL [版本] @ [IP:端口]
  - Redis：[版本] @ [IP:端口]
  - 移动端设备：[型号] [系统版本]
  - 桌面端：[操作系统] [版本]

**测试总结**：
  - 总测试用例数：
  - 通过数：
  - 失败数：
  - 阻塞数：
  - 通过率：
  - 是否建议部署到生产环境：[ ] 是 [ ] 否
```

### 缺陷汇总

| 缺陷ID | 严重程度 | 功能模块 | 描述 | 状态 | 负责人 |
|---------|----------|----------|------|------|--------|
| BUG-001 | 🔴 严重 | 同步 | 大文件上传时服务端OOM | Open | |
| BUG-002 | 🟡 一般 | 推送 | iOS推送偶发不到达 | Open | |
| BUG-003 | 🟢 轻微 | UI | 登录页面按钮对齐问题 | Fixed | |

### 附录：测试数据

```sql
-- 测试用户
INSERT INTO users (id, phone, created_at) VALUES
('test-user-001', '13800138000', NOW());

-- 清理测试数据（测试完成后执行）
DELETE FROM clipboard_items WHERE user_id = 'test-user-001';
DELETE FROM devices WHERE user_id = 'test-user-001';
DELETE FROM users WHERE id = 'test-user-001';
```

---

## 12. 桌面端功能测试

> **测试目标**：验证桌面端所有功能的完整性和可用性。

### 12.1 系统托盘测试

**测试步骤**：

```bash
# 1. 启动ClipSync桌面端
# Windows: 双击 ClipSync.exe 或从开始菜单启动

# 2. 验证系统托盘图标显示
# 预期：Windows任务栏通知区域显示ClipSync图标

# 3. 右键点击托盘图标
# 预期：显示菜单（显示主窗口、隐藏到托盘、退出）

# 4. 左键单击托盘图标
# 预期：切换主窗口显示/隐藏

# 5. 点击"显示主窗口"
# 预期：主窗口显示并获得焦点

# 6. 点击"隐藏到托盘"
# 预期：主窗口隐藏，托盘图标保留

# 7. 点击"退出"
# 预期：应用完全退出，托盘图标消失
```

**判定标准**：
- [ ] 托盘图标正常显示
- [ ] 左键单击切换窗口显示/隐藏
- [ ] 右键菜单功能正常
- [ ] 退出后托盘图标消失

---

### 12.2 全局快捷键测试

**测试步骤**：

```bash
# 1. 启动ClipSync桌面端

# 2. 验证默认快捷键 Ctrl+Shift+V（Windows/Linux）或 Cmd+Shift+V（macOS）
# 操作：在任何窗口（浏览器、记事本等）按 Ctrl+Shift+V
# 预期：ClipSync主窗口显示并获得焦点

# 3. 修改快捷键
# 操作：打开设置页面 → 快速粘贴快捷键 → 输入新的快捷键（如 Alt+Space）→ 保存
# 预期：提示"快捷键已更新"

# 4. 验证新快捷键
# 操作：按新的快捷键组合（如 Alt+Space）
# 预期：ClipSync主窗口显示并获得焦点

# 5. 恢复默认快捷键
# 操作：在设置页面输入 CmdOrCtrl+Shift+V → 保存
# 预期：默认快捷键恢复生效
```

**判定标准**：
- [ ] 默认快捷键（Ctrl+Shift+V）正常工作
- [ ] 快捷键自定义功能正常
- [ ] 新快捷键立即生效（无需重启）
- [ ] 快捷键与其他应用无冲突

---

### 12.3 剪贴板监控测试

**测试步骤**：

```bash
# 1. 启动ClipSync桌面端（确保剪贴板监控已启用）

# 2. 复制文本
# 操作：选中一段文本 → 按 Ctrl+C
# 预期：ClipSync主窗口显示新复制的文本

# 3. 复制图片
# 操作：截图（Win+Shift+S）→ 粘贴到ClipSync
# 预期：图片正常同步

# 4. 验证去抖功能
# 操作：快速连续复制多次（10次以上）
# 预期：不会触发多次同步，只同步最后一次

# 5. 验证监控间隔
# 预期：剪贴板内容变化后100ms内检测到（通过日志验证）
```

**判定标准**：
- [ ] 文本复制正常监控
- [ ] 图片复制正常监控
- [ ] 去抖功能正常（快速复制只同步最后一次）
- [ ] 监控间隔合理（100ms轮询 + 500ms去抖）
- [ ] CPU占用低（监控线程不占用过多资源）

---

### 12.4 开机自启动测试

**测试步骤**：

```bash
# Windows测试：
# 1. 打开ClipSync设置页面
# 2. 启用"开机自启动"
# 预期：提示成功

# 3. 验证注册表（Windows）
# 操作：Win+R → 输入 shell:startup → 检查是否有ClipSync快捷方式
# 或：注册表编辑器 → HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run → 检查ClipSync项

# 4. 重启电脑
# 预期：ClipSync自动启动，系统托盘显示图标

# 5. 禁用"开机自启动"
# 预期：提示成功，重启后ClipSync不再自动启动
```

**判定标准**：
- [ ] 启用自启动功能正常
- [ ] 禁用自启动功能正常
- [ ] 重启后自动启动生效
- [ ] 注册表/启动项正确配置

---

### 12.5 桌面通知测试

**测试步骤**：

```bash
# 1. 打开ClipSync设置页面
# 2. 确保"推送通知"已启用

# 3. 触发同步通知
# 操作：在另一台设备复制文本 → ClipSync同步到当前设备
# 预期：Windows通知区域显示ClipSync通知"剪贴板已同步"

# 4. 点击通知
# 预期：ClipSync主窗口显示并获得焦点

# 5. 禁用通知
# 操作：设置页面 → 禁用"推送通知"
# 预期：后续同步不再显示通知
```

**判定标准**：
- [ ] 同步通知正常显示
- [ ] 点击通知打开主窗口
- [ ] 通知开关功能正常
- [ ] 通知内容正确（显示同步的文本内容）

---

### 12.6 快速粘贴面板测试

**测试步骤**：

```bash
# 1. 按全局快捷键 Ctrl+Shift+V（或自定义快捷键）
# 预期：快速粘贴面板显示

# 2. 验证面板内容
# 预期：显示最近复制的剪贴板历史（文本、图片）

# 3. 搜索功能
# 操作：在面板搜索框输入关键词
# 预期：实时过滤显示匹配的条目

# 4. 预览功能
# 操作：点击一个条目
# 预期：面板底部显示内容预览（文本前200字符，或图片缩略图）

# 5. 收藏功能
# 操作：点击条目右侧的收藏图标
# 预期：图标变为已收藏状态

# 6. 过滤收藏
# 操作：点击"仅显示收藏"按钮
# 预期：只显示已收藏的条目

# 7. 选择条目粘贴
# 操作：点击一个条目
# 预期：面板关闭，内容自动粘贴到当前焦点窗口
```

**判定标准**：
- [ ] 面板正常显示（快捷键触发）
- [ ] 搜索功能正常（实时过滤）
- [ ] 预览功能正常（文本/图片）
- [ ] 收藏功能正常（添加/移除/过滤）
- [ ] 选择条目后自动粘贴

---

### 12.7 设置页面测试

**测试步骤**：

```bash
# 1. 打开ClipSync设置页面

# 2. 验证所有设置项显示
# 预期：显示以下设置项
#   - 服务器地址
#   - 开机自启动
#   - 推送通知
#   - 主题
#   - 语言
#   - 快速粘贴快捷键
#   - 清理缓存
#   - 导出日志
#   - 关于

# 3. 修改服务器地址
# 操作：输入新的服务器地址 → 保存
# 预期：提示"服务器地址已保存"

# 4. 修改主题
# 操作：选择"深色"主题
# 预期：界面立即切换为深色主题

# 5. 修改语言
# 操作：选择"English"
# 预期：界面语言切换为英文

# 6. 清理缓存
# 操作：点击"清理缓存"
# 预期：提示"缓存已清理"

# 7. 导出日志
# 操作：点击"导出日志"
# 预期：提示"日志已导出至: [路径]"
```

**判定标准**：
- [ ] 所有设置项正常显示
- [ ] 服务器地址修改生效
- [ ] 主题切换正常
- [ ] 语言切换正常
- [ ] 缓存清理功能正常
- [ ] 日志导出功能正常

---

### 12.8 引导流程测试

**测试步骤**：

```bash
# 1. 首次启动ClipSync（或清除 onboarded 标记）
# 操作：删除配置文件或注册表项，使应用认为是首次启动

# 2. 验证引导页面显示
# 预期：显示5页引导内容
#   - 第1页：欢迎使用ClipSync
#   - 第2页：系统托盘介绍
#   - 第3页：全局快捷键介绍
#   - 第4页：剪贴板监控介绍
#   - 第5页：准备开始

# 3. 翻页功能
# 操作：点击"下一步"
# 预期：翻到下一页

# 4. 跳过功能
# 操作：点击"跳过"
# 预期：引导流程结束，进入主窗口

# 5. 完成引导
# 操作：翻到最后一页 → 点击"开始使用"
# 预期：引导流程结束，进入主窗口

# 6. 验证 onboarded 标记
# 操作：重启应用
# 预期：不再显示引导流程（直接进入主窗口）
```

**判定标准**：
- [ ] 首次启动显示引导流程
- [ ] 5页引导内容正确显示
- [ ] 翻页功能正常
- [ ] 跳过功能正常
- [ ] 完成引导后不再显示
- [ ] onboarded 标记正确保存

---

### 12.9 自动更新测试

**测试步骤**：

```bash
# 注意：此功能需要配置更新服务器，以下为模拟测试

# 1. 验证更新检查命令
# 操作：在开发者工具中调用 check_for_updates 命令
# 预期：返回 { "hasUpdate": false }（当前版本为最新）

# 2. 模拟更新可用（需要搭建测试更新服务器）
# 预期：返回 { "hasUpdate": true, "version": "0.2.0" }

# 3. 验证更新下载和安装
# 预期：自动下载更新包，安装后重启应用

# 4. 验证更新配置文件（tauri.conf.json）
# 预期：endpoints 配置正确，pubkey 配置正确
```

**判定标准**：
- [ ] 更新检查功能正常
- [ ] 更新下载功能正常（需要测试服务器）
- [ ] 更新安装功能正常（需要测试服务器）
- [ ] 更新配置文件正确

---

### 12.10 桌面端功能测试总结

| 功能模块 | 测试用例数 | 通过数 | 失败数 | 通过率 |
|----------|-------------|---------|---------|--------|
| 系统托盘 | 5 | | | |
| 全局快捷键 | 5 | | | |
| 剪贴板监控 | 5 | | | |
| 开机自启动 | 5 | | | |
| 桌面通知 | 5 | | | |
| 快速粘贴面板 | 7 | | | |
| 设置页面 | 7 | | | |
| 引导流程 | 6 | | | |
| 自动更新 | 4 | | | |
| **总计** | **49** | | | |

**判定标准**：
- [ ] ✅ **通过**：所有测试用例通过率 ≥ 95%
- [ ] ⚠️ **有条件通过**：通过率 80-95%，非阻塞缺陷可在后续版本修复
- [ ] ❌ **不通过**：通过率 < 80%，需要修复后重新测试

---

## 13. 移动端功能测试

> 📱 **测试说明**：本章节详细描述 Flutter 移动端 App 的所有功能测试步骤，适用于 Android 和 iOS 手动测试。

### 13.1 登录与注册流程测试

#### 测试用例 13.1.1：手机号登录

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 打开 ClipSync App | 显示欢迎页面，有「登录」按钮 | |
| 2 | 点击「登录」 | 显示手机号输入框 + 验证码输入框 | |
| 3 | 输入手机号 `13800138000` | 手机号格式验证通过 | |
| 4 | 点击「发送验证码」 | 按钮变为「60秒后重新发送」，倒计时开始 | |
| 5 | 检查手机短信 | 收到验证码短信 | |
| 6 | 输入验证码 | 验证码格式验证通过 | |
| 7 | 点击「登录」 | 登录成功，进入主界面 | |

**异常场景**：
- 手机号格式错误：提示「请输入正确的手机号」
- 验证码错误：提示「验证码错误，请重新输入」
- 网络超时：提示「网络连接失败，请重试」

#### 测试用例 13.1.2：自动登录（Token持久化）

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 首次登录成功 | 进入主界面 | |
| 2 | 完全关闭 App（划掉后台） | App 完全退出 | |
| 3 | 重新打开 App | 自动登录，直接进入主界面（不显示登录页） | |
| 4 | 检查 Token 是否刷新 | 使用旧 Token 仍能访问 API | |

**验证方法**：
```bash
# 在设备上查看存储的 Token
# Android: adb shell "run-as com.clipsync.app cat /data/data/com.clipsync.app/shared_prefs/xxx.xml"
# iOS: Xcode → Devices → Download Container → 查看 UserDefaults
```

---

### 13.2 主界面剪贴板列表测试

#### 测试用例 13.2.1：剪贴板列表加载

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 登录后进入主界面 | 显示剪贴板列表（最新在上） | |
| 2 | 检查列表项 | 每项显示：内容预览、设备名称、时间、类型图标 | |
| 3 | 下拉刷新 | 列表更新，显示最新数据 | |
| 4 | 上拉加载更多 | 分页加载，显示更多历史记录 | |
| 5 | 列表为空时 | 显示「暂无剪贴板记录」提示 | |

#### 测试用例 13.2.2：剪贴板列表项操作

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 长按某条剪贴板 | 显示操作菜单（复制、删除、分享） | |
| 2 | 点击「复制」 | 内容复制到系统剪贴板，提示「已复制」 | |
| 3 | 点击「删除」 | 显示确认对话框，确认后删除 | |
| 4 | 点击「分享」 | 调用系统分享对话框 | |
| 5 | 点击某条剪贴板 | 显示剪贴板详情页 | |

---

### 13.3 剪贴板详情页测试

#### 测试用例 13.3.1：文本内容详情

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 点击文本类型剪贴板 | 显示详情页，完整显示文本内容 | |
| 2 | 点击「复制」按钮 | 文本复制到系统剪贴板 | |
| 3 | 点击「分享」按钮 | 调用系统分享 | |
| 4 | 检查设备来源 | 显示「来自：设备名称」 | |
| 5 | 检查时间 | 显示创建时间和更新时间 | |

#### 测试用例 13.3.2：图片内容详情

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 点击图片类型剪贴板 | 显示图片预览（可缩放） | |
| 2 | 点击「保存图片」 | 图片保存到系统相册 | |
| 3 | 点击「分享图片」 | 调用系统分享 | |
| 4 | 长按图片 | 显示「保存到相册」「复制图片」选项 | |

#### 测试用例 13.3.3：文件内容详情

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 点击文件类型剪贴板 | 显示文件详情（文件名、大小、类型） | |
| 2 | 点击「下载」 | 文件下载到本地，显示下载进度 | |
| 3 | 下载完成后点击「打开」 | 调用系统应用打开文件 | |
| 4 | 点击「分享文件」 | 调用系统分享 | |

---

### 13.4 上传剪贴板测试

#### 测试用例 13.4.1：上传文本剪贴板

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在主界面点击「+」按钮 | 显示输入界面（文本输入框） | |
| 2 | 输入文本「Hello from Mobile」 | 文本显示在输入框 | |
| 3 | 点击「上传」 | 上传成功，返回主界面，列表顶部显示新条目 | |
| 4 | 检查其他设备 | 其他设备收到推送，列表显示新条目 | |

#### 测试用例 13.4.2：上传图片剪贴板

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在主界面点击「+」按钮 → 选择「图片」 | 打开系统相册 | |
| 2 | 选择一张图片 | 图片显示在预览区域 | |
| 3 | 点击「上传」 | 上传成功，返回主界面 | |
| 4 | 检查图片缩略图 | 列表项显示图片缩略图 | |

#### 测试用例 13.4.3：上传文件剪贴板

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在主界面点击「+」按钮 → 选择「文件」 | 打开系统文件选择器 | |
| 2 | 选择一个文件（如 PDF） | 文件信息显示在预览区域 | |
| 3 | 点击「上传」 | 显示上传进度条，上传成功 | |
| 4 | 检查文件大小显示 | 列表项显示文件大小和类型图标 | |

---

### 13.5 搜索功能测试

#### 测试用例 13.5.1：基础搜索

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在主界面点击搜索图标 | 显示搜索框 | |
| 2 | 输入关键词「Hello」 | 实时显示搜索结果（包含「Hello」的条目） | |
| 3 | 输入中文关键词「测试」 | 显示包含「测试」的条目 | |
| 4 | 清空搜索框 | 显示完整列表 | |
| 5 | 搜索不存在的内容 | 显示「未找到相关结果」 | |

#### 测试用例 13.5.2：搜索结果操作

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 搜索某关键词，点击结果项 | 显示该剪贴板详情 | |
| 2 | 从详情页返回 | 返回搜索结果页，搜索关键词仍保留 | |
| 3 | 取消搜索 | 返回完整列表 | |

---

### 13.6 设置页面测试

#### 测试用例 13.6.1：设置页面UI

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在主界面点击「设置」图标 | 显示设置页面 | |
| 2 | 检查设置项 | 显示：用户信息、设备管理、通知设置、关于、退出登录 | |
| 3 | 点击用户信息区域 | 显示用户详情（手机号、注册时间） | |
| 4 | 点击「关于」 | 显示版本号、隐私政策、用户协议 | |

#### 测试用例 13.6.2：退出登录

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在设置页面点击「退出登录」 | 显示确认对话框 | |
| 2 | 确认退出 | 返回登录页面 | |
| 3 | 重新打开 App | 显示登录页面（不会自动登录） | |
| 4 | 使用旧 Token 访问 API | 返回 401 Unauthorized | |

---

### 13.7 设备管理页面测试

#### 测试用例 13.7.1：设备列表

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在设置页面点击「设备管理」 | 显示已登录设备列表 | |
| 2 | 检查当前设备 | 显示「当前设备」标记 | |
| 3 | 检查其他设备 | 显示设备名称、类型、最后在线时间 | |
| 4 | 点击某设备 | 显示设备详情（IP地址、系统版本） | |

#### 测试用例 13.7.2：移除设备

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在设备列表中点击某设备 | 显示「移除设备」按钮 | |
| 2 | 点击「移除设备」 | 显示确认对话框 | |
| 3 | 确认移除 | 设备从列表中消失 | |
| 4 | 被移除设备尝试同步 | 提示「设备已被移除」 | |

---

### 13.8 通知设置测试

#### 测试用例 13.8.1：通知偏好设置

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 在设置页面点击「通知设置」 | 显示通知偏好开关 | |
| 2 | 检查开关状态 | 与服务器端保存的偏好一致 | |
| 3 | 切换「新剪贴板推送」开关 | 开关状态改变，提示「保存成功」 | |
| 4 | 退出重新进入 | 设置已保存 | |

---

### 13.9 离线模式测试

#### 测试用例 13.9.1：离线后重新上线

| 步骤 | 操作 | 预期结果 | 通过 |
|------|------|----------|------|
| 1 | 确保 App 已登录，关闭手机网络（飞行模式） | App 显示「离线」状态 | |
| 2 | 在离线状态下上传剪贴板（如果有本地队列） | 显示「离线，将在联网后同步」 | |
| 3 | 重新打开网络 | App 自动同步，显示最新数据 | |
| 4 | 检查其他设备 | 其他设备收到离线期间的操作 | |

---

### 13.10 移动端功能测试汇总表

| 测试类型 | 测试用例数 | 通过 | 失败 | 阻塞 | 通过率 |
|----------|-------------|------|------|------|--------|
| 登录与注册 | 2 | | | | |
| 主界面列表 | 2 | | | | |
| 剪贴板详情 | 3 | | | | |
| 上传剪贴板 | 3 | | | | |
| 搜索功能 | 2 | | | | |
| 设置页面 | 2 | | | | |
| 设备管理 | 2 | | | | |
| 通知设置 | 1 | | | | |
| 离线模式 | 1 | | | | |
| **合计** | **18** | | | | |

---

## 附录A：快速验证检查清单

> 每次发版前，执行以下快速检查（预计时间：15分钟）。

```
□ 后端服务健康检查通过（/health 返回200）
□ 登录功能正常（验证码发送+验证）
□ 文本同步正常（2台设备互相同步文本）
□ 图片同步正常（上传一张截图，另一台设备能收到）
□ 文件上传正常（上传一个PDF文件）
□ 推送通知正常（App在后台时，新内容能触发推送）
□ 离线同步正常（断网→操作→联网→自动同步）
□ 设置页面能正常保存配置
□ 退出登录后，Token立即失效
□ 错误日志无Severe级别错误
□ 桌面端系统托盘正常显示
□ 桌面端全局快捷键正常工作
□ 桌面端剪贴板监控正常
□ 桌面端快速粘贴面板正常显示
```

---

## 附录B：联系方式与升级路径

| 角色 | 职责 | 联系方式 |
|------|------|----------|
| 测试负责人 | 测试计划、测试执行、报告输出 | |
| 后端开发负责人 | 后端Bug修复 | |
| 移动端开发负责人 | Android/iOS Bug修复 | |
| 桌面端开发负责人 | Windows/macOS Bug修复 | |
| 运维负责人 | 部署、监控、回滚 | |
| 产品负责人 | 准出条件审批 | |

**紧急升级路径**：

```
Level 1：开发团队（Bug修复，< 4小时响应）
    ↓ 无法解决
Level 2：技术负责人（架构调整，< 24小时响应）
    ↓ 无法解决
Level 3：产品负责人（决策是否延期发版）
```

---

*文档结束*

*本文档为ClipSync项目生产级测试的指导文档，所有测试活动应严格按照本文档执行。测试过程中发现的任何问题，均应记录在测试报告中，并分配给相应负责人跟进修复。*
