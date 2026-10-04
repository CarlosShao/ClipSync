#!/bin/bash
# ClipSync 备份脚本 —— 面向**生产 stack**（docker-compose.prod.yml）
# Usage: ./scripts/backup-db.sh [daily|weekly|manual]
#
# 备份两样东西（缺一不可）：
#   1) PostgreSQL 逻辑备份：pg_dump -Fc ⇒ clipsync_<type>_<ts>.dump
#      （与 docker-compose.prod.yml 里 backup 服务每小时的产物**同格式同后缀**；
#        途中曾被写成只 dump `clipsync-postgres` 这个不存在的容器，见审计 G1）
#   2) 用户上传的文件：./src/server/uploads ⇒ clipsync_uploads_<type>_<ts>.tar.gz
#      （api-prod 把这个目录 bind mount 到 /app/uploads，数据库里只有元数据 ——
#        换句话说这份文件是**唯一一份**用户资料，过去完全没备份）
#
# 环境变量（默认值全部对齐 docker-compose.prod.yml，可覆盖）：
#   COMPOSE_FILE        默认 $PROJECT_DIR/docker-compose.prod.yml
#   COMPOSE_ENV_FILE    生产机上用 `--env-file .env.production` 起服务时，把它设为 .env.production
#   POSTGRES_SERVICE    默认 postgres-prod（compose 服务名；容器名才是 clipsync-postgres-prod）
#   BACKUP_DIR          默认 $PROJECT_DIR/backups（= prod 里挂进容器的 ./backups）
#   UPLOADS_DIR         默认 $PROJECT_DIR/src/server/uploads
#   BACKUP_ENCRYPTION_KEY  设了就对产物做 GPG 对称加密（AES256），失败则回退为明文并告警
#   BACKUP_RETENTION_DAYS   daily 保留天数，默认 30
#   BACKUP_RETENTION_WEEKS  weekly 保留周数，默认 12
#
# 本脚本只做**本机**备份。异地（offsite）副本、以及“备份能不能恢复”的定期演练
# 需要 owner/基建决策（见审计 G1 报告），这里刻意不假装已经覆盖。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

BACKUP_TYPE="${1:-manual}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres-prod}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-$PROJECT_DIR/src/server/uploads}"

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
RETENTION_WEEKS="${BACKUP_RETENTION_WEEKS:-12}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DB_DUMP="$BACKUP_DIR/clipsync_${BACKUP_TYPE}_${TIMESTAMP}.dump"
UPLOADS_ARCHIVE="$BACKUP_DIR/clipsync_uploads_${BACKUP_TYPE}_${TIMESTAMP}.tar.gz"

log()      { echo "[$(date '+%F %T')] $*"; }
log_warn() { echo "[$(date '+%F %T')] WARNING: $*"; }

