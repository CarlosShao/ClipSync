#!/bin/bash
# ClipSync 回滚脚本 —— 面向**生产 stack**（docker-compose.prod.yml）
#
# Usage:
#   ./scripts/rollback.sh                      # 回滚到 CI 记录的上一版本（锚点）
#   ./scripts/rollback.sh <commit|tag>         # 回滚到指定版本
#   ./scripts/rollback.sh <commit|tag> --db-dump backups/clipsync_daily_<ts>.dump
#   ./scripts/rollback.sh --uploads backups/clipsync_uploads_daily_<ts>.tar.gz
#
# 修掉的老问题（审计 G1）：
#   * DEPLOY_DIR=deploy 指向一个**不存在**的目录，版本号标记因此永远是 unknown，
#     "没有当前版本就没法回滚"这条链路其实从没接上过。现在改读 CI 部署 job 真正写下的
#     锚点文件 $PROJECT_DIR/.last_deploy_commit（见 .github/workflows/ci.yml 的"记录当前版本"）。
#   * 到处是裸 `docker-compose`（没有 `-f docker-compose.prod.yml`）：裸 docker-compose.yml
#     里没有任何 services，命令只会失败或作用到错误的 stack 上。现在统一用
#     `docker compose -f "$COMPOSE_FILE"`，并核对服务名真的存在。
#   * 容器名写成 clipsync-postgres（prod 实际是 clipsync-postgres-prod）、
#     库属主写成 postgres（prod 用的是 $DB_USER）⇒ 改成进容器执行，用户/库名取自容器自身环境。
#   * 原来的 `docker-compose down --timeout 30` 会把**数据库**一起停掉：一次应用回滚被放大成
#     一次数据库停机。现在只停/重建 api 服务。
#   * 数据库里存的只是元数据，用户上传的文件在 ./src/server/uploads（api-prod 的 bind mount）——
#     回滚路径现在也覆盖它（--uploads / 自动配对 DB dump 同一时刻的归档）。
#
# 环境变量：
#   COMPOSE_FILE / COMPOSE_ENV_FILE / API_SERVICE（默认 api-prod）/ POSTGRES_SERVICE（默认 postgres-prod）
#   BACKUP_DIR（默认 ./backups）/ UPLOADS_DIR（默认 ./src/server/uploads）
#   HEALTH_URL（默认 http://127.0.0.1:3000/api/health）
#   DB_DUMP / UPLOADS_ARCHIVE   显式指定要恢复的文件
#   ROLLBACK_SKIP_GIT=1         不切代码，只重建/重启容器（代码回滚由别处负责时用）
#   ROLLBACK_ALLOW_DB_RESTORE=yes  非交互环境下同意覆盖生产库（CI/演练用）
#   HEALTH_RETRIES（默认 10）、HEALTH_DELAY（默认 6 秒）
#
# ⚠️ 加密产物（*.gpg）本脚本不自动解密：先 `gpg --decrypt <file> > <file>.plain`，
#    再把 DB_DUMP/UPLOADS_ARCHIVE 指到解密后的文件。灾难恢复时少一层隐含动作更安全。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"
API_SERVICE="${API_SERVICE:-api-prod}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres-prod}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-$PROJECT_DIR/src/server/uploads}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-10}"
HEALTH_DELAY="${HEALTH_DELAY:-6}"

# CI 部署 job 真正写下的两个文件（锚点 + 日志）
DEPLOY_STATE_FILE="${DEPLOY_STATE_FILE:-$PROJECT_DIR/.last_deploy_commit}"
DEPLOY_LOG_FILE="${DEPLOY_LOG_FILE:-$PROJECT_DIR/.last_deploy_log}"

DB_DUMP="${DB_DUMP:-}"
UPLOADS_ARCHIVE="${UPLOADS_ARCHIVE:-}"
TARGET_ARG=""
ROLLBACK_SKIP_GIT="${ROLLBACK_SKIP_GIT:-0}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

