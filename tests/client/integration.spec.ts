// 客户端闭环集成测试：通过真实认证后端和原生 DSH 验证通用定义、计划审核与类型化产物。
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientCreateGateway } from '../../client/graph-client'
import type { DefinitionCatalog, TransitionDefinition } from '../../contracts/data-definition'
import type { GraphNode, GraphSnapshot } from '../../contracts/graph'
import { graphCreateRunPlan } from '../../apps/ui/features/graph/graph-layout'
import { fixtureCreateEnvironment, type UiFixture } from './ui-fixture'

let fixture: UiFixture
let gateway: ReturnType<typeof clientCreateGateway>
let connection: { baseUrl: string; token: string; remember: boolean }

beforeAll(async () => {
  fixture = await fixtureCreateEnvironment()
  gateway = clientCreateGateway({ baseUrl: fixture.baseUrl, timeoutMs: 3000 })
  connection = { baseUrl: fixture.baseUrl, token: fixture.token, remember: false }
  await gateway.connect(connection)
}, 30_000)

afterAll(async () => {
  await gateway?.disconnect()
  await fixture?.close()
})

async function waitForMap(mapId: string, predicate: (snapshot: GraphSnapshot) => boolean, timeoutMs = 30_000): Promise<GraphSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last: GraphSnapshot | undefined
  while (Date.now() < deadline) {
    const snapshot = await gateway.read('map.get', { mapId })
    last = snapshot
    const failed = snapshot.runs.find(run => run.status === 'failed')
    if (failed) {
      const workId = failed.error?.workId
      const operation = failed.operations.find(item => item.stages.some(stage => stage.expectedWorkIds.includes(workId ?? '')))
      const group = operation?.stages.find(item => item.expectedWorkIds.includes(workId ?? ''))
      const stage = operation?.executionSpec.stages.find(item => item.id === group?.stageId)
      const slot = group?.planSlots.find(item => workId?.endsWith(`:${item.id}`)) ?? group?.planSlots[0]
      const agent = slot && failed.agents.find(item => item.ref.id === slot.agentRef.id && item.ref.version === slot.agentRef.version)
      const binding = { stageId: group?.stageId, templateAgent: stage?.agent.ref, slot, resolvedAgent: agent?.ref,
        resolvedProfile: agent?.profile.id, tools: slot?.tools, mode: stage?.outputContract.mode, hasPlan: !!stage?.plan }
      throw new Error(`Fixture Run failed: ${JSON.stringify(failed.error)}; binding=${JSON.stringify(binding)}; model=${JSON.stringify(fixture.modelCalls)}; runtime=${JSON.stringify(fixture.runtimeEvents.slice(-30))}; ${fixture.errors.join('; ')}`)
    }
    if (predicate(snapshot)) return snapshot
    await delay(50)
  }
  const progress = last?.runs.flatMap(run => run.operations).map(operation => ({ status: operation.status, review: operation.review,
    stages: operation.stages.map(stage => ({ id: stage.stageId, expected: stage.expectedWorkIds.length, results: stage.results.length, closed: stage.closed })) }))
  throw new Error(`Client polling did not reach its business boundary: progress=${JSON.stringify(progress)}; model=${JSON.stringify(fixture.modelCalls)}; ${fixture.errors.join('; ')}`)
}

function readTransition(catalog: DefinitionCatalog, id: string): TransitionDefinition {
  const transition = catalog.transitions.find(item => item.id === id && item.version === 1)
  if (!transition) throw new Error(`Missing transition ${id}@1`)
  return transition
}

async function createMap(name: string): Promise<GraphSnapshot> {
  const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
  return (await gateway.dispatch(randomUUID(), 'map.create', {
    workspaceId: workspace.id, expectedRevision: workspace.revision, id: randomUUID(), name,
  })).data.snapshot
}

async function putNode(snapshot: GraphSnapshot, node: Pick<GraphNode, 'id' | 'typeId' | 'typeVersion' | 'payload'>): Promise<GraphSnapshot> {
  return (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: snapshot.mapId, branch: { rootIds: [node.id], expectedVersion: null },
    changes: { nodes: { put: [node] } } })).data.snapshot
}

