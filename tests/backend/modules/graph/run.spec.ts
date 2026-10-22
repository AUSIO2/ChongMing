// 验证通用阶段计划、Agent 产物发布和人工审核边界。
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GraphQuery } from '../../../../contracts/graph-api'
import type { GraphRunControl, GraphRunControlProof } from '../../../../contracts/graph-branch'
import type { GraphOperation, GraphRun } from '../../../../contracts/graph-run'
import type { GraphWorkGrant } from '../../../../contracts/graph-work'
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

type PreviewQueryParams = Extract<GraphQuery, { method: 'run.publication.preview' }>['params']

/** 读取当前人工审核身份，避免预览与批准分别猜测版本。 */
async function readReview(
  /* 当前测试 Map 身份。 */ mapId: string,
  /* 当前人工审核 Run 身份。 */ runId: string,
): Promise<{ operation: GraphOperation; params: PreviewQueryParams }> {
  // 从真实快照固定同一待审核身份，供后续读取及提交复用。
  const snapshot = await api.snapshot(mapId)
  const run: GraphRun | undefined = snapshot.runs.find(
    /* 快照中的一个 Run，只取本用例启动的运行。 */ (item: GraphRun) => /* 按身份定位。 */ item.id === runId,
  )
  const operation = run?.operations.find(
    /* 当前 Run 中的一个 Operation。 */ item => /* 只取仍待回答的审核。 */ item.review?.state === 'pending',
  )
  if (!operation?.review) throw new Error('Fixture pending Review is missing')
  return { operation, params: { mapId, runId, operationId: operation.id, reviewId: operation.review.id,
    expectedReviewRevision: operation.review.revision } }
}

/** 复用默认核查夹具，准备两个意见与一个结论的待发布审核。 */
async function prepareResultReview() {
  // 先批准规划，再提交固定意见及引用它们的结论，全程走真实 HTTP 与存储。
  const context = await api.createRun('human-in-loop')
  await submitPlan(context.mapId, 2)
  await api.answer(context.mapId)
  await submitOpinions(context.mapId, 2)
  await submitVerification(context.mapId)
  return { ...context, ...await readReview(context.mapId, context.runId) }
}

/** 完成 A 后启动 B，使真实归档逻辑为目录准备两条记录。 */
async function prepareRunHistory() {
  // 复用确定性核查提案；没有外部模型或直接改写持久化记录。
  const context = await api.createRun()
  await submitPlan(context.mapId, 1)
  await submitOpinions(context.mapId, 1)
  await submitVerification(context.mapId)
  const branch = await api.branch(context.mapId, [context.claimId]), secondRunId = randomUUID()
  const started = await api.command('run.start', { mapId: context.mapId, id: secondRunId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, scope: { nodeIds: [context.claimId] },
    plan: verificationPlan([context.claimId]), regenerate: true, mode: 'auto' })
  expect(started.status).toBe(200)
  return { ...context, secondRunId }
}

