import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { MongoMemoryServer } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiCreateServer } from '../../backend/api'
import { graphCreateService } from '../../backend/graph'
import { storeCreateConnection, storeCreateGraphStore, storeDeleteConnection } from '../../backend/store'
import { DEVELOPMENT_WORKSPACE_ID } from '../../contracts/graph'
import { verificationConfiguration, verificationSlots } from './fixtures/verification'

let mongo: MongoMemoryServer
let connection: Connection
let server: Server
let baseUrl: string
let graphStore: ReturnType<typeof storeCreateGraphStore>

type Role = 'router' | 'worker' | 'merge'
type RunContext = { mapId: string; claimId: string; runId: string; operationId: string }
type Slot = ReturnType<typeof verificationSlots>[number]

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

function internalHeaders(role: Role, slotId?: string) {
  return { authorization: 'Bearer test-token', 'x-dsh-role': role, ...(slotId ? { 'x-dsh-slot': slotId } : {}) }
}

function command(method: string, params: unknown, requestId = randomUUID()) {
  return post('/api/v1/command', { requestId, method, params })
}

async function snapshot(mapId: string) {
  const result = await post('/api/v1/query', { method: 'map.get', params: { mapId } })
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data
}

async function startRun(
  mode: 'auto' | 'human-in-loop' = 'auto',
  configuration = verificationConfiguration(),
): Promise<RunContext> {
  const mapId = randomUUID()
  const claimId = randomUUID()
  const runId = randomUUID()
  expect(await command('map.create', {
    workspaceId: DEVELOPMENT_WORKSPACE_ID, expectedRevision: 0, id: mapId, name: 'Dynamic verification',
  })).toMatchObject({ status: 201 })
  expect(await command('graph.apply', {
    mapId, expectedRevision: 0,
    changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'A verifiable statement', category: 'data' } }] } },
  })).toMatchObject({ status: 200 })
  const started = await command('run.start', {
    mapId, expectedRevision: 1, id: runId, targetId: claimId, mode, configuration,
  })
  expect(started).toMatchObject({
    status: 200, body: { data: { snapshot: { run: { id: runId, status: 'running' } } } },
  })
  return { mapId, claimId, runId, operationId: started.body.data.snapshot.run.operation.id }
}

async function read(context: RunContext, role: Role, slotId?: string) {
  const result = await post('/internal/v1/data/read', {
    mapId: context.mapId, operationId: context.operationId,
  }, internalHeaders(role, slotId))
  expect(result).toMatchObject({
    status: 200, body: { ok: true, data: { runId: context.runId, operationId: context.operationId } },
  })
  return result.body.data
}

function propose(proposal: unknown, role: Role, slotId?: string) {
  return post('/internal/v1/data/propose', proposal, internalHeaders(role, slotId))
}

async function routeProposal(context: RunContext, slots: Slot[]) {
  const data = await read(context, 'router')
  expect(data.phase).toBe('route')
  expect(data.proposalId).toEqual(expect.any(String))
  return {
    mapId: context.mapId, operationId: context.operationId, id: data.proposalId as string,
    kind: 'route' as const, reason: 'Use the evidence angles appropriate to this claim', slots,
  }
}

async function acceptRoute(context: RunContext, slots: Slot[]) {
  const proposal = await routeProposal(context, slots)
  const result = await propose(proposal, 'router')
  expect(result).toMatchObject({ status: 200, body: { data: { run: { operation: { route: { revision: 1 } } } } } })
  return { proposal, snapshot: result.body.data }
}

async function reportProposal(context: RunContext, slot: Slot, score: 0 | 0.5 | 1 = 1) {
  const data = await read(context, 'worker', slot.id)
  return {
    mapId: context.mapId, operationId: context.operationId, id: data.proposalId as string,
    kind: 'report' as const, routeRevision: data.route.revision as number,
    slotId: slot.id, score, reason: `Evidence from ${slot.angle}`,
  }
}

async function submitReports(context: RunContext, slots: Slot[]) {
  const proposals = await Promise.all(slots.map((slot, index) => reportProposal(context, slot, index % 2 ? 0 : 1)))
  // All independent workers read before any report commits, exercising report CAS retries.
  const results = await Promise.all(proposals.map(proposal => propose(proposal, 'worker', proposal.slotId)))
  for (const result of results) expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return proposals
}

