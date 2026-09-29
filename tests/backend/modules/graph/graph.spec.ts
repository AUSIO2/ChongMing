// 验证通用数据图的 HTTP 边界、CAS、幂等和持久化。
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { graphCreateService } from '../../../../backend/modules/graph/graph-service'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { storeCreateGraphStore } from '../../../../backend/adapters/storage/mongo/graph-store'
import { createGraphApi, FACT_TYPES, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi, workspaceId: string
beforeAll(async () => { api = await createGraphApi(); workspaceId = (await api.createWorkspace()).id }, 30_000)
afterAll(async () => { await api?.close() })

describe('Generic graph HTTP API', () => {
  it('rejects malformed envelopes and payloads outside the registered type schema', async () => {
    const mapId = randomUUID()
    await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Boundary' })
    const before = await api.snapshot(mapId)
    for (const node of [
      { id: randomUUID(), payload: { content: 'missing type' } },
      { id: randomUUID(), typeId: FACT_TYPES.news.id, typeVersion: 1, payload: { content: 'missing context' } },
      { id: randomUUID(), typeId: FACT_TYPES.claim.id, typeVersion: 1, payload: { content: 'claim', category: null, extra: true } },
      { id: randomUUID(), typeId: 'unknown.type', typeVersion: 1, payload: {} },
    ]) {
      const result = await api.command('graph.apply', { mapId, branch: { rootIds: [node.id], expectedVersion: null }, changes: { nodes: { put: [node] } } })
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(await api.snapshot(mapId)).toEqual(before)
    }
  })

  it('preserves an explicitly empty payload object member through storage and later writes', async () => {
    const mapId = randomUUID(), newsId = randomUUID()
    await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Empty context' })
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [newsId], expectedVersion: null }, changes: { nodes: { put: [{ id: newsId,
      typeId: FACT_TYPES.news.id, typeVersion: 1, payload: { content: 'News', context: {} } }] } } })).status).toBe(200)
    expect((await api.snapshot(mapId)).nodes[0].payload).toHaveProperty('context', {})
    await api.apply(mapId, [newsId], { name: 'Renamed' })
    expect((await api.snapshot(mapId)).nodes[0].payload).toHaveProperty('context', {})
  })

  it('confirms an accepted asset-backed source edit after the source and asset are deleted', async () => {
    const content = Buffer.from('source evidence'), sha256 = createHash('sha256').update(content).digest('hex')
    const asset = await api.application.assets.upload(api.userToken,
      { workspaceId, requestId: randomUUID(), filename: 'source.txt', mediaType: 'text/plain', size: content.length, sha256 }, Readable.from([content]))
    const mapId = randomUUID(), nodeId = randomUUID()
    await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Asset replay' })
    const saved = { requestId: randomUUID(), method: 'graph.apply', params: { mapId, branch: { rootIds: [nodeId], expectedVersion: null }, changes: { nodes: { put: [{
      id: nodeId, typeId: FACT_TYPES.source.id, typeVersion: 1,
      payload: { label: null, locator: { kind: 'asset', assetId: asset.data.id, mediaType: 'text/plain' } },
    }] } } } }
    expect((await api.post('/api/v1/command', saved)).status).toBe(200)
    await api.apply(mapId, [nodeId], { nodes: { remove: [nodeId] } })
    await api.command('asset.delete', { assetId: asset.data.id, expectedSha256: sha256 })
    expect(await api.post('/api/v1/command', saved)).toMatchObject({ status: 200, body: { replayed: true, data: { snapshot: { nodes: [] } } } })
    const changed = structuredClone(saved); changed.params.changes.nodes.put[0].payload.locator.assetId = randomUUID()
    expect(await api.post('/api/v1/command', changed)).toMatchObject({ status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } } })
  })

  it('rejects an oversized generic document before publishing it', async () => {
    const id = randomUUID(), now = new Date().toISOString()
    await expect(api.store.create({ id, workspaceId, revision: 0, name: 'Too large', nodes: [{ id: randomUUID(), revision: 0,
      typeId: FACT_TYPES.news.id, typeVersion: 1, payload: { content: 'x'.repeat(8 * 1024 * 1024), context: {} }, createdAt: now, updatedAt: now }],
    edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now })).rejects.toMatchObject({ status: 413, code: 'GRAPH_LIMIT' })
    expect(await api.store.read(id)).toBeNull()
  })

  it('uses branch versions for CAS, replays identical requests and summarizes registered type ids', async () => {
    const mapId = randomUUID(), newsId = randomUUID(), claimId = randomUUID(), edgeId = randomUUID()
    await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'CAS graph' })
    const requestId = randomUUID(), changes = { nodes: { put: [
      { id: newsId, typeId: FACT_TYPES.news.id, typeVersion: 1, payload: { content: 'A', context: {} } },
      { id: claimId, typeId: FACT_TYPES.claim.id, typeVersion: 1, payload: { content: 'B', category: 'data' } },
    ] }, edges: { put: [{ id: edgeId, kind: 'successor', from: newsId, to: claimId }] } }
    const create = { mapId, branch: { rootIds: [newsId], expectedVersion: null }, changes }
    expect((await api.command('graph.apply', create, requestId)).status).toBe(200)
    expect(await api.command('graph.apply', create, requestId)).toMatchObject({ status: 200, body: { replayed: true } })
    const old = await api.branch(mapId, [newsId])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: old.scope.rootIds, expectedVersion: old.version },
      changes: { nodes: { put: [{ id: claimId, typeId: FACT_TYPES.claim.id, typeVersion: 1, payload: { content: 'changed', category: 'data' } }] } } })).status).toBe(200)
    const stale = await api.command('graph.apply', { mapId, branch: { rootIds: old.scope.rootIds, expectedVersion: old.version }, changes: { name: 'stale' } })
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'BRANCH_VERSION_CONFLICT' } } })
    expect(await api.post('/api/v1/query', { method: 'map.list', params: { workspaceId } })).toMatchObject({ status: 200,
      body: { data: expect.arrayContaining([expect.objectContaining({ id: mapId, nodeCount: 2,
        typeCounts: { 'factcheck.news': 1, 'factcheck.claim': 1 } })]) } })
    const reopened = await storeCreateConnection(api.uri)
    try { expect(await graphCreateService(storeCreateGraphStore(reopened)).read({ method: 'map.get', params: { mapId } })).toMatchObject({ nodes: [{ id: newsId }, { id: claimId }] }) }
    finally { await reopened.close() }
  })
})
