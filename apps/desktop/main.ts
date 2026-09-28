// Electron 主进程入口：装配安全窗口、桌面连接与本地服务，并处理恢复及退出。
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

function clientShowFailure(/* 已记录故障的关联编号，展示给用户以便定位日志。 */ errorId: string): void {
  // 仅显示一次界面故障提示，让用户重新创建窗口或退出并保留诊断编号。
  if (failureShown) return
  failureShown = true
  void dialog.showMessageBox({ type: 'error', title: '重明界面发生错误',
    message: RuntimeMessage.LOCAL_SERVICE_DATA_RETAINED, detail: `错误编号：${errorId}`,
    buttons: ['重新打开界面', '退出'], defaultId: 0, cancelId: 1,
  }).then(/* 原生提示框返回的按钮选择，用于决定退出或重建界面。 */ result => {
    // 按用户选择退出或重建窗口，退出期间不再恢复界面。
    if (result.response === 1) { app.quit(); return }
    if (!desktop || quitting) return
    window?.destroy(); window = null; failureShown = false; clientCreateWindow()
  }).catch(/* 显示或处理恢复提示时产生的异常，记录后退出。 */ error => {
    // 界面恢复提示处理失败时记录诊断并退出应用。
    reporter.report({ name: 'renderer.recovery.failed', severity: 'error', errorId, error })
    app.quit()
  })
}

