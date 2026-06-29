-- 008_audit_logs.sql
-- 审计日志表（P1-4: 安全审计日志）

-- 创建审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,          -- 操作类型（login, logout, export_data, delete_account, etc.）
  resource_type VARCHAR(50),            -- 资源类型（user, clipboard, file, etc.）
  resource_id UUID,                     -- 资源ID
  details JSONB,                       -- 操作详情（键值对）
  ip_address INET,                     -- 请求IP地址
  user_agent TEXT,                     -- 用户代理
  status VARCHAR(20) NOT NULL DEFAULT 'success',  -- 状态（success, failure, error）
  error_message TEXT,                  -- 错误信息
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ip_address ON audit_logs(ip_address);

-- 自动清理旧审计日志（保留1年）
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM audit_logs 
  WHERE created_at < NOW() - INTERVAL '1 year';
END;
$$ LANGUAGE plpgsql;

-- 评论：审计日志表用于记录敏感操作，支持安全审计和合规要求
-- 日志保留1年，超过1年的自动清理
