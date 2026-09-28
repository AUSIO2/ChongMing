// 客户端闭环集成测试：通过真实认证后端和原生 DSH 验证审核、产物复用与令牌撤销。
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientCreateGateway } from '../../client/graph-client'
import type { GraphSnapshot } from '../../contracts/graph'
import { fixtureCreateEnvironment, type UiFixture } from './ui-fixture'

let fixture: UiFixture
let gateway: ReturnType<typeof clientCreateGateway>

beforeAll(async () => {
  // 启动真实后端和本机 DSH 验收环境，并建立客户端网关。
  fixture = await fixtureCreateEnvironment()
  gateway = clientCreateGateway({ baseUrl: fixture.baseUrl, timeoutMs: 3000 })
}, 30_000)

afterAll(async () => {
  // 测试结束后退出网关并释放后端、Host 和临时资源。
  await gateway?.disconnect()
  await fixture?.close()
})

async function waitForMap(
  /* 本轮验收创建的目标图身份，用于重复读取同一图。 */ mapId: string,
  /* 只读快照判定函数，返回 true 表示到达用例要求的业务边界。 */ predicate: (
    /* 每轮从真实后端读取的完整图快照，交给用例检查运行或审核状态。 */ snapshot: GraphSnapshot
  ) => boolean,
  /* 等待业务边界的最长毫秒数，默认 20000。 */ timeoutMs = 20_000
) {
  // 轮询图快照直到满足业务条件；运行失败或超时则报告验收错误。
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await gateway.read('map.get', { mapId })
    if (snapshot.run?.status === 'failed') throw new Error(`Fixture Run failed: ${JSON.stringify(snapshot.run.error)}; ${fixture.errors.join('; ')}`)
    if (predicate(snapshot)) return snapshot
    await delay(50)
  }
  throw new Error('Client polling did not reach its business boundary')
}

