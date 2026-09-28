// 桌面本地服务子进程入口：通过父进程 IPC 报告就绪并响应关闭或失联。
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
function desktopCloseService(): Promise<void> {
  // 标记停止并复用一次关闭任务，等待启动交接后关闭运行时及父进程 IPC。
  stopping = true
  return stopTask ??= (async () => {
    // 等待正在启动的运行时稳定后释放服务资源，最后断开 IPC。
    await starting?.catch(() => {
      // 启动失败由入口失败分支报告，此处继续完成关闭。
      })
    await runtime?.close()
    if (process.connected) process.disconnect()
  })()
}
function desktopStopService(/* 触发关闭的信号或父进程断开原因，仅用于诊断关联。 */ reason: string): void {
  // 在有界关闭流程中停止服务，并用退出码表达关闭是否完成。
  void processRunClose({ reporter, component: 'desktop-service', timeoutMs: 15_000, close: desktopCloseService })
    .then(/* 有界关闭是否成功完成，用于选择退出码。 */ okay => {
      // 依据关闭结果保留既有失败码或标记关闭失败。
       process.exitCode = okay ? process.exitCode ?? 0 : 1 })
    .catch(/* 关闭协调逻辑自身抛出的错误，需要致命记录后退出。 */ error => {
      // 记录关闭处理器自身的致命错误并强制退出。
       reporter.report({ name: 'shutdown.handler.failed', severity: 'fatal', context: { reason }, error }); process.exit(1) })
}
process.once('disconnect', () => /* 父进程 IPC 断开时启动有界关闭。 */  desktopStopService('disconnect'))
process.once('SIGINT', () => /* 收到中断信号时启动有界关闭。 */  desktopStopService('SIGINT'))
process.once('SIGTERM', () => /* 收到终止信号时启动有界关闭。 */  desktopStopService('SIGTERM'))
process.on('message', /* 父进程通过 IPC 发送的原始消息，只接受对象型 stop 指令。 */ message => {
  // 仅处理父进程的停止消息，触发共享关闭任务。
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'stop') return
  void desktopCloseService()
})
async function desktopStartService() {
  // 校验父进程通道与固定目录，启动独立本地运行时并通过 IPC 返回连接凭据。
  const directory = dataDirectory
  if (!directory || !path.isAbsolute(directory) || !process.send) throw new Error(RuntimeMessage.DESKTOP_SERVICE_REQUIRES_A_PARENT_IPC_CHANNEL_AND_FIXED_DATA_DIRECTORY)
  const local = await localReadConfiguration()
  runtime = await localCreateRuntime({ directory, port: 0, reporter,
    env: Object.fromEntries(Object.entries(local.secrets).filter((/* 本机密钥条目，仅取名称检查进程环境是否已有显式配置。 */ [name]) => /* 仅补充环境中尚未设置的本机密钥，保留显式环境配置优先级。 */  process.env[name] === undefined)) })
  if (stopping) return
  process.send({ type: 'ready', baseUrl: runtime.baseUrl, token: runtime.userToken }, (/* 就绪消息发送错误；null 表示发送成功，否则启动清理。 */ error: Error | null) => {
    // 就绪消息发送失败时收回服务，避免留下父进程不可达的运行时。
     if (error) void desktopCloseService() })
}
starting = desktopStartService()
void starting.catch(async /* 本地服务启动失败原因，用于生成诊断编号并通知父进程。 */ error => {
  // 报告启动失败并通知父进程，关闭已创建的运行时后断开 IPC。
  const errorId = reporter.report({ name: 'process.start.failed', severity: 'fatal', context: { phase: 'desktop-service' }, error })
  if (process.connected) process.send?.({ type: 'failed', message: RuntimeMessage.LOCAL_SERVICE_START_FAILED_WITH_ERROR_ID, errorId }, () => {
    // 观察失败通知发送完成，不让通知发送失败阻止后续资源清理。
    })
  process.exitCode = 1
  stopping = true
  await runtime?.close().catch(/* 启动失败后清理部分运行时遇到的次级错误。 */ closeError => /* 将启动失败后的运行时清理错误写入诊断日志。 */  reporter.report({ name: 'startup.cleanup.failed', severity: 'error', error: closeError }))
  if (process.connected) process.disconnect()
}).catch(/* 启动失败处理器自身再次拒绝的原因，需记录并立即退出。 */ error => {
  // 报告启动错误处理流程自身的失败并退出进程。
   reporter.report({ name: 'startup.handler.failed', severity: 'fatal', error }); process.exit(1) })
