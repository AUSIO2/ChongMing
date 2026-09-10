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

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  connection = await storeCreateConnection(mongo.getUri('chongming_run_test'))
  server = apiCreateServer(graphCreateService(storeCreateGraphStore(connection)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Run server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
}, 30_000)

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await storeDeleteConnection(connection)
  await mongo.stop()
})

describe('Run and Review API', () => {
  it('accepts two reports and commits an approved verification', async () => {
    const mapId = randomUUID()
    const claimId = randomUUID()
    const runId = randomUUID()
    await post('/api/v1/command', {
      requestId: randomUUID(), method: 'map.create',
      params: { workspaceId: DEVELOPMENT_WORKSPACE_ID, expectedRevision: 0, id: mapId, name: 'Run' },
    })
    await post('/api/v1/command', {
      requestId: randomUUID(), method: 'graph.apply',
      params: {
        mapId, expectedRevision: 0,
        changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'Claim', category: 'data' } }] } },
      },
    })
    const started = await post('/api/v1/command', {
      requestId: randomUUID(), method: 'run.start',
      params: { mapId, expectedRevision: 1, id: runId, targetId: claimId, mode: 'human-in-loop' },
    })
    expect(started).toMatchObject({ status: 200, body: { data: { snapshot: { run: { status: 'running' } } } } })
    const operationId = started.body.data.snapshot.run.operation.id as string

    expect(await post('/internal/v1/data/read', { mapId, operationId })).toMatchObject({
      status: 200,
      body: { data: { runId, operationId, claim: { id: claimId }, reports: [] } },
    })
    const first = {
      mapId,
      operationId,
      report: { id: randomUUID(), slotId: 'source', score: 1, reason: 'supported' },
    }
    expect(await post('/internal/v1/data/propose', first)).toMatchObject({
      status: 200, body: { data: { run: { status: 'running', operation: { reports: [{ slotId: 'source' }] } } } },
    })
    expect(await post('/internal/v1/data/propose', first)).toMatchObject({ status: 200 })
    expect(await post('/internal/v1/data/propose', {
      ...first, report: { ...first.report, id: randomUUID() },
    })).toMatchObject({ status: 409, body: { error: { code: 'REPORT_SLOT_CONFLICT' } } })

    const second = await post('/internal/v1/data/propose', {
      mapId,
      operationId,
      report: { id: randomUUID(), slotId: 'logic', score: 0.5, reason: 'uncertain' },
    })
    expect(second).toMatchObject({
      status: 200,
      body: { data: { run: { status: 'waiting', operation: { review: { state: 'pending' } } } } },
    })
    const waiting = second.body.data
    expect(await post('/api/v1/command', {
      requestId: randomUUID(), method: 'graph.apply',
      params: { mapId, expectedRevision: waiting.revision, changes: { name: 'blocked' } },
    })).toMatchObject({ status: 409, body: { error: { code: 'RUN_ACTIVE' } } })

    const review = waiting.run.operation.review
    const answer = {
      requestId: randomUUID(),
      method: 'review.answer',
      params: {
        mapId,
        expectedRevision: waiting.revision,
        runId,
        reviewId: review.id,
        expectedReviewRevision: review.revision,
        decision: 'approve',
      },
    }
    const approved = await post('/api/v1/command', answer)
    expect(approved).toMatchObject({
      status: 200,
      body: {
        ok: true,
        replayed: false,
        data: {
          snapshot: { run: { status: 'completed' } },
          createdNodeIds: [expect.any(String)],
          createdEdgeIds: [expect.any(String)],
        },
      },
    })
    const verification = approved.body.data.snapshot.nodes.find(
      (node: { data: { kind: string } }) => node.data.kind === 'verification',
    )
    expect(verification.data).toMatchObject({ score: 0.5, reportIds: [first.report.id, expect.any(String)] })
    expect(approved.body.data.snapshot.edges).toContainEqual(expect.objectContaining({
      kind: 'verifies', from: verification.id, to: claimId,
    }))
    expect(await post('/api/v1/command', answer)).toMatchObject({
      status: 200, body: { ok: true, replayed: true },
    })
  }, 30_000)

  it('commits auto mode and fences reports after cancellation', async () => {
    const mapId = randomUUID()
    const claimId = randomUUID()
    await post('/api/v1/command', {
      requestId: randomUUID(), method: 'map.create',
      params: { workspaceId: DEVELOPMENT_WORKSPACE_ID, expectedRevision: 0, id: mapId, name: 'Auto' },
    })
    await post('/api/v1/command', {
      requestId: randomUUID(), method: 'graph.apply',
      params: {
        mapId, expectedRevision: 0,
        changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'Claim', category: null } }] } },
      },
    })
    const autoRunId = randomUUID()
    const started = await post('/api/v1/command', {
      requestId: randomUUID(), method: 'run.start',
      params: { mapId, expectedRevision: 1, id: autoRunId, targetId: claimId, mode: 'auto' },
    })
    const operationId = started.body.data.snapshot.run.operation.id
    await post('/internal/v1/data/propose', {
      mapId, operationId,
      report: { id: randomUUID(), slotId: 'a', score: 1, reason: 'yes' },
    })
    const completed = await post('/internal/v1/data/propose', {
      mapId, operationId,
      report: { id: randomUUID(), slotId: 'b', score: 1, reason: 'yes' },
    })
    expect(completed).toMatchObject({
      status: 200,
      body: { data: { run: { status: 'completed' }, nodes: [
        { id: claimId },
        { data: { kind: 'verification', score: 1 } },
      ] } },
    })

    const cancelRunId = randomUUID()
    const next = await post('/api/v1/command', {
      requestId: randomUUID(), method: 'run.start',
      params: {
        mapId,
        expectedRevision: completed.body.data.revision,
        id: cancelRunId,
        targetId: claimId,
        mode: 'human-in-loop',
      },
    })
    const cancelledOperation = next.body.data.snapshot.run.operation.id
    const cancelled = await post('/api/v1/command', {
      requestId: randomUUID(), method: 'run.cancel',
      params: {
        mapId,
        expectedRevision: next.body.data.snapshot.revision,
        runId: cancelRunId,
      },
    })
    expect(cancelled).toMatchObject({
      status: 200, body: { data: { snapshot: { run: { status: 'cancelled' } } } },
    })
    expect(await post('/internal/v1/data/propose', {
      mapId,
      operationId: cancelledOperation,
      report: { id: randomUUID(), slotId: 'late', score: 0, reason: 'late' },
    })).toMatchObject({ status: 409, body: { error: { code: 'RUN_NOT_ACTIVE' } } })
  }, 30_000)
})
