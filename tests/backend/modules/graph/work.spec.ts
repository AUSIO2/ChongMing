// 验证通用 Agent Work 的领取竞争、续租、接管栅栏和取消。
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GraphWorkGrant } from '../../../../contracts/graph'
import { createGraphApi, expectRejected, proof, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi(2_000) }, 30_000)
afterAll(async () => { await api?.close() })

async function readyAssess(count = 2) {
  const context = await api.createRun(), planner = (await api.claim(context.mapId, 'planner', randomUUID(), 'route'))!
  const plan = await api.plan(planner, count)
  expect((await api.propose(planner, plan.proposal)).status).toBe(200)
  return context
}

async function claimAssess(mapId: string, hostId: string): Promise<GraphWorkGrant> {
  const grant = await api.claim(mapId, hostId, randomUUID(), 'assess')
  if (!grant) throw new Error('Expected assess grant')
  return grant
}

describe('Shared generic Work leases', () => {
  it('gives one holder the work, replays its claim and keeps lease-only changes outside the public revision', async () => {
    const context = await readyAssess(1), before = await api.snapshot(context.mapId)
    const work = (await api.store.read(context.mapId))!.runs[0].operations[0].stages.find(stage => stage.stageId === 'assess')!.expectedWorkIds[0]
    const input = { mapId: context.mapId, workId: work, deploymentId: api.application.messaging().deploymentId,
      hostId: 'owner', holderId: randomUUID() }
    const first = (await api.work('claim', input)).body.data
    expect(first).toMatchObject({ status: 'claimed', grant: { stageId: 'assess', fence: 1 } })
    expect((await api.work('claim', input)).body.data).toEqual(first)
    expect((await api.work('claim', { ...input, hostId: 'other', holderId: randomUUID() })).body.data).toMatchObject({ status: 'busy' })
    expect((await api.snapshot(context.mapId)).revision).toBe(before.revision)
  })

  it('claims independent slots concurrently and preserves a sibling heartbeat through a result commit', async () => {
    const context = await readyAssess(2)
    const [first, second] = await Promise.all([claimAssess(context.mapId, 'first'), claimAssess(context.mapId, 'second')])
    expect(first.workId).not.toBe(second.workId)
    await delay(80)
    const renewed = (await api.work('renew', proof(first))).body.data as GraphWorkGrant
    const proposal = await api.opinion(second, 1)
    expect((await api.propose(second, proposal)).status).toBe(200)
    const stored = (await api.store.read(context.mapId))!.leases[first.workId]
    expect(stored.fence).toBe(first.fence)
    expect(Date.parse(stored.expiresAt)).toBe(Date.parse(renewed.expiresAt))
  })

  it('takes over an expired work and rejects the old holder at read, renew and final proposal', async () => {
    const context = await readyAssess(1), old = await claimAssess(context.mapId, 'old')
    const proposal = await api.opinion(old)
    await delay(2_200)
    expectRejected(await api.work('renew', proof(old)))
    const replacement = await claimAssess(context.mapId, 'replacement')
    expect(replacement).toMatchObject({ workId: old.workId, fence: old.fence + 1 })
    expectRejected(await api.propose(old, proposal))
    expect((await api.propose(replacement, proposal)).status).toBe(200)
    expect((await api.store.read(context.mapId))!.receipts.filter(receipt => receipt.requestId === proposal.id)).toHaveLength(1)
  })

  it('lets release make unfinished work immediately claimable without allowing a stale release to revoke its replacement', async () => {
    const context = await readyAssess(1), first = await claimAssess(context.mapId, 'first')
    expect((await api.work('release', proof(first))).body.data.released).toBe(true)
    const second = await claimAssess(context.mapId, 'second')
    expect(second.fence).toBe(first.fence + 1)
    expect((await api.work('release', proof(first))).body.data.released).toBe(false)
    expect((await api.work('renew', proof(second))).status).toBe(200)
  })

  it('cancels every outstanding grant and refuses late proposals without turning cancellation into failure', async () => {
    const context = await readyAssess(2), first = await claimAssess(context.mapId, 'first'), second = await claimAssess(context.mapId, 'second')
    const proposal = await api.opinion(second)
    expect((await api.command('run.cancel', { mapId: context.mapId, runId: context.runId })).status).toBe(200)
    expectRejected(await api.work('renew', proof(first)))
    expectRejected(await api.propose(second, proposal))
    expectRejected(await api.work('fail', { ...proof(first), message: 'late failure' }))
    expect(await api.claim(context.mapId)).toBeNull()
    expect((await api.snapshot(context.mapId)).runs[0]).toMatchObject({ status: 'cancelled' })
  })
})
