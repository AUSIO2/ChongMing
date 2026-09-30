// 为 Node 入口提供未捕获错误边界、带截止时间的关闭及信号退出协调。
import { RuntimeMessage } from '../../contracts/messages'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import { diagnosticWriteFatal } from './diagnostics'

/**
 * 注册未捕获异常和未处理拒绝的致命边界，并返回只移除本次监听器的函数。
 *
 * @param input 组件标识和可选诊断依赖；当前致命路径以组件名调用同步兜底输出。
 */
export function processRegisterBoundary(input: { component: string; reporter?: DiagnosticReporter }): () => void {
  let fatal = false
  /**
   * 首次致命错误同步写诊断后退出；重入时直接退出以避免递归故障。
   *
   * @param error 未捕获异常或未处理拒绝的原始值，记录后立即退出进程。
   * @param origin 故障边界的来源标签，用于区分异常与拒绝。
   */
  const stop = (error: unknown, origin: string) => {
    if (fatal) return process.exit(1)
    fatal = true
    diagnosticWriteFatal(input.component, origin, error)
    process.exit(1)
  }
  /**
   * @param error Node 交付的未捕获 Error，交给统一致命退出逻辑。
   * @param origin Node 报告的异常来源，保留到诊断上下文。
   */
  const exception = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => /* 把未捕获异常及其来源交给致命退出处理。 */  stop(error, origin)
  /**
   * @param reason 未处理 Promise 的拒绝值，可能并非 Error。
   */
  const rejection = (reason: unknown) => /* 把未处理拒绝交给致命退出处理并标注来源。 */  stop(reason, 'unhandledRejection')
  process.on('uncaughtException', exception)
  process.on('unhandledRejection', rejection)
  return () => {
    // 移除本次安装的两个进程错误监听器。
     process.removeListener('uncaughtException', exception); process.removeListener('unhandledRejection', rejection) }
}

/**
 * 在截止时间内等待关闭，记录耗时并返回成功状态；超时不取消仍在运行的关闭 Promise。
 *
 * @param input 关闭回调、诊断依赖与毫秒期限；超时只结束等待，不取消回调本身。
 */
export async function processRunClose(input: {
  reporter: DiagnosticReporter; component: string; timeoutMs: number
  close: () => Promise<void>
}): Promise<boolean> {
  const started = performance.now()
  input.reporter.report({ name: 'shutdown.started', severity: 'info' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      input.close(),
      new Promise<never>((_resolve, reject) => {
        // 为关闭过程建立拒绝计时器，确保等待有明确上限。
         timer = setTimeout(() => /* 关闭期限到达时拒绝计时等待。 */  reject(new Error(RuntimeMessage.SHUTDOWN_DEADLINE_ELAPSED)), input.timeoutMs) }),
    ])
    input.reporter.report({ name: 'shutdown.completed', severity: 'info', context: { phase: Math.round(performance.now() - started) } })
    return true
  } catch (error) {
    input.reporter.report({ name: 'shutdown.failed', severity: 'error', context: { phase: Math.round(performance.now() - started) }, error })
    return false
  } finally { clearTimeout(timer) }
}

/**
 * 启动入口并注册退出信号，启动失败或信号到来时统一等待资源关闭并退出。
 *
 * @param input 进程启动器及诊断依赖；启动器交回关闭函数，关闭上限缺省为 15000 毫秒。
 */
export function processRunEntry(input: {
  component: string
  reporter: DiagnosticReporter
  start: () => Promise<() => Promise<void>>
  timeoutMs?: number
}): void {
  const unregister = processRegisterBoundary({ component: input.component, reporter: input.reporter })
  let stopping = false, close: (() => Promise<void>) | undefined
  const starting = input.start().then(value => {
    // 保存启动返回的关闭函数，供后续信号处理使用。
    close = value
  })
  /**
   * 仅执行一次退出收尾，记录启动错误、限时关闭资源和诊断器，再选择退出码。
   *
   * @param code 本次退出请求的状态码，非零值优先于关闭结果保留。
   * @param reason 触发退出的启动失败或系统信号名称，用于诊断。
   * @param error 可选启动失败原因，正常信号退出时不提供。
   */
  async function finish(code: number, reason: string, error?: unknown) {
    if (stopping) return
    stopping = true
    if (error !== undefined) input.reporter.report({ name: 'process.start.failed', severity: 'fatal', context: { reason }, error })
    const okay = await processRunClose({ reporter: input.reporter, component: input.component, timeoutMs: input.timeoutMs ?? 15_000,
      close: async () => {
        // 等待启动交接资源后执行关闭，避免信号与启动并发时遗漏已创建资源。
         await starting.catch(() => {
        // 启动失败已由退出流程记录，此处仍继续执行可用的关闭函数。
        }); await close?.() } })
    unregister()
    await input.reporter.close().catch(() => {
      // 日志关闭失败不再阻止进程退出。
      })
    process.exit(code || (okay ? 0 : 1))
  }
  starting.catch(error => {
    // 启动 Promise 拒绝时进入失败退出流程。
     void finish(1, 'startup', error) })
  process.once('SIGINT', () => {
    // 收到中断信号时进入正常关闭流程。
     void finish(0, 'SIGINT') })
  process.once('SIGTERM', () => {
    // 收到终止信号时进入正常关闭流程。
     void finish(0, 'SIGTERM') })
}
