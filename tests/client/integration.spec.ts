import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientCreateGateway } from '../../client/api'
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

async function waitForMap(mapId: string, predicate: (snapshot: GraphSnapshot) => boolean) {
  const deadline = Date.now() + 20000
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
      mapId, expectedRevision: claim.data.snapshot.revision, id: runId, targetId: claimId, mode: 'human-in-loop',
    })
    const routed = await waitForMap(mapId, snapshot => snapshot.run?.operation.review?.kind === 'route')
    expect(routed.run?.status).toBe('waiting')
    expect(routed.run?.operation.route?.slots).toHaveLength(3)
    expect(fixture.modelCalls.some(call => call.role === 'worker')).toBe(false)

    await gateway.disconnect()
    expect(await gateway.getConnection()).toMatchObject({ configured: false })
    await gateway.connect(connection)
    const resumed = await gateway.read('map.get', { mapId })
    expect(resumed.run).toMatchObject({ id: runId, status: 'waiting' })
    const routeReview = resumed.run!.operation.review!
    const revised = await gateway.dispatch(randomUUID(), 'review.update', {
      mapId, expectedRevision: resumed.revision, runId, reviewId: routeReview.id,
      expectedReviewRevision: routeReview.revision, reason: '先核查来源与数据两个角度。',
      slots: resumed.run!.operation.route!.slots.slice(0, 2),
    })
    const approvedRoute = revised.data.snapshot
    await gateway.dispatch(randomUUID(), 'review.answer', {
      mapId, expectedRevision: approvedRoute.revision, runId,
      reviewId: approvedRoute.run!.operation.review!.id,
      expectedReviewRevision: approvedRoute.run!.operation.review!.revision, decision: 'approve',
    })
    const result = await waitForMap(mapId, snapshot => snapshot.run?.operation.review?.kind === 'result')
    expect(result.run!.operation.reports).toHaveLength(2)
    expect(result.nodes.some(node => node.data.kind === 'verification')).toBe(false)
    expect(result.run!.operation.draft?.score).toBe(0.5)
    const resultReview = result.run!.operation.review!
    const requestId = randomUUID()
    const answer = { mapId, expectedRevision: result.revision, runId, reviewId: resultReview.id,
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

  it('surfaces real token revocation and clears the client connection on disconnect', async () => {
    await fixture.application.auth.revokeToken(fixture.tokenId)
    await expect(gateway.read('workspace.list', {})).rejects.toMatchObject({ status: 401 })
    await gateway.disconnect()
    expect(await gateway.getConnection()).toMatchObject({ configured: false, remembered: false })
  })
})
