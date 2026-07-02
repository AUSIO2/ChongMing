import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'
import { installMockElectronAPI } from './mocks/electron-api'

if (import.meta.env.VITE_MOCK_ELECTRON) {
  installMockElectronAPI()
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
