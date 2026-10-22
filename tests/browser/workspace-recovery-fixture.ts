// 恢复用例的隔离装配：父持真实存储和稳定 Web 地址，只重开借用存储的应用子进程。
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, request as requestHttp, type Server, type ClientRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer as createVite, type ViteDevServer } from 'vite'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { require as tsRequire } from 'tsx/cjs/api'
import { test as existingTest } from './workspace-fixture'
import type { RecoveryCredential, RecoveryRequest, RecoveryResponse, RecoveryStorage } from './fixtures/workspace-recovery-process'
import {
  recoveryReadStartupDiagnostic,
  recoveryCreateStartupDiagnosticCause,
  type RecoveryStartupDiagnostic,
} from './fixtures/workspace-startup-diagnostic'
import { workspaceCreateStaticDocumentPlugin } from './workspace-vite'

type RecoveryReady = Extract<RecoveryResponse, { type: 'ready' }>['data']
interface RecoveryChild {
  readonly child: ChildProcess
  readonly closed: Promise<void>
  readonly hasClosed: boolean
}

export interface WorkspaceRecoveryEnvironment {
  readonly baseUrl: string
  readonly webUrl: string
  readonly credential: RecoveryCredential
  readonly storage: 'sqlite' | 'mongo'
  readonly directory: string
  // 保持原数据库、凭据和代理地址，仅重开应用进程；crash 不发送正常关闭消息。
  restart(/* 本轮明确选择优雅退出或真正强杀应用。 */ mode: 'graceful' | 'crash'): Promise<void>
  // 最终销毁自有环境，与 restart 的保留存储语义分开。
  close(): Promise<void>
}

enum RecoveryFixtureError {
  CHILD_FAILED = 'M00 恢复应用进程未完成请求。',
  CHILD_TIMEOUT = 'M00 恢复应用进程请求超过期限。',
  CHILD_CLOSED = 'M00 恢复应用进程在响应前结束。',
  CHILD_CLOSE_TIMEOUT = 'M00 恢复应用进程未在期限内实际结束。',
  CHILD_STOP_FAILED = 'M00 恢复应用进程正常停止失败。',
  CRASH_NOT_OBSERVED = 'M00 崩溃注入没有观察到本轮应用被 SIGKILL 结束。',
  ADDRESS_MISSING = 'M00 恢复环境没有实际回环监听地址。',
  INVALID_REPLY = 'M00 恢复应用进程返回不合法的就绪结果。',
  ENVIRONMENT_CLOSED = 'M00 恢复环境已最终关闭。',
  CLEANUP_FAILED = 'M00 恢复测试自有资源未完整释放。',
}

/** 仅读取私有 IPC 对象形状，不直接把未知消息当作完整协议。 */
function recoveryReadObject(/* 子进程发来的未知消息或其字段。 */ value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 检查真实监听 origin 及原身份字段；凭据只返回当前测试内存。 */
function recoveryReadReady(/* 已匹配请求编号的 ready.data。 */ value: unknown): RecoveryReady | undefined {
  const data = recoveryReadObject(value), actor = recoveryReadObject(data?.credential)
  if (!data || !actor || typeof data.baseUrl !== 'string' || typeof data.messagingNamespace !== 'string'
    || typeof actor.userId !== 'string' || typeof actor.token !== 'string' || typeof actor.tokenId !== 'string'
    || typeof actor.displayName !== 'string') return undefined
  try {
    const origin = new URL(data.baseUrl)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
      || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') return undefined
  } catch { return undefined }
  return { baseUrl: data.baseUrl, messagingNamespace: data.messagingNamespace,
    credential: { userId: actor.userId, token: actor.token, tokenId: actor.tokenId, displayName: actor.displayName } }
}

/** 创建只装配真实 API 的进程；不继承 Playwright 的加载/调试开关，也不输出进程私有诊断。 */
function recoveryFork(): RecoveryChild {
  const child = fork(path.resolve('tests/browser/fixtures/workspace-recovery-process.ts'), [], {
    cwd: path.resolve(process.cwd()), execArgv: ['--import', 'tsx'], detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE },
  })
  let hasClosed = false
  const closed = new Promise<void>((/* 仅在 child 的实际 close 事件完成等待。 */ resolve) => {
    child.once('close', () => { hasClosed = true; resolve() })
  })
  return { child, closed, get hasClosed() { return hasClosed } }
}

