// 先定义跨Map显式选材与使用历史验收，再接真实Mongo/HTTP生产路径；原114条库业务用例保持不变。
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { EvidenceLibraryEntry } from '../../contracts/evidence-library'
import type { GraphNodeInput } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphWorkGrant } from '../../contracts/graph-work'

import {
  evidenceCreateUsageFixture, usageRecord, usageRecords, usageRef, usageResponseData, usageString,
  type UsageTestResponse, type UsageTestRun, type UsageTestScope,
} from './usage-fixture'

enum UsageTestMessage {
  NODE_MISSING = 'Usage test cannot find its saved consumer node.',
  OPERATION_MISSING = 'Usage test cannot find its real Operation.',
  DATABASE_MISSING = 'Usage test requires its existing Mongo database.',
  LEASE_MISSING = 'Usage test requires the claimed consumer branch.',
}

let fixture: Awaited<ReturnType<typeof evidenceCreateUsageFixture>>
let scope: UsageTestScope

beforeAll(async () => {
  // 只启动自有临时Mongo/public/internal HTTP，不配置Rabbit或外部模型。
  fixture = await evidenceCreateUsageFixture()
})
beforeEach(async () => {
  // 每例拥有真实独立workspace、Agent副本和临时不可变定义。
  scope = await fixture.createScope()
})
afterAll(async () => {
  // 用例失败仍释放本套所有服务与进程。
  await fixture?.close()
})

function expectRejected(
  /* 真实HTTP返回，不能把无关4xx当成本例业务拒绝。 */ response: UsageTestResponse,
  /* 设计已经明确约定的领域错误身份。 */ code: string,
): void {
  // 明确业务拒绝须为4xx且没有成功数据，500不能证明预期验证。
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(response.status).toBeLessThan(500)
  expect(response.body).toMatchObject({ ok: false, error: { code, errorId: expect.any(String) } })
  expect(response.body).not.toHaveProperty('data')
}

async function usagePage(
  /* 被使用条目的真实身份。 */ entry: EvidenceLibraryEntry,
  /* 每次请求明确给出的可选筛选、大小和游标。 */ options: Record<string, unknown> = {},
  /* 默认owner，可使用真实viewer/nonmember身份。 */ token = fixture.ownerToken,
): Promise<Record<string, unknown>> {
  // 通过实际query接口读取摘要页，不在测试中计算使用关系。
  return usageResponseData(await fixture.query('evidence.uses', { workspaceId: entry.workspaceId, entryId: entry.id, ...options }, token))
}

async function publishConsumer(
  /* 当前用例来源材料。 */ entry: EvidenceLibraryEntry,
  /* 可使用既有目标，供规格复用场景比较同一输入。 */ target: GraphSnapshot | undefined = undefined,
): Promise<{ run: UsageTestRun; grant: GraphWorkGrant; proposal: Record<string, unknown>; nodeId: string; graph: GraphSnapshot }> {
  // 单阶段运行真实领取Work、读取获权材料、接受提案和正式发布。
  const actualTarget = target ?? await fixture.createTarget(scope)
  const run = await fixture.startRun(scope, actualTarget, [usageRef(entry)])
  expect(run.response).toMatchObject({ status: 200, body: { ok: true } })
  const grant = await fixture.claimWork(run)
  const proposal = await fixture.outputProposal(grant, scope, [usageRef(entry)])
  expect(await fixture.propose(grant, proposal)).toMatchObject({ status: 200, body: { ok: true } })
  const graph = await fixture.client.read('map.get', { mapId: run.mapId })
  const node = graph.nodes.find((/* 真实正式节点。 */ item) => /* 本单阶段只有一份核查输出。 */ item.typeId === scope.opinionType.id)
  if (!node) throw new Error(UsageTestMessage.NODE_MISSING)
  expect(graph.runs.find((/* 实际Run。 */ item) => /* 正式发布已完成。 */ item.id === run.runId)?.status).toBe('completed')
  return { run, grant, proposal, nodeId: node.id, graph }
}

async function withdraw(
  /* 真实已收录条目版本。 */ entry: EvidenceLibraryEntry,
): Promise<void> {
  // 显式停止新选择，保持已经冻结的内容。
  await fixture.client.dispatch(randomUUID(), 'evidence.withdraw', { workspaceId: entry.workspaceId, entryId: entry.id,
    expectedRevision: entry.revision, reason: '现在停止新的复用。' })
}