describe('Real client, authenticated backend and native DSH', () => {
  // 覆盖真实认证客户端到后端和原生 DSH 的完整处理闭环。
  it('connects, creates a Claim, answers both Reviews and reads a traceable verification', async () => {
    // 验证登录、事实创建、两轮人工审核、暂停恢复和结果重放形成可追溯核查结论。
    const connection = { baseUrl: fixture.baseUrl, token: fixture.token, remember: false }
    const bootstrap = await gateway.connect(connection)
    expect(bootstrap.identity).toEqual(fixture.identity)
    expect(await gateway.getConnection()).toMatchObject({ configured: true, remembered: false, canRemember: false })
    await expect(gateway.connect({ ...connection, token: 'invalid-token' })).rejects.toMatchObject({ status: 401 })
    // 替换登录前就丢弃旧身份，即使新凭据校验失败也不恢复旧连接。
    expect(await gateway.getConnection()).toMatchObject({ configured: false })
    await gateway.connect(connection)
    expect((await gateway.read('app.bootstrap', {})).identity.userId).toBe(fixture.identity.userId)
    const workspaces = await gateway.read('workspace.list', {})
    expect(workspaces.items).toContainEqual(expect.objectContaining({ id: fixture.workspaceId }))
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', {
      workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: '客户端闭环验收',
    })
    const claim = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId,
      expectedRevision: created.data.snapshot.revision,
      changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: '这条消息中的关键事实需要独立核查。', category: 'data' } }] } },
    })
    await gateway.dispatch(randomUUID(), 'run.start', {
      mapId, expectedRevision: claim.data.snapshot.revision, id: runId, scope: { nodeIds: [claimId] }, until: 'verified', mode: 'human-in-loop',
    })
    const routed = await waitForMap(mapId, /* 真实后端最新图快照，等待首个 Operation 的路由审核。 */ snapshot => /* 等待第一个 Operation 进入路由审核。 */ snapshot.run?.operations[0].review?.kind === 'route')
    expect(routed.run?.status).toBe('waiting')
    expect(routed.run?.operations[0].route?.slots).toHaveLength(3)
    expect(fixture.modelCalls.some(/* 夹具记录的一次模型调用，按 Worker 角色检查提前执行。 */ call => /* 检测路由批准前是否提前执行了 Worker。 */ call.role === 'worker')).toBe(false)
    const pauseId = randomUUID()
    const pauseInput = { mapId, expectedRevision: routed.revision, runId }
    const paused = await gateway.dispatch(pauseId, 'run.pause', pauseInput)
    expect(paused.data.snapshot.run?.paused).toBe(true)

    await gateway.disconnect()
    expect(await gateway.getConnection()).toMatchObject({ configured: false })
    await gateway.connect(connection)
    const resumed = await gateway.read('map.get', { mapId })
    expect(resumed.run).toMatchObject({ id: runId, status: 'waiting', paused: true })
    const routeReview = resumed.run!.operations[0].review!
    const revised = await gateway.dispatch(randomUUID(), 'review.update', {
      mapId, expectedRevision: resumed.revision, runId, operationId: resumed.run!.operations[0].id, reviewId: routeReview.id,
      expectedReviewRevision: routeReview.revision, reason: '先核查来源与数据两个角度。',
      slots: resumed.run!.operations[0].route!.slots.slice(0, 2),
    })
    const approvedRoute = revised.data.snapshot
    const routedWhilePaused = await gateway.dispatch(randomUUID(), 'review.answer', {
      mapId, expectedRevision: approvedRoute.revision, runId, operationId: approvedRoute.run!.operations[0].id,
      reviewId: approvedRoute.run!.operations[0].review!.id,
      expectedReviewRevision: approvedRoute.run!.operations[0].review!.revision, decision: 'approve',
    })
    expect(routedWhilePaused.data.snapshot.run?.paused).toBe(true)
    expect(fixture.modelCalls.some(/* 夹具记录的一次模型调用，检查暂停期间是否执行 Worker。 */ call => /* 检测暂停期间是否提前执行了 Worker。 */ call.role === 'worker')).toBe(false)
    await gateway.dispatch(randomUUID(), 'run.resume', { mapId, expectedRevision: routedWhilePaused.data.snapshot.revision, runId })
    const replay = await gateway.dispatch(pauseId, 'run.pause', pauseInput)
    expect(replay.replayed).toBe(true)
    expect(replay.data.snapshot.run?.paused).toBe(false)
    const result = await waitForMap(mapId, /* 真实后端最新图快照，等待结果审核状态。 */ snapshot => /* 等待第一个 Operation 进入结果审核。 */ snapshot.run?.operations[0].review?.kind === 'result')
    expect(result.run!.operations[0].reports).toHaveLength(2)
    expect(result.nodes.some(/* 结果获批前的真实节点，用类型检查是否意外保存结论。 */ node => /* 检查结果获批前是否错误地写入核查节点。 */ node.data.kind === 'verification')).toBe(false)
    expect(result.run!.operations[0].draft?.score).toBe(0.5)
    const resultReview = result.run!.operations[0].review!
    const requestId = randomUUID()
    const answer = { mapId, expectedRevision: result.revision, runId, operationId: result.run!.operations[0].id, reviewId: resultReview.id,
      expectedReviewRevision: resultReview.revision, decision: 'approve' as const }
    const accepted = await gateway.dispatch(requestId, 'review.answer', answer)
    expect(accepted.data.snapshot.run?.status).toBe('completed')
    expect((await gateway.dispatch(requestId, 'review.answer', answer)).replayed).toBe(true)
    const final = await gateway.read('map.get', { mapId })
    const verification = final.nodes.find(/* 完成后的真实节点，用类型查找持久化核查结论。 */ node => /* 查找最终保存的核查结论节点。 */ node.data.kind === 'verification')!
    expect(verification.data).toMatchObject({ kind: 'verification', score: 0.5,
      reason: '已完成 2 个独立核查角度。现有证据支持主要内容，但细节仍需更多来源确认。' })
    if (verification.data.kind !== 'verification') throw new Error('Verification result missing')
    expect(verification.data.opinions).toHaveLength(2)
    expect(verification.data.opinions.every(/* 已保存结论的一条意见，检查 Agent、槽位身份与证据理由。 */ opinion =>
      /* 确认每个意见保留 Agent、槽位身份及本机证据说明。 */
      opinion.agentId && opinion.agentName && opinion.slotId && opinion.reason.includes('本机验收证据'))).toBe(true)
    expect(final.edges).toContainEqual(expect.objectContaining({ kind: 'verifies', from: verification.id, to: claimId }))
    expect(new Set(fixture.modelCalls.filter(/* 夹具记录的一次模型调用，用 Worker 角色筛选会话。 */ call =>
      /* 筛选 Worker 模型调用以核对会话隔离。 */
      call.role === 'worker').map(/* 已经筛出的 Worker 调用，取原生 DSH 会话身份。 */ call =>
      /* 提取模型会话标识以统计独立 Worker 会话。 */
      call.sessionId)).size).toBe(2)
    expect(fixture.errors).toEqual([])
  }, 40_000)

  it('processes selected Source and News roots to Claims, then reuses them to finish verification', async () => {
    // 验证来源和新闻批量拆分到事实，再复用原产物继续完成核查，跳过未选事实。
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const mapId = randomUUID(), sourceId = randomUUID(), newsId = randomUUID(), unrelatedId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: '来源与新闻批量处理' })
    const inputs = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, expectedRevision: created.data.snapshot.revision, changes: { nodes: { put: [
      { id: sourceId, data: { kind: 'source', locator: { kind: 'url', url: fixture.sourceUrl }, label: '本机来源' } },
      { id: newsId, data: { kind: 'news', content: '已有新闻中的两项事实需要拆分。', context: {} } },
      { id: unrelatedId, data: { kind: 'claim', content: '这条未选中的事实不应自动核查。', category: null } },
    ] } } })
    await gateway.dispatch(randomUUID(), 'run.start', { mapId, expectedRevision: inputs.data.snapshot.revision, id: randomUUID(), scope: { nodeIds: [sourceId, newsId] }, until: 'claims', mode: 'auto' })
    const split = await waitForMap(mapId, /* 本轮拆分图的最新快照，用运行完成状态结束轮询。 */ snapshot => /* 等待拆分阶段的运行完成。 */ snapshot.run?.status === 'completed')
    expect(split.run!.operations.filter(/* 拆分运行中的 Operation，用类型统计解析任务。 */ operation => /* 统计来源解析 Operation。 */ operation.kind === 'parse')).toHaveLength(1)
    expect(split.run!.operations.filter(/* 拆分运行中的 Operation，用类型统计拆分任务。 */ operation => /* 统计新闻拆分 Operation。 */ operation.kind === 'split')).toHaveLength(2)
    expect(split.run!.operations.some(/* 拆分运行中的 Operation，用类型检查是否错误提前核查。 */ operation => /* 确认终点为事实时尚未创建核查 Operation。 */ operation.kind === 'verify')).toBe(false)
    expect(split.nodes.filter(/* 拆分完成后的真实节点，用类型统计事实数量。 */ node => /* 统计拆分后图中的事实节点。 */ node.data.kind === 'claim')).toHaveLength(5)
    expect(split.edges.some(/* 拆分图中的真实关系，核对产物与输入来源的派生关联。 */ edge => /* 检查生成产物与原来源之间的派生关系。 */ edge.kind === 'derived-from' && edge.to === sourceId)).toBe(true)
    const produced = split.nodes.filter(/* 拆分完成后的真实节点，用 producer 元数据识别生成产物。 */ node => /* 筛选带生成者元数据的节点。 */ node.producer)
    expect(produced).toHaveLength(5)
    expect(produced.filter(/* 带生成者信息的产物节点，按 parse 类型统计解析结果。 */ node => /* 统计由解析阶段生成的产物。 */ node.producer!.kind === 'parse')).toHaveLength(1)
    expect(produced.filter(/* 带生成者信息的产物节点，按 split 类型统计拆分结果。 */ node => /* 统计由拆分阶段生成的产物。 */ node.producer!.kind === 'split')).toHaveLength(4)
    expect(produced.every(/* 本轮生成的产物节点，需要存在匹配其 producer 输入的派生边。 */ node =>
      /* 确认每个生成产物都有指向其输入的真实派生边。 */
      split.edges.some(/* 图中的真实边，与当前产物身份和原输入身份匹配。 */ edge =>
        /* 匹配当前产物与生成者输入之间的派生边。 */
        edge.kind === 'derived-from' && edge.from === node.id && edge.to === node.producer!.inputId))).toBe(true)
    const generatedIds = split.nodes.map(/* 拆分后保留的节点，只读取身份建立复用断言基线。 */ node => /* 保存原有节点标识，以核对后续运行是否复用产物。 */ node.id)
    const processingCalls = fixture.modelCalls.filter(/* 夹具记录的模型调用，按解析或拆分角色统计处理次数。 */ call =>
      /* 统计解析和拆分模型调用，作为复用结果的基线。 */
      call.role === 'parse' || call.role.startsWith('split-')).length
    await gateway.dispatch(randomUUID(), 'run.start', { mapId, expectedRevision: split.revision, id: randomUUID(), scope: { nodeIds: [sourceId, newsId] }, until: 'verified', mode: 'auto' })
    const final = await waitForMap(mapId, /* 继续核查期间的最新图快照，用运行完成状态结束轮询。 */ snapshot => /* 等待继续核查的运行完成。 */ snapshot.run?.status === 'completed', 40_000)
    expect(final.nodes.filter(/* 最终快照中的真实节点，用类型统计保存的核查结论。 */ node => /* 统计最终保存的核查结论节点。 */ node.data.kind === 'verification')).toHaveLength(4)
    for (const node of produced) expect(final.nodes.find(/* 最终图中的候选节点，用原产物身份追踪生成者信息。 */ item => /* 查找原产物在最终快照中的记录。 */ item.id === node.id)?.producer).toMatchObject({
      kind: node.producer!.kind, inputId: node.producer!.inputId, agentId: node.producer!.agentId, agentName: node.producer!.agentName,
    })
    expect(final.nodes.map(/* 最终图中的真实节点，提取身份检查原产物仍被保留。 */ node => /* 提取最终节点标识以验证原有产物仍保留。 */ node.id)).toEqual(expect.arrayContaining(generatedIds))
    expect(final.run!.operations.some(/* 最终运行的 Operation，检查目标是否误包含未选事实。 */ operation => /* 检查是否误处理了未纳入范围的事实。 */ operation.targetId === unrelatedId)).toBe(false)
    expect(fixture.modelCalls.filter(/* 全部已记录的模型调用，重新统计解析拆分次数以检查复用。 */ call =>
      /* 重新统计解析与拆分调用，确认后续核查没有重复生成。 */
      call.role === 'parse' || call.role.startsWith('split-')).length).toBe(processingCalls)
    expect(fixture.errors).toEqual([])
  }, 60_000)

  it('surfaces real token revocation and clears the client connection on disconnect', async () => {
    // 验证真实令牌撤销产生 401，退出后清空客户端连接状态。
    await fixture.application.auth.revokeToken(fixture.tokenId)
    await expect(gateway.read('workspace.list', {})).rejects.toMatchObject({ status: 401 })
    await gateway.disconnect()
    expect(await gateway.getConnection()).toMatchObject({ configured: false, remembered: false })
  })
})