usage() {
  sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

compose() {
  if [ -n "$COMPOSE_ENV_FILE" ]; then
    docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

# ---------- 版本解析 ----------
git_rev() {
  git -C "$PROJECT_DIR" rev-parse --verify --quiet "$1" 2>/dev/null
}

get_current_version() {
  local head
  head="$(git_rev HEAD)" || true
  if [ -n "$head" ]; then
    printf '%s\n' "${head:0:12}"
  else
    printf 'unknown\n'
  fi
}

# 回滚目标（顺序：命令行参数 > CI 写的锚点文件 > HEAD 的上一个提交）
get_target_version() {
  local anchor prev

  if [ -n "$TARGET_ARG" ]; then
    printf '%s\n' "$TARGET_ARG"
    return 0
  fi

  if [ -f "$DEPLOY_STATE_FILE" ]; then
    anchor="$(tr -d '[:space:]' < "$DEPLOY_STATE_FILE")"
    if [ -n "$anchor" ]; then
      log_info "使用部署锚点 $DEPLOY_STATE_FILE: $anchor" >&2
      printf '%s\n' "$anchor"
      return 0
    fi
    log_warn "锚点文件 $DEPLOY_STATE_FILE 是空的" >&2
  else
    log_warn "找不到锚点文件 $DEPLOY_STATE_FILE（CI 部署时会写），退回到 HEAD 的上一个提交" >&2
  fi

  prev="$(git_rev 'HEAD~1')" || true
  if [ -z "$prev" ]; then
    log_error "无法确定回滚目标：请显式给出 commit/tag" >&2
    return 1
  fi
  printf '%s\n' "$prev"
}

# ---------- 健康检查 ----------
health_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || echo 000
}

pre_rollback_check() {
  local code
  log_info "Pre-rollback health check: $HEALTH_URL"
  code="$(health_code)"
  if [ "$code" = "200" ]; then
    log_info "当前 /api/health = 200"
  else
    log_warn "当前 /api/health = $code（服务已不可用或还在启动）—— 继续回滚"
  fi
}

wait_for_health() {
  local i code
  i="$HEALTH_RETRIES"
  while [ "$i" -gt 0 ]; do
    code="$(health_code)"
    if [ "$code" = "200" ]; then
      log_info "健康检查通过: HTTP 200（$HEALTH_URL）"
      return 0
    fi
    i=$((i - 1))
    log_warn "健康检查未通过（HTTP $code），还剩 $i 次重试，等待 ${HEALTH_DELAY}s..."
    sleep "$HEALTH_DELAY"
  done
  log_error "回滚后 /api/health 始终不返回 200"
  return 1
}

# ---------- 安全备份（动任何东西之前） ----------
safety_backup_database() {
  local current_version="$1"
  local out="$BACKUP_DIR/clipsync_pre_rollback_${current_version}_$(date +%Y%m%d_%H%M%S).dump"

  mkdir -p "$BACKUP_DIR"
  log_info "先给当前数据库留个底: $out"
  # 用户/库名在容器内展开（prod 的属主是 $DB_USER，不是 postgres）
  if compose exec -T "$POSTGRES_SERVICE" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$out"; then
    sha256sum "$out" > "${out}.sha256"
    log_info "安全备份完成: $out"
  else
    rm -f "$out" 2>/dev/null || true
    log_error "回滚前的数据库安全备份失败 —— 不继续动数据库"
    return 1
  fi
}

safety_backup_uploads() {
  local out="$BACKUP_DIR/clipsync_uploads_pre_rollback_$(date +%Y%m%d_%H%M%S).tar.gz"

  if [ ! -d "$UPLOADS_DIR" ]; then
    log_warn "找不到上传目录 $UPLOADS_DIR，跳过上传文件的安全备份"
    return 0
  fi

  mkdir -p "$BACKUP_DIR"
  log_info "先给当前上传文件留个底: $out"
  if tar -czf "$out" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"; then
    sha256sum "$out" > "${out}.sha256"
    log_info "安全备份完成: $out"
  else
    rm -f "$out" 2>/dev/null || true
    log_error "回滚前的上传文件安全备份失败 —— 不继续动上传目录"
    return 1
  fi
}

# ---------- 代码回滚 ----------
rollback_code() {
  local target_version="$1"

  if [ "$ROLLBACK_SKIP_GIT" = "1" ]; then
    log_warn "ROLLBACK_SKIP_GIT=1：不切代码，只重建容器"
    return 0
  fi

  if ! git -C "$PROJECT_DIR" rev-parse --git-dir > /dev/null 2>&1; then
    log_error "$PROJECT_DIR 不是 git 仓库，无法切代码（可设 ROLLBACK_SKIP_GIT=1 只重启容器）"
    return 1
  fi

  log_info "拉取远端引用：git fetch --all --tags"
  git -C "$PROJECT_DIR" fetch --all --tags --prune

  # 用 checkout --detach 而不是 reset --hard：不丢本地未提交的改动，
  # 而且"当前部署在哪个 commit"这件事本来就是游离头最直白的表达。
  log_info "切换代码到 $target_version（detached HEAD）"
  if ! git -C "$PROJECT_DIR" checkout --detach "$target_version"; then
    log_error "git checkout --detach $target_version 失败（工作区可能有冲突的本地改动）"
    log_error "处理办法：在 $PROJECT_DIR 里先 stash 或 commit，再重跑本脚本"
    return 1
  fi
  log_info "当前 HEAD: $(git -C "$PROJECT_DIR" rev-parse --short HEAD)  $(git -C "$PROJECT_DIR" log -1 --oneline)"

  return 0
}

# ---------- 数据库 / 上传文件恢复 ----------
rollback_database() {
  local db_dump="$1"

  if [[ "$db_dump" == *.gpg ]]; then
    log_error "DB_DUMP 是加密文件（$db_dump），请先解密：gpg --decrypt '$db_dump' > '${db_dump%.gpg}'"
    return 1
  fi

  log_info "用 $db_dump 覆盖生产库（pg_restore --clean --if-exists）"

  # 动生产库是不可逆动作：有终端就要求确认；非交互（CI/演练）必须显式声明同意。
  if [ -t 0 ]; then
    if [ "${ROLLBACK_ALLOW_DB_RESTORE:-}" != "yes" ]; then
      printf '将把 %s 的内容恢复到 %s 的 %s 上，覆盖现有对象。继续？[y/N] ' \
        "$db_dump" "$POSTGRES_SERVICE" "$COMPOSE_FILE"
      read -r answer
      case "$answer" in
        y|Y|yes|YES) ;;
        *) log_error "已取消（未动数据库）"; return 1 ;;
      esac
    fi
  elif [ "${ROLLBACK_ALLOW_DB_RESTORE:-}" != "yes" ]; then
    log_error "非交互环境做数据库回滚需要显式同意：ROLLBACK_ALLOW_DB_RESTORE=yes"
    return 1
  fi

  if compose exec -T "$POSTGRES_SERVICE" \
      sh -c 'pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      < "$db_dump"; then
    log_info "数据库回滚完成"
    return 0
  fi

  log_error "数据库回滚失败（pg_restore 返回非 0）—— 回滚前的安全备份在 $BACKUP_DIR"
  return 1
}

