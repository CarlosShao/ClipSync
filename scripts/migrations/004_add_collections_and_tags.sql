-- Migration 004: Add favorite_collections and favorite_collection_items tables
-- Run: psql -U clipsync -d clipsync -f scripts/migrations/004_add_collections_and_tags.sql

CREATE TABLE IF NOT EXISTS favorite_collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    icon VARCHAR(10) DEFAULT '📁',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_favcol_user ON favorite_collections(user_id);

CREATE TABLE IF NOT EXISTS favorite_collection_items (
    collection_id UUID NOT NULL REFERENCES favorite_collections(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    added_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (collection_id, item_id)
);