async function runBranch(mapId: string, rootIds: string[]) {
  const branch = await gateway.read('branch.get', { mapId, rootIds })
  const claimed = await gateway.dispatch(randomUUID(), 'branch.claim', { mapId, rootIds: branch.scope.rootIds, holderId: randomUUID() })
  if (claimed.data.status !== 'claimed') throw new Error('Integration branch is busy')
  return { branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    lease: { leaseId: claimed.data.grant.leaseId, holderId: claimed.data.grant.holderId, fence: claimed.data.grant.fence } }
}

describe('real client, generic definitions and native DSH', () => {
  it('connects, freezes a registered verification transition and publishes traceable typed outputs after both reviews', async () => {
    const bootstrap = await gateway.connect(connection)
    expect(bootstrap.identity).toEqual(fixture.identity)
    await expect(gateway.connect({ ...connection, token: 'invalid-token' })).rejects.toMatchObject({ status: 401 })
    expect(await gateway.getConnection()).toMatchObject({ configured: false })
    await gateway.connect(connection)

    const definitions = await gateway.read('definition.get', { workspaceId: fixture.workspaceId })
    expect(definitions.catalog.dataTypes.map(item => item.id)).toEqual(expect.arrayContaining(['factcheck.claim', 'factcheck.opinion', 'factcheck.verification']))
    const verify = readTransition(definitions.catalog, 'factcheck.verify-claim')
    let snapshot = await createMap('通用核查闭环')
    const claimId = randomUUID(), runId = randomUUID()
    snapshot = await putNode(snapshot, { id: claimId, typeId: 'factcheck.claim', typeVersion: 1,
      payload: { content: '这条消息中的关键事实需要独立核查。', category: 'data' } })
    const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId: snapshot.mapId, id: runId, ...await runBranch(snapshot.mapId, [claimId]), scope: { nodeIds: [claimId] },
      plan: graphCreateRunPlan(verify, [claimId]), mode: 'human-in-loop' })
    if (!started.data.runControl) throw new Error('Run control missing')
    let control = { leaseId: started.data.runControl.leaseId, holderId: started.data.runControl.holderId, fence: started.data.runControl.fence }

    const planned = await waitForMap(snapshot.mapId, value => value.runs.find(run => run.id === runId)?.operations.some(operation => operation.review?.kind === 'plan') === true)
    const planRun = planned.runs.find(run => run.id === runId)!
    const planOperation = planRun.operations.find(operation => operation.review?.kind === 'plan')!
    const planResult = planOperation.stages.flatMap(stage => stage.results).find(result => result.mode === 'plan')
    expect(planResult).toMatchObject({ mode: 'plan', plan: { approved: false, slots: expect.any(Array) } })
    if (!planResult || planResult.mode !== 'plan') throw new Error('Plan result missing')
    expect(planResult.plan.slots).toHaveLength(3)
    expect(fixture.modelCalls.some(call => call.role === 'worker')).toBe(false)

    const paused = await gateway.dispatch(randomUUID(), 'run.pause', { mapId: snapshot.mapId, runId, control })
    const pausedRun = paused.data.snapshot.runs.find(run => run.id === runId)!
    expect(pausedRun.paused).toBe(true)
    const review = pausedRun.operations.find(operation => operation.id === planOperation.id)!.review!
    const approvedPlan = await gateway.dispatch(randomUUID(), 'review.answer', { mapId: snapshot.mapId, runId, operationId: planOperation.id,
      reviewId: review.id, expectedReviewRevision: review.revision, decision: 'approve', control })
    expect(approvedPlan.data.snapshot.runs.find(run => run.id === runId)?.paused).toBe(true)
    await gateway.dispatch(randomUUID(), 'run.resume', { mapId: snapshot.mapId, runId, control })

    const proposed = await waitForMap(snapshot.mapId, value => value.runs.find(run => run.id === runId)?.operations.some(operation => operation.review?.kind === 'result') === true, 35_000)
    const resultOperation = proposed.runs.find(run => run.id === runId)!.operations.find(operation => operation.review?.kind === 'result')!
    const assessOutputs = resultOperation.stages.find(stage => stage.stageId === 'assess')!.results.flatMap(result => result.mode === 'outputs' ? result.outputs : [])
    expect(assessOutputs).toHaveLength(3)
    expect(proposed.nodes.some(node => node.typeId === 'factcheck.opinion' || node.typeId === 'factcheck.verification')).toBe(false)
    const resultReview = resultOperation.review!
    const renewed = await gateway.dispatch(randomUUID(), 'run.control.renew', { mapId: snapshot.mapId, runId, control })
    control = { leaseId: renewed.data.leaseId, holderId: renewed.data.holderId, fence: renewed.data.fence }
    const requestId = randomUUID()
    const answer = { mapId: snapshot.mapId, runId, operationId: resultOperation.id, reviewId: resultReview.id,
      expectedReviewRevision: resultReview.revision, decision: 'approve' as const, control }
    const accepted = await gateway.dispatch(requestId, 'review.answer', answer)
    expect(accepted.data.snapshot.runs.find(run => run.id === runId)?.status).toBe('completed')
    expect((await gateway.dispatch(requestId, 'review.answer', answer)).replayed).toBe(true)

    const final = await gateway.read('map.get', { mapId: snapshot.mapId })
    const opinions = final.nodes.filter(node => node.typeId === 'factcheck.opinion')
    const verification = final.nodes.find(node => node.typeId === 'factcheck.verification')!
    expect(opinions).toHaveLength(3)
    expect(verification.payload).toMatchObject({ score: 0.5, opinionIds: opinions.map(node => node.id) })
    expect(final.edges.filter(edge => edge.kind === 'successor' && edge.to === verification.id).map(edge => edge.from)).toEqual(opinions.map(node => node.id))
    expect(opinions.every(node => final.edges.some(edge => edge.kind === 'successor' && edge.from === claimId && edge.to === node.id))).toBe(true)
    expect(verification.producer).toMatchObject({ transitionRef: { id: verify.id, version: verify.version }, stageId: 'merge', agentName: expect.any(String) })
    expect(new Set(fixture.modelCalls.filter(call => call.role === 'worker').map(call => call.sessionId)).size).toBe(3)
    expect(fixture.errors).toEqual([])
  }, 80_000)

  it('runs source parsing and news splitting as two independently selected registered transitions', async () => {
    const definitions = await gateway.read('definition.get', { workspaceId: fixture.workspaceId })
    const parse = readTransition(definitions.catalog, 'factcheck.parse-source')
    const split = readTransition(definitions.catalog, 'factcheck.split-news')
    let snapshot = await createMap('通用解析与拆分')
    const sourceId = randomUUID()
    snapshot = await putNode(snapshot, { id: sourceId, typeId: 'factcheck.source', typeVersion: 1,
      payload: { locator: { kind: 'url', url: fixture.sourceUrl }, label: '本机来源' } })
    await gateway.dispatch(randomUUID(), 'run.start', { mapId: snapshot.mapId, id: randomUUID(), ...await runBranch(snapshot.mapId, [sourceId]), scope: { nodeIds: [sourceId] },
      plan: graphCreateRunPlan(parse, [sourceId]), mode: 'auto' })
    const parsed = await waitForMap(snapshot.mapId, value => value.runs.some(run => run.status === 'completed'))
    const news = parsed.nodes.find(node => node.typeId === 'factcheck.news')!
    expect(news.payload).toMatchObject({ content: expect.stringContaining('本机来源'), context: expect.any(Object) })
    expect(parsed.edges).toContainEqual(expect.objectContaining({ kind: 'successor', from: sourceId, to: news.id }))

    await gateway.dispatch(randomUUID(), 'run.start', { mapId: snapshot.mapId, id: randomUUID(), ...await runBranch(snapshot.mapId, [news.id]), scope: { nodeIds: [news.id] },
      plan: graphCreateRunPlan(split, [news.id]), mode: 'auto' })
    const claims = await waitForMap(snapshot.mapId, value => value.runs.some(run => run.status === 'completed') && value.nodes.some(node => node.typeId === 'factcheck.claim'), 40_000)
    expect(claims.nodes.filter(node => node.typeId === 'factcheck.claim')).toHaveLength(2)
    expect(claims.edges.filter(edge => edge.kind === 'successor' && edge.from === news.id)).toHaveLength(2)
    expect(claims.nodes.filter(node => node.typeId === 'factcheck.claim').every(node => node.producer?.transitionRef.id === split.id)).toBe(true)
    expect(fixture.errors).toEqual([])
  }, 60_000)

  it('surfaces real token revocation and clears the client connection on disconnect', async () => {
    await fixture.application.auth.revokeToken(fixture.tokenId)
    await expect(gateway.read('workspace.list', {})).rejects.toMatchObject({ status: 401 })
    await gateway.disconnect()
    expect(await gateway.getConnection()).toMatchObject({ configured: false, remembered: false })
  })
})
