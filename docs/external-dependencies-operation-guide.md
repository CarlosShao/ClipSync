# ClipSync 外部依赖任务操作指南

> 本文档为每一项外部依赖任务提供**准确、可执行**的操作步骤。
> 当外部条件满足后，按照本文档步骤操作即可完成部署。

---

## 任务 1：HTTPS/TLS 配置

### 前置条件
- ✅ 已拥有域名（如 `clipstream.work`）
- ✅ 域名 DNS 已解析到服务器公网 IP
- ✅ 服务器已部署 ClipSync 后端（HTTP 可访问）
- ✅ 服务器开放 80/443 端口

### 操作步骤

#### 步骤 1：安装 Certbot
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y certbot python3-certbot-nginx

# CentOS/RHEL
sudo yum install -y certbot python3-certbot-nginx
```

**预期结果**：`certbot --version` 输出版本号（如 `certbot 2.x.x`）

**失败处理**：
- 若提示 `python3-certbot-nginx` 不存在，先安装 Nginx 插件：`sudo apt install -y nginx`

---

#### 步骤 2：申请 Let's Encrypt 证书
```bash
# 停止占用 80 端口的服务（如 Nginx/Node.js）
sudo systemctl stop nginx 2>/dev/null || true
pkill -f "node.*3000" 2>/dev/null || true

# 申请证书（需先停止占用 80 端口的服务）
sudo certbot certonly --standalone \
  -d clipstream.work \
  -d www.clipstream.work \
  --email your-email@example.com \
  --agree-tos \
  --no-eff-email
