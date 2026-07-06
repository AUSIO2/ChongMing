import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadEnv } from './shared/load-env'
import { handlerRegisterIpc } from './api/register-handlers'
import { dbCreate, dbDelete } from './shared/database'
import { dbReadSettings } from './shared/db-settings'
import { ckptCreate } from './shared/checkpointer'
import { promptUpdateConfigRoot } from './shared/prompt-loader'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')
loadEnv(process.env.APP_ROOT)
promptUpdateConfigRoot(path.join(process.env.APP_ROOT, 'subagentconfig'))

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null

function getWindow(): BrowserWindow | null {
  return win
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: '崇明',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

handlerRegisterIpc(getWindow)

app.on('before-quit', () => {
  void dbDelete()
})

app.whenReady().then(async () => {
  await dbCreate(dbReadSettings().uri)
  await ckptCreate()
  createWindow()
})
