-- ClipSync 数据库初始化脚本
-- 创建于 2026-06-24

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 用户表（如果需要）
-- CREATE TABLE IF NOT EXISTS users (
--     id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
--     phone VARCHAR(20) UNIQUE,
--     created_at TIMESTAMP DEFAULT NOW(),
--     updated_at TIMESTAMP DEFAULT NOW()
-- );

-- 设备表
CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id VARCHAR(255) UNIQUE NOT NULL,
    device_name VARCHAR(255),
    platform VARCHAR(50),
    user_id UUID,
    last_active TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 剪贴板表
CREATE TABLE IF NOT EXISTS clipboard_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    device_id UUID REFERENCES devices(id),
    content_type VARCHAR(50) DEFAULT 'text/plain',
    content_encrypted TEXT,
    content_preview TEXT,
    content_size INTEGER DEFAULT 0,
    content_diff TEXT,
    diff_version INTEGER DEFAULT 1,
    metadata JSONB,
    is_favorite BOOLEAN DEFAULT FALSE,
    favorited_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_clipboard_user ON clipboard_items(user_id);
CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clipboard_diff ON clipboard_items(id) WHERE content_diff IS NOT NULL;

-- 收藏夹/集合表
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

-- 收藏夹与剪贴板项的关联表（多对多）
CREATE TABLE IF NOT EXISTS favorite_collection_items (
    collection_id UUID NOT NULL REFERENCES favorite_collections(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    added_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (collection_id, item_id)
);

-- 设备同步状态表
CREATE TABLE IF NOT EXISTS device_sync_state (
    device_id UUID REFERENCES devices(id),
    last_sync_at TIMESTAMP DEFAULT NOW(),
    last_item_id UUID,
    PRIMARY KEY (device_id)
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

