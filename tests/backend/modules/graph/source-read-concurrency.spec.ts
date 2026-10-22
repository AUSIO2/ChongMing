import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { DEFAULT_DEFINITION_PACKAGE, DEFAULT_WORKSPACE_SEED } from '../../../../apps/config/default-prompts'
import type { ExecutionAgentDefinition } from '../../../../contracts/data-definition'
import type { GraphNode } from '../../../../contracts/graph'
import type { GraphWorkGrant, GraphWorkProof } from '../../../../contracts/graph-work'
import type { GraphDocument, GraphReceipt } from '../../../../backend/modules/graph/graph-record'
import { graphCreateService } from '../../../../backend/modules/graph/graph-service'
import { runCreateRun } from '../../../../backend/modules/graph/run-state'
import { branchReadSnapshot } from '../../../../backend/modules/graph/branch-state'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import { definitionsValidateCatalog } from '../../../../backend/modules/shared/data-definition'
import type { GraphStore } from '../../../../backend/ports/graph-store'

function sourceAgents(): ExecutionAgentDefinition[] {
  const configuration = DEFAULT_WORKSPACE_SEED
  const profiles = [configuration.parse, configuration.split.router, ...configuration.split.agents, configuration.split.merger,
    configuration.router, ...configuration.agents, configuration.merger]
  return profiles.map(profile => ({ ref: { id: profile.id, version: 0 }, profile }))
}

function sourceStore(
  /* 测试已建立Run、占有和Work租约的独立图快照。 */ initial: GraphDocument,
): { store: GraphStore; current(): GraphDocument } {
  // 本夹具只模拟来源读取所需的租约和内容CAS，持有独立可观察图状态。
  let document = structuredClone(initial)
  const read = (): GraphDocument => /* 每次读取交付独立快照，防止领域草稿提前改变已提交状态。 */ structuredClone(document)
  const proofMatches = (/* 真实读取或提交携带的holder与fence证明。 */ proof: GraphWorkProof): boolean => {
    // 以夹具当前租约检查读取和CAS是否仍属于同一Work授权。
    const grant = document.leases[proof.workId]
    return !!grant && grant.holderId === proof.holderId && grant.fence === proof.fence
  }
  const store: GraphStore = {
    async initialize() { /* 此内存夹具不建立外部资源。 */ },
    async create() { /* 来源读取场景不创建图。 */ return false },
    async read(/* 当前领域读取指定的图身份。 */ mapId) {
      // 只交付本测试拥有的图。
      return mapId === document.id ? read() : null
    },
    async *discover() { /* 来源读取测试不派发新工作。 */ },
    async readLeaseDelay() { /* 夹具租约预先固定，不等待数据库时间。 */ return 0 },
    async *readDispatch() { /* 夹具不运行后台消息派发。 */ },
    async clearDispatch() { /* 本测试没有待清理的派发表。 */ return false },
    async claim() { /* Work租约已由测试明确建立，不额外领取。 */ return null },
    async readLease(/* 请求目标图身份。 */ mapId, /* 当前Work租约证明。 */ proof) {
      // 只允许仍匹配当前授权的本图读取。
      return mapId === document.id && proofMatches(proof) ? read() : null
    },
    async renew() { /* 此夹具不模拟时间推进或租约续期。 */ return null },
    async release() { /* 此场景不改变预先建立的Work租约。 */ return false },
    async list() { /* 来源读取场景不列举工作区图。 */ return [] },
    async commitOwnership() {
      // 此来源读取夹具仅支持内容CAS，意外进入占有写入必须使测试失败。
      throw new Error('Source-read fixture does not commit ownership')
    },
    async commit(
      /* 领域来源冻结准备提交的完整图草稿。 */ updated,
      /* 本次草稿基于的已提交内容版本。 */ expectedRevision,
      /* 与来源冻结原子保存的唯一收据。 */ receipt: GraphReceipt,
      /* 提交时仍必须匹配的Work租约；无凭证路径不在本测试使用。 */ grant?: GraphWorkGrant,
    ) {
      // 复刻真实适配器的单文档CAS：只有一个并发读取者能以旧revision提交。
      if (document.revision !== expectedRevision || grant && !proofMatches(grant)) return false
      document = { ...structuredClone(updated), revision: expectedRevision + 1, leases: structuredClone(document.leases),
        receipts: [...document.receipts, structuredClone(receipt)] }
      return true
    },
  }
  return { store, current: read }
}