```

**预期结果**：
```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/clipstream.work/fullchain.pem
Key is saved at: /etc/letsencrypt/live/clipstream.work/privkey.pem
```

**失败处理**：
- 若提示 `Port 80 already in use`：确认 80 端口未被占用
- 若提示 `Rate limit`：等待 1 小时后重试，或使用 `--staging` 参数测试
- 若 DNS 解析失败：检查域名 A 记录是否正确指向服务器 IP

---

#### 步骤 3：配置 Nginx 反向代理
创建 `/etc/nginx/sites-available/clipsync`：
```nginx
server {
    listen 80;
    server_name clipstream.work www.clipstream.work;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name clipstream.work www.clipstream.work;

    ssl_certificate /etc/letsencrypt/live/clipstream.work/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/clipstream.work/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # 安全响应头
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket 支持
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

**启用配置**：
```bash
sudo ln -sf /etc/nginx/sites-available/clipsync /etc/nginx/sites-enabled/
sudo nginx -t  # 验证配置语法
sudo systemctl restart nginx
```

**预期结果**：访问 `https://clipstream.work/api/health` 返回 `{"status":"ok"}`

**失败处理**：
- 若 `nginx -t` 报错：检查配置文件语法，确认证书路径正确
- 若无法访问：检查防火墙 `sudo ufw status`，确保 443 端口开放

---

#### 步骤 4：配置自动续期
```bash
# 测试自动续期
sudo certbot renew --dry-run

# 添加定时任务（每日检查）
sudo crontab -e
# 添加以下行：
0 3 * * * /usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
```

**预期结果**：`--dry-run` 输出 `Congratulations, all renewals succeeded`

---

### 验证清单
- [ ] `https://clipstream.work` 可访问（浏览器显示绿锁）
- [ ] HTTP 自动跳转 HTTPS
- [ ] WebSocket 连接正常（`wss://clipstream.work/ws`）
- [ ] SSL Labs 测试评分 A 以上（https://www.ssllabs.com/ssltest/）

---

## 任务 2：推送通知集成

### 前置条件
- ✅ Apple 开发者账号（$99/年）
- ✅ Google 开发者账号（$25 一次性）
- ✅ 生产环境服务器已部署
- ✅ 应用已打包（iOS/Android）

### 操作步骤

#### 步骤 1：iOS APNs 配置

**1.1 创建 APNs 证书**
1. 登录 [Apple Developer Center](https://developer.apple.com)
2. 进入 **Certificates, Identifiers & Profiles**
3. 创建 **Apple Push Notification service SSL (Sandbox & Production)** 证书
4. 上传 CSR 文件（使用 Keychain Access 生成）
5. 下载 `.cer` 证书文件

**预期结果**：获得 `aps.cer` 证书文件

**1.2 导出 .p8 密钥文件（推荐）**
1. 在 Developer Center 创建 **Keys**
2. 勾选 **Apple Push Notifications service (APNs)**
3. 下载 `.p8` 密钥文件（保存好，只能下载一次）

**预期结果**：获得 `AuthKey_XXXXXXXXXX.p8` 文件

**1.3 后端集成**
```javascript
// src/server/src/services/apns.js
import apn from '@parse/node-apn';

const apnProvider = new apn.Provider({
  token: {
    key: process.env.APN_KEY_PATH,      // .p8 文件路径
    keyId: process.env.APN_KEY_ID,      // 密钥 ID
    teamId: process.env.APN_TEAM_ID,    // Team ID
  },
  production: process.env.NODE_ENV === 'production',
});

export async function sendPushNotification(deviceToken, payload) {
  const notification = new apn.Notification({
    alert: payload.alert,
    badge: payload.badge,
    sound: 'default',
    topic: 'com.clipsync.app',  // Bundle ID
  });

  const result = await apnProvider.send(notification, deviceToken);
  if (result.failed.length > 0) {
    logger.error('APNs send failed:', result.failed);
  }
  return result;
}
```

**安装依赖**：`npm install @parse/node-apn`

---

#### 步骤 2：Android FCM 配置

**2.1 创建 Firebase 项目**
1. 登录 [Firebase Console](https://console.firebase.google.com)
2. 创建新项目（或导入现有 Google 项目）
3. 进入 **Project Settings** > **Service Accounts**
4. 点击 **Generate new private key**，下载 JSON 文件

**预期结果**：获得 `firebase-service-account.json` 文件

**2.2 后端集成**
```javascript
// src/server/src/services/fcm.js
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

const app = initializeApp({
  credential: cert(JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON)),
});

export async function sendPushNotification(deviceToken, payload) {
  const message = {
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data || {},
    token: deviceToken,
  };

  try {
    const response = await getMessaging(app).send(message);
    logger.info('FCM send success:', response);
    return { success: true, messageId: response };
  } catch (error) {
    logger.error('FCM send failed:', error);
    return { success: false, error: error.message };
  }
}
```

**安装依赖**：`npm install firebase-admin`

---

#### 步骤 3：Flutter 客户端集成

**3.1 添加依赖**（`pubspec.yaml`）：
```yaml
dependencies:
  firebase_messaging: ^14.7.0
  flutter_local_notifications: ^16.0.0
```

**3.2 iOS 配置**（`ios/Runner/Info.plist`）：
```xml
<key>UIBackgroundModes</key>
<array>
  <string>fetch</string>
  <string>remote-notification</string>
</array>
<key>FirebaseAppDelegateProxyEnabled</key>
<false/>
```

**3.3 Android 配置**（`android/app/src/main/AndroidManifest.xml`）：
```xml
<service
  android:name=".MyFirebaseMessagingService"
  android:exported="false">
  <intent-filter>
    <action android:name="com.google.firebase.MESSAGING_EVENT"/>
  </intent-filter>
</service>
```

---

### 验证清单
- [ ] iOS 真机可收到推送通知
- [ ] Android 真机可收到推送通知
- [ ] 应用后台/杀掉后仍能收到通知
- [ ] 点击通知可正确跳转

**失败处理**：
- iOS 收不到通知：检查 Bundle ID、Team ID、密钥文件是否正确
- Android 收不到通知：检查 `google-services.json` 是否正确放置

---

## 任务 3：密钥管理（Vault）

### 前置条件
- ✅ 拥有云服务账号（AWS/GCP/Azure）或自建服务器
- ✅ Docker 已安装
- ✅ 服务器开放 8200 端口（Vault 默认端口）

### 操作步骤

#### 步骤 1：部署 HashiCorp Vault

**1.1 Docker 方式部署（推荐，适用于测试/小团队）**
```bash
# 创建 Vault 配置目录
mkdir -p /opt/vault/config /opt/vault/data /opt/vault/logs

# 创建配置文件
cat > /opt/vault/config/vault.hcl << 'EOF'
storage "file" {
  path = "/vault/data"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1  # 生产环境请启用 TLS
}

api_addr = "http://your-server-ip:8200"
cluster_addr = "https://your-server-ip:8201"
EOF

# 启动 Vault
docker run -d \
  --name vault \
  --cap-add=IPC_LOCK \
  -p 8200:8200 \
  -v /opt/vault/config:/vault/config \
  -v /opt/vault/data:/vault/data \
  -v /opt/vault/logs:/vault/logs \
  -e 'VAULT_LOCAL_CONFIG=/vault/config/vault.hcl' \
  hashicorp/vault:latest server
```

**预期结果**：`docker ps | grep vault` 显示容器运行中

**1.2 初始化 Vault**
```bash
# 设置 Vault 地址
export VAULT_ADDR='http://your-server-ip:8200'

# 初始化（仅首次执行）
vault operator init -key-shares=5 -key-threshold=3

# 输出示例：
# Unseal Key 1: xxxx-xxxx-xxxx-xxxx
# Unseal Key 2: xxxx-xxxx-xxxx-xxxx
# ...
# Initial Root Token: hvs.XXXXXX
# ** 重要：保存这些密钥！丢失无法恢复 **
```

**预期结果**：获得 5 个 Unseal Key 和 1 个 Root Token

**失败处理**：
- 若 `vault operator init` 报错：检查 Vault 容器是否正常运行 `docker logs vault`
- 若无法连接：检查防火墙，确保 8200 端口开放

---

#### 步骤 2：配置密钥存储

**2.1 解封 Vault**
```bash
# 使用 3 个 Unseal Key 解封（每次重启都需要）
vault operator unseal <key1>
vault operator unseal <key2>
vault operator unseal <key3>

# 验证状态
vault status
# 输出中 Seal = false 表示已解封
```

**2.2 登录 Vault**
```bash
vault login <root-token>
```

**2.3 启用 KV 密钥引擎**
```bash
vault secrets enable -path=clipsync kv-v2

# 添加 ClipSync 密钥
vault kv put clipsync/production \
  database_url="postgresql://user:pass@localhost:5432/clipsync" \
  jwt_secret="your-jwt-secret" \
  encryption_key="your-encryption-key" \
  sms_api_key="your-sms-api-key"
```

**预期结果**：`vault kv get clipsync/production` 可读取密钥

---

#### 步骤 3：后端集成 Vault

**3.1 安装 Node.js Vault 客户端**
```bash
cd /d/work/java/AI-workspace/ClipSync/src/server
npm install node-vault
```

**3.2 创建 Vault 客户端模块**
```javascript
// src/server/src/utils/vault-client.js
import vault from 'node-vault';

const vaultClient = vault({
  apiVersion: 'v1',
  endpoint: process.env.VAULT_ADDR || 'http://localhost:8200',
});

export async function getSecret(path) {
  try {
    const result = await vaultClient.read(`secret/data/${path}`);
    return result.data.data;
  } catch (error) {
    logger.error('Vault read error:', error);
    throw error;
  }
}

export async function setSecret(path, data) {
  return await vaultClient.write(`secret/data/${path}`, { data });
}
```

**3.3 修改配置加载逻辑**
```javascript
// src/server/src/config/loader.js
import { getSecret } from '../utils/vault-client.js';

export async function loadConfig() {
  if (process.env.USE_VAULT === 'true') {
    const secrets = await getSecret('clipsync/production');
    return {
      database: {
        url: secrets.database_url,
      },
      jwt: {
        secret: secrets.jwt_secret,
      },
      // ...
    };
  } else {
    // 从环境变量加载（开发环境）
    return loadFromEnv();
  }
}
```

---

### 验证清单
- [ ] Vault 服务正常运行（`vault status` 返回 `Seal = false`）
- [ ] 可成功读取密钥（`vault kv get clipsync/production`）
- [ ] 后端可从 Vault 加载配置
- [ ] 密钥轮换后后端可自动获取新密钥

**失败处理**：
- 若 Vault 重启后无法访问：需要重新解封（使用 3 个 Unseal Key）
- 若后端无法连接 Vault：检查 `VAULT_ADDR` 环境变量，确认网络连通性

---

## 任务 4：错误追踪（Sentry）

### 前置条件
- ✅ 可访问互联网
- ✅ 拥有邮箱（用于注册 Sentry 账号）

### 操作步骤

#### 步骤 1：注册 Sentry 账号
1. 访问 [sentry.io](https://sentry.io)
2. 点击 **Sign Up**，使用邮箱注册
3. 创建新项目，选择 **Node.js**（后端）和 **Flutter**（前端）

**预期结果**：获得 **DSN**（Data Source Name），格式如：
```
https://xxxx@xxxx.ingest.sentry.io/xxxx
```

---

#### 步骤 2：后端集成 Sentry

**2.1 安装依赖**
```bash
cd /d/work/java/AI-workspace/ClipSync/src/server
npm install @sentry/node
```

**2.2 初始化 Sentry**（`src/server/src/utils/sentry.js`）
```javascript
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  integrations: [
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,  // 采样率（生产环境建议 0.1）
  profilesSampleRate: 1.0,  // 性能分析采样率
});

export { Sentry };
```

**2.3 在入口文件引入**（`src/server/src/index.js`）
```javascript
import './utils/sentry.js';

// 在全局错误处理器中上报错误
process.on('uncaughtException', (err) => {
  Sentry.captureException(err);
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Sentry.captureException(reason);
  logger.error('Unhandled Rejection:', reason);
});
```

---

#### 步骤 3：前端（Flutter）集成 Sentry

**3.1 添加依赖**（`pubspec.yaml`）
```yaml
dependencies:
  sentry_flutter: ^8.0.0
```

**3.2 初始化**（`lib/main.dart`）
```dart
import 'package:sentry_flutter/sentry_flutter.dart';

Future<void> main() async {
  await SentryFlutter.init(
    (options) {
      options.dsn = 'https://xxxx@xxxx.ingest.sentry.io/xxxx';
      options.environment = 'production';
      options.tracesSampleRate = 1.0;
    },
    appRunner: () => runApp(MyApp()),
  );
}
```

---

### 验证清单
- [ ] Sentry 仪表盘可看到错误上报
- [ ] 主动触发一个测试错误，确认可收到告警
- [ ] 性能分析数据正常上报
- [ ] 生产环境错误可正确归因到版本/用户

**失败处理**：
- 若看不到错误上报：检查 DSN 是否正确，确认网络可访问 `sentry.io`
- 若性能数据缺失：检查 `tracesSampleRate` 是否大于 0

---

## 任务 5：告警配置

### 前置条件
- ✅ 已部署监控系统（Prometheus + Grafana，参考 `docs/monitoring-setup-guide.md`）
- ✅ 已配置通知渠道（Email/Slack/微信）

### 操作步骤

#### 步骤 1：配置 Grafana 告警渠道

**1.1 通过 UI 配置**
1. 登录 Grafana
2. 进入 **Alerting** > **Contact points**
3. 点击 **Add contact point**
4. 选择渠道类型（Email/Slack/Webhook）
5. 填写配置（如 SMTP 服务器、Slack Webhook URL）
6. 点击 **Test** 验证配置
7. 点击 **Save**

**预期结果**：测试消息成功发送到指定渠道

**1.2 通过 API 配置（推荐，可版本化）**
```bash
# 创建 Email 告警渠道
curl -X POST http://admin:admin@localhost:3000/api/alert-notifications \
  -H "Content-Type: application/json" \
  -d '{
    "name": "email-alerts",
    "type": "email",
    "settings": {
      "addresses": "admin@clipsync.com"
    }
  }'
```

---

#### 步骤 2：创建告警规则

**2.1 通过 UI 创建**
1. 进入 **Alerting** > **Alert rules**
2. 点击 **New alert rule**
3. 选择数据源（如 Prometheus）
4. 编写查询表达式（如 `rate(http_requests_total[5m]) > 0.1`）
5. 设置触发条件（如 "IS ABOVE 0.1"）
6. 设置评估频率（如 "Evaluate every 1m for 5m"）
7. 选择通知渠道
8. 点击 **Save**

**2.2 通过配置文件创建**（`grafana/provisioning/alerts/backend-alerts.yaml`）
```yaml
groups:
  - name: clipsync-backend-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "高错误率：{{ $value }}%"
          description: "服务 {{ $labels.instance }} 错误率超过 5%"

      - alert: HighMemoryUsage
        expr: (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "高内存使用：{{ $value | humanizePercentage }}"
          description: "服务器 {{ $labels.instance }} 内存使用率超过 85%"

      - alert: APIDown
        expr: up{job="clipsync-backend"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "API 下线"
          description: "服务 {{ $labels.instance }} 已下线超过 1 分钟"
```

---

#### 步骤 3：配置 Alertmanager（可选，高级场景）

**3.1 创建配置**（`prometheus/alertmanager.yml`）
```yaml
global:
  smtp_smarthost: 'smtp.gmail.com:587'
  smtp_from: 'alerts@clipsync.com'

route:
  group_by: ['alertname', 'severity']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1h
  receiver: 'email-notifications'

receivers:
  - name: 'email-notifications'
    email_configs:
      - to: 'admin@clipsync.com'
        send_resolved: true

  - name: 'slack-notifications'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/xxx/xxx/xxx'
        channel: '#alerts'
        send_resolved: true

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname', 'instance']
```

---

### 验证清单
- [ ] 主动触发告警条件（如停止后端服务），确认收到通知
- [ ] 告警恢复后收到恢复通知
- [ ] 告警不重复发送（除非设置了 `repeat_interval`）
- [ ] 不同严重级别（critical/warning）的告警正确路由到对应渠道

**失败处理**：
- 若收不到告警：检查 Contact point 配置，查看 Grafana 日志 `docker logs grafana`
- 若告警频繁误报：调整 `for` 持续时间，或优化查询表达式

---

## 任务 6：自动扩缩容

### 前置条件
- ✅ 拥有云服务账号（AWS/GCP/Azure）
- ✅ 应用已容器化（已有 `Dockerfile`）
- ✅ 已部署容器编排平台（Kubernetes/Docker Swarm）

### 操作步骤（以 Kubernetes 为例）

#### 步骤 1：创建 Docker 镜像
```bash
# 构建镜像
docker build -t clipsync/backend:latest .

# 推送到镜像仓库（如 Docker Hub）
docker tag clipsync/backend:latest your-dockerhub-username/clipsync-backend:latest
docker push your-dockerhub-username/clipsync-backend:latest
```

**预期结果**：`docker pull your-dockerhub-username/clipsync-backend:latest` 可拉取镜像

---

#### 步骤 2：创建 Kubernetes Deployment

**2.1 创建 Deployment 配置**（`k8s/backend-deployment.yaml`）
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: clipsync-backend
spec:
  replicas: 2  # 初始副本数
  selector:
    matchLabels:
      app: clipsync-backend
  template:
    metadata:
      labels:
        app: clipsync-backend
    spec:
      containers:
        - name: backend
          image: your-dockerhub-username/clipsync-backend:latest
          ports:
            - containerPort: 3000
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: clipsync-secrets
                  key: database_url
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
```

**2.2 部署到 Kubernetes**
```bash
kubectl apply -f k8s/backend-deployment.yaml
```

**预期结果**：`kubectl get pods` 显示 2 个 Pod 运行正常

---

#### 步骤 3：配置 Horizontal Pod Autoscaler (HPA)

**3.1 创建 HPA 配置**（`k8s/backend-hpa.yaml`）
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: clipsync-backend-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: clipsync-backend
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 60
```

**3.2 部署 HPA**
```bash
kubectl apply -f k8s/backend-hpa.yaml

# 查看 HPA 状态
kubectl get hpa
```

**预期结果**：HPA 显示当前副本数和目标使用率

---

#### 步骤 4：配置集群自动扩缩容（可选，云环境）

**4.1 AWS EKS 配置**
```bash
# 安装 Cluster Autoscaler
kubectl apply -f https://raw.githubusercontent.com/kubernetes/autoscaler/master/cluster-autoscaler/cloudprovider/aws/examples/cluster-autoscaler-autodiscover.yaml

# 标注节点组
kubectl annotate deployment cluster-autoscaler \
  cluster-autoscaler.kubernetes.io/safe-to-evict-local-volumes="true"
```

**4.2 GCP GKE 配置**
```bash
# 创建节点池时启用自动扩缩容
gcloud container node-pools create clipsync-pool \
  --cluster=clipsync-cluster \
  --enable-autoscaling \
  --min-nodes=1 \
  --max-nodes=10 \
  --num-nodes=2
```

---

### 验证清单
- [ ] 高负载时 Pod 自动扩展（观察 `kubectl get hpa`）
- [ ] 负载下降后 Pod 自动缩减（但不会立即缩减，有冷却时间）
- [ ] 节点资源不足时，集群自动添加新节点
- [ ] 滚动更新时服务不中断（零停机部署）

**失败处理**：
- 若 HPA 不工作：检查 Metrics Server 是否安装 `kubectl get deployment -n kube-system metrics-server`
- 若 Pod 无法调度：检查节点资源是否充足，或增加节点数

---

## 任务 7：支付渠道集成

### 前置条件
- ✅ 拥有企业营业执照
- ✅ 已开通微信商户号（https://pay.weixin.qq.com）
- ✅ 已开通支付宝商户号（https://open.alipay.com）
- ✅ 已开通 Stripe 账号（https://stripe.com）

### 操作步骤

#### 步骤 1：微信支付集成

**1.1 获取密钥**
1. 登录微信商户平台
2. 进入 **账户中心** > **API安全**
3. 设置 **API密钥**（32位字符串）
4. 下载 **商户证书**（用于退款等敏感操作）

**预期结果**：获得 `mch_id`（商户号）、`api_key`（API密钥）、`apiclient_cert.pem` 和 `apiclient_key.pem`（证书文件）

**1.2 后端集成**
```javascript
// src/server/src/services/wechat-pay.js
import crypto from 'crypto';
import axios from 'axios';

const WECHAT_PAY_CONFIG = {
  mchId: process.env.WECHAT_MCH_ID,
  apiKey: process.env.WECHAT_API_KEY,
  notifyUrl: process.env.WECHAT_NOTIFY_URL,
};

export async function createOrder(orderNo, amount, description) {
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  
  const params = {
    mchid: WECHAT_PAY_CONFIG.mchId,
    out_trade_no: orderNo,
    description,
    notify_url: WECHAT_PAY_CONFIG.notifyUrl,
    amount: {
      total: Math.round(amount * 100),  // 单位：分
      currency: 'CNY',
    },
  };
  
  // 生成签名（省略详细步骤，参考微信支付文档）
  const signature = generateSignature(params, WECHAT_PAY_CONFIG.apiKey);
  
  const response = await axios.post(
    'https://api.mch.weixin.qq.com/v3/pay/transactions/native',
    params,
    {
      headers: {
        'Authorization': `WECHATPAY2-SHA256-RSA2048 ${signature}`,
        'Content-Type': 'application/json',
      },
    }
  );
  
  return response.data;  // 包含 qr_code 链接
}
```

**安装依赖**：`npm install axios`

---

#### 步骤 2：支付宝集成

**2.1 获取密钥**
1. 登录支付宝开放平台
2. 进入 **控制台** > **密钥管理**
3. 生成 **应用公钥** 和 **应用私钥**
4. 上传应用公钥，获得 **支付宝公钥**

**预期结果**：获得 `app_id`、`app_private_key`、`alipay_public_key`

**2.2 后端集成**
```javascript
// src/server/src/services/alipay.js
import AlipaySDK from 'alipay-sdk';
import axios from 'axios';

const alipaySDK = new AlipaySDK({
  appId: process.env.ALIPAY_APP_ID,
  privateKey: process.env.ALIPAY_PRIVATE_KEY,
  alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY,
  gateway: 'https://openapi.alipay.com/gateway.do',  // 生产环境
});

export async function createOrder(orderNo, amount, description) {
  const result = await alipaySDK.exec('alipay.trade.page.pay', {
    method: 'POST',
    bizContent: {
      out_trade_no: orderNo,
      total_amount: amount.toFixed(2),
      subject: description,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    },
    notify_url: process.env.ALIPAY_NOTIFY_URL,
    return_url: process.env.ALIPAY_RETURN_URL,
  });
  
  return {
    payUrl: result,  // 支付跳转 URL
  };
}
```

**安装依赖**：`npm install alipay-sdk`

---

#### 步骤 3：Stripe 集成（国际支付）

**3.1 获取 API 密钥**
1. 登录 Stripe Dashboard
2. 进入 **Developers** > **API keys**
3. 复制 **Publishable key** 和 **Secret key**

**预期结果**：获得 `pk_live_XXX`（公钥）和 `sk_live_XXX`（私钥）

**3.2 后端集成**
```javascript
// src/server/src/services/stripe.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

export async function createPaymentIntent(amount, currency = 'USD') {
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),  // 单位：分/cent
    currency,
    automatic_payment_methods: {
      enabled: true,
    },
  });
  
  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

export async function handleWebhook(rawBody, signature) {
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
  
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      logger.info('Payment succeeded:', paymentIntent.id);
      // 更新订单状态
      break;
    // 处理其他事件...
  }
  
  return { received: true };
}
```

**安装依赖**：`npm install stripe`

---

#### 步骤 4：前端支付页面集成

**4.1 微信支付（Native 支付，扫码支付）**
```javascript
// 用户点击支付按钮后
const response = await fetch('/api/payments/wechat/create', {
  method: 'POST',
  body: JSON.stringify({ planId: 'basic-monthly' }),
});

const { qrCodeUrl } = await response.json();
// 显示二维码（使用 qrcode.js 库）
QRCode.toCanvas(canvasElement, qrCodeUrl);
```

**4.2 支付宝（电脑网站支付）**
```javascript
// 提交表单跳转到支付宝
const form = document.createElement('form');
form.method = 'POST';
form.action = paymentUrl;  // 后端返回的支付跳转 URL
document.body.appendChild(form);
form.submit();
```

**4.3 Stripe（信用卡支付）**
```javascript
import { loadStripe } from '@stripe/stripe-js';

const stripe = await loadStripe(process.env.STRIPE_PUBLISHABLE_KEY);

// 创建 PaymentIntent 后
const { error } = await stripe.confirmCardPayment(clientSecret, {
  payment_method: {
    card: cardElement,  // Stripe Card Element
    billing_details: {
      email: user.email,
    },
  },
});

if (error) {
  console.error('Payment failed:', error);
} else {
  console.log('Payment succeeded!');
}
```

---

### 验证清单
- [ ] 微信支付：扫码后可成功支付，回调正常处理
- [ ] 支付宝：跳转支付宝后可成功支付，回调正常处理
- [ ] Stripe：信用卡支付成功，Webhook 正常接收
- [ ] 支付成功后，用户订阅状态正确更新
- [ ] 支付失败后，订单状态正确标记为失败
- [ ] 退款功能正常工作（调用退款 API）

**失败处理**：
- 若支付回调未收到：检查 `notify_url` 是否可被公网访问，查看支付平台的后台日志
- 若签名验证失败：检查密钥是否正确，确认签名算法与文档一致
- 若金额不匹配：确认单位是否正确（微信/Stripe 使用最小单位，如分/cent）

---

## 附录：快速检查表

| 任务 | 前置条件复杂度 | 实施难度 | 预计耗时 | 优先级 |
|------|----------------|----------|----------|--------|
| HTTPS/TLS | 低 | 低 | 1-2 小时 | 🔴 高 |
| 推送通知 | 中（需要开发者账号） | 中 | 3-5 天 | 🔴 高 |
| 密钥管理 | 中（需要服务器） | 中 | 1-2 天 | 🔴 高 |
| 错误追踪 | 低（只需要注册账号） | 低 | 2-4 小时 | 🔴 高 |
| 告警配置 | 中（需要监控系统） | 中 | 1-2 天 | 🔴 高 |
| 自动扩缩容 | 高（需要 K8s 知识） | 高 | 3-5 天 | 🔴 高 |
| 支付渠道 | 高（需要企业资质） | 高 | 5-7 天 | 🔴 高 |

---

**文档版本**：1.0  
**创建日期**：2026-06-29  
**作者**：ClipSync Development Team  
**更新日志**：
- 2026-06-29：初始版本，包含 7 个外部依赖任务的详细操作指南
