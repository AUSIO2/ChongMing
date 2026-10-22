// 配置 Web 代理和桌面构建入口，并为桌面页面注入受限内容安全策略。
import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import vue from '@vitejs/plugin-vue'

/**
 * 识别裸包导入，使 Electron 主进程构建保留外部依赖而非打包相对资源。
 *
 * @param id 构建器正在解析的模块标识，区分裸包名、相对路径、绝对路径和虚拟模块。
 */
function clientIsDependency(id: string): boolean {
  return !id.startsWith('.') && !id.startsWith('\0') && !path.isAbsolute(id)
}

function clientCreateContentPolicy(): Plugin {
  // 创建仅构建阶段生效的插件，为桌面页面注入内容安全策略。
  return {
    name: 'desktop-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => /* 在 HTML 头部插入策略，禁止页面自行联网、提交表单或嵌入对象。 */  [{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'",
      },
      injectTo: 'head-prepend',
    }],
  }
}

export default defineConfig(() => {
  // 校验 API 代理来源，并按 Web 或桌面模式装配 Vue、Electron 与安全策略插件。
  const web = process.env.CHONGMING_WEB === '1'
  const target = new URL(process.env.CHONGMING_GRAPH_API ?? 'http://127.0.0.1:4320')
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || target.search || target.hash || !['', '/'].includes(target.pathname)) throw new Error('CHONGMING_GRAPH_API must be a fixed HTTP(S) origin')
  return {
    server: {
      host: '127.0.0.1',
      proxy: { '/api/v1': { target: target.origin, changeOrigin: true, followRedirects: false } },
    },
    plugins: [
      vue(),
      ...(web ? [] : [clientCreateContentPolicy(), electron({
        main: {
          entry: 'apps/desktop/main.ts',
          vite: { build: { rollupOptions: { external: clientIsDependency, output: { entryFileNames: 'main.js' } } } },
        },
        preload: {
          input: path.join(__dirname, 'apps/desktop/preload.ts'),
          vite: { build: { rollupOptions: { output: { entryFileNames: 'preload.js' } } } },
        },
      })]),
    ],
  }
})
