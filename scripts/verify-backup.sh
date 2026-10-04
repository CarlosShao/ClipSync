#!/bin/bash
# ClipSync 备份校验脚本（面向**生产 stack**：docker-compose.prod.yml）
# Usage: ./scripts/verify-backup.sh [backup-file]
#   不给参数时自动挑 $BACKUP_DIR 下**最新**的备份。
#
# 支持的产物格式（都是本仓库会产出的）：
#   *.dump / *.dump.gpg      pg_dump -Fc 自定义格式 —— docker-compose.prod.yml 里 backup 服务的产物
#                            （clipsync_<ts>.dump），也是 scripts/backup-db.sh 的产物
#   *.sql.gz / *.sql.gz.gpg  纯文本 SQL 的 gzip —— 历史格式，仍可校验与恢复
#
# 修掉的老问题（审计 G1）：
#   * 只用 glob `clipsync_*.sql.gz*` ⇒ ① 挑不到 prod 实际产出的 .dump；
#     ② 会挑中 `*.sql.gz.sha256` 校验文件（它的 mtime 最新，于是"验备份"变成"验校验文件"）；
#   * 固定用容器名 clipsync-postgres（prod 实际是 clipsync-postgres-prod）、
#     固定 `-U postgres`（prod 的库属主来自 $DB_USER）⇒ 在生产上必然连不上。
#
# 校验分三层：
#   ① sha256 校验和（有 .sha256 才做）
#   ② 格式/完整性（-Fc 用 pg_restore --list 读目录；纯文本用 gzip -t + 头部检查）
#   ③ 真恢复到一个**临时数据库**，数表/索引/外键，然后删掉临时库
#      —— ③ 会在 postgres 容器里短暂建一个 clipsync_verify_test_* 库，这是本脚本唯一副作用。
#
# 环境变量（默认对齐 docker-compose.prod.yml）：
#   COMPOSE_FILE / COMPOSE_ENV_FILE / POSTGRES_SERVICE / BACKUP_DIR / VERIFY_DIR
#   UPLOADS_ARCHIVE      显式指定要一并校验的上传归档（tar.gz）；不设则按时间戳自动配对
#   BACKUP_ENCRYPTION_KEY  校验加密产物（*.gpg）时必需
#   BACKUP_STALE_HOURS   最新备份超过这个小时数就告警（默认 26）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres-prod}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
VERIFY_DIR="${VERIFY_DIR:-$BACKUP_DIR/verify-test}"
STALE_HOURS="${BACKUP_STALE_HOURS:-26}"
UPLOADS_ARCHIVE="${UPLOADS_ARCHIVE:-}"
MAINTENANCE_DB="${MAINTENANCE_DB:-postgres}"
TEST_DB_NAME="clipsync_verify_test_$(date +%s)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_pass()  { echo -e "${GREEN}[PASS]${NC}  $1"; }
log_fail()  { echo -e "${RED}[FAIL]${NC}  $1"; }

