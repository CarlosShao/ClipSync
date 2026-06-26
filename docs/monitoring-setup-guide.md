# ClipSync 监控栈部署指南

## 📊 概述

本文档介绍如何在本地部署 ClipSync 监控栈（Prometheus + Grafana），用于监控 ClipSync 后端服务的运行状态和性能指标。

## 🏗️ 架构

监控栈包含以下组件：

1. **Prometheus** (端口 9090)
   - 抓取 ClipSync 后端的 metrics 端点（`/api/metrics/prometheus`）
   - 存储时间序列数据
   - 提供 PromQL 查询接口

2. **Grafana** (端口 3001)
   - 可视化 Prometheus 数据
   - 预配置数据源（自动连接 Prometheus）
   - 预配置仪表盘（ClipSync 概览）

3. **Node Exporter** (端口 9100)
   - 收集系统指标（CPU、内存、磁盘）
   - Prometheus 抓取其 metrics

## 🚀 快速启动

### 前置条件

- Docker 已安装并运行
- Docker Compose 已安装
- ClipSync 后端服务已启动（或将通过 Docker Compose 启动）

### 启动步骤

1. **启动监控栈**

```bash
# 进入 ClipSync 项目根目录
cd D:/work/java/AI-workspace/ClipSync

# 启动监控栈
docker compose -f docker-compose.monitoring.yml up -d

# 查看运行状态
docker compose -f docker-compose.monitoring.yml ps
```

2. **验证服务**

```bash
# 检查 Prometheus 是否正常运行
curl http://localhost:9090/-/healthy

# 检查 Grafana 是否正常运行
curl http://localhost:3001/api/health

# 检查 Node Exporter 是否正常运行
curl http://localhost:9100/metrics
```

3. **访问 Grafana 仪表盘**

- 打开浏览器，访问 http://localhost:3001
- 登录凭据：
  - 用户名：`admin`
  - 密码：`clipsync2024`
- 进入 **Dashboards** → **ClipSync** → **ClipSync 概览**

## 🔧 配置说明

### Prometheus 配置

文件路径：`monitoring/prometheus/prometheus.yml`

关键配置：

```yaml
scrape_configs:
  # ClipSync API 服务
  - job_name: 'clipsync-api'
    scrape_interval: 10s
    static_configs:
      - targets: ['api-prod:3000']
    metrics_path: '/api/metrics/prometheus'
```

**注意**：如果 ClipSync 后端不在 Docker 网络中，需要修改 `targets` 为正确的地址（例如 `localhost:3000`）。

### Grafana 配置

文件路径：
- 数据源：`monitoring/grafana/provisioning/datasources/prometheus.yml`
- 仪表盘：`monitoring/grafana/provisioning/dashboards/clipsync.yml`

Grafana 会自动：
- 添加 Prometheus 数据源
- 导入预定义的仪表盘

### 预定义仪表盘

**ClipSync 概览** 仪表盘包含以下面板：

1. **HTTP 请求率 (QPS)**
   - 显示每秒 HTTP 请求数
   - 数据源：Prometheus

2. **HTTP 请求延迟 (P95)**
   - 显示 P95 延迟（毫秒）
   - 数据源：Prometheus

3. **错误率**
   - 显示 4xx 和 5xx 错误百分比
   - 数据源：Prometheus

4. **系统资源使用率**
   - 显示 CPU 和内存使用率
   - 数据源：Prometheus (Node Exporter)

## 🔄 与 ClipSync 后端集成

### 方式一：使用 Docker Compose（推荐）

更新 `docker-compose.prod.yml`，添加监控网络：

```yaml
# 在 api-prod 服务中添加
networks:
  - clipsync-prod-net
  - clipsync-monitoring-net  # 新增：连接到监控网络

# 在文件末尾添加
networks:
  clipsync-monitoring-net:
    external: true
    name: clipsync_monitoring_clipsync-monitoring-net
```

然后启动：

```bash
# 创建监控网络
docker network create clipsync-monitoring-net

# 启动 ClipSync 后端（连接到监控网络）
docker compose -f docker-compose.prod.yml up -d

# 启动监控栈
docker compose -f docker-compose.monitoring.yml up -d
```

### 方式二：本地开发环境

如果 ClipSync 后端在本地运行（不在 Docker 中），需要修改 Prometheus 配置：

