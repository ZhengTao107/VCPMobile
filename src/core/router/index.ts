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
