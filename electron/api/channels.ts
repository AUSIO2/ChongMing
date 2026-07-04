/** IPC channel 常量 — main / preload 共用 */
export const IPC_CHANNELS = {
  NEWS_CREATE: 'news:create',
  NEWS_LIST: 'news:list',
  NEWS_GET: 'news:get',
  NEWS_UPDATE: 'news:update',
  NEWS_SAVE_MAP: 'news:save-map',

  CATALOG_LIST: 'catalog:list',

  GRAPH_START_SPLIT: 'graph:start-split',
  GRAPH_START_VERIFY: 'graph:start-verify',
  GRAPH_RESUME: 'graph:resume',
  GRAPH_SET_MODE: 'graph:set-mode',
  GRAPH_CANCEL: 'graph:cancel',
  GRAPH_GET_ACTIVE_RUN: 'graph:get-active-run',
  GRAPH_RESTORE: 'graph:restore',

  GRAPH_INTERRUPTED: 'graph:interrupted',
  GRAPH_COMPLETED: 'graph:completed',
  GRAPH_ERROR: 'graph:error',
  GRAPH_PROGRESS: 'graph:progress',
} as const

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]
