// 组装隔离 Mongo、RabbitMQ 与真实 HTTP 图服务，提供带身份和租约的测试操作。
import { randomUUID } from 'node:crypto'
import { apiCreateServer } from '../../../backend/adapters/http/graph-http-server'
import { applicationCreateService } from '../../../apps/graph-server/application'
import { storeCreateConnection } from '../../../backend/adapters/storage/mongo/connection'
import { workReadItems } from '../../../backend/modules/graph/work-state'
import type { ContextField, GraphNodeData, GraphRunConfiguration, GraphWorkGrant } from '../../../contracts/graph'
import type { AgentInput, PromptKind } from '../../../contracts/control'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { expect } from 'vitest'
import { verificationConfiguration } from './verification'
import { rabbitCreateFixture } from './rabbitmq'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

export function grantHeaders(/* 需要转换为内部数据 API 身份请求头的工作授权。 */ grant: GraphWorkGrant) {
  // 将领取授权转换为内部数据 API 要求的工作身份、持有者和 fence 请求头。
  return { 'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence) }
}

export async function createGraphApi(/* 测试工作租约的有效毫秒数；默认一分钟避免普通用例意外过期。 */ leaseMs = 60_000, /* 首次初始化全局库与设置使用的完整 Agent 配置。 */ seedConfiguration = verificationConfiguration(), /* 可选诊断收集器，用于故障边界用例观察内部事件。 */ reporter?: DiagnosticReporter) {
  // 启动带独立数据库与队列的真实图 API，初始化测试管理员及配置，返回请求和资源清理入口。
  const broker = await rabbitCreateFixture()
  const queue = broker.queue
  const token = 'test-work-token'
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const uri = mongo.getUri('chongming_work_test')
  const connection = await storeCreateConnection(uri)
  const application = applicationCreateService(connection, { leaseMs, allowPrivateSources: true, messaging: queue, reporter })
  await application.initialize()
  await application.startMessaging()
  const { store, auth, control } = application
  await control.seed(seedConfiguration)
  const owner = await auth.createUser({ id: randomUUID(), displayName: 'Fixture Owner', hostAdmin: true })
  const { token: userToken } = await auth.createToken(owner.userId)
  const server = apiCreateServer(application, { internalToken: token, reporter })
  await new Promise<void>(/* HTTP 服务器开始监听后完成启动等待的回调。 */ resolve => /* 绑定回环地址的随机端口，等待服务就绪后再执行测试请求。 */ server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test Graph API did not bind')
  const url = `http://127.0.0.1:${address.port}`

  async function rawPost(/* 相对于测试服务器地址的请求路径。 */ path: string, /* 按 JSON 序列化发送的任意测试请求体。 */ body: unknown, /* 可选附加请求头，省略时为空；同名字段可覆盖默认的 JSON content-type。 */ headers: Record<string, string> = {}) {
    // 发送原始 JSON POST 并保留状态码与响应体，允许测试自行验证失败结果。
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  function post(/* 相对于测试服务器地址的公共或内部请求路径。 */ path: string, /* 按 JSON 序列化发送的任意测试请求体。 */ body: unknown, /* 显式请求头；公共路径会在其前加入用户身份。 */ headers: Record<string, string> = {}) {
    // 给公共 API 默认添加测试用户令牌，内部请求由调用者显式提供身份。
    return rawPost(path, body, { ...(path.startsWith('/api/v1/') ? { authorization: `Bearer ${userToken}` } : {}), ...headers })
  }
  function command(/* 准备调用的公共写命令方法。 */ method: string, /* 该命令未经静态收窄的测试参数。 */ params: unknown, /* 用于测试重放的稳定请求身份；省略时生成新身份。 */ requestId = randomUUID()) {
    // 用可指定的稳定请求 ID 调用公共写命令，支持测试幂等重放。
    return post('/api/v1/command', { requestId, method, params })
  }
  async function snapshot(/* 需要读取并断言成功的图身份。 */ mapId: string) {
    // 读取图快照并断言查询成功，简化后续状态比较。
    const result = await post('/api/v1/query', { method: 'map.get', params: { mapId } })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  function work(/* 准备调用的内部工作命令方法。 */ method: string, /* 领取、续租、释放或失败命令参数。 */ params: unknown) {
    // 使用测试 Host 令牌发送工作领取、续租或状态命令。
    return post('/internal/v1/work', { method, params }, { authorization: `Bearer ${token}` })
  }
  async function claim(/* 需要从当前可执行状态领取工作的图身份。 */ mapId: string, /* 领取授权应绑定的测试 Host 身份。 */ hostId = 'test-host', /* 区分同一 Host 并发领取尝试的持有者身份。 */ holderId = randomUUID()): Promise<GraphWorkGrant | null> {
    // 从当前可执行工作中依次尝试领取，返回第一份授权或表示暂时无工作的 null。
    const document = await store.read(mapId)
    if (!document) return null
    for (const item of workReadItems(document)) {
      const result = await work('claim', { mapId, workId: item.workId, hostId, holderId,
        deploymentId: application.messaging().deploymentId })
      expect(result).toMatchObject({ status: 200, body: { ok: true } })
      if (result.body.data.status === 'claimed') return result.body.data.grant
    }
    return null
  }
  async function read(/* 用于请求执行输入的完整工作授权。 */ grant: GraphWorkGrant) {
    // 携带精确工作授权读取输入，并要求内部数据 API 返回成功。
    const result = await post('/internal/v1/data/read', { mapId: grant.mapId, operationId: grant.operationId }, {
      authorization: `Bearer ${token}`, ...grantHeaders(grant),
    })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  function propose(/* 提交提案时提供内部身份请求头的工作授权。 */ grant: GraphWorkGrant, /* 需要由服务端验证结构和工作范围的提案输入。 */ proposal: unknown) {
    // 带当前授权请求头提交提案，保留响应供测试核对接纳或拒绝。
    return post('/internal/v1/data/propose', proposal, { authorization: `Bearer ${token}`, ...grantHeaders(grant) })
  }
  async function proposal(/* 决定提案身份、路由版本和槽位的工作授权。 */ grant: GraphWorkGrant, /* 测试只提供的业务提案字段。 */ input: Record<string, unknown>) {
    // 根据最新工作输入补齐提案身份、路由版本和槽位，使测试只需提供业务产物。
    const data = await read(grant)
    return {
      mapId: grant.mapId, operationId: grant.operationId, id: data.proposalId,
      ...(['route', 'parse'].includes(String(input.kind)) ? {} : { routeRevision: data.route.revision }),
      ...(['report', 'split-report'].includes(String(input.kind)) && grant.actor.role === 'worker' ? { slotId: grant.actor.slotId } : {}),
      ...input,
    }
  }
  async function createWorkspace(/* 需要写入共享设置和新工作区的完整运行配置。 */ configuration: GraphRunConfiguration = verificationConfiguration()) {
    // 用指定执行配置更新测试共享设置，并创建含独立 Agent 身份的工作区。
    const profile = (/* 准备转换为管理端 Agent 的执行配置。 */ input: GraphRunConfiguration['router'], /* 该 Agent 在管理端对应的提示词角色。 */ kind: PromptKind, /* 该 Agent 在工作区内使用的稳定提示词路径。 */ promptPath: string): AgentInput => /* 将测试执行配置转换为管理端 Agent，生成新身份并补齐阶段元数据。 */ ({
      ...input, id: randomUUID(), kind, promptPath, promptVars: input.promptVars ?? [],
      defaultPriority: input.defaultPriority ?? 'medium', claimCategory: input.claimCategory ?? null,
    })
    const agents = [profile(configuration.router, 'verifyRoute', 'fact-verifier/main-agent-route'),
      profile(configuration.merger, 'verifyMerge', 'fact-verifier/main-agent-merge'),
      ...configuration.agents.map(/* 当前转换为核查子 Agent 的执行配置。 */ agent => /* 把核查 Agent 转为新工作区的核查子角色配置。 */ profile(agent, 'verifySubAgent', `fact-verifier/sub-agents/${agent.id}`)),
      ...(configuration.parse ? [profile(configuration.parse, 'parseExtract', 'fact-parser/extract')] : []),
      ...(configuration.split ? [profile(configuration.split.router, 'splitRoute', 'fact-extractor/main-agent-route'),
        profile(configuration.split.merger, 'splitMerge', 'fact-extractor/main-agent-merge'),
        ...configuration.split.agents.map(/* 当前转换为拆分子 Agent 的执行配置。 */ agent => /* 把拆分 Agent 转为新工作区的拆分子角色配置。 */ profile(agent, 'splitSubAgent', `fact-extractor/sub-agents/${agent.id}`))] : [])]
    return auth.transact(userToken, async /* 共享设置更新和工作区创建共用的授权事务上下文。 */ ctx => {
      // 在同一身份事务中写共享模型与工具设置并创建测试工作区。
      const bootstrap = await control.read(ctx, { method: 'app.bootstrap', params: {} }) as { settings: { revision: number } }
      await control.dispatch(ctx, { requestId: randomUUID(), method: 'settings.update', params: {
        expectedRevision: bootstrap.settings.revision,
        llm: { provider: configuration.router.provider, model: configuration.router.model },
        tools: configuration.tools, limits: { maxAgentSlots: configuration.maxSlots },
      } })
      return control.createWorkspace(ctx, { id: randomUUID(), name: 'Fixture workspace', description: '', agentSource: 'empty' }, agents)
    })
  }
  async function createRun(/* 新 Run 使用自动执行还是人工审核。 */ mode: 'auto' | 'human-in-loop' = 'auto', /* 需要写入新工作区并由 Run 冻结的执行配置。 */ configuration = verificationConfiguration(),
    /* 可选新闻内容和上下文；提供时与测试事实建立 mentions 关系。 */ news?: { content: string; context: Record<string, ContextField> }) {
    // 创建事实及可选新闻关系，然后启动可指定审核模式的独立核查 Run。
    const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
    const workspace = await createWorkspace(configuration)
    expect(await command('map.create', {
      workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Dynamic verification',
    })).toMatchObject({ status: 201 })
    const nodes: Array<{ id: string; data: GraphNodeData }> = [{ id: claimId, data: { kind: 'claim', content: 'Fixture claim', category: 'data' } }]
    const newsId = randomUUID()
    if (news) nodes.push({ id: newsId, data: { kind: 'news', ...news } })
    expect(await command('graph.apply', { mapId, expectedRevision: 0,
      changes: { nodes: { put: nodes }, ...(news ? { edges: { put: [{ id: randomUUID(), kind: 'mentions', from: newsId, to: claimId }] } } : {}) },
    })).toMatchObject({ status: 200 })
    const result = await command('run.start', { mapId, expectedRevision: 1, id: runId, scope: { nodeIds: [claimId] }, until: 'verified', regenerate: true, mode })
    expect(result).toMatchObject({ status: 200, body: { data: { snapshot: { run: { id: runId, status: 'running' } } } } })
    return { mapId, claimId, runId, workspaceId: workspace.id,
      operationId: result.body.data.snapshot.run.operations[0].id as string,
      configuration: result.body.data.snapshot.run.configuration as GraphRunConfiguration }
  }
  async function answer(/* 包含待回答审核的图身份。 */ mapId: string, /* 提交批准还是拒绝；默认批准以推进常规测试流程。 */ decision: 'approve' | 'reject' = 'approve') {
    // 读取当前首个操作的审核版本并提交决定，返回请求体以便再次测试重放。
    const current = await snapshot(mapId)
    const review = current.run.operations[0].review
    const body = { requestId: randomUUID(), method: 'review.answer', params: {
      mapId, expectedRevision: current.revision, runId: current.run.id, operationId: current.run.operations[0].id, reviewId: review.id,
      expectedReviewRevision: review.revision, decision,
    } }
    const result = await post('/api/v1/command', body)
    expect(result.status).toBe(200)
    return { body, snapshot: result.body.data.snapshot }
  }
  return {
    url, token, userToken, owner, application, auth, control, server, store, connection, mongo, uri, queue,
    deleteNamespace: broker.deleteNamespace,
    post, rawPost, command, snapshot, work, claim, read, propose, proposal, createWorkspace, createRun, answer,
    async close() {
      // 关闭 HTTP、消息循环和数据库，并删除本夹具的队列命名空间及自有代理。
      server.closeAllConnections()
      await new Promise<void>((/* HTTP 服务器完成关闭时结束清理等待的回调。 */ resolve, /* HTTP 服务器关闭失败时拒绝清理等待的回调。 */ reject) => /* 将服务器关闭回调转换为可等待的清理结果。 */ server.close(/* 服务器关闭回调提供的可空系统错误。 */ error => /* 服务器关闭失败时拒绝清理，否则确认 HTTP 资源已结束。 */ error ? reject(error) : resolve()))
      await application.closeMessaging()
      await connection.close()
      await mongo.stop()
      await broker.deleteNamespace(application.messaging().namespace)
      await broker.close()
    },
  }
}

export type TestGraphApi = Awaited<ReturnType<typeof createGraphApi>>

export function proof(/* 需要裁剪为内部工作命令证明字段的授权。 */ grant: GraphWorkGrant) {
  // 提取内部工作命令使用的 map、work、holder 和 fence 证明。
  return { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence }
}

export function expectRejected(/* 预期为结构化 4xx 业务失败的测试 HTTP 结果。 */ result: Awaited<ReturnType<TestGraphApi['post']>>) {
  // 断言请求以有结构化错误码的 4xx 业务错误被拒绝。
  expect(result.status).toBeGreaterThanOrEqual(400)
  expect(result.status).toBeLessThan(500)
  expect(result.body).toMatchObject({ ok: false, error: { code: expect.any(String) } })
}
