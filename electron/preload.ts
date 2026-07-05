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
  },
  catalog: {
    list: module => ipcRenderer.invoke(IPC_CHANNELS.CATALOG_LIST, module),
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