async function mergeProposal(context: RunContext, score: 0 | 0.5 | 1 = 0) {
  const data = await read(context, 'merge')
  return {
    mapId: context.mapId, operationId: context.operationId, id: data.proposalId as string,
    kind: 'merge' as const, routeRevision: data.route.revision as number,
    reportIds: data.reports.map((report: { id: string }) => report.id) as string[],
    score, reason: 'The merger resolves the evidence, not a fixed vote formula',
  }
}

async function answerReview(context: RunContext, decision: 'approve' | 'reject' = 'approve') {
  const current = await snapshot(context.mapId)
  const review = current.run.operation.review
  const body = {
    requestId: randomUUID(), method: 'review.answer',
    params: {
      mapId: context.mapId, expectedRevision: current.revision, runId: context.runId,
      reviewId: review.id, expectedReviewRevision: review.revision, decision,
    },
  }
  const result = await post('/api/v1/command', body)
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return { body, snapshot: result.body.data.snapshot }
}

function expectRejected(result: Awaited<ReturnType<typeof post>>) {
  expect(result.status).toBeGreaterThanOrEqual(400)
  expect(result.status).toBeLessThan(500)
  expect(result.body).toMatchObject({ ok: false, error: { code: expect.any(String) } })
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  connection = await storeCreateConnection(mongo.getUri('chongming_run_test'))
  graphStore = storeCreateGraphStore(connection)
  server = apiCreateServer(graphCreateService(graphStore), { internalToken: 'test-token' })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Run server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
}, 30_000)

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  if (connection) await storeDeleteConnection(connection)
  if (mongo) await mongo.stop()
})

