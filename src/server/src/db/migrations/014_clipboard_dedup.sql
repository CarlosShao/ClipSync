-- C2 修复：剪贴板去重支持
-- 1) 新增 content_hash 列：非文件类型保存 sha256(密文)，文件类型为空（文件用路径去重）
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);

-- 2) 非文件类型去重查找索引（非唯一，允许 5 分钟后重新复制相同内容；唯一约束会永久阻断重复复制，故不用）
CREATE INDEX IF NOT EXISTS idx_clipboard_user_content_hash
  ON clipboard_items (user_id, content_hash)
  WHERE content_type <> 'file';
