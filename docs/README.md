# ClipSync 文档索引

> **最后更新**: 2026年6月24日  
> **用途**: 快速查找项目文档

---

## 📚 开发文档

### developer-guide.md
- **用途**: 开发者环境设置指南
- **读者**: 开发人员
- **内容**: 前置要求（Node.js, Flutter, Rust, Docker）、开发环境配置

### api-reference.md
- **用途**: API接口文档
- **读者**: 前端开发人员、第三方集成开发者
- **内容**: 基础URL、认证方式、所有API端点定义

---

## 🧪 测试文档

### production-test-plan.md
- **用途**: 生产环境测试计划
- **版本**: v2.1
- **读者**: 测试人员、产品负责人
- **内容**: 测试环境总览、外部依赖验证、后端服务验证、端到端同步测试、性能测试、安全测试、准出条件

### user-guide.md
- **用途**: 终端用户功能测试操作指南
- **版本**: v1.0
- **读者**: 终端用户（非技术人员）
- **内容**: 安装注册、剪贴板同步、图片同步、文件同步、搜索功能、离线使用、设置页面

### e2e-audit-report.md
- **用途**: E2E全流程审计报告
- **读者**: 开发人员、测试人员
- **内容**: 代码级逐流程审查报告

---

## 🚀 部署文档

### monitoring-setup-guide.md
- **用途**: Prometheus + Grafana监控栈部署指南
- **读者**: 运维人员
- **内容**: Docker Compose配置、Prometheus配置、Grafana仪表板

### multi-instance-deployment-guide.md
- **用途**: Docker Compose多实例部署与Nginx负载均衡配置
- **读者**: 运维人员
- **内容**: 多实例部署架构、Nginx配置、健康检查

### disaster-recovery.md
- **用途**: 灾难恢复策略文档
- **读者**: 运维人员、管理人员
- **内容**: RTO/RPO指标、备份策略、恢复流程

---

## 💰 支付与订阅文档

### payment-integration-guide.md
- **用途**: 支付渠道集成技术文档
- **版本**: v1.0
- **读者**: 开发人员、运维人员
- **内容**: 微信支付、支付宝、Stripe集成步骤

### webhook-integration-guide.md
- **用途**: Webhook签名验证功能配置与使用说明
- **读者**: 开发人员
- **内容**: 签名验证原理、配置示例、安全最佳实践

---

## 🔒 安全文档

### encryption-integration-guide.md
- **用途**: AES-256-GCM加密功能配置与最佳实践
- **读者**: 开发人员、安全审计人员
- **内容**: 加密方案、密钥管理、使用方式、API示例

### external-dependencies.md
- **用途**: 外部依赖任务跟踪清单
- **读者**: 项目管理人员、开发人员
- **内容**: 需要外部依赖的任务列表（域名、云服务器、开发者账号等）

---

## 📊 性能优化文档

### android-performance-optimization-guide.md
- **用途**: Android端性能优化目标与方案
- **读者**: 开发人员
- **内容**: 包大小优化、启动速度优化、内存优化

### windows-performance-optimization-guide.md
- **用途**: Windows端性能优化目标与方案
- **读者**: 开发人员
- **内容**: 二进制大小优化、启动速度优化、内存优化

---

## 📋 项目管理文档

### production-roadmap.md
- **用途**: 产品商用化实施规划
- **版本**: v4.0
- **读者**: 项目管理人员、产品负责人
- **内容**: 产品定位、优先级说明、整体进度概览、阶段详细任务

---

## 📁 归档文档

以下文档已归档到 `.workbuddy/archive/docs/` 目录：
- stage-4-completion-summary.md
- stage-10-completion-summary.md
- redis-migration-summary.md
- task-117-completion-summary.md
- task-118-completion-summary.md
- task-119-completion-summary.md

---

## 🔍 快速查找

| 我想... | 应该读... |
|-----------|-----------|
| 搭建开发环境 | developer-guide.md |
| 了解API接口 | api-reference.md |
| 测试产品功能 | production-test-plan.md, user-guide.md |
| 部署到生产环境 | multi-instance-deployment-guide.md |
| 配置监控告警 | monitoring-setup-guide.md |
| 集成支付功能 | payment-integration-guide.md |
| 了解安全特性 | encryption-integration-guide.md, webhook-integration-guide.md |
| 查看项目进度 | production-roadmap.md |
| 优化性能 | android-performance-optimization-guide.md, windows-performance-optimization-guide.md |

---

## 📝 文档维护

- **负责人**: 开发团队
- **更新频率**: 每次功能开发完成后更新相关文档
- **版本控制**: 所有文档使用Markdown格式，版本号在文件头部注明

---

**文档总数**: 15个（不含归档文档）
