-- Migration 010: Unified Protection Level System
-- Adds support for three protection levels:
-- Level 0: No protection
-- Level 1: PIN protection (temporary access, auto-relock)
-- Level 2: Advanced encryption (DEK dual encryption + recovery key)

-- Add protection_level enum type
DO $$ BEGIN
  CREATE TYPE protection_level AS ENUM ('none', 'pin', 'advanced');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add new columns to clipboard_items
ALTER TABLE clipboard_items 
  ADD COLUMN IF NOT EXISTS protection_level protection_level DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS wrapped_dek_password TEXT,  -- DEK encrypted with user password (PBKDF2)
  ADD COLUMN IF NOT EXISTS wrapped_dek_recovery TEXT,  -- DEK encrypted with recovery key (PBKDF2)
  ADD COLUMN IF NOT EXISTS recovery_key_hash TEXT,     -- SHA-256 hash of recovery key for verification
  ADD COLUMN IF NOT EXISTS protection_salt TEXT,       -- Salt for password-based key derivation
  ADD COLUMN IF NOT EXISTS protection_iv TEXT;         -- IV for DEK encryption

-- Add indexes for protection queries
CREATE INDEX IF NOT EXISTS idx_clipboard_items_protection ON clipboard_items(protection_level);

-- Create recovery_keys table for managing recovery keys
CREATE TABLE IF NOT EXISTS recovery_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
  recovery_key_hash TEXT NOT NULL,  -- SHA-256 hash of recovery key
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  used_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(user_id, item_id)
);

-- Add RLS policies for recovery_keys
ALTER TABLE recovery_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY recovery_keys_user_isolation ON recovery_keys
  USING (user_id = auth.uid());

-- Add comments for documentation
COMMENT ON COLUMN clipboard_items.protection_level IS 'Protection level: none=0, pin=1, advanced=2';
COMMENT ON COLUMN clipboard_items.wrapped_dek_password IS 'Data Encryption Key wrapped with user password (PBKDF2)';
COMMENT ON COLUMN clipboard_items.wrapped_dek_recovery IS 'Data Encryption Key wrapped with recovery key (PBKDF2)';
COMMENT ON COLUMN clipboard_items.recovery_key_hash IS 'SHA-256 hash of recovery key for verification';
COMMENT ON COLUMN clipboard_items.protection_salt IS 'Salt for password-based key derivation';
COMMENT ON COLUMN clipboard_items.protection_iv IS 'IV for DEK encryption';
