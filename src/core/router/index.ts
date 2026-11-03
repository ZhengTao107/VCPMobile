import { createRouter, createWebHashHistory } from 'vue-router';
import ChatView from '../../features/chat/ChatView.vue';

const routes = [
  { path: '/', redirect: '/chat' },
  { path: '/chat', name: 'chat', component: ChatView },
  { path: '/canvas', name: 'canvas', component: () => import('../../features/canvas/CanvasView.vue') },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.onError((error) => {
  console.error('[router] navigation error', error);
  void import('../stores/notification')
    .then(({ useNotificationStore }) => {
      useNotificationStore().addNotification({
        type: 'error',
        title: '页面加载失败',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        toastOnly: true,
      });
    })
    .catch(() => undefined);
});
