/// <reference types="vite-plugin-electron/electron-env" />
/// <reference path="./api/types.ts" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
    /** prompts 目录绝对路径（可选，优先于 APP_ROOT/prompts） */
    PROMPTS_ROOT?: string
    MONGO_URI?: string
  }
}
