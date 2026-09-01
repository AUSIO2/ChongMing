import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from './api/channels'
import type { ElectronAPI } from './api/types'

const electronAPI: ElectronAPI = {
  mapper: {
    read: query => ipcRenderer.invoke(IPC_CHANNELS.MAPPER_READ, query),
    dispatch: command => ipcRenderer.invoke(IPC_CHANNELS.MAPPER_DISPATCH, command),
    watch: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as Parameters<typeof callback>[0])
      }
      ipcRenderer.on(IPC_CHANNELS.MAPPER_UPDATED, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MAPPER_UPDATED, listener)
    },
  },
  workspace: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),
    get: workspaceId => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET, workspaceId),
    create: input => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, input),
    update: (workspaceId, patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE, workspaceId, patch),
    delete: workspaceId =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, workspaceId),
    uploadLocalAgents: (workspaceId, mode) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.WORKSPACE_UPLOAD_LOCAL_AGENTS,
        workspaceId,
        mode,
      ),
  },
  catalog: {
    list: module => ipcRenderer.invoke(IPC_CHANNELS.CATALOG_LIST, module),
    listAll: () => ipcRenderer.invoke(IPC_CHANNELS.CATALOG_LIST_ALL),
    get: (module, agentName) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATALOG_GET, module, agentName),
    create: (module, input) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATALOG_CREATE, module, input),
    update: (module, agentName, patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATALOG_UPDATE, module, agentName, patch),
    delete: (module, agentName) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATALOG_DELETE, module, agentName),
    reload: () => ipcRenderer.invoke(IPC_CHANNELS.CATALOG_RELOAD),
  },
  file: {
    exportMap: mapId => ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPORT_MAP, mapId),
    exportWorkspace: workspaceId =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPORT_WORKSPACE, workspaceId),
    importWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.FILE_IMPORT_WORKSPACE),
  },
  db: {
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.DB_GET_SETTINGS),
    saveSettings: uri => ipcRenderer.invoke(IPC_CHANNELS.DB_SAVE_SETTINGS, uri),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.DB_GET_STATUS),
    testConnection: uri => ipcRenderer.invoke(IPC_CHANNELS.DB_TEST_CONNECTION, uri),
    reconnect: () => ipcRenderer.invoke(IPC_CHANNELS.DB_RECONNECT),
    switch: uri => ipcRenderer.invoke(IPC_CHANNELS.DB_SWITCH, uri),
  },
  app: {
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_SETTINGS),
    saveSettings: input => ipcRenderer.invoke(IPC_CHANNELS.APP_SAVE_SETTINGS, input),
    testLlm: () => ipcRenderer.invoke(IPC_CHANNELS.APP_TEST_LLM),
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
    pingEndpoint: () => ipcRenderer.invoke(IPC_CHANNELS.APP_PING_ENDPOINT),
    setTitle: (title: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_SET_TITLE, title),
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST),
  },
  promptVars: {
    list: kind => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_VARS_LIST, kind),
  },
  promptConfig: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_CONFIG_LIST),
    get: promptPath => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_CONFIG_GET, promptPath),
    update: (promptPath, patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROMPT_CONFIG_UPDATE, promptPath, patch),
  },
  agentRegistry: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_REGISTRY_LIST),
    get: promptPath => ipcRenderer.invoke(IPC_CHANNELS.AGENT_REGISTRY_GET, promptPath),
    create: input => ipcRenderer.invoke(IPC_CHANNELS.AGENT_REGISTRY_CREATE, input),
    update: (promptPath, patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_REGISTRY_UPDATE, promptPath, patch),
    delete: promptPath => ipcRenderer.invoke(IPC_CHANNELS.AGENT_REGISTRY_DELETE, promptPath),
    reload: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_REGISTRY_RELOAD),
    previewOutput: (kind, params) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_REGISTRY_PREVIEW_OUTPUT, kind, params),
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
