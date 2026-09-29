import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { DEFAULT_DEFINITION_PACKAGE, DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'
import type { ExecutionAgentDefinition } from '../../../../contracts/data-definition'
import type { GraphNode, GraphWorkGrant, GraphWorkProof } from '../../../../contracts/graph'
import type { GraphDocument, GraphReceipt } from '../../../../backend/modules/graph/graph-record'
import { graphCreateService } from '../../../../backend/modules/graph/graph-service'
import { runCreateRun } from '../../../../backend/modules/graph/run-state'
import { branchReadSnapshot } from '../../../../backend/modules/graph/branch-state'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import { definitionsValidateCatalog } from '../../../../backend/modules/shared/data-definition'
import type { GraphStore } from '../../../../backend/ports/graph-store'

function sourceAgents(): ExecutionAgentDefinition[] {
  const configuration = DEFAULT_RUN_CONFIGURATION
  const profiles = [configuration.parse, configuration.split.router, ...configuration.split.agents, configuration.split.merger,
    configuration.router, ...configuration.agents, configuration.merger]
  return profiles.map(profile => ({ ref: { id: profile.id, version: 0 }, profile }))
}

function sourceStore(initial: GraphDocument): { store: GraphStore; current(): GraphDocument } {
  let document = structuredClone(initial)
  const read = () => structuredClone(document)
  const proofMatches = (proof: GraphWorkProof) => {
    const grant = document.leases[proof.workId]
    return !!grant && grant.holderId === proof.holderId && grant.fence === proof.fence
  }
  const store: GraphStore = {
    async initialize() {},
    async create() { return false },
    async read(mapId) { return mapId === document.id ? read() : null },
    async *discover() {},
    async readLeaseDelay() { return 0 },
    async *readDispatch() {},
    async clearDispatch() { return false },
    async claim() { return null },
    async readLease(mapId, proof) { return mapId === document.id && proofMatches(proof) ? read() : null },
    async renew() { return null },
    async release() { return false },
    async list() { return [] },
    async commit(updated, expectedRevision, receipt: GraphReceipt, grant?: GraphWorkGrant) {
      // 复刻真实适配器的单文档 CAS：只有一个并发读取者能以旧 revision 提交。
      if (document.revision !== expectedRevision || grant && !proofMatches(grant)) return false
      document = { ...structuredClone(updated), revision: expectedRevision + 1, leases: structuredClone(document.leases),
        receipts: [...document.receipts, structuredClone(receipt)] }
      return true
    },
  }
  return { store, current: read }
}

describe('source-text input freezing', () => {
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
