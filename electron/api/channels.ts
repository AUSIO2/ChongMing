/** IPC channel 常量 — main / preload 共用 */
export const IPC_CHANNELS = {
  MAP_CREATE: 'map:create',
  MAP_LIST: 'map:list',
  MAP_GET: 'map:get',
  MAP_UPDATE: 'map:update',
  MAP_DELETE: 'map:delete',
  MAP_SAVE: 'map:save',

  CATALOG_LIST: 'catalog:list',

  GRAPH_RUN_TRANSITION: 'graph:run-transition',
  GRAPH_RESUME: 'graph:resume',
  GRAPH_SET_MODE: 'graph:set-mode',
  GRAPH_CANCEL: 'graph:cancel',
  GRAPH_GET_ACTIVE_RUN: 'graph:get-active-run',
  GRAPH_RESTORE: 'graph:restore',

  GRAPH_INTERRUPTED: 'graph:interrupted',
  GRAPH_COMPLETED: 'graph:completed',
  GRAPH_ERROR: 'graph:error',
  GRAPH_PROGRESS: 'graph:progress',
  GRAPH_STATE: 'graph:state',
} as const

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]
