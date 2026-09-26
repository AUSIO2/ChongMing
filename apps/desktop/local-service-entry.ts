import { RuntimeMessage } from '../../contracts/messages'
import path from 'node:path'
import { localCreateRuntime } from '../local-server/runtime'
import { localReadConfiguration } from '../config/local-settings'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRegisterBoundary, processRunClose } from '../../platform/node/process-boundary'

let runtime: Awaited<ReturnType<typeof localCreateRuntime>> | undefined
let stopping = false, starting: Promise<void> | undefined
let stopTask: Promise<void> | undefined
const dataDirectory = process.env.CHONGMING_DESKTOP_DATA_DIR
const reporter = diagnosticCreateReporter({ component: 'desktop-service',
  ...(dataDirectory && path.isAbsolute(dataDirectory) ? { filename: path.join(dataDirectory, 'service-diagnostics.log') } : {}) })
processRegisterBoundary({ component: 'desktop-service', reporter })
// 用途：关闭服务，并释放相关资源。
function desktopCloseService(): Promise<void> {
  stopping = true
  return stopTask ??= (async () => {
    await starting?.catch(() => {})
    await runtime?.close()
    if (process.connected) process.disconnect()
  })()
}
// 用途：停止服务，并释放相关资源。
function desktopStopService(reason: string): void {
  void processRunClose({ reporter, component: 'desktop-service', timeoutMs: 15_000, close: desktopCloseService })
    .then(okay => { process.exitCode = okay ? process.exitCode ?? 0 : 1 })
    .catch(error => { reporter.report({ name: 'shutdown.handler.failed', severity: 'fatal', context: { reason }, error }); process.exit(1) })
}
process.once('disconnect', () => desktopStopService('disconnect'))
process.once('SIGINT', () => desktopStopService('SIGINT'))
process.once('SIGTERM', () => desktopStopService('SIGTERM'))
process.on('message', message => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'stop') return
  void desktopCloseService()
})
// 用途：启动服务流程，并返回执行结果。
async function desktopStartService() {
  const directory = dataDirectory
  if (!directory || !path.isAbsolute(directory) || !process.send) throw new Error(RuntimeMessage.DESKTOP_SERVICE_REQUIRES_A_PARENT_IPC_CHANNEL_AND_FIXED_DATA_DIRECTORY)
  const local = await localReadConfiguration()
  runtime = await localCreateRuntime({ directory, port: 0, reporter,
    env: Object.fromEntries(Object.entries(local.secrets).filter(([name]) => process.env[name] === undefined)) })
  if (stopping) return
  process.send({ type: 'ready', baseUrl: runtime.baseUrl, token: runtime.userToken }, (error: Error | null) => { if (error) void desktopCloseService() })
}
starting = desktopStartService()
void starting.catch(async error => {
  const errorId = reporter.report({ name: 'process.start.failed', severity: 'fatal', context: { phase: 'desktop-service' }, error })
  if (process.connected) process.send?.({ type: 'failed', message: RuntimeMessage.LOCAL_SERVICE_START_FAILED_WITH_ERROR_ID, errorId }, () => {})
  process.exitCode = 1
  stopping = true
  await runtime?.close().catch(closeError => reporter.report({ name: 'startup.cleanup.failed', severity: 'error', error: closeError }))
  if (process.connected) process.disconnect()
}).catch(error => { reporter.report({ name: 'startup.handler.failed', severity: 'fatal', error }); process.exit(1) })
