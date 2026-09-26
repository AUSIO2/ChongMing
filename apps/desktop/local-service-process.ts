import { RuntimeMessage, messageFormat } from '../../contracts/messages'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { LocalServiceState } from '../../contracts/desktop'
import { ClientError } from '../../contracts/client'
import { randomUUID } from 'node:crypto'

// 用途：创建服务，供后续流程使用。
export function clientCreateService(input: {
  runtimeDirectory: string; dataDirectory: string; configDirectory: string
  startupMs?: number; shutdownMs?: number; onState?: (state: LocalServiceState) => void
}) {
  let child: ChildProcess | undefined, starting: Promise<{ baseUrl: string; token: string }> | undefined
  let ready: { baseUrl: string; token: string } | undefined, closing: Promise<void> | undefined
  let state: LocalServiceState = { status: 'stopped' }, exited: Promise<void> = Promise.resolve()
  // 用途：更新客户端请求，并保持相关状态一致。
  function clientUpdateState(next: LocalServiceState) { state = next; input.onState?.({ ...next }) }
  // 用途：创建服务错误，供后续流程使用。
  function clientCreateServiceError(message: string, errorId?: string) { return new ClientError({ code: 'LOCAL_SERVICE_FAILED', message, status: 0, retryable: true, errorId }) }
  // 用途：处理客户端请求相关工作，并把结果交给调用方。
  async function clientKillService(process: ChildProcess, force: boolean) {
    if (!process.pid || process.exitCode !== null || process.signalCode !== null) return
    if (globalThis.process.platform === 'win32') {
      await new Promise<void>(resolve => execFile('taskkill', ['/PID', String(process.pid), '/T', ...(force ? ['/F'] : [])], () => resolve()))
    } else {
      try { globalThis.process.kill(-process.pid, force ? 'SIGKILL' : 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  // 用途：处理客户端请求相关工作，并把结果交给调用方。
  async function clientWaitExit(milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })]) }
    finally { clearTimeout(timer) }
  }
  // 用途：停止客户端请求，并释放相关资源。
  async function clientStopChild() {
    const current = child
    if (!current) return
    if (current.connected) current.send({ type: 'stop' }, () => {})
    if (!await clientWaitExit(input.shutdownMs ?? 20000)) {
      await clientKillService(current, false)
      if (!await clientWaitExit(2000)) {
        await clientKillService(current, true)
        if (!await clientWaitExit(1000)) throw clientCreateServiceError(RuntimeMessage.LOCAL_SERVICE_PROCESS_EXIT_UNCONFIRMED)
      }
    }
  }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  function start(): Promise<{ baseUrl: string; token: string }> {
    if (closing) return Promise.reject(clientCreateServiceError(RuntimeMessage.APPLICATION_IS_EXITING))
    if (ready) return Promise.resolve(ready)
    return starting ??= (async () => {
      clientUpdateState({ status: 'starting' })
      await mkdir(input.dataDirectory, { recursive: true, mode: 0o700 })
      try {
        const env = { ...process.env, PATH: path.join(input.runtimeDirectory, 'bin') + path.delimiter + (process.env.PATH ?? ''), CHONGMING_DESKTOP_DATA_DIR: input.dataDirectory, CHONGMING_CONFIG_DIR: input.configDirectory }
        for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VITE_DEV_SERVER_URL', 'CHONGMING_USER_TOKEN', 'CHONGMING_DATA_TOKEN', 'CHONGMING_AMQP_URL']) delete env[key as keyof typeof env]
        const current = child = spawn(path.join(input.runtimeDirectory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
          [path.join(input.runtimeDirectory, 'service', 'main.mjs')], {
            cwd: input.runtimeDirectory, env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          })
        exited = new Promise<void>(resolve => { current.once('exit', () => resolve()); current.once('error', () => resolve()) })
        ready = await new Promise<{ baseUrl: string; token: string }>((resolve, reject) => {
          let settled = false
          const timer = setTimeout(() => finish(clientCreateServiceError(RuntimeMessage.LOCAL_SERVICE_START_TIMEOUT)), input.startupMs ?? 30000)
          // 用途：结束当前异步操作并收敛结果。
          function finish(error?: Error, connection?: { baseUrl: string; token: string }) {
            if (settled) return
            settled = true; clearTimeout(timer)
            current.removeListener('message', message)
            if (error) reject(error)
            else resolve(connection!)
          }
          // 用途：处理当前模块相关工作，并把结果交给调用方。
          function message(value: unknown) {
            if (!value || typeof value !== 'object') return
            const item = value as Record<string, unknown>
            if (item.type === 'failed') {
              const message = typeof item.message === 'string' ? item.message.slice(0, 1000) : RuntimeMessage.LOCAL_SERVICE_START_FAILED
              const errorId = typeof item.errorId === 'string' && /^[0-9a-f-]{36}$/i.test(item.errorId) ? item.errorId : undefined
              if (errorId) clientUpdateState({ status: 'failed', message, errorId })
              finish(clientCreateServiceError(message, errorId)); return
            }
            if (item.type !== 'ready' || typeof item.baseUrl !== 'string' || typeof item.token !== 'string') return
            let url: URL
            try { url = new URL(item.baseUrl) } catch { finish(clientCreateServiceError(RuntimeMessage.LOCAL_SERVICE_INVALID_ADDRESS)); return }
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !/^[A-Za-z0-9_-]{32,256}$/.test(item.token)) {
              finish(clientCreateServiceError(RuntimeMessage.LOCAL_SERVICE_INVALID_CONNECTION)); return
            }
            finish(undefined, { baseUrl: url.origin, token: item.token })
          }
          current.on('message', message)
          current.once('error', () => finish(clientCreateServiceError(RuntimeMessage.LOCAL_RUNTIME_START_FAILED_PACKAGE)))
          current.once('exit', (code, signal) => {
            ready = undefined
            if (!closing) clientUpdateState({ status: 'failed', message: RuntimeMessage.LOCAL_SERVICE_STOPPED_RETRY, errorId: randomUUID() })
            finish(clientCreateServiceError(messageFormat(RuntimeMessage.LOCAL_SERVICE_EXITED_BEFORE_READY, signal ?? code)))
          })
        })
        if (closing) { await clientStopChild(); throw clientCreateServiceError(RuntimeMessage.APPLICATION_IS_EXITING) }
        clientUpdateState({ status: 'running' })
        return ready
      } finally { /* the child writes bounded diagnostics itself */ }
    })().catch(async error => {
      await clientStopChild()
      if (!closing && state.status !== 'failed') clientUpdateState({ status: 'failed', message: RuntimeMessage.LOCAL_SERVICE_START_FAILED_RETRY,
        errorId: error instanceof ClientError ? error.errorId : randomUUID() })
      throw error
    }).finally(() => { starting = undefined })
  }
  return {
    start,
    state: () => ({ ...state }),
    // 用途：关闭当前模块并释放占用的资源。
    close() {
      return closing ??= (async () => {
        clientUpdateState({ status: 'stopping' })
        await starting?.catch(() => {})
        await clientStopChild()
        ready = undefined; child = undefined; clientUpdateState({ status: 'stopped' })
      })()
    },
  }
}
export type ClientService = ReturnType<typeof clientCreateService>
