import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GraphWorkGrant } from '../../contracts/graph'
import { createGraphApi, expectRejected, grantHeaders, proof, type TestGraphApi } from './fixtures/graph-api'
import { verificationConfiguration, verificationSlots } from './fixtures/verification'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi() }, 30_000)
afterAll(async () => { await api?.close() })

async function route(mapId: string, count: number) {
  const grant = (await api.claim(mapId))!
  expect(grant.actor).toEqual({ role: 'router' })
  const proposal = await api.proposal(grant, { kind: 'route', reason: 'Select evidence angles', slots: verificationSlots(count) })
  const result = await api.propose(grant, proposal)
  expect(result.status).toBe(200)
  return { grant, proposal, snapshot: result.body.data }
}

async function workers(mapId: string, count: number) {
  const grants: GraphWorkGrant[] = []
  for (let index = 0; index < count; index++) {
    const grant = (await api.claim(mapId, `worker-${index}`))!
    expect(grant.actor.role).toBe('worker')
    grants.push(grant)
  }
  expect(await api.claim(mapId)).toBeNull()
  return grants
}

async function reports(grants: GraphWorkGrant[]) {
  const proposals = await Promise.all(grants.map((grant, index) => api.proposal(grant, {
    kind: 'report', score: index % 2 ? 0 : 1, reason: `Evidence from ${grant.actor.role === 'worker' ? grant.actor.slotId : '?'}`,
  })))
  const replies = await Promise.all(grants.map((grant, index) => api.propose(grant, proposals[index])))
  for (const reply of replies) expect(reply.status).toBe(200)
  return proposals
}

async function merge(mapId: string, score: 0 | 0.5 | 1 = 0.5) {
  const grant = (await api.claim(mapId))!
  expect(grant.actor.role).toBe('merge')
  const data = await api.read(grant)
  const proposal = await api.proposal(grant, {
    kind: 'merge', reportIds: data.reports.map((report: { id: string }) => report.id), score,
    reason: 'Independent merger conclusion, not a fixed vote formula',
  })
  const result = await api.propose(grant, proposal)
  expect(result.status).toBe(200)
  return { grant, proposal, snapshot: result.body.data }
}

