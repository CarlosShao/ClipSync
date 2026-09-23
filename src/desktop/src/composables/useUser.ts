import { ref, computed } from 'vue'
import { getMe, type AuthUser } from '@/api/auth'

// 轻量级当前用户信息（含 RBAC 角色）。不引入 Pinia store，避免与现有 stores 体系耦合。
// 单例 ref：全应用共享同一份用户态。
const user = ref<AuthUser | null>(null)
const loading = ref(false)
const loaded = ref(false)

export function useUser() {
  const roleKey = computed(() => user.value?.roleKey || 'user')
  const roleLevel = computed(() => user.value?.roleLevel ?? 10)
  const isAdmin = computed(() => Boolean(user.value?.isAdmin))
  const isSuperAdmin = computed(() => roleKey.value === 'super_admin')
  const permissions = computed(() => user.value?.permissions || [])

  function hasPermission(perm: string) {
    return permissions.value.includes(perm)
  }

  async function fetchUser(force = false) {
    if (loading.value) return user.value
    if (loaded.value && !force) return user.value
    loading.value = true
    try {
      const res = await getMe()
      if (res.ok && res.data) {
        user.value = res.data
        loaded.value = true
      }
    } catch (err) {
      // 未登录或请求失败：保持 null，由调用方按需处理
      console.warn('[useUser] getMe failed:', (err as Error)?.message)
    } finally {
      loading.value = false
    }
    return user.value
  }

  function setUser(u: AuthUser | null) {
    user.value = u
    loaded.value = true
  }

  /** 登出/换号：清空用户态并把 loaded 复位，确保下次登录后 fetchUser() 会真正重取 RBAC */
  function resetUser() {
    user.value = null
    loading.value = false
    loaded.value = false
  }

  return {
    user,
    loading,
    loaded,
    roleKey,
    roleLevel,
    isAdmin,
    isSuperAdmin,
    permissions,
    hasPermission,
    fetchUser,
    setUser,
    resetUser,
  }
}
