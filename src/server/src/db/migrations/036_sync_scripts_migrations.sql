-- =============================================
-- 036_sync_scripts_migrations.sql
-- 同步 scripts/migrations/ 下的历史基线迁移（003/004/005/010/011），
-- 使全新实例/测试库与 dev 库的 schema 一致。
-- 背景：favorited_at、favorite_collections、ltree 层级、protection_* 统一保护体系
--       原先只由 scripts/migrations/*.sql 在 dev 侧执行，未纳入 src/server 迁移链，
--       导致全新/CI/测试环境缺列。本文件全部幂等（CREATE/ADD 均 IF NOT EXISTS）。
-- 注：010 中依赖 auth.uid() 的 recovery_keys RLS 策略段为 Supabase 产物，
--     本项目走应用层 user_id 隔离（无 RLS），故不复制该段。
-- =============================================

-- ---- 003: favorited_at ----
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS favorited_at TIMESTAMP;
UPDATE clipboard_items SET favorited_at = created_at WHERE is_favorite = TRUE AND favorited_at IS NULL;

-- ---- 004: favorite_collections / favorite_collection_items ----
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

-- ---- 005: ltree 层级 ----
CREATE EXTENSION IF NOT EXISTS ltree;
ALTER TABLE favorite_collections ADD COLUMN IF NOT EXISTS path ltree;
CREATE INDEX IF NOT EXISTS idx_favcol_path ON favorite_collections USING GIST(path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fci_unique_item ON favorite_collection_items(item_id);
UPDATE favorite_collections SET path = CONCAT('root.', replace(id::text, '-', '_'))::ltree WHERE path IS NULL;
ALTER TABLE favorite_collections ALTER COLUMN path SET NOT NULL;

-- ---- 010: 统一保护等级（none/pin/advanced）+ DEK 字段 ----
DO $$ BEGIN
  CREATE TYPE protection_level AS ENUM ('none', 'pin', 'advanced');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
ALTER TABLE clipboard_items
  ADD COLUMN IF NOT EXISTS protection_level protection_level DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS wrapped_dek_password TEXT,
  ADD COLUMN IF NOT EXISTS wrapped_dek_recovery TEXT,
  ADD COLUMN IF NOT EXISTS recovery_key_hash TEXT,
  ADD COLUMN IF NOT EXISTS protection_salt TEXT,
  ADD COLUMN IF NOT EXISTS protection_iv TEXT;
CREATE INDEX IF NOT EXISTS idx_clipboard_items_protection ON clipboard_items(protection_level);
CREATE TABLE IF NOT EXISTS recovery_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
  recovery_key_hash TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  used_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(user_id, item_id)
);

-- ---- 011: 迁移状态字段 ----
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS protection_migration_status TEXT DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_clipboard_items_migration_status ON clipboard_items(protection_migration_status);
UPDATE clipboard_items
SET protection_level = 'advanced', protection_migration_status = 'migrated'
WHERE metadata->>'protected' = 'true' AND protection_level = 'none';