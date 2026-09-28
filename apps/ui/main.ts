// 渲染进程入口：装配 Vue、Pinia、路由和全局错误边界后挂载工作台。
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router/index'
import "./style.css"
import { uiRegisterErrors } from './errors'

const app = createApp(App)
uiRegisterErrors(app, router)
app.use(createPinia())
app.use(router)
app.mount('#app')
