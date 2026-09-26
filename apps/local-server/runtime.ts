import { RuntimeMessage } from '../../contracts/messages'
import { randomUUID, randomBytes } from 'node:crypto'
import { writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { sqliteCreatePersistence } from '../../backend/adapters/storage/sqlite/persistence'
import { applicationCreateLocalService } from './application'
import { apiCreateServer } from '../../backend/adapters/http/graph-http-server'
import { hostCreateWorker, type HostInput, type HostWorker } from '../../backend/execution/host-worker'
import type { GraphRunConfiguration } from '../../contracts/graph'
import type { DiagnosticReporter } from '../../contracts/diagnostics'

interface LocalIdentity { _id: string; userId: string; workspaceId: string; internalToken: string; userToken?: string }
// 用途：创建运行时，供后续流程使用。
export async function localCreateRuntime(input: Pick<HostInput, 'dshBin' | 'patches' | 'env' | 'maxRounds' | 'maxTokens'> & {
  directory: string; port?: number; dshHome?: string; configuration?: GraphRunConfiguration; allowPrivateSources?: boolean; reporter?: DiagnosticReporter
}) {
  if (!input.directory.trim()) throw new Error(RuntimeMessage.LOCAL_DIRECTORY_MUST_NOT_BE_EMPTY)
  const directory = path.resolve(input.directory), port = input.port ?? 4320
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(RuntimeMessage.LOCAL_PORT_MUST_BE_BETWEEN_0_AND_65535)
  const database = sqliteCreatePersistence(directory)
  const application = applicationCreateLocalService(database, { allowPrivateSources: input.allowPrivateSources, reporter: input.reporter })
  let host: HostWorker | undefined, server: ReturnType<typeof apiCreateServer> | undefined, closing: Promise<void> | undefined
  // 用途：关闭当前模块并释放占用的资源。
  function close(): Promise<void> {
    return closing ??= (async () => {
      const failures: unknown[] = []
      // 用途：执行当前异步操作。
      async function run(action: () => Promise<unknown>) { try { await action() } catch (error) { failures.push(error) } }
      server?.beginShutdown()
      await run(() => host?.close() ?? Promise.resolve())
      if (server?.listening) {
        server.closeAllConnections()
        await run(() => new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())))
      }
      await run(() => application.closeMessaging())
      await run(() => database.close())
      if (failures.length) throw failures[0]
    })()
  }
  try {
    await application.initialize()
    const records = database.records<LocalIdentity>('local_identity')
    let identity = await records.get('owner')
    if (!identity) {
      identity = { _id: 'owner', userId: randomUUID(), workspaceId: randomUUID(), internalToken: randomBytes(32).toString('base64url') }
      await records.insert(identity)
    }
    // Bootstrap steps are idempotent; a crash cannot turn the next launch into another workspace.
    await application.control.seed(input.configuration)
    if (!await database.records<{ _id: string }>('control_users').get(identity.userId)) {
      await application.auth.createUser({ id: identity.userId, displayName: '本机用户', hostAdmin: true })
    }
    if (!identity.userToken) {
      identity.userToken = (await application.auth.createToken(identity.userId)).token
      await records.replace(identity)
    }
    const userToken = identity.userToken
    await application.auth.read(userToken)
    if (!await database.records<{ _id: string }>('control_workspaces').get(identity.workspaceId)) {
      await application.auth.transact(userToken, ctx => application.control.createWorkspace(ctx, {
        id: identity!.workspaceId, name: '本机工作区', description: '独立运行的重明工作区', agentSource: 'library',
      }))
    }
    await application.startMessaging()
    server = apiCreateServer(application, { internalToken: identity.internalToken, reporter: input.reporter })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(port, '127.0.0.1', () => { server!.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error(RuntimeMessage.LOCAL_API_DID_NOT_BIND)
    const baseUrl = 'http://127.0.0.1:' + address.port
    host = hostCreateWorker({ hostId: 'local-host', queue: { namespace: 'local', open: async () => application.localQueue },
      dataApiUrl: baseUrl, token: identity.internalToken, dshHome: input.dshHome ?? path.join(directory, 'dsh'),
      cwd: directory, processCwd: directory, dshBin: input.dshBin, patches: input.patches, env: input.env,
      maxRounds: input.maxRounds, maxTokens: input.maxTokens, reporter: input.reporter })
    await host.start()
    void application.localQueue.closed.then(() => { if (!closing) void close().catch(error => console.error('Local shutdown failed', error)) })
    const connectionPath = path.join(directory, 'connection.json'), tokenPath = path.join(directory, 'user-token')
    const temporary = connectionPath + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify({ baseUrl, tokenFile: tokenPath, workspaceId: identity.workspaceId }, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, connectionPath)
    await writeFile(tokenPath, userToken + '\n', { mode: 0o600 })
    return { application, database, host, baseUrl, workspaceId: identity.workspaceId, userToken, connectionPath, tokenPath, close }
  } catch (error) { await close(); throw error }
}
