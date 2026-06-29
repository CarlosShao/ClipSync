import pool from './pool.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

const migrations = [
  // 1. Users table
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) UNIQUE NOT NULL,
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

// Post-migration: add tsvector column and trigger if not exists
const postMigrations = [
  // Add search_vector column to clipboard_items (safe for existing tables)
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clipboard_items' AND column_name = 'search_vector') THEN
      ALTER TABLE clipboard_items ADD COLUMN search_vector tsvector;
    END IF;
  END$$`,

  // Create trigger function to auto-update search_vector from content_preview
  `CREATE OR REPLACE FUNCTION clipsync_update_search_vector() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.content_type, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(NEW.content_preview, '')), 'B');
    RETURN NEW;
  END
  $$ LANGUAGE plpgsql`,

  // Create GIN index (must be after column and trigger are created)
  `CREATE INDEX IF NOT EXISTS idx_clipboard_search ON clipboard_items USING GIN(search_vector)`,
];

async function migrate() {
  logger.info('Running database migrations...');
  const client = await pool.connect();
  try {
    // 创建 schema_migrations 表（如果不存在）
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // 执行内嵌迁移
    for (let i = 0; i < migrations.length; i++) {
      logger.info(`  Migration ${i + 1}/${migrations.length}...`);
      await client.query(migrations[i]);
    }

    // 执行 migrations/ 目录中的 SQL 文件
    const migrationsDir = path.resolve('./src/db/migrations');
    
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort(); // 按文件名排序（004, 005, 006...）
      
      for (const file of files) {
        const version = file.split('_')[0]; // 提取版本号（如 "004"）
        
        // 检查是否已执行
        const result = await client.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [version]
        );
        
        if (result.rows.length === 0) {
          logger.info(`  SQL Migration ${file}...`);
          const sql = fs.readFileSync(`${migrationsDir}/${file}`, 'utf8');
          
          // 执行 SQL（可能包含多个语句）
          await client.query(sql);
          
          // 记录已执行
          await client.query(
            'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING',
            [version]
          );
          
          logger.info(`    ✓ ${file} applied successfully`);
        } else {
          logger.info(`  SQL Migration ${file} (skipped, already applied)`);
        }
      }
    }

    // 执行后迁移
    logger.info('Running post-migrations (tsvector)...');
    for (let i = 0; i < postMigrations.length; i++) {
      logger.info(`  Post-migration ${i + 1}/${postMigrations.length}...`);
      await client.query(postMigrations[i]);
    }

    logger.info('All migrations completed successfully.');
  } finally {
    client.release();
  }
}

// Run directly
if (process.argv[1] && process.argv[1].includes('migrate')) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Migration failed:', { error: err.message });
      process.exit(1);
    });
}

export default migrate;