/** 私有请求有有限期限和身份匹配，失败不把 token 或原始异常传到外层报告。 */
async function recoveryExchange(
  /* 本测试创建并仍持有的进程。 */ service: RecoveryChild,
  /* 仅能 start 或 stop 的已构造私有命令。 */ request: RecoveryRequest,
): Promise<RecoveryReady | undefined> {
  // 用本轮身份结束 IPC 等待，启动失败只保留经过严格投影的固定阶段与错误码。
  return new Promise((
    /* 接纳匹配的 ready 或正常 stopped。 */ resolve,
    /* 协议、进程或期限错误均拒绝本次等待。 */ reject,
  ) => {
    // 回包、关闭和 IPC 拒绝共享同一清理入口，不复制子进程原始异常。
    const finish = (
      /* 本轮允许的固定错误，不复制进程原始文本。 */ error?: RecoveryFixtureError,
      /* 校验过的成功启动结果。 */ data?: RecoveryReady,
      /* 仅匹配的 start-failed 允许附带经过投影的安全诊断。 */ diagnostic?: RecoveryStartupDiagnostic,
    ): void => {
      // 结束本轮监听与期限，Error cause 保证固定诊断可以穿过 Playwright 序列化。
      clearTimeout(timer)
      service.child.off('message', onMessage); service.child.off('close', onClosed); service.child.off('error', onError)
      if (error) reject(new Error(error, diagnostic ? { cause: recoveryCreateStartupDiagnosticCause(diagnostic) } : undefined))
      else resolve(data)
    }
    const onMessage = (/* 子进程的待校验消息。 */ value: unknown): void => {
      // 原 failed 事实保持，只有正确阶段与固定启动失败码的两键诊断可以进入 cause。
      const reply = recoveryReadObject(value)
      if (reply?.id !== request.id) return
      if (reply.type === 'failed') {
        const diagnostic = request.type === 'start' && reply.phase === 'start' && reply.code === 'RECOVERY_START_FAILED'
          ? recoveryReadStartupDiagnostic(reply.diagnostic) : null
        return finish(RecoveryFixtureError.CHILD_FAILED, undefined, diagnostic ?? undefined)
      }
      if (request.type === 'stop' && reply.type === 'stopped') return finish()
      const data = reply.type === 'ready' ? recoveryReadReady(reply.data) : undefined
      if (request.type === 'start' && data) finish(undefined, data)
      else finish(RecoveryFixtureError.INVALID_REPLY)
    }
    const onClosed = (): void => finish(RecoveryFixtureError.CHILD_CLOSED)
    const onError = (): void => finish(RecoveryFixtureError.CHILD_FAILED)
    const timer = setTimeout(() => finish(RecoveryFixtureError.CHILD_TIMEOUT), 30_000)
    service.child.on('message', onMessage); service.child.once('close', onClosed); service.child.once('error', onError)
    if (service.hasClosed || !service.child.connected) return finish(RecoveryFixtureError.CHILD_CLOSED)
    service.child.send(request, (/* Node IPC 写入错误，不输出其正文。 */ error) => {
      if (error) finish(RecoveryFixtureError.CHILD_FAILED)
    })
  })
}

