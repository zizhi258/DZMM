import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      children: [
        { path: '', redirect: '/chat' },
        {
          path: 'chat',
          name: 'chat',
          component: () => import('@/pages/chat/index.vue'),
        },
        {
          path: 'explore',
          name: 'explore',
          component: () => import('@/pages/explore/index.vue'),
        },
        {
          path: 'square',
          name: 'square',
          component: () => import('@/pages/square/index.vue'),
        },
      ],
    },
  ],
})

export default router
