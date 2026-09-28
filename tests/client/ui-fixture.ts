// 界面验收夹具：启动真实后端与 DSH，并提供确定性模型和来源响应及统一清理。
import { queueCreateTransport } from '../../backend/adapters/messaging/rabbitmq'
import { sqliteCreatePersistence, type SqlitePersistence } from '../../backend/adapters/storage/sqlite/persistence'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { apiCreateServer } from '../../backend/adapters/http/graph-http-server'
import { applicationCreateService } from '../../apps/graph-server/application'
import { applicationCreateLocalService } from '../../apps/local-server/application'
import { hostCreateWorker, type HostWorker, type HostInput } from '../../backend/execution/host-worker'
import { storeCreateConnection } from '../../backend/adapters/storage/mongo/connection'
import { rabbitCreateFixture } from '../backend/fixtures/rabbitmq'
import type { GraphAgentProfile, GraphDataRead, GraphRunConfiguration } from '../../contracts/graph'

import routerPrompt from './fixtures/router.json'
import workerPrompt from './fixtures/worker.json'
import mergePrompt from './fixtures/merge.json'
import parsePrompt from './fixtures/parse.json'
import splitRouterPrompt from './fixtures/split-router.json'
import splitWorkerPrompt from './fixtures/split-worker.json'
import splitMergePrompt from './fixtures/split-merge.json'

type HostInputQueue = HostInput['queue']

interface WireMessage {
  role: string; content?: string; tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}

export interface FixtureModelCall { role: string; tool: string; sessionId: string }

function fixtureReadConfiguration(): GraphRunConfiguration {
  // 从固定提示词夹具构建完整解析、拆分与核查配置，限定工具和变量。
  const prompts = { router: routerPrompt, worker: workerPrompt, merge: mergePrompt, parse: parsePrompt, 'split-router': splitRouterPrompt, 'split-worker': splitWorkerPrompt, 'split-merge': splitMergePrompt }
  const vars: Record<keyof typeof prompts, string[]> = { parse: ['rawContent'], router: ['claimContent', 'availableAgents'], worker: ['hint', 'claimContent'], merge: ['claimContent', 'opinions'], 'split-router': ['availableAgents', 'context', 'content'], 'split-worker': ['hint', 'context', 'content'], 'split-merge': ['content', 'subResults'] }
  const profile = (
    /* 验收 Agent 的稳定身份，用于运行配置和报告溯源。 */ id: string,
    /* 验收 Agent 的中文展示名称，写入配置描述和报告。 */ name: string,
    /* 确定性提示词角色，决定正文、注入变量与工具能力。 */ role: keyof typeof prompts
  ): GraphAgentProfile =>
    /* 按角色建立确定性 Agent 配置，并仅向核查 Worker 开放证据工具。 */
    ({
    id, name, description: `${name}，使用本机确定性验收数据。`,
    content: prompts[role].content,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', tools: role === 'worker' ? ['archive_lookup'] : [],
    promptVars: vars[role],
  })
  return {
    parse: profile('ui-parse', '来源解析', 'parse'),
    split: { router: profile('ui-split-router', '拆分路由', 'split-router'), merger: profile('ui-split-merger', '事实汇总', 'split-merge'), agents: [profile('ui-split-worker', '事实提取', 'split-worker')] },
    router: profile('ui-router', '核查路由', 'router'), merger: profile('ui-merger', '综合判断', 'merge'),
    agents: [profile('ui-source', '来源核验', 'worker'), profile('ui-data', '数据核验', 'worker'), profile('ui-logic', '逻辑核验', 'worker')],
    tools: [{ name: 'archive_lookup', description: '读取本机验收证据，不连接外部数据源。' }], maxSlots: 5,
  }
}

