# ClipSync 生产部署指南

> **适用版本**: ClipSync v0.2.0+
> **最后更新**: 2026年6月27日
> **部署方式**: Kubernetes (推荐) / Docker Compose (开发/小规模)

---

## 目录

1. [环境要求](#1-环境要求)
2. [快速部署（Kubernetes）](#2-快速部署kubernetes)
3. [快速部署（Docker Compose）](#3-快速部署docker-compose)
4. [配置管理](#4-配置管理)
5. [监控接入](#5-监控接入)
6. [备份与恢复](#6-备份与恢复)
7. [故障排查](#7-故障排查)
8. [运维检查清单](#8-运维检查清单)

---

## 1. 环境要求

### 1.1 Kubernetes 集群

| 组件 | 最低要求 | 推荐规格 |
|------|----------|----------|
| K8s 版本 | >= 1.28 | >= 1.30 |
| 节点数 | 1 (单节点) | 3+ (高可用) |
| 节点 CPU | 4 核 | 8+ 核 |
| 节点内存 | 8 GB | 16+ GB |
| 磁盘 | 100 GB SSD | 200+ GB NVMe |

### 1.2 必需组件

| 组件 | 用途 | 安装方式 |
|------|------|----------|
| Ingress Controller | 流量入口 / TLS 终结 | `helm install nginx-ingress ingress-nginx/ingress-nginx` |
| cert-manager (可选) | 自动 HTTPS 证书 | `helm install cert-manager jetstack/cert-manager` |
| PV Provisioner | 持久化存储 | 云厂商默认提供 / local-path-provisioner |
| Prometheus + Grafana | 监控可视化 | 见 `docker-compose.monitoring.yml` |
| sealed-secrets (推荐) | 密钥管理 | `helm install sealed-secrets sealed-secrets/sealed-secrets` |

### 1.3 外部依赖

| 依赖 | 说明 | 获取方式 |
|------|------|----------|
| 域名 | api.clipsync.app 等 | 域名注册商购买 |
| SSL 证书 | Let's Encrypt 免费 | cert-manager 自动签发 |
| 云服务器 | 阿里云/AWS/GCP | 按需选择 |
| 数据库密码等密钥 | 必须强随机 | `openssl rand -base64 32` |

---

## 2. 快速部署（Kubernetes）

### 2.1 准备工作

```bash
# 1. 克隆仓库
git clone https://github.com/YOUR_ORG/ClipSync.git
cd ClipSync

# 2. 安装 kubectl 和 kustomize
# macOS: brew install kubectl kustomize
# Linux: 下载二进制文件到 PATH
kubectl version --client
kustomize version

# 3. 验证集群连接
kubectl get nodes
```

### 2.2 创建命名空间和密钥

```bash
# 创建命名空间
kubectl create namespace clipsync

# 生成并注入生产环境密钥
kubectl create secret generic clipsync-secrets \
  --from-literal=DB_USER=clipsync \
  --from-literal=DB_PASSWORD=$(openssl rand -base64 24) \
  --from-literal=REDIS_PASSWORD=$(openssl rand -base64 16) \
  --from-literal=JWT_SECRET=$(openssl rand -hex 32) \
  --from-literal=ENCRYPTION_KEY=$(openssl rand -hex 32) \
  --from-literal=CSRF_SECRET=$(openssl rand -hex 32) \
  -n clipsync

# ⚠️ 务必保存以上生成的密钥值！丢失将无法解密用户数据！
```

### 2.3 一键部署

```bash
# 生产环境部署
kubectl apply -k k8s/overlays/production

# 或预发布环境部署
kubectl apply -k k8s/overlays/staging
```

### 2.4 验证部署状态

```bash
# 查看 Pod 状态（等待所有 Pod Running）
kubectl get pods -n clipsync -w

# 查看所有资源
kubectl get all -n clipsync

# 查看 Service 端口
kubectl get svc -n clipsync

# 查看 Ingress 地址
kubectl get ingress -n clipsync

# 健康检查
kubectl exec deployment/clipsync-api -n clipsync -- curl -sf http://localhost:3000/health

# 查看日志
kubectl logs -f deployment/clipsync-api -n clipsync --tail=100
```

### 2.5 更新部署

```bash
# 方式一：推送 tag 触发 CI/CD 自动部署
git tag v0.3.0
git push origin v0.3.0

# 方式二：手动更新镜像版本
cd k8s/overlays/production
kustomize edit set image clipsync/server=ghcr.io/YOUR_ORG/clipsync-server:v0.3.0
kustomize build . | kubectl apply -f -

# 观察滚动更新进度
kubectl rollout status deployment/clipsync-api -n clipsync

# 如有问题，一键回滚
kubectl rollout undo deployment/clipsync-api -n clipsync
```

---

## 3. 快速部署（Docker Compose）

适用于开发、测试或单机部署。

### 3.1 准备环境变量

```bash
cp .env.example .env.prod
# 编辑 .env.prod，填入实际的生产环境配置
```

`.env.prod` 必须包含：

```env
# ===== 数据库 =====
DB_USER=clipsync
DB_PASSWORD=<强密码至少24字符>
DB_NAME=clipsync

# ===== Redis =====
REDIS_PASSWORD=<强密码至少16字符>

# ===== 安全密钥（必须设置！） =====
JWT_SECRET=<32字符以上随机字符串>
ENCRYPTION_KEY=<ECDH加密密钥>
CSRF_SECRET=<CSRF保护密钥>

# ===== 服务端口 =====
PORT=3000

# ===== CORS 白名单 =====
CORS_ORIGINS=https://your-app-domain.com

# ===== 日志级别 =====
LOG_LEVEL=info
```

### 3.2 启动服务

```bash
# 启动全部服务（API + PostgreSQL + Redis）
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 仅查看状态（不启动）
docker compose -f docker-compose.prod.yml ps -a

# 查看日志
docker compose -f docker-compose.prod.yml logs -f api-prod

# 停止服务
docker compose -f docker-compose.prod.yml down

# 停止并删除数据（危险操作）
docker compose -f docker-compose.prod.yml down -v
```

### 3.3 配合监控栈

```bash
# 同时启动应用 + 监控
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.monitoring.yml up -d

# 访问地址：
#   API:      http://localhost:3000
#   Prometheus: http://localhost:9090
#   Grafana:    http://localhost:3001 (admin / clipsync2024)
```

---

## 4. 配置管理

### 4.1 环境变量优先级

```
K8s Secret > K8s ConfigMap > .env 文件 > 代码默认值
```

**安全原则**: 敏感信息（密码、密钥）必须通过 Secret 注入，禁止写入代码或 ConfigMap。

### 4.2 关键配置项说明

| 变量名 | 必须 | 说明 | 示例 |
|--------|------|------|------|
| `JWT_SECRET` | ✅ | JWT 签名密钥，>=32字符 | `a1b2c3...` (32+ hex) |
| `ENCRYPTION_KEY` | ✅ | ECDH 端到端加密密钥 | 同上 |
| `CSRF_SECRET` | ✅ | CSRF Token 签名密钥 | 同上 |
| `DB_PASSWORD` | ✅ | 数据库密码 | 强随机字符串 |
| `REDIS_PASSWORD` | ✅ | Redis 认证密码 | 强随机字符串 |
| `NODE_ENV` | | 运行环境 | production / staging |
| `CORS_ORIGINS` | | CORS 白名单（逗号分隔） | `https://app.example.com` |
| `MAX_FILE_SIZE` | | 最大上传文件大小(字节) | 10485760 (10MB) |
| `LOG_LEVEL` | | 日志级别 | info / warn / debug |

### 4.3 密钥轮换

```bash
# JWT 密钥轮换（平滑过渡：新旧密钥同时验证一段时间）
kubectl patch secret clipsync-secrets -n clipsync \
  --type='json' -p='[{"op": "replace", "path": "/data/JWT_SECRET", "value": "'$(openssl rand -hex 32)'"}]'

# 密钥轮换后需要重启 API 使新密钥生效
kubectl rollout restart deployment/clipsync-api -n clipsync
```

---

## 5. 监控接入

### 5.1 内置指标端点

ClipSync API 内置 Prometheus 格式的 `/metrics` 端点：

```
GET http://localhost:3000/metrics
```

主要指标：

| 指标名称 | 类型 | 说明 |
|----------|------|------|
| `http_requests_total` | Counter | HTTP 请求总数（按 method/path/status 分） |
| `http_request_duration_seconds` | Histogram | 请求延迟分布 |
| `websocket_connections_active` | Gauge | 当前活跃 WebSocket 连接数 |
| `clipboard_sync_operations_total` | Counter | 剪贴板同步操作计数 |
| `node_process_memory_bytes` | Gauge | 进程内存使用量 |
| `node_gc_duration_seconds` | Histogram | GC 停顿时间 |

### 5.2 Grafana Dashboard

使用预置的 Grafana dashboard (`monitoring/grafana/dashboards/clipsync-overview.json`)，包含面板：

1. **请求速率** — RPS 趋势图
2. **响应延迟** — P50/P90/P99 分布
3. **错误率** — HTTP 5xx 错误占比
4. **WebSocket 连接数** — 实时在线设备数
5. **活跃用户数** — DAU/MAU 统计
6. **系统资源** — CPU / 内存使用率

导入方法：
- 自动部署：通过 Grafana provisioning 已自动加载
- 手动导入：Grafana → Import → 上传 JSON 文件

### 5.3 告警规则建议

```yaml
# prometheus/alerting/clipsync-alerts.yml (示例)
groups:
  - name: clipsync-alerts
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
          /
          sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "ClipSync 错误率超过 5%"

      - alert: HighLatency
        expr: |
          histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m]))) by(le))
          > 2
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "P95 延迟超过 2 秒"

      - alert: WebSocketDisconnections
        expr: |
          rate(websocket_disconnects_total[5m]) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "WebSocket 异常断开频繁"

      - alert: HighMemoryUsage
        expr: |
          node_process_memory_bytes / (1024 * 1024 * 1024) > 1.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "内存使用超过 1.5GB"
```

---

## 6. 备份与恢复

### 6.1 数据库备份

#### 自动备份（已内置 CronJob）

K8s 清单中包含每日自动备份的 CronJob，每天 UTC 03:00 执行。

#### 手动备份

```bash
# 进入 PostgreSQL Pod 导出
kubectl exec deployment/clipsync-postgres -n clipsync -- \
  pg_dump -U clipsync clipsync | gzip > backup_$(date +%Y%m%d).sql.gz

# 使用备份 CronJob 手动触发
kubectl create job --from=cronjob/clipsync-postgres-backup manual-backup-$(date +%s) -n clipsync

# 从 PVC 备份文件中获取
kubectl cp clipsync/postgres-data:/backups ./local-backups -n clipsync
```

### 6.2 Redis 备份

Redis 开启了 AOF 持久化，数据会定期刷盘。如需手动备份 RDB：

```bash
# 在 Redis Pod 中执行 BGSAVE
kubectl exec deployment/clipsync-redis -n clipsync -- redis-cli -a $REDIS_PASSWORD BGSAVE

# 复制 RDB 文件
kubectl cp clipsync/redis-data:/data/dump.rdb ./redis-backup.rdb -n clipsync
```

### 6.3 上传文件备份

上传的文件存储在 `uploads-data` PVC 中。备份方案：

```bash
# 方案一：rsync 到外部存储
kubectl cp clipsync/uploads-data:/app/uploads ./uploads-backup -n clipsync

# 方案二：挂载共享存储（S3/NFS）实现实时同步
# 需要修改 k8s/base/api.yaml 的 volume 配置
```

### 6.4 灾难恢复步骤

```bash
# 1. 准备全新的集群和命名空间
kubectl create namespace clipsync

# 2. 恢复密钥（从安全位置重新创建 secret）
kubectl create secret generic clipsync-secrets ... -n clipsync

# 3. 部署基础架构（不含数据）
kubectl apply -k k8s/overlays/production

# 4. 等待 PostgreSQL 就绪后恢复数据
kubectl exec -i deployment/clipsync-postgres -n clipsync -- \
  psql -U clipsync clipsync < backup_latest.sql

# 5. 重启 API 服务
kubectl rollout restart deployment/clipsync-api -n clipsync

# 6. 验证健康状态
kubectl exec deployment/clipsync-api -n clipsync -- curl -sf http://localhost:3000/health
```

完整灾难恢复文档见：[docs/disaster-recovery.md](disaster-recovery.md)

---

## 7. 故障排查

### 7.1 常见问题速查

| 症状 | 可能原因 | 解决方法 |
|------|----------|----------|
| Pod 反复 CrashLoopBackOff | 内存不足 / 配置错误 | `kubectl describe pod` → `kubectl logs` |
| API 无法连接数据库 | DNS 解析失败 / Service 不存在 | `kubectl get svc -n clipsync` |
| WebSocket 断连频繁 | Ingress 超时太短 | 增加 proxy-read-timeout |
| 响应慢 / 超时 | 数据库慢查询 / 内存压力 | 检查 metrics + DB 慢查询日志 |
| 502 Bad Gateway | 后端未就绪 / readiness 失败 | `kubectl get endpoints` |
| OOMKilled | limits 设置过低 | 调整 resources.limits.memory |
| ImagePullBackOff | 镜像不存在 / 权限不足 | 检查 imagePullSecrets |

### 7.2 诊断命令集

```bash
# === Pod 问题诊断 ===
kubectl get pods -n clipsync -o wide              # 查看 Pod 状态和节点分布
kubectl describe pod <pod-name> -n clipsync       # 详细事件和状态
kubectl logs <pod-name> -n clipsync --tail=200    # 最近日志
kubectl logs <pod-name> -n clipsync --previous     # 崩溃前的日志

# === 网络问题诊断 ===
kubectl get endpoints -n clipsync                  # Service 后端地址
kubectl run test-curl --image=curlimages/curl -it --rm -- \
  curl -v http://clipsync-api:80/health            # Pod 间网络测试

# === 性能问题诊断 ===
kubectl top pods -n clipsync                       # 实时资源使用
kubectl exec deploy/clipsync-api -n clipsync -- top # 容器内进程状态

# === 存储问题诊断 ===
kubectl get pvc -n clipsync                       # PVC 状态
kubectl get pv | grep clipsync                    # PV 绑定情况
kubectl describe pvc uploads-data -n clipsync      # PVC 详细信息

# === 事件排查 ===
kubectl get events -n clipsync --sort-by='.lastTimestamp'  # 最近的事件流
```

### 7.3 日志分析关键词

```bash
# 错误日志
kubectl logs deployment/clipsync-api -n clipsync | grep -iE "(error|fatal|exception|timeout)" | tail -50

# 慢请求（>1秒）
kubectl logs deployment/clipsync-api -n clipsync | grep -E '"duration":[0-9]{4,}'

# WebSocket 相关
kubectl logs deployment/clipsync-api -n clipsync | grep -i websocket | tail -20

# 数据库相关
kubectl logs deployment/clipsync-api -n clipsync | grep -iE "(postgres|query|db)" | tail -20
```

---

## 8. 运维检查清单

### 8.1 每日检查（自动化）

- [ ] 所有 Pod 状态为 Running
- [ ] 无 CrashLoopBackOff / OOMKilled
- [ ] `/health` 返回 200
- [ ] `/metrics` 可正常抓取
- [ ] 错误率 < 1%
- [ ] P95 延迟 < 500ms
- [ ] 磁盘使用率 < 80%
- [ ] 备份执行成功

### 8.2 每周检查

- [ ] 检查证书有效期（Let's Encrypt 自动续期）
- [ ] 检查镜像是否为最新版本
- [ ] 审查 RBAC 权限变更
- [ ] 检查 HPA 是否正常扩缩容
- [ ] 回顾 Prometheus 告警记录
- [ ] 清理旧备份文件

### 8.3 每月检查

- [ ] 密钥轮换评估（JWT / 加密密钥）
- [ ] 依赖包安全审计（npm audit / Trivy）
- [ ] 容量规划评估（PV 使用趋势）
- [ ] 成本优化审查
- [ ] 灾难恢复演练
- [ ] 文档更新（本文档）

### 8.4 发布前检查清单

- [ ] 所有测试通过（CI 绿色）
- [ ] Docker 镜像安全扫描无 CRITICAL/HIGH
- [ ] 数据库迁移脚本已准备就绪
- [ ] 配置变更已审核
- [ ] 回滚计划已确认
- [ ] 监控告警已配置
- [ ] 维护窗口已通知用户
- [ ] 发布公告已准备好

---

## 附录

### A. 目录结构

```
ClipSync/
├── k8s/
│   ├── README.md                          # 本文档
│   ├── base/                              # 基础 K8s 资源
│   │   ├── namespace-config-pvc.yaml      # Namespace / ConfigMap / Secrets / PVC
│   │   ├── postgres.yaml                  # PostgreSQL Deployment + Service + Backup
│   │   ├── redis.yaml                     # Redis Deployment + Service + Exporter
│   │   ├── api.yaml                       # API Deployment + Service + HPA + PDB
│   │   ├── ingress-networkpolicy.yaml     # Ingress + NetworkPolicy
│   │   └── kustomization.yaml             # Base Kustomize 配置
│   └── overlays/
│       ├── staging/                       # 预发布环境覆盖
│       │   └── kustomization.yaml
│       └── production/                    # 生产环境覆盖
│           └── kustomization.yaml
├── monitoring/
│   └── grafana/
│       └── dashboards/
│           └── clipsync-overview.json     # Grafana 仪表盘
├── docker-compose.prod.yml                # Docker Compose 生产配置
├── docker-compose.monitoring.yml          # Docker Compose 监控配置
├── .github/workflows/
│   ├── ci.yml                             # CI 流水线
│   └── deploy.yml                         # CD 流水线
└── docs/
    ├── production-roadmap.md              # 实施路线图
    └── disaster-recovery.md               # 灾难恢复文档
```

### B. 有用的 kubectl 别名

```bash
# 添加到 ~/.bashrc 或 ~/.zshrc
alias k=kubectl
alias kp='k get pods -n clipsync'
alias kl='k logs -f deployment/clipsync-api -n clipsync --tail=100'
alias kr='k rollout restart deployment/clipsync-api -n clipsync'
alias ku='k get all -n clipsync'
alias ke='k get events -n clipsync --sort-by=.lastTimestamp'
```

### C. 版本历史

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v1.0 | 2026-06-27 | 初始版本：K8s manifests + Docker Compose + CI/CD + 监控接入 |
