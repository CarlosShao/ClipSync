-- 023: clipboard_items 使用统计字段
-- 用途：支撑「智能建议 / 预测粘贴」——记录每条剪贴板被用户选中粘贴的次数与最近使用时间，
--       后端按「使用次数 × 时间衰减」加权排序，预测下一个最可能粘贴的内容。
--       随账号持久化、跨设备累积（符合 ClipSync 跨设备同步基因）。

ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS usage_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_clipboard_items_usage ON clipboard_items(user_id, usage_count DESC, last_used_at DESC);

INSERT INTO schema_migrations (version, applied_at) VALUES ('023', NOW())
  ON CONFLICT (version) DO NOTHING;
