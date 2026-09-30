// 组合本地 SQLite、用户身份、HTTP API 与单个 Host，统一持有并释放运行资源。
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

// 持久化的本机身份及工作区编号，保留内部和用户令牌供重启恢复。
interface LocalIdentity { _id: string; userId: string; workspaceId: string; internalToken: string; userToken?: string }
/**
 * 创建或恢复本机身份和工作区，启动 API 与 Host 并写入连接文件，失败时统一收回资源。
 *
 * @param input 运行目录及可选执行配置；端口缺省为 4320、零表示随机端口，配置与环境交给本地应用和 Host。
 */
export async function localCreateRuntime(input: Pick<HostInput, 'dshBin' | 'patches' | 'env' | 'maxRounds' | 'maxTokens' | 'concurrency'> & {
  directory: string; port?: number; dshHome?: string; configuration?: GraphRunConfiguration; allowPrivateSources?: boolean; reporter?: DiagnosticReporter
}) {
  if (!input.directory.trim()) throw new Error(RuntimeMessage.LOCAL_DIRECTORY_MUST_NOT_BE_EMPTY)
  const directory = path.resolve(input.directory), port = input.port ?? 4320
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(RuntimeMessage.LOCAL_PORT_MUST_BE_BETWEEN_0_AND_65535)
  const database = sqliteCreatePersistence(directory)
  const application = applicationCreateLocalService(database, { allowPrivateSources: input.allowPrivateSources, reporter: input.reporter })
  let host: HostWorker | undefined, server: ReturnType<typeof apiCreateServer> | undefined, closing: Promise<void> | undefined
  function close(): Promise<void> {
    // 复用同一关闭任务，保证部分初始化失败也能走统一清理流程。
    return closing ??= (async () => {
      // 按 Host、HTTP、消息、数据库的顺序尝试全部清理，最后传播首个失败。
      const failures: unknown[] = []
      /**
       * 执行单个清理步骤并收集错误，避免某项失败跳过后续资源回收。
       *
       * @param action 需要尝试的单项异步清理，错误先收集以便后续资源仍能回收。
       */
      async function run(action: () => Promise<unknown>) {
         try { await action() } catch (error) { failures.push(error) } }
      server?.beginShutdown()
      await run(() => /* 等待已创建的 Host 停止，尚未创建时直接完成。 */  host?.close() ?? Promise.resolve())
      if (server?.listening) {
        server.closeAllConnections()
        await run(() => /* 为仍在监听的 HTTP 服务建立关闭等待。 */  new Promise<void>((resolve, reject) => /* 请求关闭 HTTP 服务并由回调完成等待。 */  server!.close(error => /* HTTP 关闭失败时传播错误，否则确认结束。 */  error ? reject(error) : resolve())))
      }
      await run(() => /* 等待本地消息服务关闭。 */  application.closeMessaging())
      await run(() => /* 等待 SQLite 持久化释放连接与目录占用。 */  database.close())
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
    // 初始化沿用持久化身份并逐项判重，崩溃后重启不会创建另一套工作区。
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
      await application.auth.transact(userToken, ctx => /* 以本机用户身份在事务中创建固定编号的工作区。 */  application.control.createWorkspace(ctx, {
        id: identity!.workspaceId, name: '本机工作区', description: '独立运行的重明工作区', agentSource: 'library',
      }))
    }
    await application.startMessaging()
    server = apiCreateServer(application, { internalToken: identity.internalToken, reporter: input.reporter })
    await new Promise<void>((resolve, reject) => {
      // 等待本地 API 完成端口绑定或报告监听错误。
      server!.once('error', reject)
      server!.listen(port, '127.0.0.1', () => {
        // 监听成功后移除启动期错误监听并完成等待。
         server!.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error(RuntimeMessage.LOCAL_API_DID_NOT_BIND)
    const baseUrl = 'http://127.0.0.1:' + address.port
    host = hostCreateWorker({ hostId: 'local-host', queue: { namespace: 'local', open: async () => /* 向本地 Host 提供同一进程内的工作队列。 */  application.localQueue },
      dataApiUrl: baseUrl, token: identity.internalToken, dshHome: input.dshHome ?? path.join(directory, 'dsh'),
      cwd: directory, processCwd: directory, dshBin: input.dshBin, patches: input.patches, env: input.env,
      maxRounds: input.maxRounds, maxTokens: input.maxTokens, concurrency: input.concurrency, reporter: input.reporter })
    await host.start()
    void application.localQueue.closed.then(() => {
      // 队列意外关闭时触发整个本地运行时清理，避免留下无消费者的 API。
       if (!closing) void close().catch(error => /* 将意外队列关闭后的清理失败写入控制台。 */  console.error('Local shutdown failed', error)) })
    const connectionPath = path.join(directory, 'connection.json'), tokenPath = path.join(directory, 'user-token')
    const temporary = connectionPath + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify({ baseUrl, tokenFile: tokenPath, workspaceId: identity.workspaceId }, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, connectionPath)
    await writeFile(tokenPath, userToken + '\n', { mode: 0o600 })
    return { application, database, host, baseUrl, workspaceId: identity.workspaceId, userToken, connectionPath, tokenPath, close }
  } catch (error) { await close(); throw error }
}
