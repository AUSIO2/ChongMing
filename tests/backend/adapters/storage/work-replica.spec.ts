// 文件职责：验证 Mongo 主节点切换后多数派数据保留与租约接管栅栏。
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mongo, type Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { describe, expect, it } from 'vitest'
import { graphCreateService, type GraphService } from '../../../../backend/modules/graph/graph-service'
import { authCreateService } from '../../../../backend/modules/identity/identity-service'
import { controlCreateService } from '../../../../backend/modules/workspace/workspace-service'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { storeCreateGraphStore } from '../../../../backend/adapters/storage/mongo/graph-store'
import { type GraphStore } from '../../../../backend/ports/graph-store'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import type { GraphDataProposal, GraphWorkGrant } from '../../../../contracts/graph'
import { verificationConfiguration, verificationSlots } from '../../fixtures/verification'
import { DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'

function replicaReadProof(/* 真实领取返回的工作授权，提取图身份及 holder/fence 用于后续 API 调用。 */ grant: GraphWorkGrant) {
  // 从测试授权中提取工作 API 所需的图身份与租约凭证。
  return { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence }
}

async function replicaReadGrant(/* 绑定目标 Mongo 连接的图服务，负责为测试 Host 领取工作。 */ service: GraphService, /* 同一数据库的图存储，用于读取并推导当前可执行工作。 */ store: GraphStore, /* 本用例要领取工作的图身份。 */ mapId: string, /* 本次模拟执行者的 Host 身份，不同阶段使用不同名字追踪归属。 */ hostId: string): Promise<GraphWorkGrant> {
  // 遍历当前可执行工作，返回指定 Host 成功领取的第一份授权。
  const document = await store.read(mapId)
  if (!document) throw new Error('Expected a graph document')
  for (const item of workReadItems(document)) {
    const result = await service.dispatchWork({ method: 'claim', params: {
      mapId, workId: item.workId, hostId, holderId: randomUUID(), deploymentId: randomUUID(),
    } })
    if ('status' in result && result.status === 'claimed') return result.grant
  }
  throw new Error('Expected a claimed work grant')
}

async function replicaReadReport(/* 提供授权数据读取的图服务，可能属于选举前或选举后的连接。 */ service: GraphService, /* 已领取的 worker 授权，槽位身份决定生成哪份核查报告。 */ grant: GraphWorkGrant): Promise<GraphDataProposal> {
  // 根据 worker 授权及已批准路由构造对应槽位的核查报告。
  const actor = grant.actor
  if (actor.role !== 'worker') throw new Error('Expected worker work')
  const data = await service.readData(grant.mapId, grant.operationId, replicaReadProof(grant))
  if (!data.route) throw new Error('Worker has no route')
  return {
    mapId: grant.mapId, operationId: grant.operationId, id: data.proposalId,
    kind: 'report', routeRevision: data.route.revision, slotId: actor.slotId,
    score: 1, reason: `Durable evidence for ${actor.slotId}`,
  }
}

async function replicaReadPrimary(/* 需要确认主节点状态的真实 Mongo 客户端连接。 */ connection: Connection, /* 可选旧主节点地址；提供时必须等到不同地址成为可写主节点。 */ previous?: string): Promise<string> {
  // 有界等待副本集选出可写主节点，必要时排除旧主节点。
  const deadline = Date.now() + 20_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const hello = await connection.db!.admin().command({ hello: 1 })
      if (hello.isWritablePrimary === true && typeof hello.me === 'string' && hello.me !== previous) return hello.me
    } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`Replica set did not elect a different writable primary: ${String(lastError ?? previous)}`)
}

