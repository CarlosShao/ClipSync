/**
 * 敏感操作判定（审计页红底高亮规则，前端与 MSW 共用同一份实现）：
 * action 以 `admin.` 开头，或 action ∈ { user.deactivate, role.assign, user.delete }。
 */
const SENSITIVE_EXACT_ACTIONS = new Set(['user.deactivate', 'role.assign', 'user.delete']);

export function isSensitiveAction(action: string): boolean {
  return action.startsWith('admin.') || SENSITIVE_EXACT_ACTIONS.has(action);
}
