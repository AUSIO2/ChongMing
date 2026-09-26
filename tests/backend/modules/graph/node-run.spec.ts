import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'
import type { GraphChanges, GraphEdgeInput, GraphNodeData, GraphOperation, GraphRun, GraphSnapshot, GraphWorkGrant } from '../../../../contracts/graph'
import { createGraphApi, expectRejected, proof, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi(60_000, DEFAULT_RUN_CONFIGURATION) }, 30_000)
afterAll(async () => { await api?.close() })

const news = (content: string) => ({ id: randomUUID(), data: { kind: 'news' as const, content, context: {} } })
const claim = (content: string) => ({ id: randomUUID(), data: { kind: 'claim' as const, content, category: null } })

async function createMap(nodes: NonNullable<GraphChanges['nodes']>['put'], edges: GraphEdgeInput[] = [], workspace?: { id: string; revision: number }) {
  const owner = workspace ?? await api.createWorkspace(DEFAULT_RUN_CONFIGURATION)
  const mapId = randomUUID()
  expect(await api.command('map.create', { workspaceId: owner.id, expectedRevision: owner.revision, id: mapId, name: 'Node closure' }))
    .toMatchObject({ status: 201 })
  expect(await api.command('graph.apply', { mapId, expectedRevision: 0, changes: { nodes: { put: nodes }, edges: { put: edges } } }))
    .toMatchObject({ status: 200 })
  return { mapId, workspaceId: owner.id }
}

async function start(mapId: string, nodeIds: string[], until: GraphRun['until'] = 'verified', mode: GraphRun['mode'] = 'auto'): Promise<GraphSnapshot> {
  const current = await api.snapshot(mapId)
  const result = await api.command('run.start', { mapId, expectedRevision: current.revision, id: randomUUID(), scope: { nodeIds }, until, mode })
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data.snapshot
}

function operation(snapshot: GraphSnapshot, targetId: string): GraphOperation {
  const found = snapshot.run!.operations.find(item => item.targetId === targetId)
  expect(found, `operation for ${targetId}`).toBeDefined()
  return found!
}

async function take(mapId: string, role: GraphWorkGrant['actor']['role'], operationId?: string) {
  const grant = await api.claim(mapId, randomUUID())
  expect(grant).toMatchObject({ actor: { role }, ...(operationId ? { operationId } : {}) })
  return grant!
}

function proposal(grant: GraphWorkGrant, input: Record<string, unknown>) {
  return { mapId: grant.mapId, operationId: grant.operationId, id: grant.workId,
    ...(grant.routeRevision ? { routeRevision: grant.routeRevision } : {}),
    ...(grant.actor.role === 'worker' ? { slotId: grant.actor.slotId } : {}), ...input }
}

async function accept(grant: GraphWorkGrant, input: Record<string, unknown>): Promise<GraphSnapshot> {
  const result = await api.propose(grant, proposal(grant, input))
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data
}

async function route(grant: GraphWorkGrant, count = 1) {
  const data = await api.read(grant)
  const agents = data.operationKind === 'split' ? data.configuration.split.agents : data.configuration.agents
  return accept(grant, { kind: 'route', reason: 'Independent node work',
    slots: agents.slice(0, count).map((agent: { id: string; tools: string[] }, index: number) => ({
      id: `angle-${index}`, agentId: agent.id, angle: `angle-${index}`, priority: 'medium', hint: '', tools: agent.tools,
    })) })
}

async function answer(mapId: string, operationId: string): Promise<GraphSnapshot> {
  const current: GraphSnapshot = await api.snapshot(mapId)
  const review = current.run!.operations.find(item => item.id === operationId)!.review!
  expect(review.state).toBe('pending')
  const result = await api.command('review.answer', { mapId, expectedRevision: current.revision, runId: current.run!.id,
    operationId, reviewId: review.id, expectedReviewRevision: review.revision, decision: 'approve' })
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data.snapshot
}

async function control(mapId: string, method: 'run.pause' | 'run.resume') {
  const current = await api.snapshot(mapId)
  const result = await api.command(method, { mapId, expectedRevision: current.revision, runId: current.run.id })
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data.snapshot as GraphSnapshot
}

