import { createRouter, createWebHistory } from 'vue-router'
import { useConfigStore } from '@/stores/configStore'

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
      path: '/app/:sub?',
      name: 'app-sub',
      component: () => import('@/views/HomeView.vue'),
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
  }

  return true
})

export default router
