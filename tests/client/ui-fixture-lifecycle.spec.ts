// 文件职责：以真实 SQLite 夹具验证关闭幂等、故障后继续清理及启动错误保留；测试自身另行兜底释放资源。
import { access, rm } from 'node:fs/promises'
import * as http from 'node:http'
import type { Server } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { RuntimeMessage } from '../../contracts/messages'
import * as graphHttp from '../../backend/adapters/http/graph-http-server'
import * as sqliteAdapter from '../../backend/adapters/storage/sqlite/persistence'
import type { SqlitePersistence } from '../../backend/adapters/storage/sqlite/persistence'
import * as localApplication from '../../apps/local-server/application'
import { clientCreateGateway } from '../../client/graph-client'
import { fixtureCreateEnvironment, type UiFixture } from './ui-fixture'

vi.mock('node:http', async (
  /* Vitest 提供的原生 HTTP 模块加载器，不伪造 Server 或实际网络。 */
  importOriginal,
) => {
  // 只复制只读 ESM namespace 的导出表，使测试可观察真实 createServer 并保留全部原生实现。
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual }
})

enum LifecycleFailure {
  STARTUP = 'M00_FAULT_APPLICATION_INITIALIZE',
  MESSAGING_CLOSE = 'M00_FAULT_MESSAGING_CLOSE',
  DATABASE_CLOSE_BEFORE_RELEASE = 'M00_FAULT_DATABASE_CLOSE_BEFORE_RELEASE',
  DATABASE_CLOSE_AFTER_RELEASE = 'M00_FAULT_DATABASE_CLOSE_AFTER_RELEASE',
  SERVER_CAPTURE_INVALID = 'M00_CAPTURED_SERVER_INVALID',
  FALLBACK_CLEANUP_FAILED = '生命周期用例兜底清理失败',
}

interface CapturedDatabase {
  directory: string
  database: SqlitePersistence
  // 调用注入故障前保存的真实数据库关闭函数，解除本用例的 SQLite 锁。
  close(): Promise<void>
}

interface CapturedApplication {
  // 关闭原消息服务，绕过本用例在 application.closeMessaging 上注入的一次性故障。
  close(): Promise<void>
}

interface LifecycleFaults {
  startup?: Error
  messagingClose?: Error
  databaseCloseBeforeRelease?: Error
  databaseCloseAfterRelease?: Error
}

interface LifecycleProbe {
  databases: CapturedDatabase[]
  apiServers: Server[]
  servers: ReadonlySet<Server>
  // 恢复测试替身后，以保留的真实释放函数关闭资源；不依赖已失败且被记忆的 fixture.close。
  dispose(): Promise<void>
}