function holdCommit(workId: string) {
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

describe('Node-driven shared Runs', () => {
  it('claims different news and facts, selects saved split candidates, and discovers every new Claim', async () => {
    const a = news('News A'), b = news('News B'), independent = claim('Independent fact')
    const { mapId } = await createMap([a, b, independent])
    const initial = await start(mapId, [a.id, b.id, independent.id])
    expect(initial.run!.operations.map(item => [item.kind, item.targetId])).toEqual([
      ['split', a.id], ['split', b.id], ['verify', independent.id],
    ])
    const grants = await Promise.all([api.claim(mapId, 'host-a'), api.claim(mapId, 'host-b'), api.claim(mapId, 'host-c')])
    expect(grants.every(Boolean)).toBe(true)
    expect(new Set(grants.map(item => item!.operationId))).toEqual(new Set(initial.run!.operations.map(item => item.id)))
    expect(await api.claim(mapId)).toBeNull()
    const splitId = operation(initial, a.id).id
    await route(grants.find(item => item!.operationId === splitId)!, 2)
    const first = await take(mapId, 'worker', splitId), second = await take(mapId, 'worker', splitId)
    await accept(first, { kind: 'split-report', reason: 'Two candidates', claims: [
      { content: 'Keep the first candidate', category: 'data' }, { content: 'Discard this candidate', category: 'quote' },
    ] })
    await accept(second, { kind: 'split-report', reason: 'Another source', claims: [{ content: 'Keep the second report', category: null }] })
    const merger = await take(mapId, 'merge', splitId)
    const merge = { kind: 'split-merge', reason: 'Select the two relevant claims', reportIds: [first.workId, second.workId],
      selected: [{ reportId: first.workId, index: 0 }, { reportId: second.workId, index: 0 }] }
    const before = await api.snapshot(mapId)
    expectRejected(await api.propose(merger, proposal(merger, { ...merge, selected: [{ reportId: first.workId, index: 99 }] })))
    expect(await api.snapshot(mapId)).toEqual(before)
    const accepted = await accept(merger, merge)
    const outputs = operation(accepted, a.id).outputRefs
    expect(outputs).toHaveLength(2)
    expect(outputs.map(ref => accepted.nodes.find(node => node.id === ref.id)!.data)).toEqual([
      { kind: 'claim', content: 'Keep the first candidate', category: 'data' },
      { kind: 'claim', content: 'Keep the second report', category: null },
    ])
    expect(accepted.edges.filter(edge => edge.kind === 'mentions' && edge.from === a.id).map(edge => edge.to)).toEqual(outputs.map(ref => ref.id))
    expect(accepted.run!.operations).toHaveLength(5)
    const descendants = await Promise.all([api.claim(mapId, 'host-d'), api.claim(mapId, 'host-e')])
    expect(new Set(descendants.map(item => item!.operationId))).toEqual(new Set(outputs.map(ref => operation(accepted, ref.id).id)))
    expect(await api.claim(mapId)).toBeNull()
  })

  it('keeps an independent news operation executable while another waits for Review', async () => {
    const a = news('Review A'), b = news('Review B')
    const { mapId } = await createMap([a, b])
    const initial = await start(mapId, [a.id, b.id], 'claims', 'human-in-loop')
    const first = await take(mapId, 'router', operation(initial, a.id).id)
    const waiting = await route(first)
    expect(operation(waiting, a.id).status).toBe('waiting')
    expect(waiting.run!.status).toBe('running')
    const second = await take(mapId, 'router', operation(initial, b.id).id)
    expect((await route(second)).run!.status).toBe('waiting')
    await answer(mapId, second.operationId)
    const worker = await take(mapId, 'worker', second.operationId)
    await accept(worker, { kind: 'split-report', reason: 'No checkable claims', claims: [] })
    const merger = await take(mapId, 'merge', second.operationId)
    await accept(merger, { kind: 'split-merge', reason: 'Accept an empty split', reportIds: [worker.workId], selected: [] })
    const finished = await answer(mapId, second.operationId)
    expect(operation(finished, b.id).status).toBe('completed')
    expect(operation(finished, a.id).review).toMatchObject({ kind: 'route', state: 'pending' })
    expect(finished.run!.status).toBe('waiting')
    expect(await api.claim(mapId)).toBeNull()
  })

  it('honors until and scope without expanding a shared Claim back into another news branch', async () => {
    const a = news('Selected news'), b = news('Other source'), shared = claim('Shared fact'), unrelated = claim('Unrelated fact')
    const { mapId } = await createMap([a, b, shared, unrelated], [
      { id: randomUUID(), kind: 'mentions', from: a.id, to: shared.id },
      { id: randomUUID(), kind: 'mentions', from: b.id, to: shared.id },
      { id: randomUUID(), kind: 'related-to', from: a.id, to: b.id },
    ])
    const newsOnly = await start(mapId, [a.id], 'news')
    expect(newsOnly.run).toMatchObject({ status: 'completed', operations: [] })
    expect(await api.claim(mapId)).toBeNull()
    const claimsOnly = await start(mapId, [a.id, shared.id], 'claims')
    expect(claimsOnly.run!.operations.map(item => item.targetId)).toEqual([a.id])
    const router = await take(mapId, 'router')
    await route(router)
    const worker = await take(mapId, 'worker')
    await accept(worker, { kind: 'split-report', reason: 'Only the existing fact applies', claims: [] })
    const merger = await take(mapId, 'merge')
    expect((await accept(merger, { kind: 'split-merge', reason: 'No additional facts', reportIds: [worker.workId], selected: [] })).run!.status)
      .toBe('completed')
    const verifying = await start(mapId, [a.id, shared.id])
    expect(verifying.run!.operations.map(item => [item.kind, item.targetId, item.status])).toEqual([
      ['split', a.id, 'completed'], ['verify', shared.id, 'running'],
    ])
    const verification = await take(mapId, 'router', operation(verifying, shared.id).id)
    const data = await api.read(verification)
    expect(new Set(data.context.map((item: { id: string }) => item.id))).toEqual(new Set([a.id, b.id]))
    expect(await api.claim(mapId)).toBeNull()
    await route(verification)
    const report = await take(mapId, 'worker')
    await accept(report, { kind: 'report', score: 1, reason: 'Verified shared fact' })
    const merge = await take(mapId, 'merge')
    const completed = await accept(merge, { kind: 'merge', reportIds: [report.workId], score: 1, reason: 'Accepted verification' })
    expect(completed.run!.status).toBe('completed')
    const replay = await start(mapId, [a.id, shared.id])
    expect(replay.run!.operations.every(item => item.status === 'completed')).toBe(true)
    expect(replay.nodes).toEqual(completed.nodes)
    expect(await api.claim(mapId)).toBeNull()
    const output = completed.nodes.find(node => node.data.kind === 'verification')!
    if (output.data.kind !== 'verification') throw new Error('Expected a verification output')
    expect(await api.command('graph.apply', { mapId, expectedRevision: replay.revision,
      changes: { nodes: { put: [{ id: output.id, data: { ...output.data, reason: 'User edited the result' } }] } } }))
      .toMatchObject({ status: 200 })
    expect(operation(await start(mapId, [a.id]), shared.id).status).toBe('running')
  })

  it.each(['parse', 'split'] as const)('persists an empty %s result and reuses it across new Runs', async kind => {
    const workspace = await api.createWorkspace(DEFAULT_RUN_CONFIGURATION)
    let input: { id: string; data: GraphNodeData } = news('Nothing to split')
    if (kind === 'parse') {
      const bytes = Buffer.from('No news content')
      const upload = await api.application.assets.upload(api.userToken, { workspaceId: workspace.id, filename: 'empty.txt',
        mediaType: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(),
      }, Readable.from([bytes]))
      input = { id: randomUUID(), data: { kind: 'source', label: 'Empty source',
        locator: { kind: 'asset', assetId: upload.data.id, mediaType: 'text/plain' } } }
    }
    const { mapId } = await createMap([input], [], workspace)
    await start(mapId, [input.id])
    let done: GraphSnapshot
    if (kind === 'parse') {
      const parser = await take(mapId, 'parse')
      expect((await api.read(parser)).rawContent).toBe('No news content')
      done = await accept(parser, { kind: 'parse', reason: 'No news found', news: [] })
    } else {
      await route(await take(mapId, 'router'))
      const worker = await take(mapId, 'worker')
      await accept(worker, { kind: 'split-report', reason: 'No claims found', claims: [] })
      done = await accept(await take(mapId, 'merge'), { kind: 'split-merge', reason: 'Accept empty result', reportIds: [worker.workId], selected: [] })
    }
    expect(done.run).toMatchObject({ status: 'completed', operations: [{ kind, status: 'completed', outputRefs: [] }] })
    const stored = await api.store.read(mapId)
    expect(stored!.receipts.some(item => item.method === `proposal.${kind === 'parse' ? 'parse' : 'split-merge'}`)).toBe(true)
    const again = await start(mapId, [input.id])
    expect(again.run!.id).not.toBe(done.run!.id)
    expect(again.run).toMatchObject({ status: 'completed', operations: [{ kind, status: 'completed', outputRefs: [] }] })
    expect(again.nodes).toEqual(done.nodes)
    expect(await api.claim(mapId)).toBeNull()
  })

  it('revokes unfinished grants across immediate resume and keeps accepted reports and pause replay idempotent', async () => {
    const target = claim('Pause this fact')
    const { mapId } = await createMap([target])
    await start(mapId, [target.id])
    await route(await take(mapId, 'router'), 2)
    const finished = await take(mapId, 'worker'), old = await take(mapId, 'worker')
    await accept(finished, { kind: 'report', score: 1, reason: 'Already accepted' })
    const late = proposal(old, { kind: 'report', score: 0.5, reason: 'Unfinished angle' })
    const before = await api.snapshot(mapId)
    const requestId = randomUUID(), params = { mapId, expectedRevision: before.revision, runId: before.run.id }
    const paused = await api.command('run.pause', params, requestId)
    expect(paused).toMatchObject({ status: 200, body: { data: { snapshot: { run: { paused: true } } } } })
    expect(await api.claim(mapId)).toBeNull()
    expect(await api.store.readLease(mapId, proof(old))).toBeNull()
    const resumed = await control(mapId, 'run.resume')
    const replacement = await take(mapId, 'worker', old.operationId)
    expect(replacement).toMatchObject({ workId: old.workId, fence: old.fence + 1 })
    expectRejected(await api.work('renew', proof(old)))
    expectRejected(await api.propose(old, late))
    expectRejected(await api.work('fail', { ...proof(old), message: 'Old worker must not fail the resumed Run' }))
    expect((await api.work('release', proof(old))).body.data.released).toBe(false)
    expect(await api.snapshot(mapId)).toEqual(resumed)
    expect(operation(resumed, target.id).reports.map(item => item.id)).toEqual([finished.workId])
    expect(await api.command('run.pause', params, requestId)).toMatchObject({ status: 200, body: { replayed: true } })
    expect(await api.snapshot(mapId)).toEqual(resumed)
    const accepted = await api.propose(replacement, late)
    expect(accepted.status).toBe(200)
    expect(operation(accepted.body.data, target.id).reports).toHaveLength(2)
  })

  it('lets a Review be approved while paused without allowing the operation to execute', async () => {
    const target = claim('Approve without resuming')
    const { mapId } = await createMap([target])
    const initial = await start(mapId, [target.id], 'verified', 'human-in-loop')
    const router = await take(mapId, 'router')
    await route(router)
    await control(mapId, 'run.pause')
    const answered = await answer(mapId, router.operationId)
    expect(answered.run).toMatchObject({ id: initial.run!.id, status: 'running', paused: true })
    expect(operation(answered, target.id).review).toMatchObject({ state: 'answered', decision: 'approve' })
    expect(await api.claim(mapId)).toBeNull()
    await control(mapId, 'run.resume')
    expect((await take(mapId, 'worker')).operationId).toBe(router.operationId)
  })

  it('fences an in-flight report even when pause and resume both finish before its commit', async () => {
    const target = claim('In-flight report')
    const { mapId } = await createMap([target])
    await start(mapId, [target.id])
    await route(await take(mapId, 'router'))
    const old = await take(mapId, 'worker')
    const data = proposal(old, { kind: 'report', score: 1, reason: 'Late report' })
    const held = holdCommit(old.workId)
    try {
      const pending = api.propose(old, data)
      await held.entered
      await control(mapId, 'run.pause')
      await control(mapId, 'run.resume')
      const replacement = await take(mapId, 'worker', old.operationId)
      held.release()
      expectRejected(await pending)
      const current = await api.snapshot(mapId)
      expect(operation(current, target.id).reports).toEqual([])
      expect(current.run.error).toBeUndefined()
      expect((await api.propose(replacement, data)).status).toBe(200)
    } finally { held.restore() }
  })

  it('rechecks current state before issuing a fresh grant after a pause/resume race', async () => {
    const target = claim('Fresh lease after resume')
    const { mapId } = await createMap([target])
    await start(mapId, [target.id])
    const original = api.store.claim
    let enter!: () => void, release!: () => void, first = true
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const attempts: Array<{ revision: number; claimed: boolean }> = []
    api.store.claim = async (...args) => {
      if (first && args[0].id === mapId) { first = false; enter(); await held }
      const result = await original(...args)
      if (args[0].id === mapId) attempts.push({ revision: args[0].revision, claimed: !!result })
      return result
    }
    try {
      const pending = api.claim(mapId, 'resumed-host')
      await entered
      await control(mapId, 'run.pause')
      await control(mapId, 'run.resume')
      const current = await api.snapshot(mapId)
      release()
      expect(await pending).toMatchObject({ hostId: 'resumed-host', fence: 1 })
      expect(attempts[0].claimed).toBe(false)
      expect(attempts.at(-1)).toEqual({ revision: current.revision, claimed: true })
    } finally { release(); api.store.claim = original }
  })

  it('rejects a stale claim while paused and permits fresh acquisition after resume', async () => {
    const target = claim('Stale claim snapshot')
    const { mapId } = await createMap([target])
    await start(mapId, [target.id])
    const original = api.store.claim
    let enter!: () => void, release!: () => void, armed = true
    const entered = new Promise<void>(resolve => { enter = resolve })
    const resumed = new Promise<void>(resolve => { release = resolve })
    api.store.claim = async (...args) => {
      if (armed && args[0].id === mapId) { armed = false; enter(); await resumed }
      return original(...args)
    }
    try {
      const pending = api.claim(mapId, 'stale-host')
      await entered
      await control(mapId, 'run.pause')
      release()
      expect(await pending).toBeNull()
      await control(mapId, 'run.resume')
      expect((await take(mapId, 'router')).hostId).not.toBe('stale-host')
    } finally { release(); api.store.claim = original }
  })
})
