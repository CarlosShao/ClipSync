import pool from './pool.js';
import { logger } from '../utils/logger.js';

/**
 * ClipSync Database Migration Manager
 * Handles schema version upgrades and data migrations
 */

const SCHEMA_VERSIONS = [
  {
    version: 1,
    description: 'Initial schema - users, devices, clipboard_items, device_sync_state, verification_codes',
    migrations: [], // Initial schema is created by migrate.js
  },
  {
    version: 2,
    description: 'Add updated_at column to clipboard_items, add file_versions table',
    migrations: [
      'ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()',
      // file_versions already in migrate.js, but this handles existing deployments
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
    ],
  },
  {
    version: 3,
    description: 'Add browser device_type support, add search_vector for full-text search',
    migrations: [
      // Update devices CHECK constraint to include 'browser'
      `ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_device_type_check`,
      `ALTER TABLE devices ADD CONSTRAINT devices_device_type_check CHECK (device_type IN ('desktop', 'mobile', 'tablet', 'browser'))`,
      `ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_platform_check`,
      `ALTER TABLE devices ADD CONSTRAINT devices_platform_check CHECK (platform IN ('windows', 'macos', 'linux', 'ios', 'android', 'browser'))`,
      // Add search_vector tsvector column
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clipboard_items' AND column_name = 'search_vector') THEN
          ALTER TABLE clipboard_items ADD COLUMN search_vector tsvector;
        END IF;
      END $$`,
      // Create trigger for auto-updating search_vector
      `CREATE OR REPLACE FUNCTION clipsync_update_search_vector() RETURNS trigger AS $$ BEGIN
        NEW.search_vector := setweight(to_tsvector('simple', coalesce(NEW.content_type, '')), 'A') || setweight(to_tsvector('simple', coalesce(NEW.content_preview, '')), 'B');
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS clipsync_search_vector_update ON clipboard_items`,
      `CREATE TRIGGER clipsync_search_vector_update BEFORE INSERT OR UPDATE OF content_preview, content_type ON clipboard_items FOR EACH ROW EXECUTE FUNCTION clipsync_update_search_vector()`,
      // GIN index for search_vector
      `CREATE INDEX IF NOT EXISTS idx_clipboard_search ON clipboard_items USING GIN(search_vector)`,
    ],
  },
  {
    version: 4,
    description: 'Add content_diff column for incremental sync',
    migrations: [
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clipboard_items' AND column_name = 'content_diff') THEN
          ALTER TABLE clipboard_items ADD COLUMN content_diff TEXT DEFAULT NULL;
        END IF;
      END $$`,
    ],
  },
    {
    version: 5,
    description: 'Add payment & subscription tables (subscription_plans, user_subscriptions, payment_orders, invoices) + extend users table',
    migrations: [
      // Extend users table
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'subscription_status') THEN
          ALTER TABLE users ADD COLUMN subscription_status VARCHAR(20) DEFAULT 'free';
        END IF;
      END $$`,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'current_subscription_id') THEN
          ALTER TABLE users ADD COLUMN current_subscription_id UUID;
        END IF;
      END $$`,

      // Create subscription_plans table
      `CREATE TABLE IF NOT EXISTS subscription_plans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(50) NOT NULL,
        price DECIMAL(10,2) NOT NULL DEFAULT 0,
        currency VARCHAR(10) DEFAULT 'CNY',
        billing_cycle VARCHAR(20) DEFAULT 'monthly',
        max_devices INTEGER DEFAULT 2,
        max_clipboard_items INTEGER DEFAULT 50,
        max_file_size_mb INTEGER DEFAULT 1,
        max_storage_mb INTEGER DEFAULT 100,
        features JSONB DEFAULT '{}',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,

      // Create user_subscriptions table
      `CREATE TABLE IF NOT EXISTS user_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id UUID NOT NULL REFERENCES subscription_plans(id),
        status VARCHAR(20) DEFAULT 'active',
        current_period_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        current_period_end TIMESTAMP WITH TIME ZONE,
        cancel_at_period_end BOOLEAN DEFAULT false,
        trial_end TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,

      // Create payment_orders table
      `CREATE TABLE IF NOT EXISTS payment_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL,
        order_no VARCHAR(100) UNIQUE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'CNY',
        payment_method VARCHAR(50),
        status VARCHAR(20) DEFAULT 'pending',
        paid_at TIMESTAMP WITH TIME ZONE,
        transaction_id VARCHAR(200),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,

      // Create invoices table
      `CREATE TABLE IF NOT EXISTS invoices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        order_id UUID REFERENCES payment_orders(id) ON DELETE SET NULL,
        invoice_no VARCHAR(100) UNIQUE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        tax DECIMAL(10,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'draft',
        invoice_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,

      // Add foreign key for users.current_subscription_id
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'users_current_subscription_id_fkey') THEN
          ALTER TABLE users ADD CONSTRAINT users_current_subscription_id_fkey 
            FOREIGN KEY (current_subscription_id) REFERENCES user_subscriptions(id) ON DELETE SET NULL;
        END IF;
      END $$`,

      // Insert default subscription plans
      `INSERT INTO subscription_plans (name, price, currency, billing_cycle, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features)
       SELECT 'Free', 0, 'CNY', 'monthly', 2, 50, 1, 100, '{"ai_classify": true, "offline_queue": true, "e2e_encryption": true, "push_notification": false, "full_text_search": false, "version_history_days": 3}'::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name = 'Free')`,
      
      `INSERT INTO subscription_plans (name, price, currency, billing_cycle, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features)
       SELECT 'Pro', 9.9, 'CNY', 'monthly', 5, 999999, 20, 5120, '{"ai_classify": true, "offline_queue": true, "e2e_encryption": true, "push_notification": true, "full_text_search": true, "version_history_days": 30}'::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name = 'Pro')`,
      
      `INSERT INTO subscription_plans (name, price, currency, billing_cycle, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features)
       SELECT 'Enterprise', 29.9, 'CNY', 'monthly', 999999, 999999, 100, 51200, '{"ai_classify": true, "offline_queue": true, "e2e_encryption": true, "push_notification": true, "full_text_search": true, "version_history_days": 999999, "team_sharing": true}'::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name = 'Enterprise')`,

      // Create indexes
      `CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status)`,
      `CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payment_orders_order_no ON payment_orders(order_no)`,
      `CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no ON invoices(invoice_no)`
    ],
  },
  {
    version: 6,
    description: 'Add encryption fields for sensitive data (phone, email, payment tokens)',
    migrations: [
      // Add encrypted fields to users table
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'phone_encrypted') THEN
          ALTER TABLE users ADD COLUMN phone_encrypted TEXT DEFAULT NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email_encrypted') THEN
          ALTER TABLE users ADD COLUMN email_encrypted TEXT DEFAULT NULL;
        END IF;
      END $$`,

      // Add encrypted fields to payment_orders table
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_orders' AND column_name = 'payment_token_encrypted') THEN
          ALTER TABLE payment_orders ADD COLUMN payment_token_encrypted TEXT DEFAULT NULL;
        END IF;
      END $$`,

      // Add encrypted fields to user_subscriptions table
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_subscriptions' AND column_name = 'subscription_token_encrypted') THEN
          ALTER TABLE user_subscriptions ADD COLUMN subscription_token_encrypted TEXT DEFAULT NULL;
        END IF;
      END $$`,

      // Create encryption_keys table for key management
      `CREATE TABLE IF NOT EXISTS encryption_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key_name VARCHAR(100) NOT NULL UNIQUE,
        key_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        algorithm VARCHAR(50) DEFAULT 'AES-256-GCM',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,

      // Create index for encryption_keys
      `CREATE INDEX IF NOT EXISTS idx_encryption_keys_active ON encryption_keys(is_active)`,
    ],
  },
  {
    version: 7,
    description: 'Add user_sessions table for session management',
    migrations: [
      // Create user_sessions table
      `CREATE TABLE IF NOT EXISTS user_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
        session_token_hash TEXT NOT NULL,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        is_active BOOLEAN DEFAULT true
      )`,
      
      // Create index for user_sessions
      `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_user_sessions_is_active ON user_sessions(is_active)`,
    ],
  },
];

// Create schema_versions tracking table if not exists
async function ensureVersionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
}

// Get current schema version
async function getCurrentVersion() {
  const result = await pool.query('SELECT MAX(version) as version FROM schema_versions');
  return result.rows[0]?.version || 0;
}

// Mark a version as applied
async function markVersionApplied(version, description) {
  await pool.query(
    'INSERT INTO schema_versions (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
    [version, description]
  );
}

// Run migrations from current version to target version
async function runMigrations(targetVersion = null) {
  await ensureVersionTable();
  const currentVersion = await getCurrentVersion();
  const maxVersion = SCHEMA_VERSIONS[SCHEMA_VERSIONS.length - 1].version;
  const target = targetVersion || maxVersion;

  logger.info('Migration manager starting', { currentVersion, targetVersion: target });

  if (currentVersion >= target) {
    logger.info('No migrations needed', { currentVersion, targetVersion: target });
    return { applied: 0, currentVersion };
  }

  let applied = 0;
  const client = await pool.connect();

  try {
    for (const schemaVersion of SCHEMA_VERSIONS) {
      if (schemaVersion.version <= currentVersion) continue;
      if (schemaVersion.version > target) break;

      logger.info(`Applying schema version ${schemaVersion.version}: ${schemaVersion.description}`);

      for (const migration of schemaVersion.migrations) {
        try {
          await client.query(migration);
          logger.info(`  Migration applied: ${migration.substring(0, 80)}...`);
        } catch (err) {
          logger.error(`  Migration failed: ${err.message}`, { migration: migration.substring(0, 100) });
          // Rollback this version's migrations
          throw new Error(`Schema version ${schemaVersion.version} migration failed: ${err.message}`);
        }
      }

      await markVersionApplied(schemaVersion.version, schemaVersion.description);
      applied++;
      logger.info(`Schema version ${schemaVersion.version} applied successfully`);
    }
  } catch (err) {
    logger.error('Migration failed, rolling back', { error: err.message });
    // Re-apply previous version marker
    throw err;
  } finally {
    client.release();
  }

  logger.info('All migrations completed', { applied, newVersion: await getCurrentVersion() });
  return { applied, currentVersion: await getCurrentVersion() };
}

// Backfill search_vector for existing rows
async function backfillSearchVector() {
  logger.info('Backfilling search_vector for existing clipboard items...');
  const result = await pool.query(`
    UPDATE clipboard_items
    SET search_vector = setweight(to_tsvector('simple', coalesce(content_type, '')), 'A') ||
                        setweight(to_tsvector('simple', coalesce(content_preview, '')), 'B')
    WHERE search_vector IS NULL
  `);
  logger.info(`Backfill completed: ${result.rowCount} rows updated`);
  return result.rowCount;
}

// Export migration manager
export { runMigrations, getCurrentVersion, backfillSearchVector, SCHEMA_VERSIONS };

// Run directly from command line
if (process.argv[1] && process.argv[1].includes('migrate-manager')) {
  const command = process.argv[2] || 'migrate';

  switch (command) {
    case 'migrate':
      runMigrations()
        .then(result => {
          logger.info(`Migrations applied: ${result.applied}, current version: ${result.currentVersion}`);
          // Backfill search_vector if needed
          return backfillSearchVector();
        })
        .then(count => {
          logger.info(`Search vector backfill: ${count} rows`);
          process.exit(0);
        })
        .catch(err => {
          logger.error('Migration failed:', { error: err.message });
          process.exit(1);
        });
      break;

    case 'status':
      ensureVersionTable()
        .then(() => getCurrentVersion())
        .then(version => {
          logger.info(`Current schema version: ${version}`);
          logger.info(`Available versions: ${SCHEMA_VERSIONS.map(v => `${v.version}: ${v.description}`).join('\n')}`);
          process.exit(0);
        })
        .catch(err => {
          logger.error('Status check failed:', { error: err.message });
          process.exit(1);
        });
      break;

    case 'backfill':
      backfillSearchVector()
        .then(count => {
          logger.info(`Backfill completed: ${count} rows updated`);
          process.exit(0);
        })
        .catch(err => {
          logger.error('Backfill failed:', { error: err.message });
          process.exit(1);
        });
      break;

    default:
      logger.info('Usage: node migrate-manager.js [migrate|status|backfill]');
      process.exit(0);
  }
}