# 只认 prod 的那份 compose 文件；-f 必须带上，否则 compose 会去找裸 docker-compose.yml
# （那个文件里没有任何 services，命令只会报“服务不存在”）。
compose() {
  if [ -n "$COMPOSE_ENV_FILE" ]; then
    docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

# 可选加密。stdout 只输出**最终保留**的文件路径，日志走 stderr，
# 这样 `file="$(encrypt_file "$file")"` 不会把日志当成文件名。
encrypt_file() {
  local file="$1"
  local enc="$1.gpg"

  if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
    log_warn "未设置 BACKUP_ENCRYPTION_KEY，保留未加密文件: $file" >&2
    printf '%s\n' "$file"
    return 0
  fi

  if gpg --batch --yes --passphrase "$BACKUP_ENCRYPTION_KEY" \
      --symmetric --cipher-algo AES256 -o "$enc" "$file" 2>/dev/null; then
    sha256sum "$enc" > "${enc}.sha256"
    rm -f "$file" "${file}.sha256"
    log "已加密: $enc" >&2
    printf '%s\n' "$enc"
  else
    log_warn "GPG 加密失败，保留未加密文件: $file" >&2
    rm -f "$enc" 2>/dev/null || true
    printf '%s\n' "$file"
  fi
}

# ---------- 前置检查：compose 文件在不在、postgres 服务在不在跑 ----------
if [ ! -f "$COMPOSE_FILE" ]; then
  log_warn "找不到 compose 文件: $COMPOSE_FILE"
  exit 1
fi

if ! compose ps --status running --services 2>/dev/null | grep -qx "$POSTGRES_SERVICE"; then
  log_warn "compose 服务 $POSTGRES_SERVICE 未在运行（$COMPOSE_FILE）。先执行： docker compose -f $COMPOSE_FILE up -d"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
log "Starting $BACKUP_TYPE backup (compose: $COMPOSE_FILE)..."

# ---------- 1. 数据库 ----------
# 凭据不需要落在宿主机：容器自己的环境里就有 POSTGRES_USER / POSTGRES_DB
# （docker-compose.prod.yml 从 ${DB_USER} / ${DB_NAME} 插值进去），
# 所以这里用 sh -c + 单引号，让变量在**容器内**展开，宿主机不接触口令。
log "Dumping PostgreSQL ($POSTGRES_SERVICE) -> $DB_DUMP"
if ! compose exec -T "$POSTGRES_SERVICE" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$DB_DUMP"; then
  log_warn "pg_dump 失败，删掉半成品文件 $DB_DUMP"
  rm -f "$DB_DUMP" 2>/dev/null || true
  exit 1
fi

DB_SIZE="$(wc -c < "$DB_DUMP" | tr -d ' ')"
if [ "$DB_SIZE" -lt 1024 ]; then
  log_warn "dump 只有 $DB_SIZE 字节，明显不是有效备份，已删除"
  rm -f "$DB_DUMP"
  exit 1
fi
sha256sum "$DB_DUMP" > "${DB_DUMP}.sha256"
log "Checksum generated: ${DB_DUMP}.sha256"

# ---------- 2. 上传的文件 ----------
# ./src/server/uploads 就是 api-prod 里 /app/uploads 的宿主机侧（bind mount），
# 直接从宿主机打包即可，不用进容器；归档里顶层目录名保持 "uploads"，
# 恢复时 `tar -xzf <archive> -C "$(dirname "$UPLOADS_DIR")"` 即可原地还原。
if [ -d "$UPLOADS_DIR" ]; then
  log "Archiving uploads ($UPLOADS_DIR) -> $UPLOADS_ARCHIVE"
  tar -czf "$UPLOADS_ARCHIVE" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
  sha256sum "$UPLOADS_ARCHIVE" > "${UPLOADS_ARCHIVE}.sha256"
  log "Checksum generated: ${UPLOADS_ARCHIVE}.sha256"
else
  log_warn "找不到上传目录 $UPLOADS_DIR —— 本次**没有**备份用户上传文件"
fi

# ---------- 3. 可选加密 ----------
DB_DUMP="$(encrypt_file "$DB_DUMP")"
if [ -f "$UPLOADS_ARCHIVE" ]; then
  UPLOADS_ARCHIVE="$(encrypt_file "$UPLOADS_ARCHIVE")"
fi

# ---------- 4. 轮转 ----------
# 只按“类型 token”清理本脚本自己的产物（clipsync_<type>_*.dump / clipsync_uploads_<type>_*.tar.gz）：
# prod 里 backup 服务每小时的产物叫 clipsync_<ts>.dump、由容器自己的 BACKUP_KEEP_DAYS 清理，
# 两套命名不重叠，避免这里误删它。
case "$BACKUP_TYPE" in
  daily)
    find "$BACKUP_DIR" -maxdepth 1 -type f \
      \( -name 'clipsync_daily_*.dump*' -o -name 'clipsync_uploads_daily_*.tar.gz*' \) \
      -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
    log "Cleaned up daily backups older than $RETENTION_DAYS days"
    ;;
  weekly)
    find "$BACKUP_DIR" -maxdepth 1 -type f \
      \( -name 'clipsync_weekly_*.dump*' -o -name 'clipsync_uploads_weekly_*.tar.gz*' \) \
      -mtime +"$((RETENTION_WEEKS * 7))" -delete 2>/dev/null || true
    log "Cleaned up weekly backups older than $RETENTION_WEEKS weeks"
    ;;
  *)
    log "manual 类型不做轮转（避免误删 daily/weekly 的产物）"
    ;;
esac

# ---------- 5. 清单 + 自检 ----------
echo ""
log "Current backups:"
# shellcheck disable=SC2012  # 这里要的是人类可读的 ls -lh 列表，不是给机器消费的
ls -lh "$BACKUP_DIR"/clipsync_* 2>/dev/null || log "No backups found"
echo ""

log "本次产物："
log "  DB      : $DB_DUMP"
if [ -f "$UPLOADS_ARCHIVE" ]; then
  log "  Uploads : $UPLOADS_ARCHIVE"
fi

# 立刻验一次（校验和 + 格式 + 恢复到一个临时库），失败的备份不算备份。
log "Running post-backup verification..."
"$SCRIPT_DIR/verify-backup.sh" "$DB_DUMP"

log "Backup completed."
