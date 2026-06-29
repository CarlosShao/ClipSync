#!/bin/bash
# ClipSync Database Backup Script
# Usage: ./scripts/backup-db.sh [daily|weekly|manual]
# Environment variables:
#   BACKUP_ENCRYPTION_KEY - GPG key ID or passphrase for encryption (optional)
#   BACKUP_RETENTION_DAYS - days to keep daily backups (default: 30)
#   BACKUP_RETENTION_WEEKS - weeks to keep weekly backups (default: 12)

set -e

BACKUP_TYPE="${1:-manual}"
BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/clipsync_${BACKUP_TYPE}_${TIMESTAMP}.sql.gz"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
ENCRYPTED_FILE="${BACKUP_FILE}.gpg"

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting $BACKUP_TYPE backup..."

# Backup PostgreSQL
docker exec clipsync-postgres pg_dump -U clipsync clipsync | gzip > "$BACKUP_FILE"

# Generate SHA256 checksum
sha256sum "$BACKUP_FILE" > "$CHECKSUM_FILE"
echo "[$(date)] Checksum generated: $CHECKSUM_FILE"

# Encrypt backup if encryption key is provided
if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "[$(date)] Encrypting backup..."
  gpg --batch --yes --passphrase "$BACKUP_ENCRYPTION_KEY" \
    --symmetric --cipher-algo AES256 \
    -o "$ENCRYPTED_FILE" "$BACKUP_FILE" 2>/dev/null || {
    echo "[$(date)] WARNING: GPG encryption failed, keeping unencrypted backup"
    rm -f "$ENCRYPTED_FILE" 2>/dev/null || true
  }
  if [ -f "$ENCRYPTED_FILE" ]; then
    # Re-generate checksum for encrypted file
    sha256sum "$ENCRYPTED_FILE" > "${ENCRYPTED_FILE}.sha256"
    # Remove unencrypted file
    rm -f "$BACKUP_FILE" "$CHECKSUM_FILE"
    BACKUP_FILE="$ENCRYPTED_FILE"
    CHECKSUM_FILE="${ENCRYPTED_FILE}.sha256"
    echo "[$(date)] Backup encrypted: $ENCRYPTED_FILE"
  fi
else
  echo "[$(date)] WARNING: No BACKUP_ENCRYPTION_KEY set, backup is unencrypted"
  echo "[$(date)] Set BACKUP_ENCRYPTION_KEY environment variable to enable encryption"
fi

# Get file size
FILESIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date)] Backup completed: $BACKUP_FILE ($FILESIZE)"

# Cleanup old backups (keep last 30 daily, 12 weekly)
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
RETENTION_WEEKS="${BACKUP_RETENTION_WEEKS:-12}"

if [ "$BACKUP_TYPE" = "daily" ]; then
  find "$BACKUP_DIR" -name "clipsync_daily_*.sql.gz*" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
  echo "[$(date)] Cleaned up daily backups older than $RETENTION_DAYS days"
elif [ "$BACKUP_TYPE" = "weekly" ]; then
  find "$BACKUP_DIR" -name "clipsync_weekly_*.sql.gz*" -mtime +$((RETENTION_WEEKS * 7)) -delete 2>/dev/null || true
  echo "[$(date)] Cleaned up weekly backups older than $RETENTION_WEEKS weeks"
fi

# List current backups
echo ""
echo "Current backups:"
ls -lh "$BACKUP_DIR"/clipsync_*.sql.gz* 2>/dev/null || echo "No backups found"

# Verify the backup immediately after creation
echo ""
echo "[$(date)] Running post-backup verification..."
"$(dirname "$0")/verify-backup.sh" "$BACKUP_FILE"
