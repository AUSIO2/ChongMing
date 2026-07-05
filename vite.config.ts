import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import vue from '@vitejs/plugin-vue'

/** Electron main 不打包 node_modules，避免 mongodb 可选 peer（kerberos 等）在 bundle 内解析失败 */
function electronMainExternal(id: string): boolean {
  if (id.startsWith('.') || id.startsWith('\0') || path.isAbsolute(id)) {
    return false
  }
  return true
}

export default defineConfig({
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: electronMainExternal,
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      renderer: process.env.NODE_ENV === 'test'
        ? undefined
        : {},
    }),
  ],
})
