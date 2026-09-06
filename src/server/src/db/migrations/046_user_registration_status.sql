-- =============================================
-- 046: 用户注册状态（signup_waitlist 功能开关的真实落地）
-- 范围：
--   users.registration_status VARCHAR(20) NOT NULL DEFAULT 'approved'
--     - 'approved'：正常（存量用户与普通注册，缺省即此值）
--     - 'waitlist'：待审核——signup_waitlist 开关开启期间注册的用户，
--       登录被拦截（提示待管理员审核），管理员审批后置回 'approved'
-- 依赖：users 表（001）。
-- 幂等：ADD COLUMN IF NOT EXISTS，可重复执行。
-- =============================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_status VARCHAR(20) NOT NULL DEFAULT 'approved';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_registration_status_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_registration_status_check
      CHECK (registration_status IN ('approved', 'waitlist'));
  END IF;
END $$;

INSERT INTO schema_migrations (version, applied_at) VALUES ('046', NOW())
  ON CONFLICT (version) DO NOTHING;
