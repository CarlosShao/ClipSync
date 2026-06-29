# ClipSync Kubernetes 部署清单

> **最后更新**: 2026-06-28  
> **版本**: v1.0

---

## 目录结构

```
k8s/
├── base/                      # 基础资源（通用配置）
│   ├── namespace-config-pvc.yaml  # 命名空间、配置、PVC
│   ├── postgres.yaml              # PostgreSQL 部署
│   ├── redis.yaml                 # Redis 部署
│   ├── api.yaml                   # API 服务部署
│   ├── ingress-networkpolicy.yaml # Ingress 和网络策略
│   └── kustomization.yaml         # Kustomize 配置
├── overlays/
│   ├── staging/               # 预发布环境（小规格、开发调试）
│   │   └── kustomization.yaml
│   └── production/            # 生产环境（高可用、资源限制）
│       └── kustomization.yaml
└── README.md                  # 本文档
```

---

## 快速开始

### 前置条件

1. **Kubernetes 集群** >= 1.28
2. **kubectl** 已配置
3. **kustomize** 已安装（kubectl >= 1.14 内置）
4. **PV Provisioner** - 持久化存储
5. **Ingress Controller** - 推荐 NGINX 或 Traefik
6. **cert-manager** (可选) - 自动 TLS 证书

### 部署步骤

#### 1. 创建命名空间和密钥

```bash
# 创建命名空间
kubectl create namespace clipsync

# 创建数据库密钥
kubectl create secret generic clipsync-secrets \
  --from-literal=DB_PASSWORD=your_secure_password \
  --from-literal=DB_USER=clipsync \
  --from-literal=JWT_SECRET=your_jwt_secret \
  --from-literal=ENCRYPTION_KEY=your_encryption_key \
  --from-literal=CSRF_SECRET=your_csrf_secret \
  --from-literal=REDIS_PASSWORD=your_redis_password \
  -n clipsync
```

#### 2. 部署到预发布环境

```bash
kubectl apply -k k8s/overlays/staging
```

#### 3. 部署到生产环境

```bash
kubectl apply -k k8s/overlays/production
```

### 常用命令

```bash
# 查看资源状态
kubectl get pods,svc,ingress -n clipsync

# 查看 Pod 详情
kubectl describe pod <pod-name> -n clipsync

# 查看日志
kubectl logs -f deployment/clipsync-api -n clipsync

# 进入容器调试
kubectl exec -it deployment/clipsync-api -n clipsync -- /bin/sh

# 查看 PVC 状态
kubectl get pvc -n clipsync

# 查看 Ingress 状态
kubectl get ingress -n clipsync
```

---

## YAML 文件说明

### 1. namespace-config-pvc.yaml

包含以下资源：

- **Namespace**: `clipsync` 命名空间
- **ConfigMap**: 应用配置（数据库名、端口等）
- **Secret**: 敏感信息引用（密码、密钥）
- **PVC**: 持久化存储声明
  - `postgres-data`: PostgreSQL 数据（50Gi）
  - `redis-data`: Redis 数据（10Gi）
  - `uploads-data`: 用户上传文件（100Gi）

### 2. postgres.yaml

PostgreSQL 数据库部署：

- **Deployment**: 单副本，健康检查，资源限制
- **Service**: ClusterIP，端口 5432
- **CronJob**: 每日自动备份（UTC 03:00，北京时间 11:00）
  - 备份文件带 SHA256 校验和
  - 保留最近 30 天备份

### 3. redis.yaml

Redis 缓存部署：

- **Deployment**: 单副本，AOF 持久化，内存限制
- **Service**: ClusterIP，端口 6379
- **Exporter**: Prometheus 指标导出

### 4. api.yaml

ClipSync API 服务部署：

- **Deployment**: 3 副本（可配置），滚动更新
- **Service**: ClusterIP，端口 3000
- **HPA**: 自动扩缩容（3-20 副本，CPU 70%）
- **PDB**: Pod 中断预算（最少 2 个可用）

### 5. ingress-networkpolicy.yaml

- **Ingress**: NGINX Ingress，TLS 终结
- **NetworkPolicy**: 网络隔离策略
  - API 服务可访问 PostgreSQL 和 Redis
  - PostgreSQL 仅允许内部访问
  - Redis 仅允许内部访问

---

## 环境差异

