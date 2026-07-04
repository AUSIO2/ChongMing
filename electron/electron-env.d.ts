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
    /** subagentconfig 目录绝对路径（可选，优先于 APP_ROOT/subagentconfig） */
    SUBAGENT_CONFIG_ROOT?: string

    MONGO_URI?: string
    DEEPSEEK_API_KEY?: string
    DEEPSEEK_BASE_URL?: string
    DEEPSEEK_MODEL?: string
    /** Tavily Search API key（web_search tool） */
    TAVILY_API_KEY?: string
  }
}