# 解密出来的明文 dump 是敏感物，退出时一定要删掉。
TEMP_FILES=()
cleanup() {
  local f
  for f in "${TEMP_FILES[@]:-}"; do
    if [ -n "$f" ]; then rm -f "$f" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

compose() {
  if [ -n "$COMPOSE_ENV_FILE" ]; then
    docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

# 在容器内跑 SQL：用户名取容器自己的 $POSTGRES_USER（宿主机不接触凭据），
# 库名与 SQL 作为位置参数传进去（避免在 sh -c 里拼字符串）。
pg_query() {  # $1 = 数据库名, $2 = SQL
  compose exec -T "$POSTGRES_SERVICE" sh -c 'psql -U "$POSTGRES_USER" -d "$1" -t -A -c "$2"' _ "$1" "$2"
}

pg_admin() {  # $1 = SQL，连到 maintenance 库执行（建库/删库）
  compose exec -T "$POSTGRES_SERVICE" sh -c 'psql -U "$POSTGRES_USER" -d "$1" -t -A -c "$2"' _ "$MAINTENANCE_DB" "$1"
}

# ---------- 选文件 ----------

# 候选备份列表（**排除** .sha256 校验文件），最新的在最前面
list_backups() {
  local candidates=() pattern
  shopt -s nullglob
  for pattern in \
    "$BACKUP_DIR"/clipsync_*.dump \
    "$BACKUP_DIR"/clipsync_*.dump.gpg \
    "$BACKUP_DIR"/clipsync_*.sql.gz \
    "$BACKUP_DIR"/clipsync_*.sql.gz.gpg
  do
    candidates+=("$pattern")
  done
  shopt -u nullglob

  if [ "${#candidates[@]}" -eq 0 ]; then
    return 0
  fi
  # shellcheck disable=SC2012  # 明确给出文件清单时 ls -t 就是最省事的 mtime 排序
  ls -t "${candidates[@]}" 2>/dev/null || true
}

find_backup() {
  local specified="$1"
  local latest

  if [ -n "$specified" ]; then
    if [ ! -f "$specified" ]; then
      log_error "指定的备份文件不存在: $specified"
      exit 1
    fi
    printf '%s\n' "$specified"
    return 0
  fi

  # 用 sed -n 1p 而不是 head -1：head 提前退出会给上游 ls 一个 SIGPIPE，
  # 在 `set -o pipefail` 下会被当成失败。
  latest="$(list_backups | sed -n '1p')"
  if [ -z "$latest" ]; then
    log_error "在 $BACKUP_DIR 里找不到备份（找过 clipsync_*.dump / *.dump.gpg / *.sql.gz / *.sql.gz.gpg）"
    exit 1
  fi
  printf '%s\n' "$latest"
}

warn_if_stale() {
  local backup_file="$1"
  local mtime now age_hours

  mtime=$(stat -c %Y "$backup_file" 2>/dev/null || stat -f %m "$backup_file" 2>/dev/null || echo 0)
  if [ "$mtime" -eq 0 ]; then
    log_warn "读不出备份的修改时间，跳过新鲜度检查"
    return 0
  fi

  now=$(date +%s)
  age_hours=$(( (now - mtime) / 3600 ))
  if [ "$age_hours" -gt "$STALE_HOURS" ]; then
    log_warn "最新的备份已经 $age_hours 小时没更新（阈值 ${STALE_HOURS}h）—— 备份任务可能已经停了"
  else
    log_info "备份新鲜度: $age_hours 小时前"
  fi
}

# ---------- 格式判断 ----------
backup_format() {
  case "$1" in
    *.dump|*.dump.gpg)     printf 'custom\n' ;;
    *.sql.gz|*.sql.gz.gpg) printf 'plain\n' ;;
    *)                     printf 'unknown\n' ;;
  esac
}

# 指向"可直接交给 pg_restore/psql 的文件"：未加密就是原文件，加密的先解密到临时文件。
# stdout 只输出路径。
materialize_backup() {
  local input="$1"
  local out

  if [ "${input##*.}" != "gpg" ]; then
    printf '%s\n' "$input"
    return 0
  fi

  out="$(mktemp "${TMPDIR:-/tmp}/clipsync-verify.XXXXXX")"
  TEMP_FILES+=("$out")
  if ! decrypt_backup "$input" "$out"; then
    return 1
  fi
  printf '%s\n' "$out"
}

# 解密（只处理 *.gpg）：成功返回 0，明文写到 $2。刻意不往 stdout 写东西，
# 老版本这里既 echo 日志又 echo 路径，调用方 $(...) 拿到的是混在一起的东西。
decrypt_backup() {
  local input_file="$1"
  local output_file="$2"

  if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
    log_error "BACKUP_ENCRYPTION_KEY 未设置，无法解密 $input_file"
    log_info  "请设置 BACKUP_ENCRYPTION_KEY=<GPG 口令> 后重试"
    return 1
  fi

  if gpg --batch --yes --passphrase "$BACKUP_ENCRYPTION_KEY" \
      --decrypt "$input_file" 2>/dev/null > "$output_file"; then
    log_pass "备份解密成功"
    return 0
  fi

  log_error "解密失败 —— 口令不对或文件损坏"
  return 1
}