describe('Dynamic verification Run and Review API', () => {
  it.each([1, 4])('uses a custom %i-slot route and commits only the explicit merger result in auto mode', async (count) => {
    const context = await startRun()
    const slots = verificationSlots(count)
    const routed = await acceptRoute(context, slots)
    expect(routed.snapshot.run.status).toBe('running')
    expect(routed.snapshot.run.operation.route).toMatchObject({ revision: 1, slots })
    expect((await read(context, 'worker', slots[0].id)).phase).toBe('workers')
    const reports = await submitReports(context, slots)
    const beforeMerge = await snapshot(context.mapId)
    expect(beforeMerge.run.operation.reports).toHaveLength(count)
    expect(beforeMerge.nodes).toHaveLength(1)
    expect(beforeMerge.run.status).toBe('running')
    expect((await read(context, 'merge')).phase).toBe('merge')
    const merge = await mergeProposal(context, 0)
    const completed = await propose(merge, 'merge')
    expect(completed).toMatchObject({ status: 200, body: { data: { run: { status: 'completed' } } } })
    const verification = completed.body.data.nodes.find((node: { data: { kind: string } }) => node.data.kind === 'verification')
    expect(verification.data).toMatchObject({ score: 0, reason: merge.reason, reportIds: expect.arrayContaining(reports.map(report => report.id)) })
    expect(verification.data.opinions).toHaveLength(count)
    for (const report of reports) {
      const slot = slots.find(item => item.id === report.slotId)!
      expect(verification.data.opinions).toContainEqual(expect.objectContaining({
        id: report.id, slotId: slot.id, agentId: slot.agentId, score: report.score, reason: report.reason,
        agentName: `Custom ${slot.agentId}`, angle: slot.angle, tools: slot.tools, routeRevision: 1,
      }))
    }
    expect(completed.body.data.edges).toContainEqual(expect.objectContaining({
      kind: 'verifies', from: verification.id, to: context.claimId,
    }))
  })

  it('persists distinct route and result reviews and replays accepted writes without duplicates', async () => {
    const context = await startRun('human-in-loop')
    const slots = verificationSlots(3)
    const routed = await acceptRoute(context, slots)
    expect(routed.snapshot.run).toMatchObject({ status: 'waiting', operation: { review: { kind: 'route', state: 'pending' } } })
    const beforeApproval = await snapshot(context.mapId)
    expect((await propose(routed.proposal, 'router')).status).toBe(200)
    expect((await snapshot(context.mapId)).revision).toBe(beforeApproval.revision)
    expectRejected(await propose({ ...routed.proposal, reason: 'Changed same proposal ID' }, 'router'))
    expectRejected(await post('/internal/v1/data/read', {
      mapId: context.mapId, operationId: context.operationId,
    }, internalHeaders('worker', slots[0].id)))
    // Even a guessed valid slot identity must not bypass pending route approval.
    expectRejected(await propose({
      mapId: context.mapId, operationId: context.operationId,
      id: `${context.operationId}:report:1:${slots[0].id}`, kind: 'report',
      routeRevision: 1, slotId: slots[0].id, score: 1, reason: 'Premature report',
    }, 'worker', slots[0].id))
    expectRejected(await command('graph.apply', {
      mapId: context.mapId, expectedRevision: beforeApproval.revision, changes: { name: 'Blocked while waiting' },
    }))
    const routeAnswer = await answerReview(context)
    expect(routeAnswer.snapshot.run.status).toBe('running')
    const reports = await submitReports(context, slots)
    const beforeMerge = await snapshot(context.mapId)
    expect(beforeMerge.run.status).toBe('running')
    expect(beforeMerge.run.operation.reports).toHaveLength(3)
    expect(beforeMerge.nodes).toHaveLength(1)
    const merge = await mergeProposal(context, 0.5)
    const merged = await propose(merge, 'merge')
    expect(merged).toMatchObject({ status: 200, body: { data: {
      run: { status: 'waiting', operation: { review: { kind: 'result', state: 'pending' } } },
    } } })
    expect(merged.body.data.nodes).toHaveLength(1)
    expect(merged.body.data.run.operation.review.id).not.toBe(beforeApproval.run.operation.review.id)
    const waitingRevision = merged.body.data.revision
    expect(await post('/api/v1/command', routeAnswer.body)).toMatchObject({ status: 200, body: { replayed: true } })
    expect((await propose(reports[0], 'worker', reports[0].slotId)).status).toBe(200)
    expect((await propose(merge, 'merge')).status).toBe(200)
    expect((await snapshot(context.mapId)).revision).toBe(waitingRevision)
    const accepted = await answerReview(context)
    expect(accepted.snapshot.run.status).toBe('completed')
    expect(accepted.snapshot.nodes).toHaveLength(2)
    expect(await post('/api/v1/command', accepted.body)).toMatchObject({ status: 200, body: { replayed: true } })
    expect((await propose(merge, 'merge')).status).toBe(200)
    const replayed = await snapshot(context.mapId)
    expect(replayed.revision).toBe(accepted.snapshot.revision)
    expect(replayed.nodes).toHaveLength(2)
    expect(replayed.edges).toHaveLength(1)
  })

  it('preserves report provenance when editing a generated verification through graph.apply', async () => {
    const context = await startRun()
    const slots = verificationSlots(3)
    await acceptRoute(context, slots)
    await submitReports(context, slots)
    expect((await propose(await mergeProposal(context), 'merge')).status).toBe(200)
    const before = await snapshot(context.mapId)
    const original = before.nodes.find((node: { data: { kind: string } }) => node.data.kind === 'verification')
    expect(original.data.opinions).toHaveLength(3)
    const revisedData = { ...original.data, reason: 'Human clarified the accepted conclusion' }
    const edited = await command('graph.apply', {
      mapId: context.mapId, expectedRevision: before.revision,
      changes: { nodes: { put: [{ id: original.id, data: revisedData }] } },
    })
    expect(edited).toMatchObject({ status: 200, body: { ok: true } })
    const after = await snapshot(context.mapId)
    const verification = after.nodes.find((node: { id: string }) => node.id === original.id)
    expect(verification.data).toEqual(revisedData)
    expect(verification.data.reportIds).toEqual(original.data.reportIds)
    expect(verification.data.opinions).toEqual(original.data.opinions)
    expect(verification.revision).toBe(original.revision + 1)
    expect(after.edges).toEqual(before.edges)
    expect(after.run).toEqual(before.run)
  })

  it('versions human route edits and requires approval of the updated slot plan', async () => {
    const context = await startRun('human-in-loop')
    const routed = await acceptRoute(context, verificationSlots(3))
    const oldReview = routed.snapshot.run.operation.review
    const revisedSlots = verificationSlots(1)
    revisedSlots[0].hint = 'Human-selected archive angle'
    const updated = await command('review.update', {
      mapId: context.mapId, expectedRevision: routed.snapshot.revision, runId: context.runId,
      reviewId: oldReview.id, expectedReviewRevision: oldReview.revision,
      reason: 'Only the archive can resolve this statement', slots: revisedSlots,
    })
    expect(updated).toMatchObject({ status: 200, body: { data: { snapshot: { run: {
      status: 'waiting', operation: { route: { revision: 2, approved: false, slots: revisedSlots } },
    } } } } })
    const current = updated.body.data.snapshot
    expect(current.run.operation.review.revision).toBeGreaterThan(oldReview.revision)
    expectRejected(await command('review.answer', {
      mapId: context.mapId, expectedRevision: current.revision, runId: context.runId,
      reviewId: oldReview.id, expectedReviewRevision: oldReview.revision, decision: 'approve',
    }))
    expect(await snapshot(context.mapId)).toEqual(current)
    await answerReview(context)
    const report = await reportProposal(context, revisedSlots[0])
    expect(report.routeRevision).toBe(2)
    expectRejected(await propose({ ...report, routeRevision: 1 }, 'worker', report.slotId))
    expect((await propose(report, 'worker', report.slotId)).status).toBe(200)
    expect((await read(context, 'merge')).phase).toBe('merge')
  })

  it('rejects unknown agents, unknown or ungranted tools, duplicate slots and routes beyond the limit', async () => {
    const context = await startRun('auto', verificationConfiguration(3))
    const valid = await routeProposal(context, verificationSlots(1))
    const baseline = await snapshot(context.mapId)
    const variants = [
      [{ ...valid.slots[0], agentId: 'agent-not-in-configuration' }],
      [{ ...valid.slots[0], tools: ['tool-not-in-configuration'] }],
      [{ ...valid.slots[0], tools: ['ledger_query'] }],
      [valid.slots[0], { ...valid.slots[0] }], verificationSlots(4), [],
    ]
    for (const slots of variants) {
      expectRejected(await propose({ ...valid, slots }, 'router'))
      expect(await snapshot(context.mapId)).toEqual(baseline)
    }
    expect((await propose(valid, 'router')).status).toBe(200)
  })

  it('requires internal authentication and confines proposals to caller role and assigned slot', async () => {
    const context = await startRun()
    const query = { mapId: context.mapId, operationId: context.operationId }
    expect((await post('/internal/v1/data/read', query)).status).toBe(401)
    expect((await post('/internal/v1/data/read', query, {
      authorization: 'Bearer wrong-token', 'x-dsh-role': 'router',
    })).status).toBe(401)
    const slots = verificationSlots(3)
    const route = await routeProposal(context, slots)
    expect((await post('/internal/v1/data/propose', route)).status).toBe(401)
    expectRejected(await propose(route, 'worker', slots[0].id))
    expectRejected(await propose(route, 'merge'))
    expect((await propose(route, 'router')).status).toBe(200)
    const report = await reportProposal(context, slots[0])
    const before = await snapshot(context.mapId)
    expectRejected(await propose(report, 'router'))
    expectRejected(await propose(report, 'merge'))
    expectRejected(await propose(report, 'worker'))
    expectRejected(await propose(report, 'worker', slots[1].id))
    expectRejected(await propose({ ...report, agentId: slots[1].agentId }, 'worker', slots[0].id))
    expectRejected(await propose({ ...report, slotId: 'undeclared-slot' }, 'worker', 'undeclared-slot'))
    expect(await snapshot(context.mapId)).toEqual(before)
    expect((await propose(report, 'worker', slots[0].id)).status).toBe(200)
    expect((await snapshot(context.mapId)).run.operation.reports).toEqual([
      expect.objectContaining({ id: report.id, slotId: slots[0].id, agentId: slots[0].agentId }),
    ])
    const accepted = await snapshot(context.mapId)
    expectRejected(await propose(report, 'worker', slots[1].id))
    expectRejected(await propose(report, 'router'))
    expect(await snapshot(context.mapId)).toEqual(accepted)
  })

  it('refuses missing, foreign or stale reports and worker attempts to merge', async () => {
    const context = await startRun()
    const slots = verificationSlots(3)
    await acceptRoute(context, slots)
    const first = await reportProposal(context, slots[0])
    const beforeReport = await snapshot(context.mapId)
    expectRejected(await propose({ ...first, routeRevision: 0 }, 'worker', slots[0].id))
    expect(await snapshot(context.mapId)).toEqual(beforeReport)
    expect((await propose(first, 'worker', slots[0].id)).status).toBe(200)
    expectRejected(await propose(await mergeProposal(context), 'merge'))
    expect((await snapshot(context.mapId)).nodes).toHaveLength(1)
    await submitReports(context, slots.slice(1))
    const merge = await mergeProposal(context)
    const beforeMerge = await snapshot(context.mapId)
    expectRejected(await propose({ ...merge, reportIds: merge.reportIds.slice(1) }, 'merge'))
    expectRejected(await propose({ ...merge, reportIds: [...merge.reportIds, randomUUID()] }, 'merge'))
    expectRejected(await propose({ ...merge, reportIds: [merge.reportIds[0], ...merge.reportIds] }, 'merge'))
    expectRejected(await propose({ ...merge, routeRevision: 0 }, 'merge'))
    expectRejected(await propose(merge, 'worker', slots[0].id))
    expect(await snapshot(context.mapId)).toEqual(beforeMerge)
    expect((await propose(merge, 'merge')).status).toBe(200)
  })

  it('binds proposal IDs to operation and slot and rejects changed report replays', async () => {
    const context = await startRun()
    const slots = verificationSlots(3)
    await acceptRoute(context, slots)
    const report = await reportProposal(context, slots[0])
    expect((await reportProposal(context, slots[0])).id).toBe(report.id)
    expect((await reportProposal(context, slots[1])).id).not.toBe(report.id)
    expectRejected(await propose({ ...report, id: randomUUID() }, 'worker', slots[0].id))
    expect((await propose(report, 'worker', slots[0].id)).status).toBe(200)
    const accepted = await snapshot(context.mapId)
    expect((await propose(report, 'worker', slots[0].id)).status).toBe(200)
    expectRejected(await propose({ ...report, reason: 'Changed after acceptance' }, 'worker', slots[0].id))
    expectRejected(await propose({ ...report, id: randomUUID() }, 'worker', slots[0].id))
    expect(await snapshot(context.mapId)).toEqual(accepted)
  })

  it('freezes custom configuration for the running operation', async () => {
    const configuration = verificationConfiguration()
    const frozen = structuredClone(configuration)
    const context = await startRun('auto', configuration)
    configuration.agents[0].content = 'A later local edit must not change this run'
    configuration.agents[0].tools = []
    configuration.tools[0].description = 'A later tool edit'
    expect((await read(context, 'router')).configuration).toEqual(frozen)
    const slots = verificationSlots(3)
    await acceptRoute(context, slots)
    const workerData = await read(context, 'worker', slots[0].id)
    expect(workerData.configuration).toEqual(frozen)
    expect(workerData.route.slots[0].tools).toEqual(['archive_lookup'])
    const before = await snapshot(context.mapId)
    expectRejected(await command('run.start', {
      mapId: context.mapId, expectedRevision: before.revision, id: randomUUID(),
      targetId: context.claimId, mode: 'auto', configuration,
    }))
    expect((await read(context, 'worker', slots[0].id)).configuration).toEqual(frozen)
    expect(await snapshot(context.mapId)).toEqual(before)
  })

  it('replays an accepted historical merge after a new Run starts but rejects an unaccepted old report', async () => {
    const first = await startRun()
    const slots = verificationSlots(1)
    await acceptRoute(first, slots)
    await submitReports(first, slots)
    const acceptedMerge = await mergeProposal(first)
    expect((await propose(acceptedMerge, 'merge')).status).toBe(200)
    const completed = await snapshot(first.mapId)

    async function startNext(revision: number): Promise<RunContext> {
      const runId = randomUUID()
      const result = await command('run.start', {
        mapId: first.mapId, expectedRevision: revision, id: runId,
        targetId: first.claimId, mode: 'auto', configuration: verificationConfiguration(),
      })
      expect(result.status).toBe(200)
      return { ...first, runId, operationId: result.body.data.snapshot.run.operation.id }
    }

    const second = await startNext(completed.revision)
    const beforeReplay = await snapshot(first.mapId)
    expect((await propose(acceptedMerge, 'merge')).status).toBe(200)
    expect(await snapshot(first.mapId)).toEqual(beforeReplay)
    expect(beforeReplay.nodes).toHaveLength(2)
    expect(beforeReplay.edges).toHaveLength(1)

    await acceptRoute(second, slots)
    const unacceptedReport = await reportProposal(second, slots[0])
    const running = await snapshot(second.mapId)
    const cancelled = await command('run.cancel', {
      mapId: second.mapId, expectedRevision: running.revision, runId: second.runId,
    })
    expect(cancelled.status).toBe(200)
    await startNext(cancelled.body.data.snapshot.revision)
    const current = await snapshot(first.mapId)
    expectRejected(await propose(unacceptedReport, 'worker', slots[0].id))
    expect((await propose(acceptedMerge, 'merge')).status).toBe(200)
    expect(await snapshot(first.mapId)).toEqual(current)
  })

  it('returns the winning persisted result IDs for concurrent identical result approvals', async () => {
    const context = await startRun('human-in-loop')
    const slots = verificationSlots(1)
    await acceptRoute(context, slots)
    await answerReview(context)
    await submitReports(context, slots)
    expect((await propose(await mergeProposal(context), 'merge')).status).toBe(200)
    const waiting = await snapshot(context.mapId)
    const review = waiting.run.operation.review
    const body = {
      requestId: randomUUID(), method: 'review.answer',
      params: {
        mapId: context.mapId, expectedRevision: waiting.revision, runId: context.runId,
        reviewId: review.id, expectedReviewRevision: review.revision, decision: 'approve',
      },
    }

    const originalRead = graphStore.read
    let arrivals = 0
    let releaseReads!: () => void
    const bothHaveRead = new Promise<void>(resolve => { releaseReads = resolve })
    // Both requests still read Mongo; the barrier forces the losing CAS/replayed-receipt branch.
    graphStore.read = async (mapId) => {
      const document = await originalRead(mapId)
      if (mapId === context.mapId && document?.revision === waiting.revision && arrivals < 2) {
        arrivals++
        if (arrivals === 2) releaseReads()
        await bothHaveRead
      }
      return document
    }
    try {
      const replies = await Promise.all([post('/api/v1/command', body), post('/api/v1/command', body)])
      expect(arrivals).toBe(2)
      expect(replies.map(reply => reply.status)).toEqual([200, 200])
      expect(replies.map(reply => reply.body.replayed).sort()).toEqual([false, true])
      const winner = replies.find(reply => !reply.body.replayed)!.body.data
      expect(winner.createdNodeIds).toHaveLength(1)
      expect(winner.createdEdgeIds).toHaveLength(1)
      for (const reply of replies) {
        const data = reply.body.data
        expect(data.createdNodeIds).toEqual(winner.createdNodeIds)
        expect(data.createdEdgeIds).toEqual(winner.createdEdgeIds)
        expect(data.snapshot.nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining(data.createdNodeIds))
        expect(data.snapshot.edges.map((edge: { id: string }) => edge.id)).toEqual(expect.arrayContaining(data.createdEdgeIds))
      }
      const persisted = await snapshot(context.mapId)
      expect(persisted.nodes).toHaveLength(2)
      expect(persisted.edges).toHaveLength(1)
      expect(persisted.edges[0]).toMatchObject({ id: winner.createdEdgeIds[0], from: winner.createdNodeIds[0] })
    } finally {
      graphStore.read = originalRead
      releaseReads()
    }
  })

  it('fences late proposals after cancellation and does not revive the old Run identity', async () => {
    const context = await startRun()
    const slots = verificationSlots(1)
    await acceptRoute(context, slots)
    const lateReport = await reportProposal(context, slots[0])
    const lateMerge = await mergeProposal(context)
    const beforeCancel = await snapshot(context.mapId)
    expect(await command('run.cancel', {
      mapId: context.mapId, expectedRevision: beforeCancel.revision, runId: context.runId,
    })).toMatchObject({ status: 200, body: { data: { snapshot: { run: { status: 'cancelled' } } } } })
    expectRejected(await propose(lateReport, 'worker', slots[0].id))
    expectRejected(await propose(lateMerge, 'merge'))
    const terminal = await snapshot(context.mapId)
    expect(terminal.nodes).toHaveLength(1)
    expectRejected(await command('run.start', {
      mapId: context.mapId, expectedRevision: terminal.revision, id: context.runId,
      targetId: context.claimId, mode: 'auto', configuration: verificationConfiguration(),
    }))
    const nextRunId = randomUUID()
    const next = await command('run.start', {
      mapId: context.mapId, expectedRevision: terminal.revision, id: nextRunId,
      targetId: context.claimId, mode: 'auto', configuration: verificationConfiguration(),
    })
    expect(next).toMatchObject({ status: 200, body: { data: { snapshot: { run: { id: nextRunId } } } } })
    expect(next.body.data.snapshot.run.operation.id).not.toBe(context.operationId)
    const restarted = await snapshot(context.mapId)
    expectRejected(await propose(lateReport, 'worker', slots[0].id))
    expectRejected(await propose(lateMerge, 'merge'))
    expect(await snapshot(context.mapId)).toEqual(restarted)
  })
})
