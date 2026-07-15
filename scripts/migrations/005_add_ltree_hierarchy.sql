-- Migration 005: Add ltree hierarchy support to favorite_collections
-- Run: psql -U clipsync -d clipsync -f scripts/migrations/005_add_ltree_hierarchy.sql

-- Enable ltree extension (idempotent)
CREATE EXTENSION IF NOT EXISTS ltree;

-- Add path column for tree hierarchy (ltree stores dot-separated labels)
-- ltree labels cannot contain hyphens, so UUIDs are sanitized: abc123-def456 → abc123_def456
ALTER TABLE favorite_collections ADD COLUMN IF NOT EXISTS path ltree;

-- GIST index for fast subtree queries: path <@ '/root/abc123' finds all descendants
CREATE INDEX IF NOT EXISTS idx_favcol_path ON favorite_collections USING GIST(path);

-- Unique index: an item can belong to exactly one collection across the entire tree
CREATE UNIQUE INDEX IF NOT EXISTS idx_fci_unique_item ON favorite_collection_items(item_id);

-- Backfill existing collections as root nodes: path = root.<sanitized_id>
UPDATE favorite_collections
SET path = 'root.' || replace(id::text, '-', '_')::ltree
WHERE path IS NULL;

-- Enforce NOT NULL after backfill
ALTER TABLE favorite_collections ALTER COLUMN path SET NOT NULL;
