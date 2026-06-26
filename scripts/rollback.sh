#!/bin/bash
# ClipSync Rollback Script
# Usage: ./rollback.sh [version-tag]
# If no version tag specified, rolls back to the previous version

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_DIR="$PROJECT_DIR/deploy"
BACKUP_DIR="$PROJECT_DIR/backups"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Get current version
get_current_version() {
  if [ -f "$DEPLOY_DIR/current-version" ]; then
    cat "$DEPLOY_DIR/current-version"
  else
    log_warn "No current-version file found"
    echo "unknown"
  fi
}

# Get target version for rollback
get_target_version() {
  local target="$1"
  if [ -z "$target" ]; then
    # Find previous version from backup list
    local current=$(get_current_version)
    local backups=($(ls -t "$BACKUP_DIR"/*.version 2>/dev/null || true))
    if [ ${#backups[@]} -eq 0 ]; then
      log_error "No backup versions found for rollback"
      exit 1
    fi
    # Find version before current
    for backup in "${backups[@]}"; do
      local version=$(cat "$backup")
      if [ "$version" != "$current" ]; then
        echo "$version"
        return
      fi
    done
    log_error "No previous version found"
    exit 1
  else
    echo "$target"
  fi
}

# Pre-rollback health check
pre_rollback_check() {
  log_info "Performing pre-rollback health check..."
  local health=$(curl -s http://localhost:3000/api/health 2>/dev/null || echo '{"status":"unreachable"}')
  local status=$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")
  log_info "Current health status: $status"

  if [ "$status" = "unreachable" ]; then
    log_warn "Service is unreachable - proceeding with rollback"
  fi
}

# Rollback Docker containers
rollback_docker() {
  local target_version="$1"
  log_info "Rolling back Docker containers to version: $target_version"

  # Stop current containers gracefully
  log_info "Stopping current containers..."
  cd "$PROJECT_DIR"
  docker-compose down --timeout 30 || true

  # Switch to target version config
  if [ -f "$BACKUP_DIR/docker-compose-$target_version.yml" ]; then
    log_info "Using backup docker-compose config for version $target_version"
    cp "$BACKUP_DIR/docker-compose-$target_version.yml" docker-compose.yml
  fi

  # Start containers with target version
  log_info "Starting containers with version $target_version..."
  docker-compose up -d

  # Wait for services to be healthy
  log_info "Waiting for services to stabilize..."
  sleep 10

  # Verify health
  local retries=5
  while [ $retries -gt 0 ]; do
    local health=$(curl -s http://localhost:3000/api/health 2>/dev/null || echo 'unreachable')
    if echo "$health" | grep -q "healthy"; then
      log_info "Service is healthy after rollback"
      return 0
    fi
    retries=$((retries - 1))
    log_warn "Service not healthy yet, waiting... ($retries retries left)"
    sleep 5
  done

  log_error "Service did not become healthy after rollback"
  return 1
}

# Rollback database
rollback_database() {
  local target_version="$1"
  log_info "Rolling back database to version: $target_version"

  # Check for database backup
  local db_backup="$BACKUP_DIR/db-$target_version.sql"
  if [ ! -f "$db_backup" ]; then
    log_warn "No database backup found for version $target_version, skipping DB rollback"
    return 0
  fi

  # Create safety backup of current state before rollback
  log_info "Creating safety backup of current database state..."
  local current_version=$(get_current_version)
  docker exec clipsync-postgres pg_dump -U postgres clipsync > "$BACKUP_DIR/db-pre-rollback-$current_version.sql"

  # Restore target version database
  log_info "Restoring database from backup: $db_backup"
  docker exec -i clipsync-postgres psql -U postgres clipsync < "$db_backup"

  log_info "Database rollback completed"
}

# Update version marker
update_version_marker() {
  local target_version="$1"
  mkdir -p "$DEPLOY_DIR"
  echo "$target_version" > "$DEPLOY_DIR/current-version"
  log_info "Updated version marker to: $target_version"
}

# Main rollback procedure
main() {
  local target_version_arg="${1:-}"
  log_info "=== ClipSync Rollback Starting ==="

  local current_version=$(get_current_version)
  local target_version=$(get_target_version "$target_version_arg")

  log_info "Current version: $current_version"
  log_info "Target version: $target_version"

  if [ "$current_version" = "$target_version" ]; then
    log_error "Target version is same as current version. No rollback needed."
    exit 0
  fi

  # Pre-rollback check
  pre_rollback_check

  # Rollback database first (data is most critical)
  rollback_database "$target_version"

  # Rollback Docker containers
  rollback_docker "$target_version"

  # Update version marker
  update_version_marker "$target_version"

  log_info "=== Rollback Completed Successfully ==="
  log_info "Rolled back from $current_version to $target_version"
}

main "$@"