describe('Dynamic verification with leased work', () => {
  it.each([1, 4])('accepts a dynamic %i-slot route and preserves opinions in the explicit merger result', async (count) => {
    const context = await api.createRun()
    const routed = await route(context.mapId, count)
    expect(routed.snapshot.run.operation.route).toMatchObject({ revision: 1, approved: true, slots: verificationSlots(count) })
    const grants = await workers(context.mapId, count)
    const proposals = await reports(grants)
    const before = await api.snapshot(context.mapId)
    expect(before.run.status).toBe('running')
    expect(before.nodes).toHaveLength(1)
    expect(before.run.operation.reports).toHaveLength(count)
    const completed = await merge(context.mapId, 0)
    expect(completed.snapshot.run.status).toBe('completed')
    const verification = completed.snapshot.nodes.find((node: { data: { kind: string } }) => node.data.kind === 'verification')
    expect(verification.data).toMatchObject({ score: 0, reason: completed.proposal.reason,
      reportIds: expect.arrayContaining(proposals.map(proposal => proposal.id)) })
    expect(verification.data.opinions).toHaveLength(count)
    for (const proposal of proposals) {
      const slot = verificationSlots(count).find(slot => slot.id === proposal.slotId)!
      expect(verification.data.opinions).toContainEqual(expect.objectContaining({
        id: proposal.id, slotId: slot.id, agentId: slot.agentId, agentName: `Custom ${slot.agentId}`,
        angle: slot.angle, tools: slot.tools, routeRevision: 1, score: proposal.score, reason: proposal.reason,
      }))
    }
    expect(completed.snapshot.edges).toContainEqual(expect.objectContaining({ kind: 'verifies', from: verification.id, to: context.claimId }))
    expect(await api.claim(context.mapId)).toBeNull()
  })

  it('waits at distinct route and result Reviews and replays accepted decisions without consuming the next Review', async () => {
    const context = await api.createRun('human-in-loop')
    const routed = await route(context.mapId, 3)
    expect(routed.snapshot.run.operation.review).toMatchObject({ kind: 'route', state: 'pending' })
    expect(await api.claim(context.mapId)).toBeNull()
    expect((await api.propose(routed.grant, routed.proposal)).status).toBe(200)
    expectRejected(await api.propose(routed.grant, { ...routed.proposal, reason: 'Changed accepted route' }))
    expectRejected(await api.command('graph.apply', { mapId: context.mapId, expectedRevision: routed.snapshot.revision, changes: { name: 'Blocked' } }))
    const approvedRoute = await api.answer(context.mapId)
    const grants = await workers(context.mapId, 3)
    const acceptedReports = await reports(grants)
    const merged = await merge(context.mapId)
    expect(merged.snapshot.run.operation.review).toMatchObject({ kind: 'result', state: 'pending' })
    expect(merged.snapshot.nodes).toHaveLength(1)
    expect(await api.claim(context.mapId)).toBeNull()
    expect((await api.post('/api/v1/command', approvedRoute.body)).body.replayed).toBe(true)
    expect((await api.propose(grants[0], acceptedReports[0])).status).toBe(200)
    expect((await api.propose(merged.grant, merged.proposal)).status).toBe(200)
    expect((await api.snapshot(context.mapId)).revision).toBe(merged.snapshot.revision)
    const approved = await api.answer(context.mapId)
    expect(approved.snapshot.run.status).toBe('completed')
    expect((await api.post('/api/v1/command', approved.body)).body.replayed).toBe(true)
    expect((await api.propose(merged.grant, merged.proposal)).status).toBe(200)
    expect(await api.snapshot(context.mapId)).toEqual(approved.snapshot)
  })

  it('edits a generated verification without losing reports, opinions or edges', async () => {
    const context = await api.createRun()
    await route(context.mapId, 3)
    await reports(await workers(context.mapId, 3))
    const completed = await merge(context.mapId)
    const original = completed.snapshot.nodes.find((node: { data: { kind: string } }) => node.data.kind === 'verification')
    const data = { ...original.data, reason: 'Human clarified the conclusion' }
    expect((await api.command('graph.apply', { mapId: context.mapId, expectedRevision: completed.snapshot.revision,
      changes: { nodes: { put: [{ id: original.id, data }] } },
    })).status).toBe(200)
    const edited = await api.snapshot(context.mapId)
    expect(edited.nodes.find((node: { id: string }) => node.id === original.id)).toMatchObject({ revision: original.revision + 1, data })
    expect(edited.edges).toEqual(completed.snapshot.edges)
    expect(edited.run).toEqual(completed.snapshot.run)
  })

  it('versions a human route edit before making the revised slots claimable', async () => {
    const context = await api.createRun('human-in-loop')
    const routed = await route(context.mapId, 3)
    const old = routed.snapshot.run.operation.review
    const slots = verificationSlots(1)
    slots[0].hint = 'Human-selected evidence'
    const updated = await api.command('review.update', {
      mapId: context.mapId, expectedRevision: routed.snapshot.revision, runId: context.runId,
      reviewId: old.id, expectedReviewRevision: old.revision, reason: 'One angle is sufficient', slots,
    })
    expect(updated.status).toBe(200)
    const current = updated.body.data.snapshot
    expect(current.run.operation.route).toMatchObject({ revision: 2, approved: false, slots })
    expect(await api.claim(context.mapId)).toBeNull()
    expectRejected(await api.command('review.answer', { mapId: context.mapId, expectedRevision: current.revision,
      runId: context.runId, reviewId: old.id, expectedReviewRevision: old.revision, decision: 'approve' }))
    await api.answer(context.mapId)
    const [grant] = await workers(context.mapId, 1)
    const proposal = await api.proposal(grant, { kind: 'report', score: 1, reason: 'Revised angle' })
    expect(proposal.routeRevision).toBe(2)
    expectRejected(await api.propose(grant, { ...proposal, routeRevision: 1 }))
    expect((await api.propose(grant, proposal)).status).toBe(200)
  })

  it('rejects invalid Agent/tool choices, duplicate slots and routes beyond the frozen limit', async () => {
    const context = await api.createRun('auto', verificationConfiguration(3))
    const grant = (await api.claim(context.mapId))!
    const valid = await api.proposal(grant, { kind: 'route', reason: 'Evidence angles', slots: verificationSlots(1) })
    const baseline = await api.snapshot(context.mapId)
    const slot = verificationSlots(1)[0]
    for (const slots of [[{ ...slot, agentId: 'unknown-agent' }], [{ ...slot, tools: ['unknown_tool'] }],
      [{ ...slot, tools: ['ledger_query'] }], [slot, slot], verificationSlots(4), []]) {
      expectRejected(await api.propose(grant, { ...valid, slots }))
      expect(await api.snapshot(context.mapId)).toEqual(baseline)
    }
    expect((await api.propose(grant, valid)).status).toBe(200)
  })

  it('requires a grant and derives actor identity from it instead of caller-supplied roles', async () => {
    const context = await api.createRun()
    const query = { mapId: context.mapId, operationId: context.operationId }
    expect((await api.post('/internal/v1/data/read', query)).status).toBe(401)
    expectRejected(await api.post('/internal/v1/data/read', query, {
      authorization: `Bearer ${api.token}`, 'x-dsh-role': 'router',
    }))
    const routed = await route(context.mapId, 3)
    const grants = await workers(context.mapId, 3)
    const first = await api.proposal(grants[0], { kind: 'report', score: 1, reason: 'Evidence' })
    const before = await api.snapshot(context.mapId)
    expectRejected(await api.propose(routed.grant, first))
    expectRejected(await api.propose(grants[1], first))
    expectRejected(await api.propose(grants[0], { ...first, agentId: 'forged-agent' }))
    expectRejected(await api.post('/internal/v1/data/propose', first, { authorization: 'Bearer wrong-token', ...grantHeaders(grants[0]) }))
    expect(await api.snapshot(context.mapId)).toEqual(before)
    expect((await api.propose(grants[0], first)).status).toBe(200)
    expectRejected(await api.propose(grants[1], first))
    expectRejected(await api.propose(routed.grant, first))
    expect((await api.snapshot(context.mapId)).run.operation.reports).toHaveLength(1)
  })

  it('does not offer merger work until all reports exist and validates its exact report set', async () => {
    const context = await api.createRun()
    await route(context.mapId, 3)
    const grants = await workers(context.mapId, 3)
    const first = await api.proposal(grants[0], { kind: 'report', score: 1, reason: 'First' })
    expectRejected(await api.propose(grants[0], { ...first, routeRevision: 0 }))
    expect((await api.propose(grants[0], first)).status).toBe(200)
    expect(await api.claim(context.mapId)).toBeNull()
    await reports(grants.slice(1))
    const grant = (await api.claim(context.mapId))!
    expect(grant.actor.role).toBe('merge')
    const data = await api.read(grant)
    const ids = data.reports.map((report: { id: string }) => report.id)
    const proposal = await api.proposal(grant, { kind: 'merge', score: 0.5, reason: 'Merged', reportIds: ids })
    const before = await api.snapshot(context.mapId)
    for (const reportIds of [ids.slice(1), [...ids, randomUUID()], [ids[0], ...ids]]) expectRejected(await api.propose(grant, { ...proposal, reportIds }))
    expectRejected(await api.propose(grant, { ...proposal, routeRevision: 0 }))
    expectRejected(await api.propose(grants[0], proposal))
    expect(await api.snapshot(context.mapId)).toEqual(before)
    expect((await api.propose(grant, proposal)).status).toBe(200)
  })

  it('keeps accepted proposal identities stable and rejects changed replays', async () => {
    const context = await api.createRun()
    await route(context.mapId, 3)
    const grants = await workers(context.mapId, 3)
    const proposal = await api.proposal(grants[0], { kind: 'report', score: 1, reason: 'Evidence' })
    expect((await api.read(grants[0])).proposalId).toBe(proposal.id)
    expect((await api.read(grants[1])).proposalId).not.toBe(proposal.id)
    expectRejected(await api.propose(grants[0], { ...proposal, id: randomUUID() }))
    expect((await api.propose(grants[0], proposal)).status).toBe(200)
    const accepted = await api.snapshot(context.mapId)
    expect((await api.propose(grants[0], proposal)).status).toBe(200)
    expectRejected(await api.propose(grants[0], { ...proposal, reason: 'Changed evidence' }))
    expect(await api.snapshot(context.mapId)).toEqual(accepted)
  })

  it('freezes configuration across separately claimed worker grants', async () => {
    const configuration = verificationConfiguration()
    const frozen = structuredClone(configuration)
    const context = await api.createRun('auto', configuration)
    configuration.agents[0].content = 'Later edits'
    configuration.agents[0].tools = []
    const routed = await route(context.mapId, 3)
    expect((await api.read(routed.grant)).configuration).toEqual(frozen)
    const grants = await workers(context.mapId, 3)
    for (const grant of grants) expect((await api.read(grant)).configuration).toEqual(frozen)
    const current = await api.snapshot(context.mapId)
    expectRejected(await api.command('run.start', { mapId: context.mapId, expectedRevision: current.revision,
      id: randomUUID(), targetId: context.claimId, mode: 'auto', configuration }))
  })

  it('confirms an accepted historical merge after a new Run starts without accepting unsubmitted old work', async () => {
    const first = await api.createRun()
    await route(first.mapId, 1)
    await reports(await workers(first.mapId, 1))
    const accepted = await merge(first.mapId)
    const nextId = randomUUID()
    expect((await api.command('run.start', { mapId: first.mapId, expectedRevision: accepted.snapshot.revision,
      id: nextId, targetId: first.claimId, mode: 'auto', configuration: verificationConfiguration() })).status).toBe(200)
    const beforeReplay = await api.snapshot(first.mapId)
    expect((await api.propose(accepted.grant, accepted.proposal)).status).toBe(200)
    expect(await api.snapshot(first.mapId)).toEqual(beforeReplay)
    await route(first.mapId, 1)
    const [unsubmitted] = await workers(first.mapId, 1)
    const proposal = await api.proposal(unsubmitted, { kind: 'report', score: 1, reason: 'Late' })
    const current = await api.snapshot(first.mapId)
    const cancelled = await api.command('run.cancel', { mapId: first.mapId, expectedRevision: current.revision, runId: nextId })
    expect(cancelled.status).toBe(200)
    expect((await api.command('run.start', { mapId: first.mapId, expectedRevision: cancelled.body.data.snapshot.revision,
      id: randomUUID(), targetId: first.claimId, mode: 'auto', configuration: verificationConfiguration() })).status).toBe(200)
    const newest = await api.snapshot(first.mapId)
    expectRejected(await api.propose(unsubmitted, proposal))
    expect((await api.propose(accepted.grant, accepted.proposal)).status).toBe(200)
    expect(await api.snapshot(first.mapId)).toEqual(newest)
  })

  it('returns the persisted winning IDs from concurrent identical result approvals', async () => {
    const context = await api.createRun('human-in-loop')
    await route(context.mapId, 1)
    await api.answer(context.mapId)
    await reports(await workers(context.mapId, 1))
    const merged = await merge(context.mapId)
    const review = merged.snapshot.run.operation.review
    const body = { requestId: randomUUID(), method: 'review.answer', params: { mapId: context.mapId,
      expectedRevision: merged.snapshot.revision, runId: context.runId, reviewId: review.id,
      expectedReviewRevision: review.revision, decision: 'approve' } }
    const originalRead = api.store.read
    let arrivals = 0, release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    api.store.read = async (mapId) => {
      const document = await originalRead(mapId)
      if (mapId === context.mapId && document?.revision === merged.snapshot.revision && arrivals < 2) {
        if (++arrivals === 2) release()
        await barrier
      }
      return document
    }
    try {
      const replies = await Promise.all([api.post('/api/v1/command', body), api.post('/api/v1/command', body)])
      expect(arrivals).toBe(2)
      expect(replies.map(reply => reply.status)).toEqual([200, 200])
      expect(replies.map(reply => reply.body.replayed).sort()).toEqual([false, true])
      const winner = replies.find(reply => !reply.body.replayed)!.body.data
      expect(winner.createdNodeIds).toHaveLength(1)
      expect(winner.createdEdgeIds).toHaveLength(1)
      for (const reply of replies) {
        expect(reply.body.data.createdNodeIds).toEqual(winner.createdNodeIds)
        expect(reply.body.data.createdEdgeIds).toEqual(winner.createdEdgeIds)
        expect(reply.body.data.snapshot.nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining(winner.createdNodeIds))
        expect(reply.body.data.snapshot.edges.map((edge: { id: string }) => edge.id)).toEqual(winner.createdEdgeIds)
      }
    } finally { api.store.read = originalRead; release() }
  })

  it('cancels outstanding grants and refuses to resurrect a used Run id', async () => {
    const context = await api.createRun()
    await route(context.mapId, 1)
    const [grant] = await workers(context.mapId, 1)
    const late = await api.proposal(grant, { kind: 'report', score: 1, reason: 'Late report' })
    const current = await api.snapshot(context.mapId)
    const cancelled = await api.command('run.cancel', { mapId: context.mapId, expectedRevision: current.revision, runId: context.runId })
    expect(cancelled.status).toBe(200)
    expectRejected(await api.propose(grant, late))
    expectRejected(await api.work('renew', proof(grant)))
    expect(await api.claim(context.mapId)).toBeNull()
    expectRejected(await api.command('run.start', { mapId: context.mapId, expectedRevision: cancelled.body.data.snapshot.revision,
      id: context.runId, targetId: context.claimId, mode: 'auto', configuration: verificationConfiguration() }))
  })
})
