import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import vue from '@vitejs/plugin-vue'

function clientIsDependency(id: string): boolean {
  return !id.startsWith('.') && !id.startsWith('\0') && !path.isAbsolute(id)
}

function clientCreateContentPolicy(): Plugin {
  return {
    name: 'desktop-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [{
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
          entry: 'electron/client-main.ts',
          vite: { build: { rollupOptions: { external: clientIsDependency, output: { entryFileNames: 'main.js' } } } },
        },
        preload: {
          input: path.join(__dirname, 'electron/client-preload.ts'),
          vite: { build: { rollupOptions: { output: { entryFileNames: 'preload.js' } } } },
        },
      })]),
    ],
  }
})