describe('source-text input freezing', () => {
  it('rejects another operation before fetching or freezing its source', async () => {
    // 有效Work租约只授权自己的Operation，错误身份不能触发外部读取或来源收据。
    const now = '2026-09-28T00:00:00.000Z'
    const nodes: GraphNode[] = ['First', 'Second'].map((/* 两个独立Operation的来源名称。 */ label) =>
      /* 为each分组准备两个同类型但身份不同的输入。 */ ({ id: randomUUID(), revision: 0, typeId: 'factcheck.source', typeVersion: 1,
        payload: { locator: { kind: 'url', url: 'https://example.com/live' }, label }, createdAt: now, updatedAt: now }))
    const document: GraphDocument = { id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'Operation source authorization',
      nodes, edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    const agents = sourceAgents(), definitions = definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE], agents)
    const branch = branchReadSnapshot(document, nodes.map((/* 分支内的两项独立来源。 */ node) => /* 以身份覆盖完整运行分支。 */ node.id))
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
      scope: { nodeIds: nodes.map((/* 已包含在分支中的来源。 */ node) => /* Run范围使用这两项来源。 */ node.id) }, mode: 'auto', plan: { steps: [{
        id: 'parse', transitionRef: { id: 'factcheck.parse-source', version: 1 }, dependsOn: [],
        input: [{ port: 'source', source: { kind: 'scope', nodeIds: nodes.map((/* 当前Run的来源。 */ node) => /* each分组的输入身份。 */ node.id) } }],
        context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
      }] } }, { definitions, agents, tools: [], maxSlots: 4 }, now)
    const run = document.runs[0]
    document.ownershipRevision = 1
    document.branchOwnerships = { [run.id]: { leaseId: run.id, kind: 'run', rootIds: branch.scope.rootIds,
      ownerUserId: randomUUID(), holderId: randomUUID(), fence: 1, expiresAt: null, leaseMs: null, runId: run.id } }
    document.ownershipReceipts = []
    const works = workReadItems(document), work = works[0]
    const grant: GraphWorkGrant = { ...work, hostId: 'host', holderId: randomUUID(), fence: 1,
      leaseMs: 60_000, expiresAt: '2999-01-01T00:00:00.000Z' }
    document.leases[work.workId] = grant
    const memory = sourceStore(document)
    let reads = 0
    const service = graphCreateService(memory.store, { readSource: async () => {
      // 记录真实外部读取是否已经发生。
      reads++
      return 'source text'
    } })
    const proof = { workId: grant.workId, holderId: grant.holderId, fence: grant.fence }
    await expect(service.readData(document.id, works[1].operationId, proof)).rejects.toMatchObject({ code: 'WORK_STOPPED' })
    expect(reads).toBe(0)
    expect(memory.current()).toEqual(document)
    await expect(service.readData(document.id, work.operationId, proof)).resolves.toMatchObject({ operationId: work.operationId })
    expect(reads).toBe(1)
  })

  it('returns the CAS winner to both concurrent readers when the source changes between fetches', async () => {
    const now = '2026-09-28T00:00:00.000Z', sourceId = randomUUID()
    const source: GraphNode = { id: sourceId, revision: 0, typeId: 'factcheck.source', typeVersion: 1,
      payload: { locator: { kind: 'url', url: 'https://example.com/live' }, label: 'Live source' }, createdAt: now, updatedAt: now }
    const document: GraphDocument = { id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'Concurrent source',
      nodes: [source], edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    const agents = sourceAgents(), definitions = definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE], agents)
    const runBranch = branchReadSnapshot(document, [sourceId])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version }, scope: { nodeIds: [sourceId] }, mode: 'auto', plan: { steps: [{
      id: 'parse', transitionRef: { id: 'factcheck.parse-source', version: 1 }, dependsOn: [],
      input: [{ port: 'source', source: { kind: 'scope', nodeIds: [sourceId] } }], context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions, agents, tools: [], maxSlots: 4 }, now)
    document.ownershipRevision = 1
    const run = document.runs[0]
    document.branchOwnerships = { [run.id]: { leaseId: run.id, kind: 'run', rootIds: runBranch.scope.rootIds,
      ownerUserId: randomUUID(), holderId: randomUUID(), fence: 1, expiresAt: null, leaseMs: null, runId: run.id } }
    document.ownershipReceipts = []
    const work = workReadItems(document)[0]
    const grant: GraphWorkGrant = { ...work, hostId: 'host', holderId: randomUUID(), fence: 1,
      leaseMs: 60_000, expiresAt: '2999-01-01T00:00:00.000Z' }
    document.leases[work.workId] = grant
    const memory = sourceStore(document)
    let reads = 0, release!: () => void
    const bothFetched = new Promise<void>(resolve => { release = resolve })
    const service = graphCreateService(memory.store, { readSource: async () => {
      const content = ++reads === 1 ? 'first response' : 'second response'
      if (reads === 2) release()
      await bothFetched
      return content
    } })
    const proof = { workId: grant.workId, holderId: grant.holderId, fence: grant.fence }

    const results = await Promise.all([
      service.readData(document.id, work.operationId, proof),
      service.readData(document.id, work.operationId, proof),
    ])

    expect(reads).toBe(2)
    expect(new Set(results.map(result => result.promptVariables.rawContent)).size).toBe(1)
    expect(['first response', 'second response']).toContain(results[0].promptVariables.rawContent)
    expect(memory.current().receipts.filter(receipt => receipt.method === 'source.read')).toHaveLength(1)
  })
})
