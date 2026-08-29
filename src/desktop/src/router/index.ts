import { createRouter, createWebHistory } from 'vue-router'
import { useConfigStore } from '@/stores/configStore'

/**
 * /app/:sub 合法子页面白名单（C8④）。
 * 必须与 HomeView 里 v-if 链渲染的子视图、AppSidebar 的导航项保持一致；
 * 任何不在名单里的 sub（如 /app/anything）都会落到 404 引导页，而不是渲染空白主页。
 */
export const APP_SUB_PAGES = [
  'clipboard',
  'archive',
  'favorites',
  'templates',
  'devices',
  'profile',
  'notifications',
  'subscription',
] as const

export type AppSubPage = (typeof APP_SUB_PAGES)[number]

function isAppSub(value: unknown): value is AppSubPage {
  return typeof value === 'string' && (APP_SUB_PAGES as readonly string[]).includes(value)
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/auth',
    },
    {
      path: '/auth',
      name: 'auth',
      component: () => import('@/views/AuthView.vue'),
    },
    {
      path: '/app',
      name: 'app',
      component: () => import('@/views/HomeView.vue'),
    },
    {
      path: '/app/:sub',
      name: 'app-sub',
      component: () => import('@/views/HomeView.vue'),
    },
    {
      // 404 兜底：所有未匹配路径（含 /app/<非法 sub> 的重定向）都走这里
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      props: (route) => ({ path: route.fullPath }),
    },
  ],
})

// Navigation guard: redirect to auth if not logged in
router.beforeEach((to) => {
  // Skip guard for /auth
  if (to.path.startsWith('/auth')) return true

  // For app routes, check token
  if (to.path.startsWith('/app')) {
    const token = localStorage.getItem('clipsync-token')
    if (!token) return '/auth'

    // 白名单校验：非法 sub 不进主页（否则 v-if 链全不匹配 → 整页空白），改为 404 引导页
    if (to.name === 'app-sub' && !isAppSub(to.params.sub)) {
      return { name: 'not-found', params: { pathMatch: to.path.split('/').slice(1) } }
    }
  }

  return true
})

// 会话彻底失效（refresh token 刷新失败，由 api/client.ts 广播）→ 跳登录页
window.addEventListener('clipsync:auth-expired', () => {
  router.push('/auth')
})

export default router