rollback_uploads() {
  local archive="$1"

  if [[ "$archive" == *.gpg ]]; then
    log_error "UPLOADS_ARCHIVE 是加密文件（$archive），请先解密：gpg --decrypt '$archive' > '${archive%.gpg}'"
    return 1
  fi

  if [ ! -f "$archive" ]; then
    log_error "上传归档不存在: $archive"
    return 1
  fi

  log_info "从 $archive 恢复上传文件（原地覆盖 $UPLOADS_DIR）"
  mkdir -p "$UPLOADS_DIR"
  if tar -xzf "$archive" -C "$(dirname "$UPLOADS_DIR")"; then
    log_info "上传文件恢复完成"
    return 0
  fi

  log_error "上传归档解包失败 —— 当前内容已在回滚前的安全备份里"
  return 1
}

# 与 backup-db.sh / verify-backup.sh 同一套命名约定：
#   clipsync_<type>_<YYYYmmdd>_<HHMMSS>.dump ↔ clipsync_uploads_<type>_<YYYYmmdd>_<HHMMSS>.tar.gz
paired_uploads_archive() {
  local db_dump="$1"
  local base stem rest type ts candidate

  base="$(basename "$db_dump")"
  case "$base" in
    clipsync_*.dump) ;;
    *) return 0 ;;
  esac

  stem="${base%.dump}"
  rest="${stem#clipsync_}"
  type="${rest%%_*}"
  ts="${rest#*_}"

  for candidate in \
    "$BACKUP_DIR/clipsync_uploads_${type}_${ts}.tar.gz" \
    "$BACKUP_DIR/clipsync_uploads_${type}_${ts}.tar.gz.gpg"
  do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
}

