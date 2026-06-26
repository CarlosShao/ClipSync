import pool from './pool.js';

async function resetDatabase() {
  console.log('⚠️  警告：这将删除所有数据！');
  console.log('开始重置数据库...');
  
  const client = await pool.connect();
  try {
    // 删除所有表（按依赖顺序）
    console.log('删除现有表...');
    await client.query('DROP TABLE IF EXISTS file_versions CASCADE');
    await client.query('DROP TABLE IF EXISTS device_sync_state CASCADE');
    await client.query('DROP TABLE IF EXISTS clipboard_items CASCADE');
    await client.query('DROP TABLE IF EXISTS devices CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    await client.query('DROP TABLE IF EXISTS verification_codes CASCADE');
    
    // 删除触发器（如果存在）
    await client.query('DROP FUNCTION IF EXISTS clipsync_update_search_vector() CASCADE');
    
    console.log('✅ 所有表已删除');
    console.log('');
    
    // 重新运行迁移
    console.log('开始重新创建表...');
    
    const migrations = [
      // 1. Users table
      `CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE,
        nickname VARCHAR(100) DEFAULT '',
        avatar_url TEXT DEFAULT '',
        password_hash VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,

      // 2. Devices table
      `CREATE TABLE IF NOT EXISTS devices (
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
      )`,

      // 3. Clipboard items table
      `CREATE TABLE IF NOT EXISTS clipboard_items (
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
      )`,

      // 4. Device sync state table
      `CREATE TABLE IF NOT EXISTS device_sync_state (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id UUID UNIQUE NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        last_synced_item_id UUID,
        last_sync_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,

      // 5. Verification codes table
      `CREATE TABLE IF NOT EXISTS verification_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        code VARCHAR(10) NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,

      // 6. File versions table
      `CREATE TABLE IF NOT EXISTS file_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        clipboard_item_id UUID NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL DEFAULT 1,
        content_encrypted TEXT NOT NULL,
        content_preview TEXT DEFAULT '',
        content_size INTEGER DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        source_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
        change_description TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(clipboard_item_id, version_number)
      )`,

      // 7. Indexes
      `CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(is_online) WHERE is_online = TRUE`,
      `CREATE INDEX IF NOT EXISTS idx_clipboard_items_user_id ON clipboard_items(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_clipboard_items_created_at ON clipboard_items(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_clipboard_items_content_type ON clipboard_items(content_type)`,
      `CREATE INDEX IF NOT EXISTS idx_clipboard_items_favorites ON clipboard_items(is_favorite) WHERE is_favorite = TRUE`,
      `CREATE INDEX IF NOT EXISTS idx_verification_codes_phone ON verification_codes(phone, used) WHERE used = FALSE`,
      `CREATE INDEX IF NOT EXISTS idx_file_versions_item ON file_versions(clipboard_item_id, version_number)`,
      `CREATE INDEX IF NOT EXISTS idx_file_versions_user ON file_versions(user_id)`,
    ];

    for (let i = 0; i < migrations.length; i++) {
      console.log(`  迁移 ${i + 1}/${migrations.length}...`);
      await client.query(migrations[i]);
    }
    
    console.log('');
    console.log('✅ 所有表创建成功');
    console.log('');
    
    // 添加全文搜索支持
    console.log('添加全文搜索支持...');
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clipboard_items' AND column_name = 'search_vector') THEN
          ALTER TABLE clipboard_items ADD COLUMN search_vector tsvector;
        END IF;
      END$$`
    );
    
    await client.query(`
      CREATE OR REPLACE FUNCTION clipsync_update_search_vector() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('simple', coalesce(NEW.content_type, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(NEW.content_preview, '')), 'B');
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`
    );
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_clipboard_search ON clipboard_items USING GIN(search_vector)`);
    
    console.log('✅ 全文搜索支持已添加');
    console.log('');
    console.log('🎉 数据库重置完成！');
    
  } catch (err) {
    console.error('❌ 重置失败:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

resetDatabase().catch((err) => {
  console.error(err);
  process.exit(1);
});
