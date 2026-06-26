-- Phase 9.3 通知偏好 - 数据库迁移
-- 执行日期：2026-06-26

-- 9.3.1 用户通知偏好表（已存在，验证结构）
-- 实际表结构：id, user_id, notification_type, enabled, created_at, updated_at
-- 如果缺少字段则补充

ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'pending'));
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 9.3.2 通知历史表
CREATE TABLE IF NOT EXISTS notification_history (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  content TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'pending')),
  sent_at TIMESTAMP,
  read_at TIMESTAMP,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_history_user_id ON notification_history(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_history_status ON notification_history(status);

-- 插入默认通知偏好（如不存在）
INSERT INTO notification_preferences (user_id, notification_type, enabled)
SELECT 
  id as user_id,
  unnest(ARRAY['sync_complete', 'device_online', 'subscription_expiring', 'security_alert']::VARCHAR(50)[]) as notification_type,
  true as enabled
FROM users
ON CONFLICT (user_id, notification_type) DO NOTHING;

-- 更新 schema 版本
INSERT INTO schema_migrations (version, applied_at) 
VALUES ('005', NOW())
ON CONFLICT (version) DO NOTHING;
