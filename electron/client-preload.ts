import { contextBridge, ipcRenderer } from 'electron'
import { CLIENT_CHANNELS } from './client-channels'
import type { ClientBridge } from '../contracts/client'

const bridge: ClientBridge = {
  getConnection: () => ipcRenderer.invoke(CLIENT_CHANNELS.connection),
  connect: input => ipcRenderer.invoke(CLIENT_CHANNELS.connect, input),
  disconnect: () => ipcRenderer.invoke(CLIENT_CHANNELS.disconnect),
  read: (callId, method, params) => ipcRenderer.invoke(CLIENT_CHANNELS.read, callId, method, params),
  dispatch: (callId, requestId, method, params) => ipcRenderer.invoke(CLIENT_CHANNELS.dispatch, callId, requestId, method, params),
  cancel: callId => { ipcRenderer.send(CLIENT_CHANNELS.cancel, callId) },
}
contextBridge.exposeInMainWorld('chongmingClient', bridge)
