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
import { verificationConfiguration } from '../../fixtures/verification'
import { DEFAULT_DEFINITION_PACKAGE, DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'
import { GRAPH_COLLECTION } from '../../../../backend/modules/graph/graph-record'

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
  // 根据 assess 阶段授权构造对应槽位的通用意见产物。
  if (grant.stageId !== 'assess') throw new Error('Expected assess work')
  const data = await service.readData(grant.mapId, grant.operationId, replicaReadProof(grant))
  return {
    mapId: grant.mapId, operationId: grant.operationId, id: data.proposalId,
    specHash: grant.specHash, kind: 'outputs', reason: `Durable evidence for ${grant.slotId}`,
    outputs: [{ key: `opinion-${grant.slotId}`, port: 'opinions', typeRef: { id: 'factcheck.opinion', version: 1 },
      payload: { score: 1, reason: `Durable evidence for ${grant.slotId}`, evidenceIds: [] } }],
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
    const replica = new MongoMemoryReplSet({ instanceOpts: Array.from({ length: 3 }, () => ({ launchTimeout: 30_000 })), replSet: {
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
      const storedAt = new Date().toISOString(), sourceId = randomUUID(), outputId = randomUUID(), genericMapId = randomUUID()
      expect(await store.create({ id: genericMapId, workspaceId: 'generic-workspace', revision: 0, name: 'Generic persistence', nodes: [
        { id: sourceId, revision: 0, typeId: 'demo.input', typeVersion: 1, payload: { value: 'source' }, createdAt: storedAt, updatedAt: storedAt },
        { id: outputId, revision: 0, typeId: 'demo.output', typeVersion: 2, payload: { value: 'output' }, createdAt: storedAt, updatedAt: storedAt,
          producer: { operationId: 'operation', transitionRef: { id: 'demo.transition', version: 3 }, stageId: 'produce', workId: 'work',
            agentRef: { id: 'demo.agent', version: 4 }, agentName: 'Demo agent' } },
      ], edges: [{ id: randomUUID(), revision: 0, kind: 'reference', from: outputId, to: sourceId, label: 'citation', createdAt: storedAt, updatedAt: storedAt }],
      runs: [], runHistory: [], leases: {}, receipts: [], createdAt: storedAt, updatedAt: storedAt })).toBe(true)
      expect(await store.read(genericMapId)).toMatchObject({ nodes: [
        { typeId: 'demo.input', typeVersion: 1, payload: { value: 'source' } },
        { typeId: 'demo.output', typeVersion: 2, producer: { stageId: 'produce', workId: 'work' } },
      ], edges: [{ kind: 'reference', label: 'citation' }] })
      expect(await store.list('generic-workspace')).toMatchObject([{ typeCounts: { 'demo.input': 1, 'demo.output': 1 } }])

      const legacyId = randomUUID()
      await connection.collection(GRAPH_COLLECTION).insertOne({ _id: legacyId, workspaceId: 'legacy', revision: 0, name: 'Legacy',
        nodes: [{ id: randomUUID(), revision: 0, data: { kind: 'claim', content: 'old' }, createdAt: new Date(storedAt), updatedAt: new Date(storedAt) }],
        edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: new Date(storedAt), updatedAt: new Date(storedAt),
        dispatch: { version: 0, pending: false } } as never)
      await expect(store.read(legacyId)).rejects.toMatchObject({ status: 409, code: 'NODE_SCHEMA_UNSUPPORTED' })
      const auth = authCreateService(persistenceCreateMongo(connection))
      const control = controlCreateService(persistenceCreateMongo(connection), { ...DEFAULT_RUN_CONFIGURATION, definitionPackage: DEFAULT_DEFINITION_PACKAGE })
      await auth.initialize()
      await control.initialize()
      await control.seed(verificationConfiguration())
      const user = await auth.createUser({ id: randomUUID(), displayName: 'Replica Owner', hostAdmin: true })
      const { token } = await auth.createToken(user.userId)
      const workspace = await auth.transact(token, /* 副本集测试拥有者的授权事务上下文，工作区创建复用其会话。 */ ctx => /* 在用户授权事务中建立副本集测试工作区。 */  control.createWorkspace(ctx, {
        id: randomUUID(), name: 'Replica workspace', description: '', agentSource: 'library',
      }))
      const execution = await auth.transact(token, ctx => control.executionCatalog(ctx, workspace.id))
      const service = graphCreateService(store, { leaseMs: 4000 })
      const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
      await service.dispatch({ requestId: randomUUID(), method: 'map.create', params: {
        workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Replica election proof',
      } })
      await service.dispatch({ requestId: randomUUID(), method: 'graph.apply', params: {
        mapId, branch: { rootIds: [claimId], expectedVersion: null },
        changes: { nodes: { put: [{ id: claimId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'Durable claim', category: 'data' } }] } },
      } }, { definitions: execution.definitions })
      const runBranch = await service.read({ method: 'branch.get', params: { mapId, rootIds: [claimId] } })
      if (!('scope' in runBranch)) throw new Error('Branch missing')
      const branchClaim = await service.dispatch({ requestId: randomUUID(), method: 'branch.claim', params: {
        mapId, rootIds: runBranch.scope.rootIds, holderId: randomUUID(),
      } }, { definitions: execution.definitions, actorUserId: user.userId })
      if (!('status' in branchClaim.data) || branchClaim.data.status !== 'claimed') throw new Error('Branch claim missing')
      await service.dispatch({ requestId: randomUUID(), method: 'run.start', params: {
        mapId, id: runId, branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version },
        lease: { leaseId: branchClaim.data.grant.leaseId, holderId: branchClaim.data.grant.holderId, fence: branchClaim.data.grant.fence },
        scope: { nodeIds: [claimId] }, regenerate: true, mode: 'auto', plan: { steps: [{
          id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
          input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [claimId] } }],
          context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail',
        }] },
      } }, { definitions: execution.definitions, actorUserId: user.userId, run: { definitions: execution.definitions, agents: execution.agents,
        tools: execution.tools, maxSlots: execution.maxSlots } })
      const router = await replicaReadGrant(service, store, mapId, 'router-host')
      expect(router).toMatchObject({ stageId: 'route', slotId: 'route' })
      const routeData = await service.readData(mapId, router.operationId, replicaReadProof(router))
      const operation = (await store.read(mapId))!.runs[0].operations[0]
      const candidates = operation.executionSpec.stages.find(stage => stage.id === 'route')!.plan!.agents.slice(0, 2)
      await service.propose(mapId, router.operationId, {
        mapId, operationId: router.operationId, id: routeData.proposalId,
        specHash: router.specHash, kind: 'plan', reason: 'Two independent evidence paths', slots: candidates.map((agent, index) => ({
          id: `angle-${index + 1}`, stageId: 'assess', agentRef: agent.ref, angle: `angle-${index + 1}`,
          hint: `Follow evidence chain ${index + 1}`, priority: 'high', tools: [...agent.profile.tools],
        })),
      }, replicaReadProof(router))

      const completed = await replicaReadGrant(service, store, mapId, 'completed-host')
      const acceptedReport = await replicaReadReport(service, completed)
      await service.propose(mapId, completed.operationId, acceptedReport, replicaReadProof(completed))
      const unfinished = await replicaReadGrant(service, store, mapId, 'interrupted-host')
      const pendingReport = await replicaReadReport(service, unfinished)
      expect(unfinished.workId).not.toBe(completed.workId)
      const before = (await store.read(mapId))!
      for (const altered of [
        { ...unfinished, runId: unfinished.runId + '-stale' },
        { ...unfinished, stageId: unfinished.stageId + '-stale' },
        { ...unfinished, specHash: unfinished.specHash + '-stale' },
      ]) {
        expect(await store.commit({ ...structuredClone(before), name: 'Must not commit' }, before.revision,
          { requestId: randomUUID(), method: 'fixture.commit', inputHash: 'hash', createdNodeIds: [], createdEdgeIds: [], createdAt: storedAt }, altered)).toBe(false)
      }
      expect((await store.read(mapId))!.name).toBe('Replica election proof')
      expect(before.runs[0].operations[0].stages.find(stage => stage.stageId === 'assess')!.results).toHaveLength(1)
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
      await expect(replacementService.propose(mapId, unfinished.operationId, pendingReport, replicaReadProof(unfinished)))
        .rejects.toMatchObject({ code: 'LEASE_LOST' })
      const fenced = (await replacementStore.read(mapId))!
      expect(fenced.runs[0].operations[0].stages.find(stage => stage.stageId === 'assess')!.results)
        .toEqual(before.runs[0].operations[0].stages.find(stage => stage.stageId === 'assess')!.results)
      expect(fenced.receipts).toEqual(before.receipts)
      expect(fenced.leases[completed.workId]).toEqual(before.leases[completed.workId])
      expect(fenced.leases[unfinished.workId].fence).toBe(replacement.fence)

      await replacementService.propose(mapId, replacement.operationId, pendingReport, replicaReadProof(replacement))
      const finished = (await replacementStore.read(mapId))!
      expect(finished.runs[0].operations[0].stages.find(stage => stage.stageId === 'assess')!.results).toHaveLength(2)
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
