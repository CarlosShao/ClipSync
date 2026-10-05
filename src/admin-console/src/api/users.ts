import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client';
import type {
  AdminUser,
  NotifyUserPayload,
  PageData,
  LimitOverrides,
  UpdateUserStatusPayload,
  UserDetail,
  UserListParams,
} from '@/api/types';

/** 用户列表（分页 + 搜索 + 套餐/状态/注册时间筛选） */
export function getUsers(params: UserListParams): Promise<PageData<AdminUser>> {
  return apiGet<PageData<AdminUser>>('/admin/users', { params });
}

/** 用户详情（含设备与最近审计） */
export function getUserDetail(id: string): Promise<UserDetail> {
  return apiGet<UserDetail>(`/admin/users/${id}`);
}

/** 停用 / 启用账号（停用必须带 reason，写入审计日志） */
export function updateUserStatus(id: string, payload: UpdateUserStatusPayload): Promise<AdminUser> {
  return apiPatch<AdminUser>(`/admin/users/${id}/status`, payload);
}

/** 审批通过等待名单用户（signup_waitlist 开关落地），写入审计日志 */
export function approveUser(id: string): Promise<AdminUser> {
  return apiPost<AdminUser>(`/admin/users/${id}/approve`, {});
}

/** AF-11：强制下线（吊销全部活跃会话；原因写审计 admin.user.force_logout） */
export function forceLogoutUser(
  id: string,
  payload: { reason: string }
): Promise<{ id: string; revokedSessions: number }> {
  return apiPost<{ id: string; revokedSessions: number }>(
    `/admin/users/${id}/force-logout`,
    payload
  );
}

/** AF-12：删除账户（软删 is_active=false；原因写审计 user.delete；非物理删除，可重新启用） */
export function deleteUser(
  id: string,
  payload: { reason: string }
): Promise<{ id: string; deleted: boolean }> {
  return apiDelete<{ id: string; deleted: boolean }>(`/admin/users/${id}`, payload);
}

/**
 * 2026-10-05 补：违规昵称 / 头像处置。
 *
 * 服务端口径：三项至少给一项；昵称非空且 ≤50 字、不含 `< > " ' &`（与用户侧同一
 * `validateNickname`），落库前 `sanitizeString`（形态与用户侧一致）；
 * 头像只接受 `http(s)://` 或 `data:image/...;base64,`；原因必填；
 * 审计 `admin.user.profile_moderation`；**并清 Redis 用户缓存**
 *（`GET /profile` 有 5 分钟缓存，不清的话用户仍看到旧昵称）。
 */
export function moderateUserProfile(
  id: string,
  payload: { nickname?: string; avatarUrl?: string; clearAvatar?: boolean; reason: string }
): Promise<AdminUser> {
  return apiPatch<AdminUser>(`/admin/users/${id}/profile`, payload);
}

/**
 * 2026-10-05 补（迁移 084）：单用户配额覆盖。
 *
 * 配额的唯一来源是 `subscription_plans`，而 `PATCH /admin/plans/:id` 改的是套餐行 ——
 * 会同时影响该套餐下**所有人**。想单独给一个人提配额（客诉补偿/大客户/内部测试），
 * 此前只能改库（无审计，且只改数据没改口径）。
 *
 * 两种用法（互斥）：
 *  - `overrides`：稀疏补丁，键值 `null` 表示**该项不限**，键缺失表示沿用套餐；
 *  - `clear: true`：清掉覆盖，回到纯套餐值。
 * 权限 `admin.users.manage`；原因必填；审计 `admin.user.limits_override`。
 */
export function setUserLimits(
  id: string,
  payload: { reason: string; overrides?: LimitOverrides } | { reason: string; clear: true }
): Promise<AdminUser> {
  return apiPost<AdminUser>(`/admin/users/${id}/limits`, payload);
}

/**
 * 2026-10-05 补：人工开通 / 重置试用。
 *
 * 用户侧 `POST /api/subscriptions/trial` 有一条**终身一次**闸（库里只要有任一
 * `user_subscriptions` 行就拒，含 cancelled/expired，专门防「取消后再试用」套取），
 * 但它没有例外通道 —— 客服补试用只能改库，而改库要同时写订阅行（含 trial_end）
 * 与 users 的两个快照列，必错。
 *
 * 本函数**刻意绕过**那条闸，因此服务端：拒绝"已有生效中订阅"的用户（409）、
 * days 限 1–30、审计留 `bypassedLifetimeGate: true`、并给用户发通知。
 * 权限 `admin.subscriptions.grant`。
 */
