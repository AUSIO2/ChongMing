// 文件职责：验证 SQLite 事务隔离、授权租约、崩溃恢复和完整本机服务重启。
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sqliteCreatePersistence, type SqlitePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { applicationCreateLocalService } from '../../../../apps/local-server/application'
import { verificationConfiguration } from '../../fixtures/verification'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import { localCreateRuntime } from '../../../../apps/local-server/runtime'
import { GRAPH_COLLECTION } from '../../../../backend/modules/graph/graph-record'
import { activityReadRecord } from '../../../../backend/modules/graph/work-activity'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  // 按创建逆序释放各用例注册的数据库、服务与临时目录。
   for (const close of cleanup.splice(0).reverse()) await close() })
async function sqliteCreateFixture() {
  // 创建独立临时目录及 SQLite 连接，并注册配套清理。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-sqlite-'))
  cleanup.push(() => /* 删除用例专属数据库与附件目录。 */  rm(directory, { recursive: true, force: true }))
  const database = sqliteCreatePersistence(directory)
  cleanup.push(() => /* 关闭测试创建的 SQLite 持久化连接。 */  database.close())
  return { directory, database }
}
async function sqliteCreateApp(/* 夹具创建的 SQLite 持久化连接，应用共用它但清理由外层登记。 */ database: SqlitePersistence) {
  // 基于给定数据库启动已初始化和配置的本机应用及消息服务。
  const app = applicationCreateLocalService(database, { leaseMs: 250 })
  cleanup.push(() => /* 停止夹具应用的进程内消息服务。 */  app.closeMessaging())
  await app.initialize(); await app.control.seed(verificationConfiguration()); await app.startMessaging()
  return app
}