1. 编辑 `monitoring/prometheus/prometheus.yml`
2. 将 `targets: ['api-prod:3000']` 修改为 `targets: ['host.docker.internal:3000']`（Windows/Mac）或 `targets: ['localhost:3000']`（Linux）
3. 重启 Prometheus：`docker compose -f docker-compose.monitoring.yml restart prometheus`

## 📈 使用指南

### 查看 metrics

1. **JSON 格式**（调试用）
   ```
   http://localhost:3000/api/metrics/json
   ```

2. **Prometheus 格式**（监控用）
   ```
   http://localhost:3000/api/metrics/prometheus
   ```

3. **Prometheus Web UI**
   ```
   http://localhost:9090
   ```
   - 进入 **Graph** 页面
   - 输入 PromQL 查询（例如 `rate(clipsync_requests_total[1m])`）
   - 点击 **Execute**

4. **Grafana 仪表盘**
   ```
   http://localhost:3001
   ```
   - 进入 **Dashboards** → **ClipSync** → **ClipSync 概览**
   - 查看实时性能指标

### 自定义仪表盘

1. 登录 Grafana
2. 点击左侧菜单 **Dashboards** → **New** → **New Dashboard**
3. 添加面板，选择 Prometheus 数据源
4. 输入 PromQL 查询
5. 保存仪表盘

### 常用 PromQL 查询

```promql
# HTTP 请求率（QPS）
sum(rate(clipsync_requests_total[1m]))

# HTTP 请求延迟 P95（秒）
histogram_quantile(0.95, sum(rate(clipsync_response_time_seconds_bucket[1m])) by (le))

# 错误率（%）
sum(rate(clipsync_requests_total{status=~"4..|5.."}[1m])) / sum(rate(clipsync_requests_total[1m])) * 100

# 内存使用（字节）
clipsync_memory_bytes{type="heap"}

# CPU 使用率（%）
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)

# 内存使用率（%）
(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100
```

## 🛠️ 维护

### 重启监控栈

```bash
docker compose -f docker-compose.monitoring.yml restart
```

### 停止监控栈

```bash
docker compose -f docker-compose.monitoring.yml down
```

### 查看日志

```bash
# Prometheus 日志
docker logs clipsync-prometheus

# Grafana 日志
docker logs clipsync-grafana

# Node Exporter 日志
docker logs clipsync-node-exporter
```

### 清理数据

```bash
# 停止并删除容器、网络、卷
docker compose -f docker-compose.monitoring.yml down -v
```

## 🔒 安全建议

1. **Grafana 密码**
   - 默认密码是 `clipsync2024`，生产环境请修改
   - 修改方式：更新 `docker-compose.monitoring.yml` 中的 `GF_SECURITY_ADMIN_PASSWORD` 环境变量

2. **Prometheus 访问**
   - 默认没有认证，生产环境请配置
   - 可以使用 Nginx 反向代理 + 基本认证

3. **网络隔离**
   - 监控栈应该只在内部网络安全访问
   - 不要将 Prometheus 和 Grafana 端口暴露到公网

## 📝 故障排查

### Prometheus 无法抓取 metrics

1. 检查 ClipSync 后端是否正常运行
   ```bash
   curl http://localhost:3000/api/health
   ```

2. 检查 Prometheus 目标状态
   - 访问 http://localhost:9090
   - 进入 **Status** → **Targets**
   - 查看 `clipsync-api` 目标是否为 **UP** 状态

3. 检查 Prometheus 配置文件
   ```bash
   docker exec clipsync-prometheus cat /etc/prometheus/prometheus.yml
   ```

### Grafana 无法连接 Prometheus

1. 检查 Prometheus 服务是否正常运行
   ```bash
   docker ps | grep prometheus
   ```

2. 检查 Grafana 数据源配置
   - 登录 Grafana
   - 进入 **Configuration** → **Data Sources**
   - 点击 **Prometheus**
   - 点击 **Save & Test**

### 仪表盘没有数据

1. 检查时间范围
   - 在 Grafana 仪表盘右上角，确保时间范围正确（例如 **Last 1 hour**）

2. 检查 PromQL 查询
   - 在 Prometheus Web UI 中测试查询
   - 确保查询返回数据

## 📚 参考资料

- [Prometheus 官方文档](https://prometheus.io/docs/)
- [Grafana 官方文档](https://grafana.com/docs/)
- [Node Exporter 文档](https://prometheus.io/docs/guides/node-exporter/)
- [PromQL 查询语言](https://prometheus.io/docs/prometheus/latest/querying/basics/)

---

**创建日期**：2026-06-24
**作者**：ClipSync Development Team
**版本**：1.0
