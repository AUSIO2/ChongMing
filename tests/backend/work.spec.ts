import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GraphWorkGrant } from '../../contracts/graph'
import { createGraphApi, expectRejected, proof, type TestGraphApi } from './fixtures/graph-api'
import { configuredSlots } from './fixtures/verification'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi(1500) }, 30_000)
afterAll(async () => { await api?.close() })

async function readyWorkers(count: number) {
  const context = await api.createRun()
  const router = (await api.claim(context.mapId, 'router-host'))!
  const proposal = await api.proposal(router, { kind: 'route', reason: 'Parallel evidence', slots: configuredSlots(context.configuration, count) })
  expect((await api.propose(router, proposal)).status).toBe(200)
  return context
}

function report(grant: GraphWorkGrant) {
  return api.proposal(grant, { kind: 'report', score: 1, reason: 'Stable evidence survives takeover' })
}

function pauseCommit(workId: string) {
  const original = api.store.commit
  let enter!: () => void, release!: () => void, armed = true
  const entered = new Promise<void>(resolve => { enter = resolve })
  const resumed = new Promise<void>(resolve => { release = resolve })
  api.store.commit = async (document, revision, receipt, grant) => {
    if (armed && grant?.workId === workId) { armed = false; enter(); await resumed }
    return original(document, revision, receipt, grant)
  }
  return { entered, release, restore() { release(); api.store.commit = original } }
}

