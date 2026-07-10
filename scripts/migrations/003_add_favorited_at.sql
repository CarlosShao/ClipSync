-- Migration 003: Add favorited_at column to clipboard_items
-- Records when an item was favorited (for sorting by favorite time)
-- Run: psql -U clipsync -d clipsync -f scripts/migrations/003_add_favorited_at.sql

ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS favorited_at TIMESTAMP;

-- Backfill existing favorites with created_at as a reasonable default
UPDATE clipboard_items SET favorited_at = created_at WHERE is_favorite = TRUE AND favorited_at IS NULL;
