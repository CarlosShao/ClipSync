-- Migration 011: Migrate existing password protection to new unified system
-- This migration identifies items with password protection and marks them for migration
-- The actual re-encryption happens client-side when users interact with these items

-- Add migration status column
ALTER TABLE clipboard_items 
  ADD COLUMN IF NOT EXISTS protection_migration_status TEXT DEFAULT 'pending';

-- Create index for migration queries
CREATE INDEX IF NOT EXISTS idx_clipboard_items_migration_status 
  ON clipboard_items(protection_migration_status);

-- Update existing password-protected items to use new protection level
UPDATE clipboard_items 
SET protection_level = 'advanced',
    protection_migration_status = 'migrated'
WHERE metadata->>'protected' = 'true'
  AND protection_level = 'none';

-- Log migration count
DO $$
DECLARE
  migration_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO migration_count 
  FROM clipboard_items 
  WHERE protection_migration_status = 'migrated';
  
  RAISE NOTICE 'Migrated % password-protected items to new protection system', migration_count;
END $$;
