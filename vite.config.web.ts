import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/** 仅前端开发：不启动 Electron，配合 VITE_MOCK_ELECTRON 使用 */
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    open: true,
  },
})
