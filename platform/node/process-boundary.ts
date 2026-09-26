import { RuntimeMessage } from '../../contracts/messages'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import { diagnosticWriteFatal } from './diagnostics'

// 用途：处理进程相关工作，并把结果交给调用方。
export function processRegisterBoundary(input: { component: string; reporter?: DiagnosticReporter }): () => void {
  let fatal = false
  const stop = (error: unknown, origin: string) => {
    if (fatal) return process.exit(1)
    fatal = true
    diagnosticWriteFatal(input.component, origin, error)
    process.exit(1)
  }
  const exception = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => stop(error, origin)
  const rejection = (reason: unknown) => stop(reason, 'unhandledRejection')
  process.on('uncaughtException', exception)
  process.on('unhandledRejection', rejection)
  return () => { process.removeListener('uncaughtException', exception); process.removeListener('unhandledRejection', rejection) }
}

// 用途：执行进程流程，并返回执行结果。
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
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(RuntimeMessage.SHUTDOWN_DEADLINE_ELAPSED)), input.timeoutMs) }),
    ])
    input.reporter.report({ name: 'shutdown.completed', severity: 'info', context: { phase: Math.round(performance.now() - started) } })
    return true
  } catch (error) {
    input.reporter.report({ name: 'shutdown.failed', severity: 'error', context: { phase: Math.round(performance.now() - started) }, error })
    return false
  } finally { clearTimeout(timer) }
}

// 用途：执行进程流程，并返回执行结果。
export function processRunEntry(input: {
  component: string
  reporter: DiagnosticReporter
  start: () => Promise<() => Promise<void>>
  timeoutMs?: number
}): void {
  const unregister = processRegisterBoundary({ component: input.component, reporter: input.reporter })
  let stopping = false, close: (() => Promise<void>) | undefined
  const starting = input.start().then(value => {
    close = value
  })
  // 用途：结束当前异步操作并收敛结果。
  async function finish(code: number, reason: string, error?: unknown) {
    if (stopping) return
    stopping = true
    if (error !== undefined) input.reporter.report({ name: 'process.start.failed', severity: 'fatal', context: { reason }, error })
    const okay = await processRunClose({ reporter: input.reporter, component: input.component, timeoutMs: input.timeoutMs ?? 15_000,
      close: async () => { await starting.catch(() => {}); await close?.() } })
    unregister()
    await input.reporter.close().catch(() => {})
    process.exit(code || (okay ? 0 : 1))
  }
  starting.catch(error => { void finish(1, 'startup', error) })
  process.once('SIGINT', () => { void finish(0, 'SIGINT') })
  process.once('SIGTERM', () => { void finish(0, 'SIGTERM') })
}