describe('Work leases across a Mongo primary election', () => {
  // 覆盖真实主节点选举期间工作状态与授权的持久性。
  it('preserves majority-confirmed reports and fences, then fences the expired holder after takeover', async () => {
    // 切换主节点后验证已确认报告保留，过期工作可接管且旧持有者无法继续提交。
    const replica = new MongoMemoryReplSet({ replSet: {
      count: 3, storageEngine: 'wiredTiger', name: `work-replica-${randomUUID()}`,
      configSettings: { electionTimeoutMillis: 1000, heartbeatIntervalMillis: 250, heartbeatTimeoutSecs: 2 },
    } })
    const connections: Connection[] = []
    try {
      await replica.start()
      const uri = replica.getUri(`work_replica_${randomUUID().replaceAll('-', '')}`)
      const connection = await storeCreateConnection(uri)
      connections.push(connection)
      const store = storeCreateGraphStore(connection)
      await store.initialize()
      const auth = authCreateService(persistenceCreateMongo(connection))
      const control = controlCreateService(persistenceCreateMongo(connection), DEFAULT_RUN_CONFIGURATION)
      await auth.initialize()
      await control.initialize()
      await control.seed(verificationConfiguration())
      const user = await auth.createUser({ id: randomUUID(), displayName: 'Replica Owner', hostAdmin: true })
      const { token } = await auth.createToken(user.userId)
      const workspace = await auth.transact(token, /* 副本集测试拥有者的授权事务上下文，工作区创建复用其会话。 */ ctx => /* 在用户授权事务中建立副本集测试工作区。 */  control.createWorkspace(ctx, {
        id: randomUUID(), name: 'Replica workspace', description: '', agentSource: 'library',
      }))
      const service = graphCreateService(store, { leaseMs: 4000 })
      const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
      await service.dispatch({ requestId: randomUUID(), method: 'map.create', params: {
        workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Replica election proof',
      } })
      await service.dispatch({ requestId: randomUUID(), method: 'graph.apply', params: {
        mapId, expectedRevision: 0,
        changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'Durable claim', category: 'data' } }] } },
      } })
      await service.dispatch({ requestId: randomUUID(), method: 'run.start', params: {
        mapId, expectedRevision: 1, id: runId, scope: { nodeIds: [claimId] }, until: 'verified', regenerate: true, mode: 'auto',
      } }, verificationConfiguration())
      const router = await replicaReadGrant(service, store, mapId, 'router-host')
      expect(router.actor.role).toBe('router')
      const routeData = await service.readData(mapId, router.operationId, replicaReadProof(router))
      await service.propose({
        mapId, operationId: router.operationId, id: routeData.proposalId,
        kind: 'route', reason: 'Two independent evidence paths', slots: verificationSlots(2),
      }, replicaReadProof(router))

      const completed = await replicaReadGrant(service, store, mapId, 'completed-host')
      const acceptedReport = await replicaReadReport(service, completed)
      await service.propose(acceptedReport, replicaReadProof(completed))
      const unfinished = await replicaReadGrant(service, store, mapId, 'interrupted-host')
      const pendingReport = await replicaReadReport(service, unfinished)
      expect(unfinished.workId).not.toBe(completed.workId)
      const before = (await store.read(mapId))!
      expect(before.run!.operations[0].reports).toHaveLength(1)
      expect(before.receipts.some(/* 选举前图中的收据，检查已成功报告的请求身份。 */ receipt => /* 确认已提交报告对应收据存在。 */  receipt.requestId === acceptedReport.id)).toBe(true)
      expect(before.receipts.some(/* 选举前图中的收据，确认尚未提交报告没有成功记录。 */ receipt => /* 确认尚未提交报告还没有成功收据。 */  receipt.requestId === pendingReport.id)).toBe(false)
      expect(before.leases[unfinished.workId]).toEqual(unfinished)

      const oldPrimary = await replicaReadPrimary(connection)
      try {
        await connection.db!.admin().command({ replSetStepDown: 20, secondaryCatchUpPeriodSecs: 5 })
      } catch (error) {
        // A successful step-down can close the command socket before returning its acknowledgement.
        const electionError = error instanceof mongo.MongoNetworkError
          || (error instanceof mongo.MongoServerError && [91, 189, 10107, 11600, 11602].includes(Number(error.code)))
        if (!electionError) throw error
      }
      const newPrimary = await replicaReadPrimary(connection, oldPrimary)
      expect(newPrimary).not.toBe(oldPrimary)

      // A fresh client must discover the new primary and read the acknowledged state from it.
      const replacementConnection = await storeCreateConnection(uri)
      connections.push(replacementConnection)
      expect(await replicaReadPrimary(replacementConnection)).toBe(newPrimary)
      const replacementStore = storeCreateGraphStore(replacementConnection)
      const replacementService = graphCreateService(replacementStore, { leaseMs: 4000 })
      expect(await replacementStore.read(mapId)).toEqual(before)

      const hello = await replacementConnection.db!.admin().command({ hello: 1 })
      const remaining = Date.parse(unfinished.expiresAt) - new Date(hello.localTime).getTime()
      if (remaining > 0) await delay(remaining + 100)
      await expect(replacementService.dispatchWork({ method: 'renew', params: replicaReadProof(unfinished) }))
        .rejects.toMatchObject({ code: 'LEASE_LOST' })
      const replacement = await replicaReadGrant(replacementService, replacementStore, mapId, 'replacement-host')
      expect(replacement.workId).toBe(unfinished.workId)
      expect(replacement.fence).toBe(unfinished.fence + 1)
      expect(replacement.holderId).not.toBe(unfinished.holderId)
      await expect(replacementService.propose(pendingReport, replicaReadProof(unfinished)))
        .rejects.toMatchObject({ code: 'LEASE_LOST' })
      const fenced = (await replacementStore.read(mapId))!
      expect(fenced.run!.operations[0].reports).toEqual(before.run!.operations[0].reports)
      expect(fenced.receipts).toEqual(before.receipts)
      expect(fenced.leases[completed.workId]).toEqual(before.leases[completed.workId])
      expect(fenced.leases[unfinished.workId].fence).toBe(replacement.fence)

      await replacementService.propose(pendingReport, replicaReadProof(replacement))
      const finished = (await replacementStore.read(mapId))!
      expect(finished.run!.operations[0].reports).toHaveLength(2)
      expect(finished.receipts.filter(/* 恢复后的持久收据，统计原已成功报告是否仍恰好一份。 */ receipt => /* 统计原已接纳报告的收据，验证选举恢复后没有重复提交。 */  receipt.requestId === acceptedReport.id)).toHaveLength(1)
      expect(finished.receipts.filter(/* 恢复后的持久收据，统计接管报告是否仅被接纳一次。 */ receipt => /* 统计接管后报告的收据，验证只接纳一次。 */  receipt.requestId === pendingReport.id)).toHaveLength(1)
    } finally {
      const closed = await Promise.allSettled(connections.map(/* 测试建立的某条 Mongo 连接，均需在副本集停止前关闭。 */ connection => /* 并行关闭所有选举前后的 Mongo 客户端连接。 */  connection.close()))
      await replica.stop({ doCleanup: true, force: true })
      const failure = closed.find(/* 单条连接关闭的 Promise.allSettled 结果，用于查找清理失败。 */ result => /* 找到连接清理中的失败，避免测试结束时静默忽略资源错误。 */  result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
  }, 60_000)
})
