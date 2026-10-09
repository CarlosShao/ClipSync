-- 090：第三方登录的占位手机号放不进 users.phone（VARCHAR(20)）
--
-- 背景（2026-10-09 生产实测）：迁移 089 的 resolveOrCreateUser 在"全新账号"分支用
--   phone = 'oauth:<provider>:<providerUserId>'
-- 作占位值（users.phone 是 NOT NULL UNIQUE，而第三方没有手机号）。但：
--   · Microsoft（Entra object id）是 36 位 GUID ⇒ 'oauth:microsoft:' + 36 = 52 字符
--   · GitHub 的用户 id 是数字（可到 10 位）⇒ 'oauth:github:' + 10 = 23 字符
-- 两者都超过 VARCHAR(20)，INSERT 直接报 "value too long for type character varying(20)"，
-- 表现为「浏览器授权成功 → 桌面端提示『关联账号失败，请改用手机号登录』」。
--
-- 处置：把 phone 放宽到 64（Postgres 加宽 varchar 是元数据操作，不重写表）。
-- 不改占位值格式：可读性对排查有价值（能一眼看出是哪个平台哪个 ID），且唯一性由 providerUserId 保证。
-- 既有的「按已验证邮箱并入老账号」分支不受影响；真实手机号永远只有 11 位，放宽不改变任何校验语义。

ALTER TABLE users ALTER COLUMN phone TYPE VARCHAR(64);

INSERT INTO schema_migrations (version, applied_at) VALUES ('090_oauth_placeholder_phone_width.sql', NOW())
  ON CONFLICT (version) DO NOTHING;
