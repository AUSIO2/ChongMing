import { randomUUID } from 'node:crypto'
import { apiCreateServer } from '../../../backend/api'
import { graphCreateService } from '../../../backend/graph'
import { storeCreateConnection, storeCreateGraphStore, storeDeleteConnection } from '../../../backend/store'
import { DEVELOPMENT_WORKSPACE_ID, type GraphWorkGrant } from '../../../contracts/graph'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { expect } from 'vitest'
import { verificationConfiguration } from './verification'

export function grantHeaders(grant: GraphWorkGrant) {
  return { 'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence) }
}

export async function createGraphApi(leaseMs = 60_000) {
  const token = 'test-work-token'
  const mongo = await MongoMemoryServer.create()
  const connection = await storeCreateConnection(mongo.getUri('chongming_work_test'))
  const store = storeCreateGraphStore(connection)
  const server = apiCreateServer(graphCreateService(store, { leaseMs }), { internalToken: token })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test Graph API did not bind')
  const url = `http://127.0.0.1:${address.port}`

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  function command(method: string, params: unknown, requestId = randomUUID()) {
    return post('/api/v1/command', { requestId, method, params })
  }
  async function snapshot(mapId: string) {
    const result = await post('/api/v1/query', { method: 'map.get', params: { mapId } })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  function work(method: string, params: unknown) {
    return post('/internal/v1/work', { method, params }, { authorization: `Bearer ${token}` })
  }
  async function claim(mapId: string, hostId = 'test-host', holderId = randomUUID()): Promise<GraphWorkGrant | null> {
    const result = await work('claim', { mapId, hostId, holderId })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  async function read(grant: GraphWorkGrant) {
    const result = await post('/internal/v1/data/read', { mapId: grant.mapId, operationId: grant.operationId }, {
      authorization: `Bearer ${token}`, ...grantHeaders(grant),
    })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  function propose(grant: GraphWorkGrant, proposal: unknown) {
    return post('/internal/v1/data/propose', proposal, { authorization: `Bearer ${token}`, ...grantHeaders(grant) })
  }
  async function proposal(grant: GraphWorkGrant, input: Record<string, unknown>) {
    const data = await read(grant)
    return {
      mapId: grant.mapId, operationId: grant.operationId, id: data.proposalId,
      ...(input.kind === 'route' ? {} : { routeRevision: data.route.revision }),
      ...(input.kind === 'report' && grant.actor.role === 'worker' ? { slotId: grant.actor.slotId } : {}),
      ...input,
    }
  }
  async function createRun(mode: 'auto' | 'human-in-loop' = 'auto', configuration = verificationConfiguration()) {
    const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
    expect(await command('map.create', {
      workspaceId: DEVELOPMENT_WORKSPACE_ID, expectedRevision: 0, id: mapId, name: 'Dynamic verification',
    })).toMatchObject({ status: 201 })
    expect(await command('graph.apply', { mapId, expectedRevision: 0,
      changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'Fixture claim', category: 'data' } }] } },
    })).toMatchObject({ status: 200 })
    const result = await command('run.start', { mapId, expectedRevision: 1, id: runId, targetId: claimId, mode, configuration })
    expect(result).toMatchObject({ status: 200, body: { data: { snapshot: { run: { id: runId, status: 'running' } } } } })
    return { mapId, claimId, runId, operationId: result.body.data.snapshot.run.operation.id as string }
  }
  async function answer(mapId: string, decision: 'approve' | 'reject' = 'approve') {
    const current = await snapshot(mapId)
    const review = current.run.operation.review
    const body = { requestId: randomUUID(), method: 'review.answer', params: {
      mapId, expectedRevision: current.revision, runId: current.run.id, reviewId: review.id,
      expectedReviewRevision: review.revision, decision,
    } }
    const result = await post('/api/v1/command', body)
    expect(result.status).toBe(200)
    return { body, snapshot: result.body.data.snapshot }
  }
  return {
    url, token, server, store, connection, mongo, post, command, snapshot, work, claim, read, propose, proposal, createRun, answer,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await storeDeleteConnection(connection)
      await mongo.stop()
    },
  }
}

export type TestGraphApi = Awaited<ReturnType<typeof createGraphApi>>

export function proof(grant: GraphWorkGrant) {
  return { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence }
}

export function expectRejected(result: Awaited<ReturnType<TestGraphApi['post']>>) {
  expect(result.status).toBeGreaterThanOrEqual(400)
  expect(result.status).toBeLessThan(500)
  expect(result.body).toMatchObject({ ok: false, error: { code: expect.any(String) } })
}