describe('Shared Mongo work leases', () => {
  it('gives one holder the work, replays its claim, and keeps leases outside the public revision', async () => {
    const context = await api.createRun()
    const before = await api.snapshot(context.mapId)
    const ids = [randomUUID(), randomUUID()]
    const claims = await Promise.all(ids.map((holderId, index) => api.claim(context.mapId, `host-${index}`, holderId)))
    expect(claims.filter(Boolean)).toHaveLength(1)
    const grant = claims.find(Boolean)!
    expect(grant).toMatchObject({ mapId: context.mapId, runId: context.runId, actor: { role: 'router' }, fence: 1, leaseMs: 1500 })
    expect(await api.claim(context.mapId, grant.hostId, grant.holderId)).toEqual(grant)
    expect(await api.snapshot(context.mapId)).toEqual(before)
    expect(before).not.toHaveProperty('leases')
    expect((await api.store.read(context.mapId))!.leases[grant.workId]).toMatchObject(grant)
  })

  it('claims different slots in one Map and preserves a concurrent heartbeat through report CAS', async () => {
    const context = await readyWorkers(2)
    const [a, b] = await Promise.all([api.claim(context.mapId, 'host-a'), api.claim(context.mapId, 'host-b')])
    expect(a!.actor.role).toBe('worker')
    expect(b!.actor.role).toBe('worker')
    expect(a!.workId).not.toBe(b!.workId)
    expect(await api.claim(context.mapId, 'host-c')).toBeNull()
    const proposal = await report(a!)
    const before = await api.snapshot(context.mapId)
    const [accepted, renewed] = await Promise.all([api.propose(a!, proposal), api.work('renew', proof(b!))])
    expect(accepted.status).toBe(200)
    expect(renewed.status).toBe(200)
    expect(renewed.body.data).toMatchObject({ workId: b!.workId, holderId: b!.holderId, fence: b!.fence })
    const document = (await api.store.read(context.mapId))!
    expect(document.leases[b!.workId]).toEqual(renewed.body.data)
    expect(document.revision).toBe(before.revision + 1)
    expect((await api.read(a!)).work.status).toBe('accepted')
    expect(await api.claim(context.mapId, 'host-c')).toBeNull()
    expect((await api.propose(b!, await report(b!))).status).toBe(200)
    expect((await api.claim(context.mapId))!.actor.role).toBe('merge')
  })

  it('takes over only unfinished work after real expiry and confirms accepted business replay across fences', async () => {
    const context = await readyWorkers(2)
    const first = (await api.claim(context.mapId, 'host-a'))!
    expect((await api.propose(first, await report(first))).status).toBe(200)
    const crashed = (await api.claim(context.mapId, 'host-crashed'))!
    const proposal = await report(crashed)
    await delay(crashed.leaseMs + 100)
    expectRejected(await api.work('renew', proof(crashed)))
    const replacement = (await api.claim(context.mapId, 'host-replacement'))!
    expect(replacement.workId).toBe(crashed.workId)
    expect(replacement.workId).not.toBe(first.workId)
    expect(replacement.fence).toBe(crashed.fence + 1)
    expect(replacement.holderId).not.toBe(crashed.holderId)
    expectRejected(await api.propose(crashed, proposal))
    expect((await api.work('release', proof(crashed))).body.data.released).toBe(false)
    expectRejected(await api.work('fail', { ...proof(crashed), message: 'Old process failure' }))
    expect((await api.snapshot(context.mapId)).run.status).toBe('running')
    expect((await api.propose(replacement, proposal)).status).toBe(200)
    const accepted = await api.snapshot(context.mapId)
    expect(accepted.run.operation.reports).toHaveLength(2)
    expect((await api.propose(crashed, proposal)).status).toBe(200)
    expect(await api.snapshot(context.mapId)).toEqual(accepted)
  })

  it('confirms historical accepted work without reconstructing a deleted Claim or the previous Run input', async () => {
    const context = await readyWorkers(1)
    const worker = (await api.claim(context.mapId))!
    expect((await api.work('read', proof(worker))).body.data).toMatchObject({ workId: worker.workId, status: 'ready' })
    expect((await api.propose(worker, await report(worker))).status).toBe(200)
    const merger = (await api.claim(context.mapId))!
    const data = await api.read(merger)
    const proposal = await api.proposal(merger, { kind: 'merge', score: 1, reason: 'Accepted result',
      reportIds: data.reports.map((report: { id: string }) => report.id) })
    const accepted = await api.propose(merger, proposal)
    expect(accepted.status).toBe(200)
    const newClaimId = randomUUID()
    const edited = await api.command('graph.apply', { mapId: context.mapId, expectedRevision: accepted.body.data.revision,
      changes: { nodes: { remove: [context.claimId], put: [{ id: newClaimId, data: { kind: 'claim', content: 'New input', category: null } }] } },
    })
    expect(edited.status).toBe(200)
    expect((await api.command('run.start', { mapId: context.mapId, expectedRevision: edited.body.data.snapshot.revision,
      id: randomUUID(), targetId: newClaimId, mode: 'auto' })).status).toBe(200)
    const current = await api.snapshot(context.mapId)
    expect((await api.work('read', proof(merger))).body.data).toEqual({ workId: merger.workId, status: 'accepted' })
    expect((await api.work('read', proof(worker))).body.data).toEqual({ workId: worker.workId, status: 'accepted' })
    expect(await api.snapshot(context.mapId)).toEqual(current)
  })

  it('checks the fixed fence at final commit even if a valid proposal was already being processed', async () => {
    const context = await readyWorkers(1)
    const old = (await api.claim(context.mapId, 'host-old'))!
    const proposal = await report(old)
    const pause = pauseCommit(old.workId)
    try {
      const late = api.propose(old, proposal)
      await pause.entered
      expect((await api.work('release', proof(old))).body.data.released).toBe(true)
      const replacement = (await api.claim(context.mapId, 'host-new'))!
      expect(replacement.fence).toBe(old.fence + 1)
      pause.release()
      expectRejected(await late)
      expect((await api.snapshot(context.mapId)).run.operation.reports).toEqual([])
      expect((await api.propose(replacement, proposal)).status).toBe(200)
    } finally { pause.restore() }
  })

  it('lets cancellation fence an in-flight final commit without converting cancellation into failure', async () => {
    const context = await readyWorkers(1)
    const grant = (await api.claim(context.mapId))!
    const proposal = await report(grant)
    const pause = pauseCommit(grant.workId)
    try {
      const late = api.propose(grant, proposal)
      await pause.entered
      const current = await api.snapshot(context.mapId)
      expect((await api.command('run.cancel', { mapId: context.mapId, expectedRevision: current.revision, runId: context.runId })).status).toBe(200)
      pause.release()
      expectRejected(await late)
      expectRejected(await api.work('renew', proof(grant)))
      expectRejected(await api.work('fail', { ...proof(grant), message: 'Cancellation is not an execution failure' }))
      const cancelled = await api.snapshot(context.mapId)
      expect(cancelled.run.status).toBe('cancelled')
      expect(cancelled.run.operation.reports).toEqual([])
      expect(cancelled.run.error).toBeUndefined()
      expect(await api.claim(context.mapId)).toBeNull()
    } finally { pause.restore() }
  })

  it('records ordinary work failure and rejects sibling writes, but accepted work cannot later fail the Run', async () => {
    const context = await readyWorkers(3)
    const acceptedGrant = (await api.claim(context.mapId, 'accepted-host'))!
    expect((await api.propose(acceptedGrant, await report(acceptedGrant))).status).toBe(200)
    expect((await api.work('fail', { ...proof(acceptedGrant), message: 'Runtime cleanup after success' })).body.data.failed).toBe(false)
    const failing = (await api.claim(context.mapId, 'failing-host'))!
    const sibling = (await api.claim(context.mapId, 'sibling-host'))!
    const proposal = await report(sibling)
    const pause = pauseCommit(sibling.workId)
    try {
      const late = api.propose(sibling, proposal)
      await pause.entered
      expect((await api.work('fail', { ...proof(failing), message: 'Provider returned an unrecoverable error' })).body.data.failed).toBe(true)
      pause.release()
      expectRejected(await late)
      expectRejected(await api.work('renew', proof(sibling)))
      const failed = await api.snapshot(context.mapId)
      expect(failed.run).toMatchObject({ status: 'failed', error: { workId: failing.workId, message: 'Provider returned an unrecoverable error' } })
      expect(failed.run.operation.reports).toHaveLength(1)
      expect(await api.claim(context.mapId)).toBeNull()
    } finally { pause.restore() }
  })
})
