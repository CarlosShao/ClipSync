# ClipSync 安全密钥轮换指南

> **重要**: 此文档记录了所有需要定期轮换的密钥和配置

---

## 一、需要轮换的密钥清单

| 密钥 | 环境变量 | 用途 | 轮换频率 |
|------|----------|------|----------|
| JWT 密钥 | `JWT_SECRET` | 用户认证 Token | 90 天 |
| 加密密钥 | `ENCRYPTION_KEY` | 端到端加密 | 180 天 |
| CSRF 密钥 | `CSRF_SECRET` | CSRF 防护 | 90 天 |
| 数据库密码 | `DB_PASSWORD` | PostgreSQL 访问 | 90 天 |
| Redis 密码 | `REDIS_PASSWORD` | Redis 访问 | 90 天 |
| 微信支付 APIv3 密钥 | `WECHAT_PAY_APIV3_KEY` | 微信支付签名 | 按需 |
| 支付宝公钥 | `ALIPAY_PUBLIC_KEY` | 支付宝验签 | 按需 |
| Stripe Webhook 密钥 | `STRIPE_WEBHOOK_SECRET` | Stripe 签名验证 | 按需 |

---

## 二、密钥生成规则

### 2.1 JWT_SECRET
```bash
# 生成 64 字节随机密钥
openssl rand -base64 64

# 要求：
# - 长度 >= 32 字符
# - 包含大小写字母、数字、特殊字符
# - 示例：K8m2pQ9xL4nR7wY3jH5vF1cD6gA8bN0eT2iU4oP6sJ8kL0mN2qR4tV6wX8yZ0
```

### 2.2 ENCRYPTION_KEY
```bash
# 生成 32 字节密钥（AES-256）
openssl rand -hex 32

# 要求：
# - 长度 >= 32 字符
# - 示例：a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4
```

### 2.3 CSRF_SECRET
```bash
# 生成 32 字节随机密钥
openssl rand -base64 32

# 要求：
# - 长度 >= 32 字符
# - 示例：Lm9p8u7y6t5r4e3w2q1a0s9d8f7g6h5j4k3l2m1n0b9v8c7x6z5
```

### 2.4 数据库密码
```bash
# 生成 24 字节强密码
openssl rand -base64 24

# 要求：
# - 长度 >= 16 字符
# - 包含大小写字母、数字、特殊字符
# - 示例：P@ssw0rd!2024#ClipSync
```

### 2.5 Redis 密码
```bash
# 生成 24 字节随机密码
openssl rand -base64 24

# 要求：
# - 长度 >= 16 字符
# - 示例：Redis$ecureP@ss2024!
```

---

## 三、轮换步骤

### 3.1 开发环境轮换

#### 步骤 1: 生成新密钥
```bash
# 生成所有密钥
JWT_SECRET=$(openssl rand -base64 64)
ENCRYPTION_KEY=$(openssl rand -hex 32)
CSRF_SECRET=$(openssl rand -base64 32)
DB_PASSWORD=$(openssl rand -base64 24)
REDIS_PASSWORD=$(openssl rand -base64 24)

# 输出密钥（复制到 .env 文件）
echo "JWT_SECRET=$JWT_SECRET"
echo "ENCRYPTION_KEY=$ENCRYPTION_KEY"
echo "CSRF_SECRET=$CSRF_SECRET"
echo "DB_PASSWORD=$DB_PASSWORD"
echo "REDIS_PASSWORD=$REDIS_PASSWORD"
```

#### 步骤 2: 更新 .env 文件
```bash
# 编辑 .env.development
vim .env.development

# 替换所有密钥为新生成的值
```

#### 步骤 3: 重启服务
```bash
# 停止所有容器
docker compose down

# 清除旧数据（可选，如果需要清除旧数据）
docker volume rm clipsync_postgres_data clipsync_redis_data

# 重新启动
docker compose up -d
```

#### 步骤 4: 验证服务
```bash
# 检查服务状态
docker compose ps

# 测试 API 连通性
curl http://localhost:3001/api/health
```

### 3.2 生产环境轮换

#### 步骤 1: 生成新密钥
```bash
# 在安全环境中生成密钥（不要在服务器上生成）
# 使用密码管理器或密钥管理服务（如 Vault）

# 记录旧密钥（备份）
echo "旧 JWT_SECRET: $(grep JWT_SECRET .env.production | cut -d= -f2)" > /tmp/old-keys-backup.txt
```

