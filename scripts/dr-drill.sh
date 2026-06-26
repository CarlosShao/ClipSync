#!/bin/bash
# ClipSync Disaster Recovery Drill Script
# Usage: ./scripts/dr-drill.sh [level1|level2|level3]
# Simulates disaster scenarios and verifies recovery procedures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[DR-INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[DR-WARN]${NC} $1"; }
log_error() { echo -e "${RED}[DR-ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[DR-STEP]${NC} $1"; }

DRILL_LEVEL="${1:-level1}"
DRILL_LOG="$PROJECT_DIR/backups/dr-drill-$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$PROJECT_DIR/backups"

# Log all output
exec > >(tee "$DRILL_LOG") 2>&1

echo "=============================================="
echo "  ClipSync Disaster Recovery Drill"
echo "  Level: $DRILL_LEVEL"
echo "  Time: $(date)"
echo "=============================================="

# Health check helper
check_health() {
  local max_retries=10
  local delay=5
  for i in $(seq 1 $max_retries); do
    local status=$(curl -s http://localhost:3000/api/health 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unreachable'))" 2>/dev/null || echo "unreachable")
    if [ "$status" = "healthy" ]; then
      log_info "Health check passed (attempt $i)"
      return 0
    fi
    log_warn "Health check: $status (attempt $i/$max_retries, waiting $delay s)"
    sleep $delay
  done
  log_error "Health check failed after $max_retries attempts"
  return 1
}

# Record start time for RTO measurement
START_TIME=$(date +%s)

# === Level 1 Drill: Single Service Failure ===
drill_level1() {
  log_step "=== Level 1 Drill: Single service container failure ==="

  # 1. Verify initial health
  log_step "1. Verify initial system health"
  check_health

  # 2. Simulate API container crash
  log_step "2. Stopping API container to simulate crash"
  cd "$PROJECT_DIR"
  docker-compose stop api || true

  # 3. Wait for auto-restart (if configured) or manual restart
  log_step "3. Waiting for recovery (auto-restart or manual)"
  sleep 5

  # Check if auto-restart happened
  local api_status=$(docker-compose ps api 2>/dev/null | grep -c "Up" || echo 0)
  if [ "$api_status" -eq 0 ]; then
    log_info "Auto-restart did not trigger, manually restarting..."
    docker-compose up -d api
  fi

  # 4. Verify recovery
  log_step "4. Verifying recovery"
  if check_health; then
    local end_time=$(date +%s)
    local rto=$((end_time - START_TIME))
    log_info "Level 1 drill PASSED - RTO: ${rto}s (target: <900s)"
  else
    log_error "Level 1 drill FAILED - service did not recover"
  fi
}

# === Level 2 Drill: Database Failure ===
drill_level2() {
  log_step "=== Level 2 Drill: Database failure with data recovery ==="

  # 1. Create fresh backup before drill
  log_step "1. Creating pre-drill backup"
  cd "$PROJECT_DIR"
  ./scripts/backup-db.sh manual

  # 2. Verify initial health
  log_step "2. Verify initial system health"
  check_health

  # 3. Simulate database failure
  log_step "3. Stopping PostgreSQL container to simulate DB failure"
  docker-compose stop postgres

  # Verify service degradation
  log_step "4. Verify service is degraded"
  local health=$(curl -s http://localhost:3000/api/health 2>/dev/null || echo 'unreachable')
  if echo "$health" | grep -q "degraded"; then
    log_info "Service correctly reports degraded status"
  else
    log_warn "Service status: $(echo "$health" | head -c 100)"
  fi

  # 4. Restore database
  log_step "5. Restarting PostgreSQL and restoring from backup"
  docker-compose up -d postgres

  log_info "Waiting for PostgreSQL to be ready..."
  sleep 10

  # Find and restore latest backup
  local latest_backup=$(ls -t "$PROJECT_DIR/backups"/clipsync_manual_*.sql.gz 2>/dev/null | head -1)
  if [ -n "$latest_backup" ]; then
    log_info "Restoring from: $latest_backup"
    gunzip -c "$latest_backup" | docker exec -i clipsync-postgres psql -U postgres clipsync 2>/dev/null || {
      log_warn "Restore had errors (may be expected for existing tables)"
    }
  else
    log_warn "No backup file found, running migrations instead"
    cd "$PROJECT_DIR/src/server"
    node src/db/migrate.js
  fi

  # 5. Restart all services
  log_step "6. Restarting all services"
  cd "$PROJECT_DIR"
  docker-compose up -d

  # 6. Verify recovery
  log_step "7. Verifying full recovery"
  if check_health; then
    local end_time=$(date +%s)
    local rto=$((end_time - START_TIME))
    log_info "Level 2 drill PASSED - RTO: ${rto}s (target: <3600s)"
  else
    log_error "Level 2 drill FAILED - service did not fully recover"
  fi
}

# === Level 3 Drill: Full System Recovery ===
drill_level3() {
  log_step "=== Level 3 Drill: Full system rebuild ==="

  # 1. Create backup before drill
  log_step "1. Creating backup before full shutdown"
  cd "$PROJECT_DIR"
  ./scripts/backup-db.sh manual

  # 2. Full system shutdown
  log_step "2. Full system shutdown (simulating total failure)"
  docker-compose down

  log_info "System completely shut down"
  sleep 5

  # 3. Full system rebuild
  log_step "3. Rebuilding entire system from scratch"
  docker-compose up -d

  log_info "Waiting for all services to initialize..."
  sleep 15

  # 4. Database migration
  log_step "4. Running database migrations"
  cd "$PROJECT_DIR/src/server"
  node src/db/migrate.js 2>/dev/null || {
    log_warn "Migrations may have partial errors (expected on fresh DB)"
  }

  # 5. Data restore
  log_step "5. Restoring data from backup"
  local latest_backup=$(ls -t "$PROJECT_DIR/backups"/clipsync_manual_*.sql.gz 2>/dev/null | head -1)
  if [ -n "$latest_backup" ]; then
    gunzip -c "$latest_backup" | docker exec -i clipsync-postgres psql -U postgres clipsync 2>/dev/null || {
      log_warn "Restore had errors"
    }
  fi

  # 6. Verify full recovery
  log_step "6. Verifying full system recovery"
  if check_health; then
    local end_time=$(date +%s)
    local rto=$((end_time - START_TIME))
    log_info "Level 3 drill PASSED - RTO: ${rto}s (target: <14400s)"
  else
    log_error "Level 3 drill FAILED - system did not recover"
  fi
}

# Execute drill
case "$DRILL_LEVEL" in
  level1) drill_level1 ;;
  level2) drill_level2 ;;
  level3) drill_level3 ;;
  *) log_error "Unknown drill level: $DRILL_LEVEL (use level1, level2, or level3)"; exit 1 ;;
esac

echo ""
echo "=============================================="
echo "  Drill completed. Log saved to: $DRILL_LOG"
echo "=============================================="
