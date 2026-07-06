import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from './api/channels'
import type { ElectronAPI } from './api/types'

const electronAPI: ElectronAPI = {
  map: {
    create: input => ipcRenderer.invoke(IPC_CHANNELS.MAP_CREATE, input),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.MAP_LIST),
    get: mapId => ipcRenderer.invoke(IPC_CHANNELS.MAP_GET, mapId),
    update: (mapId, patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.MAP_UPDATE, mapId, patch),
    delete: mapId => ipcRenderer.invoke(IPC_CHANNELS.MAP_DELETE, mapId),
    saveMapPersistence: (mapId, data) =>
      ipcRenderer.invoke(IPC_CHANNELS.MAP_SAVE, mapId, data),
    readAllClaims: mapId =>
      ipcRenderer.invoke(IPC_CHANNELS.MAP_READ_ALL_CLAIMS, mapId),
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
  graph: {
    runTransition: input =>
      ipcRenderer.invoke(IPC_CHANNELS.GRAPH_RUN_TRANSITION, input),
    resume: (runId, modifications) =>
      ipcRenderer.invoke(IPC_CHANNELS.GRAPH_RESUME, runId, modifications),
    setMode: (runId, mode) =>
      ipcRenderer.invoke(IPC_CHANNELS.GRAPH_SET_MODE, runId, mode),
    cancel: runId => ipcRenderer.invoke(IPC_CHANNELS.GRAPH_CANCEL, runId),
    getActiveRun: mapId =>
      ipcRenderer.invoke(IPC_CHANNELS.GRAPH_GET_ACTIVE_RUN, mapId),
    restore: input => ipcRenderer.invoke(IPC_CHANNELS.GRAPH_RESTORE, input),
  },
  events: {
    onInterrupted: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as Parameters<typeof callback>[0])
      }
      ipcRenderer.on(IPC_CHANNELS.GRAPH_INTERRUPTED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.GRAPH_INTERRUPTED, listener)
      }
    },
    onCompleted: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as Parameters<typeof callback>[0])
      }
      ipcRenderer.on(IPC_CHANNELS.GRAPH_COMPLETED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.GRAPH_COMPLETED, listener)
      }
    },
    onError: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as Parameters<typeof callback>[0])
      }
      ipcRenderer.on(IPC_CHANNELS.GRAPH_ERROR, listener)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.GRAPH_ERROR, listener)
      }
    },
    onProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as Parameters<typeof callback>[0])
      }
      ipcRenderer.on(IPC_CHANNELS.GRAPH_PROGRESS, listener)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.GRAPH_PROGRESS, listener)
      }
    },
    onState: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as Parameters<typeof callback>[0])
      }
      ipcRenderer.on(IPC_CHANNELS.GRAPH_STATE, listener)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.GRAPH_STATE, listener)
      }
    },
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
