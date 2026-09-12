import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { clientCreateGateway } from '../client/api'
import { clientRegisterIpc } from './client-ipc'
import { clientCreateStorage } from './client-storage'

const directory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(directory, '..')
const developmentUrl = process.env.VITE_DEV_SERVER_URL
const rendererUrl = developmentUrl ?? pathToFileURL(path.join(projectRoot, 'dist/index.html')).href
let window: BrowserWindow | null = null
let dispose: (() => void) | undefined
let gateway: ReturnType<typeof clientCreateGateway> | undefined

function clientCreateWindow(): void {
  window = new BrowserWindow({
    title: '重明', width: 1280, height: 840, minWidth: 960, minHeight: 640,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: { preload: path.join(directory, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.on('closed', () => { window = null })
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(path.join(projectRoot, 'dist/index.html'))
}

app.whenReady().then(() => {
  gateway = clientCreateGateway({
    baseUrl: 'http://127.0.0.1:4320',
    store: clientCreateStorage({ directory: app.getPath('userData'), secure: safeStorage }),
  })
  dispose = clientRegisterIpc({ ipc: ipcMain, gateway, rendererUrl, contents: () => window?.webContents ?? null })
  clientCreateWindow()
})
app.on('activate', () => { if (gateway && app.isReady() && !window) clientCreateWindow() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  dispose?.()
  gateway?.close() // Keep OS-encrypted login data; only explicit disconnect forgets it.
})
