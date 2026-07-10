-- P6 修复：通知历史保留
-- 1) 确保 notification_history 表存在（部分环境 005 迁移可能未建表）
CREATE TABLE IF NOT EXISTS notification_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,
  title TEXT,
  body TEXT,
  data JSONB DEFAULT '{}',
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2) 保留索引，供定时清理按 created_at 快速定位并删除
CREATE INDEX IF NOT EXISTS idx_notification_history_created_at ON notification_history (created_at);
