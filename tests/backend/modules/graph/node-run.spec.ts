// 验证一个通用 Run 按数据节点实例化多个独立 Operation。
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGraphApi, FACT_TYPES, proof, verificationPlan, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi() }, 30_000)
afterAll(async () => { await api?.close() })

async function createClaims(count: number) {
  const workspace = await api.createWorkspace(), mapId = randomUUID(), claimIds = Array.from({ length: count }, () => randomUUID())
  expect((await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Node operations' })).status).toBe(201)
  expect((await api.command('graph.apply', { mapId, branch: { rootIds: claimIds, expectedVersion: null }, changes: { nodes: { put: claimIds.map((id, index) => ({
    id, typeId: FACT_TYPES.claim.id, typeVersion: 1, payload: { content: `Claim ${index + 1}`, category: 'data' },
  })) } } })).status).toBe(200)
  return { mapId, claimIds }
}

async function start(mapId: string, claimIds: string[], mode: 'auto' | 'human-in-loop' = 'auto') {
  const runId = randomUUID(), runBranch = await api.branch(mapId, claimIds)
  const result = await api.command('run.start', { mapId, id: runId,
    branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version }, scope: { nodeIds: claimIds }, plan: verificationPlan(claimIds), mode })
  expect(result.status).toBe(200)
  return { runId, snapshot: result.body.data.snapshot }
}

describe('Node-driven generic Runs', () => {
  it('instantiates one Operation per input node and exposes both planner Works independently', async () => {
    const { mapId, claimIds } = await createClaims(2), started = await start(mapId, claimIds)
    expect(started.snapshot.runs[0].operations).toHaveLength(2)
    expect(new Set(started.snapshot.runs[0].operations.map((operation: { group: { inputRefs: Array<{ id: string }> } }) => operation.group.inputRefs[0].id)))
      .toEqual(new Set(claimIds))
    const first = await api.claim(mapId, 'host-a', randomUUID(), 'route'), second = await api.claim(mapId, 'host-b', randomUUID(), 'route')
    expect(first?.operationId).not.toBe(second?.operationId)
    expect(await api.claim(mapId, 'host-c', randomUUID(), 'route')).toBeNull()
  })

  it('keeps another node Operation executable while one waits for plan Review', async () => {
    const { mapId, claimIds } = await createClaims(2)
    await start(mapId, claimIds, 'human-in-loop')
    const first = (await api.claim(mapId, 'first', randomUUID(), 'route'))!, built = await api.plan(first, 1)
    expect((await api.propose(first, built.proposal)).status).toBe(200)
    const current = await api.snapshot(mapId)
    expect(current.runs[0].operations.find((operation: { id: string }) => operation.id === first.operationId).review.kind).toBe('plan')
    const other = await api.claim(mapId, 'other', randomUUID(), 'route')
    expect(other?.operationId).not.toBe(first.operationId)
  })

  it('does not expand explicit scope through a shared successor graph', async () => {
    const workspace = await api.createWorkspace(), mapId = randomUUID(), newsId = randomUUID(), first = randomUUID(), second = randomUUID()
    await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Shared graph' })
    await api.command('graph.apply', { mapId, branch: { rootIds: [newsId], expectedVersion: null }, changes: { nodes: { put: [
      { id: newsId, typeId: FACT_TYPES.news.id, typeVersion: 1, payload: { content: 'Shared report', context: {} } },
      ...[first, second].map(id => ({ id, typeId: FACT_TYPES.claim.id, typeVersion: 1, payload: { content: id, category: null } })),
    ] }, edges: { put: [first, second].map(id => ({ id: randomUUID(), kind: 'successor', from: newsId, to: id })) } } })
    const runBranch = await api.branch(mapId, [newsId])
    const result = await api.command('run.start', { mapId, id: randomUUID(),
      branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version }, scope: { nodeIds: [first, newsId] }, plan: verificationPlan([first], [newsId]), mode: 'auto' })
    expect(result.body.data.snapshot.runs[0].operations).toHaveLength(1)
    expect(result.body.data.snapshot.runs[0].operations[0].group).toMatchObject({ inputRefs: [{ id: first }], contextRefs: [{ id: newsId }] })
  })

  it('revokes a pre-pause grant and issues a higher fence after resume', async () => {
    const { mapId, claimIds } = await createClaims(1), { runId } = await start(mapId, claimIds)
    const old = (await api.claim(mapId, 'old', randomUUID(), 'route'))!
    expect((await api.command('run.pause', { mapId, runId })).status).toBe(200)
    expect((await api.work('read', proof(old))).status).toBeGreaterThanOrEqual(400)
    expect((await api.command('run.resume', { mapId, runId })).status).toBe(200)
    const fresh = (await api.claim(mapId, 'fresh', randomUUID(), 'route'))!
    expect(fresh).toMatchObject({ workId: old.workId, fence: old.fence + 1 })
  }, 15_000)
})
