// 管理桌面持有的本地服务子进程，验证就绪凭据并有界等待退出。
import { RuntimeMessage, messageFormat } from '../../contracts/messages'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { LocalServiceState } from '../../contracts/desktop'
import { ClientError } from '../../contracts/client'
import { randomUUID } from 'node:crypto'

export function clientCreateService(/* 桌面持有的服务目录和配置；可选启动/关闭期限以毫秒计，状态回调不接收令牌。 */ input: {
  runtimeDirectory: string; dataDirectory: string; configDirectory: string
  startupMs?: number; shutdownMs?: number; onState?: (/* 发给调用方的服务状态副本，仅包含状态、公开故障说明和诊断编号。 */ state: LocalServiceState) => void
}) {
  // 管理桌面独占的本地服务子进程，合并并发启动，并在关闭时等待退出或升级终止信号。
  // 子进程、连接凭据和启动/关闭 Promise 由本实例持有；对外状态仅发布运行情况，不携带 token。
  let child: ChildProcess | undefined, starting: Promise<{ baseUrl: string; token: string }> | undefined
  let ready: { baseUrl: string; token: string } | undefined, closing: Promise<void> | undefined
  let state: LocalServiceState = { status: 'stopped' }, exited: Promise<void> = Promise.resolve()
  function clientUpdateState(/* 准备替换的进程状态，保存后以副本通知观察者。 */ next: LocalServiceState) {
    // 保存当前进程状态，并把副本交给界面观察者，避免观察者改写内部状态。
    state = next; input.onState?.({ ...next })
  }
  function clientCreateServiceError(/* 可向界面展示的本地进程故障说明。 */ message: string, /* 可选已有诊断编号；省略时由 ClientError 生成。 */ errorId?: string) {
    // 将本地进程故障转换为客户端可识别、允许重试且可关联诊断编号的错误。
    return new ClientError({ code: 'LOCAL_SERVICE_FAILED', message, status: 0, retryable: true, errorId })
  }
  async function clientKillService(/* 当前实例持有的服务子进程，按其 PID 终止整棵进程树。 */ process: ChildProcess, /* 是否使用强制结束；否则先尝试正常终止信号。 */ force: boolean) {
    // 按平台终止仍存活的服务进程树，必要时使用强制终止以收回其派生进程。
    if (!process.pid || process.exitCode !== null || process.signalCode !== null) return
    if (globalThis.process.platform === 'win32') {
      await new Promise<void>(/* taskkill 返回后恢复等待的完成函数，不代表服务已确认退出。 */ resolve =>
        /* 等待 taskkill 返回；是否已退出仍由调用方的退出等待确认。 */
        execFile('taskkill', ['/PID', String(process.pid), '/T', ...(force ? ['/F'] : [])], () =>
          /* 无论 taskkill 的退出码如何，都交回控制权继续检查服务进程。 */
          resolve()))
    } else {
      // 服务以 detached 进程组启动；负 PID 向整组发信号，避免只结束入口而遗留 DSH 子进程。
      try { globalThis.process.kill(-process.pid, force ? 'SIGKILL' : 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  async function clientWaitExit(/* 本次等待结束通知的上限，单位为毫秒。 */ milliseconds: number): Promise<boolean> {
    // 在指定时限内等待当前子进程的结束通知，返回是否先于超时完成并清除计时器。
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([exited.then(() => /* 将子进程结束通知转换为等待成功。 */ true), new Promise<boolean>(/* 退出等待 Promise 的完成函数，超时路径传 false。 */ resolve => {
      // 为本次退出等待设置超时，避免阻塞桌面关闭流程。
      timer = setTimeout(() => /* 超时只结束等待，由调用方决定是否升级终止信号。 */ resolve(false), milliseconds)
    })]) }
    finally { clearTimeout(timer) }
  }
  async function clientStopChild() {
    // 先请求服务自行收尾，超时后依次终止、强制终止进程树，最终仍未退出则报告故障。
    const current = child
    if (!current) return
    if (current.connected) current.send({ type: 'stop' }, () => {
      // IPC 发送失败仍由后续退出等待和信号升级处理，不把发送成功当作进程已退出。
    })
    if (!await clientWaitExit(input.shutdownMs ?? 20000)) {
      await clientKillService(current, false)
      if (!await clientWaitExit(2000)) {
        await clientKillService(current, true)
        if (!await clientWaitExit(1000)) throw clientCreateServiceError(RuntimeMessage.LOCAL_SERVICE_PROCESS_EXIT_UNCONFIRMED)
      }
    }
  }
  function start(): Promise<{ baseUrl: string; token: string }> {
    // 复用已就绪连接或正在进行的启动；失败后允许显式重试，关闭开始后禁止再次启动。
    if (closing) return Promise.reject(clientCreateServiceError(RuntimeMessage.APPLICATION_IS_EXITING))
    if (ready) return Promise.resolve(ready)
    return starting ??= (async () => {
      // 创建数据目录并拉起随包 Node 服务，等待经校验的 IPC 就绪消息后才发布连接。
      clientUpdateState({ status: 'starting' })
      await mkdir(input.dataDirectory, { recursive: true, mode: 0o700 })
      try {
        const env = { ...process.env, PATH: path.join(input.runtimeDirectory, 'bin') + path.delimiter + (process.env.PATH ?? ''), CHONGMING_DESKTOP_DATA_DIR: input.dataDirectory, CHONGMING_CONFIG_DIR: input.configDirectory }
        // 本地服务使用随包运行时和自己的凭据，不能继承桌面调试参数或远程部署的令牌、队列配置。
        for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VITE_DEV_SERVER_URL', 'CHONGMING_USER_TOKEN', 'CHONGMING_DATA_TOKEN', 'CHONGMING_AMQP_URL']) delete env[key as keyof typeof env]
        const current = child = spawn(path.join(input.runtimeDirectory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
          [path.join(input.runtimeDirectory, 'service', 'main.mjs')], {
            cwd: input.runtimeDirectory, env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          })
        exited = new Promise<void>(/* 由进程 exit 或 error 唤醒的共享完成函数。 */ resolve => {
          // 为退出等待保存共同完成信号，兼容进程未成功创建就报错的情况。
          current.once('exit', () => /* 进程退出后唤醒所有退出等待。 */ resolve()); current.once('error', () => /* 进程报告错误时结束等待，避免启动失败悬挂。 */ resolve())
        })
        ready = await new Promise<{ baseUrl: string; token: string }>((/* 接纳经过校验的就绪连接凭据并完成启动等待。 */ resolve, /* 将启动失败、超时或提前退出传播给 start 调用方。 */ reject) => {
          // 将就绪消息、启动错误、提前退出和超时收敛为一次启动结果。
          let settled = false
          const timer = setTimeout(() =>
            /* 未按时收到就绪消息时拒绝启动，由外层清理已创建的子进程。 */
            finish(clientCreateServiceError(RuntimeMessage.LOCAL_SERVICE_START_TIMEOUT)), input.startupMs ?? 30000)
          function finish(/* 可选启动错误；提供时拒绝启动，省略时按成功连接完成。 */ error?: Error, /* 仅成功就绪时提供的已验证本机地址和令牌，由当前实例保存。 */ connection?: { baseUrl: string; token: string }) {
            // 只接纳首个启动结果，并撤销超时和消息监听，防止迟到消息覆盖既定结果。
            if (settled) return
            settled = true; clearTimeout(timer)
            current.removeListener('message', message)
            if (error) reject(error)
            else resolve(connection!)
          }
          function message(/* 子进程发出的未验证 IPC 消息，需要严格检查 ready/failed 内容。 */ value: unknown) {
            // 解析子进程失败或就绪消息，仅接受本机 HTTP 地址和格式合法的令牌作为连接凭据。
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
          current.once('error', () =>
            /* 将子进程创建错误归为随包运行时启动失败。 */
            finish(clientCreateServiceError(RuntimeMessage.LOCAL_RUNTIME_START_FAILED_PACKAGE)))
          current.once('exit', (/* 进程正常退出时的退出码；被信号终止时通常为空。 */ code, /* 导致进程退出的系统信号，若有则优先显示为退出原因。 */ signal) => {
            // 清除失效连接；非主动关闭的退出发布故障状态，未就绪的启动同时被拒绝。
            ready = undefined
            if (!closing) clientUpdateState({ status: 'failed', message: RuntimeMessage.LOCAL_SERVICE_STOPPED_RETRY, errorId: randomUUID() })
            finish(clientCreateServiceError(messageFormat(RuntimeMessage.LOCAL_SERVICE_EXITED_BEFORE_READY, signal ?? code)))
          })
        })
        if (closing) { await clientStopChild(); throw clientCreateServiceError(RuntimeMessage.APPLICATION_IS_EXITING) }
        clientUpdateState({ status: 'running' })
        return ready
      } finally { /* 子进程自行写入有容量限制的诊断日志。 */ }
    })().catch(async /* 启动 Promise 的拒绝原因，清理子进程后继续交回原调用方。 */ error => {
      // 启动失败后先收回子进程，再补充失败状态并将原始错误交回调用方。
      await clientStopChild()
      if (!closing && state.status !== 'failed') clientUpdateState({ status: 'failed', message: RuntimeMessage.LOCAL_SERVICE_START_FAILED_RETRY,
        errorId: error instanceof ClientError ? error.errorId : randomUUID() })
      throw error
    }).finally(() => {
      // 释放本次启动 Promise，失败后下次显式调用可重新启动。
      starting = undefined
    })
  }
  return {
    start,
    state: () => /* 返回状态副本，避免调用方修改本实例保存的状态。 */ ({ ...state }),
    close() {
      // 合并重复关闭请求，等待启动收尾并停止子进程，最后清除连接凭据和进程引用。
      return closing ??= (async () => {
        // 等待尚未结束的启动先交接子进程，避免关闭完成后仍出现迟到的服务进程。
        clientUpdateState({ status: 'stopping' })
        await starting?.catch(() => {
          // 启动失败已执行其清理，关闭仍需继续完成状态收尾。
        })
        await clientStopChild()
        ready = undefined; child = undefined; clientUpdateState({ status: 'stopped' })
      })()
    },
  }
}
// 本地服务进程控制器，持有启动、状态读取和关闭操作。
export type ClientService = ReturnType<typeof clientCreateService>