/** 只保留公开控制证明，避免把授权元数据混入请求参数。 */
function controlProof(
  /* 从当前 Run 快照或领取响应取得的控制租约。 */ grant: GraphRunControlProof,
): GraphRunControlProof {
  // 控制证明只携带实际写入时需要核验的租约身份和栅栏。
  return { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
}

describe('Generic staged Runs', () => {
  it('finds completed A after starting B through a read-only HTTP history directory and exact Operation filter', async () => {
    // A 的归档不删除详情；列表只返回有界摘要，不领取控制或改变图收据。
    const context = await prepareRunHistory(), before = await api.store.read(context.mapId)
    const response = await api.post('/api/v1/query', { method: 'run.list', params: { mapId: context.mapId, limit: 1 } })
    expect(response).toMatchObject({ status: 200, body: { ok: true, data: { mapId: context.mapId,
      directoryVersion: expect.any(String), nextCursor: expect.any(String), items: [expect.objectContaining({
        runId: context.secondRunId, status: 'running', archived: false, stepCount: 1, operationCount: 1,
      })] } } })
    const second = await api.post('/api/v1/query', { method: 'run.list', params: { mapId: context.mapId, limit: 1,
      cursor: response.body.data.nextCursor } })
    expect(second).toMatchObject({ status: 200, body: { data: { nextCursor: null, items: [expect.objectContaining({
      runId: context.runId, status: 'completed', archived: true, pendingReviewCount: 0, outputCount: 2,
    })] } } })
    const filtered = await api.post('/api/v1/query', { method: 'run.list', params: { mapId: context.mapId, operationId: context.operationId } })
    expect(filtered).toMatchObject({ status: 200, body: { data: { items: [expect.objectContaining({ runId: context.runId })] } } })
    expect(filtered.body.data.items).toHaveLength(1)
    const detail = await api.post('/api/v1/query', { method: 'run.get', params: { mapId: context.mapId, runId: context.runId } })
    expect(detail).toMatchObject({ status: 200, body: { data: { id: context.runId, status: 'completed',
      operations: [expect.objectContaining({ id: context.operationId, outputRefs: expect.any(Array) })] } } })
    expect(detail.body.data.operations[0].outputRefs).toHaveLength(2)
    expect(await api.store.read(context.mapId)).toEqual(before)
  })

  it('authorizes every history page and denies revoked members, outsiders and deleted Maps', async () => {
    // 游标不是授权凭据；中途撤权后继续页仍须重新检查成员角色。
    const context = await prepareRunHistory()
    const viewer = await api.auth.createUser({ id: randomUUID(), displayName: 'History viewer', hostAdmin: false })
    const outsider = await api.auth.createUser({ id: randomUUID(), displayName: 'History outsider', hostAdmin: false })
    const viewerToken = (await api.auth.createToken(viewer.userId)).token
    const outsiderToken = (await api.auth.createToken(outsider.userId)).token
    const workspace = await api.post('/api/v1/query', { method: 'workspace.get', params: { workspaceId: context.workspaceId } })
    const member = await api.command('member.set', { workspaceId: context.workspaceId, expectedRevision: workspace.body.data.revision,
      userId: viewer.userId, role: 'viewer' })
    expect(member.status).toBe(200)
    const query = { method: 'run.list', params: { mapId: context.mapId, limit: 1 } }
    const first = await api.post('/api/v1/query', query, { authorization: `Bearer ${viewerToken}` })
    expect(first.status).toBe(200)
    expect(await api.post('/api/v1/query', query, { authorization: `Bearer ${outsiderToken}` })).toMatchObject({ status: 404 })
    const latestWorkspace = await api.post('/api/v1/query', { method: 'workspace.get', params: { workspaceId: context.workspaceId } })
    expect(await api.command('member.set', { workspaceId: context.workspaceId, expectedRevision: latestWorkspace.body.data.revision,
      userId: viewer.userId, role: null })).toMatchObject({ status: 200 })
    expect(await api.post('/api/v1/query', { ...query, params: { ...query.params, cursor: first.body.data.nextCursor } },
      { authorization: `Bearer ${viewerToken}` })).toMatchObject({ status: 404 })
    expect(await api.command('run.cancel', { mapId: context.mapId, runId: context.secondRunId })).toMatchObject({ status: 200 })
    const snapshot = await api.snapshot(context.mapId)
    expect(await api.command('map.delete', { mapId: context.mapId, expectedRevision: snapshot.revision })).toMatchObject({ status: 200 })
    expect(await api.post('/api/v1/query', query)).toMatchObject({ status: 404 })
  })

  it('validates HTTP history fields and distinguishes malformed or cross-query cursors', async () => {
    // Operation 身份沿用普通非空字符串；字段和游标不借宽松解析扩大合同。
    const context = await prepareRunHistory()
    for (const params of [{ mapId: context.mapId, limit: 0 }, { mapId: context.mapId, limit: 101 },
      { mapId: context.mapId, limit: 1.5 }, { mapId: context.mapId, limit: '1' },
      { mapId: context.mapId, extra: true }, { mapId: context.mapId, operationId: '' }]) {
      expect(await api.post('/api/v1/query', { method: 'run.list', params })).toMatchObject({ status: 400 })
    }
    expect(await api.post('/api/v1/query', { method: 'run.list', params: { mapId: context.mapId, operationId: 'plain-operation-id' } }))
      .toMatchObject({ status: 200, body: { data: { items: [] } } })
    const first = await api.post('/api/v1/query', { method: 'run.list', params: { mapId: context.mapId, limit: 1 } })
    expect(first.status).toBe(200)
    for (const params of [{ mapId: context.mapId, cursor: '*', limit: 1 },
      { mapId: context.mapId, cursor: 'a'.repeat(1025), limit: 1 },
      { mapId: context.mapId, cursor: first.body.data.nextCursor, limit: 2 }]) {
      expect(await api.post('/api/v1/query', { method: 'run.list', params }))
        .toMatchObject({ status: 400, body: { error: { code: 'INVALID_CURSOR' } } })
    }
  })

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

  it('previews the real publication closure over HTTP without changing the stored graph or coordination state', async () => {
    // 结论直接入选，两个被引用意见连带发布；读取不得增加收据、工作或控制租约。
    const context = await prepareResultReview()
    const before = await api.store.read(context.mapId)
    const first = await api.post('/api/v1/query', { method: 'run.publication.preview', params: context.params })
    expect(first).toMatchObject({ status: 200, body: { ok: true, data: { mapId: context.mapId, runId: context.runId,
      operationId: context.operationId, reviewId: context.params.reviewId,
      reviewRevision: context.params.expectedReviewRevision, specHash: context.operation.specHash,
      publicationVersion: expect.any(String) } } })
    const second = await api.post('/api/v1/query', { method: 'run.publication.preview', params: context.params })
    expect(second.status).toBe(200)
    expect(second.body.data).toEqual(first.body.data)
    expect(await api.store.read(context.mapId)).toEqual(before)
    const preview = first.body.data
    expect(preview.publicationVersion.length).toBeGreaterThan(0)
    expect(preview.ports).toEqual(expect.arrayContaining([
      { port: 'opinions', typeRef: { id: 'factcheck.opinion', version: 1 }, count: 2 },
      { port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 }, count: 1 },
    ]))
    expect(preview.ports).toHaveLength(2)
    const mergeResult = context.operation.stages.flatMap(
      /* 冻结 Operation 的一个执行阶段。 */ stage => /* 汇集已接纳结果。 */ stage.results,
    ).find(
      /* 一个已接纳阶段结果。 */ result => /* 定位最终结论的生产工作。 */ result.stageId === 'merge',
    )
    if (!mergeResult || mergeResult.mode !== 'outputs') throw new Error('Fixture merge result is missing')
    expect(preview.items).toHaveLength(3)
    expect(preview.items).toContainEqual({ workId: mergeResult.workId, key: 'verification', stageId: 'merge', slotId: mergeResult.slotId,
      port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 }, directlySelected: true, referencedBy: [] })
    for (const result of context.operation.stages.flatMap(
      /* 冻结 Operation 的一个执行阶段。 */ stage => /* 汇集供预览对齐的已接纳候选。 */ stage.results,
    )) {
      if (result.stageId !== 'assess' || result.mode !== 'outputs') continue
      for (const output of result.outputs) expect(preview.items).toContainEqual({ workId: result.workId, key: output.key,
        stageId: result.stageId, slotId: result.slotId, port: output.port, typeRef: output.typeRef, directlySelected: false,
        referencedBy: [{ workId: mergeResult.workId, key: 'verification' }] })
    }
    for (const item of preview.items) {
      expect(item).not.toHaveProperty('payload')
      expect(item).not.toHaveProperty('nodeId')
    }
  })

  it('atomically rejects a mismatched preview version, publishes the matching set and replays the accepted request', async () => {
    // 版本冲突不改变审核或图；成功后的原请求不再要求当前审核和控制租约仍有效。
    const context = await prepareResultReview()
    const response = await api.post('/api/v1/query', { method: 'run.publication.preview', params: context.params })
    expect(response.status).toBe(200)
    const before = await api.store.read(context.mapId)
    expect(await api.command('review.answer', { ...context.params, decision: 'approve', expectedPublicationVersion: 'stale-preview' }))
      .toMatchObject({ status: 409, body: { error: { code: 'PUBLICATION_PREVIEW_CONFLICT' } } })
    expect(await api.store.read(context.mapId)).toEqual(before)
    const control: GraphRunControl | undefined = context.snapshot.runControls.find(
      /* 启动快照里的一个控制租约。 */ (item: GraphRunControl) => /* 复用本次 Run 的原控制证明。 */ item.runId === context.runId,
    )
    if (!control) throw new Error('Fixture Run control is missing')
    const body = { requestId: randomUUID(), method: 'review.answer', params: { ...context.params, decision: 'approve',
      expectedPublicationVersion: response.body.data.publicationVersion, control: controlProof(control) } }
    const approved = await api.post('/api/v1/command', body)
    expect(approved).toMatchObject({ status: 200, body: { data: { snapshot: { runs: [expect.objectContaining({ status: 'completed' })] } } } })
    const operation: GraphOperation = approved.body.data.snapshot.runs[0].operations[0]
    const key = (
      /* 预览条目或正式发布引用中的同一候选身份。 */ item: { workId: string; key: string; port: string },
    ) => /* 比较集合身份，避免依赖物化节点编号或输出顺序。 */ `${item.workId}:${item.key}:${item.port}`
    expect(operation.outputRefs.map(key).sort()).toEqual(response.body.data.items.map(key).sort())
    expect(await api.post('/api/v1/command', body)).toMatchObject({ status: 200, body: { replayed: true } })
  })

  it('permits viewer previews but keeps membership, editor role and current Run control mandatory for approval', async () => {
    // 预览版本只是内容条件；知道版本不会取得成员资格、编辑权限或控制权。
    const context = await prepareResultReview()
    const viewer = await api.auth.createUser({ id: randomUUID(), displayName: 'Review viewer', hostAdmin: false })
    const outsider = await api.auth.createUser({ id: randomUUID(), displayName: 'Review outsider', hostAdmin: false })
    const viewerToken = (await api.auth.createToken(viewer.userId)).token
    const outsiderToken = (await api.auth.createToken(outsider.userId)).token
    const workspace = await api.post('/api/v1/query', { method: 'workspace.get', params: { workspaceId: context.workspaceId } })
    expect(await api.command('member.set', { workspaceId: context.workspaceId, expectedRevision: workspace.body.data.revision,
      userId: viewer.userId, role: 'viewer' })).toMatchObject({ status: 200 })
    const query = { method: 'run.publication.preview', params: context.params }
    const preview = await api.post('/api/v1/query', query, { authorization: `Bearer ${viewerToken}` })
    expect(preview.status).toBe(200)
    expect(await api.post('/api/v1/query', query, { authorization: `Bearer ${outsiderToken}` })).toMatchObject({ status: 404 })
    const first: GraphRunControl | undefined = context.snapshot.runControls.find(
      /* 启动快照里的一个控制租约。 */ (item: GraphRunControl) => /* 取得随后被释放的旧证明。 */ item.runId === context.runId,
    )
    if (!first) throw new Error('Fixture Run control is missing')
    const params = { ...context.params, decision: 'approve', expectedPublicationVersion: preview.body.data.publicationVersion }
    expect(await api.post('/api/v1/command', { requestId: randomUUID(), method: 'review.answer', params: { ...params, control: controlProof(first) } },
      { authorization: `Bearer ${viewerToken}` })).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } })
    expect(await api.post('/api/v1/command', { requestId: randomUUID(), method: 'review.answer', params }))
      .toMatchObject({ status: 409, body: { error: { code: 'RUN_CONTROL_LEASE_REQUIRED' } } })
    expect(await api.command('run.control.release', { mapId: context.mapId, runId: context.runId, control: controlProof(first) })).toMatchObject({ status: 200 })
    const replacement = await api.command('run.control.claim', { mapId: context.mapId, runId: context.runId, holderId: randomUUID() })
    expect(replacement).toMatchObject({ status: 200, body: { data: { status: 'claimed' } } })
    expect(await api.post('/api/v1/command', { requestId: randomUUID(), method: 'review.answer', params: { ...params, control: controlProof(first) } }))
      .toMatchObject({ status: 409, body: { error: { code: 'RUN_CONTROL_LEASE_LOST' } } })
    const current: GraphRunControl = replacement.body.data.grant
    expect(await api.post('/api/v1/command', { requestId: randomUUID(), method: 'review.answer', params: { ...params, control: controlProof(current) } }))
      .toMatchObject({ status: 200 })
  })

  it('validates preview parameters and rejects wrong, planned and terminal Reviews', async () => {
    // HTTP 边界限制字段与版本，业务读取只服务当前待结果审核。
    const context = await api.createRun('human-in-loop')
    await submitPlan(context.mapId, 1)
    const planned = await readReview(context.mapId, context.runId)
    expectRejected(await api.post('/api/v1/query', { method: 'run.publication.preview', params: planned.params }))
    await api.answer(context.mapId)
    await submitOpinions(context.mapId, 1)
    await submitVerification(context.mapId)
    const result = await readReview(context.mapId, context.runId)
    expect(await api.post('/api/v1/query', { method: 'run.publication.preview', params: result.params })).toMatchObject({ status: 200 })
    for (const invalid of [
      { ...result.params, expectedReviewRevision: -1 }, { ...result.params, expectedReviewRevision: 0.5 },
      { ...result.params, reviewId: '' }, { ...result.params, operationId: '' }, { ...result.params, extra: true },
    ]) expect(await api.post('/api/v1/query', { method: 'run.publication.preview', params: invalid })).toMatchObject({ status: 400 })
    for (const invalid of ['', 42, null, 'v'.repeat(2_049)]) {
      expect(await api.command('review.answer', { ...result.params, decision: 'approve', expectedPublicationVersion: invalid }))
        .toMatchObject({ status: 400 })
    }
    for (const wrong of [{ ...result.params, reviewId: randomUUID() },
      { ...result.params, expectedReviewRevision: result.params.expectedReviewRevision + 1 }]) {
      expect(await api.post('/api/v1/query', { method: 'run.publication.preview', params: wrong }))
        .toMatchObject({ status: 409, body: { error: { code: 'REVIEW_CONFLICT' } } })
    }
    for (const wrong of [{ ...result.params, operationId: randomUUID() }, { ...result.params, runId: randomUUID() }]) {
      expectRejected(await api.post('/api/v1/query', { method: 'run.publication.preview', params: wrong }))
    }
    await api.answer(context.mapId)
    expectRejected(await api.post('/api/v1/query', { method: 'run.publication.preview', params: result.params }))
  })

  it('keeps plan approval, result rejection and paused result approval compatible with preview conditions', async () => {
    // 可选内容条件仅约束新结果批准；原规划、拒绝以及暂停期间已有审核保持原语义。
    const rejected = await api.createRun('human-in-loop')
    await submitPlan(rejected.mapId, 1)
    const planReview = await readReview(rejected.mapId, rejected.runId)
    expect(await api.command('review.answer', { ...planReview.params, decision: 'approve', expectedPublicationVersion: 'ignored-for-plan' }))
      .toMatchObject({ status: 200 })
    await submitOpinions(rejected.mapId, 1)
    await submitVerification(rejected.mapId)
    const resultReview = await readReview(rejected.mapId, rejected.runId)
    expect(await api.command('review.answer', { ...resultReview.params, decision: 'reject', expectedPublicationVersion: 'ignored-for-reject' }))
      .toMatchObject({ status: 200, body: { data: { snapshot: { runs: [expect.objectContaining({ status: 'failed' })] } } } })
    const paused = await prepareResultReview()
    const before = await api.post('/api/v1/query', { method: 'run.publication.preview', params: paused.params })
    expect(before.status).toBe(200)
    expect(await api.command('run.pause', { mapId: paused.mapId, runId: paused.runId })).toMatchObject({ status: 200 })
    const after = await api.post('/api/v1/query', { method: 'run.publication.preview', params: paused.params })
    expect(after.status).toBe(200)
    expect(after.body.data).toEqual(before.body.data)
    expect(await api.command('review.answer', { ...paused.params, decision: 'approve', expectedPublicationVersion: after.body.data.publicationVersion }))
      .toMatchObject({ status: 200, body: { data: { snapshot: { runs: [expect.objectContaining({ status: 'completed', paused: true })] } } } })
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
