import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/HomeView.vue')
    },
    {
      path: '/read/:chapterId',
      name: 'reader',
      component: () => import('../views/ReaderView.vue')
    },
    {
      path: '/conversation/:chapterId',
      name: 'conversation',
      component: () => import('../views/ConversationView.vue')
    },
    {
      path: '/edit/:chapterId',
      name: 'editor',
      component: () => import('../views/EditorView.vue')
    },
    {
      path: '/import/:chapterId',
      name: 'batch-import',
      component: () => import('../views/BatchImportView.vue')
    },
    {
      path: '/stats',
      name: 'stats',
      component: () => import('../views/StatsView.vue')
    },
    {
      path: '/search-replace',
      name: 'search-replace',
      component: () => import('../views/SearchReplaceView.vue')
    },
    {
      path: '/drafts',
      name: 'drafts',
      component: () => import('../views/DraftsView.vue')
    },
    {
      path: '/archive',
      name: 'archive',
      component: () => import('../views/ArchiveView.vue')
    },
    {
      path: '/archive/event/:id',
      name: 'archive-event',
      component: () => import('../views/EventView.vue')
    },
    {
      path: '/prompt-archive',
      name: 'prompt-archive',
      component: () => import('../views/PromptArchiveView.vue')
    },
    {
      path: '/novel-tree',
      name: 'novel-tree',
      component: () => import('../views/NovelTreeView.vue')
    },
    {
      path: '/chat',
      name: 'chat',
      component: () => import('../views/ChatView.vue')
    },
    {
      path: '/git',
      name: 'git',
      component: () => import('../views/GitView.vue')
    }
  ]
})

export default router
