import pool from './pool.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

const migrations = [
  // 1. Users table (complete schema with all fields required by auth/subscription routes)
  `CREATE TABLE IF NOT EXISTS users (
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

  // 6. User sessions table (auth login requires)
  `CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name VARCHAR(100) DEFAULT 'Unknown Device',
    device_type VARCHAR(20) DEFAULT 'browser',
    platform VARCHAR(20) DEFAULT 'unknown',
    ip_address VARCHAR(45),
    user_agent TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    revoked_at TIMESTAMP WITH TIME ZONE
  )`,

  // 7. Subscription plans table (subscriptionCheck middleware requires)
  `CREATE TABLE IF NOT EXISTS subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    price_monthly DECIMAL(10,2),
    price_yearly DECIMAL(10,2),
    max_devices INTEGER DEFAULT 2,
    max_clipboard_items INTEGER DEFAULT 50,
    max_file_size_mb INTEGER DEFAULT 1,
    max_storage_mb INTEGER DEFAULT 100,
    features JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // 8. User subscriptions table (subscriptionCheck middleware requires)
  `CREATE TABLE IF NOT EXISTS user_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','canceled','past_due','expired')),
    billing_cycle VARCHAR(10) DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
    current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    start_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    end_date TIMESTAMP WITH TIME ZONE,
    stripe_subscription_id VARCHAR(255),
    alipay_agreement_id VARCHAR(255),
    wechat_pay_prepay_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
  `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON user_sessions(user_id, is_active) WHERE is_active = TRUE`,
  // User lookup indexes (O(1) dedup + login)
  `CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_hash) WHERE phone_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash) WHERE email_hash IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL AND email != ''`,
  // Identity merge: track merged-into canonical user id
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES users(id) ON DELETE SET NULL`,
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
      setweight(to_tsvector('simple', coalesce(NEW.content_preview, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(NEW.ocr_text, '')), 'C');
    RETURN NEW;
  END
  $$ LANGUAGE plpgsql`,

  // Create GIN index (must be after column and trigger are created)
  `CREATE INDEX IF NOT EXISTS idx_clipboard_search ON clipboard_items USING GIN(search_vector)`,

  // Seed subscription plans if empty
  `INSERT INTO subscription_plans (name, display_name, description, price_monthly, price_yearly, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features)
   VALUES
    ('Free', '免费版', '基础剪贴板同步功能', 0, 0, 2, 50, 1, 100,
     '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":false,"full_text_search":false,"version_history_days":3}'),
    ('Pro', '专业版', '完整功能解锁', 9.9, 99, 10, 500, 10, 1024,
     '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":true,"full_text_search":true,"version_history_days":30}')
   ON CONFLICT (name) DO NOTHING`,

  // Archive feature: add archived flag (idempotent, additive column)
  `ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE INDEX IF NOT EXISTS idx_clipboard_items_archived ON clipboard_items(archived, created_at DESC)`,

  // E2E 兼容迁移（B11①）：给存量/新落的明文条目补 e2eLegacy 标记（只加标记，不改内容）。
  // 判定口径与协议 §2 一致：metadata.e2e 不存在即为明文条目。重复执行幂等（已标记行被 WHERE 排除），
  // 且服务端每次启动自愈一次——迁移之后由非加密客户端继续写入的明文条目也会被补上标记。
  `UPDATE clipboard_items
   SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{e2eLegacy}', 'true'::jsonb, true)
   WHERE NOT COALESCE(metadata ? 'e2e', false)
     AND NOT COALESCE((metadata->>'e2eLegacy')::boolean, false)`,
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

      // 护栏：数字前缀撞号只告警不 throw——幂等键已是完整文件名，撞号不再互相遮蔽，
      // throw 会让服务起不来。
      const byPrefix = new Map();
      for (const f of files) {
        const p = f.split('_')[0];
        if (!byPrefix.has(p)) byPrefix.set(p, []);
        byPrefix.get(p).push(f);
      }
      for (const [prefix, group] of byPrefix) {
        if (group.length > 1) {
          logger.error(
            `Duplicate migration version prefix "${prefix}": ${group.join(', ')}. ` +
            `Both files will run; rename one to a free number to keep ordering explicit.`
          );
        }
      }

      // 一次性回填：幂等键从「三位数字前缀」改为「完整文件名」后，历史库里的旧式数字记录
      // 会让全部已执行迁移被误判为未执行而重跑（部分文件不保证幂等）。
      const legacy = await client.query(
        `SELECT version FROM schema_migrations WHERE version NOT LIKE '%.sql' ORDER BY version`
      );
      let backfilled = 0;
      for (const row of legacy.rows) {
        const oldVersion = row.version;
        // 兼容两种历史自登记写法：数字前缀（'012'）与去掉 .sql 的文件名（012_schema_completion.sql
        // 自登记成 '012_schema_completion'）。filter 天然去重，同一文件不会被计两次。
        const matches = files.filter(
          f => f.split('_')[0] === oldVersion || f === `${oldVersion}.sql`
        );
        if (matches.length === 1) {
          await client.query(
            'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING',
            [matches[0]]
          );
          await client.query('DELETE FROM schema_migrations WHERE version = $1', [oldVersion]);
          backfilled++;
        } else if (matches.length > 1) {
          // 撞号文件一个都不回填：它们的 SQL 均为 IF NOT EXISTS，重跑安全，
          // 借此治愈「老库因撞号被跳过而缺列」的问题。
          const pending = [];
          for (const m of matches) {
            const r = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [m]);
            if (r.rows.length === 0) pending.push(m);
          }
          if (pending.length > 0) {
            logger.warn(
              `Legacy migration record "${oldVersion}" maps to ${matches.length} files; not backfilled. ` +
              `These will run to heal columns skipped by the old numeric key: ${pending.join(', ')}`
            );
          } else {
            // 撞号文件均已按文件名登记，旧数字记录不再参与任何判断，清掉避免每次启动误告警
            await client.query('DELETE FROM schema_migrations WHERE version = $1', [oldVersion]);
            logger.info(`Dropped stale legacy record "${oldVersion}"; all ${matches.length} colliding files are registered by filename.`);
          }
        } else {
          logger.warn(`Legacy migration record "${oldVersion}" matches no file in ${migrationsDir}; left untouched.`);
        }
      }
      if (backfilled > 0) {
        logger.info(`Backfilled ${backfilled} legacy numeric migration record(s) to filename keys.`);
      }

      for (const file of files) {
        const version = file; // 幂等键 = 完整文件名（数字前缀会撞号，如两个 031 互相遮蔽）
        
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