/** 等待真实进程退出；超时只代表未释放，不能当作已经重启。 */
async function recoveryWaitClosed(/* 当前自有进程观察。 */ service: RecoveryChild, /* 本阶段允许的毫秒数。 */ timeoutMs = 15_000): Promise<void> {
  if (service.hasClosed) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([service.closed, new Promise<never>((/* 未使用成功结果。 */ _resolve, /* 期限错误拒绝入口。 */ reject) => {
      timer = setTimeout(() => reject(new Error(RecoveryFixtureError.CHILD_CLOSE_TIMEOUT)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

/** 只终止当前仍持有的应用进程树；Mongo 及 Web 均不属于该进程组。 */
function recoveryKill(/* 本轮创建的进程观察对象。 */ service: RecoveryChild): void {
  if (service.hasClosed || !service.child.pid) return
  try {
    if (process.platform === 'win32') service.child.kill('SIGKILL')
    else process.kill(-service.child.pid, 'SIGKILL')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(RecoveryFixtureError.CHILD_STOP_FAILED)
  }
}

/** 正常停止要求协议确认与实际退出都完成；最终失败兜底才强杀。 */
async function recoveryStopChild(/* 本环境持有的可选应用进程。 */ service: RecoveryChild | undefined): Promise<void> {
  if (!service || service.hasClosed) return
  try {
    await recoveryExchange(service, { id: randomUUID(), type: 'stop' })
    await recoveryWaitClosed(service)
    if (service.child.exitCode !== 0) throw new Error(RecoveryFixtureError.CHILD_STOP_FAILED)
  } catch (cause) {
    recoveryKill(service)
    await recoveryWaitClosed(service)
    throw cause
  }
}

/** 用实际绑定地址启动测试转发器，不先探测再抢占固定端口。 */
async function recoveryListen(/* 当前测试创建的回环 HTTP 服务。 */ server: Server): Promise<string> {
  await new Promise<void>((/* 绑定成功解除等待。 */ resolve, /* 绑定失败直接拒绝。 */ reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(RecoveryFixtureError.ADDRESS_MISSING)
  return `http://127.0.0.1:${address.port}`
}

/** 只在测试目录内持有存储、独立 Vite 和真实 HTTP 转发，不添加公开恢复 API。 */
async function recoveryCreateEnvironment(/* 项目选定的真实存储种类。 */ storage: 'sqlite' | 'mongo'): Promise<WorkspaceRecoveryEnvironment> {
  // 父侧持有原存储与固定验收页面，API 子进程重启不受外部开发文件监听干扰。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-m00-recovery-'))
  let mongo: MongoMemoryReplSet | undefined
  let broker: Awaited<ReturnType<typeof import('../backend/fixtures/rabbitmq')['rabbitCreateFixture']>> | undefined
  let service: RecoveryChild | undefined, vite: ViteDevServer | undefined, proxy: Server | undefined
  let descriptor: RecoveryStorage
  let credential: RecoveryCredential
  let apiUrl: string | undefined
  let isClosed = false, closeTask: Promise<void> | undefined
  let restartTask: Promise<void> | undefined
  const namespaces = new Set<string>(), upstreams = new Set<ClientRequest>()
  const previousWeb = process.env.CHONGMING_WEB, previousApi = process.env.CHONGMING_GRAPH_API
  const close = (): Promise<void> => closeTask ??= (async () => {
    // 最终关闭才删除存储；逐项收尾并保留失败，不借用旧 fixture.close 删除数据库。
    isClosed = true
    const errors: unknown[] = []
    apiUrl = undefined
    try { await restartTask } catch (cause) { errors.push(cause) }
    for (const upstream of upstreams) upstream.destroy()
    if (proxy) {
      try {
        proxy.closeAllConnections()
        await new Promise<void>((/* 转发器结束后继续收尾。 */ resolve) => proxy?.close(() => resolve()))
      } catch (cause) { errors.push(cause) }
    }
    try { await vite?.close() } catch (cause) { errors.push(cause) }
    try { await recoveryStopChild(service) } catch (cause) { errors.push(cause) }
    if (!service || service.hasClosed) {
      try { await mongo?.stop() } catch (cause) { errors.push(cause) }
      for (const namespace of namespaces) {
        try { await broker?.deleteNamespace(namespace) } catch (cause) { errors.push(cause) }
      }
      try { await broker?.close() } catch (cause) { errors.push(cause) }
      try { await rm(directory, { recursive: true, force: true }) } catch (cause) { errors.push(cause) }
    } else errors.push(new Error(RecoveryFixtureError.CHILD_CLOSE_TIMEOUT))
    if (previousWeb === undefined) delete process.env.CHONGMING_WEB
    else process.env.CHONGMING_WEB = previousWeb
    if (previousApi === undefined) delete process.env.CHONGMING_GRAPH_API
    else process.env.CHONGMING_GRAPH_API = previousApi
    if (errors.length) throw new AggregateError(errors, RecoveryFixtureError.CLEANUP_FAILED)
  })()
  try {
    if (storage === 'sqlite') descriptor = { kind: 'sqlite', directory: path.join(directory, 'sqlite') }
    else {
      mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
      const module: typeof import('../backend/fixtures/rabbitmq') = tsRequire(path.resolve('tests/backend/fixtures/rabbitmq.ts'), pathToFileURL(path.resolve('tests/browser/workspace-recovery-fixture.ts')))
      broker = await module.rabbitCreateFixture()
      descriptor = { kind: 'mongo', uri: mongo.getUri('m00_recovery'), queue: broker.queue }
    }
    service = recoveryFork()
    const ready = await recoveryExchange(service, { id: randomUUID(), type: 'start', mode: 'fresh', storage: descriptor })
    if (!ready) throw new Error(RecoveryFixtureError.INVALID_REPLY)
    credential = ready.credential
    apiUrl = ready.baseUrl
    namespaces.add(ready.messagingNamespace)
    proxy = createServer((
      /* 浏览器/公共客户端发出的真实请求，保留原始字节和认证。 */ incoming,
      /* 当前下游响应，只转发真实上游结果。 */ outgoing,
    ) => {
      if (!apiUrl) { outgoing.writeHead(503); outgoing.end(); return }
      const target = new URL(incoming.url ?? '/', apiUrl)
      const upstream = requestHttp(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (
        /* 实际应用 HTTP 响应，包括未经伪造的 SSE。 */ response,
      ) => {
        if (outgoing.destroyed) { response.destroy(); return }
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.on('error', () => { outgoing.destroy() })
        response.once('aborted', () => { outgoing.destroy() })
        response.pipe(outgoing)
      })
      upstreams.add(upstream)
      upstream.once('close', () => upstreams.delete(upstream))
      upstream.on('error', () => {
        if (outgoing.headersSent) outgoing.destroy()
        else { outgoing.writeHead(502); outgoing.end() }
      })
      outgoing.once('close', () => upstream.destroy())
      outgoing.on('error', () => { upstream.destroy() })
      incoming.on('error', () => { upstream.destroy(); outgoing.destroy() })
      incoming.once('aborted', () => { upstream.destroy(); outgoing.destroy() })
      incoming.pipe(upstream)
    })
    const baseUrl = await recoveryListen(proxy)
    process.env.CHONGMING_WEB = '1'
    process.env.CHONGMING_GRAPH_API = baseUrl
    vite = await createVite({ configFile: path.resolve('vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
      plugins: [workspaceCreateStaticDocumentPlugin()],
      // Vite 的零值会回落固定端口；沿用普通浏览器夹具的可用端口选择。
      logLevel: 'silent', clearScreen: false, server: { host: '127.0.0.1', strictPort: false,
        proxy: { '/api/v1': { target: baseUrl, changeOrigin: true, followRedirects: false } } } })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error(RecoveryFixtureError.ADDRESS_MISSING)
    const webUrl = `http://127.0.0.1:${address.port}`
    return {
      baseUrl, webUrl, credential, storage, directory,
      async restart(/* 应用正常退出或突然崩溃；均不碰父持存储。 */ mode): Promise<void> {
        if (isClosed || !service) throw new Error(RecoveryFixtureError.ENVIRONMENT_CLOSED)
        if (restartTask) return restartTask
        const current = service
        restartTask = (async () => {
          // 旧请求不能跨进程代次交付；数据库与 broker 始终由父持有。
          apiUrl = undefined
          for (const upstream of upstreams) upstream.destroy()
          if (mode === 'crash') {
            if (current.hasClosed) throw new Error(RecoveryFixtureError.CRASH_NOT_OBSERVED)
            recoveryKill(current)
            await recoveryWaitClosed(current)
            if (current.child.signalCode !== 'SIGKILL') throw new Error(RecoveryFixtureError.CRASH_NOT_OBSERVED)
          }
          else await recoveryStopChild(current)
          if (isClosed) return
          service = recoveryFork()
          const reopened = await recoveryExchange(service, { id: randomUUID(), type: 'start', mode: 'reopen', storage: descriptor, credential })
          if (!reopened || reopened.credential.token !== credential.token || reopened.credential.userId !== credential.userId
            || reopened.credential.tokenId !== credential.tokenId || reopened.messagingNamespace !== ready.messagingNamespace) throw new Error(RecoveryFixtureError.INVALID_REPLY)
          namespaces.add(reopened.messagingNamespace)
          if (!isClosed) apiUrl = reopened.baseUrl
        })()
        try { await restartTask } finally { restartTask = undefined }
      },
      close,
    }
  } catch (cause) {
    try { await close() } catch (cleanup) { throw new AggregateError([cause, cleanup], RecoveryFixtureError.CLEANUP_FAILED) }
    throw cause
  }
}

// 恢复用例只依赖 storage 选项，不会同时创建另一套旧 environment/gateway。
export const recoveryTest = existingTest.extend<{ recovery: WorkspaceRecoveryEnvironment }>({
  recovery: [async (
    /* 根项目明确的 sqlite/mongo 配置。 */ { storage },
    /* 当前恢复测试借用同一份原始存储直到用例结束。 */ use,
  ) => {
    const recovery = await recoveryCreateEnvironment(storage)
    try { await use(recovery) } finally { await recovery.close() }
  }, { timeout: 120_000 }],
})
