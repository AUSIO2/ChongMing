import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from './api/channels'
import type { ElectronAPI } from './api/types'

const electronAPI: ElectronAPI = {
  news: {
    create: input => ipcRenderer.invoke(IPC_CHANNELS.NEWS_CREATE, input),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.NEWS_LIST),
    get: newsId => ipcRenderer.invoke(IPC_CHANNELS.NEWS_GET, newsId),
    update: (newsId, patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.NEWS_UPDATE, newsId, patch),
  },
  claims: {
    list: newsId => ipcRenderer.invoke(IPC_CHANNELS.CLAIMS_LIST, newsId),
    create: (newsId, input) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIMS_CREATE, newsId, input),
    update: (newsId, claimId, patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIMS_UPDATE, newsId, claimId, patch),
    delete: (newsId, claimId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIMS_DELETE, newsId, claimId),
  },
  graph: {
    startSplit: input =>
      ipcRenderer.invoke(IPC_CHANNELS.GRAPH_START_SPLIT, input),
    startVerify: input =>
      ipcRenderer.invoke(IPC_CHANNELS.GRAPH_START_VERIFY, input),
    resume: (runId, modifications) =>
      ipcRenderer.invoke(IPC_CHANNELS.GRAPH_RESUME, runId, modifications),
    setMode: (runId, mode) =>
      ipcRenderer.invoke(IPC_CHANNELS.GRAPH_SET_MODE, runId, mode),
    cancel: runId => ipcRenderer.invoke(IPC_CHANNELS.GRAPH_CANCEL, runId),
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
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
