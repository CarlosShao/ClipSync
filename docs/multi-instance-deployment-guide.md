# ClipSync 多实例部署指南

## 📊 概述

本文档介绍如何使用 Docker Compose 部署多个 ClipSync 后端实例，并通过 Nginx 实现负载均衡，提高系统的可用性和吞吐量。

## 🏗️ 架构

多实例部署架构包含以下组件：

1. **Nginx** (端口 80/443)
   - 负载均衡器
   - 反向代理
   - SSL 终止（可选）

2. **ClipSync API 实例** (端口 3001, 3002)
   - 至少 2 个实例
   - 无状态设计（理论上）
   - 共享 PostgreSQL 和 Redis

3. **PostgreSQL** (端口 5432)
   - 主数据库
   - 所有实例共享

4. **Redis** (端口 6379)
   - 缓存
   - 会话存储（理论上）

## 🚀 快速启动

### 前置条件

- Docker 已安装并运行
- Docker Compose 已安装
- ClipSync 后端代码已准备好（可以构建 Docker 镜像）

### 启动步骤

1. **构建 Docker 镜像**

```bash
# 进入 ClipSync 项目根目录
cd D:/work/java/AI-workspace/ClipSync

# 构建 API 镜像
docker build -t clipsync-api:latest ./src/server
```

2. **启动多实例部署**

```bash
# 启动所有服务
docker compose -f docker-compose.multi.yml up -d

# 查看运行状态
docker compose -f docker-compose.multi.yml ps

# 查看日志
docker compose -f docker-compose.multi.yml logs -f
```

3. **验证服务**

```bash
# 检查 Nginx 是否正常运行
curl http://localhost/api/health

# 检查 API 实例 1 是否正常运行
curl http://localhost:3001/api/health

# 检查 API 实例 2 是否正常运行
curl http://localhost:3002/api/health
```

4. **访问应用**

- API 端点：http://localhost/api/
- 健康检查：http://localhost/api/health
- Metrics：http://localhost/api/metrics/json

## ⚠️ 重要限制

### 当前问题：内存会话管理

**问题**：ClipSync 后端当前使用内存 Map 管理 WebSocket 连接和会话：
- `uploadSessions` - 上传会话（内存 Map）
- `connections` - WebSocket 连接（内存 Map）
- `csrfTokens` - CSRF 令牌（内存 Map）

**影响**：如果使用多实例部署，这些内存数据无法在实例之间共享，会导致：
- WebSocket 连接无法跨实例通信
- 用户会话丢失（如果请求被路由到不同实例）
- CSRF 验证失败

**解决方案**：

1. **短期方案**：使用 Nginx sticky session（会话保持）
   - 将同一用户的请求路由到同一实例
   - 修改 `nginx/nginx.conf`，启用 `ip_hash` 或 `sticky` 模块
   - **缺点**：如果实例宕机，用户会话会丢失

2. **长期方案**：将会话数据迁移到 Redis
   - 将 `uploadSessions`、`connections`、`csrfTokens` 存储到 Redis
   - 所有实例共享 Redis 中的数据
   - **优点**：真正的无状态设计，实例可以动态扩缩容
   - **工作量**：需要修改后端代码

### 当前建议

**测试环境**：可以使用多实例部署 + sticky session（用于测试负载均衡功能）

**生产环境**：**强烈建议**先解决会话管理问题（迁移到 Redis），再使用多实例部署。

## 🔧 配置说明

### Nginx 负载均衡策略

在 `nginx/nginx.conf` 中配置：

```nginx
upstream clipsync_api {
    # 策略1：最少连接数（推荐）
    least_conn;

    # 策略2：轮询（默认）
    # 不配置，默认轮询

    # 策略3：IP 哈希（会话保持）
    # ip_hash;

    # 策略4：权重（可以根据实例性能配置）
    # server clipsync-api-1:3000 weight=2;
    # server clipsync-api-2:3000 weight=1;

    server clipsync-api-1:3000 max_fails=3 fail_timeout=30s;
    server clipsync-api-2:3000 max_fails=3 fail_timeout=30s;
}
```

### 健康检查

Nginx 会自动检测后端实例的健康状态：
- 如果实例返回错误（5xx），Nginx 会自动将请求路由到健康实例
- `max_fails=3` - 最多失败 3 次
- `fail_timeout=30s` - 失败后 30 秒内不路由到该实例

### 会话保持（Sticky Session）

如果使用内存会话管理，需要配置会话保持：

1. **方式一：IP 哈希**（简单，但不精确）
   ```nginx
   upstream clipsync_api {
       ip_hash;
       server clipsync-api-1:3000;
       server clipsync-api-2:3000;
   }
   ```

