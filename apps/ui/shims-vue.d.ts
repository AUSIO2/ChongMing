// 补充 Vite 环境和 Vue 单文件组件的 TypeScript 类型声明。
/// <reference types="vite/client" />

interface ImportMetaEnv {
  // 在此声明本项目使用的 Vite 环境字段；当前没有额外字段。
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
