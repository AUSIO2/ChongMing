import { contextBridge, ipcRenderer } from 'electron'
import { CLIENT_CHANNELS } from './ipc-channels'
import type { ClientBridge } from '../../contracts/client'

const bridge: ClientBridge = {
  connectLocal: () => ipcRenderer.invoke(CLIENT_CHANNELS.connectLocal),
  localState: () => ipcRenderer.invoke(CLIENT_CHANNELS.localState),
  onLocalState: listener => {
    const receive = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
    ipcRenderer.on(CLIENT_CHANNELS.localChanged, receive)
    return () => { ipcRenderer.removeListener(CLIENT_CHANNELS.localChanged, receive) }
  },
  reportError: input => { ipcRenderer.send(CLIENT_CHANNELS.diagnostic, input) },
  watch: (watchId, mapId) => ipcRenderer.invoke(CLIENT_CHANNELS.watch, watchId, mapId),
  onStream: listener => {
    const receive = (_event: Electron.IpcRendererEvent, message: Parameters<Parameters<ClientBridge['onStream']>[0]>[0]) => listener(message)
    ipcRenderer.on(CLIENT_CHANNELS.stream, receive)
    return () => { ipcRenderer.removeListener(CLIENT_CHANNELS.stream, receive) }
  },
  getConnection: () => ipcRenderer.invoke(CLIENT_CHANNELS.connection),
  connect: input => ipcRenderer.invoke(CLIENT_CHANNELS.connect, input),
  disconnect: () => ipcRenderer.invoke(CLIENT_CHANNELS.disconnect),
  read: (callId, method, params) => ipcRenderer.invoke(CLIENT_CHANNELS.read, callId, method, params),
  dispatch: (callId, requestId, method, params) => ipcRenderer.invoke(CLIENT_CHANNELS.dispatch, callId, requestId, method, params),
  upload: (callId, requestId, input) => ipcRenderer.invoke(CLIENT_CHANNELS.upload, callId, requestId, input),
  download: (callId, input) => ipcRenderer.invoke(CLIENT_CHANNELS.download, callId, input),
  cancel: callId => { ipcRenderer.send(CLIENT_CHANNELS.cancel, callId) },
}
contextBridge.exposeInMainWorld('chongmingClient', bridge)
