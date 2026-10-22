// 文件职责：在独立应用进程中借用父持存储，验证正常初始化及原身份重新打开；不删除数据库或实现业务替身。
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Connection } from 'mongoose'

import type { QueueConfig } from '../../../contracts/events'
import { apiCreateServer } from '../../../backend/adapters/http/graph-http-server'
import { storeCreateConnection } from '../../../backend/adapters/storage/mongo/connection'
import { sqliteCreatePersistence, type SqlitePersistence } from '../../../backend/adapters/storage/sqlite/persistence'
import { applicationCreateService } from '../../../apps/graph-server/application'
import { applicationCreateLocalService } from '../../../apps/local-server/application'
import { recoveryCreateStartupDiagnostic, RecoveryStartupStage, type RecoveryStartupDiagnostic } from './workspace-startup-diagnostic'

export type RecoveryStorage =
  | { kind: 'sqlite'; directory: string }
  | { kind: 'mongo'; uri: string; queue: QueueConfig }

export interface RecoveryCredential {
  userId: string
  displayName: string
  token: string
  tokenId: string
}

export type RecoveryRequest =
  | { id: string; type: 'start'; mode: 'fresh'; storage: RecoveryStorage }
  | { id: string; type: 'start'; mode: 'reopen'; storage: RecoveryStorage; credential: RecoveryCredential }
  | { id: string; type: 'stop' }

export enum RecoveryFailureCode {
  INVALID_REQUEST = 'RECOVERY_INVALID_REQUEST',
  ALREADY_STARTED = 'RECOVERY_ALREADY_STARTED',
  SHUTTING_DOWN = 'RECOVERY_SHUTTING_DOWN',
  START_FAILED = 'RECOVERY_START_FAILED',
  STOP_FAILED = 'RECOVERY_STOP_FAILED',
  PROCESS_FAILED = 'RECOVERY_PROCESS_FAILED',
}

export type RecoveryResponse =
  | { id: string; type: 'ready'; data: { baseUrl: string; credential: RecoveryCredential; messagingNamespace: string } }
  | { id: string; type: 'stopped' }
  | { id: string; type: 'failed'; phase: 'start'; code: RecoveryFailureCode; diagnostic?: RecoveryStartupDiagnostic }
  | { id: string; type: 'failed'; phase: 'protocol' | 'stop'; code: RecoveryFailureCode }

function readRecord(
  /* 父进程经私有 IPC 传入的待解析值，尚未证明字段和类型有效。 */
  value: unknown,
): Record<string, unknown> | null {
  // 只接受普通对象形状，让后续字段读取不依赖类型断言。
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readCredential(
  /* reopen 必须沿用的父侧原始身份及凭据引用。 */
  value: unknown,
): RecoveryCredential | null {
  // 核对私有凭据形状；真正身份有效性仍由真实 auth.read 判断。
  const item = readRecord(value)
  if (!item || typeof item.userId !== 'string' || !item.userId || typeof item.displayName !== 'string'
    || typeof item.token !== 'string' || !item.token || typeof item.tokenId !== 'string' || !item.tokenId) return null
  return { userId: item.userId, displayName: item.displayName, token: item.token, tokenId: item.tokenId }
}

function readStorage(
  /* 父拥有的目录或数据库/队列配置，子进程只取得连接使用权。 */
  value: unknown,
): RecoveryStorage | null {
  // 显式区分存储类型，拒绝把缺失配置兜底成另一份数据库。
  const item = readRecord(value)
  if (!item) return null
  if (item.kind === 'sqlite' && typeof item.directory === 'string' && path.isAbsolute(item.directory)) {
    return { kind: 'sqlite', directory: item.directory }
  }
  const queue = readRecord(item.queue)
  if (item.kind === 'mongo' && typeof item.uri === 'string' && /^mongodb(?:\+srv)?:\/\//.test(item.uri)
    && queue && typeof queue.url === 'string' && /^amqps?:\/\//.test(queue.url)
    && typeof queue.namespace === 'string' && queue.namespace.length > 0) {
    return { kind: 'mongo', uri: item.uri, queue: { url: queue.url, namespace: queue.namespace } }
  }
  return null
}

function readRequest(
  /* Node IPC 交付的边界输入，不把任意消息直接当作测试协议。 */
  value: unknown,
): RecoveryRequest | null {
  // 仅接受 start(fresh/reopen) 或 stop，未知操作不转发到业务服务。
  const item = readRecord(value)
  if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(item.id)) return null
  if (item.type === 'stop') return { id: item.id, type: 'stop' }
  if (item.type !== 'start') return null
  const storage = readStorage(item.storage)
  if (!storage) return null
  if (item.mode === 'fresh') return { id: item.id, type: 'start', mode: 'fresh', storage }
  const credential = readCredential(item.credential)
  return item.mode === 'reopen' && credential ? { id: item.id, type: 'start', mode: 'reopen', storage, credential } : null
}

