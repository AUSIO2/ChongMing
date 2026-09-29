// 验证通用阶段计划、Agent 产物发布和人工审核边界。
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GraphWorkGrant } from '../../../../contracts/graph'
import { createGraphApi, expectRejected, proof, verificationPlan, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi() }, 30_000)
afterAll(async () => { await api?.close() })

async function submitPlan(mapId: string, count: number) {
  const grant = (await api.claim(mapId, 'planner', randomUUID(), 'route'))!
  const built = await api.plan(grant, count), response = await api.propose(grant, built.proposal)
  expect(response.status).toBe(200)
  return { grant, ...built }
}

async function submitOpinions(mapId: string, count: number) {
  const grants: GraphWorkGrant[] = []
  for (let index = 0; index < count; index++) {
    const grant = (await api.claim(mapId, `agent-${index}`, randomUUID(), 'assess'))!
    grants.push(grant)
  }
  expect(await api.claim(mapId, 'extra', randomUUID(), 'assess')).toBeNull()
  const proposals = await Promise.all(grants.map((grant, index) => api.opinion(grant, index)))
  const results = await Promise.all(grants.map((grant, index) => api.propose(grant, proposals[index])))
  results.forEach(result => expect(result.status).toBe(200))
  return { grants, proposals }
}

async function submitVerification(mapId: string, score: 0 | 0.5 | 1 = 0.5) {
  const grant = (await api.claim(mapId, 'merger', randomUUID(), 'merge'))!
  const proposal = await api.verification(grant, score), result = await api.propose(grant, proposal)
  expect(result.status).toBe(200)
  return { grant, proposal }
}

describe('Generic staged Runs', () => {
  it.each([1, 3])('runs a dynamic %i-Agent plan and atomically publishes typed opinions and a verification', async count => {
    const context = await api.createRun()
    const routed = await submitPlan(context.mapId, count)
    expect((await api.snapshot(context.mapId)).runs[0].operations[0].stages.find((stage: { stageId: string }) => stage.stageId === 'assess'))
      .toMatchObject({ expectedWorkIds: expect.arrayContaining(routed.slots.map(slot => expect.any(String))), planSlots: routed.slots })
    await submitOpinions(context.mapId, count)
    await submitVerification(context.mapId, 0)
    const final = await api.snapshot(context.mapId)
    expect(final.runs[0]).toMatchObject({ status: 'completed', operations: [{ status: 'completed' }] })
    const opinions = final.nodes.filter((node: { typeId: string }) => node.typeId === 'factcheck.opinion')
    const verification = final.nodes.find((node: { typeId: string }) => node.typeId === 'factcheck.verification')
    expect(opinions).toHaveLength(count)
    expect(verification).toMatchObject({ payload: { score: 0, reason: 'Independent merger conclusion', opinionIds: opinions.map((node: { id: string }) => node.id) },
      producer: { stageId: 'merge' } })
    expect(final.edges.filter((edge: { to: string }) => edge.to === verification.id).map((edge: { from: string }) => edge.from)).toEqual(opinions.map((node: { id: string }) => node.id))
  })

  it('waits at plan and result Reviews, and replays an accepted Review request idempotently', async () => {
    const context = await api.createRun('human-in-loop')
    const routed = await submitPlan(context.mapId, 2)
    let waiting = await api.snapshot(context.mapId)
    expect(waiting.runs[0]).toMatchObject({ status: 'waiting', operations: [{ review: { kind: 'plan', state: 'pending' } }] })
    expect(await api.claim(context.mapId)).toBeNull()
    const planApproval = await api.answer(context.mapId)
    expect(planApproval.snapshot.runs[0].status).toBe('running')
    expect(planApproval.snapshot.runs[0].operations[0].stages.find((stage: { stageId: string }) => stage.stageId === 'assess').planSlots).toEqual(routed.slots)
    await submitOpinions(context.mapId, 2); await submitVerification(context.mapId)
    waiting = await api.snapshot(context.mapId)
    expect(waiting.runs[0]).toMatchObject({ status: 'waiting', operations: [{ review: { kind: 'result', state: 'pending' } }] })
    expect(waiting.nodes.filter((node: { typeId: string }) => node.typeId === 'factcheck.opinion')).toHaveLength(0)
    const resultApproval = await api.answer(context.mapId)
    expect(resultApproval.snapshot.runs[0].status).toBe('completed')
    expect(await api.post('/api/v1/command', resultApproval.body)).toMatchObject({ status: 200, body: { replayed: true } })
  })

  it('rejects plan slots outside the frozen Agent/tool contract without changing the operation', async () => {
    const context = await api.createRun(), grant = (await api.claim(context.mapId, 'planner', randomUUID(), 'route'))!
    const valid = await api.planSlots(grant, 1)
    for (const slots of [
      [{ ...valid[0], id: 'duplicate' }, { ...valid[0], id: 'duplicate' }],
      [{ ...valid[0], agentRef: { id: randomUUID(), version: 0 } }],
      [{ ...valid[0], tools: ['not-granted'] }],
    ]) {
      const proposal = await api.proposal(grant, { kind: 'plan', reason: 'Invalid plan', slots })
      expectRejected(await api.propose(grant, proposal))
    }
    const current = await api.snapshot(context.mapId)
    expect(current.runs[0].operations[0].stages.find((stage: { stageId: string }) => stage.stageId === 'route').results).toEqual([])
  })

  it('reuses a completed operation only when its frozen inputs and spec are unchanged', async () => {
    const context = await api.createRun()
    await submitPlan(context.mapId, 1); await submitOpinions(context.mapId, 1); await submitVerification(context.mapId)
    const completed = await api.snapshot(context.mapId), priorId = completed.runs[0].operations[0].id
    const nextId = randomUUID()
    const runBranch = await api.branch(context.mapId, [context.claimId])
    const replay = await api.command('run.start', { mapId: context.mapId, id: nextId,
      branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version }, scope: { nodeIds: [context.claimId] },
      plan: verificationPlan([context.claimId]), mode: 'auto' })
    expect(replay).toMatchObject({ status: 200, body: { data: { snapshot: { runs: [expect.objectContaining({ id: nextId, status: 'completed',
      operations: [expect.objectContaining({ reusedFromOperationId: priorId })] })] } } } })
    expect(await api.claim(context.mapId)).toBeNull()
  })
})