function installLifecycleProbe(
  /* 只在真实初始化或消息关闭边界注入一次受控错误；未提供时完整执行真实实现。 */
  faults: LifecycleFaults = {},
): LifecycleProbe {
  // 保存真实数据库与消息释放函数，只替换指定故障边界，让用例结束后仍能独立清理。
  const databases: CapturedDatabase[] = []
  const applications: CapturedApplication[] = []
  const servers = new Set<Server>()
  const apiServers: Server[] = []
  const createDatabase = sqliteAdapter.sqliteCreatePersistence
  const createApplication = localApplication.applicationCreateLocalService
  const createHttpServer = http.createServer
  const createApiServer = graphHttp.apiCreateServer

  vi.spyOn(http, 'createServer').mockImplementation((
    /* 真实 Node HTTP 构造参数，完整转交原实现以同时登记 provider 与 API。 */
    ...parameters
  ) => {
    // 保留真实 HTTP，不替换请求处理；取得资源时立即登记供失败后的测试兜底。
    const server: unknown = Reflect.apply(createHttpServer, http, parameters)
    if (!(server instanceof http.Server)) throw new Error(LifecycleFailure.SERVER_CAPTURE_INVALID)
    servers.add(server)
    return server
  })

  vi.spyOn(graphHttp, 'apiCreateServer').mockImplementation((
    /* 夹具实际装配的完整应用，继续交给原 HTTP adapter。 */
    application,
    /* 原夹具内部身份与服务选项，不输出或改写。 */
    options,
  ) => {
    // 单独标记真实 API 服务，便于模拟“调用方已关闭它”的合法资源状态。
    const server = createApiServer(application, options)
    apiServers.push(server)
    servers.add(server)
    return server
  })

  vi.spyOn(sqliteAdapter, 'sqliteCreatePersistence').mockImplementation((
    /* 真实夹具创建的独立 SQLite 目录，据此限定本测试的兜底删除范围。 */
    directory,
  ) => {
    // 打开真实 SQLite，并在注入任何故障前保留其原始关闭函数。
    const database = createDatabase(directory)
    const close = database.close.bind(database)
    databases.push({ directory: path.dirname(directory), database, close })
    const beforeCloseFailure = faults.databaseCloseBeforeRelease
    const closeFailure = faults.databaseCloseAfterRelease
    if (beforeCloseFailure) vi.spyOn(database, 'close').mockRejectedValueOnce(beforeCloseFailure)
    else if (closeFailure) vi.spyOn(database, 'close').mockImplementationOnce(async () => {
      // 实际解除数据库锁后再报告关闭故障，不能假装已经执行真实释放。
      await close()
      throw closeFailure
    })
    return database
  })

  vi.spyOn(localApplication, 'applicationCreateLocalService').mockImplementation((
    /* 夹具实际创建的 SQLite 持久化对象，不使用内存或伪数据库替代。 */
    database,
    /* 夹具原本传入的租约和来源策略，保持原样交给真实装配。 */
    options,
  ) => {
    // 运行真实应用装配，仅在本用例指定的现有生命周期边界制造一次故障。
    const application = createApplication(database, options)
    applications.push({ close: application.closeMessaging.bind(application) })
    if (faults.startup) vi.spyOn(application, 'initialize').mockRejectedValueOnce(faults.startup)
    if (faults.messagingClose) vi.spyOn(application, 'closeMessaging').mockRejectedValueOnce(faults.messagingClose)
    return application
  })

  return {
    databases,
    apiServers,
    servers,
    async dispose(): Promise<void> {
      // 即使用例断言失败，也恢复替身并释放原消息服务、数据库及本次自有临时目录。
      vi.restoreAllMocks()
      const failures: unknown[] = []
      for (const server of servers) {
        try {
          await closeCapturedServer(server)
        } catch (error) {
          failures.push(error)
        }
      }
      for (const application of applications) {
        try {
          await application.close()
        } catch (error) {
          failures.push(error)
        }
      }
      for (const captured of databases) {
        try {
          await captured.close()
          await rm(captured.directory, { recursive: true, force: true })
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length) throw new AggregateError(failures, LifecycleFailure.FALLBACK_CLEANUP_FAILED)
    },
  }
}

async function closeCapturedServer(
  /* 夹具实际创建并由本测试登记的服务，已关闭时按幂等结果完成。 */
  server: Server,
): Promise<void> {
  // listening=false 也可能还有已接受连接，必须排连接并等待真实关闭回调。
  await new Promise<void>((
    /* 服务已停止监听后结束等待。 */ resolve,
    /* 未成功关闭时保留实际错误，不能把探测失败当作已经清理。 */ reject,
  ) => {
    // 等待真实 Node close 回调，不依赖测试替身的调用记录。
    server.close((
      /* 真实 HTTP 关闭结果，只有没有错误才确认完成。 */ error,
    ) => {
      // 仅接受“已经没有运行服务”的幂等结果，其他关闭错误不能被当作释放完成。
      if (!error || 'code' in error && error.code === 'ERR_SERVER_NOT_RUNNING') resolve()
      else reject(error)
    })
    server.closeAllConnections()
  })
}

async function readFailure(
  /* 已经发起的真实启动或关闭操作，观察其拒绝值而不改写错误身份。 */
  operation: Promise<unknown>,
): Promise<unknown> {
  // 将本次真实故障留在测试内存，供原始错误和附带清理错误分别核对。
  try {
    await operation
    return undefined
  } catch (error) {
    return error
  }
}

function includesFailure(
  /* 夹具实际抛出的错误或错误集合，只读取测试中的 Error cause/errors 结构。 */
  actual: unknown,
  /* 本用例注入的精确错误对象，不能只靠相同消息证明原错误得到保留。 */
  expected: Error,
  /* 已访问的错误对象，防止循环 cause 使失败断言自身挂起。 */
  visited: Set<object> = new Set(),
): boolean {
  // 允许直接抛错、cause 和 AggregateError 形式，同时要求精确保留注入的错误身份。
  if (actual === expected) return true
  if (!(actual instanceof Error) || visited.has(actual)) return false
  visited.add(actual)
  if ('cause' in actual && includesFailure(actual.cause, expected, visited)) return true
  if ('errors' in actual && Array.isArray(actual.errors)) {
    const failures: readonly unknown[] = actual.errors
    for (const failure of failures) {
      if (includesFailure(failure, expected, visited)) return true
    }
  }
  return false
}

async function directoryExists(
  /* 本测试真实 SQLite 所在的临时夹具目录，不接受其他目录作为清理目标。 */
  directory: string,
): Promise<boolean> {
  // 只把目录确实不存在视为清理完成，权限或其他文件系统错误继续传播。
  try {
    await access(directory)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function assertDatabasesClosed(
  /* 测试从真实构造边界捕获的数据库，须先观察夹具自身结果再执行兜底清理。 */
  databases: readonly CapturedDatabase[],
  /* 关闭正常返回才可删除目录；关闭抛错时调用者应保守保留，不能猜测锁已释放。 */
  directoryState: 'removed' | 'retained' = 'removed',
): Promise<void> {
  // 核验真实数据库关闭，并分别验证安全删除或保守保留，不用调用次数代替状态。
  expect(databases).toHaveLength(1)
  for (const captured of databases) {
    await expect.soft(captured.database.records<{ _id: string }>('fixture_lifecycle_probe').count())
      .rejects.toThrow(RuntimeMessage.SQLITE_DATABASE_IS_CLOSED)
    await expect.soft(directoryExists(captured.directory)).resolves.toBe(directoryState === 'retained')
  }
}

describe('M00 SQLite 夹具生命周期资格检查', () => {
  // 先证明真实环境可用，再观察现有清理与错误传播缺口；不实现未来 runtime 或修改生产行为。
  it('Q03：真实 HTTP 可用后，并发和重复关闭释放端口、SQLite 及临时目录', async () => {
    // 经真实授权读取验证环境，然后以并发关闭和真实资源状态验证幂等结束。
    const probe = installLifecycleProbe()
    let fixture: UiFixture | undefined
    try {
      fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
      const gateway = clientCreateGateway({ baseUrl: fixture.baseUrl, timeoutMs: 3000 })
      try {
        await gateway.connect({ baseUrl: fixture.baseUrl, token: fixture.token, remember: false })
        expect((await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })).id).toBe(fixture.workspaceId)
      } finally {
        await gateway.disconnect()
      }
      expect(fixture.modelCalls).toHaveLength(0)
      const firstClose = fixture.close()
      const secondClose = fixture.close()
      expect(secondClose).toBe(firstClose)
      await Promise.all([firstClose, secondClose])
      await fixture.close()
      await expect(fetch(fixture.baseUrl, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
      await assertDatabasesClosed(probe.databases)
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('Q04：消息关闭失败仍关闭真实 SQLite 并删除自有目录，同时保留清理错误', async () => {
    // 在现有消息释放边界制造一次失败，后续资源必须仍由夹具自身释放。
    const messagingFailure = new Error(LifecycleFailure.MESSAGING_CLOSE)
    const probe = installLifecycleProbe({ messagingClose: messagingFailure })
    let fixture: UiFixture | undefined
    try {
      fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
      const failure = await readFailure(fixture.close())
      expect.soft(includesFailure(failure, messagingFailure)).toBe(true)
      await expect(fetch(fixture.baseUrl, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
      await assertDatabasesClosed(probe.databases)
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('Q02：数据库已打开后的初始化失败保留原错误并释放取得的资源', async () => {
    // 启动未能完成时仍须停止已创建的真实消息与 SQLite，不能依赖返回环境后再手动关闭。
    const startupFailure = new Error(LifecycleFailure.STARTUP)
    const probe = installLifecycleProbe({ startup: startupFailure })
    let fixture: UiFixture | undefined
    try {
      const starting = fixtureCreateEnvironment({ storage: 'sqlite' }).then((
        /* 如果故障意外没有触发，仍保留实际启动的环境并在 finally 关闭它。 */
        started,
      ) => {
        // 保存意外成功的环境，避免失败断言让真实 HTTP 和 Host 留在后台。
        fixture = started
      })
      const failure = await readFailure(starting)
      expect(includesFailure(failure, startupFailure)).toBe(true)
      await assertDatabasesClosed(probe.databases)
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('Q02：启动和清理同时失败时保留首要启动错误及附带清理错误，并继续释放资源', async () => {
    // 同时触发两个真实生命周期边界，验证清理拒绝不会遮掉导致启动失败的原错误。
    const startupFailure = new Error(LifecycleFailure.STARTUP)
    const messagingFailure = new Error(LifecycleFailure.MESSAGING_CLOSE)
    const probe = installLifecycleProbe({ startup: startupFailure, messagingClose: messagingFailure })
    let fixture: UiFixture | undefined
    try {
      const starting = fixtureCreateEnvironment({ storage: 'sqlite' }).then((
        /* 如果故障边界变化导致意外启动成功，将环境归入本用例收尾。 */
        started,
      ) => {
        // 保留意外成功的真实环境，保证断言失败后也能关闭 HTTP 和 Host。
        fixture = started
      })
      const failure = await readFailure(starting)
      expect.soft(includesFailure(failure, startupFailure)).toBe(true)
      expect.soft(failure instanceof Error && 'cause' in failure && failure.cause === startupFailure).toBe(true)
      expect.soft(includesFailure(failure, messagingFailure)).toBe(true)
      await assertDatabasesClosed(probe.databases)
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('FX03：失败期间并发和重复 close 保持同一任务与拒绝对象，并完成后续清理', async () => {
    // 失败任务的幂等不能只靠缓存拒绝实现，还须实际处理剩余数据库和目录。
    const messagingFailure = new Error(LifecycleFailure.MESSAGING_CLOSE)
    const probe = installLifecycleProbe({ messagingClose: messagingFailure })
    let fixture: UiFixture | undefined
    try {
      fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
      const firstClose = fixture.close()
      const secondClose = fixture.close()
      expect(secondClose).toBe(firstClose)
      const [firstFailure, secondFailure] = await Promise.all([readFailure(firstClose), readFailure(secondClose)])
      const repeatedClose = fixture.close()
      expect(repeatedClose).toBe(firstClose)
      const repeatedFailure = await readFailure(repeatedClose)
      expect.soft(firstFailure).toBe(secondFailure)
      expect.soft(repeatedFailure).toBe(firstFailure)
      expect.soft(includesFailure(firstFailure, messagingFailure)).toBe(true)
      await assertDatabasesClosed(probe.databases)
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('FX03：消息与数据库同时报错时保留全部错误，目录保守保留', async () => {
    // 数据库实际释放后才抛错，但调用者没有确认状态，仍须保留目录并汇总两个错误。
    const messagingFailure = new Error(LifecycleFailure.MESSAGING_CLOSE)
    const databaseFailure = new Error(LifecycleFailure.DATABASE_CLOSE_AFTER_RELEASE)
    const probe = installLifecycleProbe({ messagingClose: messagingFailure, databaseCloseAfterRelease: databaseFailure })
    let fixture: UiFixture | undefined
    try {
      fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
      const failure = await readFailure(fixture.close())
      expect.soft(includesFailure(failure, messagingFailure)).toBe(true)
      expect.soft(includesFailure(failure, databaseFailure)).toBe(true)
      await assertDatabasesClosed(probe.databases, 'retained')
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('FX03：SQLite 真实关闭后报告错误仍保留无法确认安全删除的目录', async () => {
    // 测试知道锁已释放不等于夹具能证明；关闭抛错时保留目录才是保守合同。
    const databaseFailure = new Error(LifecycleFailure.DATABASE_CLOSE_AFTER_RELEASE)
    const probe = installLifecycleProbe({ databaseCloseAfterRelease: databaseFailure })
    let fixture: UiFixture | undefined
    try {
      fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
      const failure = await readFailure(fixture.close())
      expect.soft(includesFailure(failure, databaseFailure)).toBe(true)
      await assertDatabasesClosed(probe.databases, 'retained')
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('FX04：API 已经真实关闭后环境 close 仍正常释放其他资源', async () => {
    // 先通过真实服务器状态制造已关闭前提，而非 mock 一个“不监听”的布尔值。
    const probe = installLifecycleProbe()
    let fixture: UiFixture | undefined
    try {
      fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
      expect(probe.apiServers).toHaveLength(1)
      for (const server of probe.apiServers) {
        expect(server.listening).toBe(true)
        await closeCapturedServer(server)
        expect(server.listening).toBe(false)
      }
      const failure = await readFailure(fixture.close())
      expect.soft(failure === undefined).toBe(true)
      await assertDatabasesClosed(probe.databases)
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('FX03：SQLite 关闭前即拒绝时保留真实开放的数据库与目录，HTTP 仍停止', async () => {
    // 锁确实仍持有时不得删目录；测试最后使用保存的真实 close 独立解除锁。
    const databaseFailure = new Error(LifecycleFailure.DATABASE_CLOSE_BEFORE_RELEASE)
    const probe = installLifecycleProbe({ databaseCloseBeforeRelease: databaseFailure })
    let fixture: UiFixture | undefined
    try {
      fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
      const failure = await readFailure(fixture.close())
      expect.soft(includesFailure(failure, databaseFailure)).toBe(true)
      expect(probe.databases).toHaveLength(1)
      for (const captured of probe.databases) {
        await expect.soft(captured.database.records<{ _id: string }>('fixture_lifecycle_probe').count()).resolves.toBe(0)
        await expect.soft(directoryExists(captured.directory)).resolves.toBe(true)
      }
      for (const server of probe.servers) expect.soft(server.listening).toBe(false)
    } finally {
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })

  it('FX04：API 停止监听但仍有已接受连接时，必须等实际关闭后再释放数据库', async () => {
    // 验证真正的 closing 状态，保护“未监听不代表没有连接”的既有正确行为。
    const probe = installLifecycleProbe()
    let fixture: UiFixture | undefined
    let client: Socket | undefined
    let originalClose: Promise<void> | undefined
    let httpCloseConfirmed = false
    let httpWasClosedWhenDatabaseReleased: boolean | undefined
    try {
      fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
      expect(probe.apiServers).toHaveLength(1)
      for (const server of probe.apiServers) {
        const target = new URL(fixture.baseUrl)
        const accepted = new Promise<void>((
          /* 真实 API 已接受本测试的原生 TCP 连接后才继续关闭实验。 */ resolve,
          /* 探测连接未能建立时拒绝，不靠 sleep 猜测是否已有连接。 */ reject,
        ) => {
          // 不发送伪造 HTTP 或请求体，仅用真实 connection 事件确认资源仍在使用。
          server.once('connection', () => {
            // 服务已经持有连接，后续 server.close 不能立即确认资源结束。
            resolve()
          })
          client = createConnection({ host: target.hostname, port: Number(target.port) })
          client.once('error', (
            /* 仅属于本测试探测连接的建立错误。 */ error,
          ) => {
            // 让用例失败并进入统一收尾，不输出网络原文到业务报告。
            reject(error)
          })
        })
        await accepted
        originalClose = new Promise<void>((
          /* 已接受连接也全部关闭后才确认 API 释放。 */ resolve,
          /* 原始 server.close 的真实失败仍应由测试观察。 */ reject,
        ) => {
          // 故意只停止监听，不主动销毁连接，建立 listening=false 的未完成关闭前提。
          server.close((
            /* 最早发起的真实 close 结果，用来核验后续 SQLite 释放顺序。 */ error,
          ) => {
            // 只有原始关闭回调成功才记录确认；不从 listening 属性推导。
            if (error) reject(error)
            else {
              httpCloseConfirmed = true
              resolve()
            }
          })
        })
        expect(server.listening).toBe(false)
        expect(httpCloseConfirmed).toBe(false)
      }
      for (const captured of probe.databases) {
        vi.spyOn(captured.database, 'close').mockImplementation(async () => {
          // 在真实 SQLite 释放入口记录此前 HTTP 是否确认结束，再执行原生数据库关闭。
          httpWasClosedWhenDatabaseReleased = httpCloseConfirmed
          await captured.close()
        })
      }
      await fixture.close()
      if (originalClose) await originalClose
      expect(httpCloseConfirmed).toBe(true)
      expect(httpWasClosedWhenDatabaseReleased).toBe(true)
      await assertDatabasesClosed(probe.databases)
    } finally {
      client?.destroy()
      if (originalClose) await readFailure(originalClose)
      if (fixture) await readFailure(fixture.close())
      await probe.dispose()
    }
  })
})
