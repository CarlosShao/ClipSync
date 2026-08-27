-- 040: B2 整改 —— 高级保护条目清空明文预览与 OCR 文本
--
-- 背景：protection_level='advanced' 的条目正文由 DEK 双重加密保护（读取需密码/恢复密钥），
-- 但历史上 content_preview / ocr_text 里残留明文副本，会经 list / search / AI 工具泄露原文。
-- 应用侧已在设置 advanced 保护时同步清空（protection.js /setup 与 aiTools.js set_item_protection），
-- 本迁移对存量数据一次性回填。
--
-- 幂等性：条件更新，重复执行时第二次为空操作（可安全重复执行）。

UPDATE clipboard_items
SET content_preview = '',
    ocr_text = NULL,
    updated_at = NOW()
WHERE protection_level = 'advanced'
  AND (COALESCE(content_preview, '') <> '' OR ocr_text IS NOT NULL);
