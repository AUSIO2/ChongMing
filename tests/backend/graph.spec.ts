import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { MongoMemoryServer } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiCreateServer } from '../../backend/api'
import { graphCreateService } from '../../backend/graph'
import {
  storeCreateConnection,
  storeCreateGraphStore,
  storeDeleteConnection,
} from '../../backend/store'
import { DEVELOPMENT_WORKSPACE_ID } from '../../contracts/graph'

let mongo: MongoMemoryServer
let connection: Connection
let server: Server
let baseUrl: string

async function request(path: 'query' | 'command', body: unknown) {
  const response = await fetch(`${baseUrl}/api/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  connection = await storeCreateConnection(mongo.getUri('chongming_graph_test'))
  server = apiCreateServer(graphCreateService(storeCreateGraphStore(connection)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Graph server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
}, 30_000)

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await storeDeleteConnection(connection)
  await mongo.stop()
})

describe('Graph HTTP API', () => {
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
      params: { workspaceId: DEVELOPMENT_WORKSPACE_ID, expectedRevision: 0, id: mapId, name: 'Shared graph' },
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

    await storeDeleteConnection(connection)
    connection = await storeCreateConnection(mongo.getUri('chongming_graph_test'))
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server = apiCreateServer(graphCreateService(storeCreateGraphStore(connection)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Graph server did not restart')
    baseUrl = `http://127.0.0.1:${address.port}`
    expect(await request('query', { method: 'map.get', params: { mapId } })).toMatchObject({
      status: 200,
      body: { data: { nodes: [{ id: newsB }, { id: claim }] } },
    })
    expect(await request('query', {
      method: 'map.list', params: { workspaceId: DEVELOPMENT_WORKSPACE_ID },
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
      method: 'map.list', params: { workspaceId: DEVELOPMENT_WORKSPACE_ID },
    })).toMatchObject({ status: 200, body: { data: [] } })
  }, 30_000)
})
