#!/bin/bash
# ClipSync Database Backup Script
# Usage: ./scripts/backup-db.sh [daily|weekly|manual]

set -e

BACKUP_TYPE="${1:-manual}"
BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/clipsync_${BACKUP_TYPE}_${TIMESTAMP}.sql.gz"

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting $BACKUP_TYPE backup..."

# Backup PostgreSQL
docker exec clipsync-postgres pg_dump -U clipsync clipsync | gzip > "$BACKUP_FILE"

# Get file size
FILESIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date)] Backup completed: $BACKUP_FILE ($FILESIZE)"

# Cleanup old backups (keep last 30 daily, 12 weekly)
if [ "$BACKUP_TYPE" = "daily" ]; then
  find "$BACKUP_DIR" -name "clipsync_daily_*.sql.gz" -mtime +30 -delete
  echo "[$(date)] Cleaned up daily backups older than 30 days"
elif [ "$BACKUP_TYPE" = "weekly" ]; then
  find "$BACKUP_DIR" -name "clipsync_weekly_*.sql.gz" -mtime +84 -delete
  echo "[$(date)] Cleaned up weekly backups older than 12 weeks"
fi

# List current backups
echo ""
echo "Current backups:"
ls -lh "$BACKUP_DIR"/*.sql.gz 2>/dev/null || echo "No backups found"
