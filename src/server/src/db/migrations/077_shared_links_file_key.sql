-- =============================================
-- 077: shared_links.file_key 列（S0 止血：分享链接路径穿越）
-- 背景：创建分享链接时 fileKey 直接来自请求体且无格式校验，../../../ 形式可让
--       落盘目录指向 uploads/shared 之外；撤销链接时又对 file_path 做
--       path.dirname + fs.rm(recursive)，被投毒的 file_path 可递归删除任意目录。
--       修复后：fileKey 强制 UUID 校验 + realpath 边界校验，撤销删除不再用
--       path.dirname(file_path) 反推，而是用本列记录的、已校验的 fileKey 重新拼目录。
-- 回填：file_path 形如 <base>/<uuid>/<file> 的历史行可安全提取 <uuid>；
--       提取不到（含被投毒的穿越路径）的行保持 NULL，代码侧对其跳过文件删除。
-- 幂等：ADD COLUMN IF NOT EXISTS + WHERE file_key IS NULL；可重复执行。
-- 版本登记：不在此文件内写 schema_migrations，由 migrate.js 以完整文件名为幂等键自动登记。
-- =============================================

ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS file_key TEXT;

UPDATE shared_links
SET file_key = (regexp_match(replace(file_path, '\', '/'), '/([^/]+)/[^/]+$'))[1]
WHERE file_path IS NOT NULL
  AND file_key IS NULL
  AND (regexp_match(replace(file_path, '\', '/'), '/([^/]+)/[^/]+$'))[1]
      ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
