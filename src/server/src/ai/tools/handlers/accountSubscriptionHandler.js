import pool from '../../../db/pool.js'
import { getAiContext } from '../../../utils/aiContext.js'
import { logAuditEvent } from '../../../utils/audit.js'
import { PLAN_RANK } from '../shared.js'

export const accountSubscriptionHandlers = {
  'get_memories': async (args, userId, role) => {
        const { category } = args
        let sql = 'SELECT id, category, title, content, updated_at FROM ai_memories WHERE user_id = $1'
        const params = [userId]
        if (category) { sql += ' AND category = $2'; params.push(category) }
        sql += ' ORDER BY updated_at DESC'
        const result = await pool.query(sql, params)
        return { memories: result.rows, count: result.rowCount }
      },

  'save_memory': async (args, userId, role) => {
        const { category = 'fact', title, content } = args
        if (!title || !content) return { error: 'title and content are required' }
        const cat = ['preference', 'fact', 'project', 'feedback', 'other'].includes(category) ? category : 'fact'
        // D6d：注入长度截断——记忆正文 ≤2000 字符，防止巨型/恶意文本常驻长期上下文
        const rawContent = String(content).trim()
        const cappedContent = rawContent.slice(0, 2000)
        const result = await pool.query(
          `INSERT INTO ai_memories (user_id, category, title, content)
           VALUES ($1, $2, $3, $4)
           RETURNING id, category, title, content, updated_at`,
          [userId, cat, String(title).trim(), cappedContent]
        )
        return {
          saved: result.rows[0],
          ...(rawContent.length > 2000
            ? { truncated: true, note: `content 超过 2000 字符上限，已截断保存（原 ${rawContent.length} 字符）。` }
            : {}),
        }
      },

  'get_subscription_details': async (args, userId, role) => {
        const ctx = await getAiContext(userId)
        const sub = ctx.subscription
        const usage = await pool.query(
          `SELECT COUNT(*)::int AS total, COALESCE(SUM(content_size),0)::bigint AS total_bytes
           FROM clipboard_items WHERE user_id = $1`,
          [userId]
        )
        return {
          plan: sub
            ? {
                name: sub.plan_name,
                displayName: sub.display_name,
                maxDevices: sub.max_devices,
                maxItems: sub.max_clipboard_items,
                maxFileMb: sub.max_file_size_mb,
                maxStorageMb: sub.max_storage_mb
              }
            : 'free',
          usage: { totalItems: usage.rows[0].total, totalBytes: Number(usage.rows[0].total_bytes) },
          note: '套餐限制见 plan 字段；usage 为当前用量（条数 + 内容总字节）。'
        }
      },

  'upgrade_subscription': async (args, userId, role) => {
        const { user_id, plan, duration_months = 1 } = args
        const userId2 = userId // 操作者（审计用）
        if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
        const planName = Object.keys(PLAN_RANK).find((p) => p.toLowerCase() === String(plan).toLowerCase())
        if (!planName) return { error: 'INVALID_PLAN', code: 'INVALID_PLAN' }
        const months = Math.min(Math.max(1, parseInt(duration_months, 10) || 1), 12)
        const targetUser = await pool.query('SELECT id FROM users WHERE id = $1', [user_id])
        if (targetUser.rows.length === 0) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        const planRes = await pool.query('SELECT id, name FROM subscription_plans WHERE name = $1', [planName])
        if (planRes.rows.length === 0) return { error: 'PLAN_NOT_FOUND', code: 'PLAN_NOT_FOUND' }
        const planId = planRes.rows[0].id
        const existing = await pool.query(
          'SELECT id FROM user_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
          [user_id]
        )
        let sub
        if (existing.rows.length > 0) {
          const up = await pool.query(
            `UPDATE user_subscriptions
             SET plan_id = $1, status = 'active', current_period_start = NOW(),
                 current_period_end = NOW() + ($3 || ' months')::interval, updated_at = NOW()
             WHERE id = $2
             RETURNING id, user_id, plan_id, status, current_period_start, current_period_end`,
            [planId, existing.rows[0].id, months]
          )
          sub = up.rows[0]
        } else {
          const ins = await pool.query(
            `INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date, current_period_start, current_period_end, billing_cycle)
             VALUES ($1, $2, 'active', NOW(), NOW() + ($3 || ' months')::interval, NOW(), NOW() + ($3 || ' months')::interval, 'monthly')
             RETURNING id, user_id, plan_id, status, current_period_start, current_period_end`,
            [user_id, planId, months]
          )
          sub = ins.rows[0]
        }
        await pool.query(
          'UPDATE users SET subscription_status = $1, current_subscription_id = $2, updated_at = NOW() WHERE id = $3',
          [planName.toLowerCase(), sub.id, user_id]
        )
        await logAuditEvent({
          userId: userId2,
          action: 'subscription_upgrade',
          resourceType: 'user_subscription',
          resourceId: String(user_id),
          details: { target_user_id: user_id, plan: planName, duration_months: months },
        })
        return {
          success: true,
          user_id,
          plan: planName,
          status: sub.status,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
        }
      },

  'downgrade_subscription': async (args, userId, role) => {
        const { user_id, plan } = args
        if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
        const planName = Object.keys(PLAN_RANK).find((p) => p.toLowerCase() === String(plan).toLowerCase())
        if (!planName) return { error: 'INVALID_PLAN', code: 'INVALID_PLAN' }
        const targetUser = await pool.query('SELECT id FROM users WHERE id = $1', [user_id])
        if (targetUser.rows.length === 0) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        // 读取当前活跃套餐（不存在则为 Free）
        const curRes = await pool.query(
          `SELECT sp.name FROM user_subscriptions us
           JOIN subscription_plans sp ON sp.id = us.plan_id
           WHERE us.user_id = $1 AND us.status = 'active'
           ORDER BY us.created_at DESC LIMIT 1`,
          [user_id]
        )
        const currentPlan = curRes.rows.length > 0 ? curRes.rows[0].name : 'Free'
        if (PLAN_RANK[planName] >= PLAN_RANK[currentPlan]) {
          return {
            error: 'DOWNGRADE_REQUIRED_LOWER',
            code: 'DOWNGRADE_REQUIRED_LOWER',
            message: `目标套餐等级须低于当前套餐（当前 ${currentPlan}），不允许降级到同级或升级。`,
            current_plan: currentPlan,
            target_plan: planName,
          }
        }
        const planRes = await pool.query('SELECT id, name FROM subscription_plans WHERE name = $1', [planName])
        if (planRes.rows.length === 0) return { error: 'PLAN_NOT_FOUND', code: 'PLAN_NOT_FOUND' }
        const planId = planRes.rows[0].id
        const existing = await pool.query(
          'SELECT id FROM user_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
          [user_id]
        )
        let sub
        if (existing.rows.length > 0) {
          const up = await pool.query(
            `UPDATE user_subscriptions
             SET plan_id = $1, status = 'active', current_period_start = NOW(),
                 current_period_end = NOW() + INTERVAL '1 month', updated_at = NOW()
             WHERE id = $2
             RETURNING id, plan_id, status, current_period_start, current_period_end`,
            [planId, existing.rows[0].id]
          )
          sub = up.rows[0]
        } else {
          const ins = await pool.query(
            `INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date, current_period_start, current_period_end, billing_cycle)
             VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '1 month', NOW(), NOW() + INTERVAL '1 month', 'monthly')
             RETURNING id, plan_id, status, current_period_start, current_period_end`,
            [user_id, planId]
          )
          sub = ins.rows[0]
        }
        await pool.query(
          'UPDATE users SET subscription_status = $1, current_subscription_id = $2, updated_at = NOW() WHERE id = $3',
          [planName.toLowerCase(), sub.id, user_id]
        )
        await logAuditEvent({
          userId,
          action: 'subscription_downgrade',
          resourceType: 'user_subscription',
          resourceId: String(user_id),
          details: { target_user_id: user_id, from_plan: currentPlan, plan: planName },
        })
        return {
          success: true,
          user_id,
          plan: planName,
          from_plan: currentPlan,
          status: sub.status,
        }
      },

  'get_profile': async (args, userId, role) => {
        const result = await pool.query(
          'SELECT id, phone, email, nickname, avatar_url, created_at, subscription_status FROM users WHERE id = $1',
          [userId]
        )
        if (result.rows.length === 0) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        const u = result.rows[0]
        return {
          id: u.id,
          phone: u.phone,
          email: u.email,
          nickname: u.nickname,
          avatarUrl: u.avatar_url,
          createdAt: u.created_at,
          subscriptionStatus: u.subscription_status,
        }
      },

  'update_profile': async (args, userId, role) => {
        const { nickname, avatar_url } = args
        const updates = []
        const params = []
        let p = 1
        if (nickname !== undefined) { updates.push(`nickname = $${p++}`); params.push(String(nickname).trim().slice(0, 50)) }
        if (avatar_url !== undefined) { updates.push(`avatar_url = $${p++}`); params.push(String(avatar_url).trim().slice(0, 500)) }
        if (updates.length === 0) {
          return { error: 'NO_FIELDS', code: 'NO_FIELDS', message: 'nickname / avatar_url 至少提供一个' }
        }
        updates.push('updated_at = NOW()')
        params.push(userId)
        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${p}`, params)
        return { success: true, note: '账号资料已更新。' }
      },

  'get_subscription_plans': async (args, userId, role) => {
        const result = await pool.query(
          'SELECT id, name, display_name, description, price_monthly, price_yearly, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features FROM subscription_plans WHERE is_active = true ORDER BY price_monthly ASC'
        )
        return {
          plans: result.rows.map((plan) => ({
            id: plan.id,
            name: plan.name,
            displayName: plan.display_name,
            priceMonthly: parseFloat(plan.price_monthly || 0),
            priceYearly: parseFloat(plan.price_yearly || 0),
            maxDevices: plan.max_devices,
            maxClipboardItems: plan.max_clipboard_items,
            maxFileSizeMb: plan.max_file_size_mb,
            maxStorageMb: plan.max_storage_mb,
            features: plan.features,
          })),
          count: result.rowCount,
        }
      },

  'cancel_subscription': async (args, userId, role) => {
        // 仅取消自动续费（cancel_at_period_end），当期结束前仍可用，无外部支付通道依赖
        const sub = await pool.query(
          'SELECT id, current_period_end FROM user_subscriptions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
          [userId, 'active']
        )
        if (sub.rows.length === 0) return { error: 'NO_ACTIVE_SUBSCRIPTION', code: 'NO_ACTIVE_SUBSCRIPTION', message: '没有活跃订阅可取消' }
        await pool.query(
          'UPDATE user_subscriptions SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1',
          [sub.rows[0].id]
        )
        return { success: true, current_period_end: sub.rows[0].current_period_end, note: '已取消自动续费，订阅在当前计费周期结束前仍可用，不退款。' }
      },

  'resume_subscription': async (args, userId, role) => {
        const sub = await pool.query(
          'SELECT id FROM user_subscriptions WHERE user_id = $1 AND status = $2 AND cancel_at_period_end = true ORDER BY created_at DESC LIMIT 1',
          [userId, 'active']
        )
        if (sub.rows.length === 0) {
          return { error: 'NO_CANCELLABLE_SUBSCRIPTION', code: 'NO_CANCELLABLE_SUBSCRIPTION', message: '没有可恢复的已取消订阅' }
        }
        await pool.query(
          'UPDATE user_subscriptions SET cancel_at_period_end = false, updated_at = NOW() WHERE id = $1',
          [sub.rows[0].id]
        )
        return { success: true, subscription_id: sub.rows[0].id, note: '订阅已恢复自动续费。' }
      },

  'submit_survey': async (args, userId, role) => {
        const { type, score, feedback } = args
        if (typeof type !== 'string' || !type.trim()) return { error: 'TYPE_REQUIRED', code: 'TYPE_REQUIRED' }
        if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) {
          return { error: 'INVALID_SCORE', code: 'INVALID_SCORE', message: 'score 必须为 0-10 的整数' }
        }
        const safeType = type.trim().slice(0, 20) || 'nps'
        const safeFeedback = typeof feedback === 'string' ? feedback.slice(0, 2000) : null
        const result = await pool.query(
          'INSERT INTO surveys (user_id, type, score, feedback, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, type, score, feedback, created_at',
          [userId, safeType, score, safeFeedback]
        )
        return { success: true, survey: result.rows[0] }
      },
}