#### 步骤 2: 更新环境变量
```bash
# 方式 1: 使用 Docker Secrets（推荐）
echo "$NEW_JWT_SECRET" | docker secret create jwt_secret_v2 -

# 方式 2: 使用 Kubernetes Secrets
kubectl create secret generic clipsync-secrets \
  --from-literal=JWT_SECRET="$NEW_JWT_SECRET" \
  --from-literal=DB_PASSWORD="$NEW_DB_PASSWORD"

# 方式 3: 更新 .env.production（不推荐用于生产）
vim .env.production
```

#### 步骤 3: 滚动更新
```bash
# 使用 Docker Compose
docker compose -f docker-compose.prod.yml up -d --force-recreate

# 使用 Kubernetes
kubectl rollout restart deployment/clipsync-api -n clipsync
```

#### 步骤 4: 验证服务
```bash
# 检查服务健康
kubectl get pods -n clipsync
kubectl logs -f deployment/clipsync-api -n clipsync

# 测试 API
curl -H "Authorization: Bearer $TEST_TOKEN" https://api.clipsync.com/api/health
```

#### 步骤 5: 清理旧密钥
```bash
# 等待所有 Pod 更新完成（至少 5 分钟）
kubectl get pods -n clipsync -w

# 删除旧的 Secrets（如果使用版本化）
kubectl delete secret clipsync-secrets-v1 -n clipsync
```

---

## 四、紧急密钥轮换（密钥泄露）

### 4.1 立即响应步骤

```bash
# 1. 立即生成新密钥
NEW_JWT_SECRET=$(openssl rand -base64 64)
NEW_DB_PASSWORD=$(openssl rand -base64 24)

# 2. 更新所有环境
# （参考 3.2 生产环境轮换步骤）

# 3. 强制所有用户重新登录
# 在代码中添加 JWT 版本检查，使旧 Token 失效

# 4. 检查日志，确认无异常访问
tail -f /var/log/clipsync/*.log | grep -i "unauthorized\|forbidden"
```

### 4.2 事后分析

```bash
# 1. 检查 Git 历史，确认泄露范围
git log --all --full-history -- .env.development

# 2. 检查服务器访问日志
grep -i "api.clipsync.com" /var/log/nginx/access.log | tail -100

# 3. 检查数据库异常查询
# PostgreSQL 日志
tail -f /var/log/postgresql/*.log | grep -i "select\|insert\|update\|delete"

# 4. 生成安全报告
# 记录泄露时间、影响范围、修复措施
```

---

## 五、自动化密钥轮换（推荐）

### 5.1 使用 GitHub Secrets（CI/CD）

```yaml
# .github/workflows/rotate-keys.yml
name: Rotate Keys

on:
  schedule:
    - cron: '0 0 1 * *'  # 每月 1 日

jobs:
  rotate:
    runs-on: ubuntu-latest
    steps:
      - name: Generate new keys
        run: |
          JWT_SECRET=$(openssl rand -base64 64)
          echo "JWT_SECRET=$JWT_SECRET" >> $GITHUB_ENV

      - name: Update GitHub Secrets
        uses: gliech/create-github-secret-action@v1
        with:
          name: JWT_SECRET
          value: ${{ env.JWT_SECRET }}
          pa_token: ${{ secrets.PAT }}
```

### 5.2 使用 Vault（推荐）

```bash
# 1. 安装 Vault
helm install vault hashicorp/vault

# 2. 存储密钥
vault kv put secret/clipsync \
  jwt_secret="$(openssl rand -base64 64)" \
  db_password="$(openssl rand -base64 24)"

# 3. 应用读取密钥
vault kv get -field=jwt_secret secret/clipsync
```

---

## 六、检查清单

### 轮换前检查
- [ ] 确认所有团队成员知晓轮换计划
- [ ] 准备好回滚方案
- [ ] 通知用户可能的服务中断
- [ ] 备份当前密钥

### 轮换后检查
- [ ] 验证所有服务正常运行
- [ ] 测试关键功能（登录、支付、同步）
- [ ] 检查日志无异常
- [ ] 更新文档中的密钥版本
- [ ] 清理旧密钥备份

---

## 七、联系人

如有疑问，请联系：
- **安全负责人**: [待填写]
- **运维负责人**: [待填写]
- **紧急联系**: [待填写]

---

*文档版本: v1.0*  
*最后更新: 2026-06-28*
