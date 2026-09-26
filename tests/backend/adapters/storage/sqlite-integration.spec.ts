import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureCreateEnvironment, type UiFixture } from '../../../client/ui-fixture'
import { clientCreateGateway } from '../../../../client/graph-client'
import type { GraphSnapshot } from '../../../../contracts/graph'
import type { GraphStreamEvent } from '../../../../contracts/events'

let fixture: UiFixture
let gateway: ReturnType<typeof clientCreateGateway>
beforeAll(async () => {
  fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
  gateway = clientCreateGateway({ baseUrl: fixture.baseUrl })
  await gateway.connect({ baseUrl: fixture.baseUrl, token: fixture.token, remember: false })
}, 20_000)
afterAll(async () => { await gateway?.disconnect(); await fixture?.close() }, 20_000)
async function sqliteWaitMap(mapId: string, predicate: (snapshot: GraphSnapshot) => boolean) {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const snapshot = await gateway.read('map.get', { mapId })
    if (snapshot.run?.status === 'failed') throw new Error(JSON.stringify(snapshot.run.error))
    if (predicate(snapshot)) return snapshot
    await delay(40)
  }
  throw new Error('Local flow did not reach its business boundary')
}
describe('SQLite / in-process notifications / real DSH', () => {
  it('parses sources, splits independent facts, verifies all successors and streams snapshots without an external broker', async () => {
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const mapId = randomUUID(), sourceId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'SQLite full flow' })
    const events: GraphStreamEvent[] = [], stop = new AbortController()
    const streaming = gateway.watch(mapId, event => events.push(event), stop.signal).catch(error => { if (!stop.signal.aborted) throw error })
    try {
      const added = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, expectedRevision: created.data.snapshot.revision,
        changes: { nodes: { put: [{ id: sourceId, data: { kind: 'source', locator: { kind: 'url', url: fixture.sourceUrl }, label: 'SQLite source' } }] } } })
      await gateway.dispatch(randomUUID(), 'run.start', { mapId, expectedRevision: added.data.snapshot.revision, id: randomUUID(), scope: { nodeIds: [sourceId] }, until: 'verified', mode: 'auto' })
      const final = await sqliteWaitMap(mapId, snapshot => snapshot.run?.status === 'completed')
      expect(final.nodes.filter(node => node.data.kind === 'news')).toHaveLength(1)
      expect(final.nodes.filter(node => node.data.kind === 'claim')).toHaveLength(2)
      expect(final.nodes.filter(node => node.data.kind === 'verification')).toHaveLength(2)
      expect(final.run!.operations).toHaveLength(4)
      await expect.poll(() => events.some(event => event.type === 'snapshot' && event.snapshot.revision === final.revision)).toBe(true)
      expect(events.some(event => event.type === 'activity' && event.items.length > 0)).toBe(true)
      expect(fixture.errors).toEqual([])
    } finally { stop.abort(); await streaming }
  }, 50_000)

  it('preserves Review decisions while paused and reuses saved opinions on continuation', async () => {
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Local pause' })
    const added = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, expectedRevision: created.data.snapshot.revision,
      changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'SQLite pause resume fact', category: null } }] } } })
    await gateway.dispatch(randomUUID(), 'run.start', { mapId, expectedRevision: added.data.snapshot.revision, id: runId, scope: { nodeIds: [claimId] }, until: 'verified', mode: 'human-in-loop' })
    const waiting = await sqliteWaitMap(mapId, snapshot => snapshot.run?.operations[0].review?.kind === 'route')
    const paused = await gateway.dispatch(randomUUID(), 'run.pause', { mapId, expectedRevision: waiting.revision, runId })
    const operation = paused.data.snapshot.run!.operations[0]
    const approved = await gateway.dispatch(randomUUID(), 'review.answer', { mapId, expectedRevision: paused.data.snapshot.revision, runId, operationId: operation.id,
      reviewId: operation.review!.id, expectedReviewRevision: operation.review!.revision, decision: 'approve' })
    expect(approved.data.snapshot.run?.paused).toBe(true)
    await gateway.dispatch(randomUUID(), 'run.resume', { mapId, expectedRevision: approved.data.snapshot.revision, runId })
    const result = await sqliteWaitMap(mapId, snapshot => snapshot.run?.operations[0].review?.kind === 'result')
    expect(result.run!.operations[0].reports).toHaveLength(3)
    const final = await gateway.dispatch(randomUUID(), 'review.answer', { mapId, expectedRevision: result.revision, runId, operationId: operation.id,
      reviewId: result.run!.operations[0].review!.id, expectedReviewRevision: result.run!.operations[0].review!.revision, decision: 'approve' })
    expect(final.data.snapshot.run?.status).toBe('completed')
  }, 40_000)

  it('roundtrips assets and imports an exported workspace with remapped references', async () => {
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const bytes = new TextEncoder().encode('SQLite shared source file')
    const file = await gateway.upload(randomUUID(), { workspaceId: workspace.id, filename: 'source.txt', mediaType: 'text/plain', bytes })
    const mapId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Asset map' })
    await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, expectedRevision: created.data.snapshot.revision, changes: { nodes: { put: [{
      id: randomUUID(), data: { kind: 'source', locator: { kind: 'asset', assetId: file.data.id, mediaType: file.data.mediaType }, label: null },
    }] } } })
    expect((await gateway.download({ kind: 'asset', id: file.data.id })).bytes).toEqual(bytes)
    const exported = await gateway.download({ kind: 'map', id: mapId })
    const staged = await gateway.upload(randomUUID(), { workspaceId: workspace.id, filename: 'map.json', mediaType: 'application/json', bytes: exported.bytes })
    const imported = await gateway.dispatch(randomUUID(), 'workspace.import', { id: randomUUID(), bundleAssetId: staged.data.id, stagingWorkspaceId: workspace.id, name: 'Imported SQLite' })
    const copy = await gateway.read('map.get', { mapId: imported.data.mapIds[0] })
    expect(copy.workspaceId).toBe(imported.data.workspaceId)
    expect(copy.run).toBeNull()
    expect(imported.data.assetIds).toHaveLength(1)
    expect((await gateway.download({ kind: 'asset', id: imported.data.assetIds[0] })).bytes).toEqual(bytes)
  })
})
