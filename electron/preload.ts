import { contextBridge } from 'electron'
import type { ElectronAPI } from './shared/electron-api'

const electronAPI: ElectronAPI = {}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
