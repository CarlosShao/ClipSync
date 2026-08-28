-- 041: 删除墓碑（deletion tombstones）
-- 背景：DELETE 为硬删且无流水，其他设备（尤其断线重连后）永远无法感知"条目已被删"，
--       增量同步只覆盖新增（created_at 游标），删除侧是一致性黑洞。
-- 方案：AFTER DELETE 触发器为每条被删除的剪贴板条目自动写入墓碑，
--       覆盖所有删除路径（单删 / 批删 / AI 批删 / 过期自动清理 / 注销清空），零遗漏。
-- 消费：GET /api/clipboard/sync-deletions?since=<ISO> 返回 since 之后的墓碑流水；
--       前端 WS 重连注册成功后拉取，并从本地列表移除对应条目。
-- 保留期：墓碑由 cleanup scheduler 定期清理（默认 30 天，见 db/cleanup.js）。

CREATE TABLE IF NOT EXISTS clipboard_deletions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clipboard_deletions_user_time
  ON clipboard_deletions (user_id, deleted_at);

CREATE OR REPLACE FUNCTION fn_clipboard_deletion_tombstone()
RETURNS trigger AS $$
BEGIN
  INSERT INTO clipboard_deletions (user_id, item_id)
  VALUES (OLD.user_id, OLD.id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clipboard_deletion_tombstone ON clipboard_items;
CREATE TRIGGER trg_clipboard_deletion_tombstone
  AFTER DELETE ON clipboard_items
  FOR EACH ROW EXECUTE FUNCTION fn_clipboard_deletion_tombstone();