| 配置项 | staging | production |
|--------|---------|------------|
| API 副本数 | 2 | 3 |
| API CPU 请求 | 250m | 500m |
| API 内存请求 | 256Mi | 512Mi |
| API CPU 限制 | 1000m | 2000m |
| API 内存限制 | 512Mi | 1Gi |
| HPA 最小副本 | 2 | 3 |
| HPA 最大副本 | 10 | 20 |
| PVC 存储 | 20Gi/5Gi/50Gi | 50Gi/10Gi/100Gi |
| 日志级别 | debug | info |

---

## Secret 管理

### 方式 1: kubectl 命令行（开发环境）

```bash
kubectl create secret generic clipsync-secrets \
  --from-literal=DB_PASSWORD=<password> \
  --from-literal=JWT_SECRET=<secret> \
  -n clipsync
```

### 方式 2: Sealed Secrets（推荐生产环境）

```bash
# 安装 Sealed Secrets
helm install sealed-secrets sealed-secrets/sealed-secrets

# 创建 Sealed Secret
kubeseal --format yaml < secret.yaml > sealed-secret.yaml

# 应用
kubectl apply -f sealed-secret.yaml
```

### 方式 3: External Secrets Operator

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: clipsync-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: clipsync-secrets
  data:
    - secretKey: DB_PASSWORD
      remoteRef:
        key: clipsync/db
        property: password
```

---

## 监控集成

### Prometheus 指标

API 服务暴露 Prometheus 指标：

```
GET /api/metrics/prometheus
```

### Grafana 仪表盘

部署 Grafana 并导入 ClipSync 仪表盘：

```bash
# 部署 Grafana
kubectl apply -f monitoring/grafana-deployment.yaml

# 导入仪表盘
kubectl create configmap clipsync-dashboard \
  --from-file=monitoring/grafana/dashboards/clipsync-overview.json \
  -n monitoring
```

---

## 备份与恢复

### 自动备份

CronJob 每日 UTC 03:00（北京时间 11:00）自动备份：

```bash
# 查看备份任务
kubectl get cronjobs -n clipsync

# 查看备份日志
kubectl logs -l job-name=<backup-job-name> -n clipsync
```

### 手动备份

```bash
# 创建备份 Job
kubectl create job --from=cronjob/clipsync-postgres-backup manual-backup -n clipsync

# 查看备份文件
kubectl exec -it deployment/clipsync-postgres -n clipsync -- ls -la /backups
```

### 恢复数据

```bash
# 从备份恢复
kubectl exec -i deployment/clipsync-postgres -n clipsync -- \
  psql -U clipsync clipsync < backup.sql
```

---

## 故障排查

### Pod 启动失败

```bash
# 查看 Pod 状态
kubectl get pods -n clipsync

# 查看 Pod 事件
kubectl describe pod <pod-name> -n clipsync

# 查看 Pod 日志
kubectl logs <pod-name> -n clipsync
```

### 数据库连接失败

```bash
# 检查 PostgreSQL Pod
kubectl get pods -l app=clipsync,component=postgres -n clipsync

# 测试数据库连接
kubectl exec -it deployment/clipsync-api -n clipsync -- \
  psql -h clipsync-postgres -U clipsync -d clipsync -c "SELECT 1"
```

### Redis 连接失败

```bash
# 检查 Redis Pod
kubectl get pods -l app=clipsync,component=redis -n clipsync

# 测试 Redis 连接
kubectl exec -it deployment/clipsync-api -n clipsync -- \
  redis-cli -h clipsync-redis ping
```

### Ingress 问题

```bash
# 查看 Ingress 状态
kubectl get ingress -n clipsync

# 查看 Ingress 日志
kubectl logs -l app.kubernetes.io/name=ingress-nginx -n ingress-nginx
```

---

## 自定义配置

### 修改副本数

编辑 `k8s/overlays/production/kustomization.yaml`：

```yaml
patches:
  - target:
      kind: Deployment
      name: clipsync-api
    patch: |
      - op: replace
        path: /spec/replicas
        value: 5
```

### 修改资源限制

编辑 `k8s/base/api.yaml`：

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "2000m"
    memory: "1Gi"
```

### 添加环境变量

编辑 `k8s/base/api.yaml`：

```yaml
env:
  - name: NEW_FEATURE_FLAG
    value: "true"
```

---

## 参考资料

- [Kubernetes 官方文档](https://kubernetes.io/docs/)
- [Kustomize 文档](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [NGINX Ingress 文档](https://kubernetes.github.io/ingress-nginx/)
- [Sealed Secrets 文档](https://github.com/bitnami-labs/sealed-secrets)

---

*文档版本: v1.0*  
*最后更新: 2026-06-28*