# 没显式给 DB_DUMP 时，按版本号在 BACKUP_DIR 里找（找不到就跳过 DB 回滚，不猜）
find_db_dump_for() {
  local version="$1"
  local candidate

  candidate="$(ls -t "$BACKUP_DIR"/clipsync_*"$version"*.dump 2>/dev/null | sed -n '1p' || true)"
  if [ -n "$candidate" ]; then
    printf '%s\n' "$candidate"
  fi
}

update_version_marker() {
  local target_version="$1"
  local from_version="$2"

  printf '%s\n' "$target_version" > "$DEPLOY_STATE_FILE"
  printf '%s rollback -> %s (from %s)\n' "$(date '+%F %T')" "$target_version" "$from_version" >> "$DEPLOY_LOG_FILE"
  log_info "已更新部署锚点 $DEPLOY_STATE_FILE = $target_version"
}

# ---------- main ----------
main() {
  local current_version target_version db_dump uploads_archive do_db=0 do_uploads=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --db-dump)
        if [ $# -lt 2 ]; then log_error "--db-dump 需要一个文件参数"; exit 1; fi
        DB_DUMP="$2"; shift 2 ;;
      --db-dump=*)
        DB_DUMP="${1#*=}"; shift ;;
      --uploads)
        if [ $# -lt 2 ]; then log_error "--uploads 需要一个文件参数"; exit 1; fi
        UPLOADS_ARCHIVE="$2"; shift 2 ;;
      --uploads=*)
        UPLOADS_ARCHIVE="${1#*=}"; shift ;;
      -h|--help)
        usage; exit 0 ;;
      *)
        if [ -z "$TARGET_ARG" ]; then
          TARGET_ARG="$1"; shift
        else
          log_error "未知参数: $1"; usage; exit 1
        fi ;;
    esac
  done

  log_info "=== ClipSync Rollback Starting ==="
  log_info "compose: $COMPOSE_FILE    api: $API_SERVICE / db: $POSTGRES_SERVICE"

  # 前置检查：compose 文件 + 服务名真的存在（别像老脚本那样对着不存在的服务名发命令）
  if [ ! -f "$COMPOSE_FILE" ]; then
    log_error "找不到 compose 文件: $COMPOSE_FILE"
    exit 1
  fi
  if ! compose config --services 2>/dev/null | grep -qx "$API_SERVICE"; then
    log_error "$COMPOSE_FILE 里没有服务 $API_SERVICE（实际: $(compose config --services 2>/dev/null | tr '\n' ' '))"
    exit 1
  fi
  if ! compose config --services 2>/dev/null | grep -qx "$POSTGRES_SERVICE"; then
    log_error "$COMPOSE_FILE 里没有服务 $POSTGRES_SERVICE"
    exit 1
  fi

  current_version="$(get_current_version)"
  target_version="$(get_target_version)"
  log_info "Current version: $current_version"
  log_info "Target version : $target_version"

  # 都是短 SHA 时直接比：一样就没必要回滚
  if [ -n "$target_version" ] && [ "${current_version}" = "${target_version:0:12}" ]; then
    log_error "目标版本与当前版本相同（$current_version），无需回滚"
    exit 0
  fi

  # 目标 commit 必须真的能解析出来（打字错一个字符就该在这里停）
  if ! git_rev "$target_version" > /dev/null; then
    log_error "在 $PROJECT_DIR 里解析不出这个版本: $target_version"
    exit 1
  fi

  # 数据库：显式给了就用，否则按版本号找；找不到就**跳过**（不猜一个有风险的库）
  if [ -n "$DB_DUMP" ]; then
    if [ ! -f "$DB_DUMP" ]; then log_error "DB_DUMP 不存在: $DB_DUMP"; exit 1; fi
    do_db=1
  else
    db_dump="$(find_db_dump_for "$target_version")"
    if [ -n "$db_dump" ]; then
      log_warn "没有显式指定 DB_DUMP，按版本号匹配到 $db_dump（如不对请用 --db-dump 指定）"
      DB_DUMP="$db_dump"
      do_db=1
    else
      DB_DUMP=""
      log_warn "没有找到与 $target_version 对应的数据库备份 ⇒ 本次**只回滚代码/容器**，不动数据"
      log_warn "（需要连数据一起回滚时：--db-dump backups/clipsync_*.dump）"
    fi
  fi

  # 上传文件：显式给了就用，否则与 DB dump 配对
  if [ -n "$UPLOADS_ARCHIVE" ]; then
    if [ ! -f "$UPLOADS_ARCHIVE" ]; then log_error "UPLOADS_ARCHIVE 不存在: $UPLOADS_ARCHIVE"; exit 1; fi
    do_uploads=1
  elif [ "$do_db" = "1" ]; then
    uploads_archive="$(paired_uploads_archive "$DB_DUMP")"
    if [ -n "$uploads_archive" ]; then
      log_info "找到配对的上传归档: $uploads_archive"
      UPLOADS_ARCHIVE="$uploads_archive"
      do_uploads=1
    else
      log_warn "没有与 $(basename "$DB_DUMP") 配对的上传归档 ⇒ 只回滚数据库，不动上传文件"
    fi
  fi

  pre_rollback_check

  # 1) 动数据之前先留底（两个都要，缺一个都可能是"回滚把数据搞丢"）
  if ! safety_backup_database "$current_version"; then
    if [ "$do_db" = "1" ]; then
      log_error "本次要覆盖生产库，却连不上库、留不了底 —— 拒绝继续（先确认 $POSTGRES_SERVICE 在跑，或手工 pg_dump 后再跑）"
      exit 1
    fi
    log_warn "数据库安全备份没做成（本次只回滚代码/容器，继续）"
  fi
  if [ "$do_uploads" = "1" ]; then
    if ! safety_backup_uploads; then
      log_error "本次要覆盖上传目录，却留不了底 —— 拒绝继续"
      exit 1
    fi
  fi

  # 2) 要动数据就先停 api（只停 api，别把数据库一起停了）
  if [ "$do_db" = "1" ] || [ "$do_uploads" = "1" ]; then
    log_info "恢复数据期间先停掉 $API_SERVICE，避免写入与恢复互相踩"
    compose stop "$API_SERVICE" || log_warn "stop $API_SERVICE 未成功（服务可能本来就没起）"
  fi

  # 3) 代码
  rollback_code "$target_version"

  # 4) 数据（数据最关键，放在容器重建之前）
  if [ "$do_uploads" = "1" ]; then
    rollback_uploads "$UPLOADS_ARCHIVE"
  fi
  if [ "$do_db" = "1" ]; then
    rollback_database "$DB_DUMP"
  fi

  # 5) 用回滚后的代码重建并启动 api（restart 不会拉起新镜像/新代码）
  log_info "重建并启动 $API_SERVICE（$COMPOSE_FILE）"
  compose up -d --build "$API_SERVICE"

  # 6) 判定：健康检查不过就是失败
  if ! wait_for_health; then
    echo ""
    compose ps "$API_SERVICE" || true
    compose logs --tail=50 "$API_SERVICE" || true
    log_error "回滚后服务不健康 —— 需要人工介入"
    log_error "回滚前的安全备份：$BACKUP_DIR/clipsync_pre_rollback_* 与 clipsync_uploads_pre_rollback_*"
    exit 1
  fi

  echo ""
  compose ps "$API_SERVICE" || true

  # 7) 记录
  update_version_marker "$target_version" "$current_version"

  log_info "=== Rollback Completed ==="
  log_info "Rolled back from $current_version to $target_version"
  log_warn "现在仓库处于 detached HEAD。要回到主线：git -C $PROJECT_DIR checkout master"
}

main "$@"
