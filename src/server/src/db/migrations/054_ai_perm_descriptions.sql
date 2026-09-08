-- =============================================
-- 054: AI 能力键描述充实（RB-11 后续打磨）
-- 背景：角色权限页的权限说明取自 permissions.description（028 的 AI 键描述
--       过于简略，用户反馈"描述不全"），此处逐键写清能力边界与影响面。
-- 幂等：可重复执行（UPDATE 天然幂等）。
-- 依赖：028(permissions) / 053(ai.manage_*)。
-- =============================================

UPDATE permissions SET description = 'AI 可执行用户管理：新增账号、删除账号、修改角色、停用账号、重置密码（含明文临时密码下发）、升降级订阅——作用于任意用户' WHERE perm_key = 'ai.manage_users';
UPDATE permissions SET description = 'AI 可查看全站所有设备列表（手机号脱敏）并解绑任意用户的设备绑定' WHERE perm_key = 'ai.manage_devices';
UPDATE permissions SET description = 'AI 可读写系统参数（ai_max_tokens/ai_default_provider 等白名单键）与切换功能开关' WHERE perm_key = 'ai.manage_system';
UPDATE permissions SET description = 'AI 可查看安全敏感数据：安全概览、受保护条目、审计日志（已做字段脱敏与详情截断）' WHERE perm_key = 'ai.view_security_data';
UPDATE permissions SET description = 'AI 可查询慢查询与数据库连接池状态（数据库运维观测数据）' WHERE perm_key = 'ai.view_database_schema';
UPDATE permissions SET description = 'AI 可解释部署形态与项目架构等内部实现信息' WHERE perm_key = 'ai.view_deployment';
UPDATE permissions SET description = 'AI 可查看源码/实现细节（预留：当前无对应工具，功能立项时启用）' WHERE perm_key = 'ai.view_source_code';
UPDATE permissions SET description = 'AI 可访问其他用户的剪贴板/收藏等内容数据（预留：当前无对应工具）' WHERE perm_key = 'ai.access_other_user_data';
UPDATE permissions SET description = 'AI 可解释内部实现细节（预留：当前无对应工具）' WHERE perm_key = 'ai.explain_internal';

INSERT INTO schema_migrations (version, applied_at) VALUES ('054', NOW())
ON CONFLICT (version) DO NOTHING;
