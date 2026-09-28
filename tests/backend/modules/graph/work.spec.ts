// 验证工作租约的独占、续租、接管和最终提交隔离，以及终态下的重放确认。
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GraphWorkGrant } from '../../../../contracts/graph'
import { createGraphApi, expectRejected, proof, type TestGraphApi } from '../../fixtures/graph-api'
import { configuredSlots } from '../../fixtures/verification'

let api: TestGraphApi
beforeAll(async () => {
  // 启动使用短租约的真实图服务，以验证过期及接管行为。
  api = await createGraphApi(1500) }, 30_000)
afterAll(async () => {
  // 清理租约测试创建的服务和存储资源。
  await api?.close() })

async function readyWorkers(/* 路由应建立并进入可领取状态的 Worker 槽位数。 */ count: number) {
  // 建立自动运行并提交路由，使指定数量的报告槽位进入可领取状态。
  const context = await api.createRun()
  const router = (await api.claim(context.mapId, 'router-host'))!
  const proposal = await api.proposal(router, { kind: 'route', reason: 'Parallel evidence', slots: configuredSlots(context.configuration, count) })
  expect((await api.propose(router, proposal)).status).toBe(200)
  return context
}

function report(/* 需要生成稳定报告提案的 Worker 授权。 */ grant: GraphWorkGrant) {
  // 根据授权生成确定性报告，供接管和幂等重放用例复用同一提案。
  return api.proposal(grant, { kind: 'report', score: 1, reason: 'Stable evidence survives takeover' })
}

function pauseCommit(/* 要在最终提交前暂停一次的工作身份。 */ workId: string) {
  // 在最终存储提交前暂停指定工作一次，制造接管或取消与提交的竞争。
  const original = api.store.commit
  let enter!: () => void, release!: () => void, armed = true
  const entered = new Promise<void>(/* 存储提交到达断点时完成 entered Promise 的回调。 */ resolve => {
    // 保存提交到达检查点的通知，供用例等待精确竞争时机。
    enter = resolve })
  const resumed = new Promise<void>(/* 用例允许提交继续时完成 resumed Promise 的回调。 */ resolve => {
    // 保存恢复提交的回调，让用例先完成接管或状态改变。
    release = resolve })
  api.store.commit = async (/* 转发给真实图存储的待提交文档。 */ document, /* 转发给真实图存储的预期图版本。 */ revision, /* 转发给真实图存储的请求收据。 */ receipt, /* 转发给真实图存储、同时用于筛选暂停目标的可选授权。 */ grant) => {
    // 暂停目标授权的第一次提交，放行后仍调用真实存储提交以验证最终条件。
    if (armed && grant?.workId === workId) { armed = false; enter(); await resumed }
    return original(document, revision, receipt, grant)
  }
  return { entered, release, restore() {
    // 解除提交暂停并还原存储方法，避免钩子影响其他用例。
    release(); api.store.commit = original } }
}

