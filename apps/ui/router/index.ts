// 工作台路由：使用哈希历史并按需加载首页组件。
import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => /* 进入首页时按需加载工作区页面组件。 */ import("../views/WorkspacePage.vue"),
    },
  ],
})

export default router
