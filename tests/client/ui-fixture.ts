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
export interface FixtureRuntimeEvent { workId: string; method: string; params: Record<string, unknown> }

function fixtureSanitizeDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixtureSanitizeDiagnostic)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /token|authorization|api.?key/i.test(key) ? '[redacted]' : fixtureSanitizeDiagnostic(item)]))
}

function fixtureReadConfiguration(): GraphRunConfiguration {
  // 从固定提示词夹具构建完整解析、拆分与核查配置，限定工具和变量。
  const prompts = { router: routerPrompt, worker: workerPrompt, merge: mergePrompt, parse: parsePrompt, 'split-router': splitRouterPrompt, 'split-worker': splitWorkerPrompt, 'split-merge': splitMergePrompt }
  const vars: Record<keyof typeof prompts, string[]> = { parse: ['rawContent'], router: ['claimContent', 'availableAgents'], worker: ['hint', 'claimContent'], merge: ['claimContent', 'opinions'], 'split-router': ['availableAgents', 'context', 'content'], 'split-worker': ['hint', 'context', 'content'], 'split-merge': ['content', 'subResults'] }
  /**
   * @param id 验收 Agent 的稳定身份，用于运行配置和报告溯源。
   * @param name 验收 Agent 的中文展示名称，写入配置描述和报告。
   * @param role 确定性提示词角色，决定正文、注入变量与工具能力。
   */
  const profile = (
    id: string,
    name: string,
    role: keyof typeof prompts
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

/**
 * 在本机随机端口启动 HTTP 服务并返回其地址。
 *
 * @param server 尚未启动的本机 HTTP 服务器，监听临时端口后由环境负责清理。
 */
async function fixtureStartServer(server: Server) {
  await new Promise<void>(resolve => /* 等待测试服务成功绑定临时端口。 */ server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
  return `http://127.0.0.1:${address.port}`
}

/**
 * 关闭测试服务的现有连接并等待监听停止。
 *
 * @param server 环境持有的可选服务器；尚未创建时直接跳过清理。
 */
async function fixtureCloseServer(server: Server | undefined) {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    /* 将服务器关闭回调转换为可等待的清理结果。 */
    server.close(error =>
      /* 关闭失败时拒绝清理 Promise，成功时完成等待。 */
      error ? reject(error) : resolve()))
}

/**
 * 将指定工具调用编码为模型兼容的 SSE 响应，并发送流结束标记。
 *
 * @param response 模型 HTTP 响应写入端，本函数写 SSE 数据并结束它。
 * @param name 要让原生 DSH 调用的工具名称。
 * @param args 确定性工具参数，序列化进模型工具调用响应。
 */
function fixtureWriteReply(
  response: ServerResponse,
  name: string,
  args: unknown
) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
    id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

/** 后端和原生 DSH Host 均真实运行，只有本机模型 HTTP 响应使用确定性脚本。 */
/**
 * 启动可销毁的真实后端、队列和 DSH Host，仅使用本机确定性模型响应驱动验收。
 *
 * @param options 验收环境选项，默认普通用户、无模型延迟和 Mongo 存储；可选延迟单位为毫秒。
 */
export async function fixtureCreateEnvironment(
  options: { hostAdmin?: boolean; modelDelayMs?: number; storage?: 'mongo' | 'sqlite' } = {}
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-ui-'))
  const modelCalls: FixtureModelCall[] = []
  const runtimeEvents: FixtureRuntimeEvent[] = []
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
      request,
      response
    ) => {
      // 模拟来源页面和模型工具调用协议，按角色返回确定性提案并记录异常。
      try {
        if (request.method === 'GET' && request.url === '/source') { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end('本机来源：这条消息包含两项需要分别核查的事实。'); return }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
          || request.headers.authorization !== 'Bearer ui-fixture-key') throw new Error('Unexpected model request')
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: WireMessage[] }
        const persona = messages.filter(message =>
          /* 筛选用于识别模型角色的用户和系统消息。 */
          message.role === 'user' || message.role === 'system').map(message =>
          /* 提取角色提示文本以识别确定性响应分支。 */
          message.content).join('\n')
        const role = persona.match(/UI_FIXTURE_ROLE=(router|worker|merge|parse|split-router|split-worker|split-merge)/)?.[1]
        if (!role) throw new Error('Fixture role persona is absent')
        if (options.modelDelayMs) await delay(options.modelDelayMs)
        const calls = new Map(messages.flatMap(message =>
          /* 展开历史消息中的工具调用列表。 */
          message.tool_calls ?? []).map(call =>
          /* 按工具调用标识建立索引，供结果匹配原调用。 */
          [call.id, call]))
        const results = messages.filter(message =>
          /* 筛选原生工具执行结果消息。 */
          message.role === 'tool').map(message =>
          /* 将工具结果与原调用名称对应，并解析其 JSON 数据。 */
          {
            const content = message.content ?? ''
            let data: Record<string, any>
            try { data = JSON.parse(content) as Record<string, any> }
            catch { data = { error: content } }
            return { name: calls.get(message.tool_call_id ?? '')?.function.name, data }
          })
        const last = results[results.length - 1]
        /**
         * 记录模型角色、工具和 DSH 会话身份，再发送确定性工具调用响应。
         *
         * @param name 本次确定性模型选择的工具名，记录后写入 SSE 响应。
         * @param args 本次工具调用的参数，默认空对象。
         */
        const send = (name: string, args: unknown = {}) => {
          modelCalls.push({ role, tool: name, sessionId: String(request.headers['x-deepseek-harness-session-id']) })
          fixtureWriteReply(response, name, args)
        }
        if (!last) return send('data_read')
        if (last.name === 'archive_lookup') {
          const dataRead = results.find(result => result.name === 'data_read')?.data as unknown as GraphDataRead
          const port = dataRead.outputContract.ports[0]
          return send('data_propose', { proposal: { kind: 'outputs', reason: '已完成本机证据核查。', outputs: [{
            key: `opinion-${dataRead.stage.slotId}`, port: port.port, typeRef: port.type,
            payload: { score: 1, reason: `已查阅本机验收证据：${last.data.source}。该角度支持待核查内容。`, evidenceIds: [] },
          }] } })
        }
        if (last.name !== 'data_read') throw new Error(last.data.error || 'The accepted native work should have ended its turn')
        const data = last.data as unknown as GraphDataRead
        if (role === 'parse') {
          const port = data.outputContract.ports[0]
          return send('data_propose', { proposal: { kind: 'outputs', reason: '从来源中提取一篇新闻。', outputs: [{ key: 'news-1', port: port.port,
            typeRef: port.type, payload: { content: data.promptVariables.rawContent, context: { 来源: { value: '本机验收来源', visibleToAI: true } } } }] } })
        }
        if (role === 'split-worker') {
          const port = data.outputContract.ports[0]
          return send('data_propose', { proposal: { kind: 'outputs', reason: '提取两个可独立核查的事实。', outputs: [
            { key: 'claim-1', port: port.port, typeRef: port.type, payload: { content: '本机来源中的第一项事实。', category: 'data' } },
            { key: 'claim-2', port: port.port, typeRef: port.type, payload: { content: '本机来源中的第二项事实。', category: 'quote' } },
          ] } })
        }
        if (role === 'split-merge') return send('data_propose', { proposal: { kind: 'selection', reason: '保留两项有来源依据的候选事实。',
          selection: data.priorStageResults.flatMap(result => result.mode === 'outputs'
            ? result.outputs.map(output => ({ workId: result.workId, key: output.key })) : []) } })
        if (role === 'router' || role === 'split-router') return send('data_propose', { proposal: {
          kind: 'plan', reason: '从相互独立的角度处理，并保留每项依据。',
          slots: (JSON.parse(data.promptVariables.availableAgents) as Array<{ id: string; version: number; name: string; tools: string[] }>).slice(0, 3).map((agent, index) => ({
            id: `check-${index + 1}`, stageId: role === 'split-router' ? 'extract' : 'assess', agentRef: { id: agent.id, version: agent.version }, angle: agent.name,
            priority: (['high', 'medium', 'low'] as const)[index], hint: `请完成${agent.name}，写明证据和限制。`, tools: [...agent.tools],
          })),
        } })
        if (role === 'worker') {
          return send('archive_lookup', { query: data.promptVariables.hint || data.promptVariables.claimContent })
        }
        const port = data.outputContract.ports[0]
        const opinions = data.priorStageResults.flatMap(result => result.mode === 'outputs'
          ? result.outputs.map(output => ({ candidate: { workId: result.workId, key: output.key } })) : [])
        return send('data_propose', { proposal: { kind: 'outputs', reason: '汇总独立核查角度。', outputs: [{ key: 'verification', port: port.port,
          typeRef: port.type, payload: { score: 0.5, reason: `已完成 ${opinions.length} 个独立核查角度。现有证据支持主要内容，但细节仍需更多来源确认。`, opinionIds: opinions } }] } })
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
      const local = applicationCreateLocalService(sqlite, { leaseMs: 120_000, allowPrivateSources: true })
      application = local
      queue = { namespace: 'local', open: async () => /* 在 SQLite 模式中向 Host 提供应用内队列。 */ local.localQueue }
    } else {
      mongo = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
      connection = await storeCreateConnection(mongo.getUri('chongming_ui_fixture'))
      broker = await rabbitCreateFixture()
      application = applicationCreateService(connection, { leaseMs: 120_000, allowPrivateSources: true, messaging: broker.queue })
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
    const workspace = await application.auth.transact(token, ctx =>
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
      concurrency: 4,
      env: { DEEPSEEK_API_KEY: 'ui-fixture-key', DSH_TELEMETRY_DISABLED: '1',
        CHONGMING_CONFIG_DIR: path.join(directory, 'local-config'),
        CHONGMING_E2E_TOOL_LOG: path.join(directory, 'tool-calls.jsonl'),
        CHONGMING_E2E_RUNTIME_LOG: path.join(directory, 'runtime.jsonl'), CHONGMING_E2E_TOOL_DELAY_MS: '100', CHONGMING_E2E_OVERLAP: '0' },
      reporter: { report(event) {
        if (event.severity === 'error' || event.severity === 'fatal') errors.push(`${event.name}: ${event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error ?? '')}`)
      } },
      onEvent({ workId, event }) {
        runtimeEvents.push({ workId, method: event.method, params: fixtureSanitizeDiagnostic(event.params) as Record<string, unknown> })
      },
    })
    await host.start()
    const credentialsPath = path.join(directory, 'credentials.json')
    await writeFile(credentialsPath, JSON.stringify({ baseUrl, sourceUrl: providerUrl + '/source', token, workspaceId: workspace.id, displayName: identity.displayName,
      ...(member ? { memberUserId: member.userId } : {}),
    }, null, 2), { mode: 0o600 })
    return { baseUrl, sourceUrl: providerUrl + '/source', token, tokenId, identity, workspaceId: workspace.id, directory, credentialsPath,
      application, modelCalls, runtimeEvents, errors, close }
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
  void fixtureRunMain().catch(error => {
    // 记录启动失败并将进程退出码置为失败。
    console.error(error); process.exitCode = 1
  })
}
