#!/bin/bash
# ClipSync Backup Verification Script
# Usage: ./scripts/verify-backup.sh [backup-file]
# If no file specified, verifies the most recent backup

set -euo pipefail

BACKUP_DIR="./backups"
VERIFY_DIR="./backups/verify-test"
TEST_DB_NAME="clipsync_verify_test"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; }

# Find backup file
find_backup() {
  local specified="$1"
  if [ -n "$specified" ] && [ -f "$specified" ]; then
    echo "$specified"
    return
  fi

  # Find most recent backup
  local latest=$(ls -t "$BACKUP_DIR"/clipsync_*.sql.gz 2>/dev/null | head -1)
  if [ -z "$latest" ]; then
    log_error "No backup files found in $BACKUP_DIR"
    exit 1
  fi
  echo "$latest"
}

# Verify backup file integrity
verify_file_integrity() {
  local backup_file="$1"
  log_info "Verifying file integrity of: $backup_file"

  # Check file exists and is readable
  if [ ! -r "$backup_file" ]; then
    log_fail "Backup file is not readable"
    return 1
  fi
  log_pass "File is readable"

  # Check file size is reasonable (>1KB)
  local filesize=$(stat -f%z "$backup_file" 2>/dev/null || stat -c%s "$backup_file" 2>/dev/null || echo 0)
  if [ "$filesize" -lt 1024 ]; then
    log_fail "Backup file is too small ($filesize bytes), likely empty or corrupt"
    return 1
  fi
  log_pass "File size is reasonable ($filesize bytes)"

  # Verify gzip integrity
  log_info "Testing gzip decompression..."
  if gzip -t "$backup_file" 2>/dev/null; then
    log_pass "Gzip file is intact"
  else
    log_fail "Gzip file is corrupt - cannot decompress"
    return 1
  fi

  # Verify SQL content structure
  log_info "Checking SQL content structure..."
  local sql_content=$(zcat "$backup_file" | head -20)
  if echo "$sql_content" | grep -q "PostgreSQL database dump"; then
    log_pass "SQL dump header found"
  else
    log_fail "SQL dump header not found - invalid backup format"
    return 1
  fi

  return 0
}

# Verify backup by restoring to test database
verify_restore() {
  local backup_file="$1"
  log_info "Verifying backup by restoring to test database: $TEST_DB_NAME"

  # Create test database
  log_info "Creating test database..."
  docker exec clipsync-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $TEST_DB_NAME;" 2>/dev/null || true
  docker exec clipsync-postgres psql -U postgres -c "CREATE DATABASE $TEST_DB_NAME;" || {
    log_error "Failed to create test database"
    return 1
  }

  # Restore backup to test database
  log_info "Restoring backup to test database..."
  zcat "$backup_file" | docker exec -i clipsync-postgres psql -U postgres "$TEST_DB_NAME" > "$VERIFY_DIR/restore.log" 2>&1 || {
    log_error "Restore failed - check $VERIFY_DIR/restore.log for details"
    docker exec clipsync-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $TEST_DB_NAME;" 2>/dev/null || true
    return 1
  }
  log_pass "Backup restored successfully"

  # Verify restored data
  log_info "Verifying restored data..."

  local checks_passed=0
  local checks_total=0

  # Check 1: Tables exist
  checks_total=$((checks_total + 1))
  local tables=$(docker exec clipsync-postgres psql -U postgres "$TEST_DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")
  local table_count=$(echo "$tables" | tr -d ' ')
  if [ "$table_count" -ge 5 ]; then
    log_pass "Found $table_count tables (expected >=5)"
    checks_passed=$((checks_passed + 1))
  else
    log_fail "Found only $table_count tables (expected >=5)"
  fi

  # Check 2: Core tables exist
  checks_total=$((checks_total + 1))
  local core_tables=$(docker exec clipsync-postgres psql -U postgres "$TEST_DB_NAME" -t -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('users', 'devices', 'clipboard_items', 'device_sync_state', 'verification_codes');" | tr -d ' ' | wc -l)
  if [ "$core_tables" -ge 5 ]; then
    log_pass "All core tables present"
    checks_passed=$((checks_passed + 1))
  else
    log_fail "Missing core tables (found $core_tables/5)"
  fi

  # Check 3: Indexes exist
  checks_total=$((checks_total + 1))
  local indexes=$(docker exec clipsync-postgres psql -U postgres "$TEST_DB_NAME" -t -c "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public';")
  local index_count=$(echo "$indexes" | tr -d ' ')
  if [ "$index_count" -ge 5 ]; then
    log_pass "Found $index_count indexes"
    checks_passed=$((checks_passed + 1))
  else
    log_fail "Insufficient indexes ($index_count)"
  fi

  # Check 4: Data integrity (foreign keys)
  checks_total=$((checks_total + 1))
  local fk_check=$(docker exec clipsync-postgres psql -U postgres "$TEST_DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public';")
  local fk_count=$(echo "$fk_check" | tr -d ' ')
  if [ "$fk_count" -ge 3 ]; then
    log_pass "Foreign key constraints present ($fk_count)"
    checks_passed=$((checks_passed + 1))
  else
    log_fail "Missing foreign key constraints ($fk_count)"
  fi

  # Cleanup test database
  log_info "Cleaning up test database..."
  docker exec clipsync-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $TEST_DB_NAME;" 2>/dev/null || true

  # Summary
  echo ""
  echo "=== Verification Summary ==="
  echo "Checks passed: $checks_passed/$checks_total"
  if [ "$checks_passed" -eq "$checks_total" ]; then
    log_pass "All verification checks passed!"
    return 0
  else
    log_fail "Some verification checks failed"
    return 1
  fi
}

# Main
main() {
  local backup_file=$(find_backup "${1:-}")

  echo "=== ClipSync Backup Verification ==="
  echo "Backup file: $backup_file"
  echo ""

  mkdir -p "$VERIFY_DIR"

  # Phase 1: File integrity
  if ! verify_file_integrity "$backup_file"; then
    log_error "File integrity check failed - backup is corrupt"
    exit 1
  fi

  # Phase 2: Restore verification
  if ! verify_restore "$backup_file"; then
    log_error "Restore verification failed - backup cannot be reliably restored"
    exit 1
  fi

  echo ""
  log_pass "Backup verification completed successfully!"
  log_info "Backup file $backup_file is valid and can be restored"
}

main "$@"
