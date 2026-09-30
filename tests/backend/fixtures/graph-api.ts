// 组装隔离 Mongo、RabbitMQ 与真实 HTTP 图服务，并提供通用数据/阶段执行测试操作。
import { randomUUID } from 'node:crypto'
import { apiCreateServer } from '../../../backend/adapters/http/graph-http-server'
import { applicationCreateService } from '../../../apps/graph-server/application'
import { storeCreateConnection } from '../../../backend/adapters/storage/mongo/connection'
import { workReadItems } from '../../../backend/modules/graph/work-state'
import type { GraphBranchGrant, GraphBranchSnapshot, GraphChanges, GraphDataProposal, GraphPlanSlot, GraphProposedOutput, GraphRunConfiguration, GraphRunControlGrant, GraphRunPlan, GraphWorkGrant } from '../../../contracts/graph'
import type { AgentInput, PromptKind } from '../../../contracts/control'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { expect } from 'vitest'
import { verificationConfiguration } from './verification'
import { rabbitCreateFixture } from './rabbitmq'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

export const FACT_TYPES = {
  source: { id: 'factcheck.source', version: 1 }, news: { id: 'factcheck.news', version: 1 },
  claim: { id: 'factcheck.claim', version: 1 }, opinion: { id: 'factcheck.opinion', version: 1 },
  verification: { id: 'factcheck.verification', version: 1 },
} as const

/**
 * @param claimIds 核查输入事实。
 * @param newsIds 可选新闻上下文。
 */