async function sendResponse(
  /* 已经过本测试协议构造的响应，秘密只允许存在私有 ready IPC 中。 */
  response: RecoveryResponse,
): Promise<void> {
  // 等待 IPC 写入完成，不通过 stdout 或错误日志传递凭据。
  if (!process.send || !process.connected) return
  await new Promise<void>((
    /* IPC 已写入或父连接已关闭后解除等待，不把原始发送错误输出。 */
    resolve,
  ) => {
    // 父进程可能在收尾时断开连接，发送失败同样结束本次等待。
    process.send?.(response, () => {
      // 无论父连接是否仍在，都不保留本次响应回调。
      resolve()
    })
  })
}

function runRecoveryProcess(): void {
  // 启动前注册信号和断连处理；每个进程只装配一次应用，存储始终由父持有。
  let sqlite: SqlitePersistence | undefined
  let connection: Connection | undefined
  let application: ReturnType<typeof applicationCreateService> | undefined
  let server: Server | undefined
  let starting: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let isStopping = false
  let exitCode = 0
  let startupStage = RecoveryStartupStage.STORAGE
  const stopIds = new Set<string>()

  async function closeOwnedResources(): Promise<boolean> {
    // 顺序停止入站、消息和本进程连接；失败继续尝试其余步骤，不删父的目录/数据库/namespace。
    let succeeded = true
    if (server) {
      try {
        server.closeAllConnections()
        if (server.listening) await new Promise<void>((
          /* 监听已关闭时完成本次停止。 */ resolve,
          /* 仅把关闭错误留给固定失败分类，不向父传原始文本。 */ reject,
        ) => {
          // 等待 HTTP 实际停止监听，再关闭业务依赖。
          server?.close((
            /* Node HTTP 关闭结果，存在错误时只标记本次清理失败。 */ error,
          ) => {
            // 让外层继续执行后续连接清理。
            if (error) reject(error)
            else resolve()
          })
        })
      } catch {
        succeeded = false
      }
    }
    try { await application?.closeMessaging() } catch { succeeded = false }
    try { await connection?.close() } catch { succeeded = false }
    try { await sqlite?.close() } catch { succeeded = false }
    return succeeded
  }

  function stopProcess(
    /* 正常 stop 的相关请求身份；信号或父断连不伪造父请求编号。 */
    requestId?: string,
    /* 启动/进程故障必须保留非零退出，正常 stop 或信号默认零。 */
    failureCode = 0,
  ): Promise<void> {
    // 合并并发停止，启动期间先等待资源交接；最终只关闭本进程拥有的连接。
    if (requestId) stopIds.add(requestId)
    exitCode = Math.max(exitCode, failureCode)
    isStopping = true
    return closing ??= (async () => {
      // 内层期限不是资源释放证明，超时的固定失败由父看门狗继续核验。
      const timer = setTimeout(() => {
        // 防止启动或关闭挂起永久占用 child；父仍保有数据库和所属资源记录。
        process.exit(1)
      }, 10_000)
      try {
        try { await starting } catch { exitCode = 1 }
        const succeeded = await closeOwnedResources()
        if (!succeeded) exitCode = 1
        for (const id of stopIds) {
          await sendResponse(succeeded
            ? { id, type: 'stopped' }
            : { id, type: 'failed', phase: 'stop', code: RecoveryFailureCode.STOP_FAILED })
        }
      } finally {
        clearTimeout(timer)
        process.exit(exitCode)
      }
    })()
  }

  async function startApplication(
    /* 已解析的唯一启动命令，reopen 引用父侧原账号而不是重建账号。 */
    request: Extract<RecoveryRequest, { type: 'start' }>,
  ): Promise<void> {
    // 借用真实持久化资源并运行生产初始化；只有 fresh 允许 seed 和创建首个身份。
    if (request.storage.kind === 'sqlite') {
      sqlite = sqliteCreatePersistence(request.storage.directory)
      startupStage = RecoveryStartupStage.INITIALIZE
      application = applicationCreateLocalService(sqlite)
    } else {
      connection = await storeCreateConnection(request.storage.uri)
      startupStage = RecoveryStartupStage.INITIALIZE
      application = applicationCreateService(connection, { messaging: request.storage.queue })
    }
    await application.initialize()
    if (isStopping) return
    let credential: RecoveryCredential
    if (request.mode === 'fresh') {
      await application.control.seed()
      startupStage = RecoveryStartupStage.IDENTITY
      const actor = await application.auth.createUser({ id: randomUUID(), displayName: '恢复验收用户', hostAdmin: false })
      const token = await application.auth.createToken(actor.userId)
      credential = { userId: actor.userId, displayName: actor.displayName, ...token }
    } else {
      startupStage = RecoveryStartupStage.IDENTITY
      const context = await application.auth.read(request.credential.token)
      if (context.actor.userId !== request.credential.userId) throw new Error(RecoveryFailureCode.START_FAILED)
      credential = { ...request.credential, displayName: context.actor.displayName }
    }
    if (isStopping) return
    startupStage = RecoveryStartupStage.MESSAGING
    await application.startMessaging()
    if (isStopping) return
    startupStage = RecoveryStartupStage.HTTP
    server = apiCreateServer(application, { internalToken: randomUUID() })
    const activeServer = server
    await new Promise<void>((
      /* 真实 HTTP 已绑定随机回环端口后才可宣告应用就绪。 */ resolve,
      /* 监听失败使启动失败，不改成空环境继续执行。 */ reject,
    ) => {
      // 使用操作系统分配的实际端口，避免先探测再绑定的竞态。
      activeServer.once('error', reject)
      activeServer.listen(0, '127.0.0.1', () => {
        // 监听完成后移除仅用于启动的错误回调。
        activeServer.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error(RecoveryFailureCode.START_FAILED)
    if (!isStopping) await sendResponse({ id: request.id, type: 'ready', data: {
      baseUrl: `http://127.0.0.1:${address.port}`, credential, messagingNamespace: application.messaging().namespace,
    } })
  }

  process.on('message', (
    /* 父经 fork 私有通道传入的未知消息。 */ value: unknown,
  ) => {
    // 在进程边界解析协议，再进入唯一的真实应用启动或关闭路径。
    const request = readRequest(value)
    if (!request) {
      void sendResponse({ id: 'invalid', type: 'failed', phase: 'protocol', code: RecoveryFailureCode.INVALID_REQUEST })
      return
    }
    if (request.type === 'stop') {
      void stopProcess(request.id)
      return
    }
    if (isStopping || starting) {
      void sendResponse({ id: request.id, type: 'failed', phase: 'protocol',
        code: isStopping ? RecoveryFailureCode.SHUTTING_DOWN : RecoveryFailureCode.ALREADY_STARTED })
      return
    }
    starting = startApplication(request)
    void starting.catch(async (
      /* 真实启动异常，只能通过统一白名单投影为固定阶段和代码。 */ cause: unknown,
    ) => {
      // 回传固定诊断后释放本进程连接；底层message、stack、URI和凭据没有输出路径。
      await sendResponse({ id: request.id, type: 'failed', phase: 'start', code: RecoveryFailureCode.START_FAILED,
        diagnostic: recoveryCreateStartupDiagnostic(startupStage, cause) })
      void stopProcess(undefined, 1)
    })
  })
  process.once('disconnect', () => {
    // 父已消失时仍停止应用连接，但不触碰借用的存储或 broker。
    void stopProcess()
  })
  process.once('SIGTERM', () => {
    // 信号可以在初始化中到达，统一等待已取得资源交接再退出。
    void stopProcess()
  })
  process.once('SIGINT', () => {
    // 交互中断与父发 stop 使用同一条有界关闭路径。
    void stopProcess()
  })
  process.once('uncaughtException', () => {
    // 致命异常不输出原始错误，保留非零退出并尝试关闭本进程资源。
    void stopProcess(undefined, 1)
  })
  process.once('unhandledRejection', () => {
    // 未处理拒绝同样不能以零退出掩盖故障或向终端泄露凭据。
    void stopProcess(undefined, 1)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runRecoveryProcess()
