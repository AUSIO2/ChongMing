import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientCreateGateway } from '../../client/graph-client'
import type { GraphSnapshot } from '../../contracts/graph'
import { fixtureCreateEnvironment, type UiFixture } from './ui-fixture'

let fixture: UiFixture
let gateway: ReturnType<typeof clientCreateGateway>

beforeAll(async () => {
  fixture = await fixtureCreateEnvironment()
  gateway = clientCreateGateway({ baseUrl: fixture.baseUrl, timeoutMs: 3000 })
}, 30_000)

afterAll(async () => {
  await gateway?.disconnect()
  await fixture?.close()
})

async function waitForMap(mapId: string, predicate: (snapshot: GraphSnapshot) => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await gateway.read('map.get', { mapId })
    if (snapshot.run?.status === 'failed') throw new Error(`Fixture Run failed: ${JSON.stringify(snapshot.run.error)}; ${fixture.errors.join('; ')}`)
    if (predicate(snapshot)) return snapshot
    await delay(50)
  }
  throw new Error('Client polling did not reach its business boundary')
}

describe('Real client, authenticated backend and native DSH', () => {
  it('connects, creates a Claim, answers both Reviews and reads a traceable verification', async () => {
    const connection = { baseUrl: fixture.baseUrl, token: fixture.token, remember: false }
    const bootstrap = await gateway.connect(connection)
    expect(bootstrap.identity).toEqual(fixture.identity)
    expect(await gateway.getConnection()).toMatchObject({ configured: true, remembered: false, canRemember: false })
    await expect(gateway.connect({ ...connection, token: 'invalid-token' })).rejects.toMatchObject({ status: 401 })
    // Connecting to a new identity disconnects the previous one, including when validation fails.
    expect(await gateway.getConnection()).toMatchObject({ configured: false })
    await gateway.connect(connection)
    expect((await gateway.read('app.bootstrap', {})).identity.userId).toBe(fixture.identity.userId)
    const workspaces = await gateway.read('workspace.list', {})
    expect(workspaces.items).toContainEqual(expect.objectContaining({ id: fixture.workspaceId }))
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', {
      workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: '客户端闭环验收',
    })
    const claim = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId,
      expectedRevision: created.data.snapshot.revision,
      changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: '这条消息中的关键事实需要独立核查。', category: 'data' } }] } },
    })
    await gateway.dispatch(randomUUID(), 'run.start', {
      mapId, expectedRevision: claim.data.snapshot.revision, id: runId, scope: { nodeIds: [claimId] }, until: 'verified', mode: 'human-in-loop',
    })
    const routed = await waitForMap(mapId, snapshot => snapshot.run?.operations[0].review?.kind === 'route')
    expect(routed.run?.status).toBe('waiting')
    expect(routed.run?.operations[0].route?.slots).toHaveLength(3)
    expect(fixture.modelCalls.some(call => call.role === 'worker')).toBe(false)
    const pauseId = randomUUID()
    const pauseInput = { mapId, expectedRevision: routed.revision, runId }
    const paused = await gateway.dispatch(pauseId, 'run.pause', pauseInput)
    expect(paused.data.snapshot.run?.paused).toBe(true)

    await gateway.disconnect()
    expect(await gateway.getConnection()).toMatchObject({ configured: false })
    await gateway.connect(connection)
    const resumed = await gateway.read('map.get', { mapId })
    expect(resumed.run).toMatchObject({ id: runId, status: 'waiting', paused: true })
    const routeReview = resumed.run!.operations[0].review!
    const revised = await gateway.dispatch(randomUUID(), 'review.update', {
      mapId, expectedRevision: resumed.revision, runId, operationId: resumed.run!.operations[0].id, reviewId: routeReview.id,
      expectedReviewRevision: routeReview.revision, reason: '先核查来源与数据两个角度。',
      slots: resumed.run!.operations[0].route!.slots.slice(0, 2),
    })
    const approvedRoute = revised.data.snapshot
    const routedWhilePaused = await gateway.dispatch(randomUUID(), 'review.answer', {
      mapId, expectedRevision: approvedRoute.revision, runId, operationId: approvedRoute.run!.operations[0].id,
      reviewId: approvedRoute.run!.operations[0].review!.id,
      expectedReviewRevision: approvedRoute.run!.operations[0].review!.revision, decision: 'approve',
    })
    expect(routedWhilePaused.data.snapshot.run?.paused).toBe(true)
    expect(fixture.modelCalls.some(call => call.role === 'worker')).toBe(false)
    await gateway.dispatch(randomUUID(), 'run.resume', { mapId, expectedRevision: routedWhilePaused.data.snapshot.revision, runId })
    const replay = await gateway.dispatch(pauseId, 'run.pause', pauseInput)
    expect(replay.replayed).toBe(true)
    expect(replay.data.snapshot.run?.paused).toBe(false)
    const result = await waitForMap(mapId, snapshot => snapshot.run?.operations[0].review?.kind === 'result')
    expect(result.run!.operations[0].reports).toHaveLength(2)
    expect(result.nodes.some(node => node.data.kind === 'verification')).toBe(false)
    expect(result.run!.operations[0].draft?.score).toBe(0.5)
    const resultReview = result.run!.operations[0].review!
    const requestId = randomUUID()
    const answer = { mapId, expectedRevision: result.revision, runId, operationId: result.run!.operations[0].id, reviewId: resultReview.id,
      expectedReviewRevision: resultReview.revision, decision: 'approve' as const }
    const accepted = await gateway.dispatch(requestId, 'review.answer', answer)
    expect(accepted.data.snapshot.run?.status).toBe('completed')
    expect((await gateway.dispatch(requestId, 'review.answer', answer)).replayed).toBe(true)
    const final = await gateway.read('map.get', { mapId })
    const verification = final.nodes.find(node => node.data.kind === 'verification')!
    expect(verification.data).toMatchObject({ kind: 'verification', score: 0.5,
      reason: '已完成 2 个独立核查角度。现有证据支持主要内容，但细节仍需更多来源确认。' })
    if (verification.data.kind !== 'verification') throw new Error('Verification result missing')
    expect(verification.data.opinions).toHaveLength(2)
    expect(verification.data.opinions.every(opinion => opinion.agentId && opinion.agentName && opinion.slotId && opinion.reason.includes('本机验收证据'))).toBe(true)
    expect(final.edges).toContainEqual(expect.objectContaining({ kind: 'verifies', from: verification.id, to: claimId }))
    expect(new Set(fixture.modelCalls.filter(call => call.role === 'worker').map(call => call.sessionId)).size).toBe(2)
    expect(fixture.errors).toEqual([])
  }, 40_000)

  it('processes selected Source and News roots to Claims, then reuses them to finish verification', async () => {
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const mapId = randomUUID(), sourceId = randomUUID(), newsId = randomUUID(), unrelatedId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: '来源与新闻批量处理' })
    const inputs = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, expectedRevision: created.data.snapshot.revision, changes: { nodes: { put: [
      { id: sourceId, data: { kind: 'source', locator: { kind: 'url', url: fixture.sourceUrl }, label: '本机来源' } },
      { id: newsId, data: { kind: 'news', content: '已有新闻中的两项事实需要拆分。', context: {} } },
      { id: unrelatedId, data: { kind: 'claim', content: '这条未选中的事实不应自动核查。', category: null } },
    ] } } })
    await gateway.dispatch(randomUUID(), 'run.start', { mapId, expectedRevision: inputs.data.snapshot.revision, id: randomUUID(), scope: { nodeIds: [sourceId, newsId] }, until: 'claims', mode: 'auto' })
    const split = await waitForMap(mapId, snapshot => snapshot.run?.status === 'completed')
    expect(split.run!.operations.filter(operation => operation.kind === 'parse')).toHaveLength(1)
    expect(split.run!.operations.filter(operation => operation.kind === 'split')).toHaveLength(2)
    expect(split.run!.operations.some(operation => operation.kind === 'verify')).toBe(false)
    expect(split.nodes.filter(node => node.data.kind === 'claim')).toHaveLength(5)
    expect(split.edges.some(edge => edge.kind === 'derived-from' && edge.to === sourceId)).toBe(true)
    const produced = split.nodes.filter(node => node.producer)
    expect(produced).toHaveLength(5)
    expect(produced.filter(node => node.producer!.kind === 'parse')).toHaveLength(1)
    expect(produced.filter(node => node.producer!.kind === 'split')).toHaveLength(4)
    expect(produced.every(node => split.edges.some(edge => edge.kind === 'derived-from' && edge.from === node.id && edge.to === node.producer!.inputId))).toBe(true)
    const generatedIds = split.nodes.map(node => node.id)
    const processingCalls = fixture.modelCalls.filter(call => call.role === 'parse' || call.role.startsWith('split-')).length
    await gateway.dispatch(randomUUID(), 'run.start', { mapId, expectedRevision: split.revision, id: randomUUID(), scope: { nodeIds: [sourceId, newsId] }, until: 'verified', mode: 'auto' })
    const final = await waitForMap(mapId, snapshot => snapshot.run?.status === 'completed', 40_000)
    expect(final.nodes.filter(node => node.data.kind === 'verification')).toHaveLength(4)
    for (const node of produced) expect(final.nodes.find(item => item.id === node.id)?.producer).toMatchObject({
      kind: node.producer!.kind, inputId: node.producer!.inputId, agentId: node.producer!.agentId, agentName: node.producer!.agentName,
    })
    expect(final.nodes.map(node => node.id)).toEqual(expect.arrayContaining(generatedIds))
    expect(final.run!.operations.some(operation => operation.targetId === unrelatedId)).toBe(false)
    expect(fixture.modelCalls.filter(call => call.role === 'parse' || call.role.startsWith('split-')).length).toBe(processingCalls)
    expect(fixture.errors).toEqual([])
  }, 60_000)

  it('surfaces real token revocation and clears the client connection on disconnect', async () => {
    await fixture.application.auth.revokeToken(fixture.tokenId)
    await expect(gateway.read('workspace.list', {})).rejects.toMatchObject({ status: 401 })
    await gateway.disconnect()
    expect(await gateway.getConnection()).toMatchObject({ configured: false, remembered: false })
  })
})