# ---------- ① 校验和 ----------
# 比的是**哈希本身**而不是 `sha256sum -c` 的整行匹配：校验文件里记的路径可能是
# `backups/x.dump`（相对当时的 cwd）或容器里的 `/backups/x.dump`，
# 那种"路径对不上"会被 -c 报成"校验失败/文件找不到"，从而把"文件没坏"误判成坏。
verify_checksum() {
  local backup_file="$1"
  local checksum_file="${backup_file}.sha256"
  local expected actual

  log_info "Verifying SHA256 checksum..."

  if [ ! -f "$checksum_file" ]; then
    log_warn "找不到校验文件: $checksum_file"
    log_warn "（没有校验和就无法证明这份备份没被改坏，建议由 backup-db.sh 生成）"
    return 0  # 缺校验和只是告警，不判失败
  fi

  expected="$(awk '{print $1; exit}' "$checksum_file" 2>/dev/null)"
  actual="$(sha256sum "$backup_file" | awk '{print $1}')"

  if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
    log_pass "SHA256 checksum verified"
    return 0
  fi

  log_fail "SHA256 校验不匹配 —— 备份可能已损坏或被改动"
  log_info  "Expected:  $expected"
  log_info  "Actual:    $actual"
  return 1
}

# ---------- ② 完整性/格式 ----------
verify_file_integrity() {
  local backup_file="$1"
  local file_to_check format filesize

  log_info "Verifying file integrity of: $backup_file"

  if [ ! -r "$backup_file" ]; then
    log_fail "Backup file is not readable"
    return 1
  fi
  log_pass "File is readable"

  filesize=$(stat -f%z "$backup_file" 2>/dev/null || stat -c%s "$backup_file" 2>/dev/null || echo 0)
  if [ "$filesize" -lt 1024 ]; then
    log_fail "备份文件太小（$filesize 字节），大概率是空的或损坏"
    return 1
  fi
  log_pass "File size is reasonable ($filesize bytes)"

  format="$(backup_format "$backup_file")"
  if [ "$format" = "unknown" ]; then
    log_fail "无法识别的备份后缀: $backup_file"
    log_info  "支持 *.dump / *.dump.gpg（pg_dump -Fc）与 *.sql.gz / *.sql.gz.gpg（旧格式）"
    return 1
  fi
  log_info "格式: $format"

  file_to_check="$(materialize_backup "$backup_file")" || return 1

  if [ "$format" = "custom" ]; then
    # -Fc 自带目录（TOC）：pg_restore --list 能读出来，就说明头部与目录结构完好。
    # 宿主机上通常没有 pg_restore，所以从 postgres 容器里跑（读 stdin）。
    if compose exec -T "$POSTGRES_SERVICE" pg_restore --list < "$file_to_check" > /dev/null 2>&1; then
      log_pass "pg_restore --list 可读出目录（-Fc 结构完整）"
    else
      log_fail "-Fc 结构损坏：pg_restore --list 失败"
      return 1
    fi
  else
    log_info "Testing gzip decompression..."
    if gzip -t "$file_to_check" 2>/dev/null; then
      log_pass "Gzip file is intact"
    else
      log_fail "Gzip 文件损坏 —— 无法解压"
      return 1
    fi

    log_info "Checking SQL content structure..."
    if zcat "$file_to_check" 2>/dev/null | head -20 | grep -q "PostgreSQL database dump"; then
      log_pass "SQL dump header found"
    else
      log_fail "SQL dump 头部缺失 —— 不是 pg_dump 的纯文本产物"
      return 1
    fi
  fi

  return 0
}