2. **方式二：Nginx Sticky 模块**（需要 Nginx Plus 或编译模块）
   ```nginx
   upstream clipsync_api {
       sticky cookie srv_id expires=1h domain=.example.com path=/;
       server clipsync-api-1:3000;
       server clipsync-api-2:3000;
   }
   ```

## 📈 扩展实例

### 添加更多实例

1. **修改 `docker-compose.multi.yml`**，添加 `api-3`、`api-4` 等服务

2. **修改 `nginx/nginx.conf`**，在 `upstream` 块中添加新实例
   ```nginx
   upstream clipsync_api {
       least_conn;
       server clipsync-api-1:3000;
       server clipsync-api-2:3000;
       server clipsync-api-3:3000;  # 新增
   }
   ```

3. **重启 Nginx**
   ```bash
   docker compose -f docker-compose.multi.yml restart nginx
   ```

### 自动扩缩容（需云服务）

本地 Docker Compose 不支持自动扩缩容。如果需要自动扩缩容，建议使用：
- **Docker Swarm**（简单）
- **Kubernetes**（复杂，但功能强大）
- **云服务商**（AWS ECS、Google GKE、Azure AKS）

## 🛠️ 维护

### 重启服务

```bash
# 重启所有服务
docker compose -f docker-compose.multi.yml restart

# 重启单个服务
docker compose -f docker-compose.multi.yml restart api-1
docker compose -f docker-compose.multi.yml restart nginx
```

### 停止服务

```bash
# 停止所有服务（保留容器）
docker compose -f docker-compose.multi.yml stop

# 停止并删除容器、网络
docker compose -f docker-compose.multi.yml down

# 停止并删除容器、网络、卷（⚠️ 会删除数据库数据）
docker compose -f docker-compose.multi.yml down -v
```

### 查看日志

```bash
# 查看所有服务的日志
docker compose -f docker-compose.multi.yml logs -f

# 查看单个服务的日志
docker compose -f docker-compose.multi.yml logs -f api-1
docker compose -f docker-compose.multi.yml logs -f nginx
```

### 升级版本

```bash
# 1. 构建新镜像
docker build -t clipsync-api:v2 ./src/server

# 2. 修改 docker-compose.multi.yml，更新镜像标签
# image: clipsync-api:v2

# 3. 滚动更新（逐个重启实例）
docker compose -f docker-compose.multi.yml up -d --no-deps api-1
docker compose -f docker-compose.multi.yml up -d --no-deps api-2

# 4. 验证新版本
curl http://localhost/api/health
```

## 🔒 安全建议

1. **限制端口暴露**
   - 只暴露 Nginx 端口（80/443）到公网
   - API 实例、PostgreSQL、Redis 不要暴露到公网

2. **使用 HTTPS**
   - 配置 SSL 证书（Let's Encrypt 或自签名）
   - 修改 `nginx/conf.d/clipsync.conf`，启用 HTTPS 配置

3. **配置防火墙**
   - 只允许必要端口（80, 443, 22）
   - 禁止外部访问 PostgreSQL（5432）和 Redis（6379）

4. **使用强密码**
   - 修改 `.env` 文件，配置强密码
   - 不要使用默认密码

## 📝 故障排查

### Nginx 无法连接到后端

1. 检查后端实例是否正常运行
   ```bash
   docker ps | grep clipsync-api
   ```

2. 检查后端实例日志
   ```bash
   docker logs clipsync-api-1
   ```

3. 检查 Nginx 配置
   ```bash
   docker exec clipsync-nginx nginx -t
   ```

### 负载不均衡

1. 检查 Nginx 负载均衡策略
   - 确保不是 `ip_hash`（会导致负载不均衡）

2. 检查实例性能
   - 如果某个实例性能较差，配置权重

### WebSocket 连接断开

1. **这是已知问题**（内存会话管理）
   - 如果使用多实例部署，WebSocket 连接会不稳定
   - **解决方案**：迁移到 Redis 会话管理

2. 临时方案：使用 sticky session
   ```nginx
   upstream clipsync_api {
       ip_hash;
       # ...
   }
   ```

## 📚 参考资料

- [Nginx Load Balancing](https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Redis Documentation](https://redis.io/docs/)

---

**创建日期**：2026-06-24
**作者**：ClipSync Development Team
**版本**：1.0

## 📋 后续任务

1. **会话管理迁移到 Redis**
   - 将 `uploadSessions`、`connections`、`csrfTokens` 从内存迁移到 Redis
   - 实现真正的无状态设计

2. **配置自动扩缩容**
   - 使用 Docker Swarm 或 Kubernetes
   - 根据 CPU/内存使用率自动扩展实例

3. **配置健康检查**
   - 使用 Nginx Plus 或 nginx_upstream_check_module
   - 主动健康检查（而不是被动）

4. **配置监控告警**
   - 监控实例健康状态
   - 实例故障时自动告警