function clientCreateWindow(): void {
  // 创建隔离且受限的窗口，注册导航限制与渲染器故障恢复处理。
  window = new BrowserWindow({
    title: '重明', width: 1280, height: 840, minWidth: 960, minHeight: 640,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: { preload: path.join(directory, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  window.webContents.setWindowOpenHandler(() => /* 拒绝由页面发起的新窗口。 */  ({ action: 'deny' }))
  window.webContents.on('will-navigate', /* 页面准备导航的 Electron 事件，通过 preventDefault 阻止跳转。 */ event => /* 阻止页面跳转离开应用入口。 */  event.preventDefault())
  window.webContents.on('will-attach-webview', /* 页面准备挂载 webview 的 Electron 事件，通过取消阻止嵌入。 */ event => /* 阻止嵌入 webview 扩大页面访问面。 */  event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((/* 发起权限请求的窗口内容，此处统一拒绝所以不读取。 */ _contents, /* 页面请求的权限种类，此处不按种类开放权限。 */ _permission, /* Electron 提供的授权答复函数，传 false 拒绝请求。 */ callback) => /* 拒绝页面请求的额外系统权限。 */  callback(false))
  window.webContents.on('did-finish-load', () => {
    // 页面成功加载后允许再次显示未来故障提示。
     failureShown = false })
  window.webContents.on('did-fail-load', (/* 加载失败事件对象，此处仅使用后续故障字段。 */ _event, /* Chromium 加载失败码，负三表示主动取消并被忽略。 */ code, /* 引擎提供的故障描述，此处不转入公开诊断。 */ _description, /* 本次失败加载的地址，此处不记录以免泄漏地址信息。 */ _url, /* 是否为主框架加载，子框架失败不会触发整窗恢复提示。 */ isMainFrame) => {
    // 忽略子框架和主动取消，主框架加载失败时记录诊断并提示恢复。
    if (!isMainFrame || code === -3 || quitting) return
    const errorId = reporter.report({ name: 'renderer.load.failed', severity: 'error', context: { reason: code } })
    clientShowFailure(errorId)
  })
  window.webContents.on('render-process-gone', (/* 渲染进程退出事件对象，此处不读取。 */ _event, /* Electron 给出的退出原因与退出码，用于判定异常退出并记录。 */ details) => {
    // 在非正常渲染器退出时记录原因并提示重新打开界面。
    if (details.reason === 'clean-exit' || quitting) return
    const errorId = reporter.report({ name: 'renderer.process.gone', severity: 'error', context: { reason: details.reason, phase: details.exitCode } })
    clientShowFailure(errorId)
  })
  window.webContents.on('unresponsive', () => {
    // 记录界面失去响应并显示恢复选项。
    const errorId = reporter.report({ name: 'renderer.unresponsive', severity: 'warn' })
    clientShowFailure(errorId)
  })
  window.webContents.on('responsive', () => /* 记录渲染器恢复响应的事件。 */  reporter.report({ name: 'renderer.responsive', severity: 'info' }))
  window.on('closed', () => {
    // 窗口关闭后清空引用，使后续激活可以重新创建窗口。
     window = null })
  const loaded = developmentUrl ? window.loadURL(developmentUrl) : window.loadFile(path.join(projectRoot, 'dist/index.html'))
  void loaded.catch(/* loadURL/loadFile 拒绝原因，退出期间忽略。 */ error => {
    // 在页面加载 Promise 拒绝时记录故障并提示恢复，应用退出时跳过提示。
    if (quitting) return
    const errorId = reporter.report({ name: 'renderer.load.rejected', severity: 'error', error })
    clientShowFailure(errorId)
  })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    // 第二实例请求到来时恢复并聚焦现有窗口，必要时重建窗口。
    if (!window && desktop) clientCreateWindow()
    if (window?.isMinimized()) window.restore()
    window?.show(); window?.focus()
  })
  app.on('child-process-gone', (/* 辅助进程退出事件对象，此处不读取。 */ _event, /* 辅助进程的类型和退出原因，记录为关联诊断。 */ details) => /* 记录 Electron 辅助进程退出的原因和进程类型。 */  reporter.report({ name: 'electron.child.gone', severity: 'error',
    context: { reason: details.reason, phase: details.type } }))
  app.whenReady().then(async () => {
    // 应用就绪后建立用户目录与日志，装配本地服务、连接存储、IPC 和主窗口。
    const data = app.getPath('userData')
    await mkdir(data, { recursive: true, mode: 0o700 })
    await reporter.close()
    reporter = diagnosticCreateReporter({ component: 'electron-main', filename: path.join(data, 'main-diagnostics.log') })
    const service = clientCreateService({
      runtimeDirectory: app.isPackaged ? path.join(process.resourcesPath, 'local-runtime') : path.join(projectRoot, '.desktop-runtime'),
      dataDirectory: path.join(data, 'local-service'), configDirectory: process.env.CHONGMING_CONFIG_DIR ?? path.join(data, 'host-config'),
      onState: /* 本地服务刚发布的无凭据状态，转发给仍存在的界面。 */ state => {
        // 记录本地服务故障，并把最新状态发送给仍存在的渲染器。
        if (state.status === 'failed') reporter.report({ name: 'local-service.failed', severity: 'error', errorId: state.errorId })
        if (window && !window.webContents.isDestroyed()) window.webContents.send(CLIENT_CHANNELS.localChanged, state)
      },
    })
    desktop = clientCreateDesktop({ directory: data, remoteStore: clientCreateStorage({ directory: data, secure: safeStorage }), service })
    dispose = clientRegisterIpc({ ipc: ipcMain, gateway: desktop.gateway, localState: service.state, diagnostics: reporter, rendererUrl, contents: () => /* 在每次 IPC 权限检查时取得当前窗口内容，避免使用已销毁窗口的引用。 */  window?.webContents ?? null })
    clientCreateWindow()
  }).catch(/* 桌面装配或创建窗口阶段的失败原因，按致命故障记录。 */ error => {
    // 主进程启动失败时记录致命诊断并以失败码退出。
    reporter.report({ name: 'electron.start.failed', severity: 'fatal', error })
    app.exit(1)
  })
  app.on('activate', () => {
    // 应用激活且没有窗口时重新创建界面。
     if (desktop && app.isReady() && !window) clientCreateWindow() })
  app.on('window-all-closed', () => {
    // 非 macOS 平台关闭全部窗口后退出应用。
     if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', /* 应用准备退出的可取消事件，首次收到时延迟到资源收尾完成。 */ event => {
    // 拦截首次退出，卸载 IPC 并等待桌面服务清理，避免进程抢先结束。
    if (quitReady) return
    event.preventDefault()
    if (quitting) return
    quitting = true; dispose?.()
    void (desktop?.close() ?? Promise.resolve()).catch(/* 桌面关闭 Promise 的拒绝原因，记录后仍继续应用退出。 */ error => /* 记录桌面清理失败，仍让退出收尾继续。 */  reporter.report({ name: 'electron.shutdown.failed', severity: 'error', error }))
      .finally(() => {
        // 标记清理完成并关闭日志，再次发起应用退出。
         quitReady = true; void reporter.close(); app.quit() })
  })
}