describe('Independent SQLite persistence', () => {
  // 覆盖独立本机持久化从事务到进程恢复的行为。
  it('rolls back atomically, isolates asynchronous readers and persists across exclusive reopening', async () => {
    // 验证失败事务不留数据或通知，外部读取等待提交，独占连接关闭后可持久重开。
    const { database, directory } = await sqliteCreateFixture()
    expect(() => /* 尝试重复打开同一数据库以验证独占锁。 */  sqliteCreatePersistence(directory)).toThrow()
    const records = database.records<{ _id: string; value: number }>('test')
    const changes: unknown[] = []
    database.subscribe(/* 成功提交后发布的记录变更批次，保存以验证回滚不产生通知。 */ items => /* 记录提交后通知，供回滚不通知的断言使用。 */  changes.push(items))
    await expect(database.transaction(async /* 故意失败事务的活动会话，插入必须在此会话中才能随异常回滚。 */ tx => {
      // 插入记录后抛错，验证事务整体回滚。
       await records.insert({ _id: 'a', value: 1 }, tx); throw new Error('rollback') })).rejects.toThrow('rollback')
    expect(await records.get('a')).toBeNull()
    expect(changes).toEqual([])
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(/* 事务已写入但尚未提交的通知回调，用来协调外部读取时机。 */ resolve => {
      // 保存事务已写入的同步点通知回调。
       entered = resolve }), gate = new Promise<void>(/* 允许挂起事务继续提交的回调，由用例断言隔离性后显式调用。 */ resolve => {
      // 保存允许挂起事务继续提交的释放回调。
       release = resolve })
    const writing = database.transaction(async /* 被用例暂停的写事务会话，记录插入保持未提交状态。 */ tx => {
      // 在事务内写入记录后暂停，让外部读取验证隔离性。
       await records.insert({ _id: 'a', value: 2 }, tx); entered(); await gate })
    await ready
    let readFinished = false
    const reading = records.get('a').then(/* 外部读取完成后得到的记录副本，用于标记读取何时真正结束。 */ value => {
      // 标记外部读取实际结束并透传结果。
       readFinished = true; return value })
    await Promise.resolve()
    expect(readFinished).toBe(false)
    release(); await writing
    expect(await reading).toEqual({ _id: 'a', value: 2 })
    await database.close()
    const reopened = sqliteCreatePersistence(directory)
    cleanup.push(() => /* 关闭持久化重开后的测试连接。 */  reopened.close())
    expect(await reopened.records('test').get('a')).toEqual({ _id: 'a', value: 2 })
  })

  it('roundtrips generic node metadata, summarizes type ids and refuses legacy node/run records', async () => {
    // 通用数据的类型、payload、来源及关系必须完整持久化；旧 data/operation 结构只能显式迁移。
    const { database } = await sqliteCreateFixture(), store = database.graph()
    const now = new Date().toISOString(), mapId = randomUUID(), firstId = randomUUID(), secondId = randomUUID()
    expect(await store.create({ id: mapId, workspaceId: 'workspace', revision: 0, name: 'Generic', nodes: [
      { id: firstId, revision: 0, typeId: 'demo.input', typeVersion: 2, payload: { text: 'input' }, createdAt: now, updatedAt: now },
      { id: secondId, revision: 0, typeId: 'demo.output', typeVersion: 1, payload: { text: 'output' }, createdAt: now, updatedAt: now,
        producer: { operationId: 'operation', transitionRef: { id: 'demo.transition', version: 3 }, stageId: 'produce', workId: 'work',
          agentRef: { id: 'demo.agent', version: 4 }, agentName: 'Demo agent' } },
    ], edges: [{ id: randomUUID(), revision: 0, kind: 'successor', from: firstId, to: secondId, label: 'demo.transition@3:output', createdAt: now, updatedAt: now }],
    runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now })).toBe(true)
    expect(await store.read(mapId)).toMatchObject({ nodes: [
      { typeId: 'demo.input', typeVersion: 2, payload: { text: 'input' } },
      { typeId: 'demo.output', typeVersion: 1, payload: { text: 'output' }, producer: { stageId: 'produce', workId: 'work' } },
    ], edges: [{ kind: 'successor', label: 'demo.transition@3:output' }] })
    expect(await store.list('workspace')).toMatchObject([{ nodeCount: 2, typeCounts: { 'demo.input': 1, 'demo.output': 1 } }])

    const records = database.records<Record<string, unknown> & { _id: string }>(GRAPH_COLLECTION)
    const legacyNodeId = randomUUID()
    await records.insert({ _id: legacyNodeId, id: legacyNodeId, workspaceId: 'workspace', revision: 0, name: 'Legacy node',
      nodes: [{ id: randomUUID(), revision: 0, data: { kind: 'claim', content: 'old' }, createdAt: now, updatedAt: now }], edges: [],
      runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now, dispatch: { version: 0, pending: false } })
    await expect(store.read(legacyNodeId)).rejects.toMatchObject({ status: 409, code: 'NODE_SCHEMA_UNSUPPORTED' })

    const legacyRunId = randomUUID()
    await records.insert({ _id: legacyRunId, id: legacyRunId, workspaceId: 'workspace', revision: 0, name: 'Legacy run', nodes: [], edges: [],
      run: { id: 'run', configuration: {}, operation: {} }, runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now,
      dispatch: { version: 0, pending: false } })
    await expect(store.read(legacyRunId)).rejects.toMatchObject({ status: 409, code: 'RUN_SCHEMA_UNSUPPORTED' })
  })

  it('shares authorization transactions, idempotency, CAS and pause fences with the graph service', async () => {
    // 验证 SQLite 共用授权事务、请求重放、版本冲突和暂停后的租约栅栏。
    const { database, directory } = await sqliteCreateFixture(), app = await sqliteCreateApp(database)
    const user = await app.auth.createUser({ id: randomUUID(), displayName: 'Local', hostAdmin: true })
    const { token } = await app.auth.createToken(user.userId)
    const workspace = await app.auth.transact(token, /* 拥有者令牌对应的授权事务上下文，工作区创建沿用其会话。 */ ctx => /* 在用户授权事务中创建本机工作区。 */  app.control.createWorkspace(ctx, { id: randomUUID(), name: 'Local', description: '', agentSource: 'library' }))
    const mapId = randomUUID(), claimId = randomUUID()
    const create = { requestId: randomUUID(), method: 'map.create' as const, params: { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Local graph' } }
    expect((await app.dispatch(token, create)).replayed).toBe(false)
    expect((await app.dispatch(token, create)).replayed).toBe(true)
    await app.dispatch(token, { requestId: randomUUID(), method: 'graph.apply', params: { mapId, branch: { rootIds: [claimId], expectedVersion: null },
      changes: { nodes: { put: [{ id: claimId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'A local fact', category: null } }] } } } })
    const runId = randomUUID(), runBranch = await app.graph.read({ method: 'branch.get', params: { mapId, rootIds: [claimId] } })
    if (!('scope' in runBranch)) throw new Error('Branch missing')
    const started = await app.dispatch(token, { requestId: randomUUID(), method: 'run.start', params: { mapId, id: runId,
      branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version },
      scope: { nodeIds: [claimId] }, mode: 'auto', plan: { steps: [{
      id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [claimId] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } } })
    expect(started.data).not.toHaveProperty('runControl')
    const work = workReadItems((await app.store.read(mapId))!)[0]
    const first = await app.graph.dispatchWork({ method: 'claim', params: { mapId, workId: work.workId, deploymentId: app.messaging().deploymentId, hostId: 'local', holderId: randomUUID() } })
    if (!('status' in first) || first.status !== 'claimed') throw new Error('Claim missing')
    const grant = first.grant
    const before = await app.readSnapshot(token, mapId)
    await expect(app.auth.transact(token, async /* 准备主动失败的授权事务上下文，测试业务记录与身份写入一起回滚。 */ ctx => {
      // 授权事务写入后主动失败，验证业务记录随事务回滚。
      await database.records<{ _id: string; marker?: boolean }>('test').insert({ _id: 'never', marker: true }, ctx.session)
      throw new Error('reject')
    })).rejects.toThrow('reject')
    expect(await database.records('test').get('never')).toBeNull()
    await app.dispatch(token, { requestId: randomUUID(), method: 'run.pause', params: { mapId, runId } })
    expect(await app.store.readLease(mapId, grant)).toBeNull()
    await app.dispatch(token, { requestId: randomUUID(), method: 'run.resume', params: { mapId, runId } })
    const second = await app.graph.dispatchWork({ method: 'claim', params: { mapId, workId: work.workId, deploymentId: app.messaging().deploymentId, hostId: 'local', holderId: randomUUID() } })
    if (!('status' in second) || second.status !== 'claimed') throw new Error('Reclaim missing')
    expect(second.grant.fence).toBeGreaterThan(grant.fence)
    expect(await activityReadRecord(app.store, mapId, second.grant, 'model', 1)).toMatchObject({
      mapId, runId, operationId: second.grant.operationId, workId: second.grant.workId,
      stageId: second.grant.stageId, slotId: second.grant.slotId, agentName: 'Custom custom-router', status: 'model', fence: second.grant.fence,
    })
    const current = (await app.store.read(mapId))!
    expect(await app.store.commit({ ...structuredClone(current), name: 'Must not commit' }, current.revision,
      { requestId: randomUUID(), method: 'fixture.commit', inputHash: 'hash', createdNodeIds: [], createdEdgeIds: [], createdAt: new Date().toISOString() },
      { ...second.grant, specHash: second.grant.specHash + '-stale' })).toBe(false)
    expect((await app.store.read(mapId))!.name).toBe('Local graph')
    await expect(app.graph.dispatchWork({ method: 'renew', params: { mapId, ...grant } })).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(await app.store.release(mapId, grant)).toBe(false)
    const latest = (await app.store.read(mapId))!
    expect(await app.store.commit({ ...structuredClone(latest), name: 'wrong' }, latest.revision - 1,
      { requestId: randomUUID(), method: 'fixture.cas', inputHash: 'hash', createdNodeIds: [], createdEdgeIds: [], createdAt: new Date().toISOString() })).toBe(false)
    await app.auth.revokeToken((await app.auth.createToken(user.userId)).tokenId)
    expect((await app.readSnapshot(token, mapId)).runs.find(run => run.id === runId)?.paused).toBe(false)
    await app.closeMessaging(); await database.close()
    const reopened = sqliteCreatePersistence(directory)
    cleanup.push(() => /* 关闭模拟重启后重新打开的数据库。 */  reopened.close())
    const resumed = await sqliteCreateApp(reopened)
    const claimAgain = () => /* 为重启后 Host 尝试领取同一工作，以比较期限前后的结果。 */  resumed.graph.dispatchWork({ method: 'claim', params: { mapId, workId: work.workId,
      deploymentId: resumed.messaging().deploymentId, hostId: 'after-restart', holderId: randomUUID() } })
    expect(await claimAgain()).toMatchObject({ status: 'busy' })
    await delay(300)
    const afterCrash = await claimAgain()
    if (!('status' in afterCrash) || afterCrash.status !== 'claimed') throw new Error('Recovery claim missing')
    expect(afterCrash.grant.fence).toBeGreaterThan(second.grant.fence)
    expect((await resumed.readSnapshot(token, mapId)).nodes).toEqual(before.nodes)

  })

  it('recovers the file lock and rolls back an open transaction after SIGKILL', async () => {
    // 强杀持有未提交事务的子进程，验证文件锁释放且只有已提交记录留存。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-crash-'))
    cleanup.push(() => /* 清理强杀恢复用例的临时目录。 */  rm(directory, { recursive: true, force: true }))
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/backend/fixtures/sqlite-crash.ts', directory], { stdio: ['ignore', 'pipe', 'pipe'] })
    const ended = new Promise<void>((/* 崩溃夹具子进程退出后兑现等待的回调。 */ resolve, /* 子进程启动出错时拒绝退出等待的回调。 */ reject) => {
      // 等待测试子进程退出，并传播启动失败。
       child.once('exit', () => /* 通知崩溃夹具进程已经结束。 */  resolve()); child.once('error', reject) })
    let output = ''
    child.stdout.on('data', /* 崩溃夹具 stdout 字节块，累积后查找事务已打开的同步标记。 */ chunk => {
      // 收集夹具 stdout，等待事务打开的确定性标记。
       output += chunk })
    try {
      await expect.poll(() => /* 返回已收到的进程输出，供有界轮询定位事务同步点。 */  output, { timeout: 5000 }).toContain('transaction-open')
      expect(() => /* 在子进程仍持锁时尝试打开数据库，确认独占约束生效。 */  sqliteCreatePersistence(directory)).toThrow()
      child.kill('SIGKILL'); await ended
      const database = sqliteCreatePersistence(directory)
      cleanup.push(() => /* 关闭崩溃恢复后重新打开的数据库。 */  database.close())
      expect(await database.records('crash_test').get('committed')).toMatchObject({ value: 'retained' })
      expect(await database.records('crash_test').get('pending')).toBeNull()
    } finally { child.kill('SIGKILL'); await ended }
  })

  it('restarts a complete local service with the same identity, configuration, workspace and stored graph', async () => {
    // 重启完整本机运行时，验证身份、配置、工作区、图和部署身份均保留。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-runtime-'))
    cleanup.push(() => /* 清理完整运行时重启测试的持久化目录。 */  rm(directory, { recursive: true, force: true }))
    const one = await localCreateRuntime({ directory, port: 0, concurrency: 2, configuration: verificationConfiguration() })
    cleanup.push(() => /* 关闭第一轮本机服务运行时。 */  one.close())
    const workspace = await one.application.read(one.userToken, { method: 'workspace.get', params: { workspaceId: one.workspaceId } })
    if (!('revision' in workspace)) throw new Error('Workspace missing')
    const mapId = randomUUID()
    await one.application.dispatch(one.userToken, { requestId: randomUUID(), method: 'map.create', params: { workspaceId: one.workspaceId, expectedRevision: workspace.revision, id: mapId, name: 'Survives restart' } })
    await one.close()
    const two = await localCreateRuntime({ directory, port: 0, concurrency: 3, configuration: verificationConfiguration() })
    cleanup.push(() => /* 关闭重启后的第二轮本机服务运行时。 */  two.close())
    expect(two.userToken).toBe(one.userToken)
    expect(two.workspaceId).toBe(one.workspaceId)
    expect((await two.application.readSnapshot(two.userToken, mapId)).name).toBe('Survives restart')
    expect(two.application.messaging().deploymentId).toBe(one.application.messaging().deploymentId)
    expect(one.host.concurrency).toBe(2)
    expect(two.host.concurrency).toBe(3)
  })
})