export function grantUserTrial(
  id: string,
  payload: { reason: string; days?: number; planId?: string; billingCycle?: 'monthly' | 'yearly' }
): Promise<AdminUser> {
  return apiPost<AdminUser>(`/admin/users/${id}/trial`, payload);
}

/**
 * 2026-10-05 补：换绑登录标识（手机号 / 邮箱）。用户换号后自己改不了手机号，
 * 此前客服只能改库 —— 而改库要同时改明文 + 派生 hash + 密文三列，少一列人就登不进来。
 * 后端用 COALESCE：只传一项就只改那一项。
 */
export function rebindUserIdentity(
  id: string,
  payload: { phone?: string; email?: string; reason: string }
): Promise<AdminUser> {
  return apiPost<AdminUser>(`/admin/users/${id}/rebind`, payload);
}

/**
 * 2026-10-05 补：管理员代重置密码（用户手机+邮箱双失效时的**唯一救援路径**）。
 *
 * 返回的 `temporaryPassword` **只在本次响应出现一次** —— 服务端不写审计、不写日志、
 * 也不再提供查询；UI 必须当场展示并提示运营立即转达，关掉就再也拿不到。
 * 服务端同时会**吊销该用户全部活跃会话**（旧会话立刻失效，用户需重新登录）。
 */
export function resetUserPassword(
  id: string,
  payload: { reason: string }
): Promise<{ id: string; temporaryPassword: string; sessionsRevoked: number }> {
  return apiPost<{ id: string; temporaryPassword: string; sessionsRevoked: number }>(
    `/admin/users/${id}/reset-password`,
    payload
  );
}

/**
 * 2026-10-05 补：分配角色（端点 `PATCH /admin/users/:id/role` 早就存在，此前**前端零调用** ——
 * 见 docs/audit/admin-console-db-only-gaps-2026-10-05.md）。
 * 后端两道闸：超管角色不可授予（403 40301）、不得授予等级不低于操作者的角色（403 40303）。
 * 权限键是 `admin.roles.manage`（与 users.manage 分开）。
 */
export function assignUserRole(
  id: string,
  payload: { roleId: string; reason?: string }
): Promise<AdminUser> {
  return apiPatch<AdminUser>(`/admin/users/${id}/role`, payload);
}

/**
 * 2026-10-05 补：重置两步验证（端点 `POST /admin/users/:id/reset-2fa` 早就存在，此前前端零调用）。
 * 清空 TOTP 四列即完成，用户需重新绑定；写审计 admin.user.reset_2fa。
 */
export function resetUserTwoFactor(id: string): Promise<{ id: string; twoFactorEnabled: boolean }> {
  return apiPost<{ id: string; twoFactorEnabled: boolean }>(`/admin/users/${id}/reset-2fa`, {});
}

/**
 * 2026-10-05：对**单个用户**定向通知（原因/正文写入审计 admin.user.notify）。
 * 通道是站内通知（notification_history 落库 + WS 实时推给该用户所有在线设备）。
 * 返回值里的 onlineDevices 用于如实告诉运营"对方此刻是否在线"——落库一定会成功，
 * 但在线数可能为 0（对方下次打开客户端才会在通知中心看到）。
 */
export function notifyUser(
  id: string,
  payload: NotifyUserPayload
): Promise<{ userId: string; notificationType: string; title: string; onlineDevices: number }> {
  return apiPost<{ userId: string; notificationType: string; title: string; onlineDevices: number }>(
    `/admin/users/${id}/notify`,
    payload
  );
}

/**
 * AN-13：数据主体数据导出（可携权）——拉取 JSON 产物 Blob（后端 Content-Disposition 附件）。
 * 后端：GET /admin/users/:id/export?reason=（审计 admin.users.export）；
 * 响应为裸 JSON 文件（非 { code, data } 壳），拦截器对 Blob 原样放行。
 */
export async function exportUserData(id: string, reason: string): Promise<Blob> {
  const resp = await apiGet<Blob>(`/admin/users/${id}/export`, {
    params: { reason },
    responseType: 'blob',
  });
  return resp;
}
