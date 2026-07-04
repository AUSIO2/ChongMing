/// <reference types="vite/client" />
/// <reference path="../electron/api/types.ts" />

interface ImportMetaEnv {
  // reserved for future Vite env flags
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
