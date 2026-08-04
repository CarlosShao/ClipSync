-- 033_workflow_rules.sql - 工作流规则引擎（任务 #237）
-- 「当…时自动…」：满足条件自动执行动作（收藏/归档/打标签/移入收藏夹）
CREATE TABLE IF NOT EXISTS workflow_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- 触发条件
  content_type VARCHAR(10) NOT NULL DEFAULT 'text', -- text|image|file|link|code
  match_mode VARCHAR(12) NOT NULL DEFAULT 'keyword', -- keyword|regex
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,       -- 关键词列表（或正则列表）
  -- 动作
  action_type VARCHAR(12) NOT NULL DEFAULT 'favorite', -- favorite|archive|tag|move_to_collection
  action_value VARCHAR(100) DEFAULT NULL,             -- tag 时存标签名；move_to_collection 时存收藏夹名
  action_apply_tags JSONB DEFAULT NULL,               -- tag 动作可一次打多个标签
  priority INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引：按用户+启用的规则
CREATE INDEX IF NOT EXISTS idx_workflow_rules_user ON workflow_rules (user_id, enabled);
