// 通过真实认证 API 与 Mongo 事务验证分支独占、续租、接管和 Run 占有转换。
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { GraphBranchGrant, GraphRunControlGrant } from '../../../../contracts/graph-branch'
import type { GraphStore } from '../../../../backend/ports/graph-store'
import { graphCreateService } from '../../../../backend/modules/graph/graph-service'
import { clientCreateGateway } from '../../../../client/graph-client'
import { createGraphApi, FACT_TYPES, verificationPlan, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
enum MapActionTestMessage { FIXTURE_MISSING = 'Map action fixture missing' }
beforeAll(async () => { api = await createGraphApi(1_000) }, 60_000)
afterAll(async () => { await api?.close() })

function lease(grant: GraphBranchGrant) {
  return { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
}
function control(grant: GraphRunControlGrant) {
  return { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
}

async function createClaimRoot() {
  const workspace = await api.createWorkspace(), mapId = randomUUID(), rootId = randomUUID()
  expect((await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Lease' })).status).toBe(201)
  expect((await api.apply(mapId, [rootId], { nodes: { put: [{ id: rootId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version,
    payload: { content: 'Leased claim', category: null } }] } }, true)).status).toBe(200)
  return { mapId, rootId }
}

async function claim(mapId: string, rootIds: string[], holderId = randomUUID()): Promise<GraphBranchGrant> {
  const result = await api.command('branch.claim', { mapId, rootIds, holderId })
  expect(result).toMatchObject({ status: 200, body: { data: { status: 'claimed' } } })
  return result.body.data.grant
}

describe('branch edit leases', () => {
  it('refuses the combined relation scope while either endpoint is owned and permits it after release', async () => {
    // 即使来源节点空闲，引用终点的另一个有效持有者也阻止领取联合写入范围。
    const { mapId, rootId } = await createClaimRoot(), targetId = randomUUID(), edgeId = randomUUID()
    expect((await api.apply(mapId, [targetId], { nodes: { put: [{ id: targetId,
      typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Occupied target', category: null } }] } }, true)).status).toBe(200)
    const occupied = await claim(mapId, [targetId]), before = await api.snapshot(mapId)
    const roots = [rootId, targetId], holderId = randomUUID()
    expect(await api.command('branch.claim', { mapId, rootIds: roots, holderId }))
      .toMatchObject({ status: 200, body: { data: { status: 'busy', ownership: { leaseId: occupied.leaseId } } } })
    expect(await api.snapshot(mapId)).toEqual(before)
    expect((await api.command('branch.release', { mapId, lease: lease(occupied) })).status).toBe(200)
    const combined = await claim(mapId, roots, holderId)
    try {
      const branch = await api.branch(mapId, roots)
      expect(await api.command('graph.apply', { mapId, branch: { rootIds: roots, expectedVersion: branch.version }, lease: lease(combined),
        changes: { edges: { put: [{ id: edgeId, kind: 'reference', from: rootId, to: targetId }] } } }))
        .toMatchObject({ status: 200, body: { data: { snapshot: { nodes: before.nodes,
          edges: [{ id: edgeId, kind: 'reference', from: rootId, to: targetId }] } } } })
    } finally { await api.command('branch.release', { mapId, lease: lease(combined) }) }
  })

  it('requires all editor ownerships to be released before renaming or deleting a map', async () => {
    // 自己领取的分支也必须显式释放，不靠元数据操作悄悄撤销编辑权。
    const { mapId, rootId } = await createClaimRoot(), owned = await claim(mapId, [rootId])
    const before = await api.snapshot(mapId)
    for (const method of ['map.rename', 'map.delete']) {
      expect(await api.command(method, { mapId, expectedRevision: before.revision, ...(method === 'map.rename' ? { name: 'Blocked' } : {}) }))
        .toMatchObject({ status: 409, body: { error: { code: 'BRANCH_BUSY' } } })
    }
    expect(await api.snapshot(mapId)).toEqual(before)
    await api.command('branch.release', { mapId, lease: lease(owned) })
    expect(await api.command('map.rename', { mapId, expectedRevision: before.revision, name: 'Released' })).toMatchObject({ status: 200 })
    const current = await api.snapshot(mapId)
    expect(await api.command('map.delete', { mapId, expectedRevision: current.revision })).toMatchObject({ status: 200 })
  })

  it('keeps the existing ownership guard when a claim lands immediately before map actions commit', async () => {
    // 在真实存储提交前插入一次领取，确定性验证只变协调版本的竞争，避免时序循环或压测。
    for (const method of ['map.rename', 'map.delete'] as const) {
      const { mapId, rootId } = await createClaimRoot(), before = await api.store.read(mapId)
      if (!before) throw new Error(MapActionTestMessage.FIXTURE_MISSING)
      const definitions = await api.control.definitions(await api.auth.read(api.userToken), before.workspaceId)
      const context = { definitions, actorUserId: api.owner.userId }
      let claimed = false
      const store: GraphStore = { ...api.store, async commit(
        /* 已经完成元数据或删除检查的待提交图。 */ document,
        /* 本次命令检查时的内容版本。 */ expectedRevision,
        /* 将与图变更一起保存的原请求收据。 */ receipt,
        /* 普通图动作不传工作租约。 */ grant,
        /* 必须保留的协调版本提交守卫。 */ guard,
      ) {
        // 只在目标提交前领取一次分支，随后原样转交真实 CAS。
        if (!claimed) {
          claimed = true
          const claimResult = await graphCreateService(api.store).dispatch({ requestId: randomUUID(), method: 'branch.claim',
            params: { mapId, rootIds: [rootId], holderId: randomUUID() } }, context)
          expect(claimResult.data).toMatchObject({ status: 'claimed' })
        }
        return api.store.commit(document, expectedRevision, receipt, grant, guard)
      } }
      const params = { mapId, expectedRevision: before.revision }
      const command = method === 'map.rename'
        ? { requestId: randomUUID(), method, params: { ...params, name: 'Must not commit' } }
        : { requestId: randomUUID(), method, params }
      await expect(graphCreateService(store).dispatch(command, context)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      const after = await api.store.read(mapId)
      expect(after).toMatchObject({ name: before.name, revision: before.revision, ownershipRevision: (before.ownershipRevision ?? 0) + 1 })
      expect(after?.deletedAt).toBeUndefined()
      expect(after?.receipts).toEqual(before.receipts)
    }
  })

  it('makes overlapping clients read-only while disjoint branches remain independently claimable', async () => {
    const { mapId, rootId } = await createClaimRoot(), otherId = randomUUID(), childId = randomUUID()
    expect((await api.apply(mapId, [otherId], { nodes: { put: [{ id: otherId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version,
      payload: { content: 'Other', category: null } }] } }, true)).status).toBe(200)
    expect((await api.apply(mapId, [rootId], {
      nodes: { put: [{ id: childId, typeId: FACT_TYPES.opinion.id, typeVersion: FACT_TYPES.opinion.version,
        payload: { score: 1, reason: 'Child', evidenceClaimIds: [] } }] },
      edges: { put: [{ id: randomUUID(), kind: 'successor', from: rootId, to: childId }] },
    })).status).toBe(200)
    const before = await api.snapshot(mapId), first = await claim(mapId, [rootId], randomUUID())
    const afterClaim = await api.snapshot(mapId)
    expect(afterClaim.revision).toBe(before.revision)
    expect(afterClaim.ownershipRevision).toBeGreaterThan(before.ownershipRevision)
    const busy = await api.command('branch.claim', { mapId, rootIds: [rootId], holderId: randomUUID() })
    expect(busy).toMatchObject({ status: 200, body: { data: { status: 'busy', ownership: { leaseId: first.leaseId } } } })
    expect((await api.command('branch.claim', { mapId, rootIds: [childId], holderId: randomUUID() })).body.data.status).toBe('busy')
    expect((await api.command('branch.claim', { mapId, rootIds: [otherId], holderId: randomUUID() })).body.data.status).toBe('claimed')
  })

  it('requires the current holder/fence for writes and fences the old holder after release and takeover', async () => {
    const { mapId, rootId } = await createClaimRoot(), first = await claim(mapId, [rootId])
    const branch = await api.branch(mapId, [rootId])
    const without = await api.post('/api/v1/command', { requestId: randomUUID(), method: 'graph.apply', params: { mapId,
      branch: { rootIds: [rootId], expectedVersion: branch.version }, changes: { nodes: { put: [{
      id: rootId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'No lease', category: null },
    }] } } } })
    expect(without).toMatchObject({ status: 409, body: { error: { code: 'BRANCH_LEASE_REQUIRED' } } })
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [rootId], expectedVersion: branch.version }, lease: lease(first), changes: { nodes: { put: [{
      id: rootId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Owned write', category: null },
    }] } } })).status).toBe(200)
    const renewed = await api.command('branch.renew', { mapId, lease: lease(first) })
    expect(renewed).toMatchObject({ status: 200, body: { data: { leaseId: first.leaseId, fence: first.fence } } })
    expect((await api.command('branch.release', { mapId, lease: lease(first) })).status).toBe(200)
    const replacement = await claim(mapId, [rootId])
    expect(replacement.fence).toBeGreaterThan(first.fence)
    expect((await api.command('branch.renew', { mapId, lease: lease(first) })).body.error.code).toBe('BRANCH_LEASE_LOST')
    const current = await api.branch(mapId, [rootId])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [rootId], expectedVersion: current.version }, lease: lease(first),
      changes: { nodes: { put: [{ id: rootId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Stale', category: null } }] } } })).body.error.code).toBe('BRANCH_LEASE_LOST')
  })

  it('serializes renewal with a content write without losing either result', async () => {
    const { mapId, rootId } = await createClaimRoot(), grant = await claim(mapId, [rootId])
    const branch = await api.branch(mapId, [rootId])
    const [renewed, written] = await Promise.all([
      api.command('branch.renew', { mapId, lease: lease(grant) }),
      api.post('/api/v1/command', { requestId: randomUUID(), method: 'graph.apply', params: { mapId,
        branch: { rootIds: [rootId], expectedVersion: branch.version }, lease: lease(grant), changes: { nodes: { put: [{
          id: rootId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Concurrent renewal', category: null },
        }] } } } }),
    ])
    expect([renewed.status, written.status]).toEqual([200, 200])
    expect((await api.snapshot(mapId)).nodes.find((node: { id: string }) => node.id === rootId)?.payload.content).toBe('Concurrent renewal')
  })

  it('consumes the editor lease into persistent Run ownership and releases it on cancellation', async () => {
    const { mapId, rootId } = await createClaimRoot(), editor = await claim(mapId, [rootId])
    const branch = await api.branch(mapId, [rootId]), runId = randomUUID()
    expect((await api.command('run.start', { mapId, id: runId, branch: { rootIds: [rootId], expectedVersion: branch.version }, lease: lease(editor),
      scope: { nodeIds: [rootId] }, plan: verificationPlan([rootId]), mode: 'auto' })).status).toBe(200)
    const running = await api.snapshot(mapId)
    expect(running.ownerships).toContainEqual(expect.objectContaining({ kind: 'run', runId, rootIds: [rootId] }))
    expect((await api.command('branch.claim', { mapId, rootIds: [rootId], holderId: randomUUID() })).body.data.status).toBe('busy')
    expect((await api.command('run.cancel', { mapId, runId })).status).toBe(200)
    expect((await api.snapshot(mapId)).ownerships).toEqual([])
    expect((await api.command('branch.claim', { mapId, rootIds: [rootId], holderId: randomUUID() })).body.data.status).toBe('claimed')
  })

  it('fences Run controls independently and lets another client take over after release', async () => {
    const { mapId, rootId } = await createClaimRoot(), editor = await claim(mapId, [rootId])
    const branch = await api.branch(mapId, [rootId]), runId = randomUUID()
    const started = await api.command('run.start', { mapId, id: runId,
      branch: { rootIds: [rootId], expectedVersion: branch.version }, lease: lease(editor), scope: { nodeIds: [rootId] },
      plan: verificationPlan([rootId]), mode: 'auto' })
    expect(started.status).toBe(200)
    const first = started.body.data.runControl as GraphRunControlGrant
    expect(first).toMatchObject({ runId, holderId: editor.holderId, ownershipRevision: expect.any(Number) })
    expect((await api.snapshot(mapId)).runControls).toContainEqual(expect.objectContaining({ leaseId: first.leaseId, runId }))
    expect((await api.command('run.control.claim', { mapId, runId, holderId: randomUUID() })).body.data)
      .toMatchObject({ status: 'busy', control: { leaseId: first.leaseId } })
    const missing = await api.post('/api/v1/command', { requestId: randomUUID(), method: 'run.pause', params: { mapId, runId } })
    expect(missing).toMatchObject({ status: 409, body: { error: { code: 'RUN_CONTROL_LEASE_REQUIRED' } } })
    expect((await api.command('run.control.release', { mapId, runId, control: control(first) })).status).toBe(200)
    const replacementResult = await api.command('run.control.claim', { mapId, runId, holderId: randomUUID() })
    expect(replacementResult.body.data.status).toBe('claimed')
    const replacement = replacementResult.body.data.grant as GraphRunControlGrant
    expect(replacement.fence).toBeGreaterThan(first.fence)
    const stale = await api.post('/api/v1/command', { requestId: randomUUID(), method: 'run.pause', params: { mapId, runId, control: control(first) } })
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'RUN_CONTROL_LEASE_LOST' } } })
    const [renewed, paused] = await Promise.all([
      api.command('run.control.renew', { mapId, runId, control: control(replacement) }),
      api.command('run.pause', { mapId, runId, control: control(replacement) }),
    ])
    expect([renewed.status, paused.status]).toEqual([200, 200])
    expect((await api.command('run.cancel', { mapId, runId, control: control(replacement) })).status).toBe(200)
    const terminal = await api.snapshot(mapId)
    expect(terminal.runControls).toEqual([])
    expect(terminal.ownerships).toEqual([])
  })

  it('runs disjoint branches concurrently and controls each Run independently', async () => {
    const workspace = await api.createWorkspace(), mapId = randomUUID(), leftId = randomUUID(), rightId = randomUUID()
    expect((await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Parallel Runs' })).status).toBe(201)
    expect((await api.apply(mapId, [leftId], { nodes: { put: [{ id: leftId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version,
      payload: { content: 'Left', category: null } }] } }, true)).status).toBe(200)
    expect((await api.apply(mapId, [rightId], { nodes: { put: [{ id: rightId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version,
      payload: { content: 'Right', category: null } }] } }, true)).status).toBe(200)
    const prepare = async (rootId: string) => ({ rootId, branch: await api.branch(mapId, [rootId]), editor: await claim(mapId, [rootId]), runId: randomUUID() })
    const [leftInput, rightInput] = await Promise.all([prepare(leftId), prepare(rightId)])
    const [leftResult, rightResult] = await Promise.all([leftInput, rightInput].map(input => api.command('run.start', { mapId, id: input.runId,
      branch: { rootIds: [input.rootId], expectedVersion: input.branch.version }, lease: lease(input.editor), scope: { nodeIds: [input.rootId] },
      plan: verificationPlan([input.rootId]), mode: 'auto' })))
    expect([leftResult.status, rightResult.status]).toEqual([200, 200])
    const left = { runId: leftInput.runId, control: leftResult.body.data.runControl as GraphRunControlGrant }
    const right = { runId: rightInput.runId, control: rightResult.body.data.runControl as GraphRunControlGrant }
    const concurrent = await api.snapshot(mapId)
    expect(concurrent.runs.map((run: { id: string }) => run.id)).toEqual(expect.arrayContaining([left.runId, right.runId]))
    expect(concurrent.ownerships.filter((item: { kind: string }) => item.kind === 'run')).toHaveLength(2)
    const firstWork = (await api.claim(mapId, 'parallel-host', randomUUID(), 'route'))!
    const secondWork = (await api.claim(mapId, 'parallel-host', randomUUID(), 'route'))!
    expect(new Set([firstWork.runId, secondWork.runId])).toEqual(new Set([left.runId, right.runId]))
    expect((await api.command('run.pause', { mapId, runId: left.runId, control: control(left.control) })).status).toBe(200)
    const leftWork = firstWork.runId === left.runId ? firstWork : secondWork, rightWork = firstWork.runId === right.runId ? firstWork : secondWork
    expect(await api.store.readLease(mapId, leftWork)).toBeNull()
    expect(await api.store.readLease(mapId, rightWork)).not.toBeNull()
    const paused = await api.snapshot(mapId)
    expect(paused.runs.find((run: { id: string }) => run.id === left.runId).paused).toBe(true)
    expect(paused.runs.find((run: { id: string }) => run.id === right.runId).paused).toBe(false)
    expect((await api.command('run.cancel', { mapId, runId: left.runId, control: control(left.control) })).status).toBe(200)
    expect((await api.command('branch.claim', { mapId, rootIds: [leftId], holderId: randomUUID() })).body.data.status).toBe('claimed')
    expect((await api.command('branch.claim', { mapId, rootIds: [rightId], holderId: randomUUID() })).body.data.status).toBe('busy')
    expect((await api.command('run.cancel', { mapId, runId: right.runId, control: control(right.control) })).status).toBe(200)
  })

  it('streams ownership changes even when the content revision does not change', async () => {
    const { mapId, rootId } = await createClaimRoot(), gateway = clientCreateGateway({ baseUrl: api.url })
    await gateway.connect({ baseUrl: api.url, token: api.userToken, remember: false })
    const events: any[] = [], stop = new AbortController()
    const watching = gateway.watch(mapId, event => events.push(event), stop.signal).catch(error => {
      if (!stop.signal.aborted) throw error
    })
    try {
      const deadline = Date.now() + 10_000
      while (!events.some(event => event.type === 'snapshot') && Date.now() < deadline) await delay(20)
      const baseline = events.find(event => event.type === 'snapshot')?.snapshot
      if (!baseline) throw new Error('Ownership stream baseline missing')
      await claim(mapId, [rootId])
      while (!events.some(event => event.type === 'snapshot' && event.snapshot.ownershipRevision > baseline.ownershipRevision)
        && Date.now() < deadline) await delay(20)
      const owned = [...events].reverse().find(event => event.type === 'snapshot' && event.snapshot.ownershipRevision > baseline.ownershipRevision)?.snapshot
      expect(owned).toMatchObject({ revision: baseline.revision, ownerships: [{ kind: 'editor', rootIds: [rootId] }] })
    } finally { stop.abort(); await watching; await gateway.disconnect() }
  }, 15_000)
})