# ---------- ②b 上传归档（用户唯一一份资料） ----------
verify_uploads_archive() {
  local archive="$1"
  local entries

  log_info "Verifying uploads archive: $archive"

  if [ ! -r "$archive" ]; then
    log_fail "上传归档不可读: $archive"
    return 1
  fi

  # 加密归档先解成明文（GPG 无法流式校验 tar.gz，必须先解密），再验 gzip + tar 目录。
  local file_to_check
  file_to_check="$(materialize_backup "$archive")" || return 1

  if ! gzip -t "$file_to_check" 2>/dev/null; then
    log_fail "上传归档 gzip 结构损坏: $archive"
    return 1
  fi
  log_pass "Gzip 结构完好"

  entries="$(tar -tzf "$file_to_check" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$entries" -eq 0 ]; then
    log_fail "上传归档里没有任何文件: $archive"
    return 1
  fi
  log_pass "归档可读出 $entries 个条目"

  return 0
}

# 找与该 DB 备份同一时刻产生的上传归档（backup-db.sh 的命名：clipsync_<type>_<ts>.dump
# 对应 clipsync_uploads_<type>_<ts>.tar.gz）。找不到不算失败，但要说清楚。
paired_uploads_archive() {
  local db_backup="$1"
  local base stem rest type ts candidate

  base="$(basename "$db_backup")"
  case "$base" in
    clipsync_*.dump|clipsync_*.dump.gpg|clipsync_*.sql.gz|clipsync_*.sql.gz.gpg) ;;
    *) printf '\n'; return 0 ;;   # 命名不符（或传进来的本来就是上传归档）就不猜
  esac

  stem="${base%.gpg}"
  stem="${stem%.sql.gz}"
  stem="${stem%.dump}"

  # 约定（scripts/backup-db.sh）：
  #   clipsync_<type>_<YYYYmmdd>_<HHMMSS>.dump  ↔  clipsync_uploads_<type>_<YYYYmmdd>_<HHMMSS>.tar.gz
  rest="${stem#clipsync_}"     # <type>_<YYYYmmdd>_<HHMMSS>
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

  printf '\n'
}