describe('Shared Mongo work leases', () => {
  // 组织 Mongo 工作独占、续租、接管、重放和终态仲裁的回归场景。
  it('gives one holder the work, replays its claim, and keeps leases outside the public revision', async () => {
    // 验证并发领取只有一个持有者，同持有者可重放授权且租约不会推进公开图版本。
    const context = await api.createRun()
    const before = await api.snapshot(context.mapId)
    const ids = [randomUUID(), randomUUID()]
    const claims = await Promise.all(ids.map((/* 并发领取尝试使用的持有者身份。 */ holderId, /* 当前持有者在并发领取数组中的零基序号，用于生成 Host 身份。 */ index) => /* 用不同 Host 和 holder 身份并发争抢同一个待执行工作。 */ api.claim(context.mapId, `host-${index}`, holderId)))
    expect(claims.filter(Boolean)).toHaveLength(1)
    const grant = claims.find(Boolean)!
    expect(grant).toMatchObject({ mapId: context.mapId, runId: context.runId, actor: { role: 'router' }, fence: 1, leaseMs: 1500 })
    expect(await api.claim(context.mapId, grant.hostId, grant.holderId)).toEqual(grant)
    expect(await api.snapshot(context.mapId)).toEqual(before)
    expect(before).not.toHaveProperty('leases')
    expect((await api.store.read(context.mapId))!.leases[grant.workId]).toMatchObject(grant)
  })

  it('claims different slots in one Map and preserves a concurrent heartbeat through report CAS', async () => {
    // 验证两个 Host 可领取不同槽位，报告提交不会用旧快照覆盖另一槽位的续租。
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
    // 等待真实租约到期后接管未完成工作，验证旧持有者失效且已接纳提案仍可跨 fence 确认。
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
    expect(accepted.run.operations[0].reports).toHaveLength(2)
    expect((await api.propose(crashed, proposal)).status).toBe(200)
    expect(await api.snapshot(context.mapId)).toEqual(accepted)
  })

  it('confirms historical accepted work without reconstructing a deleted Claim or the previous Run input', async () => {
    // 删除旧输入并启动新 Run 后，验证旧工作仍可确认已接纳状态而不重建历史输入。
    const context = await readyWorkers(1)
    const worker = (await api.claim(context.mapId))!
    expect((await api.work('read', proof(worker))).body.data).toMatchObject({ workId: worker.workId, status: 'ready' })
    expect((await api.propose(worker, await report(worker))).status).toBe(200)
    const merger = (await api.claim(context.mapId))!
    const data = await api.read(merger)
    const proposal = await api.proposal(merger, { kind: 'merge', score: 1, reason: 'Accepted result',
      reportIds: data.reports.map((/* 汇总输入中当前提取身份的已接纳报告。 */ report: { id: string }) => /* 引用当前汇总输入中全部已接纳报告，构造合法终态结果。 */ report.id) })
    const accepted = await api.propose(merger, proposal)
    expect(accepted.status).toBe(200)
    const newClaimId = randomUUID()
    const edited = await api.command('graph.apply', { mapId: context.mapId, expectedRevision: accepted.body.data.revision,
      changes: { nodes: { remove: [context.claimId], put: [{ id: newClaimId, data: { kind: 'claim', content: 'New input', category: null } }] } },
    })
    expect(edited.status).toBe(200)
    expect((await api.command('run.start', { mapId: context.mapId, expectedRevision: edited.body.data.snapshot.revision,
      id: randomUUID(), scope: { nodeIds: [newClaimId] }, until: 'verified', regenerate: true, mode: 'auto' })).status).toBe(200)
    const current = await api.snapshot(context.mapId)
    expect((await api.work('read', proof(merger))).body.data).toEqual({ workId: merger.workId, status: 'accepted' })
    expect((await api.work('read', proof(worker))).body.data).toEqual({ workId: worker.workId, status: 'accepted' })
    expect(await api.snapshot(context.mapId)).toEqual(current)
  })

  it('checks the fixed fence at final commit even if a valid proposal was already being processed', async () => {
    // 让提案通过前置验证后发生接管，确认最终提交仍以原 fence 拒绝旧写入。
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
      expect((await api.snapshot(context.mapId)).run.operations[0].reports).toEqual([])
      expect((await api.propose(replacement, proposal)).status).toBe(200)
    } finally { pause.restore() }
  })

  it('lets cancellation fence an in-flight final commit without converting cancellation into failure', async () => {
    // 在报告最终提交前取消 Run，验证迟到报告和失败上报均不能覆盖取消状态。
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
      expect(cancelled.run.operations[0].reports).toEqual([])
      expect(cancelled.run.error).toBeUndefined()
      expect(await api.claim(context.mapId)).toBeNull()
    } finally { pause.restore() }
  })

  it('records ordinary work failure and rejects sibling writes, but accepted work cannot later fail the Run', async () => {
    // 验证普通失败终止运行并阻止兄弟工作迟到提交，而已成功工作不能事后使 Run 失败。
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
      expect(failed.run.operations[0].reports).toHaveLength(1)
      expect(await api.claim(context.mapId)).toBeNull()
    } finally { pause.restore() }
  })
})
