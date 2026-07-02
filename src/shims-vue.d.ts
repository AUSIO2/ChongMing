/// <reference types="vite/client" />
/// <reference path="../electron/api/types.ts" />

interface ImportMetaEnv {
  readonly VITE_MOCK_ELECTRON?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
