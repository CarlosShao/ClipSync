-- #225 图片内容哈希：支持图片跨复制去重 + AI 发送重复图片时提示「已存在于历史」
-- 必须基于明文图片字节（密文 content_encrypted 因随机 IV 导致同图不同哈希，无法用于图片去重）

ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS image_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_clipboard_user_image_hash
  ON clipboard_items (user_id, image_hash)
  WHERE image_hash IS NOT NULL;
