import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'
import { adapterBuildIpc, portRegisterApi } from './flow-map'

function installMapApi() {
  if (typeof window !== 'undefined' && window.electronAPI) {
    portRegisterApi(adapterBuildIpc(window.electronAPI))
  }
}

installMapApi()

if (import.meta.hot) {
  import.meta.hot.accept('./flow-map/adapters/electron-ipc.ts', () => {
    installMapApi()
  })
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
