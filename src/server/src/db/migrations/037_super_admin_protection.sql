-- =============================================
-- 037: 超管唯一性保护触发器
-- 范围：在 users 表的 INSERT / UPDATE OF role_id / DELETE 时，
--       通过触发器函数保护「role_key='super_admin'」角色的唯一性：
--        - 不允许出现第二个超管（INSERT 时已存在一个超管则拒绝；
--          UPDATE 时排除自身 id 外仍存在超管则拒绝）。
--        - 不允许删除超管用户。
--       roles 表中不存在 super_admin 角色时函数直接放行（COALESCE(NEW, OLD)）。
-- 幂等：函数用 CREATE OR REPLACE；触发器先 DROP 再 CREATE。
-- =============================================

CREATE OR REPLACE FUNCTION protect_super_admin_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_super_role UUID;
BEGIN
  -- 查询 super_admin 角色的 role_id；无该角色则放行（INSERT/UPDATE 用 NEW，DELETE 用 OLD）
  SELECT id INTO v_super_role FROM roles WHERE role_key = 'super_admin';
  IF v_super_role IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- DELETE：不允许删除超管用户
  IF TG_OP = 'DELETE' THEN
    IF OLD.role_id IS NOT DISTINCT FROM v_super_role THEN
      RAISE EXCEPTION 'SUPER_ADMIN_DELETE_FORBIDDEN';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT / UPDATE OF role_id：INSERT 时 NEW 尚未入库，检查任一已存在的超管即冲突；
  -- UPDATE 时需排除自身 id，避免把「未改变超管身份」的 UPDATE 误判为重复超管。
  IF NEW.role_id IS NOT DISTINCT FROM v_super_role THEN
    IF EXISTS (
      SELECT 1 FROM users
      WHERE role_id = v_super_role
        AND (TG_OP = 'INSERT' OR id IS DISTINCT FROM NEW.id)
    ) THEN
      RAISE EXCEPTION 'SUPER_ADMIN_EXISTS_ALREADY';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 触发器：BEFORE INSERT OR UPDATE OF role_id OR DELETE
DROP TRIGGER IF EXISTS trg_protect_super_admin ON users;
CREATE TRIGGER trg_protect_super_admin
BEFORE INSERT OR UPDATE OF role_id OR DELETE ON users
FOR EACH ROW
EXECUTE FUNCTION protect_super_admin_row();

-- 迁移登记
INSERT INTO schema_migrations (version, applied_at) VALUES ('037', NOW())
  ON CONFLICT (version) DO NOTHING;