export function verificationPlan(claimIds: string[], newsIds: string[] = []): GraphRunPlan {
  return { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
    input: [{ port: 'claim', source: { kind: 'scope', nodeIds: claimIds } }],
    context: [{ port: 'news', source: { kind: 'scope', nodeIds: newsIds } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] }
}

/**
 * @param sourceIds 来源节点身份。
 */
export function sourceFactCheckPlan(sourceIds: string[]): GraphRunPlan {
  return { steps: [
    { id: 'parse', transitionRef: { id: 'factcheck.parse-source', version: 1 }, dependsOn: [],
      input: [{ port: 'source', source: { kind: 'scope', nodeIds: sourceIds } }], context: [], grouping: { mode: 'each' }, onEmpty: 'fail' },
    { id: 'split', transitionRef: { id: 'factcheck.split-news', version: 1 }, dependsOn: ['parse'],
      input: [{ port: 'news', source: { kind: 'step', stepId: 'parse', port: 'news' } }], context: [], grouping: { mode: 'each' }, onEmpty: 'fail' },
    { id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: ['parse', 'split'],
      input: [{ port: 'claim', source: { kind: 'step', stepId: 'split', port: 'claims' } }],
      context: [{ port: 'news', source: { kind: 'step', stepId: 'parse', port: 'news' } }], grouping: { mode: 'each' }, onEmpty: 'fail' },
  ] }
}

/**
 * @param grant 完整授权。
 */
export function grantHeaders(grant: GraphWorkGrant) {
  return { 'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence) }
}

/**
 * @param leaseMs 租约毫秒。
 * @param seedConfiguration 初始 Agent 配置。
 * @param reporter 可选诊断器。
 */
export async function createGraphApi(leaseMs = 60_000, seedConfiguration = verificationConfiguration(), reporter?: DiagnosticReporter) {
  const broker = await rabbitCreateFixture(), queue = broker.queue, token = 'test-work-token'
  const mongo = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const uri = mongo.getUri('chongming_work_test'), connection = await storeCreateConnection(uri)
  const application = applicationCreateService(connection, { leaseMs, allowPrivateSources: true, messaging: queue, reporter })
  await application.initialize(); await application.startMessaging()
  const { store, auth, control } = application
  await control.seed(seedConfiguration)
  const owner = await auth.createUser({ id: randomUUID(), displayName: 'Fixture Owner', hostAdmin: true })
  const { token: userToken } = await auth.createToken(owner.userId)
  const server = apiCreateServer(application, { internalToken: token, reporter })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test Graph API did not bind')
  const url = `http://127.0.0.1:${address.port}`
  const controls = new Map<string, GraphRunControlGrant>(), controlHolderId = randomUUID()

  /**
   * @param path API 路径。
   * @param body JSON 请求体。
   * @param headers 附加请求头。
   */
  async function rawPost(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  /**
   * @param path API 路径。
   * @param body JSON 请求体。
   * @param headers 附加请求头。
   */
  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return rawPost(path, body, { ...(path.startsWith('/api/v1/') ? { authorization: `Bearer ${userToken}` } : {}), ...headers })
  }
  /**
   * 绝大多数业务测试只关心内容；为已有分支自动领取并在普通编辑后释放，独占协议专项使用 post 发送原始命令。
   *
   * @param method 命令名。
   * @param params 命令参数。
   * @param requestId 幂等身份。
   */
  async function command(method: string, params: any, requestId = randomUUID()) {
    let input = params, claimed: GraphBranchGrant | undefined
    if ((method === 'graph.apply' && params.branch?.expectedVersion !== null || method === 'run.start') && !params.lease) {
      const response = await post('/api/v1/command', { requestId: randomUUID(), method: 'branch.claim', params: {
        mapId: params.mapId, rootIds: params.branch.rootIds, holderId: randomUUID(),
      } })
      if (response.body.data?.status !== 'claimed') throw new Error('Fixture branch is busy')
      claimed = response.body.data.grant
      input = { ...params, lease: { leaseId: claimed!.leaseId, holderId: claimed!.holderId, fence: claimed!.fence } }
    }
    if (['run.cancel', 'run.pause', 'run.resume', 'review.answer'].includes(method) && !params.control) {
      const key = `${params.mapId}:${params.runId}`
      let control = controls.get(key)
      if (!control) {
        const response = await post('/api/v1/command', { requestId: randomUUID(), method: 'run.control.claim', params: {
          mapId: params.mapId, runId: params.runId, holderId: controlHolderId,
        } })
        if (response.body.data?.status !== 'claimed') throw new Error('Fixture Run control is busy')
        control = response.body.data.grant; controls.set(key, control!)
      }
      input = { ...input, control: { leaseId: control!.leaseId, holderId: control!.holderId, fence: control!.fence } }
    }
    const result = await post('/api/v1/command', { requestId, method, params: input })
    if (method === 'run.start' && result.body.data?.runControl) controls.set(`${params.mapId}:${params.id}`, result.body.data.runControl)
    const targetRun = result.body.data?.snapshot?.runs?.find((run: { id: string }) => run.id === (params.runId ?? params.id))
    if (targetRun && ['completed', 'failed', 'cancelled'].includes(targetRun.status)) {
      controls.delete(`${params.mapId}:${targetRun.id}`)
    }
    if (claimed && method === 'graph.apply') await post('/api/v1/command', { requestId: randomUUID(), method: 'branch.release', params: {
      mapId: params.mapId, lease: { leaseId: claimed.leaseId, holderId: claimed.holderId, fence: claimed.fence },
    } })
    return result
  }
  /**
   * @param mapId 图身份。
   */
  async function snapshot(mapId: string) {
    const result = await post('/api/v1/query', { method: 'map.get', params: { mapId } })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  /**
   * @param mapId 图身份。
   * @param rootIds 共同构成授权范围的真实根。
   */
  async function branch(mapId: string, rootIds: string[]): Promise<GraphBranchSnapshot> {
    const result = await post('/api/v1/query', { method: 'branch.get', params: { mapId, rootIds } })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  /**
   * @param mapId 图身份。
   * @param rootIds 分支根；新根和既有根均须真实列出。
   * @param changes 局部修改。
   * @param create true 表示这些根尚不存在。
   * @param requestId 可复用请求身份。
   */
  async function apply(mapId: string, rootIds: string[], changes: GraphChanges,
    create = false, requestId = randomUUID()) {
    const expectedVersion = create ? null : (await branch(mapId, rootIds)).version
    return command('graph.apply', { mapId, branch: { rootIds, expectedVersion }, changes }, requestId)
  }
  /**
   * @param method 工作命令。
   * @param params 工作参数。
   */
  function work(method: string, params: unknown) {
    return post('/internal/v1/work', { method, params }, { authorization: `Bearer ${token}` })
  }
  /**
   * @param mapId 图身份。
   * @param hostId Host 身份。
   * @param holderId 持有者身份。
   * @param stageId 可选阶段过滤。
   */
  async function claim(mapId: string, hostId = 'test-host', holderId = randomUUID(),
    stageId?: string): Promise<GraphWorkGrant | null> {
    const document = await store.read(mapId)
    if (!document) return null
    for (const item of workReadItems(document).filter(work => !stageId || work.stageId === stageId)) {
      const result = await work('claim', { mapId, workId: item.workId, hostId, holderId, deploymentId: application.messaging().deploymentId })
      expect(result).toMatchObject({ status: 200, body: { ok: true } })
      if (result.body.data.status === 'claimed') return result.body.data.grant
    }
    return null
  }
  /**
   * @param grant 完整授权。
   */
  async function read(grant: GraphWorkGrant) {
    const result = await post('/internal/v1/data/read', { mapId: grant.mapId, operationId: grant.operationId }, {
      authorization: `Bearer ${token}`, ...grantHeaders(grant),
    })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  /**
   * @param grant 完整授权。
   * @param proposal 通用提案。
   */
  function propose(grant: GraphWorkGrant, proposal: unknown) {
    return post('/internal/v1/data/propose', proposal, { authorization: `Bearer ${token}`, ...grantHeaders(grant) })
  }
  /**
   * @param grant 完整授权。
   * @param input kind 及业务字段。
   */
  async function proposal(grant: GraphWorkGrant, input: Record<string, unknown>) {
    const data = await read(grant)
    return { mapId: grant.mapId, operationId: grant.operationId, id: data.proposalId, specHash: data.specHash, ...input }
  }
  /**
   * @param grant Planner 授权。
   * @param count 槽位数。
   */
  async function planSlots(grant: GraphWorkGrant, count: number): Promise<GraphPlanSlot[]> {
    const document = await store.read(grant.mapId), operation = document?.runs.find(run => run.id === grant.runId)?.operations.find(item => item.id === grant.operationId)
    const planner = operation?.executionSpec.stages.find(item => item.id === grant.stageId)
    if (!planner?.plan || count < 1 || count > planner.plan.maxSlots || count > planner.plan.agents.length) throw new Error('Planner candidates are missing')
    const stageId = planner.plan.stageIds[0]
    return planner.plan.agents.slice(0, count).map((agent, index) => ({ id: `angle-${index + 1}`, stageId,
      agentRef: structuredClone(agent.ref), angle: `independent-angle-${index + 1}`, hint: `Follow evidence chain ${index + 1}`,
      priority: (['high', 'medium', 'low'] as const)[index % 3], tools: [...agent.profile.tools] }))
  }
  /**
   * @param grant Planner 授权。
   * @param count 槽位数。
   */
  async function plan(grant: GraphWorkGrant, count: number) {
    const slots = await planSlots(grant, count)
    return { slots, proposal: await proposal(grant, { kind: 'plan', reason: 'Select independent Agent work', slots }) }
  }
  /**
   * @param grant 输出阶段授权。
   * @param outputs 候选产物。
   * @param reason 理由。
   */
  async function output(grant: GraphWorkGrant, outputs: GraphProposedOutput[], reason = 'Fixture output') {
    return proposal(grant, { kind: 'outputs', reason, outputs })
  }
  /**
   * @param grant assess 授权。
   * @param index 结果序号。
   */
  async function opinion(grant: GraphWorkGrant, index = 0) {
    return output(grant, [{ key: `opinion-${grant.slotId}`, port: 'opinions', typeRef: FACT_TYPES.opinion,
      payload: { score: index % 2 ? 0 : 1, reason: `Evidence from ${grant.slotId}`, evidenceIds: [] } }], 'Independent opinion')
  }
  /**
   * @param grant merge 授权。
   * @param score 汇总评分。
   */
  async function verification(grant: GraphWorkGrant, score: 0 | 0.5 | 1 = 0.5) {
    const data = await read(grant)
    const opinionIds = (data.priorStageResults as Array<Record<string, any>>).flatMap(result => result.mode === 'outputs'
      ? result.outputs.filter((item: GraphProposedOutput) => item.port === 'opinions').map((item: GraphProposedOutput) => ({ candidate: { workId: result.workId, key: item.key } })) : [])
    return proposal(grant, { kind: 'outputs', reason: 'Independent merger conclusion', outputs: [{ key: 'verification', port: 'verification',
      typeRef: FACT_TYPES.verification, payload: { score, reason: 'Independent merger conclusion', opinionIds } }] })
  }
  /**
   * @param grant selection 授权。
   */
  async function selection(grant: GraphWorkGrant) {
    const data = await read(grant)
    const selected = (data.priorStageResults as Array<Record<string, any>>).flatMap(result => result.mode === 'outputs'
      ? result.outputs.map((item: GraphProposedOutput) => ({ workId: result.workId, key: item.key })) : [])
    return proposal(grant, { kind: 'selection', reason: 'Select all distinct candidates', selection: selected })
  }
  /**
   * @param configuration 工作区 Agent 配置。
   */
  async function createWorkspace(configuration: GraphRunConfiguration = verificationConfiguration()) {
    const profile = (input: GraphRunConfiguration['router'], kind: PromptKind, promptPath: string): AgentInput => ({ ...input,
      id: randomUUID(), kind, promptPath, promptVars: input.promptVars ?? [], defaultPriority: input.defaultPriority ?? 'medium', claimCategory: input.claimCategory ?? null })
    const agents = [profile(configuration.router, 'verifyRoute', 'fact-verifier/main-agent-route'),
      profile(configuration.merger, 'verifyMerge', 'fact-verifier/main-agent-merge'),
      ...configuration.agents.map(agent => profile(agent, 'verifySubAgent', `fact-verifier/sub-agents/${agent.id}`)),
      ...(configuration.parse ? [profile(configuration.parse, 'parseExtract', 'fact-parser/extract')] : []),
      ...(configuration.split ? [profile(configuration.split.router, 'splitRoute', 'fact-extractor/main-agent-route'),
        profile(configuration.split.merger, 'splitMerge', 'fact-extractor/main-agent-merge'),
        ...configuration.split.agents.map(agent => profile(agent, 'splitSubAgent', `fact-extractor/sub-agents/${agent.id}`))] : [])]
    return auth.transact(userToken, async ctx => {
      const bootstrap = await control.read(ctx, { method: 'app.bootstrap', params: {} }) as { settings: { revision: number } }
      await control.dispatch(ctx, { requestId: randomUUID(), method: 'settings.update', params: { expectedRevision: bootstrap.settings.revision,
        llm: { provider: configuration.router.provider, model: configuration.router.model }, tools: configuration.tools, limits: { maxAgentSlots: configuration.maxSlots } } })
      return control.createWorkspace(ctx, { id: randomUUID(), name: 'Fixture workspace', description: '', agentSource: 'empty' }, agents)
    })
  }
  /**
   * @param mode 运行模式。
   * @param configuration Agent 配置。
   * @param news 可选新闻上下文。
   */
  async function createRun(mode: 'auto' | 'human-in-loop' = 'auto', configuration = verificationConfiguration(),
    news?: { content: string; context: Record<string, { value: string; visibleToAI: boolean }> }) {
    const mapId = randomUUID(), claimId = randomUUID(), newsId = news ? randomUUID() : undefined, runId = randomUUID()
    const workspace = await createWorkspace(configuration)
    expect(await command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Dynamic verification' })).toMatchObject({ status: 201 })
    const nodes = [{ id: claimId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Fixture claim', category: 'data' } },
      ...(newsId && news ? [{ id: newsId, typeId: FACT_TYPES.news.id, typeVersion: FACT_TYPES.news.version, payload: { content: news.content, context: news.context } }] : [])]
    expect(await command('graph.apply', { mapId, branch: { rootIds: [newsId ?? claimId], expectedVersion: null }, changes: { nodes: { put: nodes }, ...(newsId ? { edges: { put: [
      { id: randomUUID(), kind: 'successor', from: newsId, to: claimId, label: 'fixture:news-claim' },
    ] } } : {}) } })).toMatchObject({ status: 200 })
    const runBranch = await branch(mapId, [newsId ?? claimId])
    const claimed = await command('branch.claim', { mapId, rootIds: runBranch.scope.rootIds, holderId: randomUUID() })
    if (claimed.body.data.status !== 'claimed') throw new Error('Fixture Run branch is busy')
    const grant = claimed.body.data.grant
    const result = await command('run.start', { mapId, id: runId,
      branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version },
      lease: { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }, scope: { nodeIds: [claimId, ...(newsId ? [newsId] : [])] },
      plan: verificationPlan([claimId], newsId ? [newsId] : []), regenerate: true, mode })
    expect(result).toMatchObject({ status: 200, body: { data: { snapshot: { runs: expect.arrayContaining([expect.objectContaining({ id: runId, status: 'running' })]) } } } })
    const run = result.body.data.snapshot.runs.find((item: { id: string }) => item.id === runId)
    return { mapId, claimId, newsId, runId, workspaceId: workspace.id,
      operationId: run.operations[0].id as string, snapshot: result.body.data.snapshot }
  }
  /**
   * @param mapId 图身份。
   * @param decision 决定。
   * @param operationId 可选 Operation。
   */
  async function answer(mapId: string, decision: 'approve' | 'reject' = 'approve', operationId?: string) {
    const current = await snapshot(mapId)
    const run = operationId ? current.runs.find((item: { operations: Array<{ id: string }> }) => item.operations.some(operation => operation.id === operationId))
      : current.runs.find((item: { operations: Array<{ review: unknown }> }) => item.operations.some(operation => operation.review))
    const operation = operationId ? run?.operations.find((item: { id: string }) => item.id === operationId)
      : run?.operations.find((item: { review: unknown }) => item.review)
    if (!run || !operation?.review) throw new Error('Pending Review missing')
    const control = controls.get(`${mapId}:${run.id}`)
    if (!control) throw new Error('Fixture Run control is missing')
    const body = { requestId: randomUUID(), method: 'review.answer', params: { mapId, runId: run.id, operationId: operation.id,
      reviewId: operation.review.id, expectedReviewRevision: operation.review.revision, decision,
      control: { leaseId: control.leaseId, holderId: control.holderId, fence: control.fence } } }
    const result = await post('/api/v1/command', body)
    expect(result.status).toBe(200)
    return { body, snapshot: result.body.data.snapshot }
  }
  return { url, token, userToken, owner, application, auth, control, server, store, connection, mongo, uri, queue,
    deleteNamespace: broker.deleteNamespace, post, rawPost, command, snapshot, branch, apply, work, claim, read, propose, proposal,
    planSlots, plan, output, opinion, verification, selection, createWorkspace, createRun, answer,
    async close() {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await application.closeMessaging(); await connection.close(); await mongo.stop(); await broker.deleteNamespace(application.messaging().namespace); await broker.close()
    } }
}

export type TestGraphApi = Awaited<ReturnType<typeof createGraphApi>>
/**
 * @param grant 完整授权。
 */
export function proof(grant: GraphWorkGrant) { return { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence } }
/**
 * @param result 预期结构化 4xx 的结果。
 */
export function expectRejected(result: Awaited<ReturnType<TestGraphApi['post']>>) {
  expect(result.status).toBeGreaterThanOrEqual(400); expect(result.status).toBeLessThan(500)
  expect(result.body).toMatchObject({ ok: false, error: { code: expect.any(String) } })
}
export type FixtureProposal = GraphDataProposal