describe('evidence cross-Map frozen selection and usage HTTP contract', () => {
  // 新材料来自独立库选择，读范围、固定版本、正式使用和历史各有明确界限。
  it.each([0, 1] as const)('reads a selected other-Map judgment %s separately without adding its same-named node to branch scope', async (
    /* 本次固定数字判断，不能把0遗漏为空值。 */ confidence,
  ) => {
    // 来源和目标故意同nodeId，输入仍只来自目标Map。
    const nodeId = randomUUID()
    const { entry, source } = await fixture.createLibraryEntry(scope, confidence, '所选材料原陈述。', 1, nodeId)
    const unselected = (await fixture.createLibraryEntry(scope, 1, '未选材料不可出现在Work。')).entry
    const target = await fixture.createTarget(scope, nodeId)
    const run = await fixture.startRun(scope, target, [usageRef(entry)])
    expect(run.response.status).toBe(200)
    const grant = await fixture.claimWork(run)
    const data = await fixture.readWork(grant)
    const materials = usageRecords(data.libraryClaims)
    expect(materials).toHaveLength(1)
    expect(materials[0]).toMatchObject({ ref: { entryId: entry.id, contentDigest: entry.contentDigest },
      entry: { confidence, claim: { origin: { mapId: source.mapId, nodeId }, nodeSnapshot: { payload: { content: '所选材料原陈述。' } } } },
      definition: { id: 'factcheck.claim', version: 1 } })
    expect(JSON.stringify(data)).not.toContain(unselected.id)
    expect(JSON.stringify(data)).not.toContain('未选材料不可出现在Work。')
    const graph = await fixture.client.read('map.get', { mapId: target.mapId })
    const currentRun = graph.runs.find((/* 真实保存Run。 */ item) => /* 找回启动运行。 */ item.id === run.runId)
    expect(currentRun?.branchState?.scope).toMatchObject({ nodeIds: [nodeId], rootIds: [nodeId] })
    expect(usageRecord(data.inputs).target).toMatchObject([{ node: { id: nodeId, payload: { content: '待核查目标陈述。' } } }])
    expect(graph.nodes).toHaveLength(1)
  })

  it('retains legacy empty-selection protocol shape without exposing a libraryClaims field', async () => {
    // 没有显式选择时不向旧Agent合同注入空的同义材料集合。
    const target = await fixture.createTarget(scope)
    const run = await fixture.startRun(scope, target, [])
    expect(run.response.status).toBe(200)
    const data = await fixture.readWork(await fixture.claimWork(run))
    expect(data).not.toHaveProperty('libraryClaims')
    const graph = await fixture.client.read('map.get', { mapId: run.mapId })
    expect(usageRecord(graph.runs.find((/* 实际Run。 */ item) => /* 找回空选择运行。 */ item.id === run.runId)))
      .not.toHaveProperty('libraryClaimSets')
  })

  it('isolates the actual selected collection between two independent steps and rejects a cross-step citation', async () => {
    // 同Run的两份Work分别获权甲和乙，不能因另一材料也在Run中而跨步骤使用。
    const left = (await fixture.createLibraryEntry(scope, 0, '步骤甲专属的固定材料。')).entry
    const right = (await fixture.createLibraryEntry(scope, 1, '步骤乙专属的固定材料。')).entry
    const target = await fixture.createTarget(scope)
    const run = await fixture.startRun(scope, target, [], true, 2, [[usageRef(left)], [usageRef(right)]])
    expect(run.response.status).toBe(200)
    const leftWork = await fixture.claimWork(run, 'assess-0')
    const rightWork = await fixture.claimWork(run, 'assess-1')
    const leftData = await fixture.readWork(leftWork)
    const rightData = await fixture.readWork(rightWork)
    expect(usageRecords(leftData.libraryClaims)).toMatchObject([{ ref: { entryId: left.id, contentDigest: left.contentDigest } }])
    expect(usageRecords(rightData.libraryClaims)).toMatchObject([{ ref: { entryId: right.id, contentDigest: right.contentDigest } }])
    expect(JSON.stringify(leftData)).not.toContain(right.id)
    expect(JSON.stringify(leftData)).not.toContain('步骤乙专属的固定材料。')
    expect(JSON.stringify(rightData)).not.toContain(left.id)
    expect(JSON.stringify(rightData)).not.toContain('步骤甲专属的固定材料。')
    expectRejected(await fixture.propose(leftWork, await fixture.outputProposal(leftWork, scope, [usageRef(right)])), 'EVIDENCE_NOT_AUTHORIZED')
    expect((await fixture.propose(leftWork, await fixture.outputProposal(leftWork, scope, [usageRef(left)]))).status).toBe(200)
    expect((await fixture.propose(rightWork, await fixture.outputProposal(rightWork, scope, [usageRef(right)]))).status).toBe(200)
    const graph = await fixture.client.read('map.get', { mapId: target.mapId })
    expect(graph.runs.find((/* 同一实际Run。 */ item) => /* 两步骤正常发布后完成。 */ item.id === run.runId)?.status).toBe('completed')
    expect(usageRecords((await usagePage(left)).items)).toMatchObject([{ operationId: leftWork.operationId, workId: leftWork.workId }])
    expect(usageRecords((await usagePage(right)).items)).toMatchObject([{ operationId: rightWork.operationId, workId: rightWork.workId }])
  })

  it('publishes already-frozen selected content after withdrawal and source deletion', async () => {
    // 新选择状态变化不能撤销已经冻结的Work材料。
    const { entry, source } = await fixture.createLibraryEntry(scope, 0, '撤回前冻结的正文。')
    const target = await fixture.createTarget(scope)
    const run = await fixture.startRun(scope, target, [usageRef(entry)])
    expect(run.response.status).toBe(200)
    const grant = await fixture.claimWork(run)
    const before = await fixture.readWork(grant)
    await withdraw(entry)
    await fixture.client.dispatch(randomUUID(), 'map.delete', { mapId: source.mapId, expectedRevision: source.revision })
    expect((await fixture.readWork(grant)).libraryClaims).toEqual(before.libraryClaims)
    const proposal = await fixture.outputProposal(grant, scope, [usageRef(entry)])
    expect((await fixture.propose(grant, proposal)).status).toBe(200)
    expect(usageRecords((await usagePage(entry)).items)).toHaveLength(1)
  })

  it.each(['withdrawn', 'fake digest', 'foreign workspace'] as const)('rejects a new Run selection with %s and leaves no new Run or usage', async (
    /* 本次新选择故意触发的业务不变量。 */ invalidSelection,
  ) => {
    // 只改外部输入或管理状态，真实生产冻结路径须原子拒绝。
    const other = invalidSelection === 'foreign workspace' ? await fixture.createScope() : scope
    const { entry } = await fixture.createLibraryEntry(other, 0)
    if (invalidSelection === 'withdrawn') await withdraw(entry)
    const ref = usageRef(entry)
    if (invalidSelection === 'fake digest') ref.contentDigest = 'f'.repeat(64)
    const target = await fixture.createTarget(scope)
    const run = await fixture.startRun(scope, target, [ref])
    const code = invalidSelection === 'withdrawn' ? 'EVIDENCE_INACTIVE'
      : invalidSelection === 'fake digest' ? 'EVIDENCE_DIGEST_MISMATCH' : 'EVIDENCE_WORKSPACE_MISMATCH'
    expectRejected(run.response, code)
    const graph = await fixture.client.read('map.get', { mapId: target.mapId })
    expect(graph.runs).toEqual([])
    expect(graph.nodes).toEqual(target.nodes)
    expect(await fixture.connection.collection('evidence_uses').countDocuments({ workspaceId: scope.workspaceId })).toBe(0)
  })

  it.each(['unselected', 'fake digest', 'foreign workspace'] as const)('atomically rejects a Work output citing %s material', async (
    /* 产物试图超出获权集合的具体方式。 */ invalidOutput,
  ) => {
    // 产物验证必须绑定本Operation已获权集合，不能仅查询库条目存在。
    const selected = (await fixture.createLibraryEntry(scope, 0)).entry
    const otherScope = invalidOutput === 'foreign workspace' ? await fixture.createScope() : scope
    const other = (await fixture.createLibraryEntry(otherScope, 1, '没有获得本Work授权的材料。')).entry
    const target = await fixture.createTarget(scope)
    const run = await fixture.startRun(scope, target, [usageRef(selected)])
    expect(run.response.status).toBe(200)
    const grant = await fixture.claimWork(run)
    const ref = usageRef(invalidOutput === 'fake digest' ? selected : other)
    if (invalidOutput === 'fake digest') ref.contentDigest = 'e'.repeat(64)
    const before = await fixture.client.read('map.get', { mapId: target.mapId })
    expectRejected(await fixture.propose(grant, await fixture.outputProposal(grant, scope, [ref])),
      invalidOutput === 'fake digest' ? 'EVIDENCE_DIGEST_MISMATCH' : 'EVIDENCE_NOT_AUTHORIZED')
    const after = await fixture.client.read('map.get', { mapId: target.mapId })
    expect(after.nodes).toEqual(before.nodes)
    expect(after.runs).toEqual(before.runs)
    expect(await fixture.connection.collection('evidence_uses').countDocuments({ workspaceId: scope.workspaceId })).toBe(0)
  })

  it('preserves the accepted Run-start frozen collection on a legal replay after withdrawal', async () => {
    // 重放同一个请求，即使原lease已被Run接管也不得再冻结或按active重新拒绝。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    const target = await fixture.createTarget(scope)
    const run = await fixture.startRun(scope, target, [usageRef(entry)])
    expect(run.response.status).toBe(200)
    const before = await fixture.client.read('map.get', { mapId: run.mapId })
    const frozen = usageRecord(before.runs[0]).libraryClaimSets
    await withdraw(entry)
    const replay = await fixture.post('/api/v1/command', run.request)
    expect(replay).toMatchObject({ status: 200, body: { replayed: true } })
    const after = await fixture.client.read('map.get', { mapId: run.mapId })
    expect(after.runs).toHaveLength(1)
    expect(usageRecord(after.runs[0]).libraryClaimSets).toEqual(frozen)
  })

  it('records one formal consumer usage across a legal accepted Work-proposal replay', async () => {
    // 正式发布和使用登记原子发生；收据重放不再新增消费者节点或使用。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    const published = await publishConsumer(entry)
    const before = await usagePage(entry)
    const rows = usageRecords(before.items)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ workspaceId: scope.workspaceId, ref: { entryId: entry.id, contentDigest: entry.contentDigest },
      consumer: { mapId: published.run.mapId, nodeId: published.nodeId, revision: 0 }, reason: usageRef(entry).reason,
      kind: 'work', runId: published.run.runId, operationId: published.grant.operationId, workId: published.grant.workId,
      reusedFromOperationId: null, endedAt: null })
    expect(rows[0]).not.toHaveProperty('consumerSnapshot')
    await withdraw(entry)
    expect((await fixture.propose(published.grant, published.proposal)).status).toBe(200)
    expect(await usagePage(entry)).toEqual(before)
  })

  it('binds specHash to the chosen collection and avoids reusing old outputs for another entry', async () => {
    // 相同目标版本换选择集合，即使正文相同也不复用旧已接受产物。
    const first = (await fixture.createLibraryEntry(scope, 0, '第一份固定材料。')).entry
    const second = (await fixture.createLibraryEntry(scope, 1, '第二份固定材料。')).entry
    const published = await publishConsumer(first)
    const next = await fixture.startRun(scope, published.graph, [usageRef(second)], false)
    expect(next.response.status).toBe(200)
    const graph = await fixture.client.read('map.get', { mapId: next.mapId })
    const operation = graph.runs.find((/* 保存Run。 */ item) => /* 找回更换集合的新Run。 */ item.id === next.runId)?.operations[0]
    if (!operation) throw new Error(UsageTestMessage.OPERATION_MISSING)
    expect(operation.specHash).not.toBe(published.grant.specHash)
    expect(operation).not.toHaveProperty('reusedFromOperationId')
    expect(operation.status).toBe('running')
  })

  it('canonicalizes reordered selections for reuse and records the new Run and Operation usage context', async () => {
    // UI顺序不影响冻结身份，但新运行复用仍须登记本轮上下文。
    const left = (await fixture.createLibraryEntry(scope, 0, '材料甲。')).entry
    const right = (await fixture.createLibraryEntry(scope, 1, '材料乙。')).entry
    const target = await fixture.createTarget(scope)
    const first = await fixture.startRun(scope, target, [usageRef(left), usageRef(right)])
    expect(first.response.status).toBe(200)
    const grant = await fixture.claimWork(first)
    expect((await fixture.propose(grant, await fixture.outputProposal(grant, scope, [usageRef(left), usageRef(right)]))).status).toBe(200)
    const completed = await fixture.client.read('map.get', { mapId: first.mapId })
    const next = await fixture.startRun(scope, completed, [usageRef(right), usageRef(left)], false)
    expect(next.response.status).toBe(200)
    const graph = await fixture.client.read('map.get', { mapId: next.mapId })
    const operation = graph.runs.find((/* 保存Run。 */ item) => /* 找回复用的新Run。 */ item.id === next.runId)?.operations[0]
    expect(operation).toMatchObject({ specHash: grant.specHash, reusedFromOperationId: grant.operationId, status: 'completed' })
    expect(usageRecords((await usagePage(left)).items)).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: next.runId, operationId: operation?.id, reusedFromOperationId: grant.operationId, endedAt: null }),
    ]))
  })

  it('ends the old consumer version on editing and keeps the original snapshot in history', async () => {
    // 新版本保留原引用仍有自己的使用身份；旧consumerSnapshot永久保存原理由正文。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    const published = await publishConsumer(entry)
    const old = usageRecords((await usagePage(entry)).items)[0]
    if (!old) throw new Error(UsageTestMessage.NODE_MISSING)
    const original = published.graph.nodes.find((/* 实际消费者。 */ node) => /* 找回正式核查节点。 */ node.id === published.nodeId)
    if (!original) throw new Error(UsageTestMessage.NODE_MISSING)
    const root = published.graph.nodes.find((/* 实际结构根。 */ node) => /* 使用目标真实根取得写范围。 */ node.typeId === scope.targetType.id)
    if (!root) throw new Error(UsageTestMessage.NODE_MISSING)
    expect((await fixture.editMetadata(published.run.mapId, [root.id], [{ id: original.id, typeId: original.typeId,
      typeVersion: original.typeVersion, payload: { ...original.payload, reason: '编辑后的新核查正文。' } }])).status).toBe(200)
    const active = usageRecords((await usagePage(entry)).items)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ consumer: { nodeId: original.id, revision: original.revision + 1 }, endedAt: null })
    const history = usageRecords((await usagePage(entry, { includeHistory: true })).items)
    expect(history).toHaveLength(2)
    const detail = usageResponseData(await fixture.query('evidence.use.get', { workspaceId: scope.workspaceId,
      entryId: entry.id, usageId: old.id }))
    expect(detail.consumerSnapshot).toEqual(original)
    expect(detail.endedAt).toEqual(expect.any(String))
  })

  it.each(['consumer node', 'consumer Map'] as const)('ends current usage after deleting the %s while historical details remain readable', async (
    /* 本例明确删除的当前消费者范围。 */ deletion,
  ) => {
    // 移除当前图引用不删除证据使用历史。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    const published = await publishConsumer(entry)
    const old = usageRecords((await usagePage(entry)).items)[0]
    if (!old) throw new Error(UsageTestMessage.NODE_MISSING)
    if (deletion === 'consumer Map') {
      await fixture.client.dispatch(randomUUID(), 'map.delete', { mapId: published.run.mapId, expectedRevision: published.graph.revision })
    } else {
      const root = published.graph.nodes.find((/* 真实结构根。 */ node) => /* 找回删除分支。 */ node.typeId === scope.targetType.id)
      if (!root) throw new Error(UsageTestMessage.NODE_MISSING)
      expect((await fixture.editMetadata(published.run.mapId, [root.id], [], [published.nodeId])).status).toBe(200)
    }
    expect(usageRecords((await usagePage(entry)).items)).toEqual([])
    const history = usageRecords((await usagePage(entry, { includeHistory: true })).items)
    expect(history).toHaveLength(1)
    expect(history[0]?.endedAt).toEqual(expect.any(String))
    const detail = usageResponseData(await fixture.query('evidence.use.get', { workspaceId: scope.workspaceId, entryId: entry.id, usageId: old.id }))
    expect(usageRecord(detail.consumerSnapshot).id).toBe(published.nodeId)
  })

  it.each([
    { name: 'extra node metadata', path: 'nodes.0.manualOrigin', value: {
      userId: '11111111-1111-4111-8111-111111111111', unexpectedMetadata: 'not in the snapshot contract',
    }, code: 'EVIDENCE_RECORD_INVALID' },
    { name: 'an invalid source UUID', path: 'nodes.0.importedFrom', value: {
      bundleId: '11111111-1111-4111-8111-111111111111', nodeId: 'invalid-source-id', revision: 0,
    }, code: 'EVIDENCE_RECORD_INVALID' },
    { name: 'an invalid source timestamp', path: 'nodes.0.createdAt', value: 'invalid-timestamp', code: 'INTERNAL_ERROR' },
  ])('rejects $name before registering a new consumer snapshot', async (
    /* 只修改真实存储 seam 的一项来源元数据，不替业务模块判断结果。 */ corruption,
  ) => {
    // 坏节点元数据必须在首次使用写入时失败，不能登记后等读历史详情才发现。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    const target = await fixture.createTarget(scope)
    const node = target.nodes[0]
    if (!node) throw new Error(UsageTestMessage.NODE_MISSING)
    const database = fixture.connection.db
    if (!database) throw new Error(UsageTestMessage.DATABASE_MISSING)
    const graphs = database.collection<{ _id: string; revision: number }>('graphv3')
    const claimed = (await fixture.client.dispatch(randomUUID(), 'branch.claim', {
      mapId: target.mapId, rootIds: [node.id], holderId: randomUUID(),
    })).data
    if (claimed.status !== 'claimed') throw new Error(UsageTestMessage.LEASE_MISSING)
    const grant = claimed.grant, lease = { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
    try {
      await graphs.updateOne({ _id: target.mapId }, { $set: { [corruption.path]: corruption.value } })
      const result = await fixture.post('/api/v1/command', { requestId: randomUUID(), method: 'graph.apply', params: {
        mapId: target.mapId, lease,
        branch: { rootIds: grant.branch.scope.rootIds, expectedVersion: grant.branch.version },
        changes: { nodes: { put: [{ id: node.id, typeId: node.typeId, typeVersion: node.typeVersion,
          payload: node.payload, libraryClaimRefs: [usageRef(entry)] }] } },
      } })
      expect(result.status).toBe(500)
      expect(result.body).toMatchObject({ ok: false, error: { code: corruption.code, errorId: expect.any(String) } })
      expect(await database.collection('evidence_uses').countDocuments({ workspaceId: scope.workspaceId })).toBe(0)
      expect((await graphs.findOne({ _id: target.mapId }))?.revision).toBe(target.revision)
    } finally {
      // 恢复本例故意损坏的来源，仍经真实接口结束自有分支授权。
      await graphs.updateOne({ _id: target.mapId }, { $set: { 'nodes.0': node } })
      await fixture.client.dispatch(randomUUID(), 'branch.release', { mapId: target.mapId, lease })
    }
  })

  it('versions manual reason edits, preserves continued withdrawn references, and ends explicit removal', async () => {
    // 只改使用理由也登记新消费者版本；省略保留、撤回后续用和显式清除各有独立历史。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    const target = await fixture.createTarget(scope)
    const node = target.nodes[0]
    if (!node) throw new Error(UsageTestMessage.NODE_MISSING)
    const base: GraphNodeInput = { id: node.id, typeId: node.typeId, typeVersion: node.typeVersion, payload: node.payload }
    const originalRef = usageRef(entry), changedRef = { ...originalRef, reason: '修订本次引用理由，不改变固定材料。' }
    expect((await fixture.editMetadata(target.mapId, [node.id], [{ ...base, libraryClaimRefs: [originalRef] }])).status).toBe(200)
    const originalUse = usageRecords((await usagePage(entry)).items)[0]
    if (!originalUse) throw new Error(UsageTestMessage.NODE_MISSING)
    expect(originalUse).toMatchObject({ kind: 'manual', runId: null, operationId: null, workId: null,
      reason: originalRef.reason, consumer: { nodeId: node.id, revision: node.revision + 1 } })

    expect((await fixture.editMetadata(target.mapId, [node.id], [{ ...base, libraryClaimRefs: [changedRef] }])).status).toBe(200)
    const changedNode = (await fixture.client.read('map.get', { mapId: target.mapId })).nodes.find(
      (/* 仅修订使用理由后的真实消费者。 */ candidate) => /* 仍是最初的同一节点。 */ candidate.id === node.id,
    )
    expect(changedNode).toMatchObject({ revision: node.revision + 2, payload: node.payload, libraryClaimRefs: [changedRef] })
    const changedUse = usageRecords((await usagePage(entry)).items)[0]
    expect(changedUse).toMatchObject({ reason: changedRef.reason, consumer: { revision: node.revision + 2 }, endedAt: null })
    expect(changedUse?.id).not.toBe(originalUse.id)
    const originalDetail = usageResponseData(await fixture.query('evidence.use.get', {
      workspaceId: scope.workspaceId, entryId: entry.id, usageId: originalUse.id,
    }))
    expect(originalDetail).toMatchObject({ reason: originalRef.reason, endedAt: expect.any(String),
      consumerSnapshot: { revision: node.revision + 1, payload: node.payload, libraryClaimRefs: [originalRef] } })

    await withdraw(entry)
    expect((await fixture.editMetadata(target.mapId, [node.id], [{ ...base, payload: { content: '保留原引用的编辑正文。' } }])).status).toBe(200)
    const continuedRef = { ...changedRef, reason: '条目撤回后补充原有引用的使用说明。' }
    expect((await fixture.editMetadata(target.mapId, [node.id], [{ ...base,
      payload: { content: '保留原引用的编辑正文。' }, libraryClaimRefs: [continuedRef] }])).status).toBe(200)
    expect(usageRecords((await usagePage(entry)).items)).toMatchObject([{ reason: continuedRef.reason,
      consumer: { nodeId: node.id, revision: node.revision + 4 }, endedAt: null }])
    expect((await fixture.client.read('map.get', { mapId: target.mapId })).nodes.find(
      (/* 撤回后继续引用的正式节点。 */ candidate) => /* 同一消费者身份不改。 */ candidate.id === node.id,
    )).toMatchObject({ payload: { content: '保留原引用的编辑正文。' }, libraryClaimRefs: [continuedRef] })
    const newTarget = await fixture.createTarget(scope)
    const newNode = newTarget.nodes[0]
    if (!newNode) throw new Error(UsageTestMessage.NODE_MISSING)
    expectRejected(await fixture.editMetadata(newTarget.mapId, [newNode.id], [{ id: newNode.id, typeId: newNode.typeId,
      typeVersion: newNode.typeVersion, payload: newNode.payload, libraryClaimRefs: [usageRef(entry)] }]), 'EVIDENCE_INACTIVE')
    expect((await fixture.editMetadata(target.mapId, [node.id], [{ ...base, libraryClaimRefs: [] }])).status).toBe(200)
    expect(usageRecords((await usagePage(entry)).items)).toEqual([])
    const history = usageRecords((await usagePage(entry, { includeHistory: true })).items)
    expect(history).toHaveLength(4)
    expect(history.every((/* 这次消费者的各个正式历史版本。 */ use) => /* 移除后所有旧使用都已结束。 */ typeof use.endedAt === 'string')).toBe(true)
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: originalRef.reason, consumer: { mapId: target.mapId, nodeId: node.id, revision: node.revision + 1 } }),
      expect.objectContaining({ reason: changedRef.reason, consumer: { mapId: target.mapId, nodeId: node.id, revision: node.revision + 2 } }),
      expect.objectContaining({ reason: changedRef.reason, consumer: { mapId: target.mapId, nodeId: node.id, revision: node.revision + 3 } }),
      expect.objectContaining({ reason: continuedRef.reason, consumer: { mapId: target.mapId, nodeId: node.id, revision: node.revision + 4 } }),
    ]))
  })

  it.each(['fake digest', 'foreign workspace'] as const)('rejects a new manual reference with %s without changing graph content or usage', async (
    /* 人工节点引用这次违反的真实库身份条件。 */ invalidReference,
  ) => {
    // 复用同一真实人工图写入口，库验证拒绝必须回滚消费者内容及使用目录。
    const sourceScope = invalidReference === 'foreign workspace' ? await fixture.createScope() : scope
    const { entry } = await fixture.createLibraryEntry(sourceScope, 0)
    const target = await fixture.createTarget(scope), node = target.nodes[0]
    if (!node) throw new Error(UsageTestMessage.NODE_MISSING)
    const before = await fixture.client.read('map.get', { mapId: target.mapId }), beforeUses = await usagePage(entry, { includeHistory: true })
    const ref = usageRef(entry)
    if (invalidReference === 'fake digest') ref.contentDigest = 'f'.repeat(64)
    expectRejected(await fixture.editMetadata(target.mapId, [node.id], [{ id: node.id, typeId: node.typeId,
      typeVersion: node.typeVersion, payload: { ...node.payload, content: '失败时不应保存的正文。' }, libraryClaimRefs: [ref] }]),
    invalidReference === 'fake digest' ? 'EVIDENCE_DIGEST_MISMATCH' : 'EVIDENCE_WORKSPACE_MISMATCH')
    // 领取和释放的占用版本可以前进，内容revision和真实节点/关系不能留下半次提交。
    expect(await fixture.client.read('map.get', { mapId: target.mapId })).toMatchObject({ revision: before.revision,
      nodes: before.nodes, edges: before.edges, runs: before.runs })
    expect(await usagePage(entry, { includeHistory: true })).toEqual(beforeUses)
    expect(await fixture.connection.collection('evidence_uses').countDocuments({ workspaceId: scope.workspaceId })).toBe(0)
  })

  it('allows viewer summaries/details and hides both queries from a nonmember', async () => {
    // 使用追溯和消费者正文遵守同一个真实workspace读授权。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    await publishConsumer(entry)
    const page = await usagePage(entry, {}, fixture.viewerToken)
    const row = usageRecords(page.items)[0]
    if (!row) throw new Error(UsageTestMessage.NODE_MISSING)
    const params = { workspaceId: scope.workspaceId, entryId: entry.id, usageId: row.id }
    expect((await fixture.query('evidence.use.get', params, fixture.viewerToken)).status).toBe(200)
    for (const method of ['evidence.uses', 'evidence.use.get']) {
      const response = await fixture.query(method, method === 'evidence.uses' ? { workspaceId: scope.workspaceId, entryId: entry.id } : params, fixture.outsiderToken)
      expect(response).toMatchObject({ status: 404, body: { error: { code: 'WORKSPACE_NOT_FOUND' } } })
      expect(response.body).not.toHaveProperty('data')
      expect(JSON.stringify(response.body)).not.toContain('保留意见原始0.5。')
    }
  })

  it('uses bounded default and cursor pages without duplicate consumers and binds the cursor to usage changes', async () => {
    // 真正保存28个使用，不伪造分页响应；旧游标不能跨新版本继续读。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    const nodes: Array<GraphNodeInput & { libraryClaimRefs: unknown }> = []
    for (let index = 0; index < 28; index++) nodes.push({ id: randomUUID(), typeId: scope.targetType.id, typeVersion: scope.targetType.version,
      payload: { content: `人工核查消费者 ${index}` }, libraryClaimRefs: [usageRef(entry)] })
    const graph = await fixture.createGraph(scope.workspaceId, nodes)
    const first = await usagePage(entry)
    expect(first).toMatchObject({ workspaceId: scope.workspaceId, entryId: entry.id, usageRevision: expect.any(Number) })
    expect(usageRecords(first.items)).toHaveLength(25)
    expect(usageRecords(first.items).every((/* 轻量摘要页中的实际行。 */ row) => /* summary不携带大消费者正文。 */ !('consumerSnapshot' in row))).toBe(true)
    const cursor = usageString(first.nextCursor)
    const second = await usagePage(entry, { cursor })
    expect(usageRecords(second.items)).toHaveLength(3)
    expect(second.nextCursor).toBeNull()
    const rows = [...usageRecords(first.items), ...usageRecords(second.items)]
    expect(new Set(rows.map((/* 实际分页行。 */ row) => /* 比较真实使用身份。 */ row.id)).size).toBe(28)
    const other = (await fixture.createLibraryEntry(scope, 1)).entry
    expectRejected(await fixture.query('evidence.uses', { workspaceId: scope.workspaceId, entryId: other.id, cursor }), 'EVIDENCE_CURSOR_INVALID')
    const changed = nodes[0]
    if (!changed) throw new Error(UsageTestMessage.NODE_MISSING)
    expect((await fixture.editMetadata(graph.mapId, [changed.id], [{ ...changed, libraryClaimRefs: [] }])).status).toBe(200)
    expectRejected(await fixture.query('evidence.uses', { workspaceId: scope.workspaceId, entryId: entry.id, cursor }), 'EVIDENCE_CURSOR_EXPIRED')
  })

  it.each([0, 101, 1.5])('rejects an invalid usage page limit %s rather than scanning or treating zero as default', async (
    /* 故意非法的外部分页大小。 */ limit,
  ) => {
    // 空库也须校验输入，不把无命中当成合法大小。
    const { entry } = await fixture.createLibraryEntry(scope, 0)
    expectRejected(await fixture.query('evidence.uses', { workspaceId: scope.workspaceId, entryId: entry.id, limit }), 'EVIDENCE_QUERY_LIMIT_INVALID')
  })

  it('rejects more than 32 explicitly selected entries in one step without saving a Run', async () => {
    // 选择集合真实有33个不同库条目，而非重复身份触发其他验证。
    const refs = []
    for (let index = 0; index < 33; index++) refs.push(usageRef((await fixture.createLibraryEntry(scope, 0, `数量边界材料 ${index}`)).entry))
    const target = await fixture.createTarget(scope)
    expectRejected((await fixture.startRun(scope, target, refs)).response, 'EVIDENCE_SELECTION_LIMIT')
    expect((await fixture.client.read('map.get', { mapId: target.mapId })).runs).toEqual([])
  })

  it.each(['one step', 'whole Run'] as const)('rejects an oversized frozen collection for %s and rolls back the Run', async (
    /* 本例超过的冻结材料预算。 */ budget,
  ) => {
    // 每条材料合法且图命令都小于HTTP限制；限制须发生在组合冻结边界。
    const refs = []
    const count = budget === 'one step' ? 22 : 14
    const size = 50_000
    for (let index = 0; index < count; index++) refs.push(usageRef((await fixture.createLibraryEntry(scope, 0, `${index} ${'x'.repeat(size)}`)).entry))
    const target = await fixture.createTarget(scope)
    const result = await fixture.startRun(scope, target, refs, true, budget === 'one step' ? 1 : 6)
    expectRejected(result.response, 'EVIDENCE_INPUT_LIMIT')
    expect(result.response.status).toBe(413)
    expect((await fixture.client.read('map.get', { mapId: target.mapId })).runs).toEqual([])
    expect(await fixture.connection.collection('evidence_uses').countDocuments({ workspaceId: scope.workspaceId })).toBe(0)
  })

  it('projects selected library node payload through its frozen definition while retaining the full source in Run storage', async () => {
    // 临时Claim v2只向模型开放content；完整冻结条目仍保留category供历史解释。
    const { entry } = await fixture.createLibraryEntry(scope, 0, '投影后的原陈述。', 2)
    const target = await fixture.createTarget(scope)
    const run = await fixture.startRun(scope, target, [usageRef(entry)])
    expect(run.response.status).toBe(200)
    const data = await fixture.readWork(await fixture.claimWork(run))
    const projected = usageRecords(data.libraryClaims)[0]
    if (!projected) throw new Error(UsageTestMessage.NODE_MISSING)
    expect(usageRecord(usageRecord(usageRecord(projected.entry).claim).nodeSnapshot).payload).toEqual({ content: '投影后的原陈述。' })
    expect(projected).toMatchObject({ definition: { id: 'factcheck.claim', version: 2,
      agentProjection: { include: ['/content'] } } })
    const graph = await fixture.client.read('map.get', { mapId: run.mapId })
    const frozenSet = usageRecords(usageRecord(graph.runs[0]).libraryClaimSets)[0]
    if (!frozenSet) throw new Error(UsageTestMessage.NODE_MISSING)
    expect(usageRecords(frozenSet.claims)[0]).toMatchObject({ entry: { claim: { nodeSnapshot: { payload: { content: '投影后的原陈述。', category: 'quote' } } } } })
  })
})
