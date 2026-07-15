/** IPC channel 常量 — main / preload 共用 */
export const IPC_CHANNELS = {
  MAP_CREATE: 'map:create',
  MAP_LIST: 'map:list',
  MAP_GET: 'map:get',
  MAP_UPDATE: 'map:update',
  MAP_DELETE: 'map:delete',
  MAP_SAVE: 'map:save',
  MAP_READ_ALL_CLAIMS: 'map:read-all-claims',

  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_UPLOAD_LOCAL_AGENTS: 'workspace:upload-local-agents',

  FILE_EXPORT_MAP: 'file:export-map',
  FILE_EXPORT_WORKSPACE: 'file:export-workspace',
  FILE_IMPORT_WORKSPACE: 'file:import-workspace',

  DB_GET_SETTINGS: 'db:get-settings',
  DB_SAVE_SETTINGS: 'db:save-settings',
  DB_GET_STATUS: 'db:get-status',
  DB_TEST_CONNECTION: 'db:test-connection',
  DB_RECONNECT: 'db:reconnect',
  DB_SWITCH: 'db:switch',

  CATALOG_LIST: 'catalog:list',
  CATALOG_LIST_ALL: 'catalog:list-all',
  CATALOG_GET: 'catalog:get',
  CATALOG_CREATE: 'catalog:create',
  CATALOG_UPDATE: 'catalog:update',
  CATALOG_DELETE: 'catalog:delete',
  CATALOG_RELOAD: 'catalog:reload',

  APP_GET_SETTINGS: 'app:get-settings',
  APP_SAVE_SETTINGS: 'app:save-settings',
  APP_TEST_LLM: 'app:test-llm',
  APP_GET_VERSION: 'app:get-version',
  APP_PING_ENDPOINT: 'app:ping-endpoint',
  APP_SET_TITLE: 'app:set-title',

  SKILLS_LIST: 'skills:list',

  PROMPT_VARS_LIST: 'prompt-vars:list',
  PROMPT_CONFIG_LIST: 'prompt-config:list',
  PROMPT_CONFIG_GET: 'prompt-config:get',
  PROMPT_CONFIG_UPDATE: 'prompt-config:update',

  AGENT_REGISTRY_LIST: 'agent-registry:list',
  AGENT_REGISTRY_GET: 'agent-registry:get',
  AGENT_REGISTRY_CREATE: 'agent-registry:create',
  AGENT_REGISTRY_UPDATE: 'agent-registry:update',
  AGENT_REGISTRY_DELETE: 'agent-registry:delete',
  AGENT_REGISTRY_RELOAD: 'agent-registry:reload',
  AGENT_REGISTRY_PREVIEW_OUTPUT: 'agent-registry:preview-output',

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
