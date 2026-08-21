-- ClipSync 数据库初始化脚本
-- 作为 migrate.js 的 baseline，与 src/server/src/db/migrate.js 中内嵌的初始 schema 保持一致
-- 创建于 2026-06-24

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "ltree";

-- 1. Users table (complete schema with all fields required by auth/subscription routes)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(255),
  nickname VARCHAR(100) DEFAULT '',
  avatar_url TEXT DEFAULT '',
  password_hash VARCHAR(255),
  phone_encrypted TEXT,
  email_encrypted TEXT,
  phone_hash VARCHAR(128),
  email_hash VARCHAR(128),
  tos_accepted_at TIMESTAMPTZ,
  privacy_accepted_at TIMESTAMPTZ,
  marketing_consent BOOLEAN DEFAULT FALSE,
  birth_date DATE,
  age_verified BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  deactivated_at TIMESTAMPTZ,
  deactivation_reason TEXT,
  analytics_consent BOOLEAN,
  functional_consent BOOLEAN,
  consent_updated_at TIMESTAMPTZ,
  subscription_status VARCHAR(20) DEFAULT 'free',
  current_subscription_id UUID,
  is_admin BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Devices table
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100) NOT NULL,
  device_type VARCHAR(20) NOT NULL CHECK (device_type IN ('desktop', 'mobile', 'tablet', 'browser')),
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('windows', 'macos', 'linux', 'ios', 'android', 'browser')),
  platform_version VARCHAR(50) DEFAULT '',
  app_version VARCHAR(20) DEFAULT '0.1.0',
  public_key TEXT,
  is_online BOOLEAN DEFAULT FALSE,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, device_name)
);

-- 3. Clipboard items table
CREATE TABLE IF NOT EXISTS clipboard_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('text', 'image', 'file', 'link', 'code')),
  content_encrypted TEXT NOT NULL,
  content_preview TEXT DEFAULT '',
  content_size INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  is_favorite BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Device sync state table
CREATE TABLE IF NOT EXISTS device_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID UNIQUE NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  last_synced_item_id UUID,
  last_sync_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Verification codes table
CREATE TABLE IF NOT EXISTS verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) NOT NULL,
  code VARCHAR(10) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 收藏夹/集合表（UI/历史功能依赖，不在 migrate.js baseline 中，在这里保留）
CREATE TABLE IF NOT EXISTS favorite_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  icon VARCHAR(10) DEFAULT '📁',
  sort_order INTEGER DEFAULT 0,
  path ltree NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_favcol_user ON favorite_collections(user_id);
CREATE INDEX IF NOT EXISTS idx_favcol_path ON favorite_collections USING GIST(path);

-- 收藏夹与剪贴板项的关联表（多对多）
CREATE TABLE IF NOT EXISTS favorite_collection_items (
  collection_id UUID NOT NULL REFERENCES favorite_collections(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (collection_id, item_id)
);

-- 创建全文搜索向量
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_clipboard_search ON clipboard_items USING GIN(search_vector);

-- 创建更新向量触发器
CREATE OR REPLACE FUNCTION update_search_vector() RETURNS trigger AS $$
BEGIN
    NEW.search_vector = to_tsvector('english', COALESCE(NEW.content_preview, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_search_vector ON clipboard_items;
CREATE TRIGGER trigger_update_search_vector
    BEFORE INSERT OR UPDATE ON clipboard_items
    FOR EACH ROW EXECUTE FUNCTION update_search_vector();