async function fixtureStartServer(/* 尚未启动的本机 HTTP 服务器，监听临时端口后由环境负责清理。 */ server: Server) {
  // 在本机随机端口启动 HTTP 服务并返回其地址。
  await new Promise<void>(/* 服务器绑定成功时调用的 Promise 完成入口。 */ resolve => /* 等待测试服务成功绑定临时端口。 */ server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function fixtureCloseServer(/* 环境持有的可选服务器；尚未创建时直接跳过清理。 */ server: Server | undefined) {
  // 关闭测试服务的现有连接并等待监听停止。
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((/* 服务器正常关闭后调用的完成入口。 */ resolve, /* 服务器关闭失败时调用的拒绝入口。 */ reject) =>
    /* 将服务器关闭回调转换为可等待的清理结果。 */
    server.close(/* Node 关闭回调提供的可选异常，存在时使清理失败。 */ error =>
      /* 关闭失败时拒绝清理 Promise，成功时完成等待。 */
      error ? reject(error) : resolve()))
}

function fixtureWriteReply(
  /* 模型 HTTP 响应写入端，本函数写 SSE 数据并结束它。 */ response: ServerResponse,
  /* 要让原生 DSH 调用的工具名称。 */ name: string,
  /* 确定性工具参数，序列化进模型工具调用响应。 */ args: unknown
) {
  // 将指定工具调用编码为模型兼容的 SSE 响应，并发送流结束标记。
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
    id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

/** 后端和原生 DSH Host 均真实运行，只有本机模型 HTTP 响应使用确定性脚本。 */
export async function fixtureCreateEnvironment(
  /* 验收环境选项，默认普通用户、无模型延迟和 Mongo 存储；可选延迟单位为毫秒。 */ options: { hostAdmin?: boolean; modelDelayMs?: number; storage?: 'mongo' | 'sqlite' } = {}
) {
  // 启动可销毁的真实后端、队列和 DSH Host，仅使用本机确定性模型响应驱动验收。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-ui-'))
  const modelCalls: FixtureModelCall[] = []
  const errors: string[] = []
  let sqlite: SqlitePersistence | undefined
  let mongo: MongoMemoryReplSet | undefined, connection: Connection | undefined
  let server: Server | undefined, provider: Server | undefined, host: HostWorker | undefined
  let applicationService: ReturnType<typeof applicationCreateService> | undefined
  let broker: Awaited<ReturnType<typeof rabbitCreateFixture>> | undefined
  let messagingNamespace: string | undefined
  let closing: Promise<void> | undefined
  const close = () => /* 复用同一个关闭 Promise，保证环境资源只释放一次。 */ closing ??= (async () => {
    // 按 Host、HTTP、消息、数据库和临时目录顺序释放验收资源。
    await host?.close()
    await fixtureCloseServer(server)
    await fixtureCloseServer(provider)
    await applicationService?.closeMessaging()
    if (connection) await connection.close()
    await sqlite?.close()
    if (mongo) await mongo.stop()
    if (broker && messagingNamespace) await broker.deleteNamespace(messagingNamespace)
    await broker?.close()
    await rm(directory, { recursive: true, force: true })
  })()
  try {
    provider = createServer(async (
      /* 本机来源或模型 HTTP 请求，校验路径、方法和夹具令牌后读取消息。 */ request,
      /* 对应请求的响应写入端，用于发送来源正文、工具调用流或失败 JSON。 */ response
    ) => {
      // 模拟来源页面和模型工具调用协议，按角色返回确定性提案并记录异常。
      try {
        if (request.method === 'GET' && request.url === '/source') { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end('本机来源：这条消息包含两项需要分别核查的事实。'); return }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
          || request.headers.authorization !== 'Bearer ui-fixture-key') throw new Error('Unexpected model request')
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: WireMessage[] }
        const persona = messages.filter(/* 模型消息中的一条记录，按角色筛选用户和系统提示。 */ message =>
          /* 筛选用于识别模型角色的用户和系统消息。 */
          message.role === 'user' || message.role === 'system').map(/* 已筛出的角色提示消息，只读取正文识别夹具角色。 */ message =>
          /* 提取角色提示文本以识别确定性响应分支。 */
          message.content).join('\n')
        const role = persona.match(/UI_FIXTURE_ROLE=(router|worker|merge|parse|split-router|split-worker|split-merge)/)?.[1]
        if (!role) throw new Error('Fixture role persona is absent')
        if (options.modelDelayMs) await delay(options.modelDelayMs)
        const calls = new Map(messages.flatMap(/* 历史模型消息，展开可选工具调用数组。 */ message =>
          /* 展开历史消息中的工具调用列表。 */
          message.tool_calls ?? []).map(/* 历史工具调用记录，以调用身份建立结果匹配索引。 */ call =>
          /* 按工具调用标识建立索引，供结果匹配原调用。 */
          [call.id, call]))
        const results = messages.filter(/* 历史消息中的一条记录，按 tool 角色筛选执行结果。 */ message =>
          /* 筛选原生工具执行结果消息。 */
          message.role === 'tool').map(/* 已筛出的工具结果消息，按调用身份关联名称并解析 JSON 正文。 */ message =>
          /* 将工具结果与原调用名称对应，并解析其 JSON 数据。 */
          ({
          name: calls.get(message.tool_call_id ?? '')?.function.name,
          data: JSON.parse(message.content ?? '') as Record<string, any>,
        }))
        const last = results[results.length - 1]
        const send = (/* 本次确定性模型选择的工具名，记录后写入 SSE 响应。 */ name: string, /* 本次工具调用的参数，默认空对象。 */ args: unknown = {}) => {
          // 记录模型角色、工具和 DSH 会话身份，再发送确定性工具调用响应。
          modelCalls.push({ role, tool: name, sessionId: String(request.headers['x-deepseek-harness-session-id']) })
          fixtureWriteReply(response, name, args)
        }
        if (!last) return send('data_read')
        if (last.name === 'archive_lookup') return send('data_propose', { proposal: {
          kind: 'report', score: 1, reason: `已查阅本机验收证据：${last.data.source}。该角度支持待核查内容。`,
        } })
        if (last.name !== 'data_read') throw new Error('The accepted native work should have ended its turn')
        const data = last.data as unknown as GraphDataRead
        if (data.work.actor.role !== role.replace('split-', '')) throw new Error('Model persona differs from its granted work')
        if (role === 'parse') return send('data_propose', { proposal: { kind: 'parse', reason: '从来源中提取一篇新闻。', news: [{ content: data.rawContent!, context: { 来源: { value: '本机验收来源', visibleToAI: true } } }] } })
        if (role === 'split-worker') return send('data_propose', { proposal: { kind: 'split-report', reason: '提取两个可独立核查的事实。', claims: [{ content: '本机来源中的第一项事实。', category: 'data' }, { content: '本机来源中的第二项事实。', category: 'quote' }] } })
        if (role === 'split-merge') return send('data_propose', { proposal: { kind: 'split-merge', reportIds: data.splitReports.map(/* 已接纳拆分报告，提取身份供汇总引用。 */ report =>
          /* 提取所有拆分报告标识，声明汇总所引用的报告。 */
          report.id), reason: '保留两项有来源依据的候选事实。', selected: data.splitReports.flatMap(/* 已接纳拆分报告，展开其中的全部候选事实选择。 */ report =>
          /* 展开每份拆分报告的候选事实选择。 */
          report.claims.map((/* 报告中的候选事实，此处只需要索引而不读取其正文。 */ _claim, /* 候选事实在该报告中的零基序号，写入汇总选择引用。 */ index) =>
            /* 将候选事实转换为报告标识与项索引。 */
            ({ reportId: report.id, index }))) } })
        if (role === 'router' || role === 'split-router') return send('data_propose', { proposal: {
          kind: 'route', reason: '从来源、数据与逻辑三个独立角度核查，保留每项依据。',
          slots: (data.operationKind === 'split' ? data.configuration.split!.agents : data.configuration.agents).slice(0, 3).map((
            /* 授权给本次运行的 Agent 配置，读取身份、名称和工具范围。 */ agent,
            /* Agent 在前三个路由候选中的零基位置，决定槽位身份和优先级。 */ index
          ) =>
            /* 为配置中的 Agent 创建固定优先级、提示和工具范围的路由槽位。 */
            ({
            id: `check-${index + 1}`, agentId: agent.id, angle: agent.name,
            priority: (['high', 'medium', 'low'] as const)[index], hint: `请完成${agent.name}，写明证据和限制。`, tools: [...agent.tools],
          })),
        } })
        if (role === 'worker' && data.work.actor.role === 'worker') {
          const slotId = data.work.actor.slotId
          return send('archive_lookup', { query: data.route!.slots.find(/* 当前授权路由中的槽位，用 Worker 槽位身份匹配处理角度。 */ slot => /* 查找当前 Worker 槽位对应的核查角度。 */ slot.id === slotId)!.angle })
        }
        return send('data_propose', { proposal: { kind: 'merge', reportIds: data.reports.map(/* 已接纳的核查报告，提取身份供最终汇总引用。 */ report => /* 提取核查报告标识，供确定性汇总结论引用。 */ report.id),
          score: 0.5, reason: `已完成 ${data.reports.length} 个独立核查角度。现有证据支持主要内容，但细节仍需更多来源确认。`,
        } })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: errors[errors.length - 1] } }))
      }
    })
    const providerUrl = await fixtureStartServer(provider)
    const patchPath = path.join(directory, 'provider.patch.yml')
    await writeFile(patchPath, ['- id: llm-deepseek', '  config:', '    apiKeyEnv: DEEPSEEK_API_KEY',
      `    baseURL: ${providerUrl}/v1`, '    thinking: disabled', '    streamIdleTimeoutMs: 10000',
      '- insert:', '    - id: verification-evidence-fixture',
      `      name: ${JSON.stringify(path.resolve('tests/backend/fixtures/evidence-tool.mjs'))}`, '',
    ].join('\n'), { mode: 0o600 })
    let application: ReturnType<typeof applicationCreateService>, queue: HostInputQueue
    if (options.storage === 'sqlite') {
      sqlite = sqliteCreatePersistence(path.join(directory, 'sqlite'))
      const local = applicationCreateLocalService(sqlite, { leaseMs: 5000, allowPrivateSources: true })
      application = local
      queue = { namespace: 'local', open: async () => /* 在 SQLite 模式中向 Host 提供应用内队列。 */ local.localQueue }
    } else {
      mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
      connection = await storeCreateConnection(mongo.getUri('chongming_ui_fixture'))
      broker = await rabbitCreateFixture()
      application = applicationCreateService(connection, { leaseMs: 5000, allowPrivateSources: true, messaging: broker.queue })
      queue = queueCreateTransport(broker.queue)
    }
    applicationService = application
    await application.initialize()
    messagingNamespace = application.messaging().namespace
    await application.startMessaging()
    await application.control.seed(fixtureReadConfiguration())
    const identity = await application.auth.createUser({ id: randomUUID(), displayName: '界面验收用户', hostAdmin: options.hostAdmin === true })
    const member = options.hostAdmin ? await application.auth.createUser({ id: randomUUID(), displayName: '验收协作成员', hostAdmin: false }) : null
    const { token, tokenId } = await application.auth.createToken(identity.userId)
    const workspace = await application.auth.transact(token, /* 验收令牌认证并开启事务后的上下文，用于创建具有真实归属的工作区。 */ ctx =>
      /* 在认证事务中为验收用户创建初始工作区和共享库配置副本。 */
      application.control.createWorkspace(ctx, {
      id: randomUUID(), name: '重明 · 核查验收', description: '独立本机验收环境，模型输出为确定性测试数据。', agentSource: 'library',
    }))
    const internalToken = randomUUID()
    server = apiCreateServer(application, { internalToken })
    const baseUrl = await fixtureStartServer(server)
    host = hostCreateWorker({ hostId: 'ui-fixture-host', dataApiUrl: baseUrl, token: internalToken,
      dshHome: path.join(directory, 'dsh-home'), cwd: directory, processCwd: directory,
      dshBin: path.resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), patches: [patchPath], queue,
      env: { DEEPSEEK_API_KEY: 'ui-fixture-key', DSH_TELEMETRY_DISABLED: '1',
        CHONGMING_CONFIG_DIR: path.join(directory, 'local-config'),
        CHONGMING_E2E_TOOL_LOG: path.join(directory, 'tool-calls.jsonl'),
        CHONGMING_E2E_RUNTIME_LOG: path.join(directory, 'runtime.jsonl'), CHONGMING_E2E_TOOL_DELAY_MS: '100', CHONGMING_E2E_OVERLAP: '0' },
    })
    await host.start()
    const credentialsPath = path.join(directory, 'credentials.json')
    await writeFile(credentialsPath, JSON.stringify({ baseUrl, sourceUrl: providerUrl + '/source', token, workspaceId: workspace.id, displayName: identity.displayName,
      ...(member ? { memberUserId: member.userId } : {}),
    }, null, 2), { mode: 0o600 })
    return { baseUrl, sourceUrl: providerUrl + '/source', token, tokenId, identity, workspaceId: workspace.id, directory, credentialsPath,
      application, modelCalls, errors, close }
  } catch (error) { await close(); throw error }
}

export type UiFixture = Awaited<ReturnType<typeof fixtureCreateEnvironment>>

async function fixtureRunMain() {
  // 按命令行选项启动验收环境，输出连接信息并安装终止信号清理。
  const fixture = await fixtureCreateEnvironment({ hostAdmin: process.argv.includes('--admin'), storage: process.argv.includes('--sqlite') ? 'sqlite' : 'mongo' })
  console.log(JSON.stringify({ event: 'ui.fixture.ready', pid: process.pid, baseUrl: fixture.baseUrl, workspaceId: fixture.workspaceId,
    credentialsPath: fixture.credentialsPath, proxyEnvironment: { CHONGMING_GRAPH_API: fixture.baseUrl } }))
  const stop = () => {
    // 收到终止信号时关闭环境，结束后输出停止事件。
    void fixture.close().then(() => /* 向外部验收进程报告环境已经停止。 */ console.log(JSON.stringify({ event: 'ui.fixture.stopped' })))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void fixtureRunMain().catch(/* 启动验收环境失败时的异常，记录并设置失败退出码。 */ error => {
    // 记录启动失败并将进程退出码置为失败。
    console.error(error); process.exitCode = 1
  })
}