# ---------- ③ 真恢复 ----------
verify_restore() {
  local backup_file="$1"
  local file_to_restore format restore_ok=0
  local checks_passed=0
  local checks_total=0
  local restore_log="$VERIFY_DIR/restore.log"

  log_info "Verifying backup by restoring to test database: $TEST_DB_NAME"

  format="$(backup_format "$backup_file")"
  file_to_restore="$(materialize_backup "$backup_file")" || return 1

  mkdir -p "$VERIFY_DIR"

  # 临时库建在 maintenance 库（默认 postgres）上，不要连生产库。
  pg_admin "DROP DATABASE IF EXISTS \"$TEST_DB_NAME\";" >/dev/null 2>&1 || true
  if ! pg_admin "CREATE DATABASE \"$TEST_DB_NAME\";" >/dev/null 2>&1; then
    log_error "临时数据库创建失败（服务 $POSTGRES_SERVICE 是否在运行？）"
    return 1
  fi
  log_pass "临时数据库已创建"

  log_info "Restoring backup to test database..."
  if [ "$format" = "custom" ]; then
    # -Fc ⇒ 必须用 pg_restore（psql 读不懂自定义格式）
    if compose exec -T "$POSTGRES_SERVICE" \
        sh -c 'pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d "$1"' \
        _ "$TEST_DB_NAME" < "$file_to_restore" > "$restore_log" 2>&1; then
      restore_ok=1
    fi
  else
    if zcat "$file_to_restore" | compose exec -T "$POSTGRES_SERVICE" \
        sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"' \
        _ "$TEST_DB_NAME" > "$restore_log" 2>&1; then
      restore_ok=1
    fi
  fi

  if [ "$restore_ok" != "1" ]; then
    log_error "恢复失败 - check $restore_log for details"
    log_error "日志尾部："
    tail -n 5 "$restore_log" 2>/dev/null || true
    pg_admin "DROP DATABASE IF EXISTS \"$TEST_DB_NAME\";" >/dev/null 2>&1 || true
    return 1
  fi
  log_pass "Backup restored successfully"

  log_info "Verifying restored data..."

  # Check 1: Tables exist
  checks_total=$((checks_total + 1))
  local table_count=0
  table_count=$(pg_query "$TEST_DB_NAME" "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d '[:space:]' || echo 0)
  if [ "${table_count:-0}" -ge 5 ] 2>/dev/null; then
    log_pass "Found $table_count tables (expected >=5)"
    checks_passed=$((checks_passed + 1))
  else
    log_fail "Found only ${table_count:-?} tables (expected >=5)"
  fi

  # Check 2: Core tables exist
  checks_total=$((checks_total + 1))
  local core_tables=0
  core_tables=$(pg_query "$TEST_DB_NAME" "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('users', 'devices', 'clipboard_items', 'device_sync_state', 'verification_codes');" 2>/dev/null | grep -c . || echo 0)
  if [ "${core_tables:-0}" -ge 5 ] 2>/dev/null; then
    log_pass "All core tables present"
    checks_passed=$((checks_passed + 1))
  else
    log_fail "Missing core tables (found ${core_tables:-?}/5)"
  fi

  # Check 3: Indexes exist
  checks_total=$((checks_total + 1))
  local index_count=0
  index_count=$(pg_query "$TEST_DB_NAME" "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public';" 2>/dev/null | tr -d '[:space:]' || echo 0)
  if [ "${index_count:-0}" -ge 5 ] 2>/dev/null; then
    log_pass "Found $index_count indexes"
    checks_passed=$((checks_passed + 1))
  else
    log_fail "Insufficient indexes (${index_count:-?})"
  fi

  # Check 4: Data integrity (foreign keys)
  checks_total=$((checks_total + 1))
  local fk_count=0
  fk_count=$(pg_query "$TEST_DB_NAME" "SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public';" 2>/dev/null | tr -d '[:space:]' || echo 0)
  if [ "${fk_count:-0}" -ge 3 ] 2>/dev/null; then
    log_pass "Foreign key constraints present ($fk_count)"
    checks_passed=$((checks_passed + 1))
  else
    log_fail "Missing foreign key constraints (${fk_count:-?})"
  fi

  # Cleanup test database
  log_info "Cleaning up test database..."
  pg_admin "DROP DATABASE IF EXISTS \"$TEST_DB_NAME\";" >/dev/null 2>&1 || true

  echo ""
  echo "=== Verification Summary ==="
  echo "Checks passed: $checks_passed/$checks_total"
  if [ "$checks_passed" -eq "$checks_total" ]; then
    log_pass "All verification checks passed!"
    return 0
  fi
  log_fail "Some verification checks failed"
  return 1
}

# ---------- main ----------
main() {
  local backup_file
  local uploads_archive

  backup_file="$(find_backup "${1:-}")"

  echo "=== ClipSync Backup Verification ==="
  echo "Backup file: $backup_file"
  echo "Postgres   : service $POSTGRES_SERVICE @ $COMPOSE_FILE"
  echo ""

  warn_if_stale "$backup_file"

  # Phase 0: 校验和
  verify_checksum "$backup_file" || {
    log_error "校验和不匹配，后面的检查已无意义"
    exit 1
  }

  # Phase 1: 文件完整性/格式
  if ! verify_file_integrity "$backup_file"; then
    log_error "File integrity check failed - backup is corrupt"
    exit 1
  fi

  # Phase 1b: 上传归档（如果有）
  if [ -n "$UPLOADS_ARCHIVE" ]; then
    uploads_archive="$UPLOADS_ARCHIVE"
  else
    uploads_archive="$(paired_uploads_archive "$backup_file")"
  fi
  if [ -n "$uploads_archive" ]; then
    if ! verify_uploads_archive "$uploads_archive"; then
      log_error "上传归档校验失败"
      exit 1
    fi
  else
    log_warn "没有找到与本次 DB 备份配对的上传归档（clipsync_uploads_*.tar.gz）"
    log_warn "用户上传的文件不在数据库里，只有 DB 备份的话救不回这部分资料 —— 请确认 backup-db.sh 正常跑过"
  fi

  # Phase 2: 真恢复
  if ! verify_restore "$backup_file"; then
    log_error "Restore verification failed - backup cannot be reliably restored"
    exit 1
  fi

  echo ""
  log_pass "Backup verification completed successfully!"
  log_info "Backup file $backup_file is valid and can be restored"
}

main "$@"
