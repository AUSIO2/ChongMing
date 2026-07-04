import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'
import { installMockElectronAPI } from './mocks/electron-api'
import { createElectronIpcMapAdapter, installMapAPI } from './flow-map'
import { createMockMapAPI } from './mocks/flow-map-api'
import { flowMapSeedToInstallElectronOptions } from './mocks/flow-map-seed'
import { USE_MAP_FLOW } from './config/map-flow'

const isMockElectron = !!import.meta.env.VITE_MOCK_ELECTRON

if (isMockElectron) {
  installMockElectronAPI(
    USE_MAP_FLOW ? { initialNews: flowMapSeedToInstallElectronOptions() } : {},
  )
}

if (USE_MAP_FLOW) {
  // dev:web 用内存 mock；真 Electron 走 IPC Adapter
  if (isMockElectron) {
    installMapAPI(createMockMapAPI())
  } else if (typeof window !== 'undefined' && window.electronAPI) {
    installMapAPI(createElectronIpcMapAdapter(window.electronAPI))
  }
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
