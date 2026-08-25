# ClipSync 灾难恢复计划 (Disaster Recovery)

## 目标

| 指标 | 目标值 |
|------|--------|
| RTO (Recovery Time Objective) | < 4小时 |
| RPO (Recovery Point Objective) | < 1小时 |
| 数据丢失容忍度 | 最近1小时内的数据变更可丢失 |

---

## 灾难场景分类

### Level 1 - 单点故障（服务降级）
- **场景**: 单个容器崩溃、单个服务进程异常
- **影响**: 服务暂时不可用，数据完整
- **恢复时间**: < 15分钟
- **恢复步骤**:
  1. Docker自动重启策略生效 (`restart: unless-stopped`)
  2. 手动干预: `docker-compose restart <service>`
  3. 健康检查验证: `curl http://localhost:3000/api/health`

### Level 2 - 数据层故障（数据风险）
- **场景**: PostgreSQL崩溃、Redis数据丢失
- **影响**: 数据可能不完整，服务完全中断
- **恢复时间**: < 1小时
- **恢复步骤**:
  1. PostgreSQL: 从最近备份恢复 (`scripts/verify-backup.sh` 验证 + 恢复)
  2. Redis: 重新启动即可（Redis为缓存层，数据可重建）
  3. 运行数据库迁移: `node src/db/migrate.js`
  4. 健康检查验证

### Level 3 - 全系统故障（灾难级）
- **场景**: 服务器硬件故障、数据中心级故障
- **影响**: 全系统不可用，需要在新环境重建
- **恢复时间**: < 4小时
- **恢复步骤**:
  1. 准备新服务器环境 (Docker + Docker Compose)
  2. 从异地备份仓库获取最新备份
  3. 克隆项目代码: `git clone <repo>`
  4. 配置环境变量: `.env.production`
  5. 启动服务: `docker-compose up -d`
  6. 迁移数据库: `node src/db/migrate.js`
  7. 从备份恢复数据: `scripts/backup-db.sh restore`
  8. 健康检查验证
  9. 通知用户服务恢复

---

## 备份策略

### PostgreSQL 备份
- **频率**: 每日自动备份 (cron 02:00)
- **方式**: `pg_dump` + gzip压缩
- **保留**: 30天日备份 + 12周周备份
- **存储**: 本地 `backups/` + 异地备份（推荐S3/OSS）
- **验证**: 每周自动运行 `scripts/verify-backup.sh`

### Redis 备份
- Redis为缓存层，AOF持久化已启用
- 不需要单独备份，数据可从PostgreSQL重建

### 配置备份
- `.env.production` 保存在安全存储（Vault/加密存储）
- `docker-compose.yml` 保存在Git仓库

---

## 演练脚本

### 自动演练（月度）
```bash
# 1. 触发备份验证
./scripts/verify-backup.sh

# 2. 模拟Level 1故障：停止API容器
docker-compose stop api
# 等待自动重启或手动恢复
docker-compose up -d api

# 3. 验证恢复
curl http://localhost:3000/api/health
```

### 手动演练（季度 - Level 2）
```bash
# 1. 创建备份
./scripts/backup-db.sh manual

# 2. 模拟数据库故障：停止PostgreSQL
docker-compose stop postgres

# 3. 从备份恢复
./scripts/verify-backup.sh <latest-backup>

# 4. 重启服务验证
docker-compose up -d
curl http://localhost:3000/api/health
```

### 全系统演练（年度 - Level 3）
- 在新服务器上完整重建
- 从异地备份恢复
- 验证RTO < 4小时

---

## 监控与告警

### 关键指标
- PostgreSQL连接数 > 80%最大值 → 警告
- API响应时间 P95 > 500ms → 警告
- 健康检查连续3次失败 → 严重告警
- 备份文件大小异常变化 → 警告

### 告警通知
- Level 1: 日志记录 + 邮件通知
- Level 2: 邮件 + 即时通知（Slack/钉钉）
- Level 3: 全渠道通知 + 电话

---

## 联系人与职责

| 角色 | 职责 | 联系方式 |
|------|------|----------|
| 系统管理员 | 服务器运维、Docker管理 | admin@clipsync.com |
| 数据库管理员 | 数据库备份恢复、迁移 | dba@clipsync.com |
| 开发负责人 | 应用层故障排查、代码修复 | dev@clipsync.com |
| 安全负责人 | 安全事件响应 | security@clipsync.com |

> **注意**: 请在部署前更新为实际联系人信息

---

## 附录

### 快速恢复命令集
```bash
# 查看服务状态
docker-compose ps

# 查看日志
docker-compose logs --tail=100 api

# 重启单个服务
docker-compose restart api

# 完全重建
docker-compose down && docker-compose up -d

# 数据库备份（带校验和）
./scripts/backup-db.sh manual

# 数据库备份（带加密）
BACKUP_ENCRYPTION_KEY=your_key ./scripts/backup-db.sh manual

# 数据库恢复（未加密备份）
gunzip -c backups/clipsync_manual_YYYYMMDD.sql.gz | docker exec -i clipsync-postgres psql -U clipsync clipsync

# 数据库恢复（加密备份）
export BACKUP_ENCRYPTION_KEY=your_key
./scripts/verify-backup.sh backups/clipsync_manual_YYYYMMDD.sql.gz.gpg

# 备份验证
./scripts/verify-backup.sh

# 查看备份列表
ls -lh backups/
```
