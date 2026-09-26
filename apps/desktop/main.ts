import { RuntimeMessage } from '../../contracts/messages'
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { clientRegisterIpc } from './ipc-handlers'
import { clientCreateService } from './local-service-process'
import { clientCreateDesktop } from './connection-manager'
import { CLIENT_CHANNELS } from './ipc-channels'
import { clientCreateStorage } from './credential-store'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRegisterBoundary } from '../../platform/node/process-boundary'
import { mkdir } from 'node:fs/promises'

const directory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(directory, '..')
const developmentUrl = process.env.VITE_DEV_SERVER_URL
const rendererUrl = developmentUrl ?? pathToFileURL(path.join(projectRoot, 'dist/index.html')).href
let window: BrowserWindow | null = null
let dispose: (() => void) | undefined
let desktop: ReturnType<typeof clientCreateDesktop> | undefined
let quitting = false, quitReady = false
let failureShown = false
let reporter = diagnosticCreateReporter({ component: 'electron-main' })
processRegisterBoundary({ component: 'electron-main', reporter })

// 用途：处理客户端请求相关工作，并把结果交给调用方。
function clientShowFailure(errorId: string): void {
  if (failureShown) return
  failureShown = true
  void dialog.showMessageBox({ type: 'error', title: '重明界面发生错误',
    message: RuntimeMessage.LOCAL_SERVICE_DATA_RETAINED, detail: `错误编号：${errorId}`,
    buttons: ['重新打开界面', '退出'], defaultId: 0, cancelId: 1,
  }).then(result => {
    if (result.response === 1) { app.quit(); return }
    if (!desktop || quitting) return
    window?.destroy(); window = null; failureShown = false; clientCreateWindow()
  }).catch(error => {
    reporter.report({ name: 'renderer.recovery.failed', severity: 'error', errorId, error })
    app.quit()
  })
}

// 用途：创建客户端请求，供后续流程使用。
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
  window.webContents.on('did-finish-load', () => { failureShown = false })
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || quitting) return
    const errorId = reporter.report({ name: 'renderer.load.failed', severity: 'error', context: { reason: code } })
    clientShowFailure(errorId)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || quitting) return
    const errorId = reporter.report({ name: 'renderer.process.gone', severity: 'error', context: { reason: details.reason, phase: details.exitCode } })
    clientShowFailure(errorId)
  })
  window.webContents.on('unresponsive', () => {
    const errorId = reporter.report({ name: 'renderer.unresponsive', severity: 'warn' })
    clientShowFailure(errorId)
  })
  window.webContents.on('responsive', () => reporter.report({ name: 'renderer.responsive', severity: 'info' }))
  window.on('closed', () => { window = null })
  const loaded = developmentUrl ? window.loadURL(developmentUrl) : window.loadFile(path.join(projectRoot, 'dist/index.html'))
  void loaded.catch(error => {
    if (quitting) return
    const errorId = reporter.report({ name: 'renderer.load.rejected', severity: 'error', error })
    clientShowFailure(errorId)
  })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (!window && desktop) clientCreateWindow()
    if (window?.isMinimized()) window.restore()
    window?.show(); window?.focus()
  })
  app.on('child-process-gone', (_event, details) => reporter.report({ name: 'electron.child.gone', severity: 'error',
    context: { reason: details.reason, phase: details.type } }))
  app.whenReady().then(async () => {
    const data = app.getPath('userData')
    await mkdir(data, { recursive: true, mode: 0o700 })
    await reporter.close()
    reporter = diagnosticCreateReporter({ component: 'electron-main', filename: path.join(data, 'main-diagnostics.log') })
    const service = clientCreateService({
      runtimeDirectory: app.isPackaged ? path.join(process.resourcesPath, 'local-runtime') : path.join(projectRoot, '.desktop-runtime'),
      dataDirectory: path.join(data, 'local-service'), configDirectory: process.env.CHONGMING_CONFIG_DIR ?? path.join(data, 'host-config'),
      onState: state => {
        if (state.status === 'failed') reporter.report({ name: 'local-service.failed', severity: 'error', errorId: state.errorId })
        if (window && !window.webContents.isDestroyed()) window.webContents.send(CLIENT_CHANNELS.localChanged, state)
      },
    })
    desktop = clientCreateDesktop({ directory: data, remoteStore: clientCreateStorage({ directory: data, secure: safeStorage }), service })
    dispose = clientRegisterIpc({ ipc: ipcMain, gateway: desktop.gateway, localState: service.state, diagnostics: reporter, rendererUrl, contents: () => window?.webContents ?? null })
    clientCreateWindow()
  }).catch(error => {
    reporter.report({ name: 'electron.start.failed', severity: 'fatal', error })
    app.exit(1)
  })
  app.on('activate', () => { if (desktop && app.isReady() && !window) clientCreateWindow() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', event => {
    if (quitReady) return
    event.preventDefault()
    if (quitting) return
    quitting = true; dispose?.()
    void (desktop?.close() ?? Promise.resolve()).catch(error => reporter.report({ name: 'electron.shutdown.failed', severity: 'error', error }))
      .finally(() => { quitReady = true; void reporter.close(); app.quit() })
  })
}
