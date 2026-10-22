// 通过真实认证 API 与 Mongo 事务验证分支版本取代整图 revision 后的并发语义。
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createGraphApi, FACT_TYPES, verificationPlan, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi() }, 30_000)
afterAll(async () => { await api?.close() })

async function createMapWithClaims() {
  const workspace = await api.createWorkspace()
  const mapId = randomUUID(), leftId = randomUUID(), rightId = randomUUID()
  expect((await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision,
    id: mapId, name: 'Branch revision' })).status).toBe(201)
  expect((await api.apply(mapId, [leftId, rightId], { nodes: { put: [
    { id: leftId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Left', category: 'data' } },
    { id: rightId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Right', category: 'quote' } },
  ] } }, true)).status).toBe(200)
  return { mapId, leftId, rightId }
}

describe('branch-scoped graph revision', () => {
  it('accepts concurrent writes to disjoint branches and conflicts only after the target branch changes', async () => {
    const { mapId, leftId, rightId } = await createMapWithClaims()
    const left = await api.branch(mapId, [leftId]), right = await api.branch(mapId, [rightId])
    const [leftWrite, rightWrite] = await Promise.all([
      api.command('graph.apply', { mapId, branch: { rootIds: [leftId], expectedVersion: left.version }, changes: { nodes: { put: [{
        id: leftId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Left changed', category: 'data' },
      }] } } }),
      api.command('graph.apply', { mapId, branch: { rootIds: [rightId], expectedVersion: right.version }, changes: { nodes: { put: [{
        id: rightId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Right changed', category: 'quote' },
      }] } } }),
    ])
    expect([leftWrite.status, rightWrite.status]).toEqual([200, 200])
    const snapshot = await api.snapshot(mapId)
    expect(snapshot.nodes.find((node: { id: string }) => node.id === leftId)?.payload.content).toBe('Left changed')
    expect(snapshot.nodes.find((node: { id: string }) => node.id === rightId)?.payload.content).toBe('Right changed')

    const stale = await api.branch(mapId, [leftId])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [leftId], expectedVersion: stale.version }, changes: { nodes: { put: [{
      id: leftId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Winner', category: 'data' },
    }] } } })).status).toBe(200)
    const loser = await api.command('graph.apply', { mapId, branch: { rootIds: [leftId], expectedVersion: stale.version }, changes: { nodes: { put: [{
      id: leftId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Loser', category: 'data' },
    }] } } })
    expect(loser).toMatchObject({ status: 409, body: { error: { code: 'BRANCH_VERSION_CONFLICT' } } })
  }, 20_000)

  it('expands through new successors, requires all existing endpoints for cross-branch edges and rejects ID reuse', async () => {
    const { mapId, leftId, rightId } = await createMapWithClaims()
    const left = await api.branch(mapId, [leftId]), opinionId = randomUUID(), successorId = randomUUID()
    const expanded = await api.command('graph.apply', { mapId, branch: { rootIds: [leftId], expectedVersion: left.version }, changes: {
      nodes: { put: [{ id: opinionId, typeId: FACT_TYPES.opinion.id, typeVersion: FACT_TYPES.opinion.version,
        payload: { score: 1, reason: 'Manual opinion', evidenceClaimIds: [] } }] },
      edges: { put: [{ id: successorId, kind: 'successor', from: leftId, to: opinionId }] },
    } })
    expect(expanded).toMatchObject({ status: 200, body: { data: { branch: { scope: { nodeIds: expect.arrayContaining([leftId, opinionId]) } } } } })

    const onlyLeft = await api.branch(mapId, [leftId]), referenceId = randomUUID()
    const outside = await api.command('graph.apply', { mapId, branch: { rootIds: [leftId], expectedVersion: onlyLeft.version },
      changes: { edges: { put: [{ id: referenceId, kind: 'reference', from: leftId, to: rightId }] } } })
    expect(outside).toMatchObject({ status: 409, body: { error: { code: 'BRANCH_SCOPE_CONFLICT' } } })
    const both = await api.branch(mapId, [leftId, rightId])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [...both.scope.rootIds], expectedVersion: both.version },
      changes: { edges: { put: [{ id: referenceId, kind: 'reference', from: leftId, to: rightId }] } } })).status).toBe(200)

    const disposable = randomUUID()
    expect((await api.apply(mapId, [disposable], { nodes: { put: [{ id: disposable, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version,
      payload: { content: 'Disposable', category: null } }] } }, true)).status).toBe(200)
    const disposableBranch = await api.branch(mapId, [disposable])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [disposable], expectedVersion: disposableBranch.version },
      changes: { nodes: { remove: [disposable] } } })).status).toBe(200)
    const reused = await api.apply(mapId, [disposable], { nodes: { put: [{ id: disposable, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version,
      payload: { content: 'Reused', category: null } }] } }, true)
    expect(reused).toMatchObject({ status: 409, body: { error: { code: 'NODE_ID_REUSED' } } })
  }, 20_000)

  it('accepts evidence Claim references only when both branches are authorized', async () => {
    // Opinion 引用另一个 Claim 时，必须同时持有核查分支和证据陈述分支的授权范围。
    const { mapId, leftId } = await createMapWithClaims()
    const evidenceClaimId = randomUUID(), opinionId = randomUUID(), edgeId = randomUUID()
    expect((await api.apply(mapId, [evidenceClaimId], { nodes: { put: [{ id: evidenceClaimId,
      typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version,
      payload: { content: 'External evidence claim', category: 'data' } }] } }, true)).status).toBe(200)
    const evidenceBefore = await api.branch(mapId, [evidenceClaimId])
    const bypass = await api.apply(mapId, [opinionId], { nodes: { put: [{ id: opinionId, typeId: FACT_TYPES.opinion.id, typeVersion: FACT_TYPES.opinion.version,
      payload: { score: 1, reason: 'Cross branch', evidenceClaimIds: [evidenceClaimId] } }] } }, true)
    expect(bypass).toMatchObject({ status: 409, body: { error: { code: 'BRANCH_SCOPE_CONFLICT' } } })

    const combined = await api.branch(mapId, [leftId, evidenceClaimId])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: combined.scope.rootIds, expectedVersion: combined.version }, changes: {
      nodes: { put: [{ id: opinionId, typeId: FACT_TYPES.opinion.id, typeVersion: FACT_TYPES.opinion.version,
        payload: { score: 1, reason: 'Authorized cross branch', evidenceClaimIds: [evidenceClaimId] } }] },
      edges: { put: [{ id: edgeId, kind: 'successor', from: leftId, to: opinionId }] },
    } })).status).toBe(200)
    const savedOpinion = (await api.snapshot(mapId)).nodes.find(
      /* 最新图中的一个已发布节点。 */ (node: { id: string }) => /* 定位刚创建的核查意见以检查其证据引用。 */ node.id === opinionId,
    )
    expect(savedOpinion?.payload.evidenceClaimIds).toEqual([evidenceClaimId])
    expect((await api.branch(mapId, [evidenceClaimId])).version).not.toBe(evidenceBefore.version)
  }, 20_000)

  it('rejects a non-Claim evidence reference without publishing either the opinion or its edge', async () => {
    // 已取得跨分支授权仍必须检查引用类型，News 不能冒充可复用的证据 Claim。
    const { mapId, leftId } = await createMapWithClaims()
    const newsId = randomUUID(), opinionId = randomUUID(), edgeId = randomUUID()
    expect((await api.apply(mapId, [newsId], { nodes: { put: [{ id: newsId,
      typeId: FACT_TYPES.news.id, typeVersion: FACT_TYPES.news.version,
      payload: { content: 'Original report', context: {} } }] } }, true)).status).toBe(200)
    const before = await api.snapshot(mapId), combined = await api.branch(mapId, [leftId, newsId])
    const invalid = await api.command('graph.apply', { mapId,
      branch: { rootIds: combined.scope.rootIds, expectedVersion: combined.version }, changes: {
        nodes: { put: [{ id: opinionId, typeId: FACT_TYPES.opinion.id, typeVersion: FACT_TYPES.opinion.version,
          payload: { score: 1, reason: 'News is not a Claim', evidenceClaimIds: [newsId] } }] },
        edges: { put: [{ id: edgeId, kind: 'successor', from: leftId, to: opinionId }] },
      },
    })
    expect(invalid).toMatchObject({ status: 422, body: { error: { code: 'OUTPUT_REFERENCE_INVALID' } } })
    expect(await api.snapshot(mapId)).toMatchObject({ revision: before.revision, nodes: before.nodes, edges: before.edges })
  }, 20_000)

  it('binds idempotent responses and Run start to the selected branch version', async () => {
    const { mapId, leftId, rightId } = await createMapWithClaims()
    const newId = randomUUID(), requestId = randomUUID(), create = { mapId, branch: { rootIds: [newId], expectedVersion: null }, changes: {
      nodes: { put: [{ id: newId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Stable', category: null } }] },
    } }
    const first = await api.command('graph.apply', create, requestId)
    expect(first).toMatchObject({ status: 200, body: { replayed: false, data: { branch: { version: expect.any(String) } } } })
    const right = await api.branch(mapId, [rightId])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [rightId], expectedVersion: right.version }, changes: { nodes: { put: [{
      id: rightId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Unrelated', category: 'quote' },
    }] } } })).status).toBe(200)
    const replay = await api.command('graph.apply', create, requestId)
    expect(replay).toMatchObject({ status: 200, body: { replayed: true, data: { createdNodeIds: [newId] } } })
    expect(replay.body.data).not.toHaveProperty('branch')

    const stale = await api.branch(mapId, [leftId])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [leftId], expectedVersion: stale.version }, changes: { nodes: { put: [{
      id: leftId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Changed before run', category: 'data' },
    }] } } })).status).toBe(200)
    const start = await api.command('run.start', { mapId, id: randomUUID(), branch: { rootIds: [leftId], expectedVersion: stale.version },
      scope: { nodeIds: [leftId] }, plan: verificationPlan([leftId]), mode: 'auto' })
    expect(start).toMatchObject({ status: 409, body: { error: { code: 'BRANCH_VERSION_CONFLICT' } } })
  }, 20_000)

  it('blocks structural input changes while the Run owns that branch', async () => {
    const context = await api.createRun('auto', undefined, { content: 'Structural context', context: {} })
    if (!context.newsId) throw new Error('Expected news root')
    const busy = await api.command('branch.claim', { mapId: context.mapId, rootIds: [context.newsId], holderId: randomUUID() })
    expect(busy).toMatchObject({ status: 200, body: { data: { status: 'busy', ownership: { kind: 'run', runId: context.runId } } } })
  }, 20_000)
})
