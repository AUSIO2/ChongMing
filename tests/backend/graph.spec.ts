import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { graphCreateService } from '../../backend/graph'
import {
  storeCreateConnection,
  storeCreateGraphStore,
  storeDeleteConnection,
} from '../../backend/store'
import { createGraphApi, type TestGraphApi } from './fixtures/graph-api'

let api: TestGraphApi
let workspaceId: string

async function request(path: 'query' | 'command', body: unknown) {
  return api.post(`/api/v1/${path}`, body)
}

beforeAll(async () => {
  api = await createGraphApi()
  workspaceId = (await api.createWorkspace()).id
}, 30_000)

afterAll(async () => {
  await api?.close()
})

describe('Graph HTTP API', () => {
  it('confirms an accepted source edit after the source and its asset have been deleted', async () => {
    const content = Buffer.from('source evidence')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const asset = await api.application.assets.upload(api.userToken,
      { workspaceId, requestId: randomUUID(), filename: 'source.txt', mediaType: 'text/plain', size: content.length, sha256 }, Readable.from([content]))
    const mapId = randomUUID(), nodeId = randomUUID()
    expect((await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Asset replay' })).status).toBe(201)
    const saved = { requestId: randomUUID(), method: 'graph.apply', params: { mapId, expectedRevision: 0,
      changes: { nodes: { put: [{ id: nodeId, data: { kind: 'source', label: null, locator: { kind: 'asset', assetId: asset.data.id, mediaType: 'text/plain' } } }] } },
    } }
    expect((await request('command', saved)).status).toBe(200)
    expect((await api.command('graph.apply', { mapId, expectedRevision: 1, changes: { nodes: { remove: [nodeId] } } })).status).toBe(200)
    expect((await api.command('asset.delete', { assetId: asset.data.id, expectedSha256: sha256 })).status).toBe(200)
    expect(await request('command', saved)).toMatchObject({ status: 200, body: { replayed: true, data: { snapshot: { revision: 2, nodes: [] } } } })
    const different = structuredClone(saved)
    different.params.changes.nodes.put[0].data.locator.assetId = randomUUID()
    expect(await request('command', different)).toMatchObject({ status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } } })
    expect((await api.command('map.delete', { mapId, expectedRevision: 2 })).status).toBe(200)
  })

  it('rejects an oversized document before publishing it', async () => {
    const id = randomUUID(), now = new Date().toISOString()
    await expect(api.store.create({ id, workspaceId, revision: 0, name: 'Too large', nodes: [{
      id: randomUUID(), revision: 0, data: { kind: 'news', content: 'x'.repeat(8 * 1024 * 1024), context: {} }, createdAt: now, updatedAt: now,
    }], edges: [], run: null, runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }))
      .rejects.toMatchObject({ status: 413, code: 'GRAPH_LIMIT' })
    expect(await api.store.read(id)).toBeNull()
  })

  it('persists a shared graph with CAS and idempotent writes', async () => {
    const mapId = randomUUID()
    const newsA = randomUUID()
    const newsB = randomUUID()
    const claim = randomUUID()
    const edgeA = randomUUID()
    const edgeB = randomUUID()
    const createRequest = randomUUID()
    const created = await request('command', {
      requestId: createRequest,
      method: 'map.create',
      params: { workspaceId, expectedRevision: 0, id: mapId, name: 'Shared graph' },
    })
    expect(created).toMatchObject({ status: 201, body: { ok: true, replayed: false } })

    const applyRequest = randomUUID()
    const apply = {
      requestId: applyRequest,
      method: 'graph.apply',
      params: {
        mapId,
        expectedRevision: 0,
        changes: {
          nodes: { put: [
            {
              id: newsA,
              data: {
                kind: 'news',
                content: 'A',
                context: { author: { value: 'Reporter A', visibleToAI: false } },
              },
            },
            { id: newsB, data: { kind: 'news', content: 'B', context: {} } },
            { id: claim, data: { kind: 'claim', content: 'C', category: 'data' } },
          ] },
          edges: { put: [
            { id: edgeA, kind: 'mentions', from: newsA, to: claim },
            { id: edgeB, kind: 'mentions', from: newsB, to: claim },
          ] },
        },
      },
    }
    const applied = await request('command', apply)
    expect(applied).toMatchObject({
      status: 200,
      body: { ok: true, replayed: false, data: { snapshot: { revision: 1 } } },
    })
    const replayed = await request('command', {
      method: apply.method,
      requestId: apply.requestId,
      params: { changes: apply.params.changes, expectedRevision: 0, mapId },
    })
    expect(replayed).toMatchObject({ status: 200, body: { ok: true, replayed: true } })
    const changedReplay = structuredClone(apply)
    changedReplay.params.changes.nodes.put[0].data.content = 'different'
    expect(await request('command', changedReplay)).toMatchObject({
      status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    })

    const concurrent = await Promise.all([
      request('command', {
        requestId: randomUUID(), method: 'graph.apply',
        params: { mapId, expectedRevision: 1, changes: { name: 'Winner A' } },
      }),
      request('command', {
        requestId: randomUUID(), method: 'graph.apply',
        params: { mapId, expectedRevision: 1, changes: { name: 'Winner B' } },
      }),
    ])
    expect(concurrent.map(result => result.status).sort()).toEqual([200, 409])

    const beforeInvalid = await request('query', { method: 'map.get', params: { mapId } })
    const revision = beforeInvalid.body.data.revision as number
    expect(await request('command', {
      requestId: randomUUID(), method: 'graph.apply',
      params: {
        mapId, expectedRevision: revision,
        changes: {
          nodes: { put: [{ id: randomUUID(), data: { kind: 'claim', content: 'D', category: null } }] },
          edges: { put: [{ id: randomUUID(), kind: 'mentions', from: claim, to: newsA }] },
        },
      },
    })).toMatchObject({ status: 422, body: { error: { code: 'INVALID_RELATION' } } })
    const afterInvalid = await request('query', { method: 'map.get', params: { mapId } })
    expect(afterInvalid.body.data.revision).toBe(revision)
    expect(afterInvalid.body.data.nodes).toHaveLength(3)

    const removed = await request('command', {
      requestId: randomUUID(), method: 'graph.apply',
      params: { mapId, expectedRevision: revision, changes: { nodes: { remove: [newsA] } } },
    })
    expect(removed).toMatchObject({ status: 200, body: { data: { snapshot: { revision: revision + 1 } } } })
    expect(removed.body.data.snapshot.nodes.map((node: { id: string }) => node.id)).toEqual([newsB, claim])
    expect(removed.body.data.snapshot.edges).toEqual([
      expect.objectContaining({ id: edgeB, from: newsB, to: claim }),
    ])

    const reopened = await storeCreateConnection(api.uri)
    try {
      const fresh = graphCreateService(storeCreateGraphStore(reopened))
      expect(await fresh.read({ method: 'map.get', params: { mapId } })).toMatchObject({ nodes: [{ id: newsB }, { id: claim }] })
    } finally { await storeDeleteConnection(reopened) }
    expect(await request('query', {
      method: 'map.list', params: { workspaceId },
    })).toMatchObject({
      status: 200,
      body: { data: [{ id: mapId, nodeCount: 2, claimCount: 1 }] },
    })

    const finalSnapshot = await request('query', { method: 'map.get', params: { mapId } })
    const deleteRequest = {
      requestId: randomUUID(), method: 'map.delete',
      params: { mapId, expectedRevision: finalSnapshot.body.data.revision },
    }
    expect(await request('command', deleteRequest)).toMatchObject({
      status: 200, body: { ok: true, replayed: false, data: { mapId, deleted: true } },
    })
    expect(await request('command', deleteRequest)).toMatchObject({
      status: 200, body: { ok: true, replayed: true, data: { mapId, deleted: true } },
    })
    expect(await request('query', { method: 'map.get', params: { mapId } })).toMatchObject({
      status: 404, body: { error: { code: 'MAP_NOT_FOUND' } },
    })
    expect(await request('query', {
      method: 'map.list', params: { workspaceId },
    })).toMatchObject({ status: 200, body: { data: [] } })
  }, 30_000)
})
