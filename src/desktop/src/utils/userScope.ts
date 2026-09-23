// === 用户数据命名空间（防跨账号串号的防御层）===
// 本地持久化的用户数据键按 clipsync:<userId>:<base> 命名空间隔离：即使某条登出路径
// 漏清了数据，下一个登录用户也读不到上一个用户的桶。
// 归属未知时（首登窗口期：已有 token 但 /auth/me 未返回）落 _anon_ 桶；
// userId 解析后由 onAnonScopeResolved 回调把 _anon_ 桶并入该用户桶（仅 ''→uid 迁移，
// A→B 绝不迁移，防止把 A 的数据刷进 B 的账号）。

const SCOPE_KEY = 'clipsync-user-scope'
const ANON = '_anon_'

function readPersistedScope(): string {
  try {
    return localStorage.getItem(SCOPE_KEY) || ''
  } catch {
    return ''
  }
}

let currentUserId: string = readPersistedScope()

const anonMigrators: ((uid: string) => void)[] = []

/** 注册「匿名桶 → 用户桶」迁移回调（offlineQueue / clipboardCache 等按 base 键存储的模块） */
export function onAnonScopeResolved(cb: (uid: string) => void): void {
  anonMigrators.push(cb)
}

export function getUserScope(): string {
  return currentUserId
}

/** 当前用户命名空间下的存储键；无归属时落 _anon_ 桶 */
export function scopedKey(base: string): string {
  return `clipsync:${currentUserId || ANON}:${base}`
}

export function anonScopedKey(base: string): string {
  return `clipsync:${ANON}:${base}`
}

/** 登录成功 / 拉到用户资料时调用；''→uid 触发匿名桶迁移，uid 变化则持久化新归属 */
export function setUserScope(id: string | null | undefined): void {
  const next = (id || '').trim()
  if (!next || next === currentUserId) return
  const prev = currentUserId
  currentUserId = next
  try {
    localStorage.setItem(SCOPE_KEY, next)
  } catch {
    /* ignore */
  }
  if (!prev) {
    for (const cb of anonMigrators) {
      try {
        cb(next)
      } catch {
        /* 迁移失败不阻断登录收尾 */
      }
    }
  }
}

/**
 * 删除某个 base 的全部分桶数据：当前用户桶、匿名桶、其它历史用户桶、
 * 以及命名空间化之前的旧无命名空间键（旧键无法归属，视为上一个用户的，直接丢弃）。
 */
export function removeScopedAndLegacy(base: string): void {
  const suffix = `:${base}`
  const doomed: string[] = [`clipsync-${base}`]
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('clipsync:') && k.endsWith(suffix)) doomed.push(k)
    }
  } catch {
    /* ignore */
  }
  for (const k of doomed) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
}

/** 登出时调用：清除归属标记，下一次登录从匿名桶起（数据本体由 removeScopedAndLegacy 负责） */
export function clearUserScope(): void {
  currentUserId = ''
  try {
    localStorage.removeItem(SCOPE_KEY)
  } catch {
    /* ignore */
  }
}

// 升级兼容：命名空间化之前的旧键无法归属到任何用户，启动即丢弃（见 removeScopedAndLegacy 注释）
for (const legacyBase of ['offline-queue', 'content-cache-v2']) {
  try {
    localStorage.removeItem(`clipsync-${legacyBase}`)
  } catch {
    /* ignore */
  }
}
